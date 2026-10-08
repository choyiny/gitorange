import { and, eq, or } from 'drizzle-orm';
import { pingingSteps } from '../live/publish';
import {
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
import { resolutionConfigured, SETTLE_MS, type StepRunner } from './resolution';
import { ensureRebase } from './rebase';
import { landTargetIs, landTargetOf } from '../lib/land-target';

export type SweepParams = { repositoryId: string; branches: string[] };

/**
 * Starts one sweep Workflow over the open pull requests into or from moved branches (a step per PR, so many PRs
 * aren't cut short by the request's time limit). Never throws.
 */
export async function startSweep(
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
    // The PR page's ensureRebase still covers these PRs.
    console.error('[merge] could not start sweep', repo.id, e);
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
 * at once; then, after a settle delay, rebases, so a burst of landings (whose sweeps all wake to
 * the same tips) ends in one rebase per pull request.
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
    await step.do(`rebase:${id}`, async () => {
      try {
        // The PR and its tips as they are after the delay.
        const pr = await db
          .select()
          .from(pullRequests)
          .where(eq(pullRequests.id, id))
          .get();
        if (!pr) return false;
        return await ensureRebase(env, db, gitFor(env, repo as Repository), pr);
      } catch (e) {
        console.error('[rebase] sweep failed', id, e);
        return false;
      }
    });
  }
}
