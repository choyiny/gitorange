import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import { pullRequests, type Repository } from '../db/app.schema';
import { NO_MODEL } from '../merge/resolution';
import { flagTitleOf } from '../review/gate';
import { branchTips } from '../review/inbox';

export const INSIGHT_PERIODS = [7, 30, 90, 365] as const;

/**
 * How pull requests fared in one repository over the last `days` days: how many were opened and
 * merged, how many GitOrange merged on its own, how often the auto-merge review needed a person,
 * AI conflict resolution, and CI on pull requests. Events count in the period they happened in
 * (merged → merged_at, a flag → when it was raised); "now" fields are a snapshot.
 *
 * Every number is an aggregate computed in D1 (medians with window functions), so the cost does
 * not grow with the rows a repository has in JavaScript.
 */
export type RepoInsights = {
  days: number;
  since: string;
  until: string;
  pulls: {
    opened: number;
    merged: number;
    /** Landed by auto-merge (no merging person). */
    autoMerged: number;
    mergedByPerson: number;
    /** autoMerged / merged, or null when nothing merged. */
    autoMergeShare: number | null;
    /** Merged pull requests whose review raised at least one flag for a person. */
    mergedAfterHumanReview: number;
    /** Auto-merged with no flag ever raised: no person was involved after opening it. */
    mergedHandsOff: number;
    closedUnmerged: number;
    openNow: number;
  };
  /** Median seconds from opened to merged. */
  timeToMerge: {
    all: number | null;
    auto: number | null;
    person: number | null;
  };
  reviews: {
    /** Reviews of pull request commits started. */
    runs: number;
    completed: number;
    failed: number;
    /** Reviews that cleared the change for auto-merge with nothing to ask. */
    autoVerdicts: number;
    /** Reviews that raised flags for a person. */
    humanVerdicts: number;
    pullsReviewed: number;
    /** Pull requests with at least one review that needed a person. */
    pullsNeedingHuman: number;
  };
  flags: {
    raised: number;
    approved: number;
    /** Median seconds from a flag being raised to a person approving it. */
    medianTimeToApproval: number | null;
    /** Findings for a person still waiting on one (the Approvals rule), right now. */
    pendingNow: number;
    pendingPullsNow: number;
    /** By agent, or by retired review.yml question or limit. */
    byKind: {
      source: 'question' | 'limit' | 'agent';
      key: string;
      title: string;
      raised: number;
      approved: number;
    }[];
  };
  resolutions: {
    attempts: number;
    /** Proposed or applied. */
    succeeded: number;
    applied: number;
    failed: number;
    rejected: number;
    inProgress: number;
    pulls: number;
  };
  ci: {
    /** Actions runs triggered by pull requests. */
    runs: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    /** succeeded / (succeeded + failed), or null without finished runs. */
    passRate: number | null;
    /** Median seconds from a pull request being opened to its first successful run. */
    medianTimeToGreen: number | null;
  };
};

const n = (v: unknown) => Number(v ?? 0);
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

type Row = Record<string, number | null>;

export async function repoInsights(
  env: CloudflareBindings,
  db: DrizzleDB,
  repo: Repository,
  days: number,
  now = new Date()
): Promise<RepoInsights> {
  const until = Math.floor(now.getTime() / 1000);
  const since = until - days * 86400;
  const repoId = repo.id;
  // Open pull requests' head reviews: the review of each one's branch tip (refs read once), as on Approvals.
  const open = await db
    .select()
    .from(pullRequests)
    .where(
      and(eq(pullRequests.repositoryId, repoId), eq(pullRequests.state, 'open'))
    )
    .all();
  const { heads, unreadable } = await branchTips(
    env,
    new Map([[repoId, repo]]),
    open
  );
  const headReviews = JSON.stringify(
    open.filter((p) => heads.has(p.id)).map((p) => `${p.id}-${heads.get(p.id)}`)
  );
  // Refs unreadable: each open pull request's newest head review stands in, as on Approvals.
  const newestFallback = unreadable.size ? 1 : 0;

  const [
    pullsRows,
    reviewRows,
    flagRows,
    pendingRows,
    resRows,
    ciRows,
    medRows,
  ] = await Promise.all([
    db.all<Row>(sql`
        SELECT
          SUM(p.created_at >= ${since}) AS opened,
          SUM(p.state = 'merged' AND p.merged_at >= ${since}) AS merged,
          SUM(p.state = 'merged' AND p.merged_at >= ${since} AND p.merged_automatically = 1) AS auto_merged,
          SUM(p.state = 'merged' AND p.merged_at >= ${since} AND EXISTS (
            SELECT 1 FROM pr_review_flags f
            JOIN pr_classifications c ON c.id = f.classification_id
            WHERE c.pull_request_id = p.id)) AS merged_after_human,
          SUM(p.state = 'merged' AND p.merged_at >= ${since} AND p.merged_automatically = 1 AND NOT EXISTS (
            SELECT 1 FROM pr_review_flags f
            JOIN pr_classifications c ON c.id = f.classification_id
            WHERE c.pull_request_id = p.id)) AS merged_hands_off,
          SUM(p.state = 'closed' AND p.closed_at >= ${since}) AS closed_unmerged,
          SUM(p.state = 'open') AS open_now
        FROM pull_requests p
        WHERE p.repository_id = ${repoId}`),
    db.all<Row>(sql`
        SELECT
          COUNT(*) AS runs,
          SUM(c.status = 'done') AS completed,
          SUM(c.status = 'failed') AS failed,
          SUM(c.status = 'done' AND NOT EXISTS (SELECT 1 FROM pr_review_flags f WHERE f.classification_id = c.id)) AS auto_verdicts,
          SUM(c.status = 'done' AND EXISTS (SELECT 1 FROM pr_review_flags f WHERE f.classification_id = c.id)) AS human_verdicts,
          COUNT(DISTINCT c.pull_request_id) AS pulls_reviewed,
          COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM pr_review_flags f WHERE f.classification_id = c.id) THEN c.pull_request_id END) AS pulls_needing_human
        FROM pr_classifications c
        JOIN pull_requests p ON p.id = c.pull_request_id
        WHERE p.repository_id = ${repoId} AND c.created_at >= ${since}`),
    db.all<{
      source: 'question' | 'limit' | 'agent';
      key: string;
      raised: number;
      approved: number;
    }>(sql`
        SELECT f.source AS source, COALESCE(u.username, f.key) AS key, COUNT(*) AS raised,
          SUM(f.approved_at IS NOT NULL) AS approved
        FROM pr_review_flags f
        JOIN pr_classifications c ON c.id = f.classification_id
        JOIN pull_requests p ON p.id = c.pull_request_id
        LEFT JOIN users u ON f.source = 'agent' AND u.id = f.agent_id
        WHERE p.repository_id = ${repoId} AND f.created_at >= ${since}
        GROUP BY f.source, COALESCE(u.username, f.key)
        ORDER BY raised DESC, f.source, key`),
    // Same rule as the Approvals inbox: findings for a person on the review of an open pull request's branch tip,
    // from an agent that is still invited and has them outstanding (flagged or changes requested).
    db.all<Row>(sql`
        SELECT COUNT(*) AS flags, COUNT(DISTINCT p.id) AS pulls
        FROM pr_review_flags f
        JOIN pr_classifications c ON c.id = f.classification_id
        JOIN pull_requests p ON p.id = c.pull_request_id
        JOIN pr_reviewers rv ON rv.pull_request_id = p.id AND rv.head_sha = c.head_sha
          AND rv.agent_id = f.agent_id AND rv.requested = 1
          AND rv.status IN ('flagged', 'changes_requested')
        WHERE p.repository_id = ${repoId} AND p.state = 'open' AND f.approved_at IS NULL
          AND f.source = 'agent' AND f.kind = 'needs_person'
          AND EXISTS (SELECT 1 FROM repository_agents ra
                      WHERE ra.repository_id = p.repository_id AND ra.agent_id = f.agent_id)
          AND (c.id IN (SELECT value FROM json_each(${headReviews}))
               OR (${newestFallback} = 1
                   AND c.id = (SELECT c2.id FROM pr_classifications c2
                               WHERE c2.pull_request_id = p.id AND c2.id = p.id || '-' || c2.head_sha
                               ORDER BY c2.created_at DESC LIMIT 1)))`),
    db.all<Row>(sql`
        SELECT
          COUNT(*) AS attempts,
          SUM(r.status IN ('proposed', 'applied')) AS succeeded,
          SUM(r.status = 'applied') AS applied,
          SUM(r.status = 'failed') AS failed,
          SUM(r.status = 'rejected') AS rejected,
          SUM(r.status IN ('queued', 'running')) AS in_progress,
          COUNT(DISTINCT r.pull_request_id) AS pulls
        FROM merge_resolutions r
        JOIN pull_requests p ON p.id = r.pull_request_id
        WHERE p.repository_id = ${repoId} AND r.created_at >= ${since}
          AND r.model <> ${NO_MODEL}`),
    db.all<Row>(sql`
        SELECT
          COUNT(*) AS runs,
          SUM(w.conclusion = 'success') AS succeeded,
          SUM(w.conclusion = 'failure') AS failed,
          SUM(w.conclusion = 'cancelled') AS cancelled
        FROM workflow_runs w
        WHERE w.repository_id = ${repoId} AND w.event = 'pull_request' AND w.created_at >= ${since}`),
    // Every median in one pass: (metric, value) pairs, ranked per metric.
    db.all<{ metric: string; median: number }>(sql`
        WITH v(metric, x) AS (
          SELECT CASE WHEN p.merged_automatically = 1 THEN 'merge_auto' ELSE 'merge_person' END,
            p.merged_at - p.created_at
          FROM pull_requests p
          WHERE p.repository_id = ${repoId} AND p.state = 'merged' AND p.merged_at >= ${since}
          UNION ALL
          SELECT 'merge_all', p.merged_at - p.created_at
          FROM pull_requests p
          WHERE p.repository_id = ${repoId} AND p.state = 'merged' AND p.merged_at >= ${since}
          UNION ALL
          SELECT 'approval', f.approved_at - f.created_at
          FROM pr_review_flags f
          JOIN pr_classifications c ON c.id = f.classification_id
          JOIN pull_requests p ON p.id = c.pull_request_id
          WHERE p.repository_id = ${repoId} AND f.created_at >= ${since} AND f.approved_at IS NOT NULL
          UNION ALL
          SELECT 'green', MIN(w.completed_at) - p.created_at
          FROM pull_requests p
          JOIN workflow_runs w ON w.repository_id = p.repository_id
            AND w.event = 'pull_request' AND w.conclusion = 'success'
            AND w.ref = 'refs/pull/' || p.number || '/head'
          WHERE p.repository_id = ${repoId} AND p.created_at >= ${since}
          GROUP BY p.id
        ),
        ranked AS (
          SELECT metric, x,
            ROW_NUMBER() OVER (PARTITION BY metric ORDER BY x) AS rn,
            COUNT(*) OVER (PARTITION BY metric) AS cnt
          FROM v WHERE x IS NOT NULL
        )
        SELECT metric, AVG(x) AS median FROM ranked
        WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
        GROUP BY metric`),
  ]);

  const p = pullsRows[0] ?? {};
  const r = reviewRows[0] ?? {};
  const pending = pendingRows[0] ?? {};
  const res = resRows[0] ?? {};
  const ci = ciRows[0] ?? {};
  const median = new Map(
    medRows.map((m) => [m.metric, Math.round(Number(m.median))])
  );
  const med = (k: string) => median.get(k) ?? null;

  const merged = n(p.merged);
  const autoMerged = n(p.auto_merged);
  const ciOk = n(ci.succeeded);
  const ciFailed = n(ci.failed);
  return {
    days,
    since: new Date(since * 1000).toISOString(),
    until: new Date(until * 1000).toISOString(),
    pulls: {
      opened: n(p.opened),
      merged,
      autoMerged,
      mergedByPerson: merged - autoMerged,
      autoMergeShare: ratio(autoMerged, merged),
      mergedAfterHumanReview: n(p.merged_after_human),
      mergedHandsOff: n(p.merged_hands_off),
      closedUnmerged: n(p.closed_unmerged),
      openNow: n(p.open_now),
    },
    timeToMerge: {
      all: med('merge_all'),
      auto: med('merge_auto'),
      person: med('merge_person'),
    },
    reviews: {
      runs: n(r.runs),
      completed: n(r.completed),
      failed: n(r.failed),
      autoVerdicts: n(r.auto_verdicts),
      humanVerdicts: n(r.human_verdicts),
      pullsReviewed: n(r.pulls_reviewed),
      pullsNeedingHuman: n(r.pulls_needing_human),
    },
    flags: {
      raised: flagRows.reduce((s, f) => s + n(f.raised), 0),
      approved: flagRows.reduce((s, f) => s + n(f.approved), 0),
      medianTimeToApproval: med('approval'),
      pendingNow: n(pending.flags),
      pendingPullsNow: n(pending.pulls),
      byKind: flagRows.map((f) => ({
        source: f.source,
        key: f.key,
        title:
          f.source === 'agent'
            ? `@${f.key}`
            : flagTitleOf({ source: f.source, key: f.key, value: null }),
        raised: n(f.raised),
        approved: n(f.approved),
      })),
    },
    resolutions: {
      attempts: n(res.attempts),
      succeeded: n(res.succeeded),
      applied: n(res.applied),
      failed: n(res.failed),
      rejected: n(res.rejected),
      inProgress: n(res.in_progress),
      pulls: n(res.pulls),
    },
    ci: {
      runs: n(ci.runs),
      succeeded: ciOk,
      failed: ciFailed,
      cancelled: n(ci.cancelled),
      passRate: ratio(ciOk, ciOk + ciFailed),
      medianTimeToGreen: med('green'),
    },
  };
}
