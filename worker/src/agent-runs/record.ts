/**
 * Records every MERGE_RESOLUTION Workflow (review, conflict resolution, stack discovery, sweep) as
 * an agent run with steps, for the Actions tab. Applied once, at the Workflow entrypoint, around the
 * step runner the executors receive.
 *
 * Replay-safe: the run id is the Workflow instance id and a step's id is `<run>:<step name>`, so a
 * replayed Workflow (which re-runs its code and gets completed steps back from the cache) finds its
 * rows instead of adding new ones. Recording never fails a step or the Workflow: every write is
 * caught and logged.
 */
import { landTargetOf } from '../lib/land-target';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  agentRuns,
  agentSteps,
  mergeResolutions,
  prClassifications,
  pullRequests,
  type AgentRunKind,
  type AgentRunStatus,
  type ClassifierAnswer,
} from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import { publishChange } from '../live/publish';
import type { StepRunner } from '../merge/resolution';
import type { MergeResolutionParams } from '../merge/workflow';
import { clip, inAgentStep } from './context';

/** A failed run's or step's error: its first line, short. */
export function shortError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return clip(text.split('\n')[0] || 'Failed', 300);
}

async function safe<T>(what: string, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[agent-runs] could not ${what}`, e);
    return undefined;
  }
}

export interface AgentRunInfo {
  kind: AgentRunKind;
  repositoryId: string;
  pullRequestId: string | null;
  title: string;
}

/** What a Workflow payload is about, for the run's row; null when its records are gone. */
export async function describeRun(
  db: DrizzleDB,
  payload: MergeResolutionParams
): Promise<AgentRunInfo | null> {
  if (payload.classificationId) {
    const row = await db
      .select({
        headSha: prClassifications.headSha,
        pullRequestId: pullRequests.id,
        repositoryId: pullRequests.repositoryId,
      })
      .from(prClassifications)
      .innerJoin(
        pullRequests,
        eq(pullRequests.id, prClassifications.pullRequestId)
      )
      .where(eq(prClassifications.id, payload.classificationId))
      .get();
    return row
      ? {
          kind: 'review',
          repositoryId: row.repositoryId,
          pullRequestId: row.pullRequestId,
          title: `Review of ${row.headSha.slice(0, 7)}`,
        }
      : null;
  }
  if (payload.resolutionId) {
    const row = await db
      .select({
        baseRef: pullRequests.baseRef,
        landTarget: pullRequests.landTarget,
        pullRequestId: pullRequests.id,
        repositoryId: pullRequests.repositoryId,
      })
      .from(mergeResolutions)
      .innerJoin(
        pullRequests,
        eq(pullRequests.id, mergeResolutions.pullRequestId)
      )
      .where(eq(mergeResolutions.id, payload.resolutionId))
      .get();
    return row
      ? {
          kind: 'conflict_resolution',
          repositoryId: row.repositoryId,
          pullRequestId: row.pullRequestId,
          title: `Resolve conflicts with ${landTargetOf(row)}`,
        }
      : null;
  }
  if (payload.stack) {
    const pr = await db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        repositoryId: pullRequests.repositoryId,
      })
      .from(pullRequests)
      .where(eq(pullRequests.id, payload.stack.pullRequestId))
      .get();
    return pr
      ? {
          kind: 'stack_discovery',
          repositoryId: pr.repositoryId,
          pullRequestId: pr.id,
          title: `Stack discovery for #${pr.number}`,
        }
      : null;
  }
  if (payload.sweep)
    return {
      kind: 'sweep',
      repositoryId: payload.sweep.repositoryId,
      pullRequestId: null,
      title: clip(
        `Sweep after a push to ${payload.sweep.branches.join(', ')}`,
        200
      ),
    };
  return null;
}

const p2 = (n: number) => n.toFixed(2);

/** Clef's answers in a line: `related: yes 0.90; kind: conflicts 0.95`. */
export function answersSummary(answers: unknown): string | null {
  if (!answers || typeof answers !== 'object') return null;
  const parts = Object.entries(answers as Record<string, ClassifierAnswer>)
    .map(([id, a]) => {
      if (a?.type === 'noul') return `${id}: yes ${p2(a.value)}`;
      if (a?.type === 'choice' || a?.type === 'score')
        return `${id}: ${a.value} ${p2(a.confidence)}`;
      return null;
    })
    .filter(Boolean);
  return parts.length ? parts.join('; ') : null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const firstLine = (s: unknown) =>
  typeof s === 'string' ? (s.trim().split('\n')[0] ?? '') : '';

/**
 * A decision summary from a step's result, where the result is the decision. Tolerant of shapes:
 * anything unexpected gives no summary.
 */
export function decisionFor(name: string, result: unknown): string | null {
  const r = result as any;
  switch (name.split(':')[0]) {
    case 'summary':
      return typeof r?.path === 'string'
        ? `${r.path}${r.unsummarized ? ' (not summarized)' : ''}`
        : null;
    case 'classify':
    case 'decide':
      return answersSummary(r);
    case 'explain':
      return r?.kind
        ? `${r.kind}${r.prerequisite ? `, ${r.prerequisite} first` : ''}${
            r.reason ? `: ${firstLine(r.reason)}` : ''
          }`
        : null;
    case 'conflicts':
      if (!Array.isArray(r)) return null;
      return r.length
        ? `Conflicts in ${plural(r.length, 'file')}: ${r.join(', ')}`
        : 'No textual conflicts';
    case 'independent':
      return 'Unrelated';
    case 'claim':
      return r === false ? 'Already checked at these commits' : null;
    case 'prepare':
      if (typeof r?.error === 'string') return r.error;
      return r?.value?.files
        ? plural(Object.keys(r.value.files).length, 'conflicted file')
        : null;
    case 'resolve':
      if (!r?.status) return null;
      return r.status === 'done'
        ? `Resolved ${plural(Object.keys(r.files ?? {}).length, 'file')}${
            firstLine(r.explanation) ? `: ${firstLine(r.explanation)}` : ''
          }`
        : `Did not finish${r.reason ? ` (${r.reason})` : ''}`;
    case 'commit':
      if (typeof r?.error === 'string') return r.error;
      return typeof r?.value === 'string'
        ? `Proposed ${r.value.slice(0, 7)}`
        : null;
    case 'targets':
      return Array.isArray(r)
        ? `${plural(r.length, 'open pull request')} to check`
        : null;
    case 'pr':
      return r === true ? 'Started an AI conflict resolution' : null;
    default:
      return null;
  }
}

/** Why a run that finished without throwing still failed: its review or resolution failed. */
async function outcomeError(
  db: DrizzleDB,
  runId: string,
  payload: MergeResolutionParams
): Promise<string | null> {
  if (payload.classificationId) {
    const row = await db
      .select({
        status: prClassifications.status,
        error: prClassifications.errorMessage,
      })
      .from(prClassifications)
      .where(eq(prClassifications.id, payload.classificationId))
      .get();
    return row?.status === 'failed'
      ? (row.error ?? 'The review failed.')
      : null;
  }
  if (payload.resolutionId) {
    const row = await db
      .select({
        status: mergeResolutions.status,
        error: mergeResolutions.errorMessage,
      })
      .from(mergeResolutions)
      .where(eq(mergeResolutions.id, payload.resolutionId))
      .get();
    return row?.status === 'failed'
      ? (row.error ?? 'The resolution failed.')
      : null;
  }
  // Stack discovery and sweeps: a failed step (a pair that could not be checked) fails the run.
  const failed = await db
    .select({ name: agentSteps.name, error: agentSteps.error })
    .from(agentSteps)
    .where(and(eq(agentSteps.runId, runId), eq(agentSteps.status, 'failed')))
    .orderBy(agentSteps.position)
    .get();
  return failed ? (failed.error ?? `Step ${failed.name} failed.`) : null;
}

/** The error of a run or step closed because it never finished (stale, or cut off). */
export const DID_NOT_FINISH = 'Did not finish';

/** A Workflow still marked running this long after it started was terminated or died. */
export const AGENT_RUN_STALE_MS = 2 * 3600_000;

/** Open, or closed only because it looked stale: a real finish may still overwrite it. */
const stillOpenRun = or(
  eq(agentRuns.status, 'running'),
  and(eq(agentRuns.status, 'failed'), eq(agentRuns.error, DID_NOT_FINISH))
);
const stillOpenStep = or(
  isNull(agentSteps.finishedAt),
  and(eq(agentSteps.status, 'failed'), eq(agentSteps.error, DID_NOT_FINISH))
);

/** A run's status for display: one still running long after it started did not finish. */
export function displayedStatus(r: {
  status: AgentRunStatus;
  startedAt: Date;
  error: string | null;
}): { status: AgentRunStatus; error: string | null } {
  return r.status === 'running' &&
    Date.now() - r.startedAt.getTime() > AGENT_RUN_STALE_MS
    ? { status: 'failed', error: DID_NOT_FINISH }
    : { status: r.status, error: r.error };
}

/**
 * Closes a run still open (the first real close wins on replay; it overrides a stale close), and
 * closes its steps that never finished: succeeded with a run that succeeded, else failed.
 */
export async function closeAgentRun(
  db: DrizzleDB,
  runId: string,
  error: string | null
): Promise<void> {
  const now = new Date();
  const closed = await db
    .update(agentRuns)
    .set({
      status: error ? 'failed' : 'succeeded',
      error: error ? clip(error, 300) : null,
      finishedAt: now,
    })
    .where(and(eq(agentRuns.id, runId), stillOpenRun))
    .returning({ id: agentRuns.id });
  if (closed.length)
    await closeOpenSteps(db, [runId], error ? 'failed' : 'succeeded', now);
}

/** Closes the unfinished steps of these runs (≤ 90 ids). */
export async function closeOpenSteps(
  db: DrizzleDB,
  runIds: string[],
  status: 'succeeded' | 'failed',
  now = new Date()
): Promise<void> {
  if (!runIds.length) return;
  await db
    .update(agentSteps)
    .set({
      status,
      finishedAt: now,
      error: status === 'failed' ? DID_NOT_FINISH : null,
    })
    .where(
      and(inArray(agentSteps.runId, runIds), isNull(agentSteps.finishedAt))
    );
}

const sqlIncrement = sql`${agentSteps.attempts} + 1`;
/** A decision noted during the step (noteDecision) wins over one read from its result. */
const coalesceDecision = (d: string) =>
  sql`COALESCE(${agentSteps.decision}, ${d})`;

/** Wraps a step runner so each step is recorded on the run. */
function recordingSteps(
  db: DrizzleDB,
  runId: string,
  inner: StepRunner
): StepRunner {
  // Assigned when the executor reaches a step: deterministic, so the same on every replay.
  let position = 0;
  const steps = {
    async do(name: string, ...args: unknown[]): Promise<unknown> {
      const pos = position++;
      const id = `${runId}:${name}`;
      const fn = args[args.length - 1] as () => Promise<unknown>;
      // Set when an attempt runs; a replayed step (result from the cache) only repairs a lost finish.
      let ran = false;
      // Runs once per attempt; never on replay of a completed step.
      const attempt = async () => {
        ran = true;
        await safe('record a step start', () =>
          db
            .insert(agentSteps)
            .values({
              id,
              runId,
              position: pos,
              name,
              status: 'running',
              startedAt: new Date(),
              attempts: 1,
            })
            .onConflictDoUpdate({
              target: agentSteps.id,
              set: {
                status: 'running',
                attempts: sqlIncrement,
                error: null,
                // A retry decides afresh.
                decision: null,
              },
            })
        );
        return inAgentStep({ db, stepId: id }, fn);
      };
      const callArgs = args.length > 1 ? [args[0], attempt] : [attempt];
      const finish = (
        status: 'succeeded' | 'failed',
        detail: { decision?: string | null; error?: string | null }
      ) =>
        safe('record a step end', async () => {
          const now = new Date();
          const decision = detail.decision ? clip(detail.decision) : null;
          const error = detail.error ?? null;
          if (!ran) {
            // Replayed: normally a no-op; finishes a step whose first finish write was lost.
            await db
              .update(agentSteps)
              .set({ status, finishedAt: now, error })
              .where(and(eq(agentSteps.id, id), stillOpenStep));
            return;
          }
          // One statement; only a step still open is updated, so the first finish wins.
          await db
            .insert(agentSteps)
            .values({
              id,
              runId,
              position: pos,
              name,
              status,
              startedAt: now,
              finishedAt: now,
              attempts: 1,
              decision,
              error,
            })
            .onConflictDoUpdate({
              target: agentSteps.id,
              set: {
                status,
                finishedAt: now,
                error,
                ...(decision ? { decision: coalesceDecision(decision) } : {}),
              },
              setWhere: stillOpenStep,
            });
        });
      let result: unknown;
      try {
        // Called as a method: in production `inner` is an RPC stub, where `do.apply` would be
        // sent as a call to a method named "apply".
        result = await (
          inner as unknown as { do: (...a: unknown[]) => Promise<unknown> }
        ).do(name, ...callArgs);
      } catch (e) {
        await finish('failed', { error: shortError(e) });
        throw e;
      }
      await finish('succeeded', { decision: decisionFor(name, result) });
      return result;
    },
    // A sleep (a sweep's settle delay) isn't a step: nothing to record.
    sleep: (name: string, duration: number) => inner.sleep(name, duration),
  };
  return steps as unknown as StepRunner;
}

/**
 * Runs a MERGE_RESOLUTION Workflow body as a recorded agent run. Returns (or throws) exactly what
 * the body does.
 */
export async function recordAgentRun<T>(
  env: CloudflareBindings,
  db: DrizzleDB,
  event: { instanceId: string; payload: MergeResolutionParams },
  step: StepRunner,
  body: (step: StepRunner) => Promise<T>
): Promise<T> {
  const info = await safe('describe a run', () =>
    describeRun(db, event.payload)
  );
  const runId = event.instanceId;
  const started =
    info &&
    (await safe('record a run start', async () => {
      await db
        .insert(agentRuns)
        .values({
          id: runId,
          workflowInstanceId: event.instanceId,
          repositoryId: info.repositoryId,
          pullRequestId: info.pullRequestId,
          kind: info.kind,
          status: 'running',
          title: info.title,
          startedAt: new Date(),
        })
        .onConflictDoNothing();
      return true;
    }));
  if (!info || !started) return body(step);
  await publishChange(env, info.repositoryId);
  let out: T;
  try {
    out = await body(recordingSteps(db, runId, step));
  } catch (e) {
    await safe('record a run end', () =>
      closeAgentRun(db, runId, shortError(e))
    );
    await publishChange(env, info.repositoryId);
    throw e;
  }
  await safe('record a run end', async () =>
    closeAgentRun(db, runId, await outcomeError(db, runId, event.payload))
  );
  await publishChange(env, info.repositoryId);
  return out;
}
