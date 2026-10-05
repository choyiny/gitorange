import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import type { ClassifierAnswer } from '../db/app.schema';
import type { StepRunner } from '../merge/resolution';
import { executeResolution } from '../merge/resolution';
import type { ResolveResult } from '../merge/resolver';
import { executeSweep, type SweepParams } from '../merge/auto';
import { executeClassification } from '../review/classify';
import type { ReviewModels } from '../review/models';
import { executeStacking, type StackParams } from '../stack/discover';
import type { StackModels } from '../stack/models';
import {
  closeAgentRun,
  DID_NOT_FINISH,
  recordAgentRun,
} from '../agent-runs/record';
import { noteDecision } from '../agent-runs/context';
import {
  closeStaleAgentRuns,
  pruneAgentRuns,
  runActionsRetention,
} from '../actions/retention';
import { recordAiUsage } from '../usage/record';
import type { MergeResolutionParams } from '../merge/workflow';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
  type TestEnv,
} from './helpers/app';
import { commitFiles, commitPaths } from './helpers/seed';

const dbOf = (t: TestEnv) => drizzle(t.env.DB, { schema });

/**
 * A Workflow-like step runner: completed steps are cached by name and replayed without running
 * again; a step with `retries` is retried that many times before it fails.
 */
function durableSteps() {
  const cache = new Map<string, unknown>();
  const runner = {
    async do(name: string, a: unknown, b?: unknown) {
      const fn = (b ?? a) as () => Promise<unknown>;
      const config = (b ? a : undefined) as
        { retries?: { limit: number } } | undefined;
      if (cache.has(name)) return cache.get(name);
      const limit = config?.retries?.limit ?? 0;
      for (let attempt = 0; ; attempt++)
        try {
          const out = await fn();
          // Workflows hands back the serialized result.
          const stored =
            out === undefined ? undefined : JSON.parse(JSON.stringify(out));
          cache.set(name, stored);
          return stored;
        } catch (e) {
          if (attempt >= limit) throw e;
        }
    },
  };
  return { step: runner as unknown as StepRunner, cache };
}

type RunRow = {
  id: string;
  repository_id: string;
  pull_request_id: string | null;
  kind: string;
  status: string;
  title: string;
  workflow_instance_id: string;
  started_at: number;
  finished_at: number | null;
  error: string | null;
};
type StepRow = {
  id: string;
  name: string;
  position: number;
  status: string;
  attempts: number;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_estimate: number | null;
  decision: string | null;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
};

async function runs(t: TestEnv) {
  return (
    await t.env.DB.prepare(
      'SELECT * FROM agent_runs ORDER BY started_at'
    ).all<RunRow>()
  ).results;
}
async function stepsOf(t: TestEnv, runId: string) {
  return (
    await t.env.DB.prepare(
      'SELECT * FROM agent_steps WHERE run_id = ? ORDER BY position'
    )
      .bind(runId)
      .all<StepRow>()
  ).results;
}

/** The test D1 database, where statements matching `fail` throw; `writes` logs every write. */
function watchedDb(t: TestEnv, fail: (sql: string) => boolean = () => false) {
  const writes: string[] = [];
  const db = new Proxy(t.env.DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          if (fail(sql)) throw new Error('D1 is down');
          if (/^\s*(insert|update|delete)/i.test(sql)) writes.push(sql);
          return target.prepare(sql);
        };
      const v = (target as any)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as D1Database;
  return Object.assign(db, { writes });
}

// ── review ────────────────────────────────────────────────────────────────────

const POLICY = `
model: clef
checks:
  require: none
human_review:
  questions:
    data_model:
      ask: Does this change alter how data is stored?
      above: 0.3
`;

async function reviewPull() {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'private' },
  });
  const repo = [...t.fake.repos.values()][0];
  const base = {
    'src/app.ts': 'export const a = 1;\n',
    '.gitorange/review.yml': POLICY,
  };
  const main = await commitPaths(repo, 'main', base, 'base');
  repo.refs.set('refs/heads/feature', main);
  const head = await commitPaths(
    repo,
    'feature',
    { ...base, 'migrations/0001.sql': 'ALTER TABLE x ADD y;\n' },
    'Add a column'
  );
  await call(t, '/api/repos/octocat/app/pulls', {
    cookie: admin,
    json: { title: 'Add a column', body: '', base: 'main', head: 'feature' },
  });
  await settle(t);
  const review = t.actions.resolutions.find(
    (s) => (s.params as { classificationId?: string }).classificationId
  )!;
  return { t, admin, head, review };
}

/** Fake review models that record usage the way the Workers AI ones do. */
function reviewModels(
  t: TestEnv,
  opts: { failClassify?: boolean } = {}
): ReviewModels {
  const answers: Record<string, ClassifierAnswer> = {
    data_model: { type: 'noul', value: 0.9 },
  };
  const use = (
    feature: Parameters<typeof recordAiUsage>[1]['feature'],
    model: string,
    tokensIn: number,
    tokensOut: number
  ) =>
    recordAiUsage(t.env, {
      feature,
      model,
      tokensIn,
      tokensOut,
      tokensCached: null,
    });
  return {
    reviewModelId: '@cf/zai-org/glm-5.3',
    summarize: async (f) => {
      await use('review-summary', '@cf/zai-org/glm-5.3-flash', 1000, 100);
      return `Changes ${f.path}.`;
    },
    classify: async () => {
      if (opts.failClassify) throw new Error('model down');
      await use('review-classify', '@cf/cloudflare/clef', 2000, 0);
      return answers;
    },
    investigate: async () => {
      await use('review-investigate', '@cf/zai-org/glm-5.3', 5000, 800);
      return {
        detail: 'Adds column y to table x.',
        diagram: null,
        snippets: [],
        paths: ['migrations/0001.sql'],
      };
    },
  };
}

async function runReview(
  t: TestEnv,
  instance: { id: string; params: unknown },
  models: ReviewModels,
  opts: { step?: StepRunner; recorderDb?: ReturnType<typeof dbOf> } = {}
) {
  const db = dbOf(t);
  const payload = instance.params as MergeResolutionParams;
  await recordAgentRun(
    t.env,
    opts.recorderDb ?? db,
    { instanceId: instance.id, payload },
    opts.step ?? durableSteps().step,
    (step) =>
      executeClassification(
        { env: t.env, db, step, models },
        payload.classificationId!
      )
  );
}

describe('agent runs: recording', () => {
  it('records a review run with its steps, models, tokens, cost and decisions', async () => {
    const { t, head, review } = await reviewPull();
    await runReview(t, review, reviewModels(t));

    const [run] = await runs(t);
    expect(run).toMatchObject({
      id: review.id,
      workflow_instance_id: review.id,
      kind: 'review',
      status: 'succeeded',
      title: `Review of ${head.slice(0, 7)}`,
      error: null,
    });
    expect(run.pull_request_id).toBeTruthy();
    expect(run.finished_at).toBeGreaterThanOrEqual(run.started_at);

    const steps = await stepsOf(t, run.id);
    expect(steps.map((s) => s.name)).toEqual([
      'load',
      'summary:0',
      'save-files',
      'classify',
      'flags',
      'investigate:0',
      'finish',
      'auto-merge',
      'stacking',
    ]);
    expect(steps.every((s) => s.status === 'succeeded')).toBe(true);
    expect(steps.every((s) => s.attempts === 1)).toBe(true);
    const by = (n: string) => steps.find((s) => s.name === n)!;
    expect(by('load').model).toBeNull();
    expect(by('summary:0')).toMatchObject({
      model: '@cf/zai-org/glm-5.3-flash',
      tokens_in: 1000,
      tokens_out: 100,
      decision: 'migrations/0001.sql',
    });
    expect(by('summary:0').cost_estimate).toBeCloseTo(
      (1000 * 0.15 + 100 * 0.5) / 1e6,
      12
    );
    expect(by('classify')).toMatchObject({
      model: '@cf/cloudflare/clef',
      tokens_in: 2000,
      tokens_out: 0,
    });
    expect(by('classify').decision).toContain('data_model: yes 0.90');
    expect(by('flags').decision).toContain('data_model');
    expect(by('investigate:0')).toMatchObject({
      model: '@cf/zai-org/glm-5.3',
      tokens_in: 5000,
      tokens_out: 800,
    });
    expect(by('investigate:0').decision).toContain('data_model');
    // Usage rows point at the step that made them.
    const usage = await t.env.DB.prepare(
      'SELECT feature, agent_step_id FROM ai_usage ORDER BY created_at'
    ).all<{ feature: string; agent_step_id: string }>();
    expect(
      usage.results.find((u) => u.feature === 'review-classify')!.agent_step_id
    ).toBe(by('classify').id);
  });

  it('marks the run failed when a step fails, with a short error', async () => {
    const { t, review } = await reviewPull();
    await runReview(t, review, reviewModels(t, { failClassify: true }));
    const [run] = await runs(t);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/classifier could not be reached/);
    const steps = await stepsOf(t, run.id);
    const classify = steps.find((s) => s.name === 'classify')!;
    expect(classify.status).toBe('failed');
    expect(classify.error).toBe('model down');
    // MODEL_RETRIES: the first attempt and 3 retries.
    expect(classify.attempts).toBe(4);
    expect(steps.map((s) => s.name)).toContain('fail');
  });

  it('marks the run failed and rethrows when the Workflow body throws', async () => {
    const { t, review } = await reviewPull();
    const db = dbOf(t);
    const { step } = durableSteps();
    await expect(
      recordAgentRun(
        t.env,
        db,
        {
          instanceId: review.id,
          payload: review.params as MergeResolutionParams,
        },
        step,
        async (s) => {
          await s.do('load', async () => 1);
          await s.do('boom', async () => {
            throw new Error('exploded\nwith a long stack');
          });
        }
      )
    ).rejects.toThrow('exploded');
    const [run] = await runs(t);
    expect(run).toMatchObject({ status: 'failed', error: 'exploded' });
    const steps = await stepsOf(t, run.id);
    expect(steps.map((s) => [s.name, s.status])).toEqual([
      ['load', 'succeeded'],
      ['boom', 'failed'],
    ]);
  });

  it('never fails the Workflow when recording fails', async () => {
    const { t, review } = await reviewPull();
    // Reads work; every write through the recorder's database fails.
    const broken = watchedDb(t, (sql) =>
      /^\s*(insert|update|delete)/i.test(sql)
    );
    await runReview(t, review, reviewModels(t), {
      recorderDb: drizzle(broken, { schema }),
    });
    const row = await t.env.DB.prepare(
      'SELECT status FROM pr_classifications'
    ).first<{ status: string }>();
    expect(row?.status).toBe('done');
    expect(await runs(t)).toEqual([]);
  });

  it('keeps the Workflow going when step writes fail after the run is recorded', async () => {
    const { t, review } = await reviewPull();
    const broken = watchedDb(t, (sql) =>
      /^\s*(insert into|update)\s+"?agent_steps/i.test(sql)
    );
    await runReview(t, review, reviewModels(t), {
      recorderDb: drizzle(broken, { schema }),
    });
    const row = await t.env.DB.prepare(
      'SELECT status FROM pr_classifications'
    ).first<{ status: string }>();
    expect(row?.status).toBe('done');
    const [run] = await runs(t);
    expect(run.status).toBe('succeeded');
    expect(await stepsOf(t, run.id)).toEqual([]);
  });

  it('fails the steps a closed run left unfinished', async () => {
    const { t } = await reviewPull();
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{
      id: string;
    }>())!.id;
    await t.env.DB.batch([
      t.env.DB.prepare(
        `INSERT INTO agent_runs (id, repository_id, kind, status, title, workflow_instance_id, started_at)
         VALUES ('r', ?, 'sweep', 'running', 'R', 'r', ?)`
      ).bind(repoId, Date.now()),
      t.env.DB.prepare(
        `INSERT INTO agent_steps (id, run_id, position, name, status, started_at, finished_at, attempts)
         VALUES ('r:a', 'r', 0, 'a', 'succeeded', 1, 2, 1), ('r:b', 'r', 1, 'b', 'running', 1, NULL, 1)`
      ),
    ]);
    await closeAgentRun(dbOf(t), 'r', 'Superseded by newer commits.');
    const [run] = (await runs(t)).filter((r) => r.id === 'r');
    expect(run).toMatchObject({
      status: 'failed',
      error: 'Superseded by newer commits.',
    });
    const steps = await stepsOf(t, 'r');
    expect(steps.map((s) => [s.name, s.status, s.error])).toEqual([
      ['a', 'succeeded', null],
      ['b', 'failed', 'Did not finish'],
    ]);
    expect(steps[1].finished_at).toBeTruthy();
  });

  it('repairs a step whose finish write was lost when the Workflow replays', async () => {
    const { t, review } = await reviewPull();
    const durable = durableSteps();
    await runReview(t, review, reviewModels(t), { step: durable.step });
    await t.env.DB.prepare(
      "UPDATE agent_steps SET status = 'running', finished_at = NULL WHERE name = 'finish'"
    ).run();
    await runReview(t, review, reviewModels(t), { step: durable.step });
    const finish = (await stepsOf(t, review.id)).find(
      (s) => s.name === 'finish'
    )!;
    expect(finish.status).toBe('succeeded');
    expect(finish.finished_at).toBeTruthy();
  });

  it('lets a real finish override a stale close, for the run and its step', async () => {
    const { t, review } = await reviewPull();
    const db = dbOf(t);
    await recordAgentRun(
      t.env,
      db,
      {
        instanceId: review.id,
        payload: review.params as MergeResolutionParams,
      },
      durableSteps().step,
      async (s) => {
        await s.do('slow', async () => {
          // The daily job runs while this step is still going (as if 3 hours later).
          expect(
            await closeStaleAgentRuns(db, new Date(Date.now() + 3 * 3600_000))
          ).toBe(1);
          return 1;
        });
      }
    );
    const [run] = await runs(t);
    expect(run).toMatchObject({ status: 'succeeded', error: null });
    const [slow] = await stepsOf(t, run.id);
    expect(slow).toMatchObject({ status: 'succeeded', error: null });
  });

  it('closes a stale-closed run for real', async () => {
    const { t } = await reviewPull();
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{
      id: string;
    }>())!.id;
    await t.env.DB.prepare(
      `INSERT INTO agent_runs (id, repository_id, kind, status, title, workflow_instance_id, started_at, finished_at, error)
       VALUES ('r', ?, 'sweep', 'failed', 'R', 'r', ?, ?, ?)`
    )
      .bind(repoId, Date.now() - 3 * 3600_000, Date.now(), DID_NOT_FINISH)
      .run();
    await closeAgentRun(dbOf(t), 'r', null);
    expect((await runs(t))[0]).toMatchObject({
      status: 'succeeded',
      error: null,
    });
    // A run that really failed stays failed.
    await closeAgentRun(dbOf(t), 'r', 'boom');
    expect((await runs(t))[0].status).toBe('succeeded');
  });

  it('clears a decision when a step is retried', async () => {
    const { t, review } = await reviewPull();
    let tried = false;
    await recordAgentRun(
      t.env,
      dbOf(t),
      {
        instanceId: review.id,
        payload: review.params as MergeResolutionParams,
      },
      durableSteps().step,
      async (s) => {
        await s.do('x', { retries: { limit: 1, delay: 0 } }, async () => {
          if (!tried) {
            tried = true;
            await noteDecision('from the failed attempt');
            throw new Error('flaky');
          }
          return 1;
        });
      }
    );
    const [x] = await stepsOf(t, review.id);
    expect(x).toMatchObject({
      attempts: 2,
      decision: null,
      status: 'succeeded',
    });
  });

  it('does not duplicate a run or its steps when the Workflow replays', async () => {
    const { t, review } = await reviewPull();
    const durable = durableSteps();
    await runReview(t, review, reviewModels(t), { step: durable.step });
    const before = await stepsOf(t, review.id);
    const [first] = await runs(t);
    // Workflows re-runs the code from the top; completed steps return their cached results.
    const watched = watchedDb(t);
    await runReview(t, review, reviewModels(t), {
      step: durable.step,
      recorderDb: drizzle(watched, { schema }),
    });
    // A replayed step only issues its conditional repair (an update that matches nothing).
    const stepWrites = watched.writes.filter((w) => /agent_steps/.test(w));
    expect(stepWrites.length).toBe(before.length);
    expect(stepWrites.every((w) => /^\s*update/i.test(w))).toBe(true);
    expect(await runs(t)).toEqual([first]);
    expect(await stepsOf(t, review.id)).toEqual(before);
    const usage = await t.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM ai_usage'
    ).first<{ n: number }>();
    expect(usage?.n).toBe(3);
  });
});

// ── conflict resolution and sweep ─────────────────────────────────────────────

const BASE = 'one\ntwo\nthree\nfour\nfive\n';

async function conflictingPull() {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'internal' },
  });
  const repo = [...t.fake.repos.values()][0];
  const root = await commitFiles(repo, 'main', { 'notes.txt': BASE }, 'base');
  await commitFiles(
    repo,
    'main',
    { 'notes.txt': BASE.replace('three', 'THREE (main)') },
    'Shout line three'
  );
  await commitFiles(
    repo,
    'feature',
    { 'notes.txt': BASE.replace('three', 'three, and a half') },
    'Elaborate on three',
    [root]
  );
  await call(t, '/api/repos/octocat/app/pulls', {
    cookie: admin,
    json: { title: 'Elaborate', body: '', base: 'main', head: 'feature' },
  });
  await settle(t);
  return { t, admin };
}

describe('agent runs: conflict resolution, sweep, stack discovery', () => {
  it('records a conflict resolution with the resolver model and tokens', async () => {
    const { t } = await conflictingPull();
    const instance = t.actions.resolutions.find(
      (s) => (s.params as { resolutionId?: string }).resolutionId
    )!;
    const id = (instance.params as { resolutionId: string }).resolutionId;
    const db = dbOf(t);
    const result: ResolveResult = {
      status: 'done',
      explanation:
        'Kept the uppercase from main and the detail from the PR.\nMore.',
      files: { 'notes.txt': BASE.replace('three', 'THREE (main), and a half') },
      transcript: JSON.stringify([
        {
          role: 'assistant',
          usage: { input: 1000, output: 200, cacheRead: 0 },
        },
      ]),
    };
    await recordAgentRun(
      t.env,
      db,
      {
        instanceId: instance.id,
        payload: instance.params as MergeResolutionParams,
      },
      durableSteps().step,
      (step) =>
        executeResolution(
          {
            env: t.env,
            db,
            step,
            resolver: () => ({ resolve: async () => result }),
          },
          id
        )
    );
    const [run] = await runs(t);
    expect(run).toMatchObject({
      kind: 'conflict_resolution',
      status: 'succeeded',
      title: 'Resolve conflicts with main',
    });
    const steps = await stepsOf(t, run.id);
    expect(steps.map((s) => s.name)).toEqual([
      'load',
      'prepare',
      'resolve',
      'commit',
      'auto-merge',
      'next',
    ]);
    const resolve = steps.find((s) => s.name === 'resolve')!;
    expect(resolve).toMatchObject({ tokens_in: 1000, tokens_out: 200 });
    expect(resolve.model).toBeTruthy();
    expect(resolve.decision).toBe(
      'Resolved 1 file: Kept the uppercase from main and the detail from the PR.'
    );
    expect(steps.find((s) => s.name === 'prepare')!.decision).toBe(
      '1 conflicted file'
    );
  });

  it('records a sweep', async () => {
    const { t } = await conflictingPull();
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{
      id: string;
    }>())!.id;
    const db = dbOf(t);
    const sweep: SweepParams = { repositoryId: repoId, branches: ['main'] };
    await recordAgentRun(
      t.env,
      db,
      { instanceId: 'sweep-1', payload: { sweep } },
      durableSteps().step,
      (step) => executeSweep({ env: t.env, db, step }, sweep)
    );
    const [run] = await runs(t);
    expect(run).toMatchObject({
      kind: 'sweep',
      status: 'succeeded',
      title: 'Sweep after a push to main',
      pull_request_id: null,
    });
    const steps = await stepsOf(t, run.id);
    expect(steps.map((s) => s.name.split(':')[0])).toEqual([
      'repo',
      'targets',
      'pr',
    ]);
    expect(steps[1].decision).toBe('1 open pull request to check');
  });

  it('records a stack discovery run with Clef and the reasoning model', async () => {
    const t = makeEnv({ actions: true });
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'internal' },
    });
    const repo = [...t.fake.repos.values()][0];
    const main = await commitFiles(repo, 'main', { 'notes.txt': BASE }, 'base');
    for (const [branch, text] of [
      ['one', 'one\ntwo\nTHREE\nfour\nfive\n'],
      ['two', 'one\ntwo\nthree!\nfour\nfive\n'],
    ]) {
      await commitFiles(repo, branch, { 'notes.txt': text }, branch, [main]);
      await call(t, '/api/repos/octocat/app/pulls', {
        cookie: admin,
        json: { title: branch, body: '', base: 'main', head: branch },
      });
    }
    await settle(t);
    const pr2 = (await t.env.DB.prepare(
      'SELECT id FROM pull_requests WHERE number = 2'
    ).first<{ id: string }>())!.id;
    const use = (feature: 'stack-decide' | 'stack-explain', model: string) =>
      recordAiUsage(t.env, {
        feature,
        model,
        tokensIn: 700,
        tokensOut: 50,
        tokensCached: null,
      });
    const models: StackModels = {
      decide: async () => {
        await use('stack-decide', '@cf/cloudflare/clef');
        return {
          related: { type: 'noul', value: 0.9 },
          kind: {
            type: 'choice',
            value: 'conflicts',
            confidence: 0.95,
            probabilities: { conflicts: 0.95 },
          },
          prerequisite: {
            type: 'choice',
            value: 'a',
            confidence: 0.95,
            probabilities: { a: 0.95 },
          },
        };
      },
      explain: async (i) => {
        await use('stack-explain', '@cf/zai-org/glm-5.3');
        return {
          kind: i.decided?.kind ?? 'conflicts',
          prerequisite: i.decided?.prerequisite ?? 'a',
          reason: 'Both edit line three of notes.txt.',
          instructions: null,
        };
      },
    };
    const db = dbOf(t);
    const stack: StackParams = { pullRequestId: pr2 };
    await recordAgentRun(
      t.env,
      db,
      { instanceId: 'stack-test', payload: { stack } },
      durableSteps().step,
      (step) => executeStacking({ env: t.env, db, step, models }, stack)
    );
    const [run] = await runs(t);
    expect(run).toMatchObject({
      kind: 'stack_discovery',
      status: 'succeeded',
      title: 'Stack discovery for #2',
      pull_request_id: pr2,
    });
    const steps = await stepsOf(t, run.id);
    expect(steps.map((s) => s.name.split(':')[0])).toEqual([
      'load',
      'claim',
      'conflicts',
      'decide',
      'deep',
      'explain',
      'save',
    ]);
    const decide = steps.find((s) => s.name.startsWith('decide:'))!;
    expect(decide).toMatchObject({
      model: '@cf/cloudflare/clef',
      tokens_in: 700,
    });
    expect(decide.decision).toContain('kind: conflicts 0.95');
    const explain = steps.find((s) => s.name.startsWith('explain:'))!;
    expect(explain.model).toBe('@cf/zai-org/glm-5.3');
    expect(explain.decision).toBe(
      'conflicts, a first: Both edit line three of notes.txt.'
    );
    expect(steps.find((s) => s.name.startsWith('conflicts:'))!.decision).toBe(
      'Conflicts in 1 file: notes.txt'
    );
  });
});

// ── API and retention ─────────────────────────────────────────────────────────

async function seedRuns(t: TestEnv, repoId: string, prId: string | null) {
  const db = t.env.DB;
  const kinds = ['review', 'conflict_resolution', 'stack_discovery', 'sweep'];
  const stmts = [];
  for (let i = 0; i < 30; i++)
    stmts.push(
      db
        .prepare(
          `INSERT INTO agent_runs (id, repository_id, pull_request_id, kind, status, title, workflow_instance_id, started_at, finished_at)
           VALUES (?, ?, ?, ?, 'succeeded', ?, ?, ?, ?)`
        )
        .bind(
          `run-${i}`,
          repoId,
          prId,
          kinds[i % 4],
          `Run ${i}`,
          `run-${i}`,
          Date.now() - (30 - i) * 60_000,
          Date.now() - (30 - i) * 60_000 + 5000
        )
    );
  await db.batch(stmts);
}

describe('agent runs: API', () => {
  it('lists runs newest first with a cursor and a kind filter; shows a run with its steps', async () => {
    const { t, admin, review } = await reviewPull();
    await runReview(t, review, reviewModels(t));
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{
      id: string;
    }>())!.id;
    await seedRuns(t, repoId, null);

    type Page = {
      runs: {
        id: string;
        kind: string;
        status: string;
        title: string;
        pullRequest: { number: number; title: string } | null;
        startedAt: string;
        finishedAt: string | null;
      }[];
      nextCursor: string | null;
    };
    const page1 = (await (
      await call(t, '/api/repos/octocat/app/agent-runs?limit=20', {
        cookie: admin,
      })
    ).json()) as Page;
    expect(page1.runs).toHaveLength(20);
    // The review ran last.
    expect(page1.runs[0]).toMatchObject({
      id: review.id,
      kind: 'review',
      pullRequest: { number: 1, title: 'Add a column' },
    });
    expect(page1.runs[1].id).toBe('run-29');
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (await (
      await call(
        t,
        `/api/repos/octocat/app/agent-runs?limit=20&cursor=${encodeURIComponent(page1.nextCursor!)}`,
        { cookie: admin }
      )
    ).json()) as Page;
    expect(page2.runs).toHaveLength(11);
    expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.runs, ...page2.runs].map((r) => r.id)).size).toBe(
      31
    );

    const sweeps = (await (
      await call(t, '/api/repos/octocat/app/agent-runs?kind=sweep', {
        cookie: admin,
      })
    ).json()) as Page;
    expect(sweeps.runs.length).toBe(7);
    expect(sweeps.runs.every((r) => r.kind === 'sweep')).toBe(true);

    const forPull = (await (
      await call(t, '/api/repos/octocat/app/agent-runs?pull=1', {
        cookie: admin,
      })
    ).json()) as Page;
    expect(forPull.runs.map((r) => r.id)).toEqual([review.id]);

    const res = await call(
      t,
      `/api/repos/octocat/app/agent-runs/${encodeURIComponent(review.id)}`,
      { cookie: admin }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: {
        id: string;
        status: string;
        title: string;
        tokensIn: number;
        tokensOut: number;
        costEstimate: number | null;
      };
      steps: {
        name: string;
        displayName: string;
        status: string;
        attempts: number;
        model: string | null;
        tokensIn: number | null;
        tokensOut: number | null;
        costEstimate: number | null;
        decision: string | null;
        startedAt: string | null;
        finishedAt: string | null;
      }[];
    };
    expect(body.run).toMatchObject({ id: review.id, status: 'succeeded' });
    expect(body.run.tokensIn).toBe(8000);
    expect(body.run.tokensOut).toBe(900);
    expect(body.run.costEstimate).toBeGreaterThan(0);
    expect(body.steps.map((s) => s.displayName)).toEqual([
      'Load',
      'Summarize file 1',
      'Save summaries',
      'Classify',
      'Record flags',
      'Investigate flag 1',
      'Finish',
      'Try auto-merge',
      'Start stack discovery',
    ]);
    expect(body.steps[3]).toMatchObject({
      name: 'classify',
      status: 'succeeded',
      attempts: 1,
      model: '@cf/cloudflare/clef',
      tokensIn: 2000,
    });

    const missing = await call(t, '/api/repos/octocat/app/agent-runs/nope', {
      cookie: admin,
    });
    expect(missing.status).toBe(404);
  });

  it('hides a private repository’s runs from non-collaborators', async () => {
    const { t, admin, review } = await reviewPull();
    await runReview(t, review, reviewModels(t));
    const outsider = await addMember(t, admin, 'mallory');
    for (const path of [
      '/api/repos/octocat/app/agent-runs',
      `/api/repos/octocat/app/agent-runs/${encodeURIComponent(review.id)}`,
    ])
      expect((await call(t, path, { cookie: outsider })).status).toBe(404);
  });

  it('shows a run left running for hours as not finished', async () => {
    const { t, admin } = await reviewPull();
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{
      id: string;
    }>())!.id;
    await t.env.DB.prepare(
      `INSERT INTO agent_runs (id, repository_id, kind, status, title, workflow_instance_id, started_at)
       VALUES ('stuck', ?, 'sweep', 'running', 'Stuck', 'stuck', ?)`
    )
      .bind(repoId, Date.now() - 3 * 3600_000)
      .run();
    const list = (await (
      await call(t, '/api/repos/octocat/app/agent-runs?kind=sweep', {
        cookie: admin,
      })
    ).json()) as { runs: { status: string; error: string | null }[] };
    expect(list.runs[0]).toMatchObject({
      status: 'failed',
      error: 'Did not finish',
    });
    const one = (await (
      await call(t, '/api/repos/octocat/app/agent-runs/stuck', {
        cookie: admin,
      })
    ).json()) as { run: { status: string; error: string | null } };
    expect(one.run).toMatchObject({
      status: 'failed',
      error: 'Did not finish',
    });
  });

  it('names stack steps by the other pull request', async () => {
    const t = makeEnv({ actions: true });
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'internal' },
    });
    const repo = [...t.fake.repos.values()][0];
    const main = await commitFiles(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    await commitFiles(repo, 'x', { 'a.txt': 'x\n' }, 'x', [main]);
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'x', body: '', base: 'main', head: 'x' },
    });
    const pr = (await t.env.DB.prepare(
      'SELECT id, repository_id FROM pull_requests'
    ).first<{ id: string; repository_id: string }>())!;
    await t.env.DB.batch([
      t.env.DB.prepare(
        `INSERT INTO agent_runs (id, repository_id, pull_request_id, kind, status, title, workflow_instance_id, started_at)
         VALUES ('s', ?, NULL, 'stack_discovery', 'running', 'Stack', 's', ?)`
      ).bind(pr.repository_id, Date.now()),
      t.env.DB.prepare(
        `INSERT INTO agent_steps (id, run_id, position, name, status, attempts) VALUES ('s:decide', 's', 0, ?, 'running', 1)`
      ).bind(`decide:${pr.id}`),
    ]);
    const body = (await (
      await call(t, '/api/repos/octocat/app/agent-runs/s', { cookie: admin })
    ).json()) as { steps: { displayName: string }[] };
    expect(body.steps[0].displayName).toBe('Decide relationship with #1');
  });
});

describe('agent runs: retention', () => {
  it('says there is more when the last prune batch was full', async () => {
    const { t } = await reviewPull();
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{
      id: string;
    }>())!.id;
    const old = Date.now() - 200 * 86_400_000;
    await t.env.DB.prepare(
      `INSERT INTO agent_runs (id, repository_id, kind, status, title, workflow_instance_id, started_at)
       VALUES ('o1', ?1, 'sweep', 'succeeded', 'O', 'o1', ?2), ('o2', ?1, 'sweep', 'succeeded', 'O', 'o2', ?2), ('o3', ?1, 'sweep', 'succeeded', 'O', 'o3', ?2)`
    )
      .bind(repoId, old)
      .run();
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    expect(
      await pruneAgentRuns(dbOf(t), cutoff, { batch: 1, maxBatches: 2 })
    ).toEqual({ deleted: 2, more: true });
    expect(
      await pruneAgentRuns(dbOf(t), cutoff, { batch: 1, maxBatches: 2 })
    ).toEqual({ deleted: 1, more: false });
  });

  it('closes runs left running for over 2 hours, with their open steps', async () => {
    const { t } = await reviewPull();
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{
      id: string;
    }>())!.id;
    await t.env.DB.batch([
      t.env.DB.prepare(
        `INSERT INTO agent_runs (id, repository_id, kind, status, title, workflow_instance_id, started_at)
         VALUES ('stale', ?, 'sweep', 'running', 'S', 'stale', ?), ('fresh', ?, 'sweep', 'running', 'F', 'fresh', ?)`
      ).bind(repoId, Date.now() - 3 * 3600_000, repoId, Date.now() - 600_000),
      t.env.DB.prepare(
        `INSERT INTO agent_steps (id, run_id, position, name, status, started_at, attempts)
         VALUES ('stale:x', 'stale', 0, 'x', 'running', 1, 1), ('fresh:x', 'fresh', 0, 'x', 'running', 1, 1)`
      ),
    ]);
    const status = await runActionsRetention(t.env, dbOf(t));
    expect(status.closedAgentRuns).toBe(1);
    const byId = new Map((await runs(t)).map((r) => [r.id, r]));
    expect(byId.get('stale')).toMatchObject({
      status: 'failed',
      error: 'Did not finish',
    });
    expect(byId.get('fresh')?.status).toBe('running');
    expect((await stepsOf(t, 'stale'))[0]).toMatchObject({
      status: 'failed',
      error: 'Did not finish',
    });
    expect((await stepsOf(t, 'fresh'))[0].status).toBe('running');
  });

  it('prunes runs older than the Actions retention, with their steps', async () => {
    const { t, review } = await reviewPull();
    await runReview(t, review, reviewModels(t));
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{
      id: string;
    }>())!.id;
    await t.env.DB.batch([
      t.env.DB.prepare(
        `INSERT INTO agent_runs (id, repository_id, kind, status, title, workflow_instance_id, started_at, finished_at)
         VALUES ('old', ?, 'sweep', 'succeeded', 'Old', 'old', ?, ?)`
      ).bind(
        repoId,
        Date.now() - 200 * 86_400_000,
        Date.now() - 200 * 86_400_000
      ),
      t.env.DB.prepare(
        `INSERT INTO agent_steps (id, run_id, position, name, status, attempts) VALUES ('old:repo', 'old', 0, 'repo', 'succeeded', 1)`
      ),
    ]);
    const status = await runActionsRetention(t.env, dbOf(t));
    expect(status.deletedAgentRuns).toBe(1);
    expect((await runs(t)).map((r) => r.id)).toEqual([review.id]);
    const orphan = await t.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM agent_steps WHERE run_id = 'old'"
    ).first<{ n: number }>();
    expect(orphan?.n).toBe(0);
  });
});
