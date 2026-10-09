import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  mergeResolutions,
  repositories,
  workflowRuns,
  type PullRequest,
} from '../db/app.schema';
import type { GitService } from '../git/service';
import { NOTHING_TO_MERGE, rebaseRow, SUPERSEDED } from '../merge/resolution';
import { checkVerdict, type CheckRun } from '../review/checks';
import { reviewInputs, reviewVerdict, type GateInput } from '../review/gate';
import { chunks, stackTreeView, type StackTreeView } from '../stack/view';
import {
  decideState,
  stackReasons,
  type PullState,
  type Reason,
} from './state';
import { contains } from '../stack/contains';
import { landTargetOf } from '../lib/land-target';

export type PullStateOptions = {
  /** Branch tips (`refs/heads/...`), when the caller already has them. */
  refs?: Map<string, string>;
  /** The stack tree covering the PRs' targets; by default read for their one target, or the whole repository. */
  tree?: StackTreeView;
  /**
   * Whether AI review and stacking can run here (`reviewConfigured(env)`; default true). When they can't, no
   * agent review or stack check ever runs, so neither is waited on.
   */
  reviewConfigured?: boolean;
  /** The review gate's inputs at the PRs' heads, when the caller already read them (`reviewInputs`). */
  reviews?: Map<string, GateInput>;
  /** Whether merging is paused on the repository, when the caller already knows; read from D1 otherwise. */
  mergingPaused?: boolean;
};

/**
 * The computed state of each open PR among `prs` (keyed by id), in a fixed number of queries: one ref listing,
 * the review gate's inputs, the stack view, and chunked D1 reads. PRs missing a branch are left out.
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

  // The caller's gate inputs, and read here for any PR they don't cover (never silently no review reasons).
  const reviews = new Map(opts.reviews);
  const unread = tips.filter((t) => !reviews.has(t.pr.id));
  if (unread.length)
    for (const [id, gate] of await reviewInputs(
      db,
      repositoryId,
      unread.map((t) => ({ pullRequestId: t.pr.id, head: t.head })),
      aiReview
    ))
      reviews.set(id, gate);
  const ids = tips.map((t) => t.pr.id);
  const heads = [...new Set(tips.map((t) => t.head))];
  const paused =
    opts.mergingPaused ??
    !!(
      await db
        .select({ at: repositories.mergingPausedAt })
        .from(repositories)
        .where(eq(repositories.id, repositoryId))
        .get()
    )?.at;

  // Actions runs at the heads.
  const runs: (CheckRun & { headSha: string })[] = [];
  for (const part of chunks(heads, 90))
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
        .where(
          and(
            eq(workflowRuns.repositoryId, repositoryId),
            inArray(workflowRuns.headSha, part)
          )
        )
        .all())
    );

  // The latest AI resolution of each PR (only that row is read).
  const resolutions = new Map<
    string,
    {
      status: string;
      baseSha: string;
      headSha: string;
      commitSha: string | null;
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
        commitSha: mergeResolutions.commitSha,
        errorMessage: mergeResolutions.errorMessage,
        conflictedPaths: mergeResolutions.conflictedPaths,
      })
      .from(mergeResolutions)
      .where(
        and(
          inArray(mergeResolutions.pullRequestId, part),
          // A squash-era row (rebaseRow) is never a rebase outcome.
          sql`${mergeResolutions}.rowid = (SELECT m.rowid FROM merge_resolutions m WHERE m.pull_request_id = ${mergeResolutions.pullRequestId} AND ${rebaseRow('m')} ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1)`
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

    const v = checkVerdict(
      runs.filter((r) => r.headSha === head),
      [],
      'any'
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

    const gate = reviews.get(pr.id);
    if (gate) reasons.push(...reviewVerdict(gate).reasons);

    // The latest rebase conflict row, at the tips the PR rebases between now (base_ref's, else the land target's).
    const r = resolutions.get(pr.id);
    const onto = (await tipOf(pr.baseRef)) ?? base;
    if (r && r.baseSha === onto && r.headSha === head) {
      // A per-commit resolution (a squash-era row, commit_sha NULL, is never resumed).
      if ((r.status === 'running' || r.status === 'resolved') && r.commitSha)
        reasons.push({ kind: 'resolution_running' });
      else if (
        r.status === 'failed' &&
        r.errorMessage !== SUPERSEDED &&
        // Nothing to merge isn't a conflict: there is nothing to rebase.
        r.errorMessage !== NOTHING_TO_MERGE
      )
        reasons.push({
          kind: 'rebase_conflict',
          commit: r.commitSha,
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
    // Nothing lands while merging is paused (landPull refuses), whatever else holds it.
    if (paused) reasons.push({ kind: 'merging_paused' });

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
