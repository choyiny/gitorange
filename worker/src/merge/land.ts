import { and, eq, ne, or } from 'drizzle-orm';
import { settleStates } from '../pulls/settle';
import { queueLessons } from '../learn/lessons';
import { publishChange } from '../live/publish';
import type { DrizzleDB } from '../db/middleware';
import {
  pullRequests,
  repositories,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import { REBASE_COMMITTER } from '../git/rebase';
import { GitPushError, ZERO_SHA } from '../git/remote';
import type { GitService } from '../git/service';
import { onRefsUpdated } from '../actions/trigger';
import { recordAudit } from '../lib/audit';
import { startSweep } from './auto';
import { resolutionConfigured } from './resolution';
import {
  afterRebase,
  ensureRebase,
  queueRebasedActions,
  rebaseAt,
  rebaseBlocked,
  stopMessage,
  writeRebase,
  written,
  type RebaseTips,
} from './rebase';
import { checksAt, reviewGateFor, reviewReasonText } from '../review/gate';
import { landTargetIs, landTargetOf } from '../lib/land-target';
import { stackGate } from '../stack/gate';
import { onPullClosed } from '../stack/retarget';
import { refreshAgentConfig } from '../agents/refresh';

export const pullRef = (n: number) => `refs/pull/${n}/head`;

type Refusal = {
  ok: false;
  status: 400 | 409;
  error: string;
  /** Which gate refused it (absent for other failures). */
  reason?: 'stack' | 'checks' | 'review' | 'rebase';
  /** Landing rebased the branch and pushed it to this head, then stopped (its checks or review, or the target moved). */
  rebased?: string;
  /** The head that rebase replaced (with `rebased`): what an agent's local commits sit on. */
  rebasedFrom?: string;
};
export type LandResult = { ok: true; sha: string; headSha: string } | Refusal;

type LandOpts = {
  env: CloudflareBindings;
  db: DrizzleDB;
  repo: Repository;
  repoFullName: string;
  git: GitService;
  pr: PullRequest;
  /** Who merged it; null for auto-merge. */
  by: { id: string; name: string; email: string } | null;
  /** The head commit the person saw: refused (409) when the branch has moved since. */
  expectedHead?: string;
  /** Runs follow-up work (Actions, sweeps) after the merge. */
  after: (work: Promise<unknown>) => void;
  /**
   * Delete the head branch once it has landed (auto-merge), after its stacked children have been sent back to
   * the land target, so a branch a child was stacked on isn't kept for that child.
   */
  deleteBranch?: boolean;
};

/**
 * Lands a pull request by moving its land target to its head with compare-and-swap (a fast-forward): the target keeps
 * every commit with its author, message and SHA, and no commit is made. When the target moved since the branch was
 * last rebased, rebases it first and pushes the rebased branch; it then lands in the same call only when the new head
 * needs no checks and its review carried over, else it stops ("rebased — waiting for checks") and auto-merge lands it
 * once they pass.
 */
export async function landPull(opts: LandOpts): Promise<LandResult> {
  const { env, db, git, pr } = opts;
  if (pr.state !== 'open')
    return { ok: false, status: 400, error: 'Pull request is not open' };
  const target = landTargetOf(pr);
  const headSha = await git.resolve(pr.headRef);
  if (!headSha)
    return {
      ok: false,
      status: 400,
      error: 'The head branch no longer exists',
    };
  if (opts.expectedHead && opts.expectedHead !== headSha)
    return {
      ok: false,
      status: 409,
      error:
        'The pull request has new commits since you looked. Review them, then merge again.',
    };
  const gate = await stackGate(db, git, pr);
  if (gate.error)
    return {
      ok: false,
      status: 409,
      reason: 'stack',
      error:
        'Couldn’t check how it relates to other open pull requests (the stack tree). Try again.',
    };
  if (gate.blocks.length)
    return {
      ok: false,
      status: 409,
      reason: 'stack',
      error: `${gate.blocks.map((b) => b.message.replace(/[.\s]+$/, '')).join('. ')}. A maintainer can dismiss a dependency on the pull request page.`,
    };
  // Checks, then review, for the commit that lands; a person's approval of it satisfies review.
  const checks = await checksAt(db, pr.repositoryId, headSha);
  if (checks)
    return {
      ok: false,
      status: 409,
      reason: 'checks',
      error:
        checks.kind === 'failed'
          ? `${checks.reason} (run #${checks.runNumber}). Fix them, then merge.`
          : `${checks.reason}. Merge once they pass.`,
    };
  const review = await reviewGateFor(
    db,
    resolutionConfigured(env),
    pr,
    headSha
  );
  if (!review.satisfied)
    return {
      ok: false,
      status: 409,
      reason: 'review',
      error: `Review isn't satisfied: ${review.reasons.map(reviewReasonText).join('; ')}. Approve the pull request or its flags (an agent's change request needs a new commit or a Dismiss first).`,
    };
  const refsBefore = await git.refs();
  const baseBefore = refsBefore.get(`refs/heads/${target}`);
  if (!baseBefore)
    return {
      ok: false,
      status: 400,
      error: 'The target branch no longer exists',
    };
  const mb = await git.mergeBase(baseBefore, headSha);
  if (mb === headSha)
    return { ok: false, status: 400, error: 'Nothing to merge' };
  let landHead = headSha;
  // Set when landing rebased the branch below: a refusal after that still says so.
  let rewrote: { rebased: string; rebasedFrom: string } | undefined;
  if (mb !== baseBefore) {
    const rebased = await rebaseForLanding(opts, {
      onto: baseBefore,
      ontoBranch: target,
      head: headSha,
    });
    if (!rebased.ok) return rebased;
    landHead = rebased.head;
    if (landHead !== headSha)
      rewrote = { rebased: landHead, rebasedFrom: headSha };
  }
  try {
    await git.client.push(
      [
        { ref: `refs/heads/${target}`, old: baseBefore, new: landHead },
        {
          ref: pullRef(pr.number),
          old: refsBefore.get(pullRef(pr.number)) ?? ZERO_SHA,
          new: landHead,
        },
      ],
      []
    );
  } catch (e) {
    if (e instanceof GitPushError)
      return {
        ok: false,
        status: 409,
        error: 'Base branch was modified. Review and try the merge again.',
        // The branch was rebased (and pushed) before the target moved again: the agent's clone is stale either way.
        ...rewrote,
      };
    return {
      ok: false,
      status: 400,
      error: e instanceof Error ? e.message : 'Merge failed',
    };
  }
  // The push is the commit point; record only after it succeeds.
  const landedCommits = await firstParentSteps(git, baseBefore, landHead);
  const now = new Date();
  await db
    .update(pullRequests)
    .set({
      state: 'merged',
      mergeCommitSha: landHead,
      landedCommits,
      mergedById: opts.by?.id ?? null,
      mergedAutomatically: !opts.by,
      mergedAt: now,
      closedAt: now,
      updatedAt: now,
    })
    .where(eq(pullRequests.id, pr.id));
  await db
    .update(repositories)
    .set({ updatedAt: now })
    .where(eq(repositories.id, pr.repositoryId));
  await recordAudit(db, {
    repositoryId: pr.repositoryId,
    // GitOrange itself when it lands one on its own (auto-merge).
    actorId: opts.by?.id ?? null,
    action: 'pull.merged',
    target: `#${pr.number}`,
    pull: pr.number,
    data: { title: pr.title, sha: landHead, into: target, automatic: !opts.by },
  });
  // Auto-merges happen in the background.
  opts.after(publishChange(env, pr.repositoryId, { approvals: true }));
  opts.after(settleStates(env, db, pr.repositoryId));
  // The agents whose change requests on it were dismissed learn from them (worker/src/learn/).
  opts.after(queueLessons(env, db, pr));
  // Children stacked on its branch go back to the land target; a reconcile restacks them. Only then is the
  // branch free to delete.
  opts.after(
    onPullClosed(env, db, pr, 'landed').then(() =>
      opts.deleteBranch
        ? deleteMergedBranch({
            env,
            db,
            repo: opts.repo,
            git,
            pr,
            headSha: landHead,
          })
        : false
    )
  );
  const updates = [
    { ref: `refs/heads/${target}`, old: baseBefore, new: landHead },
  ];
  // Pull requests into the target are now behind: the sweep rebases them.
  opts.after(startSweep(env, opts.repo, updates));
  opts.after(
    onRefsUpdated(
      env,
      db,
      opts.repo,
      opts.repoFullName,
      updates,
      opts.by?.id ?? pr.authorId
    )
  );
  if (target === opts.repo.defaultBranch)
    opts.after(refreshAgentConfig(env, db, opts.repo.id));
  return { ok: true, sha: landHead, headSha };
}

/**
 * How many first-parent steps lead from `head` back into `base`'s history: the landed commits `pullShas` reads back
 * with `log(head, n)`. Counts a merged-in side branch as one step (its merge commit), as a first-parent log shows it.
 */
async function firstParentSteps(
  git: GitService,
  base: string,
  head: string
): Promise<number> {
  const own = new Set(
    (await git.commitsBetween(base, head)).map((c) => c.hash)
  );
  const chain = await git.log(head, own.size || 1);
  let n = 0;
  while (n < chain.length && own.has(chain[n].hash)) n++;
  return n;
}

/**
 * The target moved since the branch was last rebased: rebase it now and push the rebased branch (as a rebase run
 * would: Actions, the sweep, review carry-over). Ready to land only if the new head needs no checks and its review
 * holds; a conflict leaves the pull request to a rebase run.
 */
async function rebaseForLanding(
  opts: LandOpts,
  tips: RebaseTips
): Promise<{ ok: true; head: string } | Refusal> {
  const { env, db, git, pr } = opts;
  // Never rewrite the default branch, a protected branch, or a head another open pull request into a different base
  // shares.
  const blocked = await rebaseBlocked(db, pr);
  if (blocked)
    return {
      ok: false,
      status: 409,
      reason: 'rebase',
      error: `${tips.ontoBranch} has moved on, so it must be rebased before it lands. ${blocked}`,
    };
  const result = await rebaseAt(git, db, pr, tips, {
    ...REBASE_COMMITTER,
    timestamp: Math.floor(Date.now() / 1000),
  });
  if (result.kind === 'up_to_date') return { ok: true, head: tips.head };
  // The target already has every change: rewriting the branch to its tip would land nothing.
  if (result.kind === 'done' && !result.commits.length)
    return { ok: false, status: 400, error: 'Nothing to merge' };
  if (result.kind !== 'done') {
    opts.after(ensureRebase(env, db, git, pr));
    return {
      ok: false,
      status: 409,
      reason: 'rebase',
      error:
        result.kind === 'too_many'
          ? stopMessage.tooMany(result.count)
          : `Rebasing onto ${tips.ontoBranch} stops at commit ${result.commit.hash.slice(0, 7)}, which conflicts in ${result.conflicts.join(', ')}. ${
              resolutionConfigured(env)
                ? 'GitOrange is resolving it; merge again once it has.'
                : 'Rebase it locally and push.'
            }`,
    };
  }
  if ((await writeRebase(git, pr, tips, result)) === 'moved')
    return {
      ok: false,
      status: 409,
      error:
        'The pull request has new commits since you looked. Review them, then merge again.',
    };
  const w = written(tips, result);
  const done = { repo: opts.repo, repoFullName: opts.repoFullName, pr, w };
  // Actions on the new head before anything that can fail: the checks gate below must see its runs.
  await queueRebasedActions(env, db, done);
  try {
    await afterRebase(env, db, done);
  } catch (e) {
    // The branch is rebased and its runs are queued: the gates below still hold.
    console.error('[merge] after-rebase work failed', pr.id, e);
  }
  const rebased = `Rebased onto ${tips.ontoBranch} as ${w.to.slice(0, 7)}`;
  const checks = await checksAt(db, pr.repositoryId, w.to);
  if (checks)
    return {
      ok: false,
      status: 409,
      reason: 'checks',
      rebased: w.to,
      rebasedFrom: w.from,
      error: `${rebased} — waiting for checks (${checks.reason}). It lands once they pass: on its own with auto-merge, else merge again.`,
    };
  const review = await reviewGateFor(db, resolutionConfigured(env), pr, w.to);
  if (!review.satisfied)
    return {
      ok: false,
      status: 409,
      reason: 'review',
      rebased: w.to,
      rebasedFrom: w.from,
      error: `${rebased}; review isn't satisfied for the new head: ${review.reasons.map(reviewReasonText).join('; ')}.`,
    };
  return { ok: true, head: w.to };
}

/**
 * After auto-merge lands a pull request, deletes its head branch with compare-and-swap on the
 * landed head. Keeps it when someone pushed since, when it's the default branch, or when
 * another open pull request uses it as base, head or land target (a stack builds on it). Never throws.
 */
export async function deleteMergedBranch(opts: {
  env: CloudflareBindings;
  db: DrizzleDB;
  repo: Repository;
  git: GitService;
  pr: Pick<PullRequest, 'id' | 'repositoryId' | 'headRef'>;
  /** The head commit that landed. */
  headSha: string;
}): Promise<boolean> {
  const { env, db, repo, git, pr } = opts;
  const branch = pr.headRef;
  try {
    if (branch === repo.defaultBranch) return false;
    const inUse = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, pr.repositoryId),
          eq(pullRequests.state, 'open'),
          ne(pullRequests.id, pr.id),
          or(
            eq(pullRequests.baseRef, branch),
            eq(pullRequests.headRef, branch),
            landTargetIs(branch)
          )
        )
      )
      .get();
    if (inUse) return false;
    // From the remote: landing may have just pushed a rebased head, which a cached listing wouldn't show.
    const { refs } = await git.client.listRefs();
    if (refs.get(`refs/heads/${branch}`) !== opts.headSha) return false;
    // A deletion starts no Actions run and leaves no PR to sweep, so a live ping is all it needs.
    await git.deleteBranch(branch, opts.headSha);
  } catch (e) {
    console.warn('[merge] could not delete merged branch', pr.id, branch, e);
    return false;
  }
  await recordAudit(db, {
    repositoryId: pr.repositoryId,
    actorId: null,
    action: 'branch.deleted',
    target: branch,
    data: { sha: opts.headSha, merged: true },
  });
  await publishChange(env, pr.repositoryId);
  return true;
}
