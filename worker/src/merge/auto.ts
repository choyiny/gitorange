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
import { ensureHeadReview } from '../review/head';
import { ensureStacking } from '../stack/discover';
import {
  cancelStale,
  carryForward,
  NO_MODEL,
  notSuperseded,
  resolutionConfigured,
  SETTLE_MS,
  startResolution,
  type StepRunner,
} from './resolution';
import { generatedConflicts } from './generated';
import { landTargetIs, landTargetOf } from '../lib/land-target';

export type SweepParams = { repositoryId: string; branches: string[] };

/**
 * Checks open PRs into or from moved branches for conflicts, as one durable sweep Workflow (a
 * step per PR) so many PRs aren't cut short by the request's time limit. Never throws.
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
    // ensureResolution on PR view still covers these PRs.
    console.error('[merge] could not start conflict sweep', repo.id, e);
  }
}

const SWEEP_CHUNK = 20;

/** The PRs a sweep checks, as plain data for a durable step. */
async function sweepTargets(db: DrizzleDB, params: SweepParams) {
  // Three ORed terms and parameters per branch; D1 caps both a statement's parameters and its expression depth at 100.
  const byId = new Map<string, PullRequest>();
  for (let i = 0; i < params.branches.length; i += SWEEP_CHUNK) {
    const part = params.branches.slice(i, i + SWEEP_CHUNK);
    for (const pr of await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, params.repositoryId),
          eq(pullRequests.state, 'open'),
          or(
            ...part.map((b) => landTargetIs(b)),
            ...part.map((b) => eq(pullRequests.baseRef, b)),
            ...part.map((b) => eq(pullRequests.headRef, b))
          )
        )
      )
      .all())
      byId.set(pr.id, pr);
  }
  return [...byId.values()].sort((a, b) => a.number - b.number);
}

/**
 * Runs a sweep in two passes of durable steps per pull request: review and stack discovery start
 * at once; then, after a settle delay, conflict resolution, so a burst of landings (whose sweeps
 * all wake to the same tips) ends in one attempt per pull request.
 */
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
  const tips = async (git: GitService, pr: PullRequest) => {
    const [base, head] = await Promise.all([
      git.resolve(landTargetOf(pr)),
      git.resolve(pr.headRef),
    ]);
    return base && head ? { base, head } : null;
  };
  for (const pr of prs) {
    await step.do(`pr:${pr.id}`, async () => {
      try {
        const git = gitFor(env, repo as Repository);
        const shas = await tips(git, pr as PullRequest);
        if (!shas) return false;
        // Each in its own try: one failing never skips the other.
        let ok = true;
        try {
          // New commits on the PR: its agents review them.
          await ensureHeadReview(env, db, pr as PullRequest, shas);
        } catch (e) {
          console.error('[review] sweep: review not started', pr.id, e);
          ok = false;
        }
        try {
          // The target moved (a PR landed) or the head moved: discovery runs again for new pairs.
          await ensureStacking(env, db, git, pr as PullRequest, shas);
        } catch (e) {
          console.error('[stack] sweep: discovery not started', pr.id, e);
          ok = false;
        }
        return ok;
      } catch (e) {
        console.error('[review] sweep failed', pr.id, e);
        return false;
      }
    });
  }
  if (!prs.length) return;
  await step.sleep('settle', SETTLE_MS);
  for (const { id } of prs) {
    await step.do(`resolve:${id}`, async () => {
      try {
        // The PR and its tips as they are after the delay.
        const pr = await db
          .select()
          .from(pullRequests)
          .where(eq(pullRequests.id, id))
          .get();
        if (!pr) return false;
        const git = gitFor(env, repo as Repository);
        const shas = await tips(git, pr);
        if (!shas) return false;
        return await ensureResolution(env, db, git, pr, shas);
      } catch (e) {
        console.error('[merge] auto-resolve failed', id, e);
        return false;
      }
    });
  }
}

/**
 * Cancels the PR's attempts for older commits, then starts an AI resolution if the PR has text
 * conflicts outside generated files and no attempt exists for these exact commits (failed or
 * discarded ones wait for a person; superseded ones don't count). Does nothing when `shas` are
 * already behind the branches. Returns whether it started one.
 */
export async function ensureResolution(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest,
  shas: { base: string; head: string }
): Promise<boolean> {
  if (!resolutionConfigured(env) || pr.state !== 'open') return false;
  // The caller's view of the branches is out of date: a newer check owns this PR.
  if ((await cancelStale(env, db, git, pr, shas)).stale) return false;
  const tried = await db
    .select({ id: mergeResolutions.id })
    .from(mergeResolutions)
    .where(
      and(
        eq(mergeResolutions.pullRequestId, pr.id),
        eq(mergeResolutions.baseSha, shas.base),
        eq(mergeResolutions.headSha, shas.head),
        notSuperseded
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
  if (!resolvable) {
    // Binary or delete/edit conflicts: AI can't resolve them, so record why for the PR's state and inbox.
    if (!plan.upToDate && plan.conflicts.length > 0) {
      const textual = new Set(plan.conflictFiles.map((f) => f.path));
      const other = plan.conflicts.filter((p) => !textual.has(p));
      await db.insert(mergeResolutions).values({
        id: crypto.randomUUID(),
        pullRequestId: pr.id,
        baseSha: shas.base,
        headSha: shas.head,
        status: 'failed',
        model: NO_MODEL,
        conflictedPaths: plan.conflicts,
        errorMessage: `These conflicts can't be resolved automatically (binary files, or a file deleted on one side and changed on the other): ${other.join(', ')}. Resolve them locally.`,
        createdAt: new Date(),
      });
    }
    return false;
  }
  // Lockfiles, migration snapshots, .orangeignore'd output: regenerated by a person or agent.
  if ((await generatedConflicts(git, shas.base, plan.conflicts)).length)
    return false;
  // The target branch moved but not in the conflicted files: reuse the earlier resolution.
  if (await carryForward(env, db, git, pr, shas)) return true;
  const started = await startResolution(env, db, git, pr, shas, null);
  if (!started.ok)
    console.warn('[merge] auto-resolve skipped', pr.id, started.error);
  return started.ok;
}
