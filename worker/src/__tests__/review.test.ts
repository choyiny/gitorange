import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import type { ClassifierAnswer } from '../db/app.schema';
import type { StepRunner } from '../merge/resolution';
import { executeResolution } from '../merge/resolution';
import { executeClassification } from '../review/classify';
import { autoMergeForCommit } from '../review/auto-merge';
import type {
  ClefQuestion,
  InvestigateRequest,
  ReviewModels,
} from '../review/models';
import { parsePolicy, PolicyError, questionType } from '../review/policy';
import OWN_POLICY from '../../../.gitorange/review.yml?raw';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
  type TestEnv,
} from './helpers/app';
import { commitPaths } from './helpers/seed';

const POLICY = `
model: clef
checks:
  require: none
human_review:
  questions:
    data_model:
      ask: Does this change alter how data is stored?
      above: 0.3
    risk:
      ask: How risky is this?
      levels: [trivial, low, moderate, high]
      at_least: 2
`;

const APP = { 'src/app.ts': 'export const a = 1;\n' };

type Review = {
  classification: {
    status: string;
    verdict: string | null;
    errorMessage: string | null;
    files: { path: string; summary: string }[];
  } | null;
  questions: { id: string; flagged: boolean; answer: unknown }[];
  flags: {
    id: string;
    source: string;
    key: string;
    title: string;
    paths: string[];
    detail: string | null;
    approvedBy: { username: string } | null;
  }[];
  autoMerge: { state: string; reasons: string[] };
};

/** A repository whose main has `policy` (if any), and an open PR adding `changes`. */
async function pullWith(
  changes: Record<string, string>,
  opts: {
    policy?: string | null;
    actions?: boolean;
    /** Extra files on main (and so on the branch too). */
    base?: Record<string, string>;
  } = {}
) {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'internal' },
  });
  const repo = [...t.fake.repos.values()][0];
  const policy = opts.policy === undefined ? POLICY : opts.policy;
  const main = await commitPaths(
    repo,
    'main',
    {
      ...APP,
      ...opts.base,
      ...(policy ? { '.gitorange/review.yml': policy } : {}),
    },
    'base'
  );
  repo.refs.set('refs/heads/feature', main);
  await commitPaths(
    repo,
    'feature',
    {
      ...APP,
      ...opts.base,
      ...(policy ? { '.gitorange/review.yml': policy } : {}),
      ...changes,
    },
    'Change things'
  );
  await call(t, '/api/repos/octocat/app/pulls', {
    cookie: admin,
    json: {
      title: 'Change things',
      body: 'Some changes.',
      base: 'main',
      head: 'feature',
    },
  });
  await settle(t);
  return { t, admin, repo };
}

const step = {
  do: async (_name: string, a: unknown, b?: unknown) =>
    ((b ?? a) as () => Promise<unknown>)(),
} as unknown as StepRunner;

type Calls = {
  summarized: string[];
  classified: { state: unknown; questions: Record<string, ClefQuestion> }[];
  investigated: InvestigateRequest[];
};

/** Answers that flag only data_model. */
const DATA_CHANGE: Record<string, ClassifierAnswer> = {
  data_model: { type: 'noul', value: 0.9 },
  risk: { type: 'score', value: 1, confidence: 0.7, probabilities: { '1': 1 } },
};

/** Fake models: a fixed one-liner per file, scripted answers, a fixed investigation. */
function fakeModels(
  answers: Record<string, ClassifierAnswer> = {
    data_model: { type: 'noul', value: 0.05 },
    risk: {
      type: 'score',
      value: 0.4,
      confidence: 0.8,
      probabilities: { '0': 0.6, '1': 0.4 },
    },
  },
  opts: { failSummary?: string; failClassify?: boolean } = {}
): { models: ReviewModels; calls: Calls } {
  const calls: Calls = { summarized: [], classified: [], investigated: [] };
  return {
    calls,
    models: {
      summarize: async (f) => {
        if (f.path === opts.failSummary) throw new Error('model down');
        calls.summarized.push(f.path);
        return `Changes ${f.path}.`;
      },
      classify: async (_model, state, questions) => {
        if (opts.failClassify) throw new Error('model down');
        calls.classified.push({ state, questions });
        return answers;
      },
      investigate: async (req) => {
        calls.investigated.push(req);
        return {
          detail: 'Adds a column; check the migration.',
          diagram: 'erDiagram\n  X {\n    text y "NEW"\n  }',
          snippets: [
            {
              path: 'migrations/0001.sql',
              start: 1,
              end: 1,
              why: 'the new column',
            },
            // Not a changed file: dropped rather than shown.
            { path: 'src/nope.ts', start: 1, end: 3, why: 'made up' },
          ],
          paths: ['migrations/0001.sql', 'not/changed.ts'],
        };
      },
    },
  };
}

/** Runs every review Workflow started so far (once each), inline. */
const ran = new WeakMap<TestEnv, Set<string>>();
async function runReviews(t: TestEnv, models: ReviewModels) {
  const done = ran.get(t) ?? new Set<string>();
  ran.set(t, done);
  for (const s of t.actions.resolutions) {
    const params = s.params as { classificationId?: string };
    if (!params.classificationId || done.has(s.id)) continue;
    done.add(s.id);
    await executeClassification(
      { env: t.env, db: drizzle(t.env.DB, { schema }), step, models },
      params.classificationId
    );
  }
}

async function review(t: TestEnv, cookie: string) {
  const d = (await (
    await call(t, '/api/repos/octocat/app/pulls/1', { cookie })
  ).json()) as { review: Review | null; pull: { state: string } };
  return d;
}

async function pullRow(t: TestEnv) {
  return t.env.DB.prepare(
    'SELECT state, merged_by_id, merged_automatically, merge_commit_sha FROM pull_requests'
  ).first<{
    state: string;
    merged_by_id: string | null;
    merged_automatically: number;
    merge_commit_sha: string | null;
  }>();
}

describe('review.yml', () => {
  it('parses all three question kinds and rejects mistakes with a clear message', () => {
    const p = parsePolicy(POLICY);
    expect(p.model).toBe('clef');
    expect(p.limits.max_files).toBe(100);
    expect(Object.keys(p.human_review.questions)).toEqual([
      'data_model',
      'risk',
    ]);
    expect(() =>
      parsePolicy(
        'human_review:\n  questions:\n    q:\n      ask: x\n      levels: [a, b]\n      at_least: 5\n'
      )
    ).toThrow(/at_least/);
    expect(() => parsePolicy('modle: clef\n')).toThrow(PolicyError);
    expect(() => parsePolicy('a: [\n')).toThrow(/not valid YAML/);
    expect(() =>
      parsePolicy('human_review:\n  paths: [migrations/**]\n')
    ).toThrow(/human_review.paths is no longer supported/);
  });

  it("accepts this repository's own .gitorange/review.yml", () => {
    const p = parsePolicy(OWN_POLICY);
    expect(p.model).toBe('clef');
    expect(p.checks.require).toBe('all');
    const removes = p.human_review.questions.removes_functionality;
    expect(removes).toBeDefined();
    expect(questionType(removes)).toBe('noul');
  });
});

describe('auto-merge review', () => {
  it('does nothing for a repository without .gitorange/review.yml', async () => {
    const { t, admin } = await pullWith(
      { 'src/b.ts': 'b\n' },
      { policy: null }
    );
    expect((await review(t, admin)).review).toBeNull();
    expect(
      t.actions.resolutions.filter(
        (r) => (r.params as { classificationId?: string }).classificationId
      )
    ).toEqual([]);
  });

  it('classifies one-liners, never the diff, and merges a clean PR on its own', async () => {
    const { t, admin, repo } = await pullWith({
      'src/b.ts': 'export const b = 2;\n',
    });
    const before = await review(t, admin);
    expect(before.review?.autoMerge.state).toBe('waiting');

    const { models, calls } = fakeModels();
    await runReviews(t, models);
    await settle(t);

    expect(calls.summarized).toEqual(['src/b.ts']);
    expect(calls.classified).toHaveLength(1);
    const state = JSON.stringify(calls.classified[0].state);
    expect(state).toContain('Changes src/b.ts.');
    expect(state).not.toContain('export const b'); // the raw diff never reaches Clef
    expect(calls.classified[0].questions.data_model).toEqual({
      type: 'noul',
      instructions: 'Does this change alter how data is stored?',
    });
    expect(calls.investigated).toEqual([]);

    const row = await pullRow(t);
    expect(row).toMatchObject({
      state: 'merged',
      merged_by_id: null,
      merged_automatically: 1,
    });
    // Linear: one squashed commit on main, authored as the PR's author.
    const merged = repo.parseCommit(row!.merge_commit_sha!)!;
    expect(merged.message).toBe('Change things (#1)');
    expect(merged.author.name).toBe('Admin');
  });

  it('flags crossed thresholds, investigates them visually, and merges once all are approved', async () => {
    const { t, admin } = await pullWith({
      'migrations/0001.sql': 'ALTER TABLE x ADD y;\n',
      'src/b.ts': 'b\n',
    });
    const { models, calls } = fakeModels({
      data_model: { type: 'noul', value: 0.9 },
      risk: {
        type: 'score',
        value: 2.4,
        confidence: 0.7,
        probabilities: { '2': 0.6, '3': 0.4 },
      },
    });
    await runReviews(t, models);
    await settle(t);

    let d = await review(t, admin);
    expect(d.pull.state).toBe('open');
    expect(d.review!.classification).toMatchObject({
      status: 'done',
      verdict: 'human',
    });
    expect(d.review!.flags.map((f) => [f.source, f.key])).toEqual([
      ['question', 'data_model'],
      ['question', 'risk'],
    ]);
    const flag = d.review!.flags[0];
    // Only changed files count.
    expect(flag.paths).toEqual(['migrations/0001.sql']);
    // The explanation, its diagram as a Mermaid block, and the code excerpt taken from the
    // real diff (the made-up path is dropped).
    expect(flag.detail).toContain('Adds a column; check the migration.');
    expect(flag.detail).toContain('```mermaid\nerDiagram');
    expect(flag.detail).toContain(
      '<details><summary><code>migrations/0001.sql</code> lines 1–1: the new column</summary>'
    );
    expect(flag.detail).toContain('```diff\n+ALTER TABLE x ADD y;\n```');
    expect(flag.detail).not.toContain('src/nope.ts');
    expect(d.review!.autoMerge).toMatchObject({
      state: 'waiting',
      reasons: ['2 flags need approval'],
    });
    // The investigator gets every diff, each line numbered as in the file.
    expect(calls.investigated[0].diffs).toContain(
      '+    1     | ALTER TABLE x ADD y;'
    );

    // The PR's author may approve (for now).
    for (const f of d.review!.flags) {
      const res = await call(
        t,
        `/api/repos/octocat/app/pulls/1/review/flags/${f.id}/approve`,
        { cookie: admin, method: 'POST' }
      );
      expect(res.status).toBe(200);
      await settle(t);
    }
    expect((await pullRow(t))!.state).toBe('merged');
    // The review stays on the merged PR as a record, with who approved what.
    d = await review(t, admin);
    expect(d.review!.classification!.verdict).toBe('human');
    expect(d.review!.flags.map((f) => f.approvedBy?.username)).toEqual([
      'octocat',
      'octocat',
    ]);
    expect(d.review!.autoMerge.state).toBe('off');
    const late = await call(
      t,
      `/api/repos/octocat/app/pulls/1/review/flags/${d.review!.flags[0].id}/approve`,
      { cookie: admin, method: 'POST' }
    );
    expect(late.status).toBe(400);
  });

  it('needs merge permission to approve a flag', async () => {
    const { t, admin } = await pullWith({ 'migrations/1.sql': 'x\n' });
    await runReviews(t, fakeModels(DATA_CHANGE).models);
    const flag = (await review(t, admin)).review!.flags[0];
    const reader = await addMember(t, admin, 'reader');
    const res = await call(
      t,
      `/api/repos/octocat/app/pulls/1/review/flags/${flag.id}/approve`,
      { cookie: reader, method: 'POST' }
    );
    expect(res.status).toBe(403);
  });

  it('waits for passing checks, and merges when the last run succeeds', async () => {
    const { t, admin, repo } = await pullWith(
      { 'src/b.ts': 'b\n' },
      { policy: POLICY.replace('require: none', 'require: all') }
    );
    await runReviews(t, fakeModels().models);
    expect((await review(t, admin)).review!.autoMerge).toEqual({
      state: 'waiting',
      reasons: ['No checks have run for this commit yet'],
      disabledAt: null,
    });
    const head = repo.refs.get('refs/heads/feature')!;
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{
      id: string;
    }>())!.id;
    const insertRun = (
      id: string,
      n: number,
      status: string,
      conclusion: string | null
    ) =>
      t.env.DB.prepare(
        `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title, status, conclusion, created_at)
         VALUES (?, ?, ?, '.github/workflows/ci.yml', 'CI', 'pull_request', 'refs/pull/1/head', ?, 'x', ?, ?, 0)`
      )
        .bind(id, repoId, n, head, status, conclusion)
        .run();
    await insertRun('r1', 1, 'in_progress', null);
    expect((await review(t, admin)).review!.autoMerge.reasons).toEqual([
      'Checks are running',
    ]);
    await t.env.DB.prepare(
      "UPDATE workflow_runs SET status = 'completed', conclusion = 'success'"
    ).run();
    await autoMergeForCommit(
      t.env,
      drizzle(t.env.DB, { schema }),
      repoId,
      head
    );
    expect((await pullRow(t))!.state).toBe('merged');
  });

  it('blocks on failed checks', async () => {
    const { t, admin, repo } = await pullWith(
      { 'src/b.ts': 'b\n' },
      { policy: POLICY.replace('require: none', 'require: all') }
    );
    await runReviews(t, fakeModels().models);
    const head = repo.refs.get('refs/heads/feature')!;
    await t.env.DB.prepare(
      `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title, status, conclusion, created_at)
       SELECT 'r1', id, 1, 'ci.yml', 'CI', 'pull_request', 'x', ?, 'x', 'completed', 'failure', 0 FROM repositories`
    )
      .bind(head)
      .run();
    expect((await review(t, admin)).review!.autoMerge).toMatchObject({
      state: 'blocked',
      reasons: ['Checks failed'],
    });
  });

  it('records an invalid review.yml as a failed review without calling a model', async () => {
    const { t, admin } = await pullWith(
      { 'src/b.ts': 'b\n' },
      { policy: 'human_review:\n  questions:\n    q:\n      ask: x\n' }
    );
    const d = await review(t, admin);
    expect(d.review!.classification).toMatchObject({ status: 'failed' });
    expect(d.review!.classification!.errorMessage).toMatch(
      /^\.gitorange\/review\.yml: /
    );
    expect(d.review!.autoMerge.state).toBe('blocked');
  });

  it('describes lockfiles without a model, and flags files whose summary fails', async () => {
    const { t, admin } = await pullWith({
      'yarn.lock': 'lock\n',
      'src/b.ts': 'b\n',
    });
    const { models, calls } = fakeModels(undefined, {
      failSummary: 'src/b.ts',
    });
    await runReviews(t, models);
    const d = await review(t, admin);
    expect(calls.summarized).toEqual([]);
    expect(d.review!.classification!.files).toEqual([
      expect.objectContaining({
        path: 'src/b.ts',
        summary: 'Could not be summarized.',
      }),
      expect.objectContaining({
        path: 'yarn.lock',
        summary: 'Dependency lockfile updated.',
      }),
    ]);
    expect(d.review!.flags).toEqual([
      expect.objectContaining({
        source: 'limit',
        key: 'unsummarized',
        paths: ['src/b.ts'],
      }),
    ]);
  });

  it('flags a PR with more files than limits.max_files without calling a model', async () => {
    const { t, admin } = await pullWith(
      { 'a.txt': '1\n', 'b.txt': '2\n', 'c.txt': '3\n' },
      { policy: `${POLICY}limits:\n  max_files: 2\n` }
    );
    const { models, calls } = fakeModels();
    await runReviews(t, models);
    const d = await review(t, admin);
    expect(calls.summarized).toEqual([]);
    expect(calls.classified).toEqual([]);
    expect(d.review!.flags).toEqual([
      expect.objectContaining({ source: 'limit', key: 'max_files' }),
    ]);
  });

  it('fails the review when the classifier does not answer, and can be retried', async () => {
    const { t, admin } = await pullWith({ 'src/b.ts': 'b\n' });
    await runReviews(t, fakeModels(undefined, { failClassify: true }).models);
    const d = await review(t, admin);
    expect(d.review!.classification).toMatchObject({ status: 'failed' });
    expect(d.review!.autoMerge.state).toBe('blocked');

    const res = await call(t, '/api/repos/octocat/app/pulls/1/review/retry', {
      cookie: admin,
      method: 'POST',
    });
    expect(res.status).toBe(200);
    await runReviews(t, fakeModels().models);
    await settle(t);
    expect((await pullRow(t))!.state).toBe('merged');
  });

  it('does not auto-merge a PR a maintainer opted out, until they opt it back in', async () => {
    const { t, admin } = await pullWith({ 'src/b.ts': 'b\n' });
    await call(t, '/api/repos/octocat/app/pulls/1/auto-merge', {
      cookie: admin,
      method: 'PUT',
      json: { enabled: false },
    });
    await runReviews(t, fakeModels().models);
    await settle(t);
    expect((await pullRow(t))!.state).toBe('open');
    expect((await review(t, admin)).review!.autoMerge.state).toBe('disabled');

    await call(t, '/api/repos/octocat/app/pulls/1/auto-merge', {
      cookie: admin,
      method: 'PUT',
      json: { enabled: true },
    });
    await settle(t);
    expect((await pullRow(t))!.state).toBe('merged');
  });

  it('reviews new commits from scratch: earlier approvals no longer count', async () => {
    const { t, admin, repo } = await pullWith({ 'migrations/1.sql': 'x\n' });
    const { models } = fakeModels(DATA_CHANGE);
    await call(t, '/api/repos/octocat/app/pulls/1/auto-merge', {
      cookie: admin,
      method: 'PUT',
      json: { enabled: false },
    });
    await runReviews(t, models);
    const flag = (await review(t, admin)).review!.flags[0];
    await call(
      t,
      `/api/repos/octocat/app/pulls/1/review/flags/${flag.id}/approve`,
      {
        cookie: admin,
        method: 'POST',
      }
    );
    expect((await review(t, admin)).review!.flags[0].approvedBy?.username).toBe(
      'octocat'
    );

    await commitPaths(
      repo,
      'feature',
      {
        ...APP,
        '.gitorange/review.yml': POLICY,
        'migrations/1.sql': 'x\ny\n',
      },
      'More'
    );
    // The PR page notices the new head and starts a fresh review.
    expect((await review(t, admin)).review!.classification).toBeNull();
    await settle(t);
    await runReviews(t, models);
    const d = await review(t, admin);
    expect(d.review!.flags).toHaveLength(1);
    expect(d.review!.flags[0].approvedBy).toBeNull();
  });

  it('auto-merges a conflicting PR once AI resolves the conflicts', async () => {
    const t = makeEnv({ actions: true });
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'internal' },
    });
    const repo = [...t.fake.repos.values()][0];
    const policy = { '.gitorange/review.yml': POLICY };
    const root = await commitPaths(
      repo,
      'main',
      { ...policy, 'notes.txt': 'one\ntwo\nthree\n' },
      'base'
    );
    repo.refs.set('refs/heads/feature', root);
    await commitPaths(
      repo,
      'feature',
      { ...policy, 'notes.txt': 'one\ntwo\nthree (feature)\n' },
      'Feature'
    );
    await commitPaths(
      repo,
      'main',
      { ...policy, 'notes.txt': 'one\ntwo\nTHREE\n' },
      'Main'
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Feature', base: 'main', head: 'feature' },
    });
    await settle(t);
    await runReviews(t, fakeModels().models);
    expect((await review(t, admin)).review!.autoMerge).toMatchObject({
      state: 'waiting',
      reasons: ['Resolving conflicts with AI'],
    });

    const mainTip = repo.refs.get('refs/heads/main')!;
    const resolution = t.actions.resolutions.find(
      (r) => (r.params as { resolutionId?: string }).resolutionId
    )!;
    await executeResolution(
      {
        env: t.env,
        db: drizzle(t.env.DB, { schema }),
        step,
        resolver: () => ({
          resolve: async () => ({
            status: 'done',
            explanation: 'Kept both.',
            files: { 'notes.txt': 'one\ntwo\nTHREE (feature)\n' },
            transcript: '[]',
          }),
        }),
      },
      resolution.id
    );
    const row = await pullRow(t);
    expect(row).toMatchObject({ state: 'merged', merged_automatically: 1 });
    const merged = repo.parseCommit(row!.merge_commit_sha!)!;
    expect(merged.parents).toEqual([mainTip]); // onto main's tip: linear
  });
});

describe('approvals inbox', () => {
  type Item = {
    repo: { fullName: string };
    pull: { number: number };
    reviewFailed: string | null;
    flags: { id: string; key: string; detail: string | null }[];
  };
  const inbox = async (t: TestEnv, cookie: string) =>
    (await (await call(t, '/api/approvals', { cookie })).json()) as Item[];

  it('lists unapproved flags across repositories, for people who can merge, until approved', async () => {
    const { t, admin } = await pullWith({ 'migrations/1.sql': 'x\n' });
    await call(t, '/api/repos/octocat/app/pulls/1/auto-merge', {
      cookie: admin,
      method: 'PUT',
      json: { enabled: false },
    });
    await runReviews(t, fakeModels(DATA_CHANGE).models);
    const items = await inbox(t, admin);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      repo: { fullName: 'octocat/app' },
      pull: { number: 1 },
      reviewFailed: null,
    });
    expect(items[0].flags.map((f) => f.key)).toEqual(['data_model']);
    expect(items[0].flags[0].detail).toContain('```mermaid');

    // A member who can read but not merge sees nothing to approve.
    const reader = await addMember(t, admin, 'reader');
    expect(await inbox(t, reader)).toEqual([]);

    await call(
      t,
      `/api/repos/octocat/app/pulls/1/review/flags/${items[0].flags[0].id}/approve`,
      { cookie: admin, method: 'POST' }
    );
    expect(await inbox(t, admin)).toEqual([]);
  });

  it('lists failed reviews to retry', async () => {
    const { t, admin } = await pullWith({ 'src/b.ts': 'b\n' });
    await runReviews(t, fakeModels(undefined, { failClassify: true }).models);
    const items = await inbox(t, admin);
    expect(items).toHaveLength(1);
    expect(items[0].reviewFailed).toMatch(/classifier/);
    expect(items[0].flags).toEqual([]);
  });
});

describe('code excerpts for flags', () => {
  it('takes the lines a model points at from the real diff, numbered as in the file', async () => {
    const { renderNumberedDiff, snippetLines } =
      await import('../review/classify');
    const { parseInvestigation } = await import('../review/models');
    const d = {
      path: 'a.py',
      status: 'modified' as const,
      oldHash: null,
      newHash: null,
      mode: '100644',
      additions: 2,
      deletions: 1,
      binary: false,
      tooLarge: false,
      hunks: [
        {
          oldStart: 10,
          oldLines: 3,
          newStart: 10,
          newLines: 4,
          lines: [' keep', '-old', '+new', '+newer', ' tail'],
        },
      ],
    };
    expect(renderNumberedDiff(d)).toBe(
      [
        '    10     | keep',
        '-   11 old | old',
        '+   11     | new',
        '+   12     | newer',
        '    13     | tail',
      ].join('\n')
    );
    expect(snippetLines(d, 11, 12)).toBe('-old\n+new\n+newer');
    expect(snippetLines(d, 50, 60)).toBeNull();

    // Fenced JSON, a stray fence around the diagram, bad snippets dropped.
    const parsed = parseInvestigation(
      '```json\n{"detail":"Risky.","diagram":"```mermaid\\nflowchart LR\\n  A-->B\\n```","snippets":[{"path":"a.py","start":11,"end":12,"why":"here"},{"path":"b"}],"files":["a.py"]}\n```',
      []
    );
    expect(parsed).toEqual({
      detail: 'Risky.',
      changes: [],
      diagram: 'flowchart LR\n  A-->B',
      snippets: [{ path: 'a.py', start: 11, end: 12, why: 'here' }],
      paths: ['a.py'],
    });
    expect(parseInvestigation('Plain text answer.', ['x'])).toEqual({
      detail: 'Plain text answer.',
      diagram: null,
      snippets: [],
      paths: ['x'],
      raw: true,
    });
    // An answer cut off mid-JSON (the model ran out of room) still yields its explanation…
    const cut = parseInvestigation(
      '{"detail":"Adds a table.\\n- Migrate first.","diagram":"erDiagram\\n  A {\\n    text id PK\\n  }","snippets":[{"path":"migrations/0008.sql","sta',
      []
    );
    expect(cut).toMatchObject({
      detail: 'Adds a table.\n- Migrate first.',
      diagram: 'erDiagram\n  A {\n    text id PK\n  }',
      snippets: [],
    });
    expect(cut.raw).toBeUndefined();
    // …and a JSON blob with nothing usable is never shown as the explanation.
    expect(parseInvestigation('{"detail": "half a sen', [])).toMatchObject({
      detail: '',
      raw: true,
    });
  });
});

describe('what the investigating model reads', () => {
  it('leaves out generated files and lockfiles, caps huge diffs, and reads source first', async () => {
    const { diffsFor } = await import('../review/classify');
    const { ArtifactsRepoClient } = await import('../git/remote');
    const { GitService } = await import('../git/service');
    const { createFakeArtifacts } = await import('./helpers/fake-artifacts');
    const fake = createFakeArtifacts();
    await fake.binding.create('r');
    const repo = fake.repos.get('r')!;
    const base = await commitPaths(repo, 'main', { 'src/a.ts': 'a\n' }, 'base');
    const huge = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    const head = await commitPaths(
      repo,
      'main',
      {
        'src/a.ts': 'a\nb\n',
        'docs/guide.md': 'guide\n',
        'worker/src/__tests__/a.test.ts': 'test\n',
        'migrations/meta/0008_snapshot.json': huge,
        'yarn.lock': 'lock\n',
        'src/big.ts': huge,
      },
      'change'
    );
    const git = new GitService(new ArtifactsRepoClient(fake.binding, 'r'));
    const [from, to] = await Promise.all([git.commit(base), git.commit(head)]);
    const changes = await git.diffTrees(from!.treeHash, to!.treeHash);
    const { ignoreMatcher } = await import('../review/ignore');
    const text = await diffsFor(
      git,
      changes,
      [],
      ignoreMatcher('migrations/meta/*.json')
    );
    expect(text).not.toContain('--- migrations/meta/0008_snapshot.json');
    expect(text).not.toContain('--- yarn.lock');
    expect(text).toContain(
      'Ignored (lockfiles and .orangeignore), not shown: migrations/meta/0008_snapshot.json, yarn.lock'
    );
    expect(text).toContain("(the rest of this file's diff is not shown)");
    // Source, then tests, then docs.
    const at = (p: string) => text.indexOf(`--- ${p}`);
    expect(at('src/a.ts')).toBeLessThan(at('worker/src/__tests__/a.test.ts'));
    expect(at('worker/src/__tests__/a.test.ts')).toBeLessThan(
      at('docs/guide.md')
    );
    expect(text.length).toBeLessThan(130 * 1024);
  });
});

describe('investigations read only the relevant files', () => {
  it('investigates only the files the fast model picked, and drops empty diagrams', async () => {
    const { t, admin } = await pullWith({
      'migrations/1.sql': 'CREATE TABLE x (id TEXT);\n',
      'src/unrelated.ts': 'export const u = 1;\n',
    });
    const { models, calls } = fakeModels(DATA_CHANGE);
    const asked: string[] = [];
    models.selectFiles = async ({ paths }) => {
      asked.push(...paths);
      return ['migrations/1.sql', 'not/a/changed/file.ts'];
    };
    const investigate = models.investigate;
    models.investigate = async (req) => ({
      ...(await investigate(req)),
      diagram: 'erDiagram',
    });
    await runReviews(t, models);
    expect(asked.sort()).toEqual(['migrations/1.sql', 'src/unrelated.ts']);
    const req = calls.investigated[0];
    expect(req.diffs).toContain('--- migrations/1.sql');
    expect(req.diffs).not.toContain('--- src/unrelated.ts');
    expect(req.diffs).toContain(
      'Not shown (judged unrelated to this flag from their summaries): src/unrelated.ts'
    );
    const flag = (await review(t, admin)).review!.flags[0];
    expect(flag.detail).not.toContain('```mermaid');
  });
});

describe('flags show before and after, and their diagram', () => {
  it('renders the changes as a before/after table and keeps one-line or escaped diagrams', async () => {
    const { parseInvestigation, mermaidSource } =
      await import('../review/models');
    const parsed = parseInvestigation(
      JSON.stringify({
        detail: 'Adds the instance_settings table.',
        changes: [
          {
            what: 'instance_settings',
            before: 'none',
            after: 'key, value | json',
          },
          { what: '', before: 'x', after: 'y' },
        ],
        diagram: 'erDiagram\\n  SETTINGS {\\n    text key PK "NEW"\\n  }',
        snippets: [],
        files: [],
      }),
      []
    );
    expect(parsed.changes).toEqual([
      { what: 'instance_settings', before: 'none', after: 'key, value | json' },
    ]);
    // A literal "\n" from the model becomes a real line break.
    expect(parsed.diagram).toBe(
      'erDiagram\n  SETTINGS {\n    text key PK "NEW"\n  }'
    );
    expect(mermaidSource('flowchart LR\nA-->B')).toBe('flowchart LR\nA-->B');
    // Crammed onto one line (what models do with a single string): not drawable.
    expect(mermaidSource('erDiagram SETTINGS { text key PK }')).toBeNull();
    // As a list of lines, comments dropped.
    expect(
      parseInvestigation(
        JSON.stringify({
          detail: 'd',
          changes: [],
          diagram: ['erDiagram', '%% note', 'X {', 'text id PK', '}'],
          snippets: [],
          files: [],
        }),
        []
      ).diagram
    ).toBe('erDiagram\nX {\ntext id PK\n}');
    expect(mermaidSource('erDiagram')).toBeNull();
    expect(mermaidSource('')).toBeNull();

    const { t, admin } = await pullWith({
      'migrations/1.sql': 'CREATE TABLE x (id TEXT);\n',
    });
    const { models } = fakeModels(DATA_CHANGE);
    const investigate = models.investigate;
    models.investigate = async (req) => ({
      ...(await investigate(req)),
      detail: 'Adds table x.',
      changes: [{ what: 'x', before: 'none', after: 'id | text' }],
    });
    await runReviews(t, models);
    const flag = (await review(t, admin)).review!.flags[0];
    expect(flag.detail).toContain('| | Before | After |');
    expect(flag.detail).toContain('| **x** | none | id \\| text |');
    expect(flag.detail).toContain('```mermaid\nerDiagram');
  });
});

describe('.orangeignore', () => {
  it('reads .gitignore-style patterns', async () => {
    const { ignoreMatcher } = await import('../review/ignore');
    const ignored = ignoreMatcher(
      [
        '# generated',
        'worker-configuration.d.ts',
        'migrations/meta/',
        '*.snap',
        'dist/**/*.js',
        '/build',
        '!dist/keep.js',
      ].join('\n')
    );
    for (const p of [
      'worker/worker-configuration.d.ts',
      'migrations/meta/0008_snapshot.json',
      'src/__snapshots__/a.test.ts.snap',
      'dist/a/b.js',
      'dist/x.js',
      'build/out.txt',
      'yarn.lock',
      'packages/a/package-lock.json',
    ])
      expect(ignored(p), p).toBe(true);
    for (const p of [
      'worker/src/index.ts',
      'migrations/0008_x.sql',
      'dist/keep.js',
      'src/build/x.ts',
      'snap.ts',
    ])
      expect(ignored(p), p).toBe(false);
    // No file: only lockfiles.
    expect(ignoreMatcher(null)('yarn.lock')).toBe(true);
    expect(ignoreMatcher(null)('gen.d.ts')).toBe(false);
  });

  it("skips ignored files on the target branch's list, but not ones a pull request adds to it", async () => {
    const { t, admin } = await pullWith(
      {
        'src/gen.d.ts': 'export type X = 1;\n',
        'src/vendor.js': 'var v;\n',
        // The branch's own .orangeignore doesn't count.
        '.orangeignore': 'src/gen.d.ts\nsrc/vendor.js\n',
      },
      { base: { '.orangeignore': 'src/gen.d.ts\n' } }
    );
    const { models, calls } = fakeModels({});
    await runReviews(t, models);
    expect(calls.summarized).not.toContain('src/gen.d.ts');
    expect(calls.summarized).toContain('src/vendor.js');
    const files = (await review(t, admin)).review!.classification!.files;
    expect(files.find((f) => f.path === 'src/gen.d.ts')?.summary).toBe(
      'Changed; ignored by .orangeignore.'
    );
  });
});
