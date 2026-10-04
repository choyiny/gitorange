import { and, eq, or } from 'drizzle-orm';
import { pingingSteps } from '../live/publish';
import {
  mergeResolutions,
  pullRequests,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import type { GitService } from '../git/service';
import type { DrizzleDB } from '../db/middleware';
import type { RefUpdate } from '../actions/trigger';
import { findRepoById, gitFor } from '../lib/repos';
import { ensureClassification } from '../review/classify';
import {
  carryForward,
  resolutionConfigured,
  startResolution,
  type StepRunner,
} from './resolution';

export type SweepParams = { repositoryId: string; branches: string[] };

/**
 * After branches move (a push, or a merge into the target branch), checks every open pull
 * request they could have put into conflict: PRs into a moved branch (their base advanced) and
 * PRs from one (new commits on the PR). The check runs as one durable sweep Workflow, a step per
 * PR, so a repository with many open PRs isn't cut short by a request's background time limit.
 * Never fails the push or merge that called it.
 */
export async function autoResolveConflicts(
  env: CloudflareBindings,
  repo: Repository,
  updates: RefUpdate[]
): Promise<void> {
  if (!resolutionConfigured(env)) return;
  const branches = updates
    .filter((u) => u.ref.startsWith('refs/heads/'))
    .map((u) => u.ref.slice('refs/heads/'.length));
  if (!branches.length) return;
  try {
    await env.MERGE_RESOLUTION.create({
      id: `sweep-${crypto.randomUUID()}`,
      params: { sweep: { repositoryId: repo.id, branches } },
    });
  } catch (e) {
    // The PR page's backstop (ensureResolution on view) still covers these PRs.
    console.error('[merge] could not start conflict sweep', repo.id, e);
  }
}

/** The PRs a sweep checks, as plain data for a durable step. */
async function sweepTargets(db: DrizzleDB, params: SweepParams) {
  return db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, params.repositoryId),
        eq(pullRequests.state, 'open'),
        or(
          ...params.branches.map((b) => eq(pullRequests.baseRef, b)),
          ...params.branches.map((b) => eq(pullRequests.headRef, b))
        )
      )
    )
    .all();
}

/** Runs a sweep: one durable step per pull request. */
export async function executeSweep(
  deps: { env: CloudflareBindings; db: DrizzleDB; step: StepRunner },
  params: SweepParams
) {
  const { env, db } = deps;
  const step = pingingSteps(env, deps.step, params.repositoryId, {
    approvals: true,
  });
  const repo = await step.do('repo', async () => {
    const found = await findRepoById(db, params.repositoryId);
    return found?.repo ?? null;
  });
  if (!repo) return;
  const prs = await step.do('targets', () => sweepTargets(db, params));
  for (const pr of prs) {
    await step.do(`pr:${pr.id}`, async () => {
      try {
        const git = gitFor(env, repo as Repository);
        const [base, head] = await Promise.all([
          git.resolve(pr.baseRef),
          git.resolve(pr.headRef),
        ]);
        if (!base || !head) return false;
        // New commits on the PR, or a new review.yml on its target: review for auto-merge.
        await ensureClassification(env, db, git, pr as PullRequest, {
          base,
          head,
        });
        return await ensureResolution(env, db, git, pr as PullRequest, {
          base,
          head,
        });
      } catch (e) {
        console.error('[merge] auto-resolve failed', pr.id, e);
        return false;
      }
    });
  }
}

/**
 * Starts an AI resolution for a pull request's current commits if it has text conflicts and
 * none was attempted for exactly these commits yet. Any earlier attempt for them counts: a
 * running or proposed one is in hand, and a failed or discarded one waits for a person (or
 * for a branch to move). Returns whether it started one.
 */
export async function ensureResolution(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest,
  shas: { base: string; head: string }
): Promise<boolean> {
  if (!resolutionConfigured(env) || pr.state !== 'open') return false;
  const tried = await db
    .select({ id: mergeResolutions.id })
    .from(mergeResolutions)
    .where(
      and(
        eq(mergeResolutions.pullRequestId, pr.id),
        eq(mergeResolutions.baseSha, shas.base),
        eq(mergeResolutions.headSha, shas.head)
      )
    )
    .get();
  if (tried) return false;
  const plan = await git.planMerge(shas.base, shas.head, {
    collectConflictFiles: true,
  });
  const resolvable =
    !plan.upToDate &&
    plan.conflicts.length > 0 &&
    plan.conflictFiles.length === plan.conflicts.length;
  if (!resolvable) return false;
  // The target branch moved but not in the conflicted files: reuse the earlier resolution.
  if (await carryForward(env, db, git, pr, shas)) return true;
  const started = await startResolution(env, db, git, pr, shas, null);
  if (!started.ok)
    console.warn('[merge] auto-resolve skipped', pr.id, started.error);
  return started.ok;
}
