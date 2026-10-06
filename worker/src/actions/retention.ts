import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import { agentRuns, instanceSettings, workflowRuns } from '../db/app.schema';
import { getSetting, RETENTION_STATUS_KEY } from '../lib/settings';
import {
  AGENT_RUN_STALE_MS,
  DID_NOT_FINISH,
  closeOpenSteps,
} from '../agent-runs/record';
import { stopStaleReviews } from '../review/head';

/** Runs deleted per batch, and batches per invocation (a backlog clears over several days). */
const BATCH = 100;
const MAX_BATCHES = 50;

export type RetentionStatus = {
  at: string;
  retentionDays: number | null;
  deletedRuns: number;
  /** Agent runs (AI reviews, resolutions, stack discovery, sweeps) deleted. */
  deletedAgentRuns?: number;
  /** Agent runs still marked running long after they started, closed as failed. */
  closedAgentRuns?: number;
  /** Reviews of a commit, and single agents' reviews, left in progress over 2 h (their Workflow died), stopped. */
  stoppedReviews?: number;
  stoppedReviewers?: number;
  /** More finished runs were past the cutoff than one invocation deletes. */
  more: boolean;
};

/** Deletes every R2 object under a prefix (a run's step logs). */
async function deletePrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length)
      await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Agent runs per delete: ids are bound parameters, and D1 allows 100 per statement. */
const AGENT_BATCH = 90;

/**
 * Deletes agent runs that started before the cutoff (their steps cascade). Started, not finished:
 * a run still marked running that long after it began was cut off and will never finish.
 */
export async function pruneAgentRuns(
  db: DrizzleDB,
  cutoff: Date,
  /** Batch size and batches per invocation (tests lower them). */
  limits = { batch: AGENT_BATCH, maxBatches: MAX_BATCHES }
): Promise<{ deleted: number; more: boolean }> {
  let deleted = 0;
  for (let i = 0; i < limits.maxBatches; i++) {
    const batch = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(lt(agentRuns.startedAt, cutoff))
      .orderBy(asc(agentRuns.startedAt))
      .limit(limits.batch)
      .all();
    if (!batch.length) break;
    await db.delete(agentRuns).where(
      inArray(
        agentRuns.id,
        batch.map((r) => r.id)
      )
    );
    deleted += batch.length;
    if (batch.length < limits.batch) break;
    if (i === limits.maxBatches - 1) return { deleted, more: true };
  }
  return { deleted, more: false };
}

/** Closes agent runs left running (and their open steps) as failed. Returns how many. */
export async function closeStaleAgentRuns(
  db: DrizzleDB,
  now = new Date()
): Promise<number> {
  const cutoff = new Date(now.getTime() - AGENT_RUN_STALE_MS);
  let closed = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const batch = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.status, 'running'), lt(agentRuns.startedAt, cutoff))
      )
      .limit(AGENT_BATCH)
      .all();
    if (!batch.length) break;
    const ids = batch.map((r) => r.id);
    await db
      .update(agentRuns)
      .set({ status: 'failed', error: DID_NOT_FINISH, finishedAt: now })
      .where(and(inArray(agentRuns.id, ids), eq(agentRuns.status, 'running')));
    await closeOpenSteps(db, ids, 'failed', now);
    closed += ids.length;
    if (batch.length < AGENT_BATCH) break;
  }
  return closed;
}

/**
 * Deletes Actions runs that finished more than `actions.retention_days` ago (Site admin, default
 * 90): their step logs in R2, then the runs, whose jobs and steps cascade. Runs that are queued or
 * still running are never touched. Called daily by the Cron Trigger; records what it did.
 */
export async function runActionsRetention(
  env: CloudflareBindings,
  db: DrizzleDB,
  now = new Date()
): Promise<RetentionStatus> {
  const days = await getSetting(db, env, 'actions.retention_days');
  let deleted = 0;
  let deletedAgent = 0;
  let more = false;
  if (days !== null) {
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    for (let i = 0; i < MAX_BATCHES; i++) {
      const batch = await db
        .select({
          id: workflowRuns.id,
          repositoryId: workflowRuns.repositoryId,
        })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.status, 'completed'),
            isNotNull(workflowRuns.completedAt),
            lt(workflowRuns.completedAt, cutoff)
          )
        )
        .orderBy(asc(workflowRuns.completedAt))
        .limit(BATCH)
        .all();
      if (!batch.length) break;
      // Logs first: if the row deletion fails, the next run finds the rows again.
      for (const r of batch)
        await deletePrefix(
          env.ACTIONS_LOGS,
          `actions/${r.repositoryId}/${r.id}/`
        );
      await db.delete(workflowRuns).where(
        inArray(
          workflowRuns.id,
          batch.map((r) => r.id)
        )
      );
      deleted += batch.length;
      if (batch.length < BATCH) break;
      if (i === MAX_BATCHES - 1) more = true;
    }
    const pruned = await pruneAgentRuns(db, cutoff);
    deletedAgent = pruned.deleted;
    if (pruned.more) more = true;
  }
  const closedAgent = await closeStaleAgentRuns(db, now);
  const stopped = await stopStaleReviews(env, db, now).catch((e: unknown) => {
    console.error('[review] could not stop stale reviews', e);
    return { reviews: 0, reviewers: 0 };
  });
  const status: RetentionStatus = {
    at: now.toISOString(),
    retentionDays: days,
    deletedRuns: deleted,
    deletedAgentRuns: deletedAgent,
    closedAgentRuns: closedAgent,
    stoppedReviews: stopped.reviews,
    stoppedReviewers: stopped.reviewers,
    more,
  };
  await db
    .insert(instanceSettings)
    .values({ key: RETENTION_STATUS_KEY, value: status, updatedAt: now })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: status, updatedAt: now, updatedById: null },
    });
  if (deletedAgent)
    console.log(
      `[actions] retention deleted ${deletedAgent} agent runs older than ${days} days`
    );
  if (deleted)
    console.log(
      `[actions] retention deleted ${deleted} runs older than ${days} days`
    );
  return status;
}
