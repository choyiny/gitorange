import { interpolate, type Value } from './expressions';
import {
  MAX_MATRIX_JOBS,
  WorkflowFileError,
  stepDisplayName,
  type BranchFilter,
  type JobDef,
  type Scalar,
  type WorkflowDef,
} from './workflow-file';

// ── filters ──────────────────────────────────────────────────────────────────

/**
 * GitHub's filter glob: `*` matches within a path segment, `**` across segments, `?` one
 * character, `+` one or more of the preceding character, `[…]` a character class.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '+') re += '+';
    else if (ch === '[') {
      const end = pattern.indexOf(']', i);
      if (end < 0) re += '\\[';
      else {
        re += pattern.slice(i, end + 1);
        i = end;
      }
    } else re += ch.replace(/[.^$(){}|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Ordered include/`!`exclude patterns: the last pattern that matches decides. */
export function matchesPatterns(value: string, patterns: string[]): boolean {
  let result = false;
  for (const p of patterns) {
    const negated = p.startsWith('!');
    if (globToRegExp(negated ? p.slice(1) : p).test(value)) result = !negated;
  }
  return result;
}

function pathsMatch(f: BranchFilter, changed: string[] | null): boolean {
  // Unknown change set (a new branch): run, as GitHub does when it cannot diff.
  if (changed === null) return true;
  if (f.paths) return changed.some((p) => matchesPatterns(p, f.paths!));
  if (f.pathsIgnore)
    return changed.some((p) => !matchesPatterns(p, f.pathsIgnore!));
  return true;
}

/** Does a push to `ref` (refs/heads/… or refs/tags/…) trigger this filter? */
export function pushMatches(
  f: BranchFilter,
  ref: string,
  changed: string[] | null
): boolean {
  if (ref.startsWith('refs/heads/')) {
    const branch = ref.slice('refs/heads/'.length);
    // Only tag filters configured ⇒ branch pushes do not trigger.
    if (!f.branches && !f.branchesIgnore && (f.tags || f.tagsIgnore))
      return false;
    if (f.branches && !matchesPatterns(branch, f.branches)) return false;
    if (f.branchesIgnore && matchesPatterns(branch, f.branchesIgnore))
      return false;
    return pathsMatch(f, changed);
  }
  if (ref.startsWith('refs/tags/')) {
    const tag = ref.slice('refs/tags/'.length);
    if (!f.tags && !f.tagsIgnore && (f.branches || f.branchesIgnore))
      return false;
    if (f.tags && !matchesPatterns(tag, f.tags)) return false;
    if (f.tagsIgnore && matchesPatterns(tag, f.tagsIgnore)) return false;
    // Path filters do not apply to tag pushes.
    return true;
  }
  return false;
}

/** Does a pull request into `baseBranch` trigger this filter? */
export function pullRequestMatches(
  f: BranchFilter,
  baseBranch: string,
  changed: string[] | null
): boolean {
  if (f.branches && !matchesPatterns(baseBranch, f.branches)) return false;
  if (f.branchesIgnore && matchesPatterns(baseBranch, f.branchesIgnore))
    return false;
  return pathsMatch(f, changed);
}

// ── runners ──────────────────────────────────────────────────────────────────

export type InstanceType =
  'lite' | 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4';

const SIZES: InstanceType[] = [
  'lite',
  'standard-1',
  'standard-2',
  'standard-3',
  'standard-4',
];

/**
 * Maps `runs-on` to a container instance type. GitHub's Linux labels get `standard-1`
 * (½ vCPU, 4 GiB); `gitorange-standard-3` (or just `standard-3`) picks a size explicitly.
 */
export function instanceTypeFor(runsOn: string): InstanceType {
  const labels = runsOn.split(',').map((l) => l.trim().toLowerCase());
  for (const l of labels) {
    const size = l.replace(/^gitorange-/, '');
    if ((SIZES as string[]).includes(size)) return size as InstanceType;
  }
  if (labels.some((l) => /^(windows|macos)/.test(l)))
    throw new WorkflowFileError(
      `runs-on: ${runsOn} is not available. GitOrange Actions runs Linux jobs only (use ubuntu-latest).`
    );
  return 'standard-1';
}

// ── jobs ─────────────────────────────────────────────────────────────────────

export interface PlannedStep {
  number: number;
  name: string;
}

export interface PlannedJob {
  key: string;
  name: string;
  runsOn: string;
  needs: string[];
  matrix: Record<string, Scalar> | null;
  steps: PlannedStep[];
}

/** Cartesian product of the matrix axes, in declaration order. */
export function expandMatrix(
  m: Record<string, Scalar[]>
): Record<string, Scalar>[] {
  let combos: Record<string, Scalar>[] = [{}];
  for (const [k, vals] of Object.entries(m))
    combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  return combos;
}

function safeInterpolate(text: string, ctx: Record<string, Value>): string {
  try {
    return interpolate(text, ctx);
  } catch {
    return text;
  }
}

/**
 * Expands each job by its matrix and names its steps, framed by GitHub's "Set up job" and
 * "Complete job" steps so step numbers line up with what users see on GitHub.
 */
export function planJobs(
  wf: WorkflowDef,
  github: Record<string, Value>
): PlannedJob[] {
  const out: PlannedJob[] = [];
  for (const job of wf.jobs) {
    instanceTypeFor(job.runsOn);
    const combos = job.matrix ? expandMatrix(job.matrix) : [null];
    if (combos.length > MAX_MATRIX_JOBS)
      throw new WorkflowFileError(
        `jobs.${job.key}.strategy.matrix expands to ${combos.length} jobs; the limit is ${MAX_MATRIX_JOBS}`
      );
    for (const combo of combos) out.push(planJob(job, combo, github));
  }
  return out;
}

function planJob(
  job: JobDef,
  combo: Record<string, Scalar> | null,
  github: Record<string, Value>
): PlannedJob {
  const ctx: Record<string, Value> = {
    github,
    matrix: combo ?? {},
    env: {},
    needs: {},
  };
  const base = job.name ? safeInterpolate(job.name, ctx) : job.key;
  const name =
    combo && !(job.name && job.name.includes('${{'))
      ? `${base} (${Object.values(combo).map(String).join(', ')})`
      : base;
  const steps: PlannedStep[] = [
    { number: 1, name: 'Set up job' },
    ...job.steps.map((s, i) => ({
      number: i + 2,
      name: safeInterpolate(stepDisplayName(s), ctx),
    })),
    { number: job.steps.length + 2, name: 'Complete job' },
  ];
  return {
    key: job.key,
    name,
    runsOn: job.runsOn,
    needs: job.needs,
    matrix: combo,
    steps,
  };
}
