import { and, eq, isNull } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  prReviewFlags,
  pullRequests,
  workflowJobs,
  workflowRuns,
  type PullRequest,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { GitService } from '../git/service';
import { findRepoById, gitFor } from '../lib/repos';
import { landPull } from '../merge/land';
import { latestResolution } from '../merge/resolution';
import { classificationFor } from './classify';
import { parsePolicy, readPolicy, type ReviewPolicy } from './policy';

/**
 * Where a pull request stands on auto-merge.
 * - off: the target branch has no `.gitorange/review.yml`.
 * - disabled: a maintainer turned it off for this pull request.
 * - waiting: something is still in progress (review, approvals, checks, conflict resolution).
 * - blocked: it can't merge on its own as things stand (failed checks or review, conflicts).
 * - ready: it merges now.
 */
export type AutoMergeStatus =
  | { state: 'off' }
  | { state: 'disabled'; at: Date }
  | { state: 'waiting' | 'blocked' | 'ready'; reasons: string[] };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Whether the required Actions checks for a commit passed: null when they have. */
async function checkProblem(
  db: DrizzleDB,
  repositoryId: string,
  sha: string,
  require: ReviewPolicy['checks']['require']
): Promise<{ kind: 'waiting' | 'blocked'; reason: string } | null> {
  if (require === 'none') return null;
  const runs = await db
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.repositoryId, repositoryId),
        eq(workflowRuns.headSha, sha)
      )
    )
    .all();
  if (require === 'all') {
    if (!runs.length)
      return {
        kind: 'waiting',
        reason: 'No checks have run for this commit yet',
      };
    if (
      runs.some((r) => r.status === 'completed' && r.conclusion !== 'success')
    )
      return { kind: 'blocked', reason: 'Checks failed' };
    if (runs.some((r) => r.status !== 'completed'))
      return { kind: 'waiting', reason: 'Checks are running' };
    return null;
  }
  const jobs = runs.length
    ? await db
        .select({
          key: workflowJobs.jobKey,
          name: workflowJobs.name,
          status: workflowJobs.status,
          conclusion: workflowJobs.conclusion,
        })
        .from(workflowJobs)
        .innerJoin(workflowRuns, eq(workflowRuns.id, workflowJobs.runId))
        .where(
          and(
            eq(workflowRuns.repositoryId, repositoryId),
            eq(workflowRuns.headSha, sha)
          )
        )
        .all()
    : [];
  for (const wanted of require) {
    const matching = jobs.filter((j) => j.key === wanted || j.name === wanted);
    if (!matching.length)
      return { kind: 'waiting', reason: `Waiting for the "${wanted}" check` };
    if (
      matching.some(
        (j) => j.status === 'completed' && j.conclusion !== 'success'
      )
    )
      return { kind: 'blocked', reason: `The "${wanted}" check failed` };
    if (matching.some((j) => j.status !== 'completed'))
      return { kind: 'waiting', reason: `The "${wanted}" check is running` };
  }
  return null;
}

export async function autoMergeStatus(
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest
): Promise<AutoMergeStatus> {
  if (pr.state !== 'open') return { state: 'off' };
  const [base, head] = await Promise.all([
    git.resolve(pr.baseRef),
    git.resolve(pr.headRef),
  ]);
  if (!base || !head) return { state: 'off' };
  const policyFile = await readPolicy(git, base);
  if (!policyFile) return { state: 'off' };
  if (pr.autoMergeDisabledAt)
    return { state: 'disabled', at: pr.autoMergeDisabledAt };

  const waiting: string[] = [];
  const blocked: string[] = [];

  let policy: ReviewPolicy | null = null;
  try {
    policy = parsePolicy(policyFile.text);
  } catch (e) {
    blocked.push(e instanceof Error ? e.message : String(e));
  }

  const review = await classificationFor(db, pr.id, head, policyFile.sha);
  if (!review) waiting.push('Reviewing the changes');
  else if (review.status === 'failed') {
    if (policy)
      blocked.push(`Review failed: ${review.errorMessage ?? ''}`.trim());
  } else if (review.status !== 'done') waiting.push('Reviewing the changes');
  else if (review.verdict === 'human') {
    const open = await db
      .select({ id: prReviewFlags.id })
      .from(prReviewFlags)
      .where(
        and(
          eq(prReviewFlags.classificationId, review.id),
          isNull(prReviewFlags.approvedAt)
        )
      )
      .all();
    if (open.length)
      waiting.push(
        `${plural(open.length, 'flag')} need${open.length === 1 ? 's' : ''} approval`
      );
  }

  if (policy) {
    const checks = await checkProblem(
      db,
      pr.repositoryId,
      head,
      policy.checks.require
    );
    if (checks)
      (checks.kind === 'blocked' ? blocked : waiting).push(checks.reason);
  }

  const plan = await git.planMerge(base, head);
  if (plan.upToDate) blocked.push('Nothing to merge');
  else if (plan.conflicts.length) {
    const r = await latestResolution(db, pr.id);
    const current = r && r.baseSha === base && r.headSha === head;
    if (current && r.status === 'proposed') {
      // Resolved by AI: merging lands the resolution.
    } else if (current && (r.status === 'running' || r.status === 'queued'))
      waiting.push('Resolving conflicts with AI');
    else blocked.push('Merge conflicts need a person');
  }

  if (blocked.length) return { state: 'blocked', reasons: blocked };
  if (waiting.length) return { state: 'waiting', reasons: waiting };
  return { state: 'ready', reasons: [] };
}

/**
 * Merges a pull request on its own if it is ready. Called whenever something it waits on
 * finishes: its review, a flag approval, an Actions run, an AI conflict resolution. Failures are
 * logged; a lost race (the base moved, or someone merged first) simply leaves it for next time.
 */
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
  const status = await autoMergeStatus(db, git, pr);
  if (status.state !== 'ready') return false;
  const author = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, pr.authorId))
    .get();
  const followUps: Promise<unknown>[] = [];
  const result = await landPull({
    env,
    db,
    repo: found.repo,
    repoFullName: `${found.namespace.username}/${found.repo.name}`,
    git,
    pr,
    by: null,
    author: author ?? { name: 'GitOrange', email: 'noreply@gitorange' },
    after: (p) => void followUps.push(p),
  });
  await Promise.allSettled(followUps);
  if (!result.ok)
    console.warn('[review] auto-merge did not land', pr.id, result.error);
  return result.ok;
}

/** After an Actions run finishes: tries to auto-merge open pull requests at that commit. */
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
