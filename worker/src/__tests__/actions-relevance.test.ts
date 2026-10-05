import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { prClassifications } from '../db/app.schema';
import { relevanceContext, workersAiRelevance } from '../actions/relevance';
import { call } from './helpers/app';
import { commitPaths } from './helpers/seed';
import {
  harness,
  pushFiles,
  runDetail,
  runs,
  scriptLog,
  scriptOutputs,
  setup,
  type Setup,
} from './helpers/actions';
import type { ClassifierAnswer } from '../db/app.schema';
import type { ClefQuestion } from '../review/models';
import {
  decideRelevance,
  moduleQuestion,
  parseRelevanceInputs,
  RelevanceInputError,
  relevanceScript,
  relevanceState,
  WORKFLOW_QUESTION,
  type ChangedFile,
  type RelevanceContext,
  type RelevanceModel,
  type RelevanceModelFor,
} from '../actions/relevance';

const INPUTS = parseRelevanceInputs({
  'skip-below': '0.2',
  modules:
    'stacking: Stack discovery and the stack tree\nmerge-queue: Merging and conflicts\n',
});
const file = (path: string, summary: string | null = null): ChangedFile => ({
  path,
  additions: 3,
  deletions: 1,
  summary,
});
const PR = (files: ChangedFile[] | null): RelevanceContext => ({
  event: 'pull_request',
  defaultBranchPush: null,
  title: 'Tidy the stack view',
  pullRequestId: 'pr-1',
  files,
});
const noul = (value: number): ClassifierAnswer => ({ type: 'noul', value });

/** A fake Clef: fixed answers; records what it was asked. */
function clef(answers: Record<string, ClassifierAnswer> | Error) {
  const calls: {
    state: Record<string, unknown>;
    questions: Record<string, ClefQuestion>;
  }[] = [];
  const model: RelevanceModel = {
    async decide(state, questions) {
      calls.push({ state, questions });
      if (answers instanceof Error) throw answers;
      return answers;
    },
  };
  return { model, calls };
}
const ALL_TRUE = {
  run: 'true',
  'run-stacking': 'true',
  'run-merge-queue': 'true',
};

describe('gitorange/relevance inputs', () => {
  it('reads modules, skip-below, and always-run-paths', () => {
    expect(
      parseRelevanceInputs({
        modules:
          '# comment\nstacking: Stack discovery\n\nmerge-queue:   Merging  \n',
        'always-run-paths': 'worker/src/__tests__/helpers/**\n# no\n',
      })
    ).toEqual({
      modules: [
        { name: 'stacking', description: 'Stack discovery' },
        { name: 'merge-queue', description: 'Merging' },
      ],
      skipBelow: 0.2,
      alwaysRunPaths: ['worker/src/__tests__/helpers/**'],
    });
  });

  it('rejects inputs it cannot use, naming the input', () => {
    const bad: Record<string, string>[] = [
      { modules: '' },
      { modules: 'no description here' },
      { modules: 'has space: x' },
      { modules: 'a: x\na: y' },
      { modules: 'a: x', 'skip-below': 'abc' },
      { modules: 'a: x', 'skip-below': '1.5' },
      { modules: 'a: x', 'skip-below': '-0.1' },
      { modules: 'a: x', 'always-run-paths': 'src/**\n!src/docs/**' },
    ];
    for (const withArgs of bad)
      expect(
        () => parseRelevanceInputs(withArgs),
        JSON.stringify(withArgs)
      ).toThrow(RelevanceInputError);
    expect(() =>
      parseRelevanceInputs({ modules: 'a: x', 'skip-below': 'abc' })
    ).toThrow(/skip-below/);
    expect(() =>
      parseRelevanceInputs({
        modules: 'a: x',
        'always-run-paths': '!docs/**',
      })
    ).toThrow(/always-run-paths: "!docs\/\*\*" can't exclude/);
  });
});

describe('gitorange/relevance decision', () => {
  it('runs everything on a push to the default branch, without asking Clef', async () => {
    const { model, calls } = clef(new Error('must not be called'));
    const d = await decideRelevance(
      INPUTS,
      { ...PR([file('docs/a.md')]), event: 'push', defaultBranchPush: 'main' },
      model
    );
    expect(d.outputs).toEqual(ALL_TRUE);
    expect(d.log[0]).toContain('push to the default branch (main)');
    expect(calls).toHaveLength(0);
  });

  it('runs everything when a changed path is always-run (defaults and the input)', async () => {
    const custom = parseRelevanceInputs({
      modules: 'stacking: x\nmerge-queue: y',
      'always-run-paths': 'worker/src/__tests__/helpers/**',
    });
    for (const path of [
      'package.json',
      'yarn.lock',
      '.github/workflows/ci.yml',
      'worker/vitest.config.ts',
      'wrangler.test.jsonc',
      'tsconfig.app.json',
      'worker/src/__tests__/helpers/app.ts',
    ]) {
      const { model, calls } = clef(new Error('must not be called'));
      const d = await decideRelevance(
        custom,
        PR([file('README.md'), file(path)]),
        model
      );
      expect(d.outputs, path).toEqual(ALL_TRUE);
      expect(d.log[0], path).toContain(path);
      expect(calls, path).toHaveLength(0);
    }
  });

  it('runs everything when Clef is not configured', async () => {
    const d = await decideRelevance(INPUTS, PR([file('a.ts')]), null);
    expect(d.outputs).toEqual(ALL_TRUE);
    expect(d.log[0]).toContain('Clef is not configured');
  });

  it('runs everything when no changed paths can be read', async () => {
    for (const files of [null, []]) {
      const { model, calls } = clef({});
      const d = await decideRelevance(INPUTS, PR(files), model);
      expect(d.outputs).toEqual(ALL_TRUE);
      expect(d.log[0]).toContain('no changed paths');
      expect(calls).toHaveLength(0);
    }
  });

  it('runs everything when Clef fails', async () => {
    const { model } = clef(new Error('503 from Workers AI'));
    const d = await decideRelevance(INPUTS, PR([file('a.ts')]), model);
    expect(d.outputs).toEqual(ALL_TRUE);
    expect(d.log[0]).toContain('503 from Workers AI');
  });

  it('an unusable answer runs everything', async () => {
    const good = {
      [WORKFLOW_QUESTION]: noul(0.9),
      [moduleQuestion(0)]: noul(0.9),
      [moduleQuestion(1)]: noul(0.9),
    };
    const broken: Record<string, ClassifierAnswer>[] = [
      { ...good, [WORKFLOW_QUESTION]: noul(1.5) },
      { ...good, [moduleQuestion(1)]: noul(Number.NaN) },
      { ...good, [moduleQuestion(0)]: noul(-0.1) },
      {
        ...good,
        [WORKFLOW_QUESTION]: {
          type: 'choice',
          value: 'yes',
          confidence: 1,
          probabilities: {},
        },
      },
      { [WORKFLOW_QUESTION]: noul(0.9), [moduleQuestion(0)]: noul(0.9) },
      {
        ...good,
        [moduleQuestion(0)]: {
          type: 'noul',
          value: '0.9',
        } as unknown as ClassifierAnswer,
      },
    ];
    for (const answers of broken) {
      const d = await decideRelevance(
        INPUTS,
        PR([file('a.ts')]),
        clef(answers).model
      );
      expect(d.outputs, JSON.stringify(answers)).toEqual(ALL_TRUE);
      expect(d.log[0]).toContain('unusable answer');
    }
  });

  it('skips a module only below skip-below; equal or above runs', async () => {
    const { model, calls } = clef({
      [WORKFLOW_QUESTION]: noul(0.9),
      [moduleQuestion(0)]: noul(0.2),
      [moduleQuestion(1)]: noul(0.19),
    });
    const d = await decideRelevance(
      INPUTS,
      PR([file('worker/src/stack/tree.ts', 'Renames a variable.')]),
      model
    );
    expect(d.outputs).toEqual({
      run: 'true',
      'run-stacking': 'true',
      'run-merge-queue': 'false',
    });
    expect(d.log).toEqual([
      'Asked Clef about 1 changed file; skipping only below 0.2.',
      '  run (whole workflow): 0.90 → run',
      '  run-stacking: 0.20 → run',
      '  run-merge-queue: 0.19 → skip',
    ]);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions)).toEqual([
      WORKFLOW_QUESTION,
      moduleQuestion(0),
      moduleQuestion(1),
    ]);
    expect(calls[0].questions[moduleQuestion(0)].instructions).toContain(
      'Stack discovery and the stack tree'
    );
    expect(calls[0].state).toMatchObject({
      title: 'Tidy the stack view',
      changed_files: '- worker/src/stack/tree.ts (+3 −1): Renames a variable.',
    });
    for (const q of Object.values(calls[0].questions))
      expect(q.instructions).toContain(
        "Judge only from the changed files. The title and message are the author's claims; they can make a change more relevant but never make a changed file irrelevant."
      );
  });

  it('never sends the description; lists uncounted files without counts', () => {
    const state = relevanceState(
      PR([
        file('a.ts'),
        { path: 'b.ts', additions: null, deletions: null, summary: null },
      ]),
      INPUTS.modules
    );
    expect(state).not.toHaveProperty('description');
    expect(JSON.stringify(state)).not.toContain('Renames a variable');
    expect(state.changed_files).toBe('- a.ts (+3 −1)\n- b.ts');
  });

  it('a whole-workflow skip skips every module', async () => {
    const { model } = clef({
      [WORKFLOW_QUESTION]: noul(0.05),
      [moduleQuestion(0)]: noul(0.9),
      [moduleQuestion(1)]: noul(0.9),
    });
    const d = await decideRelevance(INPUTS, PR([file('docs/a.md')]), model);
    expect(d.outputs).toEqual({
      run: 'false',
      'run-stacking': 'false',
      'run-merge-queue': 'false',
    });
    expect(d.log[2]).toBe(
      '  run-stacking: 0.90 → skip (the whole workflow is skipped)'
    );
  });

  it('lists at most 300 files to Clef', () => {
    const files = Array.from({ length: 450 }, (_, i) => file(`src/f${i}.ts`));
    const state = relevanceState(PR(files), INPUTS.modules);
    const lines = String(state.changed_files).split('\n');
    expect(lines).toHaveLength(301);
    expect(lines[300]).toBe('- … and 150 more files');
  });

  it('writes the log and the outputs as a bash script', () => {
    const script = relevanceScript({
      outputs: { run: 'true', 'run-stacking': 'false' },
      log: ["Running everything: it's a test."],
      asked: false,
    });
    expect(script).toBe(
      [
        `echo 'Running everything: it'\\''s a test.'`,
        `echo 'run=true' >> "$GITHUB_OUTPUT"`,
        `echo 'run-stacking=false' >> "$GITHUB_OUTPUT"`,
      ].join('\n')
    );
  });
});

const WF = `on:
  push:
  pull_request:
jobs:
  noop:
    runs-on: ubuntu-latest
    steps:
      - run: true
`;

/** Starts `branch` at `from`'s tip, as `git checkout -b` would. */
const branchFrom = (s: Setup, branch: string, from = 'main') =>
  s.repo.refs.set(
    `refs/heads/${branch}`,
    s.repo.refs.get(`refs/heads/${from}`)!
  );

async function repoRow(s: Setup) {
  return (await s.t.env.DB.prepare(
    "SELECT id, artifacts_name AS artifactsName FROM repositories WHERE name = 'app'"
  ).first<{ id: string; artifactsName: string }>())!;
}

async function openPr(s: Setup) {
  const res = await call(s.t, '/api/repos/octocat/app/pulls', {
    cookie: s.admin,
    json: {
      title: 'Walk the stack',
      body: 'Adds a walker.',
      base: 'main',
      head: 'feature',
    },
  });
  expect(res.status).toBe(201);
  return (await s.t.env.DB.prepare(
    'SELECT id FROM pull_requests WHERE number = 1'
  ).first<{ id: string }>())!.id;
}

describe('gitorange/relevance reads the change', () => {
  it("reads a pull request's title and its whole change since it branched", async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': WF });
    branchFrom(s, 'feature');
    await pushFiles(s, 'feature', {
      '.github/workflows/ci.yml': WF,
      'worker/src/stack/walk.ts': 'one\n',
    });
    const head = await pushFiles(s, 'feature', {
      '.github/workflows/ci.yml': WF,
      'worker/src/stack/walk.ts': 'one\ntwo\n',
      'worker/src/stack/tree.ts': 'tree\n',
    });
    // main moves on after the branch: its change is not the pull request's.
    await pushFiles(s, 'main', {
      '.github/workflows/ci.yml': WF,
      'worker/src/main-only.ts': 'm\n',
    });
    const prId = await openPr(s);
    const repo = await repoRow(s);
    const rc = await relevanceContext(
      s.t.env,
      drizzle(s.t.env.DB, { schema }),
      {
        repoId: repo.id,
        artifactsName: repo.artifactsName,
        event: 'pull_request',
        ref: 'refs/pull/1/head',
        headSha: head,
        defaultBranch: 'main',
      }
    );
    expect(rc).toEqual({
      event: 'pull_request',
      defaultBranchPush: null,
      title: 'Walk the stack',
      pullRequestId: prId,
      files: [
        {
          path: 'worker/src/stack/tree.ts',
          additions: 1,
          deletions: 0,
          summary: null,
        },
        {
          path: 'worker/src/stack/walk.ts',
          additions: 2,
          deletions: 0,
          summary: null,
        },
      ],
    });
  });

  it("uses the auto-merge review's one-liners when that review finished for this commit", async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': WF });
    branchFrom(s, 'feature');
    const head = await pushFiles(s, 'feature', {
      '.github/workflows/ci.yml': WF,
      'worker/src/stack/walk.ts': 'one\ntwo\n',
    });
    const prId = await openPr(s);
    const db = drizzle(s.t.env.DB, { schema });
    await db.insert(prClassifications).values({
      id: crypto.randomUUID(),
      pullRequestId: prId,
      headSha: head,
      policySha: 'p'.repeat(40),
      status: 'done',
      summaryModel: '@cf/zai-org/glm-5.3-flash',
      classifierModel: '@cf/cloudflare/clef',
      files: [
        {
          path: 'worker/src/stack/walk.ts',
          status: 'added',
          additions: 2,
          deletions: 0,
          summary: 'Adds the stack walker.',
        },
      ],
      answers: {},
      verdict: 'auto',
      createdAt: new Date(),
      finishedAt: new Date(),
    });
    const repo = await repoRow(s);
    const rc = await relevanceContext(s.t.env, db, {
      repoId: repo.id,
      artifactsName: repo.artifactsName,
      event: 'pull_request',
      ref: 'refs/pull/1/head',
      headSha: head,
      defaultBranch: 'main',
    });
    expect(rc.files).toEqual([
      {
        path: 'worker/src/stack/walk.ts',
        additions: 2,
        deletions: 0,
        summary: 'Adds the stack walker.',
      },
    ]);
  });

  it("reads a pushed commit's subject, and nothing for a push to the default branch", async () => {
    const s = await setup();
    const repo = await repoRow(s);
    const db = drizzle(s.t.env.DB, { schema });
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': WF });
    branchFrom(s, 'feature');
    const head = await pushFiles(
      s,
      'feature',
      { '.github/workflows/ci.yml': WF, 'docs/x.md': '# x\n' },
      'Document x\n\nExplains x.'
    );
    const long = await pushFiles(
      s,
      'feature',
      { '.github/workflows/ci.yml': WF, 'docs/x.md': '# x\ny\n' },
      `${'z'.repeat(250)}\n\nBody that must not reach Clef.`
    );
    const base = {
      repoId: repo.id,
      artifactsName: repo.artifactsName,
      defaultBranch: 'main',
    };
    expect(
      await relevanceContext(s.t.env, db, {
        ...base,
        event: 'push',
        ref: 'refs/heads/feature',
        headSha: head,
      })
    ).toMatchObject({
      title: 'Document x',
      files: [{ path: 'docs/x.md', additions: 1, deletions: 0, summary: null }],
    });
    const longRc = await relevanceContext(s.t.env, db, {
      ...base,
      event: 'push',
      ref: 'refs/heads/feature',
      headSha: long,
    });
    expect(longRc.title).toBe('z'.repeat(200));
    expect(JSON.stringify(longRc)).not.toContain('must not reach');
    expect(
      await relevanceContext(s.t.env, db, {
        ...base,
        event: 'push',
        ref: 'refs/heads/main',
        headSha: s.repo.refs.get('refs/heads/main')!,
      })
    ).toMatchObject({ defaultBranchPush: 'main', files: null });
  });

  it('judges a branch push on its whole change against the default branch', async () => {
    const s = await setup();
    const repo = await repoRow(s);
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': WF });
    branchFrom(s, 'feature');
    // The first commit touches package.json; the pushed tip only adds docs.
    await pushFiles(s, 'feature', {
      '.github/workflows/ci.yml': WF,
      'package.json': '{}\n',
    });
    const head = await pushFiles(s, 'feature', {
      '.github/workflows/ci.yml': WF,
      'package.json': '{}\n',
      'docs/x.md': '# x\n',
    });
    const rc = await relevanceContext(
      s.t.env,
      drizzle(s.t.env.DB, { schema }),
      {
        repoId: repo.id,
        artifactsName: repo.artifactsName,
        event: 'push',
        ref: 'refs/heads/feature',
        headSha: head,
        defaultBranch: 'main',
      }
    );
    expect(rc.files?.map((f) => f.path)).toEqual(['docs/x.md', 'package.json']);
    const { model, calls } = clef({
      [WORKFLOW_QUESTION]: noul(0),
      [moduleQuestion(0)]: noul(0),
      [moduleQuestion(1)]: noul(0),
    });
    expect((await decideRelevance(INPUTS, rc, model)).outputs).toEqual(
      ALL_TRUE
    );
    expect(calls).toHaveLength(0);
  });

  it('reads no changed paths for events other than push and pull_request', async () => {
    const s = await setup();
    const repo = await repoRow(s);
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': WF });
    branchFrom(s, 'feature');
    const head = await pushFiles(s, 'feature', {
      '.github/workflows/ci.yml': WF,
      'docs/x.md': '# x\n',
    });
    for (const event of ['workflow_dispatch', 'schedule']) {
      const rc = await relevanceContext(
        s.t.env,
        drizzle(s.t.env.DB, { schema }),
        {
          repoId: repo.id,
          artifactsName: repo.artifactsName,
          event,
          ref: 'refs/heads/feature',
          headSha: head,
          defaultBranch: 'main',
        }
      );
      expect(rc.files, event).toBeNull();
    }
  });

  it('counts lines for the first 60 files only', async () => {
    const s = await setup();
    const repo = await repoRow(s);
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': WF });
    branchFrom(s, 'feature');
    const many: Record<string, string> = { '.github/workflows/ci.yml': WF };
    for (let i = 0; i < 70; i++)
      many[`src/f${String(i).padStart(2, '0')}.ts`] = 'x\n';
    const head = await pushFiles(s, 'feature', many);
    const rc = await relevanceContext(
      s.t.env,
      drizzle(s.t.env.DB, { schema }),
      {
        repoId: repo.id,
        artifactsName: repo.artifactsName,
        event: 'push',
        ref: 'refs/heads/feature',
        headSha: head,
        defaultBranch: 'main',
      }
    );
    expect(rc.files).toHaveLength(70);
    expect(rc.files!.filter((f) => f.additions === 1)).toHaveLength(60);
    expect(rc.files![60]).toEqual({
      path: 'src/f60.ts',
      additions: null,
      deletions: null,
      summary: null,
    });
  });

  it('reads no changed paths for a root commit', async () => {
    const s = await setup();
    const repo = await repoRow(s);
    // A branch with no history in common: its first commit has no parent.
    const root = await commitPaths(
      s.repo,
      'orphan',
      { 'a.ts': 'a' },
      'Start over'
    );
    const rc = await relevanceContext(
      s.t.env,
      drizzle(s.t.env.DB, { schema }),
      {
        repoId: repo.id,
        artifactsName: repo.artifactsName,
        event: 'push',
        ref: 'refs/heads/orphan',
        headSha: root,
        defaultBranch: 'main',
      }
    );
    expect(rc.files).toBeNull();
  });
});

describe('gitorange/relevance on Workers AI', () => {
  it('asks Clef through AI Gateway and records usage under ci-relevance', async () => {
    const s = await setup();
    const repo = await repoRow(s);
    const calls: { model: string; input: any; options: any }[] = [];
    const env = {
      ...s.t.env,
      AI_GATEWAY: 'default',
      AI: {
        run: async (model: string, input: unknown, options: unknown) => {
          calls.push({ model, input, options });
          return {
            answers: { workflow: { type: 'noul', noul: 0.7 } },
            usage: { prompt_tokens: 50, completion_tokens: 3 },
          };
        },
      },
    } as unknown as CloudflareBindings;
    const answers = await workersAiRelevance(env, {
      repositoryId: repo.id,
      pullRequestId: null,
    }).decide(
      { title: 't' },
      { workflow: { type: 'noul', instructions: 'q' } }
    );
    expect(answers).toEqual({ workflow: { type: 'noul', value: 0.7 } });
    expect(calls[0].model).toBe('@cf/cloudflare/clef');
    expect(calls[0].input).toEqual({
      model: 'clef',
      state: { title: 't' },
      questions: { workflow: { type: 'noul', instructions: 'q' } },
    });
    expect(calls[0].options.gateway.metadata.feature).toBe('ci-relevance');
    const row = await s.t.env.DB.prepare(
      'SELECT feature, model, repository_id, tokens_in, tokens_out, agent_step_id FROM ai_usage'
    ).first();
    // An Actions job is not an agent run step: the usage row stands alone.
    expect(row).toEqual({
      feature: 'ci-relevance',
      model: '@cf/cloudflare/clef',
      repository_id: repo.id,
      tokens_in: 50,
      tokens_out: 3,
      agent_step_id: null,
    });
  });

  it('throws when Clef returns no answers (the decision then runs everything)', async () => {
    const s = await setup();
    const env = {
      ...s.t.env,
      AI: { run: async () => ({}) },
    } as unknown as CloudflareBindings;
    await expect(
      workersAiRelevance(env, {
        repositoryId: (await repoRow(s)).id,
        pullRequestId: null,
      }).decide({}, {})
    ).rejects.toThrow('Clef returned no answers');
  });
});

const GATED = `name: CI
on:
  push:
  pull_request:
jobs:
  gate:
    runs-on: ubuntu-latest
    outputs:
      run: \${{ steps.relevance.outputs.run }}
      run-stacking: \${{ steps.relevance.outputs.run-stacking }}
      run-merge-queue: \${{ steps.relevance.outputs.run-merge-queue }}
    steps:
      - id: relevance
        uses: gitorange/relevance@v1
        with:
          skip-below: 0.2
          modules: |
            stacking: Stack discovery and the stack tree
            merge-queue: Merging and conflict resolution
  stacking:
    needs: gate
    if: always() && (needs.gate.result == 'skipped' || needs.gate.outputs.run-stacking == 'true')
    runs-on: ubuntu-latest
    steps:
      - run: test-stacking
  merge-queue:
    needs: gate
    if: always() && (needs.gate.result == 'skipped' || needs.gate.outputs.run-merge-queue == 'true')
    runs-on: ubuntu-latest
    steps:
      - run: test-merge-queue
`;

/** A fake Clef for executeRun; `calls` counts how often it was asked. */
function fakeClef(answers: Record<string, ClassifierAnswer>) {
  const calls: Record<string, unknown>[] = [];
  const relevance: RelevanceModelFor = () => ({
    async decide(state) {
      calls.push(state);
      return answers;
    },
  });
  return { relevance, calls };
}

async function gatedPr(s: Setup, files: Record<string, string>) {
  await pushFiles(s, 'main', { '.github/workflows/ci.yml': GATED });
  branchFrom(s, 'feature');
  await pushFiles(s, 'feature', {
    '.github/workflows/ci.yml': GATED,
    ...files,
  });
  await openPr(s);
  return (await runs(s.t, s.admin)).runs.find(
    (r) => r.event === 'pull_request'
  )!;
}

const stepLog = async (s: Setup, run: number, jobId: string, step: number) =>
  (
    await call(
      s.t,
      `/api/repos/octocat/app/actions/runs/${run}/jobs/${jobId}/steps/${step}/logs`,
      { cookie: s.admin }
    )
  ).text();

describe('gitorange/relevance in a workflow', () => {
  it("gates each module job on the gate's outputs", async () => {
    const s = await setup();
    const run = await gatedPr(s, { 'worker/src/stack/walk.ts': 'one\n' });
    const { relevance, calls } = fakeClef({
      workflow: noul(0.9),
      module_0: noul(0.8),
      module_1: noul(0.05),
    });
    const h = harness(
      s.t,
      (r) => ({ outputs: scriptOutputs(r), log: scriptLog(r) }),
      { relevance }
    );
    expect(await h.run(run.id)).toBe('success');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      title: 'Walk the stack',
      changed_files: '- worker/src/stack/walk.ts (+1 −0)',
    });
    const ran = h.requests.map((r) => r.argv[r.argv.length - 1]);
    expect(ran).toContain('test-stacking');
    expect(ran).not.toContain('test-merge-queue');
    const { jobs } = await runDetail(s.t, s.admin, run.runNumber);
    expect(Object.fromEntries(jobs.map((j) => [j.name, j.conclusion]))).toEqual(
      {
        gate: 'success',
        stacking: 'success',
        'merge-queue': 'skipped',
      }
    );
    const log = await stepLog(
      s,
      run.runNumber,
      jobs.find((j) => j.name === 'gate')!.id,
      2
    );
    expect(log).toContain('run (whole workflow): 0.90 → run');
    expect(log).toContain('run-merge-queue: 0.05 → skip');
  });

  it('skips every module when the whole workflow is irrelevant, and the run still passes', async () => {
    const s = await setup();
    const run = await gatedPr(s, { 'docs/notes.md': '# notes\n' });
    const { relevance } = fakeClef({
      workflow: noul(0.02),
      module_0: noul(0.9),
      module_1: noul(0.9),
    });
    const h = harness(s.t, (r) => ({ outputs: scriptOutputs(r) }), {
      relevance,
    });
    expect(await h.run(run.id)).toBe('success');
    const { run: after, jobs } = await runDetail(s.t, s.admin, run.runNumber);
    expect(after.conclusion).toBe('success');
    expect(
      jobs
        .filter((j) => j.conclusion === 'skipped')
        .map((j) => j.name)
        .sort()
    ).toEqual(['merge-queue', 'stacking']);
  });

  it('runs everything on a push to the default branch without asking Clef', async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': GATED });
    const [push] = (await runs(s.t, s.admin)).runs;
    const { relevance, calls } = fakeClef({});
    const h = harness(s.t, (r) => ({ outputs: scriptOutputs(r) }), {
      relevance,
    });
    expect(await h.run(push.id)).toBe('success');
    expect(calls).toHaveLength(0);
    const ran = h.requests.map((r) => r.argv[r.argv.length - 1]);
    expect(ran).toEqual(
      expect.arrayContaining(['test-stacking', 'test-merge-queue'])
    );
  });

  it('runs everything when Clef is not configured on the server', async () => {
    const s = await setup();
    const run = await gatedPr(s, { 'worker/src/stack/walk.ts': 'one\n' });
    const h = harness(s.t, (r) => ({ outputs: scriptOutputs(r) }), {
      relevance: () => null,
    });
    expect(await h.run(run.id)).toBe('success');
    const ran = h.requests.map((r) => r.argv[r.argv.length - 1]);
    expect(ran).toEqual(
      expect.arrayContaining(['test-stacking', 'test-merge-queue'])
    );
  });

  it('fails the step on bad inputs, naming the input', async () => {
    const s = await setup();
    await pushFiles(s, 'main', {
      '.github/workflows/ci.yml': GATED.replace(
        'skip-below: 0.2',
        'skip-below: lots'
      ),
    });
    const [push] = (await runs(s.t, s.admin)).runs;
    const h = harness(s.t, (r) => ({ outputs: scriptOutputs(r) }), {
      relevance: fakeClef({}).relevance,
    });
    expect(await h.run(push.id)).toBe('failure');
    const { jobs } = await runDetail(s.t, s.admin, push.runNumber);
    const gate = jobs.find((j) => j.name === 'gate')!;
    expect(gate.conclusion).toBe('failure');
    expect(await stepLog(s, push.runNumber, gate.id, 2)).toContain(
      'skip-below must be a number from 0 to 1, not "lots"'
    );
  });

  it('only runs v1', async () => {
    const s = await setup();
    await pushFiles(s, 'main', {
      '.github/workflows/ci.yml': GATED.replace(
        'gitorange/relevance@v1',
        'gitorange/relevance@v2'
      ),
    });
    const [push] = (await runs(s.t, s.admin)).runs;
    const h = harness(s.t);
    expect(await h.run(push.id)).toBe('failure');
    const { jobs } = await runDetail(s.t, s.admin, push.runNumber);
    expect(
      await stepLog(
        s,
        push.runNumber,
        jobs.find((j) => j.name === 'gate')!.id,
        2
      )
    ).toContain('Use gitorange/relevance@v1');
  });
});
