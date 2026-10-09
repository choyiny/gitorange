import { and, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  pullRequests,
  type PrClassification,
  type PullRequest,
} from '../db/app.schema';
import type { GitService } from '../git/service';
import { findRepoById, gitFor } from '../lib/repos';
import { landPull, mergingPause } from '../merge/land';
import { resolutionConfigured } from '../merge/resolution';
import { rebaseTips, rebaseView } from '../merge/rebase';
import { landTargetOf } from '../lib/land-target';
import { stackGate } from '../stack/gate';
import { checksAt, reviewGateFor, reviewReasonText } from './gate';
import { hasInvitedAgents } from './keys';

/**
 * - off: no agent is invited to the repository (a person approves and merges), or the PR isn't open.
 * - disabled: turned off for this pull request.
 * - waiting: merging is paused on the repository; review, approvals, checks, AI resolving a rebase conflict, or stack
 *   discovery in progress.
 * - blocked: failed checks or a failed review, a rebase conflict, or nothing to merge.
 * - ready: merges now.
 */
export type AutoMergeStatus =
  | { state: 'off' }
  | { state: 'disabled'; at: Date }
  | { state: 'waiting' | 'blocked' | 'ready'; reasons: string[] };

export async function autoMergeStatus(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest
): Promise<AutoMergeStatus> {
  if (pr.state !== 'open') return { state: 'off' };
  if (!(await hasInvitedAgents(db, pr.repositoryId))) return { state: 'off' };
  const [base, head] = await Promise.all([
    git.resolve(landTargetOf(pr)),
    git.resolve(pr.headRef),
  ]);
  if (!base || !head) return { state: 'off' };
  if (pr.autoMergeDisabledAt)
    return { state: 'disabled', at: pr.autoMergeDisabledAt };

  const waiting: string[] = [];
  const blocked: string[] = [];
  // Landing refuses until someone resumes merging (landPull).
  if (await mergingPause(db, pr.repositoryId))
    waiting.push('Merging is paused');

  const review = await reviewGateFor(db, resolutionConfigured(env), pr, head);
  for (const r of review.reasons)
    (r.kind === 'agent_review_failed' ? blocked : waiting).push(
      reviewReasonText(r)
    );

  const checks = await checksAt(db, pr.repositoryId, head);
  if (checks)
    (checks.kind === 'failed' ? blocked : waiting).push(checks.reason);

  const tips = await rebaseTips(git, pr);
  if (tips) {
    // Behind is fine: landing rebases it first.
    const v = await rebaseView(env, db, git, pr, tips);
    if (v.status === 'nothing_to_merge') blocked.push('Nothing to merge');
    else if (v.status === 'resolving')
      waiting.push('Resolving a rebase conflict with AI');
    else if (v.status === 'conflict')
      blocked.push(v.error ?? 'Rebase conflict');
  }

  const gate = await stackGate(db, git, pr);
  if (gate.error)
    waiting.push('Couldn’t check how it relates to other open pull requests');
  for (const b of gate.blocks)
    (b.kind === 'must_account_for' ? blocked : waiting).push(b.message);
  // Discovery runs once the review ends; landing before it has checked this head would skip it.
  if (gate.checking)
    waiting.push('Checking how it relates to other open pull requests');

  if (blocked.length) return { state: 'blocked', reasons: blocked };
  if (waiting.length) return { state: 'waiting', reasons: waiting };
  return { state: 'ready', reasons: [] };
}

/** Merges a pull request if ready. Failures are logged; a lost race waits for the next trigger. */
export async function maybeAutoMerge(
  env: CloudflareBindings,
  db: DrizzleDB,
  pullRequestId: string
): Promise<boolean> {
  const pr = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.id, pullRequestId))
    .get();
  if (!pr || pr.state !== 'open') return false;
  const found = await findRepoById(db, pr.repositoryId);
  if (!found) return false;
  const git = gitFor(env, found.repo);
  const status = await autoMergeStatus(env, db, git, pr);
  if (status.state !== 'ready') return false;
  const followUps: Promise<unknown>[] = [];
  const result = await landPull({
    env,
    db,
    repo: found.repo,
    repoFullName: `${found.namespace.username}/${found.repo.name}`,
    git,
    pr,
    by: null,
    after: (p) => void followUps.push(p),
  });
  await Promise.allSettled(followUps);
  if (!result.ok)
    console.warn('[review] auto-merge did not land', pr.id, result.error);
  return result.ok;
}

/** Tries to auto-merge open pull requests at a commit whose Actions run finished. */
export async function autoMergeForCommit(
  env: CloudflareBindings,
  db: DrizzleDB,
  repositoryId: string,
  sha: string
) {
  const found = await findRepoById(db, repositoryId);
  if (!found) return;
  const git = gitFor(env, found.repo);
  const refs = await git.refs();
  const prs = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repositoryId),
        eq(pullRequests.state, 'open')
      )
    )
    .all();
  for (const pr of prs)
    if (refs.get(`refs/heads/${pr.headRef}`) === sha)
      await maybeAutoMerge(env, db, pr.id).catch((e) =>
        console.error('[review] auto-merge failed', pr.id, e)
      );
}

/** Tries to auto-merge every open pull request of a repository, after a change that may unblock several. */
export async function autoMergeRepository(
  env: CloudflareBindings,
  db: DrizzleDB,
  repositoryId: string
) {
  const prs = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repositoryId),
        eq(pullRequests.state, 'open')
      )
    )
    .all();
  for (const { id } of prs)
    await maybeAutoMerge(env, db, id).catch((e) =>
      console.error('[review] auto-merge failed', id, e)
    );
}
