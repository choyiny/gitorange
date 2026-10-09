import { and, desc, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import {
  prClassifications,
  prReviewers,
  prReviewFlags,
  pullRequests,
  repositories,
  type ReviewerStatus,
} from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import { invitedRepositories } from '../agents/accounts';
import { flagTitleOf } from '../review/gate';
import type { SessionUser } from '../variables';
import { findReposByIds, visibleTo } from './repos';

// What an agent's profile and the Agents page show: how its findings fared, how busy it was, where it works now
// (`GET /api/agents/{handle}/stats`), and the numbers for the two built-in agents, Clef and Fixer
// (`GET /api/agents/builtin`). Every number is an aggregate computed in D1, and counts only what `viewer` can see:
// a finding, review or run in a repository they can't read is left out, as the profile's recent reviews are.

export type AgentStatus = ReviewerStatus | 'idle';

export type AgentStats = {
  handle: string;
  /** Findings it raised, of any kind. */
  raised: number;
  /** Findings that stood: a finding for a person that a person approved, or a change request its author fixed. */
  kept: number;
  /** Change requests a person dismissed as wrong. */
  dismissed: number;
  /** kept / (kept + dismissed) as a whole percentage; null until one has been decided. */
  keptPct: number | null;
  /** Rules it learned: its committed lessons. */
  rules: number;
  /** Reviews it did (every reviewer row but "not needed"). */
  reviews: number;
  /** Reviews per UTC day over the last 182 days, oldest first, today last. */
  byDay: { date: string; reviews: number }[];
  /** The newest finding a person approved. */
  bestCatch: { title: string; repo: string; number: number } | null;
  /** Each repository it is invited to, and what it is doing there. */
  repos: { repo: string; status: AgentStatus; number: number | null }[];
};

export type BuiltinAgent = {
  id: 'clef' | 'fixer';
  name: string;
  job: string;
  stats: { label: string; value: string }[];
};

const DAY = 86_400_000;
export const BY_DAY_LENGTH = 182;

const n = (v: unknown) => Number(v ?? 0);

/** The viewer's repository filter (`visibleTo`; nothing for an admin) as SQL over the `repositories` table. */
const visible = (viewer: SessionUser): SQL => visibleTo(viewer) ?? sql`1 = 1`;

/** 'YYYY-MM-DD' of the UTC day that contains `ms`. */
export const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The `count` UTC days ending today, oldest first, as 'YYYY-MM-DD'. */
export function lastUtcDays(count: number, now: Date): string[] {
  const today = Math.floor(now.getTime() / DAY) * DAY;
  return Array.from({ length: count }, (_, i) =>
    utcDate(today - (count - 1 - i) * DAY)
  );
}

/** Most pressing first: what blocks a merge, then what is in progress, then what is done. */
const PRESSING: ReviewerStatus[] = [
  'failed',
  'changes_requested',
  'flagged',
  'reviewing',
  'approved',
];

/**
 * What an agent is doing across some open pull requests, given its newest review of each, newest first: the most
 * pressing status among them, and the pull request it is on (the newest of that status). `idle` without any.
 */
export function currentStatus(
  rows: { status: ReviewerStatus; number: number }[]
): { status: AgentStatus; number: number | null } {
  let best: { status: ReviewerStatus; number: number } | undefined;
  for (const r of rows) {
    const rank = PRESSING.indexOf(r.status);
    if (rank >= 0 && (!best || rank < PRESSING.indexOf(best.status))) best = r;
  }
  return best
    ? { status: best.status, number: best.number }
    : { status: 'idle', number: null };
}

/** One agent's review of one open pull request, as `currentReviews` returns it. */
export type CurrentReview = {
  pullRequestId: string;
  repositoryId: string;
  agentId: string;
  number: number;
  status: ReviewerStatus;
};

/**
 * What each agent is doing on the open pull requests of `repositoryIds` (`agentId`: only that agent), keyed
 * `<repository id>:<agent id>`: its newest review of each open pull request, newest first. The one read behind the
 * board's agent chips and an agent's `repos`.
 *
 * Clef writes a review row for every invited agent on every head commit, with status `not_needed` for the agents it
 * didn't wake. So the newest row is picked first, `not_needed` included, and only then dropped: an agent that flagged
 * an earlier head and isn't needed at the current one is not on that pull request any more, and must not keep showing the
 * old head's `flagged` or `changes_requested`.
 */
export async function currentReviews(
  db: DrizzleDB,
  repositoryIds: string[],
  agentId?: string
): Promise<Map<string, CurrentReview[]>> {
  const out = new Map<string, CurrentReview[]>();
  if (!repositoryIds.length) return out;
  const rows = await db
    .select({
      pullRequestId: prReviewers.pullRequestId,
      repositoryId: pullRequests.repositoryId,
      agentId: prReviewers.agentId,
      number: pullRequests.number,
      status: prReviewers.status,
      requested: prReviewers.requested,
    })
    .from(prReviewers)
    .innerJoin(pullRequests, eq(pullRequests.id, prReviewers.pullRequestId))
    .where(
      and(
        agentId ? eq(prReviewers.agentId, agentId) : undefined,
        eq(pullRequests.state, 'open'),
        sql`${pullRequests.repositoryId} IN (SELECT value FROM json_each(${JSON.stringify(repositoryIds)}))`
      )
    )
    .orderBy(desc(prReviewers.createdAt), sql`${prReviewers}.rowid DESC`)
    .all();
  const seen = new Set<string>();
  for (const { requested, ...r } of rows) {
    const once = `${r.pullRequestId}:${r.agentId}`;
    if (seen.has(once)) continue;
    seen.add(once);
    if (!requested || r.status === 'not_needed') continue;
    const key = `${r.repositoryId}:${r.agentId}`;
    out.set(key, [...(out.get(key) ?? []), r]);
  }
  return out;
}

/**
 * An agent's stats as `viewer` can see them.
 *
 * kept and dismissed: a needs_person finding a person approved is kept. A change_requested finding is dismissed when a
 * person dismissed (approved) it, and kept when nobody did and its pull request moved on: it merged, or a newer commit
 * was reviewed after it, so its author's agent fixed it. A finding still waiting is only counted as raised.
 */
export async function agentStats(
  db: DrizzleDB,
  agent: { userId: string; handle: string },
  viewer: SessionUser,
  now = new Date()
): Promise<AgentStats> {
  const can = visible(viewer);
  const id = agent.userId;
  const [flagRows, lessonRows, dayRows, catchRows, invited] = await Promise.all(
    [
      db.all<{ raised: number; kept: number; dismissed: number }>(sql`
        SELECT
          COUNT(*) AS raised,
          COALESCE(SUM(CASE
            WHEN f.kind = 'needs_person' AND f.approved_at IS NOT NULL THEN 1
            WHEN f.kind = 'change_requested' AND f.approved_at IS NULL AND (
              p.state = 'merged' OR EXISTS (
                SELECT 1 FROM pr_classifications c2
                WHERE c2.pull_request_id = c.pull_request_id AND c2.id <> c.id
                  AND (c2.created_at > c.created_at
                       OR (c2.created_at = c.created_at AND c2.rowid > c.rowid)))
            ) THEN 1 ELSE 0 END), 0) AS kept,
          COALESCE(SUM(f.kind = 'change_requested' AND f.approved_at IS NOT NULL), 0) AS dismissed
        FROM pr_review_flags f
        JOIN pr_classifications c ON c.id = f.classification_id
        JOIN pull_requests p ON p.id = c.pull_request_id
        JOIN repositories ON repositories.id = p.repository_id
        WHERE f.agent_id = ${id} AND ${can}`),
      db.all<{ rules: number }>(sql`
        SELECT COUNT(*) AS rules
        FROM agent_lessons l
        JOIN repositories ON repositories.id = l.repository_id
        WHERE l.agent_id = ${id} AND l.status = 'committed' AND ${can}`),
      // Every day it reviewed on: the window is cut below, and the total counts all of them.
      db.all<{ day: string; reviews: number }>(sql`
        SELECT strftime('%Y-%m-%d', rv.created_at, 'unixepoch') AS day, COUNT(*) AS reviews
        FROM pr_reviewers rv
        JOIN pull_requests p ON p.id = rv.pull_request_id
        JOIN repositories ON repositories.id = p.repository_id
        WHERE rv.agent_id = ${id} AND rv.status <> 'not_needed' AND ${can}
        GROUP BY day`),
      db
        .select({
          value: prReviewFlags.value,
          number: pullRequests.number,
          repositoryId: pullRequests.repositoryId,
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
        .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
        .where(
          and(
            eq(prReviewFlags.agentId, id),
            eq(prReviewFlags.kind, 'needs_person'),
            isNotNull(prReviewFlags.approvedAt),
            can
          )
        )
        .orderBy(
          desc(prReviewFlags.approvedAt),
          sql`${prReviewFlags}.rowid DESC`
        )
        .limit(1),
      invitedRepositories(db, id, viewer),
    ]
  );

  const f = flagRows[0];
  const kept = n(f?.kept);
  const dismissed = n(f?.dismissed);

  const perDay = new Map(dayRows.map((r) => [r.day, n(r.reviews)]));
  const byDay = lastUtcDays(BY_DAY_LENGTH, now).map((date) => ({
    date,
    reviews: perDay.get(date) ?? 0,
  }));

  let bestCatch: AgentStats['bestCatch'] = null;
  const caught = catchRows[0];
  if (caught) {
    const found = (await findReposByIds(db, [caught.repositoryId])).get(
      caught.repositoryId
    );
    if (found)
      bestCatch = {
        title: flagTitleOf({ value: caught.value }).slice(0, 200),
        repo: `${found.namespace.username}/${found.repo.name}`,
        number: caught.number,
      };
  }

  // Where it works now: its newest review of each open pull request, in each repository it is invited to.
  const reviewing = await currentReviews(
    db,
    invited.map((r) => r.repo.id),
    id
  );
  const repos = invited
    .map(({ repo, namespace }) => ({
      repo: `${namespace.username}/${repo.name}`,
      ...currentStatus(reviewing.get(`${repo.id}:${id}`) ?? []),
    }))
    .sort((a, b) => a.repo.localeCompare(b.repo));

  return {
    handle: agent.handle,
    raised: n(f?.raised),
    kept,
    dismissed,
    keptPct:
      kept + dismissed > 0
        ? Math.round((kept / (kept + dismissed)) * 100)
        : null,
    rules: n(lessonRows[0]?.rules),
    reviews: dayRows.reduce((sum, r) => sum + n(r.reviews), 0),
    byDay,
    bestCatch,
    repos,
  };
}

// ── Clef and Fixer ───────────────────────────────────────────────────────────

/** How far back Clef's and Fixer's numbers reach. */
const WEEK = 7 * DAY;

/** A review's duration in a few words: "41 ms", "1.5 s", "20 s", "3 min". */
export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/**
 * Clef and Fixer, with their last seven days (rolling), in repositories `viewer` can see.
 *
 * Clef: the changes it routed (reviews that got past summarizing: Clef had picked the agents, so `reviewing` or `done`)
 * and the median `duration_ms` of the reviews that finished, labelled "per review". That duration is the whole review
 * of one commit, from its start to when every agent it woke had answered (`executeHeadReview`'s `finish` step): it
 * includes the agents' time, not only Clef's own decision, and nothing records Clef's alone. "Test runs picked" has no
 * stored data either (a relevance decision is printed into its Actions step's log and never written to D1), so that
 * stat is left out.
 * Fixer: the runs of its two kinds (`rebase`, and the older `conflict_resolution`): all of them are attempts, the
 * succeeded ones were combined by Fixer itself, and a failed one is handed back to the author, who may still get the pull
 * request merged: distinct pull requests with a failed run that merged after it started count as "merged anyway".
 */
export async function builtinAgents(
  db: DrizzleDB,
  viewer: SessionUser,
  now = new Date()
): Promise<BuiltinAgent[]> {
  const can = visible(viewer);
  const sinceMs = now.getTime() - WEEK;
  const since = Math.floor(sinceMs / 1000);
  const [routed, median, fixer, anyway] = await Promise.all([
    db.all<{ n: number }>(sql`
      SELECT COUNT(*) AS n
      FROM pr_classifications c
      JOIN pull_requests p ON p.id = c.pull_request_id
      JOIN repositories ON repositories.id = p.repository_id
      WHERE c.created_at >= ${since} AND c.status IN ('reviewing', 'done') AND ${can}`),
    // The median, in one pass: the middle row, or the mean of the two middle ones.
    db.all<{ median: number | null }>(sql`
      WITH d AS (
        SELECT c.duration_ms AS x,
          ROW_NUMBER() OVER (ORDER BY c.duration_ms) AS rn,
          COUNT(*) OVER () AS cnt
        FROM pr_classifications c
        JOIN pull_requests p ON p.id = c.pull_request_id
        JOIN repositories ON repositories.id = p.repository_id
        WHERE c.created_at >= ${since} AND c.status = 'done' AND c.duration_ms IS NOT NULL AND ${can}
      )
      SELECT AVG(x) AS median FROM d WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)`),
    db.all<{ attempts: number; combined: number }>(sql`
      SELECT COUNT(*) AS attempts, COALESCE(SUM(r.status = 'succeeded'), 0) AS combined
      FROM agent_runs r
      JOIN repositories ON repositories.id = r.repository_id
      WHERE r.kind IN ('rebase', 'conflict_resolution') AND r.started_at >= ${sinceMs} AND ${can}`),
    db.all<{ n: number }>(sql`
      SELECT COUNT(DISTINCT r.pull_request_id) AS n
      FROM agent_runs r
      JOIN pull_requests p ON p.id = r.pull_request_id
      JOIN repositories ON repositories.id = r.repository_id
      WHERE r.kind IN ('rebase', 'conflict_resolution') AND r.status = 'failed'
        AND r.started_at >= ${sinceMs} AND p.state = 'merged'
        AND p.merged_at * 1000 + 999 >= r.started_at AND ${can}`),
  ]);

  const clef: BuiltinAgent['stats'] = [
    { label: 'changes routed', value: String(n(routed[0]?.n)) },
  ];
  const ms = median[0]?.median;
  if (ms !== null && ms !== undefined)
    clef.push({ label: 'per review', value: durationText(ms) });

  return [
    {
      id: 'clef',
      name: 'Clef',
      job: 'Sends each change to the helpers and tests it needs.',
      stats: clef,
    },
    {
      id: 'fixer',
      name: 'Fixer',
      job: 'Untangles changes that collide so they can go in.',
      stats: [
        { label: 'attempts', value: String(n(fixer[0]?.attempts)) },
        { label: 'combined', value: String(n(fixer[0]?.combined)) },
        { label: 'merged anyway', value: String(n(anyway[0]?.n)) },
      ],
    },
  ];
}
