import { and, asc, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import {
  agents,
  auditEvents,
  mergeResolutions,
  prClassifications,
  prReviewFlags,
  pullRequests,
  repositoryAgents,
  workflowRuns,
  type Repository,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import { agentColor } from '../agents/presets';
import type { GitService } from '../git/service';
import { latestStates } from '../pulls/events';
import { pullStates } from '../pulls/signals';
import type { PullState } from '../pulls/state';
import { reviewConfigured } from '../review/head';
import { chunks } from '../stack/view';
import { mainStatus } from './branches';
import { GHOST, personRefs } from './person-ref';

// A repository's health (Decision 1), measured only from what GitOrange itself knows, week over week (ISO weeks,
// Monday 00:00 UTC): one row per invited reviewer agent (its findings: those that needed a person or asked for
// changes), "Tests on main" (the share of finished runs on the default branch that failed) and "Merging" (reverts;
// merges and clashes GitOrange fixed in its status). Every row counts problems, so a row got worse when this week has
// more than last week. Sentences are plain English for the owner.

export type Trend = 'better' | 'same' | 'worse';

export type HealthArea = {
  id: string;
  label: string;
  color: string | null;
  /** The agent's handle, for an agent's row. */
  agent: string | null;
  thisWeek: number;
  lastWeek: number;
  /** Problems per ISO week, the last 8, oldest first: this week last. */
  weeks: number[];
  trend: Trend;
  /** Where it stands now, in a sentence. */
  status: string;
  /** This week against last, in a sentence. */
  detail: string;
  /** Problems open now. */
  open: number;
};

export type HealthContributor = {
  who: {
    kind: 'person' | 'session';
    /** A person's name, or a session's label (else its app's name). */
    label: string;
    /** The person, or the person the session worked for. */
    login: string;
    /** The app of a session; null for a person working by hand. */
    client: string | null;
  };
  /** Pull requests merged this week. */
  merged: number;
  /** Findings agents raised this week on their pull requests. */
  findings: number;
  note: string | null;
  /** Their findings this week against last. */
  trend: Trend;
};

export type HealthReport = {
  summary: string;
  /** Findings waiting for a person, plus pull requests waiting for a person's approval for another reason. */
  decisionsWaiting: number;
  areas: HealthArea[];
  contributors: HealthContributor[];
};

const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const HEALTH_WEEKS = 8;

/** Monday 00:00 UTC of the ISO week holding `ms`. */
export function isoWeekStart(ms: number): number {
  const day = Math.floor(ms / DAY_MS);
  // 1 January 1970 (day 0) was a Thursday, three days after a Monday.
  return (day - ((day + 3) % 7)) * DAY_MS;
}

/** The starts of the last 8 ISO weeks, oldest first: the last is the week holding `now`. */
export function weekStarts(now: number): number[] {
  const start = isoWeekStart(now);
  return Array.from(
    { length: HEALTH_WEEKS },
    (_, i) => start - (HEALTH_WEEKS - 1 - i) * WEEK_MS
  );
}

/** How many of `times` (epoch ms) fall in each week of `starts`; others are left out. */
export function perWeek(times: number[], starts: number[]): number[] {
  const out = starts.map(() => 0);
  for (const t of times) {
    const i = Math.floor((t - starts[0]) / WEEK_MS);
    if (i >= 0 && i < out.length) out[i]++;
  }
  return out;
}

/** More problems this week than last is worse; fewer is better. */
export function trendOf(thisWeek: number, lastWeek: number): Trend {
  return thisWeek > lastWeek
    ? 'worse'
    : thisWeek < lastWeek
      ? 'better'
      : 'same';
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** "a", "a and b", "a, b and c". */
const joinAnd = (xs: string[]) =>
  xs.length < 2
    ? (xs[0] ?? '')
    : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;

/** "3 raised this week, 1 more than last week", or `none` when both weeks are zero. */
function weekOverWeek(
  thisWeek: number,
  lastWeek: number,
  what: (n: number) => string,
  none: string
): string {
  if (thisWeek === lastWeek)
    return thisWeek === 0
      ? none
      : `${what(thisWeek)} this week, same as last week`;
  const diff = Math.abs(thisWeek - lastWeek);
  return `${what(thisWeek)} this week, ${diff} ${thisWeek > lastWeek ? 'more' : 'fewer'} than last week`;
}

const pct = (part: number, whole: number) => Math.round((part / whole) * 100);

/**
 * The health report of `repo`. D1 is read a fixed number of times (agents, findings, runs, merges, reverts, clashes
 * fixed, open pull requests); git once for the open pull requests' states (`pullStates`, batched), falling back to the
 * states last recorded.
 */
export async function repoHealth(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  repo: Repository,
  opts: { now?: number } = {}
): Promise<HealthReport> {
  const now = opts.now ?? Date.now();
  const starts = weekStarts(now);
  const since = new Date(starts[0]);
  const thisWeekStart = starts[HEALTH_WEEKS - 1];
  const lastWeekStart = starts[HEALTH_WEEKS - 2];

  const [invited, flags, runs, merged, reverts, fixes, open, main] =
    await Promise.all([
      db
        .select({
          agentId: agents.userId,
          handle: users.username,
          name: agents.name,
          color: agents.color,
        })
        .from(repositoryAgents)
        .innerJoin(agents, eq(agents.userId, repositoryAgents.agentId))
        .innerJoin(users, eq(users.id, agents.userId))
        .where(
          and(
            eq(repositoryAgents.repositoryId, repo.id),
            isNull(agents.deletedAt)
          )
        )
        .orderBy(asc(users.username))
        .all(),
      db
        .select({
          agentId: prReviewFlags.agentId,
          kind: prReviewFlags.kind,
          createdAt: prReviewFlags.createdAt,
          approvedAt: prReviewFlags.approvedAt,
          pullRequestId: prClassifications.pullRequestId,
        })
        .from(prReviewFlags)
        .innerJoin(
          prClassifications,
          eq(prClassifications.id, prReviewFlags.classificationId)
        )
        .innerJoin(
          pullRequests,
          eq(pullRequests.id, prClassifications.pullRequestId)
        )
        .where(
          and(
            eq(pullRequests.repositoryId, repo.id),
            or(
              gte(prReviewFlags.createdAt, since),
              gte(prReviewFlags.approvedAt, since)
            )
          )
        )
        .all(),
      db
        .select({
          conclusion: workflowRuns.conclusion,
          completedAt: workflowRuns.completedAt,
        })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.repositoryId, repo.id),
            eq(workflowRuns.event, 'push'),
            eq(workflowRuns.ref, `refs/heads/${repo.defaultBranch}`),
            eq(workflowRuns.status, 'completed'),
            gte(workflowRuns.completedAt, since)
          )
        )
        .all(),
      db
        .select({
          id: pullRequests.id,
          number: pullRequests.number,
          authorId: pullRequests.authorId,
          createdVia: pullRequests.createdVia,
          sessionLabel: pullRequests.sessionLabel,
        })
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repositoryId, repo.id),
            eq(pullRequests.state, 'merged'),
            gte(pullRequests.mergedAt, new Date(thisWeekStart))
          )
        )
        .all(),
      db
        .select({ createdAt: auditEvents.createdAt })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.repositoryId, repo.id),
            eq(auditEvents.action, 'pull.reverted'),
            gte(auditEvents.createdAt, since)
          )
        )
        .all(),
      db
        .select({
          createdAt: mergeResolutions.createdAt,
          decidedAt: mergeResolutions.decidedAt,
        })
        .from(mergeResolutions)
        .innerJoin(
          pullRequests,
          eq(pullRequests.id, mergeResolutions.pullRequestId)
        )
        .where(
          and(
            eq(pullRequests.repositoryId, repo.id),
            eq(mergeResolutions.status, 'applied'),
            or(
              gte(mergeResolutions.decidedAt, new Date(thisWeekStart)),
              gte(mergeResolutions.createdAt, new Date(thisWeekStart))
            )
          )
        )
        .all(),
      db
        .select()
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repositoryId, repo.id),
            eq(pullRequests.state, 'open')
          )
        )
        .all(),
      mainStatus(db, repo),
    ]);

  let states = new Map<string, PullState>();
  if (open.length)
    try {
      states = await pullStates(db, git, repo.id, open, {
        reviewConfigured: reviewConfigured(env),
        mergingPaused: !!repo.mergingPausedAt,
      });
    } catch (e) {
      console.error('[health] could not compute states', repo.id, e);
      states = await latestStates(
        db,
        open.map((p) => p.id)
      ).catch(() => new Map<string, PullState>());
    }

  // What is open now: each agent's undecided findings at the current heads, decisions waiting for a person, clashes.
  const openByAgent = new Map<string, number>();
  let decisionsWaiting = 0;
  let clashes = 0;
  for (const s of states.values()) {
    let flagged = 0;
    for (const r of s.reasons) {
      if (r.kind === 'agent_flagged') {
        flagged += r.flags.length;
        openByAgent.set(
          r.agent,
          (openByAgent.get(r.agent) ?? 0) + r.flags.length
        );
      } else if (r.kind === 'agent_changes_requested')
        openByAgent.set(
          r.agent,
          (openByAgent.get(r.agent) ?? 0) + r.changes.length
        );
    }
    decisionsWaiting += flagged || (s.state === 'human_review' ? 1 : 0);
    if (s.reasons.some((r) => r.kind === 'rebase_conflict')) clashes++;
  }

  const areas: (HealthArea & { why: string })[] = [];
  const last = HEALTH_WEEKS - 1;

  for (const a of invited) {
    const handle = a.handle ?? a.agentId;
    const own = flags.filter((f) => f.agentId === a.agentId);
    const weeks = perWeek(
      own.map((f) => f.createdAt.getTime()),
      starts
    );
    const accepted = own.filter(
      (f) =>
        f.kind === 'needs_person' &&
        f.approvedAt &&
        f.approvedAt.getTime() >= thisWeekStart
    ).length;
    const openNow = openByAgent.get(handle) ?? 0;
    areas.push({
      id: `agent:${handle}`,
      label: a.name,
      color: agentColor(a, handle),
      agent: handle,
      thisWeek: weeks[last],
      lastWeek: weeks[last - 1],
      weeks,
      trend: trendOf(weeks[last], weeks[last - 1]),
      status: openNow ? plural(openNow, 'open problem') : 'No open problems',
      detail:
        weekOverWeek(
          weeks[last],
          weeks[last - 1],
          (n) => `${n} raised`,
          'None raised this week or last'
        ) + (accepted ? `. ${plural(accepted, 'risk')} accepted` : ''),
      open: openNow,
      why: `${plural(weeks[last], 'finding')} this week, up from ${weeks[last - 1]}`,
    });
  }

  // Tests on main: the share of finished runs (passed or failed) that failed, per week; 0 for a week without runs.
  const passed = starts.map(() => 0);
  const failed = starts.map(() => 0);
  for (const r of runs) {
    const i = Math.floor((r.completedAt!.getTime() - starts[0]) / WEEK_MS);
    if (i < 0 || i >= HEALTH_WEEKS) continue;
    if (r.conclusion === 'success') passed[i]++;
    else if (r.conclusion === 'failure') failed[i]++;
  }
  const total = (i: number) => passed[i] + failed[i];
  const failedPct = starts.map((_, i) =>
    total(i) ? pct(failed[i], total(i)) : 0
  );
  const passThis = total(last) ? pct(passed[last], total(last)) : null;
  const passLast = total(last - 1)
    ? pct(passed[last - 1], total(last - 1))
    : null;
  areas.push({
    id: 'tests',
    label: 'Tests on main',
    color: null,
    agent: null,
    thisWeek: failedPct[last],
    lastWeek: failedPct[last - 1],
    weeks: failedPct,
    trend: trendOf(failedPct[last], failedPct[last - 1]),
    status: {
      failing: 'Failing now',
      passing: 'Passing',
      running: 'Running now',
      unknown: 'No tests have run yet',
    }[main],
    detail:
      passThis === null
        ? 'No test runs this week'
        : `${passThis}% of ${plural(total(last), 'run')} passed this week` +
          (passLast === null
            ? ''
            : passLast === passThis
              ? ', same as last week'
              : `, was ${passLast}% last week`),
    open: main === 'failing' ? 1 : 0,
    why:
      passThis === null
        ? 'no test runs this week'
        : `${passThis}% of test runs passed` +
          (passLast === null ? '' : `, down from ${passLast}%`),
  });

  // Merging: reverts are its problems; merges and clashes GitOrange fixed say how it went.
  const revertWeeks = perWeek(
    reverts.map((r) => r.createdAt.getTime()),
    starts
  );
  const fixed = fixes.filter(
    (f) => (f.decidedAt ?? f.createdAt).getTime() >= thisWeekStart
  ).length;
  areas.push({
    id: 'merging',
    label: 'Merging',
    color: null,
    agent: null,
    thisWeek: revertWeeks[last],
    lastWeek: revertWeeks[last - 1],
    weeks: revertWeeks,
    trend: trendOf(revertWeeks[last], revertWeeks[last - 1]),
    status:
      (merged.length
        ? `${merged.length} merged this week`
        : 'Nothing merged this week') +
      (fixed
        ? `, ${plural(fixed, 'clash', 'clashes')} fixed by GitOrange`
        : ''),
    detail: weekOverWeek(
      revertWeeks[last],
      revertWeeks[last - 1],
      (n) => plural(n, 'revert'),
      'No reverts this week or last'
    ),
    open: clashes,
    why: `${plural(revertWeeks[last], 'revert')} this week, up from ${revertWeeks[last - 1]}`,
  });

  const worse = areas.filter((a) => a.trend === 'worse');
  const summary = !worse.length
    ? 'Nothing got worse this week.'
    : worse.length === 1
      ? `${worse[0].label} got worse: ${worse[0].why}.`
      : `${joinAnd(worse.map((a) => a.label))} got worse this week.`;

  return {
    summary,
    decisionsWaiting,
    areas: areas.map(({ why: _why, ...a }) => a),
    contributors: await contributors(db, merged, flags, {
      thisWeekStart,
      lastWeekStart,
    }),
  };
}

/**
 * People and coding sessions that merged this week: a coding session is the pull requests one app opened for one
 * person under one label (as worker/src/lib/sessions.ts groups them); pull requests opened by hand are the person's.
 * Their findings are those agents raised this week (and last, for the trend) on any of the group's pull requests.
 */
async function contributors(
  db: DrizzleDB,
  merged: {
    id: string;
    number: number;
    authorId: string;
    createdVia: string | null;
    sessionLabel: string | null;
  }[],
  flags: { createdAt: Date; pullRequestId: string }[],
  weeks: { thisWeekStart: number; lastWeekStart: number }
): Promise<HealthContributor[]> {
  if (!merged.length) return [];
  type Row = (typeof merged)[number];
  const keyOf = (p: Row) =>
    p.createdVia
      ? `${p.authorId}\0${p.createdVia}\0${p.sessionLabel ?? ''}`
      : p.authorId;
  // The pull requests findings were raised on, to find their group.
  const rows = new Map(merged.map((p) => [p.id, p]));
  const unknown = [...new Set(flags.map((f) => f.pullRequestId))].filter(
    (id) => !rows.has(id)
  );
  for (const part of chunks(unknown, 90))
    for (const p of await db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        authorId: pullRequests.authorId,
        createdVia: pullRequests.createdVia,
        sessionLabel: pullRequests.sessionLabel,
      })
      .from(pullRequests)
      .where(inArray(pullRequests.id, part))
      .all())
      rows.set(p.id, p);

  type Group = {
    first: Row;
    merged: number;
    thisWeek: number;
    lastWeek: number;
    byNumber: Map<number, number>;
  };
  const groups = new Map<string, Group>();
  for (const p of merged) {
    const g = groups.get(keyOf(p));
    if (g) g.merged++;
    else
      groups.set(keyOf(p), {
        first: p,
        merged: 1,
        thisWeek: 0,
        lastWeek: 0,
        byNumber: new Map(),
      });
  }
  for (const f of flags) {
    const p = rows.get(f.pullRequestId);
    const g = p && groups.get(keyOf(p));
    if (!p || !g) continue;
    const at = f.createdAt.getTime();
    if (at >= weeks.thisWeekStart) {
      g.thisWeek++;
      g.byNumber.set(p.number, (g.byNumber.get(p.number) ?? 0) + 1);
    } else if (at >= weeks.lastWeekStart) g.lastWeek++;
  }

  const people = await personRefs(
    db,
    [...groups.values()].map((g) => g.first.authorId)
  );
  return [...groups.values()]
    .map((g): HealthContributor => {
      const person = people.get(g.first.authorId) ?? GHOST;
      const client = g.first.createdVia || null;
      const [top] = [...g.byNumber].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      return {
        who: client
          ? {
              kind: 'session',
              label: g.first.sessionLabel || client,
              login: person.login,
              client,
            }
          : {
              kind: 'person',
              label: person.name ?? person.login,
              login: person.login,
              client: null,
            },
        merged: g.merged,
        findings: g.thisWeek,
        note: top
          ? `${plural(g.thisWeek, 'finding')}${g.byNumber.size > 1 ? ', most' : ''} on #${top[0]}`
          : null,
        trend: trendOf(g.thisWeek, g.lastWeek),
      };
    })
    .sort(
      (a, b) =>
        b.merged - a.merged ||
        a.who.label.localeCompare(b.who.label) ||
        a.who.login.localeCompare(b.who.login)
    );
}
