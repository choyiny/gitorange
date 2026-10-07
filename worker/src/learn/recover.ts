import { and, eq, inArray, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';
import { agentLessons, agents } from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import { startNextLesson } from './lessons';

/** A lesson still learning this long after its run claimed it was cut off: its Workflow died. */
export const LEARN_STALE_MS = 2 * 3600_000;
/** Runs a lesson gets: the first, and one more from the sweep. */
export const LEARN_MAX_ATTEMPTS = 2;
export const LEARN_STOPPED = 'The lesson stopped unexpectedly.';

export type LessonRecovery = {
  /** Unfinished lessons of deleted agents (or agents without a repository), deleted. */
  dropped: number;
  /** Lessons put back to pending: stuck learning, or failed retryably on their first attempt. */
  requeued: number;
  /** Learn Workflows started: each idle agent's oldest pending lesson. */
  started: number;
};

/**
 * The daily sweep (with Actions retention): drops lessons of deleted agents, requeues lessons stuck learning past
 * LEARN_STALE_MS (failed for good after LEARN_MAX_ATTEMPTS), retries a retryable failure once, and starts the oldest
 * pending lesson of every agent with none learning (a Workflow that was never started or died). Clearing run_id
 * fences out whatever the old run might still write.
 */
export async function recoverLessons(
  env: CloudflareBindings,
  db: DrizzleDB,
  now = new Date()
): Promise<LessonRecovery> {
  const cutoff = new Date(now.getTime() - LEARN_STALE_MS);
  const gone = db
    .select({ id: agents.userId })
    .from(agents)
    .where(or(isNotNull(agents.deletedAt), isNull(agents.repositoryId)));
  const dropped = await db
    .delete(agentLessons)
    .where(
      and(
        ne(agentLessons.status, 'committed'),
        inArray(agentLessons.agentId, gone)
      )
    )
    .returning({ id: agentLessons.id });
  const stale = and(
    eq(agentLessons.status, 'learning'),
    lt(agentLessons.startedAt, cutoff)
  );
  const requeued = await db
    .update(agentLessons)
    .set({ status: 'pending', runId: null, error: LEARN_STOPPED })
    .where(and(stale, lt(agentLessons.attempts, LEARN_MAX_ATTEMPTS)))
    .returning({ id: agentLessons.id });
  await db
    .update(agentLessons)
    .set({
      status: 'failed',
      runId: null,
      error: LEARN_STOPPED,
      retryable: false,
      finishedAt: now,
    })
    .where(stale);
  const retried = await db
    .update(agentLessons)
    .set({ status: 'pending', runId: null, retryable: false })
    .where(
      and(
        eq(agentLessons.status, 'failed'),
        eq(agentLessons.retryable, true),
        lt(agentLessons.attempts, LEARN_MAX_ATTEMPTS)
      )
    )
    .returning({ id: agentLessons.id });
  const idle = await db
    .selectDistinct({ agentId: agentLessons.agentId })
    .from(agentLessons)
    .where(eq(agentLessons.status, 'pending'))
    .all();
  let started = 0;
  for (const { agentId } of idle)
    if (await startNextLesson(env, db, agentId)) started += 1;
  return {
    dropped: dropped.length,
    requeued: requeued.length + retried.length,
    started,
  };
}
