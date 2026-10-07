/**
 * The review Workflow's side of an engine: pi review: start the AgentReviewer inside the agent's `review:<handle>`
 * step, then wait for its event (or 2 minutes) and check it, until it answers, fails, runs out of time or budget,
 * or stops being wanted. Each check is its own step (`pi:<handle>:<i>`), so a replayed Workflow re-runs none of
 * them. Nothing here stores a prompt or a transcript.
 */
import type { WorkflowStepConfig } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { prReviewers, pullRequests, type PrReviewer } from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import { gitFor } from '../lib/repos';
import { getSettings } from '../lib/settings';
import type { StepRunner } from '../merge/resolution';
import { recordAiUsage } from '../usage/record';
import { parseAgentReview, ReviewParseError } from './contract';
import {
  failReviewer,
  MODEL_FAILED,
  NO_FINDINGS,
  recordedOutcome,
  recordReview,
  sameAttempt,
  type PiStarted,
  type PreparedReview,
  type ReviewContext,
  type ReviewOutcome,
} from './outcome';
import {
  PI_RECHECK,
  PI_RECHECK_MS,
  piChecks,
  piEventType,
  piReviewerName,
  type PiLimits,
  type PiReviewerApi,
  type PiStatus,
} from './pi-contract';

export const piTimeUp = (limits: PiLimits) =>
  `The Pi review ran out of time (${limits.wallClockMs / 60_000} minutes).`;
/** How every budget message begins, the DO's (piLimitReached) and the Workflow's. */
export const PI_BUDGET_PREFIX = 'The Pi review used up its budget';
export const piBudgetSpent = (limits: PiLimits) =>
  `${PI_BUDGET_PREFIX} (${limits.maxModelCalls} model calls or ${limits.maxInputTokens.toLocaleString('en-US')} input tokens).`;
/**
 * Whether a waitForEvent failure is its timeout: the engine's WorkflowTimeoutError, or its message ("Execution timed
 * out after 120000ms", confirmed in the miniflare engine). A miss only makes a check wait one more interval.
 */
export const isWaitTimeout = (e: unknown) =>
  (e instanceof Error && e.name === 'WorkflowTimeoutError') ||
  /time(d)?\s?out/i.test(e instanceof Error ? e.message : String(e));

/**
 * Checks allowed past piChecks: early events (a notification that came before Pi settled) can use checks up before
 * the wall clock ends, so a check past piChecks still inside the wall clock is allowed, up to this many.
 */
export const PI_EXTRA_CHECKS = 2;

export const PI_LOST =
  "The Pi review's workspace was gone before it answered. Try again.";

export const PI_SUPERSEDED = 'Stopped: a newer commit replaced this one.';
export const PI_CANCELLED = 'Stopped: the review was cancelled or retried.';
export const PI_CLOSED =
  'Stopped: the pull request was closed. Retry reviews it again.';

type StopReason = { status: 'not_needed' | 'failed'; message: string };

/**
 * Why a review of `row` is no longer wanted, or null while it is: the pull request closed (failed, so Retry can
 * review the commit again if it reopens), or its head branch moved off the reviewed commit (not needed: the new
 * commit is reviewed afresh).
 */
async function stopReason(
  env: CloudflareBindings,
  db: DrizzleDB,
  ctx: ReviewContext,
  row: PrReviewer
): Promise<StopReason | null> {
  const pr = await db
    .select({ state: pullRequests.state, headRef: pullRequests.headRef })
    .from(pullRequests)
    .where(eq(pullRequests.id, row.pullRequestId))
    .get();
  if (pr?.state !== 'open') return { status: 'failed', message: PI_CLOSED };
  const head = await gitFor(env, ctx.repo).resolve(pr.headRef);
  if (head !== row.headSha)
    return { status: 'not_needed', message: PI_SUPERSEDED };
  return null;
}

/** Ends this attempt of the row for `stop`, only while it is still reviewing. */
async function endReviewer(
  db: DrizzleDB,
  row: PrReviewer,
  stop: StopReason
): Promise<ReviewOutcome> {
  if (stop.status === 'failed')
    return { ...(await failReviewer(db, row, stop.message)), engine: 'pi' };
  await db
    .update(prReviewers)
    .set({
      status: 'not_needed',
      requested: false,
      summary: stop.message,
      finishedAt: new Date(),
    })
    .where(sameAttempt(row));
  return {
    verdict: 'skipped',
    ...NO_FINDINGS,
    engine: 'pi',
    stopped: stop.message,
  };
}

/** A check reads D1 and asks the DO: short, retried. */
export const PI_CHECK_RETRIES: WorkflowStepConfig = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
};

/**
 * The deep review model and the limits, from Site admin → Settings in one query. Read once, when a review starts:
 * the review carries them in its step result, so a setting changed mid-review applies from the next review.
 */
export async function readPiSettings(
  db: DrizzleDB,
  env: CloudflareBindings
): Promise<{ model: string; limits: PiLimits }> {
  const s = await getSettings(db, env, [
    'ai.review_pi_model',
    'review.pi_minutes',
    'review.pi_max_tool_calls',
    'review.pi_max_model_calls',
    'review.pi_max_input_tokens',
  ]);
  return {
    model: s['ai.review_pi_model'],
    limits: {
      wallClockMs: s['review.pi_minutes'] * 60_000,
      maxToolCalls: s['review.pi_max_tool_calls'],
      maxModelCalls: s['review.pi_max_model_calls'],
      maxInputTokens: s['review.pi_max_input_tokens'],
    },
  };
}

export interface PiDeps {
  env: CloudflareBindings;
  db: DrizzleDB;
  pi: (name: string) => PiReviewerApi;
  /** This Workflow instance, for the DO's "settled" event; null when nothing waits for one. */
  instanceId: string | null;
}

/**
 * Starts (or rejoins) the Pi review of a reviewing row: one AgentReviewer per row attempt, given exactly what the
 * single pass would send. Runs inside the agent's `review:<handle>` step; the DO's start is idempotent, so a retried
 * step joins the same run, and a stopped DO (or a row no longer this attempt) starts nothing: skipped.
 */
export async function startPiReview(
  deps: PiDeps,
  row: PrReviewer,
  prepared: PreparedReview,
  ctx: ReviewContext
): Promise<ReviewOutcome> {
  const generation = row.createdAt.getTime();
  const wanted = await readPiSettings(deps.db, deps.env);
  const effective = await deps.pi(piReviewerName(row.id, generation)).start({
    reviewerId: row.id,
    generation,
    handle: ctx.reviewer.handle,
    input: prepared.input,
    changedPaths: prepared.changedPaths,
    repository: { artifactsName: ctx.repo.artifactsName },
    headSha: row.headSha,
    ignoreText: ctx.ignoreText,
    model: wanted.model,
    limits: wanted.limits,
    notify: deps.instanceId
      ? { instanceId: deps.instanceId, type: piEventType(row.id, generation) }
      : null,
  });
  // Stopped (cancelled, superseded, abandoned) before or while this step ran: nothing to start or wait for.
  if (effective.stopped)
    return {
      verdict: 'skipped',
      ...NO_FINDINGS,
      engine: 'pi',
      stopped: PI_CANCELLED,
    };
  // What the object runs with: a retried step joining an earlier start keeps that start's budgets, whatever the
  // settings say now.
  return {
    verdict: 'started',
    ...NO_FINDINGS,
    engine: 'pi',
    started: {
      generation,
      startedAt: effective.startedAt,
      model: effective.model ?? wanted.model,
      limits: { ...wanted.limits, ...effective.limits },
    },
  };
}

export type PiCheck = AwaitedCheck<ReviewOutcome>;

/** A Pi check that found the review still running changed nothing on screen: pingingSteps' `quiet`. */
export const quietPiCheck = (name: string, result: unknown) =>
  name.startsWith('pi:') &&
  (result as Partial<PiCheck> | null)?.state === 'running';

/**
 * One attempt's spend, as one ai_usage row under a stable id (a later record replaces it), on the step that ends
 * the review.
 */
async function recordPiUsage(
  env: CloudflareBindings,
  ctx: ReviewContext,
  started: Pick<PiStarted, 'generation' | 'model'>,
  s: PiStatus
) {
  await recordAiUsage(env, {
    id: `review-agent-pi:${ctx.reviewer.reviewerId}:${started.generation}`,
    feature: 'review-agent-pi',
    model: started.model,
    requests: Math.max(1, s.turns),
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    tokensCached: s.tokensCached,
    repositoryId: ctx.repo.id,
    pullRequestId: ctx.pr.id,
    classificationId: ctx.reviewId,
  });
}

/**
 * Ends a Pi review from the failure step, best effort and never throwing: records what it spent (if the object still
 * answers) and stops it. Safe on an object that never started, or only got as far as its draft. `model` is the
 * started review's; absent (its start step failed), the deep review model setting.
 */
export async function abandonPiReview(
  deps: PiDeps,
  ctx: ReviewContext,
  generation: number,
  model: string | undefined
): Promise<void> {
  const { reviewerId } = ctx.reviewer;
  const stub = deps.pi(piReviewerName(reviewerId, generation));
  try {
    const status = await stub.status().catch(() => null);
    if (status && status.state !== 'missing')
      await recordPiUsage(
        deps.env,
        ctx,
        {
          generation,
          model: model ?? (await readPiSettings(deps.db, deps.env)).model,
        },
        status
      );
  } catch (e) {
    console.warn(
      '[review] could not record the Pi review usage',
      reviewerId,
      e
    );
  }
  await stub
    .stop()
    .catch((e: unknown) =>
      console.warn('[review] could not stop the Pi reviewer', reviewerId, e)
    );
}

/**
 * One look at a running Pi review. Ends it (records usage, stops the DO) when its row is no longer this attempt,
 * when it answered (parsed with the single pass's parser and recorded with its write), gave up, lost its workspace,
 * ran past the wall clock (or `last`: the bound on checks), or spent its budget; otherwise reports progress.
 */
export async function checkPiReview(
  deps: PiDeps,
  ctx: ReviewContext,
  started: PiStarted,
  last: boolean
): Promise<PiCheck> {
  const { env, db } = deps;
  const stub = deps.pi(
    piReviewerName(ctx.reviewer.reviewerId, started.generation)
  );
  const finish = async (
    outcome: ReviewOutcome,
    status: PiStatus | null
  ): Promise<PiCheck> => {
    if (status && status.state !== 'missing')
      await recordPiUsage(env, ctx, started, status);
    await stub
      .stop()
      .catch((e: unknown) =>
        console.warn(
          '[review] could not stop the Pi reviewer',
          ctx.reviewer.reviewerId,
          e
        )
      );
    return { state: 'finished', outcome };
  };
  const row = await db
    .select()
    .from(prReviewers)
    .where(eq(prReviewers.id, ctx.reviewer.reviewerId))
    .get();
  const thisAttempt = row?.createdAt.getTime() === started.generation;
  // Cancelled, removed, finished by an earlier try of this step, or retried: stop it, write nothing.
  if (!row || !thisAttempt || row.status !== 'reviewing')
    return finish(
      row && thisAttempt
        ? { ...(await recordedOutcome(db, ctx.reviewId, row)), engine: 'pi' }
        : {
            verdict: 'skipped',
            ...NO_FINDINGS,
            engine: 'pi',
            stopped: PI_CANCELLED,
          },
      await stub.status().catch(() => null)
    );
  // Its pull request closed, or a newer commit replaced the head: stop it now rather than at the wall clock.
  const stop = await stopReason(env, db, ctx, row);
  if (stop)
    return finish(
      await endReviewer(db, row, stop),
      await stub.status().catch(() => null)
    );
  const status = await stub.status();
  const run = {
    turns: status.turns,
    toolCalls: status.toolCalls,
    durationMs: Date.now() - started.startedAt,
  };
  const failed = async (error: string) =>
    finish(
      { ...(await failReviewer(db, row, error)), engine: 'pi', pi: run },
      status
    );
  if (status.state === 'missing') return failed(PI_LOST);
  if (status.state === 'running') {
    const { limits } = started;
    if (run.durationMs >= limits.wallClockMs || last)
      return failed(piTimeUp(limits));
    if (
      status.turns > limits.maxModelCalls ||
      (status.tokensIn ?? 0) > limits.maxInputTokens
    )
      return failed(piBudgetSpent(limits));
    return { state: 'running', ...run };
  }
  if (status.state === 'unanswered')
    // The DO stops its own run at the model-call and input-token limits (piLimitReached); said as the Workflow would.
    return failed(
      status.reason.startsWith(PI_BUDGET_PREFIX)
        ? piBudgetSpent(started.limits)
        : `${MODEL_FAILED}Pi did not finish (${status.reason}).`
    );
  let review;
  try {
    review = parseAgentReview(
      status.text,
      [...ctx.changes, ...ctx.more].map((c) => c.path)
    );
  } catch (e) {
    if (e instanceof ReviewParseError)
      return failed(`${MODEL_FAILED}${e.message}`);
    throw e;
  }
  const { recorded, ...counts } = await recordReview(
    env,
    db,
    ctx,
    row,
    review,
    {
      modelId: started.model,
    }
  );
  // The row moved on between this check's read and its write: the answer is no longer this attempt's.
  if (!recorded)
    return finish(
      {
        verdict: 'skipped',
        ...NO_FINDINGS,
        engine: 'pi',
        pi: run,
        stopped: PI_CANCELLED,
      },
      status
    );
  return finish(
    { verdict: review.verdict, ...counts, engine: 'pi', pi: run },
    status
  );
}

/** A check of a running Pi run (a review or a lesson): still running, with its spend, or finished with `outcome`. */
export type AwaitedCheck<O> =
  | { state: 'running'; turns: number; toolCalls: number; durationMs: number }
  | { state: 'finished'; outcome: O };

/**
 * Waits for a started Pi run (a review, or a lesson) to end: its object's event `type`, or PI_RECHECK, then a check
 * step, until a check ends it. Steps are named `<wait>:<i>` and `<check>:<i>`. A check past the wall clock ends it;
 * so does the bound on checks, `piChecks(limits)` (which covers the wall clock when no event comes early) plus
 * PI_EXTRA_CHECKS: `run(last)` is told when it is the last.
 */
export async function awaitChecks<O>(
  step: StepRunner,
  o: {
    wait: string;
    check: string;
    type: string;
    limits: PiLimits;
    run: (last: boolean) => Promise<AwaitedCheck<O>>;
  }
): Promise<O> {
  for (let i = 1; ; i++) {
    const wait = `${o.wait}:${i}`;
    if (!step.waitForEvent) await step.sleep(wait, PI_RECHECK_MS);
    else
      try {
        await step.waitForEvent(wait, { type: o.type, timeout: PI_RECHECK });
      } catch (e) {
        // Timed out: check anyway. Any other failure (no event support): wait the interval out instead, so checks
        // never run back to back and the last one never ends a run early.
        if (!isWaitTimeout(e)) await step.sleep(`${wait}:sleep`, PI_RECHECK_MS);
      }
    const check = await step.do(`${o.check}:${i}`, PI_CHECK_RETRIES, () =>
      o.run(i >= piChecks(o.limits) + PI_EXTRA_CHECKS)
    );
    if (check.state === 'finished') return check.outcome;
  }
}

/** Waits for a started Pi review to end (awaitChecks: `pi-wait:<handle>:<i>`, `pi:<handle>:<i>`). */
export async function awaitPiReview(
  deps: PiDeps,
  step: StepRunner,
  ctx: ReviewContext,
  started: PiStarted
): Promise<ReviewOutcome> {
  const { handle, reviewerId } = ctx.reviewer;
  return awaitChecks(step, {
    wait: `pi-wait:${handle}`,
    check: `pi:${handle}`,
    type: piEventType(reviewerId, started.generation),
    limits: started.limits,
    run: (last) => checkPiReview(deps, ctx, started, last),
  });
}
