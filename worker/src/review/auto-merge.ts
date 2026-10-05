import { and, eq, isNull } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  prReviewFlags,
  pullRequests,
  workflowJobs,
  workflowRuns,
  type PrClassification,
  type PullRequest,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { GitService } from '../git/service';
import { findRepoById, gitFor } from '../lib/repos';
import { deleteMergedBranch, landPull } from '../merge/land';
import { latestResolution } from '../merge/resolution';
import { classificationFor } from './classify';
import { parsePolicy, readPolicy, type ReviewPolicy } from './policy';

/**
 * - off: the target branch has no `.gitorange/review.yml`.
 * - disabled: turned off for this pull request.
 * - waiting: review, approvals, checks, or conflict resolution in progress.
 * - blocked: failed checks or review, or conflicts.
 * - ready: merges now.
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

/**
 * Where the head commit's review stands; `review_required` counts unapproved flags.
 * A future "changes requested" state belongs here too.
 */
export type ReviewProgress =
  | { state: 'reviewing' }
  | { state: 'failed'; error: string | null }
  | { state: 'review_required'; flags: number }
  | { state: 'approved' };

export function reviewProgress(
  review:
    Pick<PrClassification, 'status' | 'verdict' | 'errorMessage'> | undefined,
  unapprovedFlags: number
): ReviewProgress {
  if (!review) return { state: 'reviewing' };
  if (review.status === 'failed')
    return { state: 'failed', error: review.errorMessage };
  if (review.status !== 'done') return { state: 'reviewing' };
  if (review.verdict === 'human' && unapprovedFlags > 0)
    return { state: 'review_required', flags: unapprovedFlags };
  return { state: 'approved' };
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
  const openFlags =
    review?.status === 'done' && review.verdict === 'human'
      ? await db
          .select({
            id: prReviewFlags.id,
            changesRequestedAt: prReviewFlags.changesRequestedAt,
          })
          .from(prReviewFlags)
          .where(
            and(
              eq(prReviewFlags.classificationId, review.id),
              isNull(prReviewFlags.approvedAt)
            )
          )
          .all()
      : [];
  const progress = reviewProgress(
    review,
    review?.status === 'done' && review.verdict === 'human'
      ? openFlags.length
      : 0
  );
  if (progress.state === 'reviewing') waiting.push('Reviewing the changes');
  else if (progress.state === 'failed') {
    if (policy) blocked.push(`Review failed: ${progress.error ?? ''}`.trim());
  } else if (progress.state === 'review_required') {
    const changes = openFlags.filter((f) => f.changesRequestedAt).length;
    const open = openFlags.length - changes;
    if (changes)
      waiting.push(`Changes requested on ${plural(changes, 'flag')}`);
    if (open)
      waiting.push(
        `${plural(open, 'flag')} need${open === 1 ? 's' : ''} approval`
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
  // Merged branches don't pile up; stacked or since-pushed ones are kept.
  if (result.ok)
    followUps.push(
      deleteMergedBranch({
        env,
        db,
        repo: found.repo,
        git,
        pr,
        headSha: result.headSha,
      })
    );
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
