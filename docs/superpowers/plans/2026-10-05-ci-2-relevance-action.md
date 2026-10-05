# `gitorange/relevance@v1` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A built-in GitOrange Actions step, `gitorange/relevance@v1`, that asks Clef once per run whether a change could affect the workflow's tests (as a whole and per module) and sets `run` / `run-<module>` outputs that dependent jobs read in their `if:`, behind safety nets that run everything when in doubt.

**Architecture:** The decision is made in the Worker while the executor builds the step's command (like `actions/cache` computes its restore there): `relevanceContext` reads the pull request (or pushed commit), the changed paths with counts, and the auto-merge review's one-liners when that review finished for this commit; `decideRelevance` applies the safety nets and the one Clef call; `relevanceScript` turns the decision into a bash script that prints the log lines and writes the outputs to `$GITHUB_OUTPUT`, which the runner executes like any built-in. The model sits behind a small `RelevanceModel` interface (`decide(state, questions)`), injected into `executeRun` so tests use a fake.

**Tech Stack:** Workers AI (Clef `@cf/cloudflare/clef`) through AI Gateway, Drizzle/D1, Cloudflare Workflows executor (`worker/src/actions/executor.ts`), Vitest in workerd.

**Spec:** `docs/superpowers/specs/2026-10-05-ci-relevance-design.md` (section 2; Testing: "Relevance action").

**Depends on:** the job-queue plan (`2026-10-05-ci-1-job-queue.md`) being merged: this plan uses `worker/src/__tests__/helpers/actions.ts` (the `harness` with `waitForEvent`), which that plan creates.

## Global Constraints

- Executed by the runner like the existing built-ins (`actions/checkout`, `actions/setup-node`, `actions/cache`).
- Inputs: `modules` (one `name: description` per line), `skip-below` (skip only when Clef's probability that it's relevant is below this), `always-run-paths` (gitignore-style globs, added to the defaults).
- One Clef call per run: one yes/no question for the whole workflow and one per module. Clef reads the PR title and description (or the pushed commit's message), the changed paths with addition/deletion counts, and the auto-merge review's one-line summaries when that review already finished for this commit.
- Outputs `run` (`'true'`/`'false'`) and `run-<module>`; a module runs when `run` is true and its own answer is relevant.
- Safety nets, in this order; any of them makes every output `'true'`: (1) push to the repository's default branch; (2) a changed path matches `always-run-paths` or the defaults `package.json`, the lockfile, `.github/workflows/**`, `vitest.config.*`, `wrangler*.jsonc`, `tsconfig*.json`; (3) Clef isn't configured, fails, or returns an unusable answer; (4) the change has no changed paths it can read.
- Unsure means run: skip only when the probability is **below** `skip-below`.
- The step log prints each question's probability and the decision. Jobs skipped by the gate show as skipped, which auto-merge already counts as passing.
- AI usage feature `ci-relevance`.
- Non-goal: Clef deciding anything for workflows that don't use the action.
- Project rules (CLAUDE.md): `yarn` only; tests under `worker/src/__tests__/` against real D1 with fakes for models; done = `yarn test`, `yarn typecheck`, `yarn format`. No schema change.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9
  ```

## Decisions

- **Job-level `if:` already reads what the gate needs.** `needsContext` in `executor.ts` gives `needs.<job>.result` and `needs.<job>.outputs` (merged across matrix legs); `evaluateCondition` honours `always()` (no implicit `success() &&`); the tokenizer reads hyphenated names (`run-merge-queue`) as one identifier; a skipped gate has `result: 'skipped'` and no outputs. No executor change is needed for this; Task 3 pins it with tests.
- **Order of the nets vs. the Clef call.** Nets 1, 2, "Clef isn't configured" (3a) and 4 are checked before calling Clef, in the spec's order, so a push to `main` or a change with no readable paths never spends a call. "Clef fails / unusable answer" (3b) can only be known after the call.
- **Bad inputs fail the step** (`skip-below: abc`, a module line without `name: description`, duplicate or malformed names) instead of silently running everything, so a misconfigured gate is seen. An empty `skip-below` means the default `0.2`.
- **Question ids** are `workflow` and `module_<index>` (Clef only needs stable keys; names with `-` stay out of them).
- **Model:** `clef` (the review's default). Changed files listed to Clef are capped at 300, with a "… and N more files" line.

## Review Focus

- **Hyphenated module names** (`merge-queue` → `needs.gate.outputs.run-merge-queue`) — must evaluate as one property, not subtraction. Pinned in Task 3 (expression test and the end-to-end workflow, which uses `merge-queue`).
- **A pull request with hundreds of changed files** — the Clef state must stay bounded and still decide. Pinned by "lists at most 300 files to Clef" (Task 1).
- **A change whose base can't be found** (unrelated history, a root commit, a deleted base branch) — must run everything, not skip. Pinned by "reads no changed paths for a root commit" (Task 2) plus net 4 (Task 1).
- **Clef answering with numbers outside 0..1, NaN, the wrong type, or missing a module** — must run everything. Pinned by "an unusable answer runs everything" (Task 1).
- **`skip-below` mistyped** — the gate fails with a message naming the input, rather than guessing. Pinned by "fails the step on bad inputs" (Task 3).

---

## File Structure

- Create `worker/src/actions/relevance.ts` — inputs, safety nets, Clef questions/state, decision, script, context reading, and the Workers AI model.
- Modify `worker/src/lib/ai-gateway.ts` — `AiFeature` gains `'ci-relevance'`.
- Modify `worker/src/actions/executor.ts` — `ExecutorDeps.relevance`, `buildCommand` runs the action.
- Modify `worker/src/__tests__/helpers/actions.ts` — `harness` takes `relevance`; `scriptOutputs`.
- Create `worker/src/__tests__/actions-relevance.test.ts`.
- Modify `worker/src/__tests__/actions-syntax.test.ts` — gate `if:` expressions.
- Create `docs/ci-relevance.md`; modify `docs/README.md`, `README.md`, `docs/configuration.md`.

---

### Task 1: Inputs, safety nets, and the decision

**Files:**

- Create: `worker/src/actions/relevance.ts`
- Modify: `worker/src/lib/ai-gateway.ts`
- Test: `worker/src/__tests__/actions-relevance.test.ts` (new)

**Interfaces:**

- Consumes: `ignoreMatcher` (`worker/src/review/ignore.ts`, gitignore syntax, lockfiles always match), `ClefQuestion` (`worker/src/review/models.ts`), `ClassifierAnswer` (`worker/src/db/app.schema.ts`).
- Produces (in `worker/src/actions/relevance.ts`):
  - `RELEVANCE_ACTION = 'gitorange/relevance'`, `RELEVANCE_VERSION = 'v1'`, `DEFAULT_SKIP_BELOW = 0.2`, `DEFAULT_ALWAYS_RUN_PATHS: string[]`, `MAX_LISTED_FILES = 300`, `WORKFLOW_QUESTION = 'workflow'`, `moduleQuestion(i: number): string`
  - `class RelevanceInputError extends Error`
  - `interface RelevanceModule { name: string; description: string }`, `interface RelevanceInputs { modules: RelevanceModule[]; skipBelow: number; alwaysRunPaths: string[] }`
  - `parseRelevanceInputs(withArgs: Record<string, string>): RelevanceInputs` (throws `RelevanceInputError`)
  - `interface ChangedFile { path: string; additions: number; deletions: number; summary: string | null }`
  - `interface RelevanceContext { event: string; defaultBranchPush: string | null; title: string; description: string; pullRequestId: string | null; files: ChangedFile[] | null }`
  - `interface RelevanceModel { decide(state: Record<string, unknown>, questions: Record<string, ClefQuestion>): Promise<Record<string, ClassifierAnswer>> }`
  - `type RelevanceModelFor = (target: { repositoryId: string; pullRequestId: string | null }) => RelevanceModel | null`
  - `interface RelevanceDecision { outputs: Record<string, 'true' | 'false'>; log: string[]; asked: boolean }`
  - `alwaysRunMatcher(extra: string[]): (path: string) => boolean`
  - `relevanceQuestions(modules): Record<string, ClefQuestion>`, `relevanceState(rc, modules): Record<string, unknown>`
  - `decideRelevance(inputs, rc, model: RelevanceModel | null): Promise<RelevanceDecision>`
  - `relevanceScript(d: RelevanceDecision): string`
  - `AiFeature` includes `'ci-relevance'`.

- [ ] **Step 1: Write the failing tests**

Create `worker/src/__tests__/actions-relevance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
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
  description: 'Renames a variable.',
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
    ];
    for (const withArgs of bad)
      expect(
        () => parseRelevanceInputs(withArgs),
        JSON.stringify(withArgs)
      ).toThrow(RelevanceInputError);
    expect(() =>
      parseRelevanceInputs({ modules: 'a: x', 'skip-below': 'abc' })
    ).toThrow(/skip-below/);
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
      description: 'Renames a variable.',
      changed_files: '- worker/src/stack/tree.ts (+3 −1): Renames a variable.',
    });
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test worker/src/__tests__/actions-relevance.test.ts`
Expected: FAIL — `Cannot find module '../actions/relevance'`.

- [ ] **Step 3: Add the AI usage feature**

In `worker/src/lib/ai-gateway.ts`, extend `AiFeature`:

```ts
export type AiFeature =
  | 'review-summary'
  | 'review-classify'
  | 'review-select'
  | 'review-investigate'
  | 'merge-resolution'
  | 'stack-decide'
  | 'stack-explain'
  | 'ci-relevance';
```

- [ ] **Step 4: Write `worker/src/actions/relevance.ts` (decision half)**

```ts
import type { ClassifierAnswer } from '../db/app.schema';
import { ignoreMatcher } from '../review/ignore';
import type { ClefQuestion } from '../review/models';

/**
 * `gitorange/relevance@v1`: one Clef call decides whether a change could affect a workflow's tests,
 * as a whole and per module, behind safety nets that run everything when in doubt. The decision is
 * made in the Worker; the runner only prints it and writes the outputs.
 */
export const RELEVANCE_ACTION = 'gitorange/relevance';
export const RELEVANCE_VERSION = 'v1';
export const DEFAULT_SKIP_BELOW = 0.2;
/** Changes here run everything (lockfiles always do, via ignoreMatcher). gitignore syntax. */
export const DEFAULT_ALWAYS_RUN_PATHS = [
  'package.json',
  '.github/workflows/**',
  'vitest.config.*',
  'wrangler*.jsonc',
  'tsconfig*.json',
];
/** Changed files listed to Clef; the rest are counted. */
export const MAX_LISTED_FILES = 300;
export const WORKFLOW_QUESTION = 'workflow';
export const moduleQuestion = (i: number) => `module_${i}`;
const MODULE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export class RelevanceInputError extends Error {}

export interface RelevanceModule {
  name: string;
  description: string;
}
export interface RelevanceInputs {
  modules: RelevanceModule[];
  skipBelow: number;
  alwaysRunPaths: string[];
}

const lines = (text: string | undefined) =>
  (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

export function parseRelevanceInputs(
  withArgs: Record<string, string>
): RelevanceInputs {
  const modules: RelevanceModule[] = [];
  for (const line of lines(withArgs.modules)) {
    const m = /^([^:]+):\s*(.+)$/.exec(line);
    if (!m)
      throw new RelevanceInputError(
        `modules: "${line}" must look like "name: what its tests cover".`
      );
    const name = m[1].trim();
    if (!MODULE_NAME.test(name))
      throw new RelevanceInputError(
        `modules: "${name}" may contain only letters, numbers, - and _.`
      );
    if (modules.some((x) => x.name === name))
      throw new RelevanceInputError(`modules: "${name}" is listed twice.`);
    modules.push({ name, description: m[2].trim() });
  }
  if (!modules.length)
    throw new RelevanceInputError(
      'modules: list at least one module, one "name: description" per line.'
    );
  const raw = (withArgs['skip-below'] ?? '').trim();
  const skipBelow = raw === '' ? DEFAULT_SKIP_BELOW : Number(raw);
  if (!Number.isFinite(skipBelow) || skipBelow < 0 || skipBelow > 1)
    throw new RelevanceInputError(
      `skip-below must be a number from 0 to 1, not "${raw}".`
    );
  return {
    modules,
    skipBelow,
    alwaysRunPaths: lines(withArgs['always-run-paths']),
  };
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  /** The auto-merge review's one-liner, when that review finished for this commit. */
  summary: string | null;
}

export interface RelevanceContext {
  event: string;
  /** The default branch's name when this run is a push to it; null otherwise. */
  defaultBranchPush: string | null;
  /** Pull request title, or the pushed commit's subject. */
  title: string;
  /** Pull request description, or the rest of the commit message. */
  description: string;
  pullRequestId: string | null;
  /** Null when the change's paths couldn't be read. */
  files: ChangedFile[] | null;
}

/** Clef, as the action needs it; tests pass a fake. */
export interface RelevanceModel {
  decide(
    state: Record<string, unknown>,
    questions: Record<string, ClefQuestion>
  ): Promise<Record<string, ClassifierAnswer>>;
}
/** A model for one run (usage is attributed to it), or null when Clef isn't configured. */
export type RelevanceModelFor = (target: {
  repositoryId: string;
  pullRequestId: string | null;
}) => RelevanceModel | null;

export interface RelevanceDecision {
  outputs: Record<string, 'true' | 'false'>;
  log: string[];
  /** Whether Clef was called. */
  asked: boolean;
}

export function alwaysRunMatcher(extra: string[]): (path: string) => boolean {
  return ignoreMatcher([...DEFAULT_ALWAYS_RUN_PATHS, ...extra].join('\n'));
}

export function relevanceQuestions(
  modules: RelevanceModule[]
): Record<string, ClefQuestion> {
  const questions: Record<string, ClefQuestion> = {
    [WORKFLOW_QUESTION]: {
      type: 'noul',
      instructions: `Could this change affect the result of any of these test suites?\n${modules.map((m) => `- ${m.name}: ${m.description}`).join('\n')}`,
      criteria: {
        true: 'A changed file is code, configuration, or test data that one of these suites runs or depends on, directly or through shared code.',
        false:
          'Nothing any of these suites runs or depends on changed, e.g. only documentation or comments.',
      },
    },
  };
  modules.forEach((m, i) => {
    questions[moduleQuestion(i)] = {
      type: 'noul',
      instructions: `Could this change affect the tests of ${m.description}?`,
      criteria: {
        true: 'A changed file is code or configuration these tests run or depend on, directly or through shared code.',
        false: 'Nothing these tests run or depend on changed.',
      },
    };
  });
  return questions;
}

export function relevanceState(
  rc: RelevanceContext,
  modules: RelevanceModule[]
): Record<string, unknown> {
  const files = rc.files ?? [];
  const listed = files
    .slice(0, MAX_LISTED_FILES)
    .map(
      (f) =>
        `- ${f.path} (+${f.additions} −${f.deletions})${f.summary ? `: ${f.summary}` : ''}`
    );
  if (files.length > MAX_LISTED_FILES)
    listed.push(`- … and ${files.length - MAX_LISTED_FILES} more files`);
  return {
    change: rc.event === 'pull_request' ? 'pull request' : 'pushed commit',
    title: rc.title,
    description: rc.description || '(none)',
    changed_files: listed.join('\n'),
    test_suites: modules.map((m) => `${m.name}: ${m.description}`).join('\n'),
  };
}

/** The safety nets (in the spec's order), then one Clef call. Unsure means run. */
export async function decideRelevance(
  inputs: RelevanceInputs,
  rc: RelevanceContext,
  model: RelevanceModel | null
): Promise<RelevanceDecision> {
  const names = inputs.modules.map((m) => m.name);
  const runAll = (reason: string, asked = false): RelevanceDecision => ({
    outputs: Object.fromEntries([
      ['run', 'true'],
      ...names.map((n) => [`run-${n}`, 'true']),
    ]) as Record<string, 'true' | 'false'>,
    log: [
      `Running everything: ${reason}`,
      ...names.map((n) => `  run-${n}: run`),
    ],
    asked,
  });
  // 1. A push to the default branch is what lands; it always runs everything.
  if (rc.defaultBranchPush)
    return runAll(
      `this is a push to the default branch (${rc.defaultBranchPush}).`
    );
  // 2. Changes to the build, the test setup, or listed paths run everything.
  const always = alwaysRunMatcher(inputs.alwaysRunPaths);
  const hit = rc.files?.find((f) => always(f.path));
  if (hit)
    return runAll(
      `${hit.path} changed, and changes there run everything (always-run-paths).`
    );
  // 3a. No Clef on this server.
  if (!model) return runAll('Clef is not configured on this server.');
  // 4. Nothing to judge by.
  const files = rc.files;
  if (!files?.length)
    return runAll('the change has no changed paths that could be read.');
  // 3b. One Clef call; a failure or an unusable answer runs everything.
  let answers: Record<string, ClassifierAnswer>;
  try {
    answers = await model.decide(
      relevanceState(rc, inputs.modules),
      relevanceQuestions(inputs.modules)
    );
  } catch (e) {
    return runAll(
      `Clef failed (${e instanceof Error ? e.message : String(e)}).`,
      true
    );
  }
  const probability = (id: string) => {
    const a = answers[id];
    return a?.type === 'noul' && a.value >= 0 && a.value <= 1 ? a.value : null;
  };
  const overall = probability(WORKFLOW_QUESTION);
  const each = inputs.modules.map((_, i) => probability(moduleQuestion(i)));
  if (overall === null || each.some((p) => p === null))
    return runAll('Clef gave an unusable answer.', true);
  const fmt = (p: number) => p.toFixed(2);
  const run = overall >= inputs.skipBelow;
  const outputs: Record<string, 'true' | 'false'> = {
    run: run ? 'true' : 'false',
  };
  const log = [
    `Asked Clef about ${files.length} changed file${files.length === 1 ? '' : 's'}; skipping only below ${inputs.skipBelow}.`,
    `  run (whole workflow): ${fmt(overall)} → ${run ? 'run' : 'skip'}`,
  ];
  inputs.modules.forEach((m, i) => {
    const p = each[i]!;
    const yes = run && p >= inputs.skipBelow;
    outputs[`run-${m.name}`] = yes ? 'true' : 'false';
    log.push(
      `  run-${m.name}: ${fmt(p)} → ${yes ? 'run' : run ? 'skip' : 'skip (the whole workflow is skipped)'}`
    );
  });
  return { outputs, log, asked: true };
}

const quoteSh = (t: string) => `'${t.replace(/'/g, `'\\''`)}'`;

/** What the runner executes: the log lines, then the outputs. */
export function relevanceScript(d: RelevanceDecision): string {
  return [
    ...d.log.map((l) => `echo ${quoteSh(l)}`),
    ...Object.entries(d.outputs).map(
      ([k, v]) => `echo '${k}=${v}' >> "$GITHUB_OUTPUT"`
    ),
  ].join('\n');
}
```

(`a.value >= 0 && a.value <= 1` is false for `NaN`, so NaN is unusable.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test worker/src/__tests__/actions-relevance.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/actions/relevance.ts worker/src/lib/ai-gateway.ts worker/src/__tests__/actions-relevance.test.ts
git commit -m "Actions: gitorange/relevance decision, inputs, and safety nets

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 2: Reading the change, and Clef on Workers AI

**Files:**

- Modify: `worker/src/actions/relevance.ts` (append)
- Test: `worker/src/__tests__/actions-relevance.test.ts`

**Interfaces:**

- Consumes: `GitService` (`commit`, `resolve`, `mergeBase`, `diffTrees`, `fileDiffs`), `ArtifactsRepoClient`, `pullRequests`, `prClassifications` (`files: FileSummary[]`, `status: 'done'`), `classifierModel`, `toAnswers`, `ClefAnswer` (`worker/src/review/models.ts`), `aiGateway`, `recordAiUsage`, `usageFromResponse`.
- Produces:
  - `relevanceContext(env: CloudflareBindings, db: DrizzleD1Database<typeof schema>, run: { repoId: string; artifactsName: string; event: string; ref: string; headSha: string; defaultBranch: string }): Promise<RelevanceContext>` (never throws; unreadable changes give `files: null`)
  - `workersAiRelevance(env: CloudflareBindings, target: { repositoryId: string; pullRequestId: string | null }): RelevanceModel`
  - `defaultRelevance(env: CloudflareBindings): RelevanceModelFor` (Workers AI when `env.AI` exists, else null)

- [ ] **Step 1: Write the failing tests**

Add to the imports of `worker/src/__tests__/actions-relevance.test.ts`:

```ts
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { prClassifications } from '../db/app.schema';
import { relevanceContext, workersAiRelevance } from '../actions/relevance';
import { call } from './helpers/app';
import { commitPaths } from './helpers/seed';
import { pushFiles, setup, type Setup } from './helpers/actions';
```

Append:

```ts
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
  it("reads a pull request's title, description, and changed paths with counts", async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': WF });
    branchFrom(s, 'feature');
    const head = await pushFiles(s, 'feature', {
      '.github/workflows/ci.yml': WF,
      'worker/src/stack/walk.ts': 'one\ntwo\n',
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
      description: 'Adds a walker.',
      pullRequestId: prId,
      files: [
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

  it("reads a pushed commit's message, and nothing for a push to the default branch", async () => {
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
      description: 'Explains x.',
      files: [{ path: 'docs/x.md', additions: 1, deletions: 0, summary: null }],
    });
    expect(
      await relevanceContext(s.t.env, db, {
        ...base,
        event: 'push',
        ref: 'refs/heads/main',
        headSha: s.repo.refs.get('refs/heads/main')!,
      })
    ).toMatchObject({ defaultBranchPush: 'main', files: null });
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
      'SELECT feature, model, repository_id, tokens_in, tokens_out FROM ai_usage'
    ).first();
    expect(row).toEqual({
      feature: 'ci-relevance',
      model: '@cf/cloudflare/clef',
      repository_id: repo.id,
      tokens_in: 50,
      tokens_out: 3,
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test worker/src/__tests__/actions-relevance.test.ts`
Expected: FAIL — `relevanceContext` and `workersAiRelevance` are not exported.

- [ ] **Step 3: Append the context reader and the Workers AI model**

Add these imports at the top of `worker/src/actions/relevance.ts`:

```ts
import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { schema } from '../db/schema';
import { prClassifications, pullRequests } from '../db/app.schema';
import { ArtifactsRepoClient } from '../git/remote';
import { GitService } from '../git/service';
import { aiGateway } from '../lib/ai-gateway';
import { classifierModel, toAnswers, type ClefAnswer } from '../review/models';
import { recordAiUsage, usageFromResponse } from '../usage/record';
```

(Merge `ClassifierAnswer` into the existing `../db/app.schema` type import and `ClefQuestion` into the `../review/models` import, so each module is imported once.)

Append:

```ts
type Db = DrizzleD1Database<typeof schema>;

/**
 * What Clef reads about a run's change. Never throws: anything that can't be read leaves
 * `files` null, which runs everything.
 */
export async function relevanceContext(
  env: CloudflareBindings,
  db: Db,
  run: {
    repoId: string;
    artifactsName: string;
    event: string;
    ref: string;
    headSha: string;
    defaultBranch: string;
  }
): Promise<RelevanceContext> {
  const rc: RelevanceContext = {
    event: run.event,
    defaultBranchPush: null,
    title: '',
    description: '',
    pullRequestId: null,
    files: null,
  };
  if (run.event === 'push' && run.ref === `refs/heads/${run.defaultBranch}`) {
    rc.defaultBranchPush = run.defaultBranch;
    return rc;
  }
  try {
    const git = new GitService(
      new ArtifactsRepoClient(env.ARTIFACTS, run.artifactsName)
    );
    const head = await git.commit(run.headSha);
    let base: string | null = null;
    if (run.event === 'pull_request') {
      const number = Number(/^refs\/pull\/(\d+)\/head$/.exec(run.ref)?.[1]);
      const pr = Number.isInteger(number)
        ? await db
            .select()
            .from(pullRequests)
            .where(
              and(
                eq(pullRequests.repositoryId, run.repoId),
                eq(pullRequests.number, number)
              )
            )
            .get()
        : undefined;
      if (pr) {
        rc.title = pr.title;
        rc.description = pr.body;
        rc.pullRequestId = pr.id;
        const tip = await git.resolve(pr.baseRef);
        base = tip ? await git.mergeBase(tip, run.headSha) : null;
      }
    } else if (head) {
      const [subject = '', ...rest] = head.message.split('\n');
      rc.title = subject.trim();
      rc.description = rest.join('\n').trim();
      base = head.parents[0] ?? null;
    }
    const baseCommit = base ? await git.commit(base) : null;
    if (!head || !baseCommit) return rc;
    const changes = await git.diffTrees(baseCommit.treeHash, head.treeHash);
    // The auto-merge review's one-liners, when it finished for this very commit.
    const review = rc.pullRequestId
      ? await db
          .select({ files: prClassifications.files })
          .from(prClassifications)
          .where(
            and(
              eq(prClassifications.pullRequestId, rc.pullRequestId),
              eq(prClassifications.headSha, run.headSha),
              eq(prClassifications.status, 'done')
            )
          )
          .orderBy(desc(prClassifications.createdAt))
          .get()
      : undefined;
    const reviewed = new Map((review?.files ?? []).map((f) => [f.path, f]));
    const counted = reviewed.size
      ? []
      : await git.fileDiffs(changes.slice(0, MAX_LISTED_FILES));
    const counts = new Map(counted.map((d) => [d.path, d]));
    rc.files = changes.map((c) => {
      const r = reviewed.get(c.path);
      const n = r ?? counts.get(c.path);
      return {
        path: c.path,
        additions: n?.additions ?? 0,
        deletions: n?.deletions ?? 0,
        summary: r?.summary ?? null,
      };
    });
  } catch (e) {
    console.warn(
      '[actions] relevance: could not read the change',
      run.headSha,
      e
    );
    rc.files = null;
  }
  return rc;
}

/** Clef on Workers AI through AI Gateway; usage recorded under `ci-relevance`. */
export function workersAiRelevance(
  env: CloudflareBindings,
  target: { repositoryId: string; pullRequestId: string | null }
): RelevanceModel {
  return {
    async decide(state, questions) {
      const model = classifierModel('clef');
      const gateway = aiGateway(
        env,
        'ci-relevance',
        target.pullRequestId ? { pull_request: target.pullRequestId } : {}
      );
      const out = (await env.AI.run(
        model as never,
        { model: 'clef', state, questions } as never,
        (gateway ? { gateway } : undefined) as never
      )) as { answers?: Record<string, ClefAnswer> };
      await recordAiUsage(env, {
        feature: 'ci-relevance',
        model,
        repositoryId: target.repositoryId,
        pullRequestId: target.pullRequestId,
        ...usageFromResponse(out),
      });
      if (!out.answers) throw new Error('Clef returned no answers');
      return toAnswers(out.answers);
    },
  };
}

/** Workers AI when the AI binding exists; otherwise "Clef isn't configured". */
export function defaultRelevance(env: CloudflareBindings): RelevanceModelFor {
  return (target) =>
    (env as Partial<CloudflareBindings>).AI
      ? workersAiRelevance(env, target)
      : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test worker/src/__tests__/actions-relevance.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/actions/relevance.ts worker/src/__tests__/actions-relevance.test.ts
git commit -m "Actions: relevance reads the change and asks Clef on Workers AI

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 3: Run it as a built-in step; dependent jobs read its outputs

**Files:**

- Modify: `worker/src/actions/executor.ts` (`ExecutorDeps`, `runAttempt`'s `buildCommand` call, `buildCommand`)
- Modify: `worker/src/__tests__/helpers/actions.ts` (`harness` opts, `scriptOutputs`)
- Test: `worker/src/__tests__/actions-relevance.test.ts`, `worker/src/__tests__/actions-syntax.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 1–2; `evaluateCondition` (`worker/src/actions/expressions.ts`).
- Produces:
  - `ExecutorDeps.relevance?: RelevanceModelFor` (default `defaultRelevance(env)`).
  - `harness(t, onStep?, opts?: { loseEvents?: boolean; relevance?: RelevanceModelFor })`.
  - `scriptOutputs(r: StepRequest): Record<string, string>` in `helpers/actions.ts`: the `name=true|false` lines a relevance script writes to `$GITHUB_OUTPUT`, as the real runner would report them.

- [ ] **Step 1: Write the failing tests**

In `worker/src/__tests__/actions-syntax.test.ts` (inside `describe('expressions', …)`):

```ts
it('lets a job-level if: read a gate job: hyphenated outputs, its result, and always()', () => {
  const cond =
    "always() && needs.build.result == 'success' && (needs.gate.result == 'skipped' || needs.gate.outputs.run-merge-queue == 'true')";
  const needs = (gate: unknown, build = 'success') => ({
    needs: { build: { result: build, outputs: {} }, gate },
  });
  const ran = { result: 'success', outputs: { 'run-merge-queue': 'true' } };
  const skipped = {
    result: 'success',
    outputs: { 'run-merge-queue': 'false' },
  };
  expect(evaluateCondition(cond, needs(ran), { status: 'success' })).toBe(true);
  expect(evaluateCondition(cond, needs(skipped), { status: 'success' })).toBe(
    false
  );
  // On GitHub the gate itself is skipped (no outputs): every module runs.
  expect(
    evaluateCondition(cond, needs({ result: 'skipped', outputs: {} }), {
      status: 'cancelled',
    })
  ).toBe(true);
  // A failed build skips the tests even though always() is there.
  expect(
    evaluateCondition(cond, needs(ran, 'failure'), { status: 'failure' })
  ).toBe(false);
});
```

In `worker/src/__tests__/helpers/actions.ts`, add the `scriptOutputs` export (the integration tests below use it); it's part of this step because it is test scaffolding:

```ts
/** The outputs a gitorange/relevance step writes to $GITHUB_OUTPUT, as the real runner reports them. */
export function scriptOutputs(r: StepRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of script(r).matchAll(
    /^echo '([A-Za-z0-9_-]+)=(true|false)' >> "\$GITHUB_OUTPUT"$/gm
  ))
    out[m[1]] = m[2];
  return out;
}
```

Append to `worker/src/__tests__/actions-relevance.test.ts` (add `harness`, `runs`, `runDetail`, `scriptOutputs` to the `./helpers/actions` import and `RelevanceModelFor` to the `../actions/relevance` import):

```ts
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
    const h = harness(s.t, (r) => ({ outputs: scriptOutputs(r) }), {
      relevance,
    });
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test worker/src/__tests__/actions-relevance.test.ts worker/src/__tests__/actions-syntax.test.ts`
Expected: the syntax test PASSES already (confirming job-level `if:` support); the workflow tests FAIL with "GitOrange Actions doesn't run `uses: gitorange/relevance@v1` yet".

- [ ] **Step 3: Pass `relevance` through the harness**

In `worker/src/__tests__/helpers/actions.ts`, import the type and extend `harness`:

```ts
import type { RelevanceModelFor } from '../../actions/relevance';
```

```ts
  opts: { loseEvents?: boolean; relevance?: RelevanceModelFor } = {}
```

and in `executeRun`'s deps add `relevance: opts.relevance,`.

- [ ] **Step 4: Run the action in the executor**

In `worker/src/actions/executor.ts`, add the import:

```ts
import {
  decideRelevance,
  defaultRelevance,
  parseRelevanceInputs,
  RELEVANCE_ACTION,
  RELEVANCE_VERSION,
  RelevanceInputError,
  relevanceContext,
  relevanceScript,
  type RelevanceInputs,
  type RelevanceModelFor,
} from './relevance';
```

In `ExecutorDeps`:

```ts
  /** Clef for `gitorange/relevance`; defaults to Workers AI when the AI binding exists. */
  relevance?: RelevanceModelFor;
```

In `runAttempt`, the `buildCommand` call's state object gains two fields:

```ts
const cmd = await buildCommand(env, ctx, wf, def, s, prepared, {
  number,
  envAdds,
  pathAdds,
  remainingMs: deadline - Date.now(),
  db,
  relevance: deps.relevance ?? defaultRelevance(env),
});
```

In `buildCommand`'s signature, the `state` type becomes:

```ts
  state: {
    number: number;
    envAdds: Record<string, string>;
    pathAdds: string[];
    remainingMs: number;
    db: Db;
    relevance: RelevanceModelFor;
  }
```

Before the final `return { error: … }` of `buildCommand` (after the `actions/cache` branch):

```ts
if (action === RELEVANCE_ACTION) {
  if (uses !== `${RELEVANCE_ACTION}@${RELEVANCE_VERSION}`)
    return { error: `Use ${RELEVANCE_ACTION}@${RELEVANCE_VERSION}.` };
  let inputs: RelevanceInputs;
  try {
    inputs = parseRelevanceInputs(withArgs);
  } catch (e) {
    if (e instanceof RelevanceInputError)
      return { error: `${RELEVANCE_ACTION}: ${e.message}` };
    throw e;
  }
  // Decided here, in the Worker (the change, the review, Clef); the runner prints it.
  const rc = await relevanceContext(env, state.db, ctx);
  const decision = await decideRelevance(
    inputs,
    rc,
    state.relevance({
      repositoryId: ctx.repoId,
      pullRequestId: rc.pullRequestId,
    })
  );
  return {
    request: {
      number: state.number,
      argv: [...SHELLS.bash, relevanceScript(decision)],
      cwd: WORKSPACE,
      env: stepEnv,
      timeoutMs,
      masks: [],
    },
  };
}
```

and change the unsupported-action message to:

```ts
return {
  error: `GitOrange Actions doesn't run \`uses: ${uses}\` yet. Supported actions: actions/checkout, actions/setup-node, actions/cache, and ${RELEVANCE_ACTION}@${RELEVANCE_VERSION}. Use a \`run:\` step instead.`,
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test worker/src/__tests__/actions-relevance.test.ts worker/src/__tests__/actions-syntax.test.ts worker/src/__tests__/actions.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/actions/executor.ts worker/src/__tests__/helpers/actions.ts worker/src/__tests__/actions-relevance.test.ts worker/src/__tests__/actions-syntax.test.ts
git commit -m "Actions: run gitorange/relevance@v1 as a built-in step

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 4: Docs and the definition of done

**Files:**

- Create: `docs/ci-relevance.md`
- Modify: `docs/README.md`, `README.md`, `docs/configuration.md`

- [ ] **Step 1: Write `docs/ci-relevance.md`**

````markdown
# Skipping tests a change can't affect (`gitorange/relevance@v1`)

`gitorange/relevance@v1` is a GitOrange-only workflow step. It asks Clef, a fast decision model on Workers AI, whether a change could affect a workflow's tests (as a whole and per module), and sets outputs that later jobs read in their `if:`. It's made for many small pull requests: a docs change skips the test jobs, a change to one area runs only that area's tests.

```yaml
jobs:
  gate:
    runs-on: ubuntu-latest
    outputs:
      run: ${{ steps.relevance.outputs.run }}
      run-stacking: ${{ steps.relevance.outputs.run-stacking }}
    steps:
      - id: relevance
        uses: gitorange/relevance@v1
        with:
          skip-below: 0.2
          always-run-paths: |
            test/helpers/**
          modules: |
            stacking: Stack discovery and the stack tree
            review: Auto-merge review and pull request states

  test-stacking:
    needs: gate
    if: always() && (needs.gate.result == 'skipped' || needs.gate.outputs.run-stacking == 'true')
    runs-on: ubuntu-latest
    steps:
      - run: yarn test stacking
```

## Inputs

| Input              | Default | Meaning                                                                                                                                                                                                     |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modules`          | —       | One `name: what its tests cover` per line. Names use letters, numbers, `-` and `_`. Required.                                                                                                               |
| `skip-below`       | `0.2`   | A module (or the whole workflow) is skipped only when Clef's probability that the change is relevant is **below** this. Unsure means run.                                                                   |
| `always-run-paths` | none    | `.gitignore`-style patterns; a change to a matching path runs everything. Added to the defaults: `package.json`, lockfiles, `.github/workflows/**`, `vitest.config.*`, `wrangler*.jsonc`, `tsconfig*.json`. |

A bad input (a `skip-below` that isn't a number from 0 to 1, a module line without `name: description`) fails the step with a message naming it.

## Outputs

- `run`: `'true'` or `'false'` for the whole workflow.
- `run-<module>`: `'true'` when `run` is true and Clef found the change relevant to that module.

## What Clef reads

One Clef call per run, with one yes/no question for the whole workflow and one per module. It reads the pull request's title and description (or the pushed commit's message), the changed paths with added and deleted line counts (at most 300 listed), and, when the [auto-merge review](auto-merge.md) already finished for this commit, its one-line summary of each file. It never sees the diff itself.

## Safety nets

Any of these makes every output `'true'`, checked in this order:

1. The run is a push to the repository's default branch.
2. A changed path matches `always-run-paths` or the defaults.
3. Clef isn't configured (no `AI` binding), fails, or returns an unusable answer.
4. The change has no changed paths that could be read (for example, a branch with no history in common with its base).

The step log shows which net fired, or each question's probability and the decision. Jobs skipped by the gate show as skipped; a run whose only non-successes are skipped jobs passes, so auto-merge treats it like any passing run.

On GitHub, `gitorange/` actions don't exist: give the gate job `if: github.server_url != 'https://github.com'` and write each module's `if:` so a skipped gate runs it (`needs.gate.result == 'skipped' || …`), as above.

## Cost

One Clef call per run, recorded in **Site admin → Usage & cost** under the feature `ci-relevance` and tagged the same way in AI Gateway.
````

- [ ] **Step 2: Link it**

`docs/README.md`, after the Auto-merge line:

```markdown
- [Skipping irrelevant tests](ci-relevance.md) — `gitorange/relevance@v1`: Clef decides which test jobs a change can affect.
```

`README.md`, the "## Documentation" line: append ` · [Skipping irrelevant tests](docs/ci-relevance.md)` after `[Auto-merge](docs/auto-merge.md)`.

`README.md`, "GitHub Actions compatibility" table: in the row starting `` | `actions/checkout`, `actions/setup-node` ``, replace ``and `actions/cache` (in R2; `setup-node`'s `cache:` caches `node_modules` itself, so a hit makes installs instant)`` with `` `actions/cache` (in R2; `setup-node`'s `cache:` caches `node_modules` itself, so a hit makes installs instant), and GitOrange's own [`gitorange/relevance@v1`](docs/ci-relevance.md), which skips test jobs a change can't affect ``.

`docs/configuration.md`, the `AI_GATEWAY` row: replace ``(`review-summary`, `review-classify`, `review-select`, `review-investigate`, `merge-resolution`)`` with ``(`review-summary`, `review-classify`, `review-select`, `review-investigate`, `merge-resolution`, `stack-decide`, `stack-explain`, `ci-relevance`)``, and in the `ai.binding` row replace `Workers AI: conflict resolution and the auto-merge review` with `Workers AI: conflict resolution, the auto-merge review, and Clef for \`gitorange/relevance@v1\``.

- [ ] **Step 3: Definition of done**

Run: `yarn test`
Expected: all PASS.

Run: `yarn typecheck`
Expected: no errors.

Run: `yarn format`
Expected: files formatted.

- [ ] **Step 4: Commit**

```bash
git add docs/ci-relevance.md docs/README.md README.md docs/configuration.md
git add -u
git commit -m "Docs: gitorange/relevance@v1

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```
