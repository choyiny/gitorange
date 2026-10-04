import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import { instanceSettings, workflowRuns } from '../db/app.schema';
import { getSetting, RETENTION_STATUS_KEY } from '../lib/settings';

/** Runs deleted per batch, and batches per invocation (a backlog clears over several days). */
const BATCH = 100;
const MAX_BATCHES = 50;

export type RetentionStatus = {
  at: string;
  retentionDays: number | null;
  deletedRuns: number;
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
  }
  const status: RetentionStatus = {
    at: now.toISOString(),
    retentionDays: days,
    deletedRuns: deleted,
    more,
  };
  await db
    .insert(instanceSettings)
    .values({ key: RETENTION_STATUS_KEY, value: status, updatedAt: now })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: status, updatedAt: now, updatedById: null },
    });
  if (deleted)
    console.log(
      `[actions] retention deleted ${deleted} runs older than ${days} days`
    );
  return status;
}
