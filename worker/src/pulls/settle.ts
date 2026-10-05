import { and, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  mergeResolutions,
  prClassifications,
  pullRequests,
} from '../db/app.schema';
import { publishChange } from '../live/publish';
import { findRepoById, gitFor } from '../lib/repos';
import { reviewConfigured } from '../review/classify';
import { recordStates } from './events';
import { pullStates } from './signals';
import { landTargetIs, landTargetOf } from '../lib/land-target';

/**
 * Recomputes the states of a repository's open PRs (those into `scope.branch` only, when given) and records
 * those that changed (timeline). Called where changes already ping live pages; pings again when it recorded
 * something. Never throws.
 */
export async function settleStates(
  env: CloudflareBindings,
  db: DrizzleDB,
  repositoryId: string,
  scope: { branch?: string } = {}
): Promise<number> {
  try {
    const computedAt = Date.now();
    const found = await findRepoById(db, repositoryId);
    if (!found) return 0;
    const open = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          eq(pullRequests.state, 'open'),
          scope.branch ? landTargetIs(scope.branch) : undefined
        )
      )
      .all();
    if (!open.length) return 0;
    // With one target, pullStates reads the stack tree of that branch only.
    const states = await pullStates(
      db,
      gitFor(env, found.repo),
      repositoryId,
      open,
      { reviewConfigured: reviewConfigured(env) }
    );
    const recorded = await recordStates(db, open, states, computedAt);
    if (recorded) await publishChange(env, repositoryId, { approvals: true });
    return recorded;
  } catch (e) {
    console.error('[states] settle failed', repositoryId, e);
    return 0;
  }
}

type Payload = {
  resolutionId?: string;
  classificationId?: string;
  sweep?: { repositoryId: string };
  stack?: { pullRequestId: string };
  reconcile?: { repositoryId: string; landTarget: string };
};

/**
 * The repository a MERGE_RESOLUTION Workflow payload is about, and the target branch of its pull request (none
 * for a sweep, which may touch several targets).
 */
export async function repositoryForPayload(
  db: DrizzleDB,
  p: Payload
): Promise<{ repositoryId: string; branch?: string } | null> {
  if (p.reconcile)
    return {
      repositoryId: p.reconcile.repositoryId,
      branch: p.reconcile.landTarget,
    };
  if (p.sweep) return { repositoryId: p.sweep.repositoryId };
  let prId = p.stack?.pullRequestId;
  if (!prId && p.classificationId)
    prId = (
      await db
        .select({ id: prClassifications.pullRequestId })
        .from(prClassifications)
        .where(eq(prClassifications.id, p.classificationId))
        .get()
    )?.id;
  if (!prId && p.resolutionId)
    prId = (
      await db
        .select({ id: mergeResolutions.pullRequestId })
        .from(mergeResolutions)
        .where(eq(mergeResolutions.id, p.resolutionId))
        .get()
    )?.id;
  if (!prId) return null;
  const row = await db
    .select({
      repositoryId: pullRequests.repositoryId,
      baseRef: pullRequests.baseRef,
      landTarget: pullRequests.landTarget,
    })
    .from(pullRequests)
    .where(eq(pullRequests.id, prId))
    .get();
  return row
    ? { repositoryId: row.repositoryId, branch: landTargetOf(row) }
    : null;
}

/**
 * The end of a MERGE_RESOLUTION Workflow: settles the states of the PRs it may have moved (the payload PR's
 * target, or the whole repository after a sweep). Never throws, so the Workflow step never retries over it.
 */
export async function settleAfterPayload(
  env: CloudflareBindings,
  db: DrizzleDB,
  p: Payload
): Promise<number> {
  try {
    const at = await repositoryForPayload(db, p);
    if (!at) return 0;
    return await settleStates(env, db, at.repositoryId, { branch: at.branch });
  } catch (e) {
    console.error('[states] settle after workflow failed', e);
    return 0;
  }
}
