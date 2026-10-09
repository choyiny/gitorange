import type { Tone } from './agentLook';
import type { BoardRow } from './board';
import type {
  ApprovalItem,
  AuditEvent,
  HealthReport,
  HealthTrend,
  ReviewFlag,
} from './uiApi';

// Home, in words: what needs the owner, what got better or worse since last week, how each repository is doing and
// what happened. Pure, so the sentences are tested; the page only lays them out.

export interface Decision {
  item: ApprovalItem;
  agent: ApprovalItem['agents'][number];
  flag: ReviewFlag;
}

/**
 * The owner's decisions: open findings for a person that carry the agent's plain yes/no question. What is assigned to
 * you comes first, then what nobody was asked, then what someone else was asked; within each, the order of the list.
 */
export function decisionsOf(
  items: ApprovalItem[],
  me: string | null
): Decision[] {
  const rank = (d: Decision) =>
    !d.flag.assignee ? 1 : d.flag.assignee.login === me ? 0 : 2;
  const found: Decision[] = [];
  for (const item of items)
    for (const agent of item.agents)
      for (const flag of agent.flags)
        if (
          flag.kind === 'needs_person' &&
          !flag.approvedAt &&
          flag.question?.trim()
        )
          found.push({ item, agent, flag });
  return found
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i)
    .map(({ d }) => d);
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** "a", "a and b", "a, b and c". */
const joinAnd = (xs: string[]) =>
  xs.length < 2
    ? (xs[0] ?? '')
    : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/**
 * Home's statement. `decisions` are plain questions for the owner and `others` everything else waiting in Approvals.
 * `broken` lists the repositories whose tests on main are failing, or is null when health could not be read (then it
 * does not claim that nothing is broken).
 */
export function homeHeadline(input: {
  decisions: number;
  others: number;
  broken: string[] | null;
}): string {
  const { decisions, others, broken } = input;
  const parts = [
    decisions > 0 && plural(decisions, 'decision'),
    others > 0 &&
      (decisions > 0 ? plural(others, 'other item') : plural(others, 'item')),
  ].filter((p): p is string => !!p);
  const needs = parts.length
    ? `${joinAnd(parts)} ${decisions + others === 1 ? 'needs' : 'need'} you.`
    : 'Nothing needs you.';
  if (broken === null) return needs;
  if (broken.length) return `Tests are failing on ${joinAnd(broken)}. ${needs}`;
  return `Nothing is broken. ${needs}`;
}

/** The sentence under Home's statement: what merged in the last seven days and how much needed no merge click. */
export function homeLede(input: {
  merged7d: number;
  automatic: number;
}): string {
  const { merged7d, automatic } = input;
  if (merged7d === 0) return 'Nothing has merged in the last 7 days.';
  const merged = `GitOrange merged ${plural(merged7d, 'change')} in the last 7 days`;
  if (automatic === merged7d)
    return merged7d === 1
      ? `${merged}, and it needed no merge click.`
      : `${merged}, and none needed a merge click.`;
  return `${merged}; ${automatic} needed no merge click.`;
}

/** "Friday 9 October", in the reader's own day. */
export function dateEyebrow(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).formatToParts(now);
  const of = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${of('weekday')} ${of('day')} ${of('month')}`;
}

/**
 * The code repositories Home checks the health of: the busiest first (open pull requests plus merges this week,
 * then the most recently changed). Reviewer agents' instruction repositories are left out.
 */
export function topByActivity(rows: BoardRow[], count: number): BoardRow[] {
  const score = (r: BoardRow) =>
    r.repo.stats.pulls.open + r.repo.stats.merged7d;
  return rows
    .filter((r) => r.agent === null)
    .sort(
      (a, b) =>
        score(b) - score(a) ||
        b.repo.stats.updatedAt - a.repo.stats.updatedAt ||
        a.repo.fullName.localeCompare(b.repo.fullName)
    )
    .slice(0, count);
}

export interface RepoHealth {
  repo: string;
  report: HealthReport;
}

/** The repositories whose tests on main are failing now. */
export function brokenRepos(reports: RepoHealth[]): string[] {
  return reports
    .filter((r) => r.report.areas.some((a) => a.id === 'tests' && a.open > 0))
    .map((r) => r.repo);
}

export interface GlanceLine {
  trend: HealthTrend;
  text: string;
}

/**
 * "Since last week": every area that got worse, then every one that got better, then what stayed the same (an area
 * with problems still open on its own line, the quiet ones together). With several repositories each line names its
 * repository, and the quiet areas are only counted.
 */
export function sinceLastWeek(reports: RepoHealth[]): GlanceLine[] {
  const several = reports.length > 1;
  const worse: GlanceLine[] = [];
  const better: GlanceLine[] = [];
  const same: GlanceLine[] = [];
  for (const { repo, report } of reports) {
    // "Security in a/one" when there are several repositories, else just "Security".
    const named = (label: string) => (several ? `${label} in ${repo}` : label);
    const quiet: string[] = [];
    for (const a of report.areas) {
      if (a.trend === 'worse')
        worse.push({ trend: 'worse', text: `${named(a.label)}: ${a.detail}` });
      else if (a.trend === 'better')
        better.push({
          trend: 'better',
          text: `${named(a.label)}: ${a.detail}`,
        });
      else if (a.open > 0)
        same.push({ trend: 'same', text: `${named(a.label)}: ${a.status}` });
      else quiet.push(a.label);
    }
    if (quiet.length)
      same.push({
        trend: 'same',
        text: several
          ? `${plural(quiet.length, 'area')} in ${repo} unchanged`
          : `No change in ${joinAnd(quiet)}`,
      });
  }
  return [...worse, ...better, ...same];
}

/** One repository's verdict on its Home card: failing tests, then decisions waiting, then what got worse, else healthy. */
export function repoVerdict(report: HealthReport): {
  tone: Tone;
  label: string;
} {
  if (report.areas.some((a) => a.id === 'tests' && a.open > 0))
    return { tone: 'critical', label: 'Tests are failing on main' };
  if (report.decisionsWaiting > 0)
    return {
      tone: 'warn',
      label: `${plural(report.decisionsWaiting, 'decision')} for you`,
    };
  const worse = report.areas.filter((a) => a.trend === 'worse');
  if (worse.length === 1)
    return { tone: 'serious', label: `${worse[0].label} got worse` };
  if (worse.length > 1)
    return { tone: 'serious', label: `${worse.length} areas got worse` };
  return { tone: 'good', label: 'Healthy' };
}

/** Pull request timeline entries worth a line in the feed; the rest (state changes, stacking) is noise on Home. */
const LOUD_PULL = new Set([
  'pull.merged',
  'pull.reverted',
  'pull.approved',
  'pull.withdrawn',
  'pull.learned',
  'pull.rebased',
]);

/** Whether an audit event belongs in Home's activity feed. */
export function isNotable(e: AuditEvent): boolean {
  if (e.action === 'branch.deleted') return false;
  if (e.action.startsWith('pull.')) return LOUD_PULL.has(e.action);
  return true;
}

/** The newest notable events of several repositories' logs, once each, at most `limit`. */
export function mergeActivity(
  lists: AuditEvent[][],
  limit: number
): AuditEvent[] {
  const seen = new Set<string>();
  const all: AuditEvent[] = [];
  for (const list of lists)
    for (const e of list) {
      if (seen.has(e.id) || !isNotable(e)) continue;
      seen.add(e.id);
      all.push(e);
    }
  return all
    .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, limit);
}
