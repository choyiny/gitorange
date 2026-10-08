// Stacking: discovery, the stack API, and must-account-for re-checks. Fixtures: helpers/stacking.ts.
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import type { StepRunner } from '../merge/resolution';
import { startSweep } from '../merge/auto';
import type { Repository } from '../db/app.schema';
import { executeStacking, type StackParams } from '../stack/discover';
import { executeReconcile } from '../stack/reconcile';
import { recordEvent } from '../pulls/events';
import type { Relation } from '../stack/models';
import { addMember, call, settle } from './helpers/app';
import { commitPaths } from './helpers/seed';
import { runReviews } from './helpers/reviews';
import {
  step,
  holdReviews,
  stackModels,
  ran,
  drain,
  repoWithAgent,
  pushTo,
  events,
  edges,
  SETUP_CHECKS,
  USAGE,
  MUST,
} from './helpers/stacking';

describe('stacking discovery', () => {
  it('finds that #2 must account for #1 (the #28/#29 case)', async () => {
    const { t, open } = await repoWithAgent();
    const { models, calls } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    expect(await open('setup', SETUP_CHECKS, 'Setup checks')).toBe(1);
    expect(await open('usage', USAGE, 'Usage and cost')).toBe(2);
    await drain(t, models);
    expect(await edges(t)).toMatchObject([
      {
        a: 1,
        b: 2,
        stage: 'done',
        kind: 'must_account_for',
        prerequisite: 'a',
        instructions: MUST.instructions,
      },
    ]);
    // Clef saw both PRs' one-liners; the reasoning model read the real diffs.
    const triage = calls.triaged.at(-1)!;
    expect(triage.a.summaries).toContain('src/setup-checks.ts');
    expect(triage.b.summaries).toContain('src/usage.ts');
    expect(triage.sharedFiles).toEqual([]);
    expect(calls.related.at(-1)!.a.diffs).toContain('export const checks');
  });

  it('treats a textual conflict as related even when Clef says unrelated', async () => {
    const { t, open } = await repoWithAgent();
    const { models, calls } = stackModels();
    await open('one', { 'notes.txt': 'one\nTWO\nthree\n' }, 'One');
    await open('two', { 'notes.txt': 'one\n2\nthree\n' }, 'Two');
    await drain(t, models);
    expect(calls.triaged.at(-1)!.conflicts).toEqual(['notes.txt']);
    expect(calls.related.at(-1)!.conflicts).toEqual(['notes.txt']);
    expect(await edges(t)).toMatchObject([
      { a: 1, b: 2, kind: 'conflicts', prerequisite: 'a' },
    ]);
  });

  // Split in two: each needs its own instance (the admin is bootstrapped once per test database).
  const BUILDS: Relation = {
    kind: 'builds_on',
    prerequisite: 'a',
    reason: 'Uses what #1 adds.',
    instructions: null,
  };

  it('keeps Clef’s confident decision; the reasoning model only writes the reason', async () => {
    const sure = await repoWithAgent();
    const confident = stackModels({
      related: () => true,
      relation: () => BUILDS,
      explainAs: MUST,
    });
    await sure.open('one', { 'a.txt': 'a\n' }, 'One');
    await sure.open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(sure.t, confident.models);
    expect(confident.calls.related.at(-1)!.decided).toEqual({
      kind: 'builds_on',
      prerequisite: 'a',
    });
    expect(await edges(sure.t)).toMatchObject([
      { kind: 'builds_on', reason: MUST.reason },
    ]);
  });

  it('lets the reasoning model decide only when Clef is unsure', async () => {
    const unsure = await repoWithAgent();
    const hesitant = stackModels({
      related: () => true,
      relation: () => BUILDS,
      confidence: 0.4,
      explainAs: MUST,
    });
    await unsure.open('one', { 'a.txt': 'a\n' }, 'One');
    await unsure.open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(unsure.t, hesitant.models);
    expect(hesitant.calls.related.at(-1)!.decided).toBeNull();
    expect(await edges(unsure.t)).toMatchObject([
      { kind: 'must_account_for', instructions: MUST.instructions },
    ]);
  });

  it('records unrelated pairs as independent without a deep dive', async () => {
    const { t, open } = await repoWithAgent();
    const { models, calls } = stackModels();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    expect(calls.related).toEqual([]);
    expect(await edges(t)).toMatchObject([
      { a: 1, b: 2, stage: 'done', kind: 'independent', prerequisite: null },
    ]);
  });

  it('re-checks a pair only when a head moves', async () => {
    const { t, open, repo, files } = await repoWithAgent();
    const { models, calls } = stackModels();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    const before = calls.triaged.length;
    expect(before).toBe(1);
    // Draining again with nothing new re-checks nothing.
    await drain(t, models);
    expect(calls.triaged.length).toBe(before);
    // A push to #2's branch, then the sweep a push starts: the pair is checked again at the new head.
    await commitPaths(repo, 'two', { ...files, 'b.txt': 'b2\n' }, 'More');
    const row = await t.env.DB.prepare(
      "SELECT id FROM repositories WHERE name = 'app'"
    ).first<{ id: string }>();
    await startSweep(t.env, { id: row!.id } as Repository, [
      {
        ref: 'refs/heads/two',
        old: '0'.repeat(40),
        new: repo.refs.get('refs/heads/two')!,
      },
    ]);
    await drain(t, models);
    expect(calls.triaged.length).toBe(before + 1);
  });

  it('never lets a stale run overwrite a pair a newer run re-claimed', async () => {
    const { t, open } = await repoWithAgent();
    const db = drizzle(t.env.DB, { schema });
    const newer = 'f'.repeat(40);
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    const explain = models.explain;
    // While this run explains, a newer run re-claims the pair at a newer head of #2 and finishes it.
    models.explain = async (i) => {
      await t.env.DB.prepare(
        "UPDATE pr_edges SET b_head = ?, stage = 'done', kind = 'conflicts', reason = 'Newer run.'"
      )
        .bind(newer)
        .run();
      return explain(i);
    };
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    // Run the reviews, then only #1's stack run (the stale one).
    await runReviews(t, holdReviews);
    const run = t.actions.resolutions.find(
      (r) => (r.params as { stack?: StackParams }).stack
    )!;
    await executeStacking(
      { env: t.env, db, step, models },
      (run.params as { stack: StackParams }).stack
    );
    const row = await t.env.DB.prepare(
      'SELECT b_head AS bHead, stage, kind, reason FROM pr_edges'
    ).first();
    expect(row).toEqual({
      bHead: newer,
      stage: 'done',
      kind: 'conflicts',
      reason: 'Newer run.',
    });
  });

  it('marks a pair failed when a model fails, and never blocks others', async () => {
    const { t, open } = await repoWithAgent();
    const { models } = stackModels({ failTriage: true });
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    expect(await edges(t)).toMatchObject([{ a: 1, b: 2, stage: 'failed' }]);
  });

  it('finds a dependency on a PR that already landed', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models, calls } = stackModels({
      related: () => true,
      relation: (i) =>
        i.a.landed
          ? MUST
          : { ...MUST, kind: 'independent', prerequisite: null },
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await drain(t, models);
    const merged = await call(t, '/api/repos/octocat/app/pulls/1/merge', {
      cookie: admin,
      json: { approve: true },
    });
    expect(merged.status).toBe(200);
    await drain(t, models);
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    expect(calls.related.at(-1)!.a).toMatchObject({ number: 1, landed: true });
    expect(await edges(t)).toMatchObject([
      { a: 1, b: 2, kind: 'must_account_for', prerequisite: 'a' },
    ]);
  });

  it('never lets a run that loaded before a landing undo the landed orientation', async () => {
    const { t, open } = await repoWithAgent();
    const db = drizzle(t.env.DB, { schema });
    const { models } = stackModels();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    const ids = (
      await t.env.DB.prepare(
        'SELECT id FROM pull_requests ORDER BY number'
      ).all<{
        id: string;
      }>()
    ).results.map((r) => r.id);
    // As #1's run claims the pair, #2 has landed and a newer run stored the pair the other way round.
    const racing = {
      do: async (name: string, a: unknown, b?: unknown) => {
        if (name.startsWith('claim:'))
          await t.env.DB.prepare(
            "UPDATE pr_edges SET pr_a_id = ?, pr_b_id = ?, kind = 'builds_on', prerequisite = 'a', reason = 'Landed.'"
          )
            .bind(ids[1], ids[0])
            .run();
        return ((b ?? a) as () => Promise<unknown>)();
      },
    } as unknown as StepRunner;
    await executeStacking(
      { env: t.env, db, step: racing, models },
      { pullRequestId: ids[0] }
    );
    expect(await edges(t)).toMatchObject([
      { a: 2, b: 1, kind: 'builds_on', reason: 'Landed.' },
    ]);
  });

  it('keeps one row per pair when the higher-numbered PR lands first', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = stackModels({
      related: () => true,
      relation: (i) => (i.a.landed ? BUILDS : { ...BUILDS, prerequisite: 'b' }),
    });
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    expect(await edges(t)).toMatchObject([{ a: 1, b: 2 }]);
    const merged = await call(t, '/api/repos/octocat/app/pulls/2/merge', {
      cookie: admin,
      json: { approve: true },
    });
    expect(merged.status).toBe(200);
    await drain(t, models);
    expect(await edges(t)).toMatchObject([
      { a: 2, b: 1, stage: 'done', kind: 'builds_on', prerequisite: 'a' },
    ]);
    expect(await edges(t)).toHaveLength(1);
  });

  it('keeps each side small enough for a Workflow step result', async () => {
    const { t, open } = await repoWithAgent();
    const { models, calls } = stackModels();
    const many: Record<string, string> = {};
    for (let i = 0; i < 2000; i++)
      many[`generated/file-${String(i).padStart(4, '0')}.txt`] = `${i}\n`;
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', many, 'Two');
    await t.env.DB.prepare('UPDATE pull_requests SET body = ? WHERE number = 2')
      .bind('x'.repeat(60 * 1024))
      .run();
    // Record each step's result size, as Workflows would.
    const sizes: number[] = [];
    const db = drizzle(t.env.DB, { schema });
    const measuring = {
      do: async (_name: string, a: unknown, b?: unknown) => {
        const out = await ((b ?? a) as () => Promise<unknown>)();
        sizes.push(JSON.stringify(out ?? null).length);
        return out;
      },
    } as unknown as StepRunner;
    await drain(t, models);
    calls.triaged.length = 0;
    await t.env.DB.prepare('DELETE FROM pr_edges').run();
    const id = (await t.env.DB.prepare(
      'SELECT id FROM pull_requests WHERE number = 1'
    ).first<{ id: string }>())!.id;
    await executeStacking(
      { env: t.env, db, step: measuring, models },
      { pullRequestId: id }
    );
    const b = calls.triaged.at(-1)!.b;
    expect(b.description.length).toBeLessThanOrEqual(4096);
    expect(b.summaries.length).toBeLessThanOrEqual(16 * 1024 + 100);
    expect(b.summaries).toMatch(/…and \d+ more files$/);
    expect(Math.max(...sizes)).toBeLessThan(64 * 1024);
    expect(await edges(t)).toMatchObject([
      { a: 1, b: 2, stage: 'done', kind: 'independent' },
    ]);
  });

  it('skips closed PRs and missing branches', async () => {
    const { t, admin, open, repo } = await repoWithAgent();
    const { models, calls } = stackModels();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    // Close #1 and delete #2's branch before any stack run executes.
    await call(t, '/api/repos/octocat/app/pulls/1', {
      method: 'PATCH',
      cookie: admin,
      json: { state: 'closed' },
    });
    repo.refs.delete('refs/heads/two');
    await drain(t, models);
    expect(calls.triaged).toEqual([]);
    expect(await edges(t)).toEqual([]);
  });

  it('caps triage at max_open, newest first, but still checks pairs that share a file', async () => {
    const { t, open } = await repoWithAgent();
    const { models, calls } = stackModels();
    await open('p1', { 'shared.txt': 'one\n' }, 'P1');
    await open('p2', { 'b.txt': 'b\n' }, 'P2');
    await open('p3', { 'shared.txt': 'three\n' }, 'P3');
    await drain(t, models, step, holdReviews, { max_open: 2 });
    const pairs = (await edges(t)).map((e) => `${e.a}-${e.b}`);
    // #3's run sees #2 (within the cap) and #1 (shares shared.txt), so both pairs exist.
    // #1's and #2's runs each see only #3 within the cap; neither shares a file with the other, so 1-2 is never checked.
    expect(pairs.sort()).toEqual(['1-3', '2-3']);
    expect(calls.related.some((r) => r.conflicts.includes('shared.txt'))).toBe(
      true
    );
  });

  it('runs without an agent, on paths, from the PR opens', async () => {
    const { t, open } = await repoWithAgent(false);
    const { models, calls } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    // No review ran (no agent is invited), so discovery started from the opens alone.
    expect(
      t.actions.resolutions.filter(
        (s) => (s.params as { headReview?: unknown }).headReview
      )
    ).toEqual([]);
    expect(await edges(t)).toMatchObject([
      { a: 1, b: 2, stage: 'done', kind: 'must_account_for' },
    ]);
    const triage = calls.triaged.at(-1)!;
    expect(triage.a.summaries).toBe(
      '- docs/configuration.md\n- src/setup-checks.ts'
    );
    expect(triage.b.summaries).toContain('- src/usage.ts');
  });
});

describe('stack API', () => {
  it('serves the tree and each PR’s place in it', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    const tree = await (
      await call(t, '/api/repos/octocat/app/pulls/tree', { cookie: admin })
    ).json();
    expect(tree).toMatchObject({
      targets: [
        {
          branch: 'main',
          nodes: [
            { number: 1, parent: null, children: [2], title: 'Setup checks' },
            {
              number: 2,
              parent: { number: 1, kind: 'must_account_for' },
              mustAccountFor: [{ number: 1, instructions: MUST.instructions }],
            },
          ],
        },
      ],
    });
    const detail = (await (
      await call(t, '/api/repos/octocat/app/pulls/2', { cookie: admin })
    ).json()) as { stack: { parent: { number: number } } };
    expect(detail.stack.parent.number).toBe(1);
  });

  it('does not count a closed, unmerged PR as landed', async () => {
    const { t, admin, open } = await repoWithAgent();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    const closed = await call(t, '/api/repos/octocat/app/pulls/1', {
      cookie: admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    expect(closed.status).toBe(200);
    const tree = (await (
      await call(t, '/api/repos/octocat/app/pulls/tree', { cookie: admin })
    ).json()) as {
      targets: {
        landed: unknown[];
        nodes: {
          number: number;
          parent: unknown;
          mustAccountFor: unknown[];
        }[];
      }[];
    };
    expect(tree.targets[0].landed).toEqual([]);
    const two = tree.targets[0].nodes.find((n) => n.number === 2)!;
    expect(two.parent).toBeNull();
    expect(two.mustAccountFor).toEqual([]);
  });

  it('serves the tree for a repository without an agent', async () => {
    const { t, admin, open } = await repoWithAgent(false);
    await open('one', { 'a.txt': 'a\n' }, 'One');
    const res = await call(t, '/api/repos/octocat/app/pulls/tree', {
      cookie: admin,
    });
    expect(await res.json()).toMatchObject({
      targets: [{ branch: 'main', nodes: [{ number: 1, title: 'One' }] }],
    });
    const detail = (await (
      await call(t, '/api/repos/octocat/app/pulls/1', { cookie: admin })
    ).json()) as { stack: unknown };
    expect(detail.stack).toMatchObject({ number: 1, parent: null });
  });

  it('serves a PR with more pairs than D1 binds in one statement', async () => {
    const { t, admin, open } = await repoWithAgent();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    const pr = (await t.env.DB.prepare(
      'SELECT id, repository_id AS repo, author_id AS author FROM pull_requests WHERE number = 1'
    ).first<{ id: string; repo: string; author: string }>())!;
    const now = Math.floor(Date.now() / 1000);
    const N = 120;
    const insertPr = t.env.DB.prepare(
      `INSERT INTO pull_requests (id, repository_id, number, title, body, author_id, base_ref, head_ref,
         state, merged_automatically, merged_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, 'main', ?, 'merged', 0, ?, ?, ?)`
    );
    const insertEdge = t.env.DB.prepare(
      `INSERT INTO pr_edges (id, repository_id, land_target, pr_a_id, pr_b_id, a_head, b_head, stage, kind,
         prerequisite, reason, instructions, files, created_at, updated_at)
       VALUES (?, ?, 'main', ?, ?, 'x', 'y', 'done', ?, 'a', 'r', ?, '[]', ?, ?)`
    );
    const stmts = [];
    for (let i = 0; i < N; i++)
      stmts.push(
        insertPr.bind(
          `l${i}`,
          pr.repo,
          100 + i,
          `Landed ${i}`,
          pr.author,
          `l${i}`,
          now,
          now,
          now
        ),
        // Each landed PR must be accounted for by #1 ...
        insertEdge.bind(
          `e${i}`,
          pr.repo,
          `l${i}`,
          pr.id,
          'must_account_for',
          'Do it.',
          now,
          now
        )
      );
    // ... and pairs between landed PRs only, which no open PR's tree needs.
    for (let i = 0; i < N; i++)
      stmts.push(
        insertEdge.bind(
          `f${i}`,
          pr.repo,
          `l${i}`,
          `l${(i + 1) % N}`,
          'builds_on',
          null,
          now,
          now
        )
      );
    await t.env.DB.batch(stmts);
    const res = await call(t, '/api/repos/octocat/app/pulls/tree', {
      cookie: admin,
    });
    expect(res.status).toBe(200);
    const tree = (await res.json()) as {
      targets: {
        nodes: { number: number; mustAccountFor: unknown[] }[];
        landed: unknown[];
      }[];
    };
    expect(tree.targets[0].nodes.map((n) => n.number)).toEqual([1]);
    expect(tree.targets[0].nodes[0].mustAccountFor).toHaveLength(N);
    expect(tree.targets[0].landed).toHaveLength(N);
    const detail = await call(t, '/api/repos/octocat/app/pulls/1', {
      cookie: admin,
    });
    expect(detail.status).toBe(200);
    expect(
      ((await detail.json()) as { stack: { mustAccountFor: unknown[] } }).stack
        .mustAccountFor
    ).toHaveLength(N);
  });

  it('is empty when no pull request is open', async () => {
    const { t, admin } = await repoWithAgent(false);
    const res = await call(t, '/api/repos/octocat/app/pulls/tree', {
      cookie: admin,
    });
    expect(await res.json()).toEqual({ targets: [] });
  });

  it('reports pairs still being checked instead of calling a PR independent', async () => {
    const { t, admin, open } = await repoWithAgent();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    type Node = { number: number; checking: boolean; pending: number[] };
    const detail = async (n: number) =>
      (
        (await (
          await call(t, `/api/repos/octocat/app/pulls/${n}`, { cookie: admin })
        ).json()) as { stack: Node }
      ).stack;
    // Before any stack run: no row at either head yet.
    expect(await detail(2)).toMatchObject({ checking: true, pending: [] });
    const tree = (await (
      await call(t, '/api/repos/octocat/app/pulls/tree', { cookie: admin })
    ).json()) as { targets: { nodes: Node[] }[] };
    expect(tree.targets[0].nodes.map((n) => n.checking)).toEqual([true, true]);
    await drain(t, stackModels().models);
    expect(await detail(2)).toMatchObject({ checking: false, pending: [] });
    // A pair claimed but not finished is pending on both sides.
    await t.env.DB.prepare("UPDATE pr_edges SET stage = 'deep'").run();
    expect(await detail(1)).toMatchObject({ checking: false, pending: [2] });
    expect(await detail(2)).toMatchObject({ checking: false, pending: [1] });
  });

  it('hides a private repository’s tree from non-collaborators', async () => {
    const { t, admin } = await repoWithAgent();
    const bob = await addMember(t, admin, 'bob');
    const res = await call(t, '/api/repos/octocat/app/pulls/tree', {
      cookie: bob,
    });
    expect(res.status).toBe(404);
  });

  it('refuses to retry when AI is not configured, and deletes nothing', async () => {
    const { t, admin, open } = await repoWithAgent();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, stackModels({ failTriage: true }).models);
    expect(await edges(t)).toMatchObject([{ stage: 'failed' }]);
    const before = t.actions.resolutions.length;
    delete (t.env as Partial<CloudflareBindings>).MERGE_RESOLUTION;
    const res = await call(t, '/api/repos/octocat/app/pulls/2/stack/retry', {
      cookie: admin,
      json: {},
    });
    expect(res.status).toBe(409);
    expect(await edges(t)).toMatchObject([{ stage: 'failed' }]);
    expect(t.actions.resolutions.length).toBe(before);
  });

  it('re-arms a pair whose run died mid-check, once it is stale', async () => {
    const { t, open } = await repoWithAgent();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, stackModels().models);
    const db = drizzle(t.env.DB, { schema });
    const two = (await t.env.DB.prepare(
      'SELECT id FROM pull_requests WHERE number = 2'
    ).first<{ id: string }>())!.id;
    // A run died right after claiming: the row sits in triage at the current heads.
    await t.env.DB.prepare(
      "UPDATE pr_edges SET stage = 'triage', kind = NULL, prerequisite = NULL, updated_at = ?"
    )
      .bind(Math.floor(Date.now() / 1000))
      .run();
    const fresh = stackModels();
    await executeStacking(
      { env: t.env, db, step, models: fresh.models },
      { pullRequestId: two }
    );
    expect(fresh.calls.triaged).toHaveLength(0); // still in progress elsewhere
    await t.env.DB.prepare('UPDATE pr_edges SET updated_at = 0').run();
    await executeStacking(
      { env: t.env, db, step, models: fresh.models },
      { pullRequestId: two }
    );
    expect(fresh.calls.triaged).toHaveLength(1);
    expect(await edges(t)).toMatchObject([
      { stage: 'done', kind: 'independent' },
    ]);
  });

  it('Retry resets a pair stuck mid-check', async () => {
    const { t, admin, open } = await repoWithAgent();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, stackModels().models);
    await t.env.DB.prepare(
      "UPDATE pr_edges SET stage = 'deep', updated_at = 0"
    ).run();
    const res = await call(t, '/api/repos/octocat/app/pulls/2/stack/retry', {
      cookie: admin,
      json: {},
    });
    expect(res.status).toBe(202);
    expect(await edges(t)).toEqual([]);
  });

  it('retries failed pairs', async () => {
    const { t, admin, open } = await repoWithAgent();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, stackModels({ failTriage: true }).models);
    expect(await edges(t)).toMatchObject([{ stage: 'failed' }]);
    const res = await call(t, '/api/repos/octocat/app/pulls/2/stack/retry', {
      cookie: admin,
      json: {},
    });
    expect(res.status).toBe(202);
    await drain(t, stackModels().models);
    expect(await edges(t)).toMatchObject([
      { stage: 'done', kind: 'independent' },
    ]);
  });
  it('leaves order rows alone and never reads them as pair verdicts', async () => {
    const { t, admin, open } = await repoWithAgent();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, stackModels({ failTriage: true }).models);
    expect(await edges(t)).toMatchObject([{ a: 1, b: 2, stage: 'failed' }]);
    // Failed order rows for the same pair, in both orientations, at the pair's heads.
    await t.env.DB.prepare(
      `INSERT INTO pr_edges (id, repository_id, land_target, pr_a_id, pr_b_id, slot, for_pr_id, for_head,
                             a_head, b_head, stage, kind, prerequisite, reason, created_at, updated_at)
       SELECT 'order-' || x.n, e.repository_id, e.land_target,
              CASE x.n WHEN 1 THEN e.pr_a_id ELSE e.pr_b_id END,
              CASE x.n WHEN 1 THEN e.pr_b_id ELSE e.pr_a_id END,
              'order', e.pr_b_id, e.b_head,
              CASE x.n WHEN 1 THEN e.a_head ELSE e.b_head END,
              CASE x.n WHEN 1 THEN e.b_head ELSE e.a_head END,
              'failed', 'ordered_after', 'a', 'Order.', e.created_at, e.updated_at
         FROM pr_edges e, (SELECT 1 AS n UNION ALL SELECT 2) x`
    ).run();
    const orders = async () =>
      (
        await t.env.DB.prepare(
          "SELECT id, pr_a_id, pr_b_id, a_head, b_head, stage, kind, prerequisite, reason, updated_at FROM pr_edges WHERE slot = 'order' ORDER BY id"
        ).all()
      ).results;
    const before = await orders();
    expect(before).toHaveLength(2);
    const pairs = async () =>
      (
        await t.env.DB.prepare(
          `SELECT a.number AS a, b.number AS b, e.stage, e.kind
             FROM pr_edges e
             JOIN pull_requests a ON a.id = e.pr_a_id
             JOIN pull_requests b ON b.id = e.pr_b_id
            WHERE e.slot = 'pair'`
        ).all()
      ).results;
    // Retry forgets only the failed pair verdict; the run re-claims and saves the pair, not the order rows.
    const res = await call(t, '/api/repos/octocat/app/pulls/2/stack/retry', {
      cookie: admin,
      json: {},
    });
    expect(res.status).toBe(202);
    const { models, calls } = stackModels();
    // Discovery alone: the stack runs' reconcile (which prunes these malformed order rows) is skipped.
    const discoveryOnly = {
      do: async (name: string, a: unknown, b?: unknown) => {
        if (name.startsWith('stack-reconcile:'))
          throw new Error('reconcile skipped');
        return ((b ?? a) as () => Promise<unknown>)();
      },
    } as unknown as StepRunner;
    await drain(t, models, discoveryOnly);
    expect(await pairs()).toEqual([
      { a: 1, b: 2, stage: 'done', kind: 'independent' },
    ]);
    expect(await orders()).toEqual(before);
    // A run at the same heads finds the pair verdict current, whatever the order rows say.
    const triaged = calls.triaged.length;
    const id = (await t.env.DB.prepare(
      'SELECT id FROM pull_requests WHERE number = 2'
    ).first<{ id: string }>())!.id;
    await executeStacking(
      {
        env: t.env,
        db: drizzle(t.env.DB, { schema }),
        step: discoveryOnly,
        models,
      },
      { pullRequestId: id }
    );
    expect(calls.triaged.length).toBe(triaged);
    expect(await orders()).toEqual(before);
    // The tree reads pair verdicts only: a failed order row is not an unchecked pair.
    const tree = (await (
      await call(t, '/api/repos/octocat/app/pulls/tree', { cookie: admin })
    ).json()) as {
      targets: { nodes: { number: number; unchecked: number[] }[] }[];
    };
    expect(tree.targets[0].nodes).toMatchObject([
      { number: 1, unchecked: [] },
      { number: 2, unchecked: [] },
    ]);
  });
});

describe('must account for', () => {
  const HAS_CHECK = {
    ...SETUP_CHECKS,
    ...USAGE,
    'src/setup-checks.ts':
      'export const checks = [check("CF_ANALYTICS_TOKEN")];\n',
  };

  it('tells the dependent what to change, then re-checks only its new head', async () => {
    const { t, open, repo, files } = await repoWithAgent();
    const { models, calls } = stackModels({
      related: () => true,
      relation: () => MUST,
      recheck: (i) => ({
        accounted: i.dependent.diffs.includes('CF_ANALYTICS_TOKEN")'),
        reason: 'Adds a setup check for CF_ANALYTICS_TOKEN.',
        instructions: null,
      }),
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    expect(await events(t, 2)).toContainEqual({
      kind: 'must_account_for',
      data: expect.objectContaining({
        pr: 1,
        instructions: MUST.instructions,
        rebase_first: 'setup',
      }),
    });
    const decided = calls.triaged.length;
    await pushTo(t, repo, 'usage', { ...files, ...HAS_CHECK });
    await drain(t, models);
    expect(calls.triaged.length).toBe(decided); // not re-decided
    expect(calls.rechecked).toHaveLength(1);
    const row = await t.env.DB.prepare(
      "SELECT kind, stage, accounted_for_at AS at, accounted_head AS head FROM pr_edges WHERE slot = 'pair'"
    ).first<{
      kind: string;
      stage: string;
      at: number | null;
      head: string | null;
    }>();
    expect(row).toMatchObject({
      kind: 'must_account_for',
      stage: 'done',
      head: repo.refs.get('refs/heads/usage'),
    });
    expect(row!.at).not.toBeNull();
    expect((await events(t, 2)).map((e) => e.kind)).toContain('accounted_for');
  });

  it('re-checks a landed prerequisite after the dependent rebases onto it, then lets it merge', async () => {
    const { t, admin, open, repo, files } = await repoWithAgent();
    const { models, calls } = stackModels({
      related: () => true,
      relation: () => MUST,
      recheck: (i) => ({
        accounted: i.dependent.diffs.includes('CF_ANALYTICS_TOKEN")'),
        reason: 'Adds a setup check for CF_ANALYTICS_TOKEN.',
        instructions: null,
      }),
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    const merge = (n: number) =>
      call(t, `/api/repos/octocat/app/pulls/${n}/merge`, {
        cookie: admin,
        json: { approve: true },
      });
    expect((await merge(1)).status).toBe(200);
    await drain(t, models);
    expect((await merge(2)).status).toBe(409);
    // #2's agent rebases onto main (which now has #1) and adds the check.
    repo.refs.set('refs/heads/usage', repo.refs.get('refs/heads/main')!);
    await pushTo(t, repo, 'usage', { ...files, ...HAS_CHECK });
    await drain(t, models);
    expect(calls.rechecked).toHaveLength(1);
    expect(calls.rechecked[0].prerequisite.number).toBe(1);
    expect((await events(t, 2)).map((e) => e.kind)).toContain('accounted_for');
    expect((await merge(2)).status).toBe(200);
  });

  it('keeps blocking with new instructions when not accounted for', async () => {
    const { t, open, repo, files } = await repoWithAgent();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    await pushTo(t, repo, 'usage', { ...files, ...USAGE, 'docs/x.md': 'x\n' });
    await drain(t, models);
    expect(
      await t.env.DB.prepare(
        "SELECT accounted_for_at AS at, instructions FROM pr_edges WHERE slot = 'pair'"
      ).first()
    ).toEqual({ at: null, instructions: 'Still add the check.' });
  });

  it('keeps blocking when the re-check fails, and Retry runs it again', async () => {
    const { t, admin, open, repo, files } = await repoWithAgent();
    let fail = true;
    const { models, calls } = stackModels({
      related: () => true,
      relation: () => MUST,
      recheck: () => {
        if (fail) throw new Error('model down');
        return { accounted: true, reason: 'Done.', instructions: null };
      },
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    await pushTo(t, repo, 'usage', { ...files, ...HAS_CHECK });
    await drain(t, models);
    expect(
      await t.env.DB.prepare(
        "SELECT stage, kind, accounted_for_at AS at, error_message AS error FROM pr_edges WHERE slot = 'pair'"
      ).first()
    ).toMatchObject({
      stage: 'done',
      kind: 'must_account_for',
      at: null,
      error: expect.stringMatching(/^Re-check failed/),
    });
    // The sidebar offers Retry: the dependent lists the prerequisite as unchecked.
    const tree = (await (
      await call(t, '/api/repos/octocat/app/pulls/tree', { cookie: admin })
    ).json()) as {
      targets: { nodes: { number: number; unchecked: number[] }[] }[];
    };
    expect(tree.targets[0].nodes).toMatchObject([
      { number: 1, unchecked: [] },
      { number: 2, unchecked: [1] },
    ]);
    fail = false;
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/2/stack/retry', {
          cookie: admin,
          method: 'POST',
        })
      ).status
    ).toBe(202);
    await drain(t, models);
    expect(calls.rechecked.length).toBeGreaterThanOrEqual(2);
    expect(
      (await t.env.DB.prepare(
        "SELECT accounted_for_at AS at FROM pr_edges WHERE slot = 'pair'"
      ).first<{ at: number | null }>())!.at
    ).not.toBeNull();
  });

  it('never re-checks or announces a dismissed edge', async () => {
    const { t, open, repo, files } = await repoWithAgent();
    const { models, calls } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    await t.env.DB.prepare(
      "UPDATE pr_edges SET dismissed_at = 1 WHERE slot = 'pair'"
    ).run();
    // A dismissed edge no longer stacks: the next reconcile sends #2 back to main (once).
    const repoId = (await t.env.DB.prepare(
      "SELECT id FROM repositories WHERE name = 'app'"
    ).first<{ id: string }>())!.id;
    await executeReconcile(
      { env: t.env, db: drizzle(t.env.DB, { schema }), step, models },
      { repositoryId: repoId, landTarget: 'main' }
    );
    expect((await events(t, 2)).at(-1)).toMatchObject({
      kind: 'unstacked',
      data: { pr: 1 },
    });
    const before = await events(t, 2);
    await pushTo(t, repo, 'usage', { ...files, ...HAS_CHECK });
    await drain(t, models);
    expect(calls.rechecked).toHaveLength(0);
    expect(await events(t, 2)).toEqual(before);
    // Both heads moved: re-decided, but still not announced.
    await pushTo(t, repo, 'setup', {
      ...files,
      ...SETUP_CHECKS,
      'a.txt': 'a\n',
    });
    await drain(t, models);
    expect(
      await t.env.DB.prepare(
        "SELECT kind, stage FROM pr_edges WHERE slot = 'pair'"
      ).first()
    ).toEqual({ kind: 'must_account_for', stage: 'done' });
    expect(await events(t, 2)).toEqual(before);
  });

  it('records nothing from a run whose claim a newer run superseded', async () => {
    const { t, open, repo, files } = await repoWithAgent();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
      recheck: async () => {
        // A newer run re-claims the pair at other heads while this one asks the model.
        await t.env.DB.prepare(
          "UPDATE pr_edges SET b_head = 'newer' WHERE slot = 'pair'"
        ).run();
        return { accounted: true, reason: 'Done.', instructions: null };
      },
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    const before = await events(t, 2);
    await pushTo(t, repo, 'usage', { ...files, ...HAS_CHECK });
    await drain(t, models);
    expect(await events(t, 2)).toEqual(before);
    expect(
      await t.env.DB.prepare(
        "SELECT accounted_for_at AS at FROM pr_edges WHERE slot = 'pair'"
      ).first()
    ).toEqual({ at: null });
  });

  it('records an event once however often its step runs', async () => {
    const { t, open } = await repoWithAgent();
    await open('setup', SETUP_CHECKS, 'Setup checks');
    const pr = (await t.env.DB.prepare(
      'SELECT id, repository_id AS repo FROM pull_requests WHERE number = 1'
    ).first<{ id: string; repo: string }>())!;
    const db = drizzle(t.env.DB, { schema });
    for (let i = 0; i < 2; i++)
      await recordEvent(db, {
        id: 'edge:head:accounted_for',
        repositoryId: pr.repo,
        pullRequestId: pr.id,
        kind: 'accounted_for',
        data: { pr: 2, reason: 'r' },
      });
    expect(await events(t, 1)).toEqual([
      { kind: 'accounted_for', data: { pr: 2, reason: 'r' } },
    ]);
  });

  it('records only the re-check when an accounted-for pair is re-decided', async () => {
    const { t, open, repo, files } = await repoWithAgent();
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
    await pushTo(t, repo, 'usage', { ...files, ...HAS_CHECK });
    await drain(t, models);
    const before = (await events(t, 2)).length;
    await pushTo(t, repo, 'setup', {
      ...files,
      ...SETUP_CHECKS,
      'a.txt': 'a\n',
    });
    await drain(t, models);
    expect(calls.rechecked).toHaveLength(2);
    expect((await events(t, 2)).slice(before).map((e) => e.kind)).toEqual([
      'accounted_for',
    ]);
  });

  it('Retry re-arms a re-check whose run died mid-way', async () => {
    const { t, admin, open, repo, files } = await repoWithAgent();
    const { models, calls } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    await pushTo(t, repo, 'usage', { ...files, ...HAS_CHECK });
    await drain(t, models);
    expect(calls.rechecked).toHaveLength(1);
    // As if the run claimed the re-check and died before saving it.
    await t.env.DB.prepare(
      "UPDATE pr_edges SET stage = 'recheck' WHERE slot = 'pair'"
    ).run();
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/2/stack/retry', {
          cookie: admin,
          method: 'POST',
        })
      ).status
    ).toBe(202);
    await drain(t, models);
    expect(calls.rechecked).toHaveLength(2);
    expect(
      await t.env.DB.prepare(
        "SELECT stage FROM pr_edges WHERE slot = 'pair'"
      ).first()
    ).toEqual({ stage: 'done' });
  });
});
