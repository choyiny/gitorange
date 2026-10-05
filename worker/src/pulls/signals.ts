import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  mergeResolutions,
  prClassifications,
  prReviewFlags,
  workflowJobs,
  workflowRuns,
  type PullRequest,
} from '../db/app.schema';
import type { GitService } from '../git/service';
import { SUPERSEDED } from '../merge/resolution';
import { checkVerdict, type CheckJob, type CheckRun } from '../review/checks';
import {
  parsePolicy,
  POLICY_PATH,
  readPolicy,
  type ReviewPolicy,
} from '../review/policy';
import { chunks, stackTreeView, type StackTreeView } from '../stack/view';
import {
  decideState,
  stackReasons,
  type PullState,
  type Reason,
} from './state';
import { contains } from '../stack/contains';
import { landTargetOf } from '../lib/land-target';

type TargetPolicy = {
  sha: string;
  policy: ReviewPolicy | null;
  error: string | null;
} | null;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** review.yml at a commit: null when absent, `error` when it doesn't parse. */
async function policyAt(git: GitService, sha: string): Promise<TargetPolicy> {
  const file = await readPolicy(git, sha).catch(() => null);
  if (!file) return null;
  try {
    return { sha: file.sha, policy: parsePolicy(file.text), error: null };
  } catch (e) {
    return { sha: file.sha, policy: null, error: message(e) };
  }
}

export type PullStateOptions = {
  /** Branch tips (`refs/heads/...`), when the caller already has them. */
  refs?: Map<string, string>;
  /** The stack tree covering the PRs' targets; by default read for their one target, or the whole repository. */
  tree?: StackTreeView;
  /**
   * Whether AI review and stacking can run here (`reviewConfigured(env)`; default true). When they can't, a
   * review.yml on the target never produces a review or a stack check, so neither is waited on.
   */
  reviewConfigured?: boolean;
};

/**
 * The computed state of each open PR among `prs` (keyed by id), in a fixed number of queries: one ref listing,
 * one review.yml read per target tip, the stack view, and chunked D1 reads. PRs missing a branch are left out.
 */
export async function pullStates(
  db: DrizzleDB,
  git: GitService,
  repositoryId: string,
  prs: PullRequest[],
  opts: PullStateOptions = {}
): Promise<Map<string, PullState>> {
  const aiReview = opts.reviewConfigured ?? true;
  const out = new Map<string, PullState>();
  if (!prs.some((p) => p.state === 'open')) return out;
  const refs = opts.refs ?? (await git.refs());
  const tips = prs.flatMap((pr) => {
    if (pr.state !== 'open') return [];
    const base = refs.get(`refs/heads/${landTargetOf(pr)}`);
    const head = refs.get(`refs/heads/${pr.headRef}`);
    return base && head ? [{ pr, base, head }] : [];
  });
  if (!tips.length) return out;

  const policies = new Map<string, TargetPolicy>();
  for (const base of new Set(tips.map((t) => t.base)))
    policies.set(base, await policyAt(git, base));
  const ids = tips.map((t) => t.pr.id);
  const heads = [...new Set(tips.map((t) => t.head))];

  // Reviews at the current heads (no file lists: whether one changes review.yml is answered in SQL).
  const reviews = (
    await Promise.all(
      chunks(tips, 45).map((part) =>
        db
          .select({
            id: prClassifications.id,
            pullRequestId: prClassifications.pullRequestId,
            headSha: prClassifications.headSha,
            policySha: prClassifications.policySha,
            status: prClassifications.status,
            verdict: prClassifications.verdict,
            errorMessage: prClassifications.errorMessage,
            changesPolicy: sql<number>`EXISTS (SELECT 1 FROM json_each(COALESCE(${prClassifications.files}, '[]')) WHERE json_extract(value, '$.path') = ${POLICY_PATH} AND json_extract(value, '$.status') <> 'removed')`,
          })
          .from(prClassifications)
          .where(
            and(
              inArray(
                prClassifications.pullRequestId,
                part.map((t) => t.pr.id)
              ),
              inArray(prClassifications.headSha, [
                ...new Set(part.map((t) => t.head)),
              ])
            )
          )
          .all()
      )
    )
  ).flat();
  const reviewAt = new Map(
    reviews.map((r) => [`${r.pullRequestId} ${r.headSha} ${r.policySha}`, r])
  );
  const current = tips.flatMap(({ pr, base, head }) => {
    const pol = policies.get(base);
    const r = pol ? reviewAt.get(`${pr.id} ${head} ${pol.sha}`) : undefined;
    return r ? [r] : [];
  });

  // Unapproved flags of the current reviews: how many, and how many with changes requested.
  const flags = new Map<string, { open: number; changes: number }>();
  const human = current
    .filter((r) => r.status === 'done' && r.verdict === 'human')
    .map((r) => r.id);
  for (const part of chunks(human, 90))
    for (const f of await db
      .select({
        classificationId: prReviewFlags.classificationId,
        open: sql<number>`COUNT(*)`,
        changes: sql<number>`SUM(CASE WHEN ${prReviewFlags.changesRequestedAt} IS NOT NULL THEN 1 ELSE 0 END)`,
      })
      .from(prReviewFlags)
      .where(
        and(
          inArray(prReviewFlags.classificationId, part),
          isNull(prReviewFlags.approvedAt)
        )
      )
      .groupBy(prReviewFlags.classificationId)
      .all())
      flags.set(f.classificationId, {
        open: Number(f.open),
        changes: Number(f.changes ?? 0),
      });

  // Actions runs (and, when review.yml names checks, their jobs) at the heads.
  const runs: (CheckRun & { headSha: string })[] = [];
  const jobs: (CheckJob & { headSha: string })[] = [];
  const wantJobs = [...policies.values()].some((p) =>
    Array.isArray(p?.policy?.checks.require)
  );
  for (const part of chunks(heads, 90)) {
    const at = and(
      eq(workflowRuns.repositoryId, repositoryId),
      inArray(workflowRuns.headSha, part)
    );
    runs.push(
      ...(await db
        .select({
          runNumber: workflowRuns.runNumber,
          status: workflowRuns.status,
          conclusion: workflowRuns.conclusion,
          workflowPath: workflowRuns.workflowPath,
          event: workflowRuns.event,
          headSha: workflowRuns.headSha,
        })
        .from(workflowRuns)
        .where(at)
        .all())
    );
    if (wantJobs)
      jobs.push(
        ...(await db
          .select({
            key: workflowJobs.jobKey,
            name: workflowJobs.name,
            status: workflowJobs.status,
            conclusion: workflowJobs.conclusion,
            runNumber: workflowRuns.runNumber,
            headSha: workflowRuns.headSha,
          })
          .from(workflowJobs)
          .innerJoin(workflowRuns, eq(workflowRuns.id, workflowJobs.runId))
          .where(at)
          .all())
      );
  }

  // The latest AI resolution of each PR (only that row is read).
  const resolutions = new Map<
    string,
    {
      status: string;
      baseSha: string;
      headSha: string;
      errorMessage: string | null;
      conflictedPaths: string[];
    }
  >();
  for (const part of chunks(ids, 90))
    for (const r of await db
      .select({
        pullRequestId: mergeResolutions.pullRequestId,
        status: mergeResolutions.status,
        baseSha: mergeResolutions.baseSha,
        headSha: mergeResolutions.headSha,
        errorMessage: mergeResolutions.errorMessage,
        conflictedPaths: mergeResolutions.conflictedPaths,
      })
      .from(mergeResolutions)
      .where(
        and(
          inArray(mergeResolutions.pullRequestId, part),
          sql`${mergeResolutions}.rowid = (SELECT m.rowid FROM merge_resolutions m WHERE m.pull_request_id = ${mergeResolutions.pullRequestId} ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1)`
        )
      )
      .all())
      resolutions.set(r.pullRequestId, r);

  const targets = [...new Set(tips.map((t) => landTargetOf(t.pr)))];
  // A tree that can't be read: every PR waits on stack checking instead of failing the whole read.
  let treeFailed = false;
  const tree =
    opts.tree ??
    (await stackTreeView(db, git, repositoryId, {
      authors: false,
      branch: targets.length === 1 ? targets[0] : undefined,
    }).catch((e): StackTreeView => {
      console.error('[states] stack tree failed', repositoryId, e);
      treeFailed = true;
      return { targets: [] };
    }));

  // Which stacked PRs still need to rebase onto their open parent: parents before children, and a PR is asked
  // only once its parent's own chain is in order.
  const needsRebase = new Map<number, boolean>();
  const branchOf = new Map<number, string>();
  // Callers may pass only the PR's own branch tips: a parent's head is then read from the full listing, once.
  let allRefs: Map<string, string> | undefined;
  const tipOf = async (branch: string) =>
    refs.get(`refs/heads/${branch}`) ??
    (allRefs ??= await git.refs()).get(`refs/heads/${branch}`);
  for (const t of tree.targets) {
    for (const n of t.nodes) branchOf.set(n.number, n.headRef);
    const byNumber = new Map(t.nodes.map((n) => [n.number, n]));
    const visit = async (n: (typeof t.nodes)[number]): Promise<boolean> => {
      if (needsRebase.has(n.number)) return needsRebase.get(n.number)!;
      needsRebase.set(n.number, false); // cycle guard
      const parent = n.parent ? byNumber.get(n.parent.number) : undefined;
      let needs = false;
      if (parent) {
        const parentHead = await tipOf(parent.headRef);
        const head = await tipOf(n.headRef);
        needs =
          !!parentHead &&
          !!head &&
          !(await visit(parent)) &&
          (await contains(git, parentHead, head)) === false; // unknown: no ask
      }
      needsRebase.set(n.number, needs);
      return needs;
    };
    for (const n of t.nodes) await visit(n);
  }

  for (const { pr, base, head } of tips) {
    const reasons: Reason[] = [];
    const pol = policies.get(base) ?? null;

    const v = checkVerdict(
      runs.filter((r) => r.headSha === head),
      jobs.filter((j) => j.headSha === head),
      pol?.policy ? pol.policy.checks.require : 'any'
    );
    if (v?.kind === 'failed')
      reasons.push({
        kind: 'check_failed',
        run_number: v.runNumber,
        check: v.check,
      });
    else if (v)
      reasons.push({
        kind: 'checks_running',
        check: v.check,
        started: v.started,
      });

    if (pol?.error)
      reasons.push({
        kind: 'review_policy_invalid',
        where: 'target',
        error: pol.error,
      });
    else if (pol) {
      const review = reviewAt.get(`${pr.id} ${head} ${pol.sha}`);
      if (!review || (review.status !== 'done' && review.status !== 'failed')) {
        if (aiReview) reasons.push({ kind: 'review_running' });
      } else if (review.status === 'failed')
        reasons.push({ kind: 'review_failed', error: review.errorMessage });
      else if (review.verdict === 'human') {
        const f = flags.get(review.id);
        if (f?.changes)
          reasons.push({ kind: 'changes_requested', flags: f.changes });
        if (f && f.open - f.changes > 0)
          reasons.push({ kind: 'flags_pending', count: f.open - f.changes });
      }
      // The PR's own review.yml takes effect once it lands: an invalid one is the author's to fix.
      if (review && Number(review.changesPolicy)) {
        const own = await policyAt(git, head);
        if (own?.error)
          reasons.push({
            kind: 'review_policy_invalid',
            where: 'pull_request',
            error: own.error,
          });
      }
    }

    const r = resolutions.get(pr.id);
    if (r && r.baseSha === base && r.headSha === head) {
      if (r.status === 'queued' || r.status === 'running')
        reasons.push({ kind: 'resolution_running' });
      else if (
        r.status === 'rejected' ||
        (r.status === 'failed' && r.errorMessage !== SUPERSEDED)
      )
        reasons.push({
          kind: 'conflicts_unresolved',
          files: r.conflictedPaths,
          error: r.errorMessage,
        });
    }

    const node = tree.targets
      .find((t) => t.branch === landTargetOf(pr))
      ?.nodes.find((n) => n.number === pr.number);
    // Whatever is configured: landPull refuses while the tree can't be read, so the PR is never Ready.
    if (treeFailed) reasons.push({ kind: 'stack_checking', prs: [] });
    if (node)
      reasons.push(
        ...stackReasons(node, {
          branchOf: (n) => branchOf.get(n) ?? null,
          needsRebase: needsRebase.get(node.number) ?? false,
        }).filter((x) => aiReview || x.kind !== 'stack_checking')
      );

    out.set(pr.id, decideState(reasons));
  }
  return out;
}

/**
 * One PR's state; null unless it is open with both branches. `shas` (its land target's tip and head, from `landShas`)
 * saves listing the refs; the stack tree is read for its target only.
 */
export async function pullStateFor(
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest,
  opts: {
    shas?: { base: string; head: string } | null;
    reviewConfigured?: boolean;
    /** The PR's target tree, when the caller already read it. */
    tree?: StackTreeView;
  } = {}
): Promise<PullState | null> {
  if (pr.state !== 'open') return null;
  const refs =
    opts.shas === undefined
      ? undefined
      : new Map(
          opts.shas
            ? [
                [`refs/heads/${landTargetOf(pr)}`, opts.shas.base],
                [`refs/heads/${pr.headRef}`, opts.shas.head],
              ]
            : []
        );
  return (
    (
      await pullStates(db, git, pr.repositoryId, [pr], {
        refs,
        reviewConfigured: opts.reviewConfigured,
        tree: opts.tree,
      })
    ).get(pr.id) ?? null
  );
}
