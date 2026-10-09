/**
 * The rules behind a repository's Health page: how a row's numbers are charted and named, the one decision that
 * waits on the owner, who is credited with what got better or worse, and how each reviewer is described. Pure, so
 * the page stays thin and the wording (plain English, never a pass rate for the tests row) is tested.
 *
 * Units, from the API: an agent row counts findings it raised, "Tests on main" the SHARE OF RUNS THAT FAILED (0 for a
 * week without runs), "Merging" reverts. Every row counts problems, so lower is better.
 */
import type { Tone } from './agentLook';
import {
  dedupeItems,
  findingSentence,
  inboxRows,
  isDecided,
  isOwnerQuestion,
} from './approvalsInbox';
import type { FindingRow } from './approvalsInbox';
import type {
  Agent,
  AgentActivity,
  AgentStats,
  ApprovalItem,
  HealthArea,
  HealthReport,
  HealthTrend,
} from './uiApi';

export type Contributor = HealthReport['contributors'][number];

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

export type AreaKind = 'agent' | 'tests' | 'merging';

/** An agent's row, the tests row (`tests`) or the merging row (`merging`). */
export function areaKind(area: Pick<HealthArea, 'id' | 'agent'>): AreaKind {
  if (area.agent) return 'agent';
  return area.id === 'tests' ? 'tests' : 'merging';
}

/** What the Change chip says for a trend, and its tone. */
export const TREND_LOOK: Record<HealthTrend, { label: string; tone: Tone }> = {
  better: { label: 'Better', tone: 'good' },
  same: { label: 'Same', tone: 'off' },
  worse: { label: 'Worse', tone: 'serious' },
};

/** Names for `count` weeks, oldest first: "7 weeks ago" … "Last week", "This week". */
export function weekLabels(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const ago = count - 1 - i;
    return ago === 0
      ? 'This week'
      : ago === 1
        ? 'Last week'
        : `${ago} weeks ago`;
  });
}

/**
 * How to chart a row's weeks: the unit each point's tooltip ends with and the name for assistive tech. The tests
 * row says "failed" in both, because its numbers are the share of runs that failed, not a pass rate. A week of the
 * tests row in which no run finished is `missing`: its 0 is not a measurement, so it is drawn as a gap.
 */
export function areaSpark(area: HealthArea): {
  values: number[];
  unit: string;
  label: string;
  labels: string[];
  trend: HealthTrend;
  missing?: boolean[];
  missingText: string;
} {
  const kind = areaKind(area);
  const unit =
    kind === 'tests'
      ? '% of runs failed'
      : kind === 'merging'
        ? ' reverted'
        : ' raised';
  const what =
    kind === 'tests'
      ? 'share of runs that failed'
      : kind === 'merging'
        ? 'reverts'
        : 'findings raised';
  const gaps =
    kind === 'tests' &&
    area.noRuns?.length === area.weeks.length &&
    area.noRuns.some(Boolean)
      ? area.noRuns
      : undefined;
  return {
    values: area.weeks,
    unit,
    label: `${area.label}, ${what}, last ${area.weeks.length} weeks${gaps ? '; weeks with no test runs are gaps' : ''}`,
    labels: weekLabels(area.weeks.length),
    trend: area.trend,
    missing: gaps,
    missingText: 'no test runs',
  };
}

/** The sentence under the page's title: the summary, what waits on the owner, and what is open. */
export function healthLede(report: HealthReport, openPulls: number): string {
  const parts = [report.summary];
  if (report.decisionsWaiting)
    parts.push(
      report.decisionsWaiting === 1
        ? '1 decision needs you.'
        : `${report.decisionsWaiting} decisions need you.`
    );
  parts.push(
    openPulls === 0
      ? 'No pull requests open.'
      : `${plural(openPulls, 'pull request')} open.`
  );
  return parts.join(' ');
}

/**
 * The one decision to put in front of the owner: an unanswered finding for a person in this repository, a plain
 * question before an ordinary finding. Change requests are the author's to fix, not a decision.
 */
export function pickDecision(
  items: ApprovalItem[],
  fullName: string
): FindingRow | null {
  const here = fullName.toLowerCase();
  const waiting = inboxRows(dedupeItems([{ items }])).filter(
    (r): r is FindingRow =>
      r.type === 'finding' &&
      r.repo.toLowerCase() === here &&
      r.flag.kind === 'needs_person' &&
      !isDecided(r.flag)
  );
  return waiting.find((r) => isOwnerQuestion(r)) ?? waiting[0] ?? null;
}

/** The words on the decision card: who is asking, what, and the recorded sentence under it. */
export function decisionCopy(row: FindingRow): {
  from: string;
  title: string;
  body: string | null;
} {
  const agent = row.agent.name || `@${row.agent.username}`;
  const question = row.flag.question?.trim();
  return {
    from: question ? `${agent} is asking` : `${agent} wants a person to decide`,
    title: question || row.flag.title,
    body: findingSentence(row.flag),
  };
}

/**
 * What to say about a person or coding session under "Who made things better or worse": the reviewers' findings on
 * their changes this week, set against last week. `dir` picks the icon.
 */
export function contributorLine(c: Contributor): {
  text: string;
  detail: string;
  dir: HealthTrend;
} {
  if (c.findings === 0)
    return c.trend === 'better'
      ? {
          text: 'Nothing got worse',
          detail: 'No findings this week, fewer than last week',
          dir: 'better',
        }
      : {
          text: 'Nothing got worse',
          detail: 'No findings from your reviewers',
          dir: 'same',
        };
  return {
    text: c.note ?? plural(c.findings, 'finding'),
    detail: {
      worse: 'More than last week',
      better: 'Fewer than last week',
      same: 'Same as last week',
    }[c.trend],
    dir: c.trend,
  };
}

/** The monogram a coding session's tile shows: the app's first letter. Codex is an "X", drawn as an outline. */
export function clientMark(client: string | null | undefined): {
  mark: string;
  codex: boolean;
} {
  const name = (client ?? '').trim();
  const codex = /codex/i.test(name);
  return { mark: codex ? 'X' : name.charAt(0).toUpperCase() || '?', codex };
}

/**
 * One line about a reviewer: what it raised this week here, then its record overall (the share of its findings a
 * person kept, the rules it learned), which says "overall" because it covers every repository it reviews. Null when
 * neither is known.
 */
export function reviewerRecord(
  area: Pick<HealthArea, 'thisWeek'> | undefined,
  stats: Pick<AgentStats, 'keptPct' | 'rules'> | undefined
): string | null {
  const parts: string[] = [];
  if (area)
    parts.push(
      area.thisWeek === 0
        ? 'Nothing raised this week'
        : `${area.thisWeek} raised this week`
    );
  if (stats) {
    if (stats.keptPct !== null) parts.push(`${stats.keptPct}% kept overall`);
    if (stats.rules > 0)
      parts.push(`${plural(stats.rules, 'rule')} learned overall`);
  }
  return parts.length ? parts.join(' · ') : null;
}

/** What a reviewer is doing in this repository now; null while its record has not loaded. */
export function reviewerState(
  stats: Pick<AgentStats, 'repos'> | undefined,
  fullName: string
): AgentActivity | null {
  if (!stats) return null;
  const here = fullName.toLowerCase();
  return (
    stats.repos.find((r) => r.repo.toLowerCase() === here)?.status ?? 'idle'
  );
}

/** The agents that exist but do not review this repository (deleted ones are left out). */
export function notReviewing(
  all: readonly Agent[],
  invited: readonly { username: string }[]
): Agent[] {
  const on = new Set(invited.map((a) => a.username.toLowerCase()));
  return all.filter((a) => !a.deletedAt && !on.has(a.username.toLowerCase()));
}

/**
 * What the reviewers list says when no reviewer is on the project. Only an admin of the repository is told to add
 * one; anyone else is told who can.
 */
export function noReviewersBody(o: {
  /** The viewer is an admin of this repository (the Add buttons are theirs). */
  admin: boolean;
  /** Reviewers that exist but are not on this repository. */
  available: number;
}): string {
  const what = 'Reviewers look at each change before it merges.';
  if (o.available === 0)
    return `${what} A site admin can create them from Agents.`;
  return o.admin
    ? `${what} Add one below.`
    : `${what} An admin of this repository can add one.`;
}
