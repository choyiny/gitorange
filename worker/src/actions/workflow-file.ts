import { parse as parseYaml } from 'yaml';

/**
 * The subset of the GitHub Actions workflow syntax GitOrange runs. Parsing is strict about
 * structure (so a typo fails the run with a clear message, like GitHub's "Invalid workflow file")
 * and lenient about keys that only affect GitHub's own platform (`permissions`, `concurrency`).
 */

export type Scalar = string | number | boolean;

export interface BranchFilter {
  branches?: string[];
  branchesIgnore?: string[];
  tags?: string[];
  tagsIgnore?: string[];
  paths?: string[];
  pathsIgnore?: string[];
}

export interface Triggers {
  push?: BranchFilter;
  pullRequest?: BranchFilter;
}

export interface StepDef {
  id?: string;
  name?: string;
  if?: string | boolean;
  run?: string;
  uses?: string;
  with: Record<string, string>;
  env: Record<string, string>;
  shell?: string;
  workingDirectory?: string;
  continueOnError: boolean | string;
  timeoutMinutes?: number;
}

export interface JobDef {
  key: string;
  name?: string;
  runsOn: string;
  needs: string[];
  if?: string | boolean;
  env: Record<string, string>;
  workingDirectory?: string;
  shell?: string;
  matrix?: Record<string, Scalar[]>;
  outputs: Record<string, string>;
  steps: StepDef[];
  timeoutMinutes: number;
  continueOnError: boolean | string;
}

export interface WorkflowDef {
  name?: string;
  on: Triggers;
  env: Record<string, string>;
  workingDirectory?: string;
  shell?: string;
  jobs: JobDef[];
}

export class WorkflowFileError extends Error {}

/** The longest a job may run, and the default when `timeout-minutes` is not set. */
export const MAX_JOB_MINUTES = 120;
/** Matrix expansion cap per job, to keep one push from starting a fleet of containers. */
export const MAX_MATRIX_JOBS = 20;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(msg: string): never {
  throw new WorkflowFileError(msg);
}

function stringMap(v: unknown, where: string): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) fail(`${where} must be a mapping`);
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === null || x === undefined) out[k] = '';
    else if (
      typeof x === 'string' ||
      typeof x === 'number' ||
      typeof x === 'boolean'
    )
      out[k] = String(x);
    else fail(`${where}.${k} must be a string`);
  }
  return out;
}

function stringList(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return [v];
  if (
    !Array.isArray(v) ||
    v.some((x) => typeof x !== 'string' && typeof x !== 'number')
  )
    fail(`${where} must be a string or a list of strings`);
  return v.map(String);
}

function condition(v: unknown, where: string): string | boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  fail(`${where} must be an expression`);
}

function minutes(v: unknown, where: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) fail(`${where} must be a positive number`);
  return Math.min(n, MAX_JOB_MINUTES);
}

function filter(v: unknown, where: string): BranchFilter {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) fail(`${where} must be a mapping`);
  const f: BranchFilter = {
    branches:
      v.branches === undefined
        ? undefined
        : stringList(v.branches, `${where}.branches`),
    branchesIgnore:
      v['branches-ignore'] === undefined
        ? undefined
        : stringList(v['branches-ignore'], `${where}.branches-ignore`),
    tags:
      v.tags === undefined ? undefined : stringList(v.tags, `${where}.tags`),
    tagsIgnore:
      v['tags-ignore'] === undefined
        ? undefined
        : stringList(v['tags-ignore'], `${where}.tags-ignore`),
    paths:
      v.paths === undefined ? undefined : stringList(v.paths, `${where}.paths`),
    pathsIgnore:
      v['paths-ignore'] === undefined
        ? undefined
        : stringList(v['paths-ignore'], `${where}.paths-ignore`),
  };
  if (f.branches && f.branchesIgnore)
    fail(`${where}: use either branches or branches-ignore, not both`);
  if (f.paths && f.pathsIgnore)
    fail(`${where}: use either paths or paths-ignore, not both`);
  return f;
}

function triggers(v: unknown): Triggers {
  const out: Triggers = {};
  const add = (event: string, cfg: unknown) => {
    if (event === 'push') out.push = filter(cfg, 'on.push');
    else if (event === 'pull_request')
      out.pullRequest = filter(cfg, 'on.pull_request');
    // Other events (schedule, workflow_dispatch, …) are accepted but never fire here yet.
  };
  if (typeof v === 'string') add(v, undefined);
  else if (Array.isArray(v)) for (const e of v) add(String(e), undefined);
  else if (isObj(v)) for (const [e, cfg] of Object.entries(v)) add(e, cfg);
  else fail('`on` must name at least one event');
  return out;
}

function runsOn(v: unknown, where: string): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string'))
    return v.join(', ');
  if (isObj(v) && v.labels !== undefined)
    return stringList(v.labels, `${where}.labels`).join(', ');
  fail(`${where} is required`);
}

function matrix(
  v: unknown,
  where: string
): Record<string, Scalar[]> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string')
    fail(`${where}: matrix expressions are not supported yet`);
  if (!isObj(v)) fail(`${where} must be a mapping`);
  if (v.include !== undefined || v.exclude !== undefined)
    fail(`${where}: matrix include/exclude is not supported yet`);
  const out: Record<string, Scalar[]> = {};
  for (const [k, vals] of Object.entries(v)) {
    if (!Array.isArray(vals) || !vals.length)
      fail(`${where}.${k} must be a non-empty list`);
    if (vals.some((x) => !['string', 'number', 'boolean'].includes(typeof x)))
      fail(`${where}.${k}: only strings, numbers, and booleans are supported`);
    out[k] = vals as Scalar[];
  }
  return out;
}

function step(v: unknown, where: string): StepDef {
  if (!isObj(v)) fail(`${where} must be a mapping`);
  const run = v.run === undefined ? undefined : String(v.run);
  const uses = v.uses === undefined ? undefined : String(v.uses);
  if (!run === !uses) fail(`${where} must have exactly one of run or uses`);
  const coe = v['continue-on-error'];
  return {
    id: v.id === undefined ? undefined : String(v.id),
    name: v.name === undefined ? undefined : String(v.name),
    if: condition(v.if, `${where}.if`),
    run,
    uses,
    with: stringMap(v.with, `${where}.with`),
    env: stringMap(v.env, `${where}.env`),
    shell: v.shell === undefined ? undefined : String(v.shell),
    workingDirectory:
      v['working-directory'] === undefined
        ? undefined
        : String(v['working-directory']),
    continueOnError: typeof coe === 'string' ? coe : coe === true,
    timeoutMinutes: minutes(v['timeout-minutes'], `${where}.timeout-minutes`),
  };
}

function runDefaults(v: unknown, where: string) {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) fail(`${where} must be a mapping`);
  const run = v.run;
  if (run === undefined || run === null) return {};
  if (!isObj(run)) fail(`${where}.run must be a mapping`);
  return {
    shell: run.shell === undefined ? undefined : String(run.shell),
    workingDirectory:
      run['working-directory'] === undefined
        ? undefined
        : String(run['working-directory']),
  };
}

const JOB_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function job(key: string, v: unknown): JobDef {
  const where = `jobs.${key}`;
  if (!JOB_KEY.test(key))
    fail(`${where}: job ids may contain only letters, numbers, - and _`);
  if (!isObj(v)) fail(`${where} must be a mapping`);
  if (v.uses !== undefined)
    fail(`${where}: reusable workflows are not supported yet`);
  if (v.container !== undefined)
    fail(`${where}: job containers are not supported yet`);
  if (v.services !== undefined)
    fail(`${where}: service containers are not supported yet`);
  if (!Array.isArray(v.steps) || !v.steps.length)
    fail(`${where}.steps must be a non-empty list`);
  const strategy = v.strategy;
  if (strategy !== undefined && !isObj(strategy))
    fail(`${where}.strategy must be a mapping`);
  const defaults = runDefaults(v.defaults, `${where}.defaults`);
  const coe = v['continue-on-error'];
  return {
    key,
    name: v.name === undefined ? undefined : String(v.name),
    runsOn: runsOn(v['runs-on'], `${where}.runs-on`),
    needs: stringList(v.needs, `${where}.needs`),
    if: condition(v.if, `${where}.if`),
    env: stringMap(v.env, `${where}.env`),
    workingDirectory: defaults.workingDirectory,
    shell: defaults.shell,
    matrix: matrix(strategy?.matrix, `${where}.strategy.matrix`),
    outputs: stringMap(v.outputs, `${where}.outputs`),
    steps: v.steps.map((s, i) => step(s, `${where}.steps[${i}]`)),
    timeoutMinutes:
      minutes(v['timeout-minutes'], `${where}.timeout-minutes`) ??
      MAX_JOB_MINUTES,
    continueOnError: typeof coe === 'string' ? coe : coe === true,
  };
}

/** Parses and validates a workflow file. Throws WorkflowFileError with a user-facing message. */
export function parseWorkflow(text: string): WorkflowDef {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    fail(
      `Invalid YAML: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`
    );
  }
  if (!isObj(doc)) fail('A workflow file must be a mapping');
  // YAML 1.1 parsers read a bare `on:` key as boolean true; accept both spellings.
  const on = doc.on ?? (doc as Record<string, unknown>)['true'];
  if (on === undefined) fail('`on` is required');
  if (!isObj(doc.jobs) || !Object.keys(doc.jobs).length)
    fail('`jobs` must define at least one job');
  const jobs = Object.entries(doc.jobs).map(([k, v]) => job(k, v));
  const keys = new Set(jobs.map((j) => j.key));
  for (const j of jobs)
    for (const n of j.needs)
      if (!keys.has(n)) fail(`jobs.${j.key}.needs: unknown job '${n}'`);
  // Reject dependency cycles up front so a run can never wait forever.
  const state = new Map<string, 'visiting' | 'done'>();
  const byKey = new Map(jobs.map((j) => [j.key, j]));
  const visit = (k: string) => {
    if (state.get(k) === 'done') return;
    if (state.get(k) === 'visiting') fail(`jobs.${k}.needs: dependency cycle`);
    state.set(k, 'visiting');
    for (const n of byKey.get(k)!.needs) visit(n);
    state.set(k, 'done');
  };
  for (const j of jobs) visit(j.key);
  const defaults = runDefaults(doc.defaults, 'defaults');
  return {
    name: doc.name === undefined ? undefined : String(doc.name),
    on: triggers(on),
    env: stringMap(doc.env, 'env'),
    workingDirectory: defaults.workingDirectory,
    shell: defaults.shell,
    jobs,
  };
}

/** The UI name of a step, matching GitHub's defaults. */
export function stepDisplayName(s: StepDef): string {
  if (s.name) return s.name;
  if (s.uses) return `Run ${s.uses}`;
  const first = (s.run ?? '').trim().split('\n')[0];
  return `Run ${first}`;
}
