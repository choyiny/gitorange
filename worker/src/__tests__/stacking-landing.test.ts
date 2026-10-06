// Stacking: the stack gate, retargeting, maintainer controls, and stack surfaces. Fixtures: helpers/stacking.ts.
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import type { StepRunner } from '../merge/resolution';
import { executeStacking, type StackParams } from '../stack/discover';
import { executeReconcile } from '../stack/reconcile';
import { contains } from '../stack/contains';
import { pullStates } from '../pulls/signals';
import { findRepoById, gitFor } from '../lib/repos';
import type { Relation } from '../stack/models';
import { addMember, call, settle, type TestEnv } from './helpers/app';
import { agentModels } from './helpers/reviews';
import {
  step,
  holdReviews,
  approveReviewOf,
  CONFLICT,
  stackModels,
  drain,
  repoWithAgent,
  pushTo,
  events,
  SETUP_CHECKS,
  USAGE,
  MUST,
} from './helpers/stacking';

/** An agent Clef says isn't needed: reviews raise no findings, so Approvals counts only stack entries. */
const notNeeded = agentModels({ probabilities: { secagent: 0 } }).models;

describe('stack gate', () => {
  it('holds auto-merge until discovery has checked the PR', async () => {
    const { t, open } = await repoWithAgent(true);
    const db = drizzle(t.env.DB, { schema });
    const { models } = stackModels();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await approveReviewOf(t, 1);
    const state = () =>
      t.env.DB.prepare(
        'SELECT state FROM pull_requests WHERE number = 1'
      ).first<{ state: string }>();
    expect((await state())!.state).toBe('open'); // clean review, but not yet checked against #2
    const run = t.actions.resolutions.find(
      (r) => (r.params as { stack?: StackParams }).stack
    )!;
    await executeStacking(
      { env: t.env, db, step, models },
      (run.params as { stack: StackParams }).stack
    );
    expect((await state())!.state).toBe('merged');
  });

  it('refuses to land a PR that must account for another, naming it', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    const res = await call(t, '/api/repos/octocat/app/pulls/2/merge', {
      cookie: admin,
      json: { approve: true },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /Must account for #1 first/
    );
    const d = (await (
      await call(t, '/api/repos/octocat/app/pulls/2', { cookie: admin })
    ).json()) as {
      review: { autoMerge: { state: string; reasons: string[] } };
    };
    expect(d.review.autoMerge.state).toBe('blocked');
    expect(d.review.autoMerge.reasons.join('\n')).toMatch(
      /Must account for #1 first/
    );
  });

  it('blocks on a landed prerequisite without retargeting', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = stackModels({
      related: () => true,
      relation: (i) =>
        i.a.landed
          ? MUST
          : { ...MUST, kind: 'independent', prerequisite: null },
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await drain(t, models);
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/1/merge', {
          cookie: admin,
          json: { approve: true },
        })
      ).status
    ).toBe(200);
    await drain(t, models);
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    expect(
      await t.env.DB.prepare(
        'SELECT base_ref AS baseRef FROM pull_requests WHERE number = 2'
      ).first()
    ).toEqual({ baseRef: 'main' });
    const res = await call(t, '/api/repos/octocat/app/pulls/2/merge', {
      cookie: admin,
      json: { approve: true },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/#1/);
  });

  it('when the tree can’t be read: the PR page waits, merging refuses', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = stackModels();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    await t.env.DB.prepare("UPDATE pr_edges SET files = '{broken'").run();
    const res = await call(t, '/api/repos/octocat/app/pulls/2', {
      cookie: admin,
    });
    expect(res.status).toBe(200);
    const d = (await res.json()) as {
      stack: unknown;
      review: { autoMerge: { state: string; reasons: string[] } };
    };
    expect(d.stack).toBeNull();
    expect(d.review.autoMerge.state).toBe('waiting');
    expect(d.review.autoMerge.reasons.join('\n')).toMatch(
      /Couldn’t check how it relates/
    );
    const merge = await call(t, '/api/repos/octocat/app/pulls/2/merge', {
      cookie: admin,
      json: { approve: true },
    });
    expect(merge.status).toBe(409);
    expect(((await merge.json()) as { error: string }).error).toMatch(/stack/i);
  });

  it('never calls a PR Ready when its tree can’t be read, even without AI review', async () => {
    const { t, admin, open } = await repoWithAgent(false);
    const { models } = stackModels();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    await t.env.DB.prepare("UPDATE pr_edges SET files = '{broken'").run();
    // Approved, so the unreadable tree is all that holds them.
    for (const n of [1, 2])
      await call(t, `/api/repos/octocat/app/pulls/${n}/approval`, {
        cookie: admin,
        method: 'POST',
      });
    await settle(t);
    const db = drizzle(t.env.DB, { schema });
    const repoId = (await t.env.DB.prepare(
      "SELECT id FROM repositories WHERE name = 'app'"
    ).first<{ id: string }>())!.id;
    const found = await findRepoById(db, repoId);
    const prs = await db.query.pullRequests.findMany();
    const states = await pullStates(
      db,
      gitFor(t.env, found!.repo),
      repoId,
      prs,
      { reviewConfigured: false }
    );
    for (const p of prs)
      expect(states.get(p.id)).toEqual({
        state: 'waiting',
        reasons: [{ kind: 'stack_checking', prs: [] }],
      });
  });

  it('auto-merges the other side of a pair once a run checks it', async () => {
    const { t, open } = await repoWithAgent(true);
    const db = drizzle(t.env.DB, { schema });
    const { models } = stackModels();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await approveReviewOf(t, 1);
    const state = (n: number) =>
      t.env.DB.prepare('SELECT state FROM pull_requests WHERE number = ?')
        .bind(n)
        .first<{ state: string }>();
    expect((await state(1))!.state).toBe('open'); // held only by "checking"
    // #2's run (not #1's) checks the pair; #2 itself is still in review.
    const two = (await t.env.DB.prepare(
      'SELECT id FROM pull_requests WHERE number = 2'
    ).first<{ id: string }>())!.id;
    await executeStacking(
      { env: t.env, db, step, models },
      { pullRequestId: two }
    );
    expect((await state(1))!.state).toBe('merged');
    expect((await state(2))!.state).toBe('open');
  });

  it('lands once a must-account-for edge is dismissed', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    const refused = await call(t, '/api/repos/octocat/app/pulls/2/merge', {
      cookie: admin,
      json: { approve: true },
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(
      /Must account for #1 first/
    );
    await t.env.DB.prepare(
      "UPDATE pr_edges SET dismissed_at = ? WHERE kind = 'must_account_for'"
    )
      .bind(Math.floor(Date.now() / 1000))
      .run();
    const res = await call(t, '/api/repos/octocat/app/pulls/2/merge', {
      cookie: admin,
      json: { approve: true },
    });
    expect(res.status).toBe(200);
  });

  it('lands once a landed prerequisite is accounted for', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = stackModels({
      related: () => true,
      relation: (i) =>
        i.a.landed
          ? MUST
          : { ...MUST, kind: 'independent', prerequisite: null },
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await drain(t, models);
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/1/merge', {
          cookie: admin,
          json: { approve: true },
        })
      ).status
    ).toBe(200);
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    const refused = await call(t, '/api/repos/octocat/app/pulls/2/merge', {
      cookie: admin,
      json: { approve: true },
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).not.toMatch(
      /\.\./
    );
    await t.env.DB.prepare(
      "UPDATE pr_edges SET accounted_for_at = ? WHERE kind = 'must_account_for'"
    )
      .bind(Math.floor(Date.now() / 1000))
      .run();
    const res = await call(t, '/api/repos/octocat/app/pulls/2/merge', {
      cookie: admin,
      json: { approve: true },
    });
    expect(res.status).toBe(200);
  });
});

describe('retargeting', () => {
  const BUILDS_A: Relation = {
    kind: 'builds_on',
    prerequisite: 'a',
    reason: 'Builds on it.',
    instructions: null,
  };
  /** #3 builds on #1 and on #2; #1 and #2 are unrelated. */
  const three = (more: Parameters<typeof stackModels>[0] = {}) =>
    stackModels({
      related: (i) => !(i.a.number === 1 && i.b.number === 2),
      relation: () => BUILDS_A,
      ...more,
    });
  const bases = async (t: TestEnv) =>
    (
      await t.env.DB.prepare(
        'SELECT number, base_ref AS base FROM pull_requests ORDER BY number'
      ).all<{
        number: number;
        base: string;
      }>()
    ).results.map((r) => [r.number, r.base]);

  async function openThree(
    t: TestEnv,
    open: (
      b: string,
      c: Record<string, string>,
      title: string
    ) => Promise<number>
  ) {
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await open('three', { 'c.txt': 'c\n' }, 'Three');
  }

  it('linearizes #3’s prerequisites and stacks each on its parent', async () => {
    const { t, open } = await repoWithAgent();
    const { models, calls } = three();
    await openThree(t, open);
    await drain(t, models);
    expect(calls.ordered).toBe(1);
    expect(await bases(t)).toEqual([
      [1, 'main'],
      [2, 'one'],
      [3, 'two'],
    ]);
    expect(
      await t.env.DB.prepare(
        "SELECT kind, prerequisite, reason FROM pr_edges WHERE slot = 'order'"
      ).first()
    ).toEqual({
      kind: 'ordered_after',
      prerequisite: 'a',
      reason: '#2 lands after #1 so #3 can build on both.',
    });
    expect((await events(t, 2)).map((e) => e.kind)).toEqual(
      expect.arrayContaining(['ordered', 'stacked'])
    );
    expect((await events(t, 3)).at(-1)).toMatchObject({
      kind: 'stacked',
      data: { pr: 2, branch: 'two' },
    });
  });

  it('asks the later prerequisite to rebase first, then the dependent', async () => {
    const { t, open, repo, files } = await repoWithAgent();
    const { models } = three();
    await openThree(t, open);
    await drain(t, models);
    const db = drizzle(t.env.DB, { schema });
    const states = async () => {
      const repoId = (await t.env.DB.prepare(
        "SELECT id FROM repositories WHERE name = 'app'"
      ).first<{ id: string }>())!.id;
      const found = await findRepoById(db, repoId);
      const prs = await db.query.pullRequests.findMany();
      const map = await pullStates(db, gitFor(t.env, found!.repo), repoId, prs);
      return Object.fromEntries(prs.map((p) => [p.number, map.get(p.id)]));
    };
    let st = await states();
    expect(st[2]!.reasons).toContainEqual({
      kind: 'rebase_onto',
      pr: 1,
      branch: 'one',
      why: '#2 lands after #1 so #3 can build on both.',
    });
    expect(st[2]!.state).toBe('agent_followup');
    expect(st[3]!.reasons.map((r) => r.kind)).not.toContain('rebase_onto'); // #2 isn't on #1 yet
    // #2's agent rebases onto #1 (GitOrange never does): now #3 is asked to rebase onto #2.
    repo.refs.set('refs/heads/two', repo.refs.get('refs/heads/one')!);
    await pushTo(t, repo, 'two', { ...files, 'a.txt': 'a\n', 'b.txt': 'b\n' });
    await drain(t, models);
    st = await states();
    expect(st[2]!.reasons.map((r) => r.kind)).not.toContain('rebase_onto');
    expect(st[3]!.reasons).toContainEqual(
      expect.objectContaining({ kind: 'rebase_onto', pr: 2, branch: 'two' })
    );
  });

  it('reports rebase_onto in the PR detail for a stacked PR that lacks its parent', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = three();
    await openThree(t, open);
    await drain(t, models);
    const detail = (await (
      await call(t, '/api/repos/octocat/app/pulls/2', { cookie: admin })
    ).json()) as {
      pullState: { state: string; reasons: { kind: string; pr?: number }[] };
    };
    expect(detail.pullState.state).toBe('agent_followup');
    expect(detail.pullState.reasons).toContainEqual(
      expect.objectContaining({ kind: 'rebase_onto', pr: 1 })
    );
  });

  it('PR detail asks only the PR whose parent chain is in order, like the list', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = three();
    await openThree(t, open);
    await drain(t, models);
    const kinds = async (n: number) =>
      (
        (await (
          await call(t, `/api/repos/octocat/app/pulls/${n}`, { cookie: admin })
        ).json()) as { pullState: { reasons: { kind: string }[] } }
      ).pullState.reasons.map((r) => r.kind);
    expect(await kinds(2)).toContain('rebase_onto');
    expect(await kinds(3)).not.toContain('rebase_onto'); // #2 isn't on #1 yet
  });

  it('treats a failing ancestry check as unknown, and does not remember it', async () => {
    let fail = true;
    const git = {
      mergeBase: async () => {
        if (fail) throw new Error('boom');
        return 'anc-unknown-1';
      },
    } as unknown as Parameters<typeof contains>[0];
    expect(await contains(git, 'anc-unknown-1', 'desc-unknown-1')).toBeNull();
    fail = false;
    expect(await contains(git, 'anc-unknown-1', 'desc-unknown-1')).toBe(true);
  });

  // Two tests: each needs its own instance (the admin is bootstrapped once per test database).
  it('falls back when Clef is unsure: closer to Ready first', async () => {
    const { t, open, repo } = await repoWithAgent();
    const { models } = three({
      order: () => ({
        first: {
          type: 'choice',
          value: 'a',
          confidence: 0.2,
          probabilities: { a: 0.2 },
        },
      }),
    });
    await openThree(t, open);
    // #1 has a failed check (agent followup); #2 only waits: #2 is closer to Ready and goes first.
    await t.env.DB.prepare(
      `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title, status, conclusion, created_at)
       SELECT 'r1', id, 1, 'ci.yml', 'CI', 'pull_request', 'x', ?, 'x', 'completed', 'failure', 0 FROM repositories WHERE name = 'app'`
    )
      .bind(repo.refs.get('refs/heads/one'))
      .run();
    await drain(t, models);
    expect(await bases(t)).toEqual([
      [1, 'two'],
      [2, 'main'],
      [3, 'one'],
    ]);
  });

  it('falls back when Clef fails: equally close to Ready, the lower number first', async () => {
    const { t, open } = await repoWithAgent();
    const { models } = three({
      order: () => {
        throw new Error('Clef down');
      },
    });
    await openThree(t, open);
    await drain(t, models);
    expect(await bases(t)).toEqual([
      [1, 'main'],
      [2, 'one'],
      [3, 'two'],
    ]);
  });

  it('keeps an ordering until one of its three PRs moves', async () => {
    const { t, open, repo, files } = await repoWithAgent();
    const { models, calls } = three();
    await openThree(t, open);
    await drain(t, models);
    await drain(t, models);
    expect(calls.ordered).toBe(1);
    await pushTo(t, repo, 'three', { ...files, 'c.txt': 'c2\n' });
    await drain(t, models);
    expect(calls.ordered).toBe(2);
  });

  it('sends children back to the land target when their parent closes, then restacks them', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = three();
    await openThree(t, open);
    await drain(t, models);
    await call(t, '/api/repos/octocat/app/pulls/1', {
      cookie: admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    await settle(t);
    expect((await bases(t)).slice(1)).toEqual([
      [2, 'main'],
      [3, 'two'],
    ]);
    expect((await events(t, 2)).at(-1)).toMatchObject({
      kind: 'unstacked',
      data: { pr: 1 },
    });
    expect(
      await t.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM pr_edges WHERE slot = 'order'"
      ).first()
    ).toEqual({ n: 0 });
    expect(
      t.actions.resolutions.some(
        (r) => (r.params as { reconcile?: unknown }).reconcile
      )
    ).toBe(true);
    await drain(t, models);
    expect((await bases(t)).slice(1)).toEqual([
      [2, 'main'],
      [3, 'two'],
    ]);
  });

  it('restacks a reopened pull request', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = three();
    await openThree(t, open);
    await drain(t, models);
    const setState = (state: string) =>
      call(t, '/api/repos/octocat/app/pulls/1', {
        cookie: admin,
        method: 'PATCH',
        json: { state },
      });
    await setState('closed');
    await drain(t, models);
    expect((await bases(t)).slice(1)).toEqual([
      [2, 'main'],
      [3, 'two'],
    ]);
    expect((await setState('open')).status).toBe(200);
    await drain(t, models);
    expect(await bases(t)).toEqual([
      [1, 'main'],
      [2, 'one'],
      [3, 'two'],
    ]);
  });

  it('never stacks onto a branch that no longer exists', async () => {
    const { t, open, repo } = await repoWithAgent();
    const { models } = stackModels({
      related: () => true,
      relation: () => BUILDS_A,
    });
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    expect(await bases(t)).toEqual([
      [1, 'main'],
      [2, 'one'],
    ]);
    repo.refs.delete('refs/heads/one');
    const db = drizzle(t.env.DB, { schema });
    const repoId = (await t.env.DB.prepare(
      "SELECT id FROM repositories WHERE name = 'app'"
    ).first<{ id: string }>())!.id;
    await executeReconcile(
      { env: t.env, db, step, models },
      { repositoryId: repoId, landTarget: 'main' }
    );
    expect((await bases(t))[1]).toEqual([2, 'main']);
  });

  it('retargets once when reconciles repeat or race', async () => {
    const { t, open } = await repoWithAgent();
    const { models } = stackModels({
      related: () => true,
      relation: () => BUILDS_A,
    });
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    const db = drizzle(t.env.DB, { schema });
    const repoId = (await t.env.DB.prepare(
      "SELECT id FROM repositories WHERE name = 'app'"
    ).first<{ id: string }>())!.id;
    const params = { repositoryId: repoId, landTarget: 'main' };
    // Repeated: nothing left to change.
    expect(
      await executeReconcile({ env: t.env, db, step, models }, params)
    ).toBe(0);
    // Racing: #2 is back on main; both runs decide to stack it, one changes it.
    await t.env.DB.prepare(
      "UPDATE pull_requests SET base_ref = 'main' WHERE number = 2"
    ).run();
    const stacked = async () =>
      (await events(t, 2)).filter((e) => e.kind === 'stacked').length;
    const before = await stacked();
    const [x, y] = await Promise.all([
      executeReconcile({ env: t.env, db, step, models }, params),
      executeReconcile({ env: t.env, db, step, models }, params),
    ]);
    expect(x + y).toBe(1);
    expect(await stacked()).toBe(before + 1);
    expect((await bases(t))[1]).toEqual([2, 'one']);
  });

  it('drops an ordering edge once a side is no longer a stackable prerequisite', async () => {
    const { t, open } = await repoWithAgent();
    const { models } = three();
    await openThree(t, open);
    await drain(t, models);
    await t.env.DB.prepare(
      `UPDATE pr_edges SET dismissed_at = 1 WHERE slot = 'pair'
         AND pr_a_id = (SELECT id FROM pull_requests WHERE number = 2)
         AND pr_b_id = (SELECT id FROM pull_requests WHERE number = 3)`
    ).run();
    const db = drizzle(t.env.DB, { schema });
    const repoId = (await t.env.DB.prepare(
      "SELECT id FROM repositories WHERE name = 'app'"
    ).first<{ id: string }>())!.id;
    await executeReconcile(
      { env: t.env, db, step, models },
      { repositoryId: repoId, landTarget: 'main' }
    );
    expect(
      await t.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM pr_edges WHERE slot = 'order'"
      ).first()
    ).toEqual({ n: 0 });
    expect(await bases(t)).toEqual([
      [1, 'main'],
      [2, 'main'],
      [3, 'one'],
    ]);
  });

  it('keeps PR text out of the load step’s result', async () => {
    const { t, open } = await repoWithAgent();
    const { models } = three();
    await openThree(t, open);
    await drain(t, models);
    const results = new Map<string, unknown>();
    const recording = {
      do: async (name: string, a: unknown, b?: unknown) => {
        const out = await ((b ?? a) as () => Promise<unknown>)();
        results.set(name, out);
        return out;
      },
    } as unknown as StepRunner;
    const repoId = (await t.env.DB.prepare(
      "SELECT id FROM repositories WHERE name = 'app'"
    ).first<{ id: string }>())!.id;
    await executeReconcile(
      {
        env: t.env,
        db: drizzle(t.env.DB, { schema }),
        step: recording,
        models,
      },
      { repositoryId: repoId, landTarget: 'main' }
    );
    const load = results.get('reconcile:load') as {
      prs: Record<string, unknown>[];
    };
    expect(load.prs).toHaveLength(3);
    for (const pr of load.prs)
      expect(Object.keys(pr).sort()).toEqual([
        'baseRef',
        'head',
        'headRef',
        'id',
        'number',
      ]);
    expect(JSON.stringify(load)).not.toMatch(/One\.|Changes /);
  });

  it('orders by a conflict without asking Clef, and stacks #3 on a line that holds both', async () => {
    const { t, open } = await repoWithAgent();
    // #3 builds on #1 and #2; #2 conflicts with #1 and lands after it.
    const { models, calls } = stackModels({
      related: () => true,
      relation: (i) =>
        i.a.number === 1 && i.b.number === 2 ? CONFLICT : BUILDS_A,
    });
    await openThree(t, open);
    await drain(t, models);
    expect(calls.ordered).toBe(0);
    expect(
      await t.env.DB.prepare(
        "SELECT kind, prerequisite FROM pr_edges WHERE slot = 'order'"
      ).first()
    ).toEqual({ kind: 'ordered_after', prerequisite: 'a' });
    expect(await bases(t)).toEqual([
      [1, 'main'],
      [2, 'one'],
      [3, 'two'],
    ]);
  });

  it('keeps an ordering parent unstacked after Unstack, also when heads move', async () => {
    const { t, admin, open, repo, files } = await repoWithAgent();
    const { models, calls } = three();
    await openThree(t, open);
    await drain(t, models);
    expect(await bases(t)).toEqual([
      [1, 'main'],
      [2, 'one'],
      [3, 'two'],
    ]);
    const res = await call(t, '/api/repos/octocat/app/pulls/2/stack/unstack', {
      cookie: admin,
      method: 'POST',
    });
    expect(res.status).toBe(200);
    await drain(t, models);
    // #2 stays on main; #3 can't stack on one line any more, so it waits on both.
    expect(await bases(t)).toEqual([
      [1, 'main'],
      [2, 'main'],
      [3, 'main'],
    ]);
    const ordered = calls.ordered;
    await pushTo(t, repo, 'two', { ...files, 'b.txt': 'b2\n' });
    await drain(t, models);
    expect((await bases(t))[1]).toEqual([2, 'main']);
    expect(calls.ordered).toBe(ordered);
    const node = (
      (await (
        await call(t, '/api/repos/octocat/app/pulls/3', { cookie: admin })
      ).json()) as { stack: { parent: unknown; waitsOn: { number: number }[] } }
    ).stack;
    expect(node.parent).toBeNull();
    expect(node.waitsOn.map((d) => d.number)).toEqual([1, 2]);
  });

  it('auto-merging a parent sends its stacked child to main, then deletes the parent’s branch', async () => {
    const { t, admin, open, repo } = await repoWithAgent(true);
    const { models } = stackModels({
      related: () => true,
      relation: () => BUILDS_A,
    });
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    // A person approves #1: review is satisfied, so auto-merge lands it.
    await call(t, '/api/repos/octocat/app/pulls/1/approval', {
      cookie: admin,
      method: 'POST',
    });
    await drain(t, models);
    expect(
      await t.env.DB.prepare(
        'SELECT number, state, base_ref AS base FROM pull_requests ORDER BY number'
      ).all()
    ).toMatchObject({
      results: [
        { number: 1, state: 'merged' },
        { number: 2, base: 'main' },
      ],
    });
    expect(repo.refs.has('refs/heads/one')).toBe(false);
  });

  it('skips the inline reconcile when a stack run claims nothing', async () => {
    const { t, open } = await repoWithAgent();
    const { models } = three();
    await openThree(t, open);
    await drain(t, models);
    const names: string[] = [];
    const recording = {
      do: async (name: string, a: unknown, b?: unknown) => {
        names.push(name);
        return ((b ?? a) as () => Promise<unknown>)();
      },
    } as unknown as StepRunner;
    const pr = (await t.env.DB.prepare(
      'SELECT id FROM pull_requests WHERE number = 3'
    ).first<{ id: string }>())!.id;
    await executeStacking(
      {
        env: t.env,
        db: drizzle(t.env.DB, { schema }),
        step: recording,
        models,
      },
      { pullRequestId: pr }
    );
    expect(names.some((n) => n.startsWith('stack-reconcile:'))).toBe(false);
    expect(names.at(-1)).toBe('auto-merge');
  });

  it('reconciles a target with more open pull requests than D1 binds in one statement', async () => {
    const { t, open, repo } = await repoWithAgent();
    const { models } = three();
    await openThree(t, open);
    await drain(t, models);
    const repoId = (await t.env.DB.prepare(
      "SELECT id FROM repositories WHERE name = 'app'"
    ).first<{ id: string }>())!.id;
    // 60 more open PRs (no pairs yet) and a pair row between two landed ones.
    const main = repo.refs.get('refs/heads/main')!;
    for (let n = 4; n < 64; n++) {
      repo.refs.set(`refs/heads/b${n}`, main);
      await t.env.DB.prepare(
        `INSERT INTO pull_requests (id, repository_id, number, title, body, author_id, base_ref, land_target, head_ref, state, created_at, updated_at)
         SELECT 'p${n}', ?, ${n}, 'T', '', author_id, 'main', 'main', 'b${n}', ?, 0, 0 FROM pull_requests WHERE number = 1`
      )
        .bind(repoId, n < 62 ? 'open' : 'merged')
        .run();
    }
    await t.env.DB.prepare(
      `INSERT INTO pr_edges (id, repository_id, land_target, pr_a_id, pr_b_id, a_head, b_head, stage, kind, prerequisite, created_at, updated_at)
       VALUES ('landed-pair', ?, 'main', 'p62', 'p63', 'x', 'y', 'done', 'builds_on', 'a', 0, 0)`
    )
      .bind(repoId)
      .run();
    await executeReconcile(
      { env: t.env, db: drizzle(t.env.DB, { schema }), step, models },
      { repositoryId: repoId, landTarget: 'main' }
    );
    expect((await bases(t)).slice(0, 3)).toEqual([
      [1, 'main'],
      [2, 'one'],
      [3, 'two'],
    ]);
  });

  it('runs a stack run’s auto-merge step even when its reconcile fails', async () => {
    const { t, open } = await repoWithAgent();
    const { models } = three();
    await openThree(t, open);
    await drain(t, models);
    // Forget #3's pairs, so its run claims them again (a run that claims nothing doesn't reconcile).
    await t.env.DB.prepare(
      "DELETE FROM pr_edges WHERE slot = 'pair' AND pr_b_id = (SELECT id FROM pull_requests WHERE number = 3)"
    ).run();
    const names: string[] = [];
    const failing = {
      do: async (name: string, a: unknown, b?: unknown) => {
        names.push(name);
        if (name.startsWith('stack-reconcile:'))
          throw new Error('reconcile down');
        return ((b ?? a) as () => Promise<unknown>)();
      },
    } as unknown as StepRunner;
    const pr = (await t.env.DB.prepare(
      'SELECT id FROM pull_requests WHERE number = 3'
    ).first<{ id: string }>())!.id;
    await executeStacking(
      {
        env: t.env,
        db: drizzle(t.env.DB, { schema }),
        step: failing,
        models,
      },
      { pullRequestId: pr }
    );
    expect(names).toContain('stack-reconcile:load');
    expect(names.at(-1)).toBe('auto-merge');
  });
});

describe('maintainer controls', () => {
  it('unstacks and dismisses with merge permission only', async () => {
    const { t, admin, open } = await repoWithAgent(true, 'internal');
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    expect(
      await t.env.DB.prepare(
        'SELECT base_ref AS b FROM pull_requests WHERE number = 2'
      ).first()
    ).toEqual({ b: 'setup' });
    const bob = await addMember(t, admin, 'bob'); // can read the internal repo, can't merge
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/2/stack/unstack', {
          cookie: bob,
          method: 'POST',
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/2/stack/unstack', {
          cookie: admin,
          method: 'POST',
        })
      ).status
    ).toBe(200);
    await settle(t);
    expect(
      await t.env.DB.prepare(
        'SELECT base_ref AS b FROM pull_requests WHERE number = 2'
      ).first()
    ).toEqual({ b: 'main' });
    const ev = await events(t, 2);
    expect(ev.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['dismissed', 'unstacked'])
    );
    // Restacking leaves it alone, and the dismissed must-account-for no longer blocks landing.
    await drain(t, models);
    expect(
      await t.env.DB.prepare(
        'SELECT base_ref AS b FROM pull_requests WHERE number = 2'
      ).first()
    ).toEqual({ b: 'main' });
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/2/merge', {
          cookie: admin,
          json: { approve: true },
        })
      ).status
    ).toBe(200);
  });

  it('dismisses a waits-on edge', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = stackModels();
    await open('one', { 'notes.txt': 'one\nTWO\nthree\n' }, 'One');
    await open('two', { 'notes.txt': 'one\n2\nthree\n' }, 'Two');
    await drain(t, models);
    const before = (await (
      await call(t, '/api/repos/octocat/app/pulls/2', { cookie: admin })
    ).json()) as {
      stack: { waitsOn: { number: number }[] };
    };
    expect(before.stack.waitsOn.map((d) => d.number)).toEqual([1]);
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/2/stack/dismiss', {
          cookie: admin,
          json: { pr: 1 },
        })
      ).status
    ).toBe(200);
    const after = (await (
      await call(t, '/api/repos/octocat/app/pulls/2', { cookie: admin })
    ).json()) as {
      stack: { waitsOn: unknown[] };
    };
    expect(after.stack.waitsOn).toEqual([]);
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/2/stack/dismiss', {
          cookie: admin,
          json: { pr: 9 },
        })
      ).status
    ).toBe(404);
  });

  it('unstack finishes a retarget a crashed attempt left behind', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    await t.env.DB.prepare(
      'UPDATE pr_edges SET dismissed_at = 1, dismissed_by_id = NULL'
    ).run();
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/2/stack/unstack', {
          cookie: admin,
          method: 'POST',
        })
      ).status
    ).toBe(200);
    expect(
      await t.env.DB.prepare(
        'SELECT base_ref AS b FROM pull_requests WHERE number = 2'
      ).first()
    ).toEqual({ b: 'main' });
    expect((await events(t, 2)).map((e) => e.kind)).toContain('unstacked');
  });

  it('refuses to unstack an unstacked PR, and hides a private repo', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = stackModels();
    await open('one', { 'notes.txt': 'one\nTWO\nthree\n' }, 'One');
    await drain(t, models);
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/1/stack/unstack', {
          cookie: admin,
          method: 'POST',
        })
      ).status
    ).toBe(400);
    const bob = await addMember(t, admin, 'bob');
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/1/stack/unstack', {
          cookie: bob,
          method: 'POST',
        })
      ).status
    ).toBe(404);
  });

  it('ends a dismissal when a side lands', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models, calls } = stackModels({
      related: () => true,
      relation: () => MUST,
      recheck: () => ({
        accounted: true,
        reason: 'Adds the check.',
        instructions: null,
      }),
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    const dismiss = await call(
      t,
      '/api/repos/octocat/app/pulls/2/stack/dismiss',
      {
        cookie: admin,
        json: { pr: 1 },
      }
    );
    expect(dismiss.status).toBe(200);
    const merge = (n: number) =>
      call(t, `/api/repos/octocat/app/pulls/${n}/merge`, {
        cookie: admin,
        json: { approve: true },
      });
    expect((await merge(1)).status).toBe(200);
    await drain(t, models);
    expect(
      await t.env.DB.prepare(
        "SELECT dismissed_at AS d, dismissed_by_id AS by FROM pr_edges WHERE slot = 'pair'"
      ).first()
    ).toEqual({ d: null, by: null });
    // #1 landed: #2 must account for it again, so the sweep's run re-checks #2's head; it passes, so #2 lands.
    expect(calls.rechecked).toHaveLength(1);
    expect(calls.rechecked[0].prerequisite.number).toBe(1);
    expect((await merge(2)).status).toBe(200);
  });

  it('keeps a dismissal when a head moves', async () => {
    const { t, admin, open, repo, files } = await repoWithAgent();
    const { models } = stackModels();
    await open('one', { 'notes.txt': 'one\nTWO\nthree\n' }, 'One');
    await open('two', { 'notes.txt': 'one\n2\nthree\n' }, 'Two');
    await drain(t, models);
    await call(t, '/api/repos/octocat/app/pulls/2/stack/dismiss', {
      cookie: admin,
      json: { pr: 1 },
    });
    await pushTo(t, repo, 'two', { ...files, 'notes.txt': 'one\n22\nthree\n' });
    await drain(t, models);
    expect(
      (await t.env.DB.prepare(
        "SELECT dismissed_at AS d FROM pr_edges WHERE slot = 'pair'"
      ).first<{ d: number | null }>())!.d
    ).not.toBeNull();
  });
});

describe('stack surfaces', () => {
  it('lists stale must-account-for blocks and failed pairs on Approvals', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models, step, notNeeded);
    await t.env.DB.prepare('UPDATE pr_edges SET updated_at = 0').run();
    const items = (
      (await (await call(t, '/api/approvals', { cookie: admin })).json()) as {
        items: {
          pull: { number: number };
          stackStale: { pr: number }[];
          stackUnchecked: number[];
        }[];
      }
    ).items;
    expect(items.find((i) => i.pull.number === 2)).toMatchObject({
      stackStale: [{ pr: 1 }],
      stackUnchecked: [],
    });
  });

  it('drops a stale block on Approvals once its prerequisite is closed without landing', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models, step, notNeeded);
    await t.env.DB.prepare(
      "UPDATE pull_requests SET state = 'closed' WHERE number = 1"
    ).run();
    await t.env.DB.prepare('UPDATE pr_edges SET updated_at = 0').run();
    const items = (
      (await (await call(t, '/api/approvals', { cookie: admin })).json()) as {
        items: { pull: { number: number }; stackStale: { pr: number }[] }[];
      }
    ).items;
    expect(items.find((i) => i.pull.number === 2)?.stackStale ?? []).toEqual(
      []
    );
  });

  it('shows stack events on the PR', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    const d = (await (
      await call(t, '/api/repos/octocat/app/pulls/2', { cookie: admin })
    ).json()) as {
      events: { kind: string }[];
      stack: { mustAccountFor: { accounted: boolean }[] };
    };
    expect(d.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['must_account_for', 'stacked'])
    );
    expect(d.stack.mustAccountFor).toMatchObject([{ accounted: false }]);
  });
});

describe('stack surfaces on Approvals', () => {
  type Item = {
    pull: { number: number };
    stackStale: { pr: number }[];
    stackUnchecked: number[];
    pullState: { state: string } | null;
  };
  const approvals = async (t: TestEnv, admin: string) =>
    (await (
      await call(t, '/api/approvals?limit=100', { cookie: admin })
    ).json()) as {
      items: Item[];
      count: number;
    };

  it('lists a failed pair on both sides, and counts each entry once', async () => {
    const { t, admin, open } = await repoWithAgent();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, stackModels({ failTriage: true }).models, step, notNeeded);
    const { items, count } = await approvals(t, admin);
    expect(items.find((i) => i.pull.number === 1)).toMatchObject({
      stackUnchecked: [2],
      stackStale: [],
    });
    expect(items.find((i) => i.pull.number === 2)).toMatchObject({
      stackUnchecked: [1],
      stackStale: [],
    });
    // One entry per pull request, however many pairs failed; no extra human_review item.
    expect(count).toBe(2);
  });

  it('counts a stale block and an unchecked pair separately, without a second human_review entry', async () => {
    const { t, admin, open } = await repoWithAgent();
    const must = stackModels({ related: () => true, relation: () => MUST });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, must.models, step, notNeeded);
    await open('third', { 'c.txt': 'c\n' }, 'Third');
    await drain(t, stackModels({ failTriage: true }).models, step, notNeeded);
    await t.env.DB.prepare(
      "UPDATE pr_edges SET updated_at = 0 WHERE stage = 'done'"
    ).run();
    const { items, count } = await approvals(t, admin);
    const two = items.find((i) => i.pull.number === 2)!;
    expect(two.stackStale).toMatchObject([{ pr: 1 }]);
    expect(two.stackUnchecked).toEqual([3]);
    expect(items.find((i) => i.pull.number === 3)!.stackUnchecked).toEqual([
      1, 2,
    ]);
    // #2: stale + unchecked = 2; #1 and #3: unchecked = 1 each. A human_review state adds nothing on top.
    expect(count).toBe(4);
  });

  it('finds stack entries past the first 90 open pull requests', async () => {
    const { t, admin, open } = await repoWithAgent();
    const must = stackModels({ related: () => true, relation: () => MUST });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, must.models, step, notNeeded);
    await t.env.DB.prepare('UPDATE pr_edges SET updated_at = 0').run();
    const row = (await t.env.DB.prepare(
      'SELECT * FROM pull_requests WHERE number = 1'
    ).first<Record<string, unknown>>())!;
    const cols = Object.keys(row);
    const insert = t.env.DB.prepare(
      `INSERT INTO pull_requests (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    );
    // Newer than #1 and #2, so they sort first and push the stack pair into the second chunk.
    const fillers = Array.from({ length: 100 }, (_, i) => {
      const v = {
        ...row,
        id: `filler-${i}`,
        number: 100 + i,
        head_ref: `filler-${i}`,
        updated_at: 4_000_000_000 + i,
      };
      return insert.bind(...cols.map((c) => v[c as keyof typeof v]));
    });
    await t.env.DB.batch(fillers);
    const { items } = await approvals(t, admin);
    expect(items.find((i) => i.pull.number === 2)).toMatchObject({
      stackStale: [{ pr: 1 }],
    });
  });
});
