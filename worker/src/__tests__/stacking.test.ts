import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import type { StepRunner } from '../merge/resolution';
import { executeClassification } from '../review/classify';
import {
  autoResolveConflicts,
  executeSweep,
  type SweepParams,
} from '../merge/auto';
import type { Repository } from '../db/app.schema';
import type { ReviewModels } from '../review/models';
import { executeStacking, type StackParams } from '../stack/discover';
import type {
  DecideInput,
  ExplainInput,
  Relation,
  StackModels,
} from '../stack/models';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
  type TestEnv,
} from './helpers/app';
import { commitPaths } from './helpers/seed';

// Checks are required (and none ever run), so auto-merge waits and the PRs stay open.
const POLICY = (extra = '') => `
model: clef
checks:
  require: all
stacking:
  enabled: true
${extra}`;

/** The #28/#29 shape: a config file and docs on main. */
const MAIN = {
  'src/config.ts': 'export const vars = ["BASE_URL"];\n',
  'docs/configuration.md': '# Configuration\n\n- BASE_URL\n',
  'notes.txt': 'one\ntwo\nthree\n',
};

const step = {
  do: async (_name: string, a: unknown, b?: unknown) =>
    ((b ?? a) as () => Promise<unknown>)(),
} as unknown as StepRunner;

const reviewModels: ReviewModels = {
  summarize: async (f) => `Changes ${f.path}.`,
  classify: async () => ({}),
  investigate: async () => ({
    detail: '',
    diagram: null,
    snippets: [],
    paths: [],
  }),
};

/** `triaged`: what Clef was asked; `related`: what the reasoning model was asked. */
type StackCalls = { triaged: DecideInput[]; related: ExplainInput[] };

const CONFLICT: Relation = {
  kind: 'conflicts',
  prerequisite: 'a',
  reason: 'Both edit notes.txt.',
  instructions: null,
};

/**
 * Fake models. Clef answers "related" from `related`, and kind/prerequisite from `relation` with `confidence`;
 * the reasoning model answers `explainAs` (default: the same relation).
 */
function stackModels(
  opts: {
    related?: (i: DecideInput) => boolean;
    relation?: (i: { a: { landed: boolean } }) => Relation;
    confidence?: number;
    explainAs?: Relation;
    failTriage?: boolean;
  } = {}
): { models: StackModels; calls: StackCalls } {
  const calls: StackCalls = { triaged: [], related: [] };
  const confidence = opts.confidence ?? 0.9;
  return {
    calls,
    models: {
      decide: async (_model, i) => {
        if (opts.failTriage) throw new Error('model down');
        calls.triaged.push(i);
        const rel = opts.relation?.(i) ?? CONFLICT;
        return {
          related: { type: 'noul', value: opts.related?.(i) ? 0.9 : 0.05 },
          kind: {
            type: 'choice',
            value: rel.kind,
            confidence,
            probabilities: { [rel.kind]: confidence },
          },
          prerequisite: {
            type: 'choice',
            value: rel.prerequisite ?? 'a',
            confidence,
            probabilities: { [rel.prerequisite ?? 'a']: confidence },
          },
        };
      },
      explain: async (i) => {
        calls.related.push(i);
        const rel = opts.explainAs ?? opts.relation?.(i) ?? CONFLICT;
        return i.decided ? { ...rel, ...i.decided } : rel;
      },
    },
  };
}

/** Runs every review, sweep and stack Workflow started so far (once each), until none are left. */
const ran = new WeakMap<TestEnv, Set<string>>();
async function drain(t: TestEnv, models: StackModels) {
  const db = drizzle(t.env.DB, { schema });
  const done = ran.get(t) ?? new Set<string>();
  ran.set(t, done);
  for (;;) {
    await settle(t);
    const next = t.actions.resolutions.find((s) => !done.has(s.id));
    if (!next) return;
    done.add(next.id);
    const p = next.params as {
      classificationId?: string;
      sweep?: SweepParams;
      stack?: StackParams;
    };
    if (p.classificationId)
      await executeClassification(
        { env: t.env, db, step, models: reviewModels },
        p.classificationId
      );
    else if (p.sweep) await executeSweep({ env: t.env, db, step }, p.sweep);
    else if (p.stack)
      await executeStacking({ env: t.env, db, step, models }, p.stack);
  }
}

/** A repository with `review.yml` on main, and helpers to open PRs from branches off main. */
async function repoWithPolicy(policy = POLICY()) {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'private' },
  });
  const repo = [...t.fake.repos.values()][0];
  const main = await commitPaths(
    repo,
    'main',
    { ...MAIN, '.gitorange/review.yml': policy },
    'base'
  );
  const files = { ...MAIN, '.gitorange/review.yml': policy };
  async function open(
    branch: string,
    changes: Record<string, string>,
    title: string
  ) {
    repo.refs.set(`refs/heads/${branch}`, main);
    await commitPaths(repo, branch, { ...files, ...changes }, title);
    const res = await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title, body: `${title}.`, base: 'main', head: branch },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { number: number }).number;
  }
  return { t, admin, repo, open, files };
}

async function edges(t: TestEnv) {
  const { results } = await t.env.DB.prepare(
    `SELECT a.number AS a, b.number AS b, e.stage, e.kind, e.prerequisite, e.reason,
            e.instructions, e.conflict_files AS conflictFiles
       FROM pr_edges e
       JOIN pull_requests a ON a.id = e.pr_a_id
       JOIN pull_requests b ON b.id = e.pr_b_id
      ORDER BY a.number, b.number`
  ).all<Record<string, unknown>>();
  return results;
}

const SETUP_CHECKS = {
  'src/setup-checks.ts':
    'import { vars } from "./config";\nexport const checks = vars.map(check);\n',
  'docs/configuration.md':
    '# Configuration\n\nEvery variable needs a setup check.\n\n- BASE_URL\n',
};
const USAGE = {
  'src/usage.ts': 'export const token = env.CF_ANALYTICS_TOKEN;\n',
  'src/config.ts': 'export const vars = ["BASE_URL", "CF_ANALYTICS_TOKEN"];\n',
};
const MUST: Relation = {
  kind: 'must_account_for',
  prerequisite: 'a',
  reason:
    '#1 adds a setup check per config variable; this adds CF_ANALYTICS_TOKEN without one.',
  instructions:
    'Rebase onto setup-checks and add a check for CF_ANALYTICS_TOKEN.',
};

describe('stacking discovery', () => {
  it('finds that #2 must account for #1 (the #28/#29 case)', async () => {
    const { t, open } = await repoWithPolicy();
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
    const { t, open } = await repoWithPolicy();
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
    const sure = await repoWithPolicy();
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
    const unsure = await repoWithPolicy();
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
    const { t, open } = await repoWithPolicy();
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
    const { t, open, repo, files } = await repoWithPolicy();
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
    await autoResolveConflicts(t.env, { id: row!.id } as Repository, [
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
    const { t, open } = await repoWithPolicy();
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
    await settle(t);
    for (const r of [...t.actions.resolutions]) {
      const id = (r.params as { classificationId?: string }).classificationId;
      if (id)
        await executeClassification(
          { env: t.env, db, step, models: reviewModels },
          id
        );
    }
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
    const { t, open } = await repoWithPolicy();
    const { models } = stackModels({ failTriage: true });
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    expect(await edges(t)).toMatchObject([{ a: 1, b: 2, stage: 'failed' }]);
  });

  it('finds a dependency on a PR that already landed', async () => {
    const { t, admin, open } = await repoWithPolicy();
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
      json: {},
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

  it('keeps one row per pair when the higher-numbered PR lands first', async () => {
    const { t, admin, open } = await repoWithPolicy();
    const { models } = stackModels({
      related: () => true,
      relation: () => BUILDS,
    });
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    expect(await edges(t)).toMatchObject([{ a: 1, b: 2 }]);
    const merged = await call(t, '/api/repos/octocat/app/pulls/2/merge', {
      cookie: admin,
      json: {},
    });
    expect(merged.status).toBe(200);
    await drain(t, models);
    expect(await edges(t)).toMatchObject([
      { a: 2, b: 1, stage: 'done', kind: 'builds_on', prerequisite: 'a' },
    ]);
    expect(await edges(t)).toHaveLength(1);
  });

  it('keeps each side small enough for a Workflow step result', async () => {
    const { t, open } = await repoWithPolicy();
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

  it('falls back to paths when the review has no summaries', async () => {
    const { t, open } = await repoWithPolicy(
      POLICY('limits:\n  max_files: 1\n')
    );
    const { models, calls } = stackModels();
    await open('one', { 'a.txt': 'a\n', 'a2.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n', 'b2.txt': 'b\n' }, 'Two');
    await drain(t, models);
    expect(calls.triaged.at(-1)!.a.summaries).toBe('- a.txt\n- a2.txt');
  });

  it('skips closed PRs and missing branches', async () => {
    const { t, admin, open, repo } = await repoWithPolicy();
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
    const { t, open } = await repoWithPolicy(POLICY('  max_open: 2\n'));
    const { models, calls } = stackModels();
    await open('p1', { 'shared.txt': 'one\n' }, 'P1');
    await open('p2', { 'b.txt': 'b\n' }, 'P2');
    await open('p3', { 'shared.txt': 'three\n' }, 'P3');
    await drain(t, models);
    const pairs = (await edges(t)).map((e) => `${e.a}-${e.b}`);
    // #3's run sees #2 (within the cap) and #1 (shares shared.txt), so both pairs exist.
    // #1's and #2's runs each see only #3 within the cap; neither shares a file with the other, so 1-2 is never checked.
    expect(pairs.sort()).toEqual(['1-3', '2-3']);
    expect(calls.related.some((r) => r.conflicts.includes('shared.txt'))).toBe(
      true
    );
  });

  it('does nothing when stacking is off', async () => {
    const { t, open } = await repoWithPolicy(
      'model: clef\nchecks:\n  require: none\n'
    );
    const { models, calls } = stackModels();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    expect(
      t.actions.resolutions.filter(
        (s) => (s.params as { stack?: unknown }).stack
      )
    ).toEqual([]);
    expect(calls.triaged).toEqual([]);
  });
});

describe('stack API', () => {
  it('serves the tree and each PR’s place in it', async () => {
    const { t, admin, open } = await repoWithPolicy();
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
    const { t, admin, open } = await repoWithPolicy();
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

  it('is empty with stacking off', async () => {
    const { t, admin, open } = await repoWithPolicy('model: clef\n');
    await open('one', { 'a.txt': 'a\n' }, 'One');
    const res = await call(t, '/api/repos/octocat/app/pulls/tree', {
      cookie: admin,
    });
    expect(await res.json()).toEqual({ stacking: false, targets: [] });
    const detail = (await (
      await call(t, '/api/repos/octocat/app/pulls/1', { cookie: admin })
    ).json()) as { stack: unknown };
    expect(detail.stack).toBeNull();
  });

  it('serves a PR with more pairs than D1 binds in one statement', async () => {
    const { t, admin, open } = await repoWithPolicy();
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

  it('says stacking is on when no pull request is open', async () => {
    const { t, admin } = await repoWithPolicy();
    const res = await call(t, '/api/repos/octocat/app/pulls/tree', {
      cookie: admin,
    });
    expect(await res.json()).toEqual({ stacking: true, targets: [] });
  });

  it('reports pairs still being checked instead of calling a PR independent', async () => {
    const { t, admin, open } = await repoWithPolicy();
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
    const { t, admin } = await repoWithPolicy();
    const bob = await addMember(t, admin, 'bob');
    const res = await call(t, '/api/repos/octocat/app/pulls/tree', {
      cookie: bob,
    });
    expect(res.status).toBe(404);
  });

  it('refuses to retry when stacking is off, and deletes nothing', async () => {
    const { t, admin, open, repo, files } = await repoWithPolicy();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, stackModels({ failTriage: true }).models);
    expect(await edges(t)).toMatchObject([{ stage: 'failed' }]);
    await commitPaths(
      repo,
      'main',
      { ...files, '.gitorange/review.yml': 'model: clef\n' },
      'Stacking off'
    );
    const before = t.actions.resolutions.length;
    const res = await call(t, '/api/repos/octocat/app/pulls/2/stack/retry', {
      cookie: admin,
      json: {},
    });
    expect(res.status).toBe(409);
    expect(await edges(t)).toMatchObject([{ stage: 'failed' }]);
    expect(t.actions.resolutions.length).toBe(before);
  });

  it('retries failed pairs', async () => {
    const { t, admin, open } = await repoWithPolicy();
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
});
