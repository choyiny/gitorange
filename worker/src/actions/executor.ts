import type { WorkflowStepConfig } from 'cloudflare:workers';
import { and, eq, inArray } from 'drizzle-orm';
import { pingingSteps } from '../live/publish';
import { autoMergeForCommit } from '../review/auto-merge';
import {
  absolutePaths,
  cacheConfigured,
  cacheObjectKey,
  cacheUrl,
  enforceCacheLimit,
  findCacheEntry,
  nodeModulesKey,
  restoreScript,
  RUNNER_NODE_MAJOR,
  saveScript,
} from './cache';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { schema } from '../db/schema';
import { users } from '../db/auth.schema';
import {
  repositories,
  workflowJobs,
  workflowRuns,
  workflowSteps,
  type WorkflowJob,
} from '../db/app.schema';
import { ArtifactsRepoClient } from '../git/remote';
import { GitService } from '../git/service';
import { gitFor, findRepoById } from '../lib/repos';
import {
  ExpressionError,
  evaluateCondition,
  interpolate,
  truthy,
  evaluate,
  type JobStatus,
  type Value,
} from './expressions';
import { WORKSPACE, type JobRunnerApi, type StepRequest } from './job-runner';
import { instanceTypeFor, postStepIndexes } from './plan';
import { githubContext, readWorkflowFiles } from './trigger';
import {
  parseWorkflow,
  type JobDef,
  type StepDef,
  type WorkflowDef,
} from './workflow-file';

type Db = DrizzleD1Database<typeof schema>;
type Conclusion = 'success' | 'failure' | 'cancelled' | 'skipped';

/**
 * The part of Cloudflare's WorkflowStep the executor uses. Results must be JSON-serializable;
 * tests pass a fake that calls `fn` directly.
 */
export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    fn: () => Promise<T>
  ): Promise<T>;
}

export interface ExecutorDeps {
  env: CloudflareBindings;
  db: Db;
  step: StepRunner;
  runner: (jobId: string) => JobRunnerApi;
}

const DEFAULT_PATH =
  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const NO_RETRY = { retries: { limit: 0, delay: 0 } } as const;

export function logKey(
  repoId: string,
  runId: string,
  jobId: string,
  step: number
) {
  return `actions/${repoId}/${runId}/${jobId}/${step}.log`;
}

/** Loaded once per run (inside a durable step, so replays reuse it). */
interface RunContext {
  runId: string;
  repoId: string;
  repoFullName: string;
  artifactsName: string;
  defaultBranch: string;
  status: string;
  event: string;
  ref: string;
  headSha: string;
  runNumber: number;
  actor: string;
  workflowPath: string;
  workflowText: string | null;
  serverUrl: string;
  jobs: Pick<
    WorkflowJob,
    'id' | 'jobKey' | 'needs' | 'matrixValues' | 'runsOn'
  >[];
}

async function loadRun(
  env: CloudflareBindings,
  db: Db,
  runId: string
): Promise<RunContext | null> {
  const run = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .get();
  if (!run) return null;
  const found = await findRepoById(db, run.repositoryId);
  if (!found) return null;
  const actor = run.actorId
    ? await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, run.actorId))
        .get()
    : null;
  const jobs = await db
    .select({
      id: workflowJobs.id,
      jobKey: workflowJobs.jobKey,
      needs: workflowJobs.needs,
      matrixValues: workflowJobs.matrixValues,
      runsOn: workflowJobs.runsOn,
    })
    .from(workflowJobs)
    .where(eq(workflowJobs.runId, runId));
  const files = await readWorkflowFiles(gitFor(env, found.repo), run.headSha);
  return {
    runId,
    repoId: found.repo.id,
    repoFullName: `${found.namespace.username}/${found.repo.name}`,
    artifactsName: found.repo.artifactsName,
    defaultBranch: found.repo.defaultBranch,
    status: run.status,
    event: run.event,
    ref: run.ref,
    headSha: run.headSha,
    runNumber: run.runNumber,
    actor: actor?.username ?? '',
    workflowPath: run.workflowPath,
    workflowText: files.find((f) => f.path === run.workflowPath)?.text ?? null,
    serverUrl: env.BASE_URL ?? '',
    jobs,
  };
}

interface JobOutcome {
  key: string;
  result: Conclusion;
  outputs: Record<string, string>;
}

interface StepState {
  outcome: Conclusion;
  conclusion: Conclusion;
  outputs: Record<string, string>;
}

/** Runs one workflow run to completion. Called from the ActionsRun Workflow. */
export async function executeRun(
  deps: ExecutorDeps,
  runId: string
): Promise<Conclusion | null> {
  const { env, db } = deps;
  let { step } = deps;
  const ctx = await step.do('load', () => loadRun(env, db, runId));
  if (!ctx || ctx.status === 'completed') return null;
  // Each step (run, job, and step status, logs) shows on open pages as it finishes.
  step = pingingSteps(env, step, ctx.repoId);
  deps = { ...deps, step };

  let wf: WorkflowDef;
  try {
    if (ctx.workflowText === null)
      throw new Error(`${ctx.workflowPath} no longer exists at ${ctx.headSha}`);
    wf = parseWorkflow(ctx.workflowText);
  } catch (e) {
    await step.do('fail-run', async () => {
      await finishRun(
        db,
        runId,
        'failure',
        e instanceof Error ? e.message : String(e)
      );
      return true;
    });
    return 'failure';
  }

  await step.do('start-run', async () => {
    await db
      .update(workflowRuns)
      .set({ status: 'in_progress', startedAt: new Date() })
      .where(eq(workflowRuns.id, runId));
    return true;
  });

  const github = githubContext(
    ctx.repoFullName,
    {
      event: ctx.event,
      ref: ctx.ref,
      headSha: ctx.headSha,
      runNumber: ctx.runNumber,
      id: ctx.runId,
    },
    {
      actor: ctx.actor,
      workflow: wf.name ?? ctx.workflowPath,
      serverUrl: ctx.serverUrl,
    }
  ) as Record<string, Value>;

  const defs = new Map(wf.jobs.map((j) => [j.key, j]));
  const outcomes = new Map<string, JobOutcome[]>();
  const pending = new Set(ctx.jobs.map((j) => j.id));
  const keyCount = new Map<string, number>();
  for (const j of ctx.jobs)
    keyCount.set(j.jobKey, (keyCount.get(j.jobKey) ?? 0) + 1);
  const finishedKey = (k: string) =>
    (outcomes.get(k)?.length ?? 0) === (keyCount.get(k) ?? 0);

  // Waves: every job whose `needs` have all finished runs now, in parallel.
  while (pending.size) {
    const ready = ctx.jobs.filter(
      (j) => pending.has(j.id) && j.needs.every(finishedKey)
    );
    if (!ready.length) break; // unreachable: cycles are rejected when parsing
    const results = await Promise.all(
      ready.map((j) => {
        const def = defs.get(j.jobKey);
        return def
          ? runJob(deps, ctx, wf, def, j, github, outcomes)
          : skipJob(deps, j.id, `job:${j.id}`).then(() => ({
              key: j.jobKey,
              result: 'skipped' as const,
              outputs: {},
            }));
      })
    );
    for (const [i, r] of results.entries()) {
      pending.delete(ready[i].id);
      outcomes.set(r.key, [...(outcomes.get(r.key) ?? []), r]);
    }
  }

  const all = [...outcomes.values()].flat().map((o) => o.result);
  const conclusion: Conclusion = all.includes('failure')
    ? 'failure'
    : all.includes('cancelled')
      ? 'cancelled'
      : 'success';
  await step.do('finish-run', async () => {
    await finishRun(db, runId, conclusion, null);
    return true;
  });
  // Passing checks may be the last thing an open pull request at this commit waited on.
  if (conclusion === 'success')
    await step.do('auto-merge', async () => {
      await autoMergeForCommit(env, db, ctx.repoId, ctx.headSha).catch((e) =>
        console.error('[actions] auto-merge failed', runId, e)
      );
      return true;
    });
  return conclusion;
}

async function finishRun(
  db: Db,
  runId: string,
  conclusion: Conclusion,
  error: string | null
) {
  await db
    .update(workflowRuns)
    .set({
      status: 'completed',
      conclusion,
      errorMessage: error,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(workflowRuns.id, runId),
        inArray(workflowRuns.status, ['queued', 'in_progress'])
      )
    );
}

function needsContext(def: JobDef, outcomes: Map<string, JobOutcome[]>) {
  const needs: Record<string, Value> = {};
  let status: JobStatus = 'success';
  for (const key of def.needs) {
    const list = outcomes.get(key) ?? [];
    const result: Conclusion = list.some((o) => o.result === 'failure')
      ? 'failure'
      : list.some((o) => o.result === 'cancelled')
        ? 'cancelled'
        : list.every((o) => o.result === 'skipped')
          ? 'skipped'
          : 'success';
    if (result === 'failure') status = 'failure';
    else if (result === 'cancelled' && status !== 'failure')
      status = 'cancelled';
    needs[key] = {
      result,
      outputs: Object.assign({}, ...list.map((o) => o.outputs)),
    };
  }
  // A skipped dependency also blocks success() jobs, like GitHub.
  const anySkipped = def.needs.some((k) =>
    (outcomes.get(k) ?? []).every((o) => o.result === 'skipped')
  );
  return { needs, status, anySkipped };
}

async function skipJob(deps: ExecutorDeps, jobId: string, name: string) {
  await deps.step.do(`${name}:skip`, async () => {
    const now = new Date();
    await deps.db
      .update(workflowJobs)
      .set({ status: 'completed', conclusion: 'skipped', completedAt: now })
      .where(eq(workflowJobs.id, jobId));
    await deps.db
      .update(workflowSteps)
      .set({ status: 'completed', conclusion: 'skipped', completedAt: now })
      .where(eq(workflowSteps.jobId, jobId));
    return true;
  });
}

async function setStep(
  db: Db,
  jobId: string,
  number: number,
  patch: Partial<typeof workflowSteps.$inferInsert>
) {
  await db
    .update(workflowSteps)
    .set(patch)
    .where(
      and(eq(workflowSteps.jobId, jobId), eq(workflowSteps.number, number))
    );
}

async function runJob(
  deps: ExecutorDeps,
  ctx: RunContext,
  wf: WorkflowDef,
  def: JobDef,
  job: RunContext['jobs'][number],
  github: Record<string, Value>,
  outcomes: Map<string, JobOutcome[]>
): Promise<JobOutcome> {
  const { db, step, env } = deps;
  const name = `job:${job.id}`;
  const matrix = (job.matrixValues ?? {}) as Record<string, Value>;
  const {
    needs,
    status: needsStatus,
    anySkipped,
  } = needsContext(def, outcomes);
  const exprCtx = (
    extra: Record<string, Value> = {}
  ): Record<string, Value> => ({
    github: { ...github, job: def.key },
    matrix,
    needs,
    strategy: {},
    runner: {
      os: 'Linux',
      arch: 'X64',
      name: 'GitOrange',
      temp: '/tmp',
      tool_cache: '/opt/hostedtoolcache',
    },
    inputs: {},
    secrets: {},
    vars: {},
    env: {},
    ...extra,
  });

  // Job-level `if:` sees the dependencies' combined status.
  let runIt: boolean;
  try {
    const status: JobStatus =
      anySkipped && needsStatus === 'success' ? 'cancelled' : needsStatus;
    runIt = evaluateCondition(def.if, exprCtx(), { status });
    if (anySkipped && def.if === undefined) runIt = false;
  } catch {
    runIt = false;
  }
  if (!runIt) {
    await skipJob(deps, job.id, name);
    return { key: def.key, result: 'skipped', outputs: {} };
  }

  const runner = deps.runner(job.id);
  const jobTimeoutMs = def.timeoutMinutes * 60_000;
  const deadline = Date.now() + jobTimeoutMs;
  const posts = postStepIndexes(def.steps);
  const lastStep = def.steps.length + 2 + posts.length;
  // What each caching step restored, for its post step (step results replay deterministically).
  const caches = new Map<number, CacheState>();

  // ── Set up job ──
  const setup = await step.do(
    `${name}:setup`,
    {
      retries: { limit: 2, delay: '10 seconds', backoff: 'constant' },
      timeout: '10 minutes',
    },
    async () => {
      const now = new Date();
      await db
        .update(workflowJobs)
        .set({ status: 'in_progress', startedAt: now })
        .where(eq(workflowJobs.id, job.id));
      await setStep(db, job.id, 1, { status: 'in_progress', startedAt: now });
      let log: string;
      let ok = true;
      try {
        const size = instanceTypeFor(job.runsOn);
        const { ms } = await runner.boot(size, jobTimeoutMs);
        log = [
          `Runner: GitOrange Actions (${size})`,
          `Labels: ${job.runsOn}`,
          `Image: Debian (trixie) with Node.js, git, and build tools`,
          `Started in ${(ms / 1000).toFixed(1)}s`,
        ].join('\n');
      } catch (e) {
        ok = false;
        log = `Could not start the runner: ${e instanceof Error ? e.message : String(e)}`;
      }
      await putLog(env, ctx, job.id, 1, log);
      await setStep(db, job.id, 1, {
        status: 'completed',
        conclusion: ok ? 'success' : 'failure',
        completedAt: new Date(),
        logR2Key: logKey(ctx.repoId, ctx.runId, job.id, 1),
      });
      return ok;
    }
  );

  let jobStatus: JobStatus = setup ? 'success' : 'failure';
  const steps: Record<string, Value> = {};
  let envAdds: Record<string, string> = {};
  let pathAdds: string[] = [];

  for (const [i, s] of def.steps.entries()) {
    const number = i + 2;
    const stepCtx = () => {
      // env is layered workflow → job → GITHUB_ENV → step; each layer may use the ones before it.
      let envCtx: Record<string, string> = {};
      const layer = (vars: Record<string, string>) => {
        const next = { ...envCtx };
        for (const [k, v] of Object.entries(vars))
          next[k] = interpolate(v, exprCtx({ env: envCtx, steps }));
        envCtx = next;
      };
      layer(wf.env);
      layer(def.env);
      envCtx = { ...envCtx, ...envAdds };
      layer(s.env);
      return {
        env: envCtx,
        ctx: exprCtx({ env: envCtx, steps, job: { status: jobStatus } }),
      };
    };

    let run = false;
    let prepared: {
      env: Record<string, string>;
      ctx: Record<string, Value>;
    } | null = null;
    let prepError: string | null = null;
    try {
      prepared = stepCtx();
      run = evaluateCondition(s.if, prepared.ctx, { status: jobStatus });
    } catch (e) {
      prepError = e instanceof Error ? e.message : String(e);
      run = jobStatus === 'success';
    }
    if (Date.now() > deadline && run) {
      prepError = `The job exceeded its timeout of ${def.timeoutMinutes} minutes.`;
    }

    if (!run) {
      await step.do(`${name}:step:${number}:skip`, async () => {
        const now = new Date();
        await setStep(db, job.id, number, {
          status: 'completed',
          conclusion: 'skipped',
          completedAt: now,
        });
        return true;
      });
      if (s.id)
        steps[s.id] = {
          outcome: 'skipped',
          conclusion: 'skipped',
          outputs: {},
        };
      continue;
    }

    const result = await step
      .do(
        `${name}:step:${number}`,
        {
          ...NO_RETRY,
          timeout: `${Math.min(s.timeoutMinutes ?? def.timeoutMinutes, def.timeoutMinutes) + 5} minutes`,
        },
        async () => {
          await setStep(db, job.id, number, {
            status: 'in_progress',
            startedAt: new Date(),
          });
          let exitCode = 1;
          let log = '';
          let out: {
            outputs: Record<string, string>;
            envAdds: Record<string, string>;
            pathAdds: string[];
          } = {
            outputs: {},
            envAdds: {},
            pathAdds: [],
          };
          let cache: CacheState | null = null;
          if (prepError || !prepared) {
            log = `Error: ${prepError}`;
          } else {
            const cmd = await buildCommand(env, ctx, wf, def, s, prepared, {
              number,
              envAdds,
              pathAdds,
              remainingMs: deadline - Date.now(),
            });
            if ('error' in cmd) log = `Error: ${cmd.error}`;
            else {
              cache = cmd.cache ?? null;
              const r = await runner.runStep(cmd.request);
              exitCode = r.exitCode;
              log = (cmd.preamble ? cmd.preamble + '\n' : '') + r.log;
              if (exitCode !== 0)
                log += `\nError: Process completed with exit code ${exitCode}.`;
              out = {
                outputs: r.outputs,
                envAdds: r.envAdds,
                pathAdds: r.pathAdds,
              };
            }
          }
          const outcome: Conclusion = exitCode === 0 ? 'success' : 'failure';
          await putLog(env, ctx, job.id, number, log);
          return { outcome, ...out, cache };
        }
      )
      .catch((e: unknown) => ({
        outcome: 'failure' as Conclusion,
        outputs: {},
        envAdds: {},
        pathAdds: [],
        cache: null,
        crash: e instanceof Error ? e.message : String(e),
      }));
    if (result.cache && result.outcome === 'success')
      caches.set(i, result.cache);

    const continueOnError =
      typeof s.continueOnError === 'string'
        ? safeTruthy(s.continueOnError, prepared?.ctx ?? exprCtx())
        : s.continueOnError;
    const conclusion: Conclusion =
      result.outcome === 'failure' && continueOnError
        ? 'success'
        : result.outcome;
    await step.do(`${name}:step:${number}:done`, async () => {
      if ('crash' in result)
        await putLog(env, ctx, job.id, number, `Error: ${result.crash}`);
      await setStep(db, job.id, number, {
        status: 'completed',
        conclusion,
        completedAt: new Date(),
        logR2Key: logKey(ctx.repoId, ctx.runId, job.id, number),
      });
      return true;
    });
    if (s.id)
      steps[s.id] = {
        outcome: result.outcome,
        conclusion,
        outputs: result.outputs,
      };
    envAdds = { ...envAdds, ...result.envAdds };
    pathAdds = [...result.pathAdds, ...pathAdds];
    if (conclusion === 'failure') jobStatus = 'failure';
  }

  // ── Post steps: save caches (GitHub runs them in reverse, on success only) ──
  for (const [k, i] of posts.entries()) {
    const number = def.steps.length + 2 + k;
    const state = caches.get(i);
    await step.do(
      `${name}:post:${number}`,
      { ...NO_RETRY, timeout: '30 minutes' },
      async () => {
        const now = new Date();
        await setStep(db, job.id, number, {
          status: 'in_progress',
          startedAt: now,
        });
        let log: string;
        let ran = true;
        if (jobStatus !== 'success') {
          log = 'The job failed, so the cache is not saved.';
          ran = false;
        } else if (!state) {
          log = 'Nothing to save: the cache step did not run.';
          ran = false;
        } else if (state.exact) {
          log = `Cache hit on ${state.key}; nothing to save.`;
          ran = false;
        } else {
          try {
            const objectKey = cacheObjectKey(ctx.repoId, ctx.ref, state.key);
            const url = await cacheUrl(env, objectKey, 'PUT');
            const r = await runner.runStep({
              number,
              argv: [...SHELLS.bash, saveScript(state.paths, state.key)],
              cwd: WORKSPACE,
              env: { CACHE_URL: url, PATH: DEFAULT_PATH, HOME: '/root' },
              timeoutMs: 25 * 60_000,
              masks: [url],
            });
            log = r.log;
            if (r.exitCode !== 0)
              log +=
                '\nWarning: the cache could not be saved; the job is unaffected.';
            else await enforceCacheLimit(env, ctx.repoId);
          } catch (e) {
            log = `Warning: the cache could not be saved: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        await putLog(env, ctx, job.id, number, log);
        // Saving is best effort, like GitHub's: it never fails the job.
        await setStep(db, job.id, number, {
          status: 'completed',
          conclusion: ran ? 'success' : 'skipped',
          completedAt: new Date(),
          logR2Key: logKey(ctx.repoId, ctx.runId, job.id, number),
        });
        return true;
      }
    );
  }

  // ── Complete job ──
  return step.do(`${name}:complete`, async () => {
    try {
      await runner.destroy();
    } catch (e) {
      console.error('[actions] runner destroy failed', job.id, e);
    }
    const outputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(def.outputs)) {
      try {
        outputs[k] = interpolate(v, exprCtx({ steps }));
      } catch {
        outputs[k] = '';
      }
    }
    const jobContinue =
      typeof def.continueOnError === 'string'
        ? safeTruthy(def.continueOnError, exprCtx())
        : def.continueOnError;
    const result: Conclusion =
      jobStatus === 'failure' && !jobContinue ? 'failure' : 'success';
    const now = new Date();
    await putLog(
      env,
      ctx,
      job.id,
      lastStep,
      'Cleaning up: the runner was stopped and its disk discarded.'
    );
    await setStep(db, job.id, lastStep, {
      status: 'completed',
      conclusion: 'success',
      startedAt: now,
      completedAt: now,
      logR2Key: logKey(ctx.repoId, ctx.runId, job.id, lastStep),
    });
    await db
      .update(workflowJobs)
      .set({
        status: 'completed',
        conclusion: jobStatus === 'failure' ? 'failure' : 'success',
        completedAt: now,
      })
      .where(eq(workflowJobs.id, job.id));
    return { key: def.key, result, outputs } satisfies JobOutcome;
  });
}

function safeTruthy(expr: string, ctx: Record<string, Value>) {
  try {
    const m = /^\$\{\{([\s\S]*)\}\}$/.exec(expr.trim());
    return truthy(evaluate(m ? m[1] : expr, ctx));
  } catch {
    return false;
  }
}

async function putLog(
  env: CloudflareBindings,
  ctx: RunContext,
  jobId: string,
  number: number,
  text: string
) {
  await env.ACTIONS_LOGS.put(
    logKey(ctx.repoId, ctx.runId, jobId, number),
    text,
    {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    }
  );
}

/** Shells a `run:` step can use, as argv prefixes; the script is the last argument. */
const SHELLS: Record<string, string[]> = {
  bash: ['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c'],
  sh: ['sh', '-e', '-c'],
  python: ['python3', '-c'],
  node: ['node', '-e'],
};

function resolveDir(dir: string | undefined): string {
  if (!dir) return WORKSPACE;
  return dir.startsWith('/')
    ? dir
    : `${WORKSPACE}/${dir.replace(/^\.\/?/, '')}`;
}

async function buildCommand(
  env: CloudflareBindings,
  ctx: RunContext,
  wf: WorkflowDef,
  def: JobDef,
  s: StepDef,
  prepared: { env: Record<string, string>; ctx: Record<string, Value> },
  state: {
    number: number;
    envAdds: Record<string, string>;
    pathAdds: string[];
    remainingMs: number;
  }
): Promise<
  | { request: StepRequest; preamble?: string; cache?: CacheState }
  | { error: string }
> {
  const timeoutMs = Math.max(
    1000,
    Math.min(
      state.remainingMs,
      (s.timeoutMinutes ?? def.timeoutMinutes) * 60_000
    )
  );
  const g = prepared.ctx.github as Record<string, Value>;
  const baseEnv: Record<string, string> = {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITORANGE_ACTIONS: 'true',
    HOME: '/root',
    GITHUB_WORKSPACE: WORKSPACE,
    GITHUB_SHA: ctx.headSha,
    GITHUB_REF: ctx.ref,
    GITHUB_REF_NAME: String(g.ref_name),
    GITHUB_REF_TYPE: String(g.ref_type),
    GITHUB_REPOSITORY: ctx.repoFullName,
    GITHUB_REPOSITORY_OWNER: ctx.repoFullName.split('/')[0],
    GITHUB_ACTOR: ctx.actor,
    GITHUB_EVENT_NAME: ctx.event,
    GITHUB_RUN_ID: ctx.runId,
    GITHUB_RUN_NUMBER: String(ctx.runNumber),
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: def.key,
    GITHUB_WORKFLOW: wf.name ?? ctx.workflowPath,
    GITHUB_SERVER_URL: ctx.serverUrl,
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    RUNNER_TEMP: '/tmp',
    PATH: [...state.pathAdds, DEFAULT_PATH].join(':'),
  };
  const stepEnv = { ...baseEnv, ...prepared.env };

  try {
    if (s.run !== undefined) {
      const shell = s.shell ?? def.shell ?? wf.shell ?? 'bash';
      const argv = SHELLS[shell];
      if (!argv)
        return {
          error: `shell: ${shell} is not supported. Use bash, sh, python, or node.`,
        };
      const script = interpolate(s.run, prepared.ctx);
      return {
        request: {
          number: state.number,
          argv: [...argv, script],
          cwd: resolveDir(
            s.workingDirectory ?? def.workingDirectory ?? wf.workingDirectory
          ),
          env: stepEnv,
          timeoutMs,
          masks: [],
        },
      };
    }

    const uses = s.uses!;
    const [action] = uses.split('@');
    const withArgs: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.with))
      withArgs[k] = interpolate(v, prepared.ctx);

    if (action === 'actions/checkout') {
      if (withArgs.repository && withArgs.repository !== ctx.repoFullName)
        return {
          error: 'actions/checkout can only check out this repository.',
        };
      const client = new ArtifactsRepoClient(env.ARTIFACTS, ctx.artifactsName);
      const [remote, token] = await Promise.all([
        client.remote(),
        client.token('read'),
      ]);
      const depth = Number(withArgs['fetch-depth'] ?? '1');
      const target = withArgs.ref || ctx.headSha;
      const dest = resolveDir(withArgs.path);
      const branch = ctx.ref.startsWith('refs/heads/')
        ? ctx.ref.slice('refs/heads/'.length)
        : '';
      const fetchSpec =
        depth === 0
          ? `"+refs/heads/*:refs/remotes/origin/*" "+refs/tags/*:refs/tags/*"`
          : `"$TARGET"`;
      const script = [
        `mkdir -p "$DEST" && cd "$DEST"`,
        `git init -q . && git config --global --add safe.directory "$DEST"`,
        `git remote add origin "$PUBLIC_URL" 2>/dev/null || git remote set-url origin "$PUBLIC_URL"`,
        `echo "Fetching $GITHUB_REPOSITORY at $TARGET"`,
        `git -c http.extraHeader="Authorization: Bearer $GITORANGE_TOKEN" fetch -q --no-tags ${depth > 0 ? `--depth ${depth}` : ''} "$REMOTE" ${fetchSpec}`,
        depth === 0
          ? `git checkout -q --force "$TARGET"`
          : `git checkout -q --force FETCH_HEAD`,
        branch && !withArgs.ref ? `git checkout -q -B "$BRANCH"` : '',
        `git log -1 --format='HEAD is now at %h %s'`,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        request: {
          number: state.number,
          argv: [...SHELLS.bash, script],
          cwd: '/',
          env: {
            ...stepEnv,
            GITORANGE_TOKEN: token,
            REMOTE: remote,
            PUBLIC_URL: `${ctx.serverUrl}/${ctx.repoFullName}.git`,
            TARGET: target,
            DEST: dest,
            BRANCH: branch,
          },
          timeoutMs,
          masks: [token],
        },
      };
    }

    if (action === 'actions/setup-node') {
      // GitOrange runners use the image's preinstalled Node.js (current release) rather than
      // downloading another one per job.
      const requested = (withArgs['node-version'] ?? '').replace(/^v/, '');
      const lines = [
        'echo "Using the preinstalled Node.js $(node -v), npm $(npm -v)"',
        ...(requested
          ? [
              `case "$(node -v)" in v${requested.replace(/[^0-9.]/g, '').replace(/\.x$/, '')}*) ;; *) echo ${quoteSh(`Note: node-version ${requested} was requested; GitOrange runners provide the preinstalled Node.js instead.`)} ;; esac`,
            ]
          : []),
      ];
      let cache: CacheState | undefined;
      const env2: Record<string, string> = { ...stepEnv };
      const masks: string[] = [];
      const manager = withArgs.cache?.trim();
      if (manager) {
        const restore = await prepareRestore(env, ctx, {
          paths: [`${WORKSPACE}/node_modules`],
          key: async () => {
            const k = await nodeModulesKey(
              gitForRun(env, ctx),
              ctx.headSha,
              manager,
              RUNNER_NODE_MAJOR,
              withArgs['cache-dependency-path']
            );
            return 'error' in k ? k : { key: k.key };
          },
          restoreKeys: [],
          label: 'node_modules',
        });
        lines.push(restore.script);
        if (restore.url) {
          env2.CACHE_URL = restore.url;
          masks.push(restore.url);
        }
        cache = restore.state ?? undefined;
      }
      return {
        request: {
          number: state.number,
          argv: [...SHELLS.bash, lines.join('\n')],
          cwd: WORKSPACE,
          env: env2,
          timeoutMs,
          masks,
        },
        cache,
      };
    }

    if (action === 'actions/cache') {
      const paths = absolutePaths((withArgs.path ?? '').split('\n'), WORKSPACE);
      const key = withArgs.key?.trim();
      if (!paths.length || !key)
        return { error: 'actions/cache needs `path` and `key`.' };
      const restore = await prepareRestore(env, ctx, {
        paths,
        key: async () => ({ key }),
        restoreKeys: (withArgs['restore-keys'] ?? '')
          .split('\n')
          .map((k) => k.trim())
          .filter(Boolean),
        label: key,
      });
      return {
        request: {
          number: state.number,
          argv: [...SHELLS.bash, restore.script],
          cwd: WORKSPACE,
          env: restore.url ? { ...stepEnv, CACHE_URL: restore.url } : stepEnv,
          timeoutMs,
          masks: restore.url ? [restore.url] : [],
        },
        cache: restore.state ?? undefined,
      };
    }

    return {
      error: `GitOrange Actions doesn't run \`uses: ${uses}\` yet. Supported actions: actions/checkout, actions/setup-node, and actions/cache. Use a \`run:\` step instead.`,
    };
  } catch (e) {
    if (e instanceof ExpressionError) return { error: e.message };
    throw e;
  }
}

// ── cache ────────────────────────────────────────────────────────────────────

/** What a caching step restored; its post step saves under `key` unless it was an exact hit. */
export type CacheState = { key: string; paths: string[]; exact: boolean };

const quoteSh = (t: string) => `'${t.replace(/'/g, `'\\''`)}'`;

function gitForRun(env: CloudflareBindings, ctx: RunContext) {
  return new GitService(
    new ArtifactsRepoClient(env.ARTIFACTS, ctx.artifactsName)
  );
}

/**
 * Finds the entry to restore and returns the script that restores it (with its pre-signed URL)
 * plus the state its post step needs. Missing configuration or a miss is reported in the log and
 * never fails the step; `cache-hit` is written to the step's outputs either way.
 */
async function prepareRestore(
  env: CloudflareBindings,
  ctx: RunContext,
  opts: {
    paths: string[];
    key: () => Promise<{ key: string } | { error: string }>;
    restoreKeys: string[];
    label: string;
  }
): Promise<{ script: string; url: string | null; state: CacheState | null }> {
  const say = (t: string, hit = false) =>
    `echo ${quoteSh(t)}\necho "cache-hit=${hit}" >> "$GITHUB_OUTPUT"`;
  if (!cacheConfigured(env))
    return {
      script: say(
        "The Actions cache isn't set up on this server; continuing without it."
      ),
      url: null,
      state: null,
    };
  const k = await opts.key();
  if ('error' in k) return { script: say(k.error), url: null, state: null };
  const refs = [ctx.ref, `refs/heads/${ctx.defaultBranch}`];
  const found = await findCacheEntry(
    env,
    ctx.repoId,
    refs,
    k.key,
    opts.restoreKeys
  );
  const state: CacheState = {
    key: k.key,
    paths: opts.paths,
    exact: !!found?.exact,
  };
  if (!found)
    return { script: say(`Cache not found for ${k.key}`), url: null, state };
  const url = await cacheUrl(env, found.objectKey, 'GET');
  return {
    script:
      restoreScript(
        opts.paths,
        `${found.key} (${Math.round(found.size / 1048576)} MB)`
      ) + `\necho "cache-hit=${found.exact}" >> "$GITHUB_OUTPUT"`,
    url,
    state,
  };
}
