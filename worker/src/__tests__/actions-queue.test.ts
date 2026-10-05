import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import {
  FRESH_WAIT_MS,
  MAX_RECHECK_MS,
  RECLAIM_MARGIN_MS,
  slotRecheck,
  type ActionsQueue,
  type ActionsQueueApi,
  type SlotRequest,
} from '../actions/queue';
import { actionsQueue } from '../actions/queue';
import { bootstrapAdmin, call, makeEnv, settle } from './helpers/app';
import { commitPaths } from './helpers/seed';
import {
  CI,
  harness,
  pushFiles,
  runDetail,
  runs,
  setup,
  type Setup,
} from './helpers/actions';

/** A queue of its own: tests share storage, so each one names a fresh instance. */
const fresh = () =>
  env.ACTIONS_QUEUE.getByName(
    `unit-${crypto.randomUUID()}`
  ) as unknown as ActionsQueueApi;
const ask = (
  jobId: string,
  limit: number,
  extra: Partial<SlotRequest> = {}
): SlotRequest => ({ jobId, runId: 'run-1', maxMinutes: 30, limit, ...extra });

describe('ActionsQueue', () => {
  it('grants at most the limit, even when many jobs ask at once', async () => {
    const q = fresh();
    const all = await Promise.all(
      Array.from({ length: 25 }, (_, i) => q.acquire(ask(`job-${i}`, 3)))
    );
    expect(all.filter((s) => s.granted)).toHaveLength(3);
    expect(
      all
        .filter((s) => !s.granted)
        .map((s) => s.ahead)
        .sort((a, b) => a - b)
    ).toEqual(Array.from({ length: 22 }, (_, i) => i));
  });

  it('grants in arrival order as slots free up', async () => {
    const q = fresh();
    expect(await q.acquire(ask('a', 1))).toEqual({ granted: true, ahead: 0 });
    expect(await q.acquire(ask('b', 1))).toEqual({ granted: false, ahead: 0 });
    expect(await q.acquire(ask('c', 1, { runId: 'run-2' }))).toEqual({
      granted: false,
      ahead: 1,
    });
    expect(await q.positions(['a', 'b', 'c', 'nope'])).toEqual({ b: 0, c: 1 });
    expect(await q.release('a')).toEqual([{ jobId: 'b', runId: 'run-1' }]);
    expect(await q.release('b')).toEqual([{ jobId: 'c', runId: 'run-2' }]);
    expect(await q.release('c')).toEqual([]);
  });

  it('asking again is idempotent, and releasing an unknown job does nothing', async () => {
    const q = fresh();
    await q.acquire(ask('a', 1));
    expect(await q.acquire(ask('a', 1))).toEqual({ granted: true, ahead: 0 });
    expect(await q.acquire(ask('b', 1))).toEqual({ granted: false, ahead: 0 });
    expect(await q.acquire(ask('b', 1))).toEqual({ granted: false, ahead: 0 });
    expect(await q.release('ghost')).toEqual([]);
    expect(await q.positions(['b'])).toEqual({ b: 0 });
  });

  it('releasing a waiting job takes it out of line', async () => {
    const q = fresh();
    await q.acquire(ask('a', 1));
    await q.acquire(ask('b', 1));
    await q.acquire(ask('c', 1));
    expect(await q.release('b')).toEqual([]);
    expect(await q.positions(['c'])).toEqual({ c: 0 });
  });

  it("cancelling a run drops all of its jobs, waiting or running, and grants the next run's", async () => {
    const q = fresh();
    await q.acquire(ask('a1', 2));
    await q.acquire(ask('a2', 2));
    await q.acquire(ask('a3', 2));
    await q.acquire(ask('b1', 2, { runId: 'run-2' }));
    expect(await q.cancelRun('run-1')).toEqual([
      { jobId: 'b1', runId: 'run-2' },
    ]);
    expect(await q.positions(['a3'])).toEqual({});
    expect(await q.acquire(ask('c1', 2, { runId: 'run-3' }))).toEqual({
      granted: true,
      ahead: 0,
    });
  });

  it('a raised limit grants on the next request; a lowered one only stops new grants', async () => {
    const q = fresh();
    await q.acquire(ask('a', 2));
    await q.acquire(ask('b', 2));
    expect(await q.acquire(ask('c', 2))).toEqual({ granted: false, ahead: 0 });
    // The limit came from Site admin when the job asked; a later job brings the new value.
    expect(await q.acquire(ask('d', 3))).toEqual({ granted: false, ahead: 0 });
    expect(await q.acquire(ask('c', 3))).toEqual({ granted: true, ahead: 0 });
    // Lowered to 1: the three running keep going, nothing new starts until fewer than 1 run.
    expect(await q.acquire(ask('e', 1))).toEqual({ granted: false, ahead: 1 });
    expect(await q.release('a')).toEqual([]);
    expect(await q.release('b')).toEqual([]);
    expect(await q.release('c')).toEqual([{ jobId: 'd', runId: 'run-1' }]);
  });

  it('reclaims slots whose job is gone or finished, and slots held past the timeout', async () => {
    // Real job rows: one workflow with three jobs.
    const t = makeEnv({ actions: true });
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', addReadme: true, visibility: 'internal' },
    });
    const repo = [...t.fake.repos.values()][0];
    const repoId = (await t.env.DB.prepare(
      "SELECT id FROM repositories WHERE name = 'app'"
    ).first<{ id: string }>())!.id;
    const runId = crypto.randomUUID();
    const sha = await commitPaths(repo, 'main', { 'a.txt': 'a' }, 'One');
    await t.env.DB.prepare(
      `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title, status, created_at)
       VALUES (?, ?, 1, '.github/workflows/ci.yml', 'CI', 'push', 'refs/heads/main', ?, 'One', 'in_progress', ?)`
    )
      .bind(runId, repoId, sha, Math.floor(Date.now() / 1000))
      .run();
    for (const [id, status] of [
      ['job-a', 'in_progress'],
      ['job-b', 'completed'],
      ['job-c', 'queued'],
    ])
      await t.env.DB.prepare(
        `INSERT INTO workflow_jobs (id, run_id, job_key, name, runs_on, needs, status)
         VALUES (?, ?, ?, ?, 'ubuntu-latest', '[]', ?)`
      )
        .bind(id, runId, id, id, status)
        .run();

    const q = fresh();
    await q.acquire(ask('job-a', 3, { runId, maxMinutes: 30 }));
    await q.acquire(ask('job-b', 3, { runId }));
    await q.acquire(ask('ghost', 3, { runId: 'deleted-run' }));
    await q.acquire(ask('job-c', 3, { runId, maxMinutes: 120 }));
    const t0 = Date.now();
    await q.started('job-a', t0);

    const first = await q.reclaim(t0);
    expect(first.reclaimed.sort()).toEqual(['ghost', 'job-b']);
    expect(first.grants).toEqual([{ jobId: 'job-c', runId }]);
    await q.started('job-c', t0);

    // job-a ran 30 minutes plus the margin; job-c (120 minutes) is still within its timeout.
    const later = await q.reclaim(
      t0 + 30 * 60_000 + RECLAIM_MARGIN_MS + 60_000
    );
    expect(later.reclaimed).toEqual(['job-a']);
    expect(await q.acquire(ask('job-c', 3, { runId }))).toEqual({
      granted: true,
      ahead: 0,
    });
  });
});

/** A repository ("app") to seed workflow runs into; `seed` adds one run with the given jobs. */
async function runSeeder() {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', addReadme: true, visibility: 'internal' },
  });
  const repo = [...t.fake.repos.values()][0];
  const repoId = (await t.env.DB.prepare(
    "SELECT id FROM repositories WHERE name = 'app'"
  ).first<{ id: string }>())!.id;
  const sha = await commitPaths(repo, 'main', { 'a.txt': 'a' }, 'One');
  let n = 0;
  return async (
    jobs: [string, string][],
    runStatus = 'in_progress'
  ): Promise<string> => {
    const runId = crypto.randomUUID();
    await t.env.DB.prepare(
      `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title, status, created_at)
       VALUES (?, ?, ?, '.github/workflows/ci.yml', 'CI', 'push', 'refs/heads/main', ?, 'One', ?, ?)`
    )
      .bind(runId, repoId, ++n, sha, runStatus, Math.floor(Date.now() / 1000))
      .run();
    for (const [id, status] of jobs)
      await t.env.DB.prepare(
        `INSERT INTO workflow_jobs (id, run_id, job_key, name, runs_on, needs, status)
         VALUES (?, ?, ?, ?, 'ubuntu-latest', '[]', ?)`
      )
        .bind(id, runId, id, id, status)
        .run();
    return runId;
  };
}
const seedRun = async (jobs: [string, string][], runStatus?: string) =>
  (await runSeeder())(jobs, runStatus);

describe('ActionsQueue reclaim', () => {
  it('rechecks after 5, 10, 20, then every 30 minutes', () => {
    expect([1, 2, 3, 4, 5, 50].map(slotRecheck)).toEqual([
      '5 minutes',
      '10 minutes',
      '20 minutes',
      '30 minutes',
      '30 minutes',
      '30 minutes',
    ]);
  });

  it("counts a slot's deadline from when its job started, not from the grant", async () => {
    const id = `late-${crypto.randomUUID()}`;
    const runId = await seedRun([[id, 'in_progress']]);
    const q = fresh();
    await q.acquire(ask(id, 1, { runId, maxMinutes: 30 }));
    const t0 = Date.now();
    // The grant was noticed late (a lost event and a recheck): the container started 20 minutes on.
    await q.started(id, t0 + 20 * 60_000);
    const oldDeadline = t0 + 30 * 60_000 + RECLAIM_MARGIN_MS + 60_000;
    expect((await q.reclaim(oldDeadline)).reclaimed).toEqual([]);
    expect((await q.reclaim(oldDeadline + 20 * 60_000)).reclaimed).toEqual([
      id,
    ]);
  });

  it('gives a granted job that has not started the longest recheck to notice', async () => {
    const id = `granted-${crypto.randomUUID()}`;
    const runId = await seedRun([[id, 'queued']]);
    const q = fresh();
    await q.acquire(ask(id, 1, { runId, maxMinutes: 5 }));
    const t0 = Date.now();
    // Its own timeout (5 minutes) plus the margin has passed, but it may still be waiting to recheck.
    expect(
      (await q.reclaim(t0 + MAX_RECHECK_MS + RECLAIM_MARGIN_MS - 60_000))
        .reclaimed
    ).toEqual([]);
    expect(
      (await q.reclaim(t0 + MAX_RECHECK_MS + RECLAIM_MARGIN_MS + 60_000))
        .reclaimed
    ).toEqual([id]);
  });

  it('reclaims the slots of a run that is finished in D1', async () => {
    const id = `done-${crypto.randomUUID()}`;
    // The run was finished (cancelled or reconciled) but its job row was left open.
    const runId = await seedRun([[id, 'in_progress']], 'completed');
    const q = fresh();
    await q.acquire(ask(id, 1, { runId }));
    expect((await q.reclaim()).reclaimed).toEqual([id]);
  });

  it('reclaims the slots of a run whose Workflow errored or was terminated, and finishes the run', async () => {
    const crashed = `crashed-${crypto.randomUUID()}`;
    const crashedWaiting = `crashed-w-${crypto.randomUUID()}`;
    const killed = `killed-${crypto.randomUUID()}`;
    const alive = `alive-${crypto.randomUUID()}`;
    const seed = await runSeeder();
    const crashedRun = await seed([
      [crashed, 'in_progress'],
      [crashedWaiting, 'queued'],
    ]);
    const killedRun = await seed([[killed, 'in_progress']]);
    const aliveRun = await seed([[alive, 'queued']]);
    const statuses: Record<string, string> = {
      [crashedRun]: 'errored',
      [killedRun]: 'terminated',
      [aliveRun]: 'running',
    };
    const stub = env.ACTIONS_QUEUE.getByName(`unit-${crypto.randomUUID()}`);
    const result = await runInDurableObject(stub, async (obj) => {
      const instance = obj as unknown as ActionsQueue;
      // The test config has no Workflow binding: give the object a fake one.
      (instance as unknown as { env: CloudflareBindings }).env = {
        ...env,
        ACTIONS_RUN: {
          get: async (id: string) => ({
            status: async () => ({ status: statuses[id] ?? 'unknown' }),
            sendEvent: async () => {},
          }),
        },
      } as unknown as CloudflareBindings;
      await instance.acquire(ask(crashed, 2, { runId: crashedRun }));
      await instance.acquire(ask(killed, 2, { runId: killedRun }));
      await instance.acquire(ask(crashedWaiting, 2, { runId: crashedRun }));
      await instance.acquire(ask(alive, 2, { runId: aliveRun }));
      return instance.reclaim();
    });
    expect(result.reclaimed.sort()).toEqual(
      [crashed, crashedWaiting, killed].sort()
    );
    expect(result.grants).toEqual([{ jobId: alive, runId: aliveRun }]);
    const run = (id: string) =>
      env.DB.prepare(
        'SELECT status, conclusion FROM workflow_runs WHERE id = ?'
      )
        .bind(id)
        .first<{ status: string; conclusion: string }>();
    expect(await run(crashedRun)).toEqual({
      status: 'completed',
      conclusion: 'failure',
    });
    expect(await run(killedRun)).toEqual({
      status: 'completed',
      conclusion: 'cancelled',
    });
    expect(await run(aliveRun)).toMatchObject({ status: 'in_progress' });
  });
  it('asks the Workflow only about runs holding a slot or waiting more than 10 minutes', async () => {
    const seed = await runSeeder();
    const holder = `holder-${crypto.randomUUID()}`;
    const waiter = `waiter-${crypto.randomUUID()}`;
    const holderRun = await seed([[holder, 'in_progress']]);
    const waiterRun = await seed([[waiter, 'queued']]);
    const asked: string[] = [];
    const stub = env.ACTIONS_QUEUE.getByName(`unit-${crypto.randomUUID()}`);
    const [fresh10, stale] = await runInDurableObject(stub, async (obj) => {
      const instance = obj as unknown as ActionsQueue;
      (instance as unknown as { env: CloudflareBindings }).env = {
        ...env,
        ACTIONS_RUN: {
          get: async (id: string) => ({
            status: async () => {
              asked.push(id);
              return { status: 'running' };
            },
            sendEvent: async () => {},
          }),
        },
      } as unknown as CloudflareBindings;
      await instance.acquire(ask(holder, 1, { runId: holderRun }));
      await instance.acquire(ask(waiter, 1, { runId: waiterRun }));
      const t0 = Date.now();
      await instance.reclaim(t0);
      const first = [...asked];
      asked.length = 0;
      await instance.reclaim(t0 + FRESH_WAIT_MS + 60_000);
      return [first, [...asked]];
    });
    expect(fresh10).toEqual([holderRun]);
    expect(stale.sort()).toEqual([holderRun, waiterRun].sort());
  });
});

const MATRIX = `on: push
jobs:
  work:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2, 3, 4, 5]
    steps:
      - run: work-\${{ matrix.n }}
`;

const setLimit = async (s: Setup, n: number) =>
  expect(
    (
      await call(s.t, '/api/admin/settings/actions.max_concurrent_jobs', {
        cookie: s.admin,
        method: 'PUT',
        json: { value: n },
      })
    ).status
  ).toBe(200);

/** A slot is free right now (every job gave its slot back). */
const queueIsEmpty = async (s: Setup) =>
  expect(
    await actionsQueue(s.t.env).acquire({
      jobId: `probe-${crypto.randomUUID()}`,
      runId: 'probe',
      maxMinutes: 1,
      limit: 1,
    })
  ).toEqual({ granted: true, ahead: 0 });

const slow = async () => {
  await new Promise((r) => setTimeout(r, 20));
  return {};
};

describe('Actions jobs wait for a slot', () => {
  it('never runs more jobs at once than the limit; waiting jobs start as slots free up', async () => {
    const s = await setup();
    await setLimit(s, 2);
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': MATRIX });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const h = harness(s.t, slow);
    expect(await h.run(queued.id)).toBe('success');
    expect(h.boots).toHaveLength(5);
    expect(h.peak()).toBe(2);
    expect(
      h.stepNames.filter((n) => n.includes(':queue:wait:')).length
    ).toBeGreaterThanOrEqual(3);
    const { jobs } = await runDetail(s.t, s.admin, 1);
    expect(jobs.every((j) => j.conclusion === 'success')).toBe(true);
    await queueIsEmpty(s);
  });

  it('starts waiting jobs even when every grant event is lost', async () => {
    const s = await setup();
    await setLimit(s, 1);
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': MATRIX });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const h = harness(s.t, slow, { loseEvents: true });
    expect(await h.run(queued.id)).toBe('success');
    expect(h.boots).toHaveLength(5);
    expect(h.peak()).toBe(1);
  });

  it('gives the slot back when a job fails', async () => {
    const s = await setup();
    await setLimit(s, 1);
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const h = harness(s.t, () => ({ exitCode: 1 }));
    expect(await h.run(queued.id)).toBe('failure');
    await queueIsEmpty(s);
  });

  it('gives the slot back when the runner is interrupted, and queues again for the restart', async () => {
    const s = await setup();
    await setLimit(s, 1);
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [queued] = (await runs(s.t, s.admin)).runs;
    let interrupted = false;
    const h = harness(s.t, (r) => {
      if (r.argv[r.argv.length - 1] === 'npm test' && !interrupted) {
        interrupted = true;
        throw new Error('Durable Object reset because its code was updated.');
      }
      return {};
    });
    expect(await h.run(queued.id)).toBe('success');
    const { jobs } = await runDetail(s.t, s.admin, 1);
    expect(h.stepNames).toContain(`job:${jobs[0].id}:queue`);
    expect(h.stepNames).toContain(`job:${jobs[0].id}:attempt:2:queue`);
    await queueIsEmpty(s);
  });

  it('runs jobs without a limit when the queue binding is missing', async () => {
    const s = await setup();
    await setLimit(s, 1);
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': MATRIX });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const t = {
      ...s.t,
      env: { ...s.t.env, ACTIONS_QUEUE: undefined },
    } as unknown as typeof s.t;
    const h = harness(t, slow);
    expect(await h.run(queued.id)).toBe('success');
    expect(h.peak()).toBe(5);
    expect(h.stepNames.some((n) => n.endsWith(':queue'))).toBe(false);
  });
});

describe('Queued jobs on the run page and when cancelling', () => {
  it('shows how many jobs are ahead, and cancelling takes the run out of the queue', async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [run] = (await runs(s.t, s.admin)).runs;
    const { jobs } = await runDetail(s.t, s.admin, 1);
    const q = actionsQueue(s.t.env);
    await q.acquire({
      jobId: 'busy',
      runId: 'other',
      maxMinutes: 30,
      limit: 1,
    });
    await q.acquire({
      jobId: 'next',
      runId: 'other',
      maxMinutes: 30,
      limit: 1,
    });
    await q.acquire({
      jobId: jobs[0].id,
      runId: run.id,
      maxMinutes: 30,
      limit: 1,
    });
    expect((await runDetail(s.t, s.admin, 1)).jobs[0].queuedAhead).toBe(1);

    const res = await call(
      s.t,
      '/api/repos/octocat/app/actions/runs/1/cancel',
      { cookie: s.admin, method: 'POST' }
    );
    expect(res.status).toBe(200);
    await settle(s.t);
    expect(await q.positions([jobs[0].id])).toEqual({});
    expect((await runDetail(s.t, s.admin, 1)).jobs[0].queuedAhead).toBeNull();
    expect(await q.release('busy')).toEqual([
      { jobId: 'next', runId: 'other' },
    ]);
  });

  it('never starts a waiting job whose run was cancelled', async () => {
    const s = await setup();
    await setLimit(s, 1);
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const q = actionsQueue(s.t.env);
    await q.acquire({
      jobId: 'busy',
      runId: 'other',
      maxMinutes: 30,
      limit: 1,
    });
    const h = harness(s.t);
    const done = h.run(queued.id);
    while (!h.stepNames.some((n) => n.includes(':queue:wait:')))
      await new Promise((r) => setTimeout(r, 5));
    const res = await call(
      s.t,
      '/api/repos/octocat/app/actions/runs/1/cancel',
      { cookie: s.admin, method: 'POST' }
    );
    expect(res.status).toBe(200);
    await settle(s.t);
    expect(await q.release('busy')).toEqual([]);
    expect(await done).toBe('cancelled');
    expect(h.boots).toHaveLength(0);
  });

  it('drops the jobs of a run whose Workflow crashed when the run is viewed', async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [run] = (await runs(s.t, s.admin)).runs;
    const { jobs } = await runDetail(s.t, s.admin, 1);
    const q = actionsQueue(s.t.env);
    await q.acquire({
      jobId: 'busy',
      runId: 'other',
      maxMinutes: 30,
      limit: 1,
    });
    await q.acquire({
      jobId: jobs[0].id,
      runId: run.id,
      maxMinutes: 30,
      limit: 1,
    });
    // reconcile() only looks at runs older than a minute.
    await s.t.env.DB.prepare(
      'UPDATE workflow_runs SET created_at = created_at - 600'
    ).run();
    s.t.actions.instanceStatus.set(run.id, 'errored');
    const detail = await runDetail(s.t, s.admin, 1);
    expect(detail.run.conclusion).toBe('failure');
    expect(await q.positions([jobs[0].id])).toEqual({});
  });
});

describe('Job queue failures and restarts', () => {
  it('runs the job without a slot when the queue cannot be reached', async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const broken = () => {
      throw new Error('queue unavailable');
    };
    const t = {
      ...s.t,
      env: {
        ...s.t.env,
        ACTIONS_QUEUE: {
          getByName: () => ({
            acquire: broken,
            started: broken,
            release: broken,
            cancelRun: broken,
            positions: broken,
          }),
        },
      },
    } as unknown as typeof s.t;
    const h = harness(t);
    expect(await h.run(queued.id)).toBe('success');
    expect(h.boots).toHaveLength(1);
  });

  it('shows a restarted job waiting for a slot again as queued', async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [run] = (await runs(s.t, s.admin)).runs;
    const { jobs } = await runDetail(s.t, s.admin, 1);
    // The first attempt started the job; its runner was interrupted and it queues again.
    await s.t.env.DB.prepare(
      "UPDATE workflow_jobs SET status = 'in_progress', started_at = ? WHERE id = ?"
    )
      .bind(Math.floor(Date.now() / 1000), jobs[0].id)
      .run();
    const q = actionsQueue(s.t.env);
    await q.acquire({
      jobId: 'busy',
      runId: 'other',
      maxMinutes: 30,
      limit: 1,
    });
    await q.acquire({
      jobId: jobs[0].id,
      runId: run.id,
      maxMinutes: 30,
      limit: 1,
    });
    const job = (await runDetail(s.t, s.admin, 1)).jobs[0];
    expect(job.status).toBe('in_progress');
    expect(job.queuedAhead).toBe(0);
  });

  /** The test's real queue, with `started` failing the first `failures` times. */
  const flakyStarted = (s: Setup, failures: number) => {
    const real = actionsQueue(s.t.env);
    const calls = { started: 0 };
    const queue: ActionsQueueApi = {
      acquire: (r) => real.acquire(r),
      started: async (id, now) => {
        if (++calls.started <= failures) throw new Error('queue hiccup');
        return real.started(id, now);
      },
      release: (id) => real.release(id),
      cancelRun: (id) => real.cancelRun(id),
      positions: (ids) => real.positions(ids),
      reclaim: (now) => real.reclaim(now),
    };
    const t = {
      ...s.t,
      env: { ...s.t.env, ACTIONS_QUEUE: { getByName: () => queue } },
    } as unknown as typeof s.t;
    return { t, calls, real };
  };

  it('retries marking a job started, so its slot counts from the start', async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const { t, calls, real } = flakyStarted(s, 1);
    let kept: string[] | null = null;
    const h = harness(
      t,
      async () => {
        // Past a granted-but-unstarted job's deadline: only a started job keeps its slot.
        kept ??= (
          await real.reclaim(
            Date.now() + MAX_RECHECK_MS + RECLAIM_MARGIN_MS + 60_000
          )
        ).reclaimed;
        return {};
      },
      { retrySteps: true }
    );
    expect(await h.run(queued.id)).toBe('success');
    expect(calls.started).toBe(2);
    expect(kept).toEqual([]);
  });

  it('runs the job when marking it started keeps failing', async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const { t, calls } = flakyStarted(s, Infinity);
    const h = harness(t, () => ({}), { retrySteps: true });
    expect(await h.run(queued.id)).toBe('success');
    expect(calls.started).toBe(4);
    expect(h.boots).toHaveLength(1);
  });
});
