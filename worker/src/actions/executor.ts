import type { WorkflowStepConfig } from 'cloudflare:workers';
import { settleStates } from '../pulls/settle';
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
import { runnerStarted, runnersStopped } from '../usage/record';
import { getSetting } from '../lib/settings';
import {
  actionsQueue,
  markStarted,
  queueConfigured,
  releaseSlot,
  slotEventType,
  slotRecheck,
} from './queue';

/** Each post step (cache save) may take this long. */
const POST_STEP_MINUTES = 30;
import { githubContext, readWorkflowFiles } from './trigger';
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
import {
  parseWorkflow,
  stepDisplayName,
  type JobDef,
  type StepDef,
  type WorkflowDef,
} from './workflow-file';

type Db = DrizzleD1Database<typeof schema>;
type Conclusion = 'success' | 'failure' | 'cancelled' | 'skipped';

/** Subset of WorkflowStep used here; results must be JSON-serializable. */
export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    fn: () => Promise<T>
  ): Promise<T>;
  /** Waits for `instance.sendEvent({ type })`; throws when `timeout` passes first. */
  waitForEvent<T = unknown>(
    name: string,
    options: { type: string; timeout?: string }
  ): Promise<{ payload: T }>;
}

export interface ExecutorDeps {
  env: CloudflareBindings;
  db: Db;
  step: StepRunner;
  runner: (jobId: string) => JobRunnerApi;
  /** Wait before restarting an interrupted job, times the attempt that failed. Default 15s. */
  restartDelayMs?: number;
  /** Clef for `gitorange/relevance`; defaults to Workers AI when the AI binding exists. */
  relevance?: RelevanceModelFor;
}

const DEFAULT_PATH =
  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const NO_RETRY = { retries: { limit: 0, delay: 0 } } as const;
/** How many times a job runs in total when the platform keeps interrupting its runner. */
export const MAX_JOB_ATTEMPTS = 3;

export function logKey(
  repoId: string,
  runId: string,
  jobId: string,
  step: number
) {
  return `actions/${repoId}/${runId}/${jobId}/${step}.log`;
}

/** Loaded in a durable step, so replays reuse it. */
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
  /** Why the job could not start its runner, for the run's error. */
  error?: string;
}

interface StepState {
  outcome: Conclusion;
  conclusion: Conclusion;
  outputs: Record<string, string>;
}

/** Runs one workflow run to completion (ActionsRun Workflow). */
export async function executeRun(
  deps: ExecutorDeps,
  runId: string
): Promise<Conclusion | null> {
  const { env, db } = deps;
  let { step } = deps;
  const ctx = await step.do('load', () => loadRun(env, db, runId));
  if (!ctx || ctx.status === 'completed') return null;
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
    await step.do('states', async () => {
      await settleStates(env, db, ctx.repoId);
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

  // Waves: run every job whose `needs` have finished, in parallel.
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
  const error = [...outcomes.values()].flat().find((o) => o.error)?.error;
  await step.do('finish-run', async () => {
    await finishRun(db, runId, conclusion, error ?? null);
    return true;
  });
  // Passing checks may unblock auto-merge of a PR at this commit.
  if (conclusion === 'success')
    await step.do('auto-merge', async () => {
      await autoMergeForCommit(env, db, ctx.repoId, ctx.headSha).catch((e) =>
        console.error('[actions] auto-merge failed', runId, e)
      );
      return true;
    });
  await step.do('states', async () => {
    await settleStates(env, db, ctx.repoId);
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
  // A skipped dependency blocks success() jobs, like GitHub.
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

/**
 * Waits durably for one of the instance's job slots (ActionsQueue) before a container starts.
 * The grant arrives as a Workflow event; a lost or early event is caught by the next recheck
 * (5, 10, 20, then every 30 minutes), when the queue is asked again. Returns false when the run
 * was cancelled while waiting. Fails open: if the queue can't be reached after its retries, the
 * job runs without a slot (giving it back later is a no-op).
 */
async function waitForSlot(
  deps: ExecutorDeps,
  ctx: RunContext,
  def: JobDef,
  job: RunContext['jobs'][number],
  prefix: string
): Promise<boolean> {
  const { env, db, step } = deps;
  if (!queueConfigured(env)) return true;
  // The slot covers the steps and the cache saves after them.
  const maxMinutes =
    def.timeoutMinutes + POST_STEP_MINUTES * postStepIndexes(def.steps).length;
  const ask = async () => {
    const run = await db
      .select({ status: workflowRuns.status })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, ctx.runId))
      .get();
    if (!run || run.status === 'completed')
      return { cancelled: true, granted: false, ahead: 0 };
    const limit = await getSetting(db, env, 'actions.max_concurrent_jobs');
    const s = await actionsQueue(env).acquire({
      jobId: job.id,
      runId: ctx.runId,
      maxMinutes,
      limit,
    });
    return { cancelled: false, granted: s.granted, ahead: s.ahead };
  };
  const config: WorkflowStepConfig = {
    retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
    timeout: '1 minute',
  };
  try {
    let state = await step.do(`${prefix}:queue`, config, ask);
    for (let i = 1; !state.cancelled && !state.granted; i++) {
      try {
        await step.waitForEvent(`${prefix}:queue:wait:${i}`, {
          type: slotEventType(job.id),
          timeout: slotRecheck(i),
        });
      } catch {
        // Timed out: ask again (this also picks up a grant whose event was lost).
      }
      state = await step.do(`${prefix}:queue:${i}`, config, ask);
    }
    return !state.cancelled;
  } catch (e) {
    console.warn(
      '[actions] job queue unavailable; running without a slot',
      job.id,
      e
    );
    return true;
  }
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
  const posts = postStepIndexes(def.steps);
  const lastStep = def.steps.length + 2 + posts.length;

  // A job whose runner the platform interrupts (a deploy restarts Durable Objects and drops the
  // connection to the container) runs again from the start in a fresh container. A step that
  // fails on its own is never retried.
  let attempt = 1;
  let restartNote: string | null = null;
  let attemptState: AttemptState;
  for (;;) {
    const prefix = attempt === 1 ? name : `${name}:attempt:${attempt}`;
    if (!(await waitForSlot(deps, ctx, def, job, prefix)))
      return { key: def.key, result: 'cancelled', outputs: {} };
    attemptState = await runAttempt(
      deps,
      ctx,
      wf,
      def,
      job,
      runner,
      exprCtx,
      prefix,
      restartNote,
      attempt === MAX_JOB_ATTEMPTS ? attempt : null
    );
    if (!attemptState.interrupted) break;
    const stopped = attemptState.interrupted;
    const next = await step.do(
      `${prefix}:restart`,
      { retries: { limit: 2, delay: '5 seconds' }, timeout: '5 minutes' },
      async () => {
        const run = await db
          .select({ status: workflowRuns.status })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, ctx.runId))
          .get();
        // A cancelled run is already marked finished; its containers were stopped on purpose.
        if (!run || run.status === 'completed') {
          await releaseSlot(env, job.id);
          return 'cancelled' as const;
        }
        try {
          await runner.destroy();
        } catch (e) {
          console.warn('[actions] runner destroy failed', job.id, e);
        }
        await runnersStopped(db, [job.id]);
        // The container is gone: the restart queues again, and meanwhile someone else may use the slot.
        await releaseSlot(env, job.id);
        const wait = (deps.restartDelayMs ?? 15_000) * attempt;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        await db
          .update(workflowSteps)
          .set({
            status: 'queued',
            conclusion: null,
            startedAt: null,
            completedAt: null,
            logR2Key: null,
          })
          .where(eq(workflowSteps.jobId, job.id));
        return 'restart' as const;
      }
    );
    if (next === 'cancelled')
      return { key: def.key, result: 'cancelled', outputs: {} };
    attempt++;
    restartNote = [
      `Restarted after the runner was interrupted (attempt ${attempt} of ${MAX_JOB_ATTEMPTS}).`,
      `Step ${stopped.number} (${stopped.name}) was interrupted: ${stopped.message}`,
      'The job runs again from the start in a new container.',
      '',
    ].join('\n');
  }
  const { steps, caches, jobStatus, setupError } = attemptState;

  // ── Post steps: save caches (GitHub runs them in reverse, on success only) ──
  for (const [k, i] of posts.entries()) {
    const number = def.steps.length + 2 + k;
    const state = caches.get(i);
    await step
      .do(
        `${name}:post:${number}`,
        { ...NO_RETRY, timeout: `${POST_STEP_MINUTES} minutes` },
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
      )
      .catch(() =>
        // Interrupted mid-save: the job already finished, so record the miss and move on.
        step.do(`${name}:post:${number}:interrupted`, async () => {
          await putLog(
            env,
            ctx,
            job.id,
            number,
            'Warning: the runner was interrupted while saving the cache; the job is unaffected.'
          );
          await setStep(db, job.id, number, {
            status: 'completed',
            conclusion: 'skipped',
            completedAt: new Date(),
            logR2Key: logKey(ctx.repoId, ctx.runId, job.id, number),
          });
          return true;
        })
      );
  }

  // ── Complete job ──
  return step.do(`${name}:complete`, async () => {
    try {
      await runner.destroy();
    } catch (e) {
      console.error('[actions] runner destroy failed', job.id, e);
    }
    await runnersStopped(db, [job.id]);
    await releaseSlot(env, job.id);
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
    return {
      key: def.key,
      result,
      outputs,
      ...(setupError && {
        error: `Job "${def.key}" could not start its runner: ${setupError}`,
      }),
    } satisfies JobOutcome;
  });
}

interface AttemptState {
  jobStatus: JobStatus;
  steps: Record<string, Value>;
  /** What each caching step restored, for its post step. */
  caches: Map<number, CacheState>;
  /** Why Set up job failed, when the runner never started. */
  setupError?: string;
  /** The step whose runner went away, when this attempt should be restarted. */
  interrupted?: { number: number; name: string; message: string };
}

/**
 * Sets up the runner and runs the job's steps once. Returns early with `interrupted` when the
 * platform stops the runner under a step, unless `final` is set: then that step fails with the
 * reason and the remaining steps are skipped.
 */
async function runAttempt(
  deps: ExecutorDeps,
  ctx: RunContext,
  wf: WorkflowDef,
  def: JobDef,
  job: RunContext['jobs'][number],
  runner: JobRunnerApi,
  exprCtx: (extra?: Record<string, Value>) => Record<string, Value>,
  name: string,
  restartNote: string | null,
  final: number | null
): Promise<AttemptState> {
  const { db, step, env } = deps;
  const jobTimeoutMs = def.timeoutMinutes * 60_000;
  const deadline = Date.now() + jobTimeoutMs;
  const caches = new Map<number, CacheState>();
  // ── Set up job ──
  // The slot's reclaim deadline counts from the container's start, not the grant. Its own step,
  // so a failed mark is retried without booting twice, and a final failure never fails the job.
  if (queueConfigured(env))
    await step
      .do(
        `${name}:queue:started`,
        {
          retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
          timeout: '1 minute',
        },
        async () => {
          await markStarted(env, job.id);
          return true;
        }
      )
      .catch((err) =>
        console.warn('[actions] could not mark slot started', job.id, err)
      );
  const setupResult = await step
    .do(
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
        let error: string | undefined;
        try {
          const size = instanceTypeFor(job.runsOn);
          // Usage & cost: the container is billed from boot until destroy.
          await runnerStarted(db, {
            id: `${job.id}:${/:attempt:(\d+)$/.exec(name)?.[1] ?? '1'}`,
            jobId: job.id,
            repositoryId: ctx.repoId,
            instanceType: size,
            deadlineAt: new Date(Date.now() + jobTimeoutMs + 10 * 60_000),
          });
          const { ms } = await runner.boot(size, jobTimeoutMs);
          log = [
            ...(restartNote ? [restartNote] : []),
            `Runner: GitOrange Actions (${size})`,
            `Labels: ${job.runsOn}`,
            `Image: Debian (trixie) with Node.js, git, and build tools`,
            `Started in ${(ms / 1000).toFixed(1)}s`,
          ].join('\n');
        } catch (e) {
          ok = false;
          error = e instanceof Error ? e.message : String(e);
          log = `${restartNote ?? ''}Could not start the runner: ${error}`;
        }
        await putLog(env, ctx, job.id, 1, log);
        await setStep(db, job.id, 1, {
          status: 'completed',
          conclusion: ok ? 'success' : 'failure',
          completedAt: new Date(),
          logR2Key: logKey(ctx.repoId, ctx.runId, job.id, 1),
        });
        return { ok, error };
      }
    )
    .catch((e: unknown) => ({
      // The step itself failed (it timed out, or the database or log store was unavailable):
      // nothing was logged, so the next step records why.
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      unlogged: true,
    }));
  // A run replayed from before this step returned an object recorded a bare boolean.
  const setup: { ok: boolean; error?: string; unlogged?: boolean } =
    typeof setupResult === 'boolean' ? { ok: setupResult } : setupResult;
  if (setup.unlogged)
    await step.do(`${name}:setup:failed`, async () => {
      await putLog(
        env,
        ctx,
        job.id,
        1,
        `${restartNote ?? ''}Could not start the runner: ${setup.error}`
      );
      await setStep(db, job.id, 1, {
        status: 'completed',
        conclusion: 'failure',
        completedAt: new Date(),
        logR2Key: logKey(ctx.repoId, ctx.runId, job.id, 1),
      });
      return true;
    });

  let jobStatus: JobStatus = setup.ok ? 'success' : 'failure';
  let runnerGone: string | null = setup.ok ? null : 'The runner did not start.';
  const steps: Record<string, Value> = {};
  let envAdds: Record<string, string> = {};
  let pathAdds: string[] = [];

  for (const [i, s] of def.steps.entries()) {
    const number = i + 2;
    const stepCtx = () => {
      // env layers: workflow → job → GITHUB_ENV → step; each sees the ones before.
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

    if (runnerGone) run = false;

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
              db,
              relevance: deps.relevance ?? defaultRelevance(env),
            });
            if ('error' in cmd) log = `Error: ${cmd.error}`;
            else {
              cache = cmd.cache ?? null;
              const r = await runner.runStep(cmd.request);
              if (r.interrupted) throw new Error(r.interrupted);
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
    if ('crash' in result && final === null)
      return {
        jobStatus,
        steps,
        caches,
        interrupted: {
          number,
          name: stepDisplayName(s),
          message: result.crash,
        },
      };
    if ('crash' in result) runnerGone = result.crash;
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
        await putLog(
          env,
          ctx,
          job.id,
          number,
          `Error: ${result.crash}` +
            (final
              ? `\nThe runner was interrupted on all ${final} attempts, so the job was not restarted again.`
              : '')
        );
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
  return { jobStatus, steps, caches, setupError: setup.error };
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
    db: Db;
    relevance: RelevanceModelFor;
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
      // Uses the image's preinstalled Node.js; no per-job download.
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

    return {
      error: `GitOrange Actions doesn't run \`uses: ${uses}\` yet. Supported actions: actions/checkout, actions/setup-node, actions/cache, and ${RELEVANCE_ACTION}@${RELEVANCE_VERSION}. Use a \`run:\` step instead.`,
    };
  } catch (e) {
    if (e instanceof ExpressionError) return { error: e.message };
    throw e;
  }
}

// ── cache ────────────────────────────────────────────────────────────────────

/** A caching step's restore; its post step saves under `key` unless `exact`. */
export type CacheState = { key: string; paths: string[]; exact: boolean };

const quoteSh = (t: string) => `'${t.replace(/'/g, `'\\''`)}'`;

function gitForRun(env: CloudflareBindings, ctx: RunContext) {
  return new GitService(
    new ArtifactsRepoClient(env.ARTIFACTS, ctx.artifactsName)
  );
}

/**
 * Restore script, its pre-signed URL, and post-step state.
 * Misses never fail the step; `cache-hit` is always set.
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
