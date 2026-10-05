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
import type { ClassifierAnswer, Repository } from '../db/app.schema';
import type { ReviewModels } from '../review/models';
import { executeStacking, type StackParams } from '../stack/discover';
import { executeReconcile, type ReconcileParams } from '../stack/reconcile';
import { recordEvent } from '../pulls/events';
import { contains } from '../stack/contains';
import { pullStates } from '../pulls/signals';
import { findRepoById, gitFor } from '../lib/repos';
import type {
  DecideInput,
  ExplainInput,
  PrSide,
  Recheck,
  RecheckInput,
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
  // Durable sleeps (the conflict sweep's settle delay) pass instantly.
  sleep: async () => {},
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
type StackCalls = {
  triaged: DecideInput[];
  related: ExplainInput[];
  rechecked: RecheckInput[];
  ordered: number;
};

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
    relation?: (i: { a: PrSide; b: PrSide }) => Relation;
    confidence?: number;
    explainAs?: Relation;
    failTriage?: boolean;
    recheck?: (i: RecheckInput) => Recheck | Promise<Recheck>;
    order?: () =>
      | Record<string, ClassifierAnswer>
      | Promise<Record<string, ClassifierAnswer>>;
  } = {}
): { models: StackModels; calls: StackCalls } {
  const calls: StackCalls = {
    triaged: [],
    related: [],
    rechecked: [],
    ordered: 0,
  };
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
      recheck: async (i) => {
        calls.rechecked.push(i);
        return (
          (await opts.recheck?.(i)) ?? {
            accounted: false,
            reason: 'Not yet.',
            instructions: 'Still add the check.',
          }
        );
      },
      order: async () => {
        calls.ordered++;
        return (
          (await opts.order?.()) ?? {
            first: {
              type: 'choice',
              value: 'a',
              confidence: 0.9,
              probabilities: { a: 0.9 },
            },
          }
        );
      },
    },
  };
}

/** Runs every review, sweep and stack Workflow started so far (once each), until none are left. */
const ran = new WeakMap<TestEnv, Set<string>>();
async function drain(
  t: TestEnv,
  models: StackModels,
  stackStep: StepRunner = step
) {
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
      reconcile?: ReconcileParams;
    };
    if (p.classificationId)
      await executeClassification(
        { env: t.env, db, step, models: reviewModels },
        p.classificationId
      );
    else if (p.sweep) await executeSweep({ env: t.env, db, step }, p.sweep);
    else if (p.stack)
      await executeStacking(
        { env: t.env, db, step: stackStep, models },
        p.stack
      );
    else if (p.reconcile)
      await executeReconcile({ env: t.env, db, step, models }, p.reconcile);
  }
}

/** A repository with `review.yml` on main (none when `policy` is null), and helpers to open PRs from branches off main. */
async function repoWithPolicy(
  policy: string | null = POLICY(),
  visibility: 'private' | 'internal' = 'private'
) {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility },
  });
  const repo = [...t.fake.repos.values()][0];
  const files: Record<string, string> =
    policy === null
      ? { ...MAIN }
      : { ...MAIN, '.gitorange/review.yml': policy };
  const main = await commitPaths(repo, 'main', files, 'base');
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

/** Pushes `files` to `branch` and starts the sweep a push starts. */
async function pushTo(
  t: TestEnv,
  repo: Parameters<typeof commitPaths>[0],
  branch: string,
  files: Record<string, string>
) {
  const old = repo.refs.get(`refs/heads/${branch}`)!;
  await commitPaths(repo, branch, files, `Update ${branch}`);
  const row = await t.env.DB.prepare(
    "SELECT id FROM repositories WHERE name = 'app'"
  ).first<{ id: string }>();
  await autoResolveConflicts(t.env, { id: row!.id } as Repository, [
    {
      ref: `refs/heads/${branch}`,
      old,
      new: repo.refs.get(`refs/heads/${branch}`)!,
    },
  ]);
}

async function events(t: TestEnv, number: number) {
  return (
    await t.env.DB.prepare(
      `SELECT e.kind, e.data FROM pr_events e JOIN pull_requests p ON p.id = e.pull_request_id
        WHERE p.number = ? AND e.kind <> 'state_changed' ORDER BY e.created_at, e.rowid`
    )
      .bind(number)
      .all<{ kind: string; data: string }>()
  ).results.map((r) => ({ kind: r.kind, data: JSON.parse(r.data) }));
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

  it('never lets a run that loaded before a landing undo the landed orientation', async () => {
    const { t, open } = await repoWithPolicy();
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
    const { t, admin, open } = await repoWithPolicy();
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
    const { t, open } = await repoWithPolicy(
      POLICY('stacking:\n  max_open: 2\n')
    );
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

  it('runs in a repository without review.yml, on paths, from the PR opens', async () => {
    const { t, open } = await repoWithPolicy(null);
    const { models, calls } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    // No review ran (there is no review.yml), so discovery started from the opens alone.
    expect(
      t.actions.resolutions.filter(
        (s) => (s.params as { classificationId?: string }).classificationId
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

  it('runs with a review.yml that has no stacking section', async () => {
    const { t, open } = await repoWithPolicy(
      'model: clef\nchecks:\n  require: all\n'
    );
    const { models } = stackModels();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    expect(await edges(t)).toMatchObject([
      { a: 1, b: 2, stage: 'done', kind: 'independent' },
    ]);
  });

  it('ignores a leftover stacking.enabled: false', async () => {
    const { t, open } = await repoWithPolicy(
      POLICY('stacking:\n  enabled: false\n')
    );
    const { models } = stackModels();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    expect(await edges(t)).toMatchObject([
      { a: 1, b: 2, stage: 'done', kind: 'independent' },
    ]);
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

  it('serves the tree for a repository without review.yml', async () => {
    const { t, admin, open } = await repoWithPolicy(null);
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

  it('is empty when no pull request is open', async () => {
    const { t, admin } = await repoWithPolicy(null);
    const res = await call(t, '/api/repos/octocat/app/pulls/tree', {
      cookie: admin,
    });
    expect(await res.json()).toEqual({ targets: [] });
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

  it('refuses to retry when AI is not configured, and deletes nothing', async () => {
    const { t, admin, open } = await repoWithPolicy();
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
    const { t, open } = await repoWithPolicy();
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
    const { t, admin, open } = await repoWithPolicy();
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
  it('leaves order rows alone and never reads them as pair verdicts', async () => {
    const { t, admin, open } = await repoWithPolicy();
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
    const { t, open, repo, files } = await repoWithPolicy();
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
    const { t, admin, open, repo, files } = await repoWithPolicy();
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
        json: {},
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
    const { t, open, repo, files } = await repoWithPolicy();
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
    const { t, admin, open, repo, files } = await repoWithPolicy();
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
    const { t, open, repo, files } = await repoWithPolicy();
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
      'SELECT id FROM repositories'
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
    const { t, open, repo, files } = await repoWithPolicy();
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
    const { t, open } = await repoWithPolicy();
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
    const { t, open, repo, files } = await repoWithPolicy();
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
    const { t, admin, open, repo, files } = await repoWithPolicy();
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

describe('stack gate', () => {
  it('holds auto-merge until discovery has checked the PR', async () => {
    const { t, open } = await repoWithPolicy(
      'model: clef\nchecks:\n  require: none\nstacking:\n  enabled: true\n'
    );
    const db = drizzle(t.env.DB, { schema });
    const { models } = stackModels();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await settle(t);
    const review = t.actions.resolutions.find(
      (r) => (r.params as { classificationId?: string }).classificationId
    )!;
    await executeClassification(
      { env: t.env, db, step, models: reviewModels },
      (review.params as { classificationId: string }).classificationId
    );
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
    const { t, admin, open } = await repoWithPolicy();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    const res = await call(t, '/api/repos/octocat/app/pulls/2/merge', {
      cookie: admin,
      json: {},
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
    const { t, admin, open } = await repoWithPolicy();
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
          json: {},
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
      json: {},
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/#1/);
  });

  it('when the tree can’t be read: the PR page waits, merging refuses', async () => {
    const { t, admin, open } = await repoWithPolicy();
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
      json: {},
    });
    expect(merge.status).toBe(409);
    expect(((await merge.json()) as { error: string }).error).toMatch(/stack/i);
  });

  it('never calls a PR Ready when its tree can’t be read, even without AI review', async () => {
    const { t, open } = await repoWithPolicy(null);
    const { models } = stackModels();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    await t.env.DB.prepare("UPDATE pr_edges SET files = '{broken'").run();
    const db = drizzle(t.env.DB, { schema });
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
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
    const { t, open } = await repoWithPolicy(
      'model: clef\nchecks:\n  require: none\nstacking:\n  enabled: true\n'
    );
    const db = drizzle(t.env.DB, { schema });
    const { models } = stackModels();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await settle(t);
    const review = t.actions.resolutions.find(
      (r) => (r.params as { classificationId?: string }).classificationId
    )!;
    await executeClassification(
      { env: t.env, db, step, models: reviewModels },
      (review.params as { classificationId: string }).classificationId
    );
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
    const { t, admin, open } = await repoWithPolicy();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    const refused = await call(t, '/api/repos/octocat/app/pulls/2/merge', {
      cookie: admin,
      json: {},
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
      json: {},
    });
    expect(res.status).toBe(200);
  });

  it('lands once a landed prerequisite is accounted for', async () => {
    const { t, admin, open } = await repoWithPolicy();
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
          json: {},
        })
      ).status
    ).toBe(200);
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    const refused = await call(t, '/api/repos/octocat/app/pulls/2/merge', {
      cookie: admin,
      json: {},
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
      json: {},
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
    const { t, open } = await repoWithPolicy();
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
    const { t, open, repo, files } = await repoWithPolicy();
    const { models } = three();
    await openThree(t, open);
    await drain(t, models);
    const db = drizzle(t.env.DB, { schema });
    const states = async () => {
      const repoId = (await t.env.DB.prepare(
        'SELECT id FROM repositories'
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
    const { t, admin, open } = await repoWithPolicy();
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
    const { t, admin, open } = await repoWithPolicy();
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
    const { t, open, repo } = await repoWithPolicy();
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
       SELECT 'r1', id, 1, 'ci.yml', 'CI', 'pull_request', 'x', ?, 'x', 'completed', 'failure', 0 FROM repositories`
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
    const { t, open } = await repoWithPolicy();
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
    const { t, open, repo, files } = await repoWithPolicy();
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
    const { t, admin, open } = await repoWithPolicy();
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
    const { t, admin, open } = await repoWithPolicy();
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
    const { t, open, repo } = await repoWithPolicy();
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
      'SELECT id FROM repositories'
    ).first<{ id: string }>())!.id;
    await executeReconcile(
      { env: t.env, db, step, models },
      { repositoryId: repoId, landTarget: 'main' }
    );
    expect((await bases(t))[1]).toEqual([2, 'main']);
  });

  it('retargets once when reconciles repeat or race', async () => {
    const { t, open } = await repoWithPolicy();
    const { models } = stackModels({
      related: () => true,
      relation: () => BUILDS_A,
    });
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    const db = drizzle(t.env.DB, { schema });
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
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
    const { t, open } = await repoWithPolicy();
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
      'SELECT id FROM repositories'
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
    const { t, open } = await repoWithPolicy();
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
      'SELECT id FROM repositories'
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
    const { t, open } = await repoWithPolicy();
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
    const { t, admin, open, repo, files } = await repoWithPolicy();
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
    const { t, open, repo } = await repoWithPolicy(
      'model: clef\nchecks:\n  require: none\n'
    );
    const { models } = stackModels({
      related: () => true,
      relation: () => BUILDS_A,
    });
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
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
    const { t, open } = await repoWithPolicy();
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
    const { t, open, repo } = await repoWithPolicy();
    const { models } = three();
    await openThree(t, open);
    await drain(t, models);
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
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
    const { t, open } = await repoWithPolicy();
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
    const { t, admin, open } = await repoWithPolicy(POLICY(), 'internal');
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
          json: {},
        })
      ).status
    ).toBe(200);
  });

  it('dismisses a waits-on edge', async () => {
    const { t, admin, open } = await repoWithPolicy();
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
    const { t, admin, open } = await repoWithPolicy();
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
    const { t, admin, open } = await repoWithPolicy();
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
    const { t, admin, open } = await repoWithPolicy();
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
        json: {},
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
    const { t, admin, open, repo, files } = await repoWithPolicy();
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
    const { t, admin, open } = await repoWithPolicy();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
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
    const { t, admin, open } = await repoWithPolicy();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
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
    const { t, admin, open } = await repoWithPolicy();
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
    const { t, admin, open } = await repoWithPolicy();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, stackModels({ failTriage: true }).models);
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
    const { t, admin, open } = await repoWithPolicy();
    const must = stackModels({ related: () => true, relation: () => MUST });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, must.models);
    await open('third', { 'c.txt': 'c\n' }, 'Third');
    await drain(t, stackModels({ failTriage: true }).models);
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
    const { t, admin, open } = await repoWithPolicy();
    const must = stackModels({ related: () => true, relation: () => MUST });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, must.models);
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
