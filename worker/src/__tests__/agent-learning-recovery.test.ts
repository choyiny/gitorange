import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { runActionsRetention } from '../actions/retention';
import {
  LEARN_STALE_MS,
  LEARN_STOPPED,
  recoverLessons,
} from '../learn/recover';
import { call } from './helpers/app';
import {
  closedLesson,
  fakeLearner,
  learnRuns,
  lessons,
  runLessons,
} from './helpers/lessons';

type T = Awaited<ReturnType<typeof closedLesson>>['t'];

const set = (t: T, id: string, sql: string, ...binds: unknown[]) =>
  t.env.DB.prepare(`UPDATE agent_lessons SET ${sql} WHERE id = ?`)
    .bind(...binds, id)
    .run();

const longAgo = () => Math.floor((Date.now() - LEARN_STALE_MS - 60_000) / 1000);

describe('lesson recovery (daily)', () => {
  it('requeues a lesson stuck learning past the stale window and starts it; fails it after its last attempt', async () => {
    const { t } = await closedLesson();
    const db = drizzle(t.env.DB, { schema });
    const [l] = await lessons(t);
    await set(
      t,
      l.id,
      `status = 'learning', run_id = 'dead', attempts = 1, started_at = ?`,
      longAgo()
    );
    const runs = learnRuns(t).length;
    expect(await recoverLessons(t.env, db)).toEqual({
      dropped: 0,
      requeued: 1,
      started: 1,
    });
    expect((await lessons(t))[0]).toMatchObject({
      status: 'pending',
      run_id: null,
      error: LEARN_STOPPED,
    });
    expect(learnRuns(t)).toHaveLength(runs + 1);

    await set(
      t,
      l.id,
      `status = 'learning', run_id = 'dead-too', attempts = 2, started_at = ?`,
      longAgo()
    );
    expect(await recoverLessons(t.env, db)).toEqual({
      dropped: 0,
      requeued: 0,
      started: 0,
    });
    expect((await lessons(t))[0]).toMatchObject({
      status: 'failed',
      run_id: null,
      retryable: 0,
      error: LEARN_STOPPED,
    });
  });

  it('leaves a lesson learning inside the stale window alone', async () => {
    const { t } = await closedLesson();
    const [l] = await lessons(t);
    await set(
      t,
      l.id,
      `status = 'learning', run_id = 'alive', attempts = 1, started_at = ?`,
      Math.floor(Date.now() / 1000) - 600
    );
    expect(await recoverLessons(t.env, drizzle(t.env.DB, { schema }))).toEqual({
      dropped: 0,
      requeued: 0,
      started: 0,
    });
    expect((await lessons(t))[0]).toMatchObject({
      status: 'learning',
      run_id: 'alive',
    });
  });

  it('retries a retryable failure once, never a second time, and never a rejected edit', async () => {
    const { t } = await closedLesson();
    const db = drizzle(t.env.DB, { schema });
    const [l] = await lessons(t);
    // A rejected edit: not retryable.
    await set(t, l.id, `status = 'failed', retryable = 0, attempts = 1`);
    expect((await recoverLessons(t.env, db)).requeued).toBe(0);
    // A model failure on its first attempt: tried once more.
    await set(t, l.id, `status = 'failed', retryable = 1, attempts = 1`);
    expect(await recoverLessons(t.env, db)).toEqual({
      dropped: 0,
      requeued: 1,
      started: 1,
    });
    expect((await lessons(t))[0]).toMatchObject({
      status: 'pending',
      retryable: 0,
    });
    // It failed again: that was its last attempt.
    await set(t, l.id, `status = 'failed', retryable = 1, attempts = 2`);
    expect((await recoverLessons(t.env, db)).requeued).toBe(0);
    expect((await lessons(t))[0].status).toBe('failed');
  });

  it("starts a pending lesson whose Workflow was lost, and it's learned once", async () => {
    const { t } = await closedLesson();
    expect(learnRuns(t)).toHaveLength(1);
    expect(await recoverLessons(t.env, drizzle(t.env.DB, { schema }))).toEqual({
      dropped: 0,
      requeued: 0,
      started: 1,
    });
    expect(learnRuns(t)).toHaveLength(2);
    const learner = fakeLearner();
    await runLessons(t, learner.api);
    expect(learner.starts).toHaveLength(1);
    expect((await lessons(t))[0].status).toBe('nothing');
  });

  it('drops unfinished lessons of a deleted agent, and keeps committed ones', async () => {
    const { t, admin } = await closedLesson();
    const db = drizzle(t.env.DB, { schema });
    const [l] = await lessons(t);
    await set(t, l.id, `status = 'committed', commit_sha = ?`, 'c'.repeat(40));
    await call(t, '/api/admin/agents/secagent', {
      cookie: admin,
      method: 'DELETE',
    });
    expect((await recoverLessons(t.env, db)).dropped).toBe(0);
    await set(t, l.id, `status = 'pending', commit_sha = NULL`);
    expect(await recoverLessons(t.env, db)).toEqual({
      dropped: 1,
      requeued: 0,
      started: 0,
    });
    expect(await lessons(t)).toEqual([]);
  });

  it('runs with the daily retention, which reports what it did', async () => {
    const { t } = await closedLesson();
    const status = await runActionsRetention(
      t.env,
      drizzle(t.env.DB, { schema })
    );
    expect(status).toMatchObject({
      lessonsDropped: 0,
      lessonsRequeued: 0,
      lessonsStarted: 1,
    });
  });
});
