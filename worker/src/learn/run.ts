/**
 * A lesson on the MERGE_RESOLUTION Workflow: claim it and start the learner (`learn:<handle>`), then wait for its
 * event (or 2 minutes) and check it (`learn-check:<handle>:<n>`, review/pi.ts awaitChecks) until it answers, fails,
 * runs out of time or budget, or stops being this run's; then start the agent's next pending lesson
 * (`next:<handle>`). Step results carry ids, verdicts and counts only: never prompts, files or the summary.
 */
import { eq } from 'drizzle-orm';
import { AGENT_PATH, readAgentConfig } from '../agents/config';
import { shortError } from '../agent-runs/record';
import { agentLessons } from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import { gitFor } from '../lib/repos';
import { getSettings } from '../lib/settings';
import type { StepRunner } from '../merge/resolution';
import { AGENT_REVIEW_RETRIES } from '../review/head';
import { awaitChecks, PI_BUDGET_PREFIX, type AwaitedCheck } from '../review/pi';
import type { PiLimits, PiStatus } from '../review/pi-contract';
import {
  learnerInput,
  learnerName,
  learnEventType,
  type LearnerApi,
} from './contract';
import {
  commitLesson,
  failLesson,
  outcomeOf,
  recordLearnUsage,
  type LearnOutcome,
} from './finish';
import {
  claimLesson,
  dropLesson,
  lessonAttempt,
  lessonInput,
  loadLesson,
  startNextLesson,
} from './lessons';

export const LEARN_FAILED = 'The learning model failed: ';
export const LEARN_LOST = "The lesson's workspace was gone before it answered.";
export const LEARN_STOPPED =
  'The learner was stopped before the lesson started.';
export const LEARN_NO_PI =
  "Learning runs on Pi, which isn't set up on this server (no AGENT_REVIEWER binding).";
export const learnTimeUp = (limits: PiLimits) =>
  `The lesson ran out of time (${limits.wallClockMs / 60_000} minutes).`;
export const learnBudgetSpent = (limits: PiLimits) =>
  `The lesson used up its budget (${limits.maxModelCalls} model calls or ${limits.maxInputTokens.toLocaleString('en-US')} input tokens).`;

/** The deep review model and the learning limits, read once when a lesson starts. */
export async function readLearnSettings(
  db: DrizzleDB,
  env: CloudflareBindings
): Promise<{ model: string; limits: PiLimits }> {
  const s = await getSettings(db, env, [
    'ai.review_pi_model',
    'review.learn_minutes',
    'review.learn_max_tool_calls',
    'review.learn_max_model_calls',
    'review.learn_max_input_tokens',
  ]);
  return {
    model: s['ai.review_pi_model'],
    limits: {
      wallClockMs: s['review.learn_minutes'] * 60_000,
      maxToolCalls: s['review.learn_max_tool_calls'],
      maxModelCalls: s['review.learn_max_model_calls'],
      maxInputTokens: s['review.learn_max_input_tokens'],
    },
  };
}

export interface LearnDeps {
  env: CloudflareBindings;
  db: DrizzleDB;
  step: StepRunner;
  /** The AgentReviewer by name; absent where AGENT_REVIEWER isn't bound. */
  learner?: (name: string) => LearnerApi;
  /** This Workflow instance: the lesson's run_id once claimed, and where the learner's event goes. */
  instanceId: string;
}

export type LearnStarted = {
  attempt: number;
  startedAt: number;
  model: string;
  limits: PiLimits;
};

export type LearnStart =
  | { verdict: 'started'; started: LearnStarted }
  /** Another lesson of the agent is learning: that run starts this one when it ends. */
  | { verdict: 'waiting' }
  /** Not pending (ended, or another run has it), or the learner refused to start. */
  | { verdict: 'skipped' }
  /** The agent was deleted: the lesson is gone. */
  | { verdict: 'dropped' }
  | { verdict: 'failed'; error: string };

export type LearnCheck = AwaitedCheck<LearnOutcome>;

/**
 * Claims the lesson and starts its learner (inside `learn:<handle>`, retried as a review's start is). A retried step
 * whose earlier try already claimed it (the lesson is learning under this run) resumes that attempt, reading the
 * agent repository's tip if no base commit was recorded yet; the learner's start is idempotent.
 */
export async function startLesson(
  deps: LearnDeps,
  lessonId: string
): Promise<LearnStart> {
  const { env, db, instanceId } = deps;
  const loaded = await loadLesson(db, lessonId);
  if (!loaded) return { verdict: 'skipped' };
  const { lesson, agentRepo } = loaded;
  if (loaded.agent.deletedAt || !agentRepo) {
    await dropLesson(db, lessonId);
    return { verdict: 'dropped' };
  }
  const failStart = async (error: string): Promise<LearnStart> => {
    await failLesson(db, lessonId, instanceId, error, false);
    return { verdict: 'failed', error };
  };
  let attempt: number;
  let baseSha = lesson.baseSha;
  if (lesson.status === 'learning' && lesson.runId === instanceId) {
    attempt = lesson.attempts;
  } else {
    if (lesson.status !== 'pending') return { verdict: 'skipped' };
    const claim = await claimLesson(db, lesson, instanceId);
    if (claim === 'busy') return { verdict: 'waiting' };
    if (claim === 'taken') return { verdict: 'skipped' };
    attempt = claim.attempt;
    baseSha = null;
  }
  if (!deps.learner) return failStart(LEARN_NO_PI);
  if (!baseSha) {
    const git = gitFor(env, agentRepo);
    const tip = await git.resolve(agentRepo.defaultBranch);
    if (!tip) return failStart("The agent's repository could not be read.");
    const config = await readAgentConfig(git, tip);
    if (!config.ok)
      return failStart(
        `${AGENT_PATH} on ${agentRepo.defaultBranch} is invalid: ${config.error}`
      );
    baseSha = tip;
    await db
      .update(agentLessons)
      .set({ baseSha })
      .where(lessonAttempt(lessonId, instanceId));
  }
  const wanted = await readLearnSettings(db, env);
  const effective = await deps
    .learner(learnerName(lessonId, attempt))
    .startLearning({
      lessonId,
      runId: instanceId,
      attempt,
      handle: loaded.handle,
      agentRepository: { artifactsName: agentRepo.artifactsName },
      baseSha,
      input: learnerInput(await lessonInput(db, loaded)),
      model: wanted.model,
      limits: wanted.limits,
      notify: { instanceId, type: learnEventType(lessonId, attempt) },
    });
  // Stopped before it ran: end this run's claim (fenced) so the agent's next lesson can start; the sweep may retry.
  if (effective.stopped) {
    await failLesson(db, lessonId, instanceId, LEARN_STOPPED, true);
    return { verdict: 'failed', error: LEARN_STOPPED };
  }
  // What the object runs with: a retried step joining an earlier start keeps that start's limits.
  return {
    verdict: 'started',
    started: {
      attempt,
      startedAt: effective.startedAt,
      model: effective.model ?? wanted.model,
      limits: { ...wanted.limits, ...effective.limits },
    },
  };
}

/**
 * One look at a running learner. Ends it (records usage, stops the object) when the lesson is no longer this run's,
 * when it answered (validated and committed by commitLesson), gave up, lost its workspace, ran past the wall clock
 * (or `last`), or spent its budget; otherwise reports progress.
 */
export async function checkLesson(
  deps: LearnDeps,
  lessonId: string,
  started: LearnStarted,
  last: boolean
): Promise<LearnCheck> {
  const { env, db, instanceId } = deps;
  if (!deps.learner) throw new Error(LEARN_NO_PI);
  const stub = deps.learner(learnerName(lessonId, started.attempt));
  const lesson = await db
    .select()
    .from(agentLessons)
    .where(eq(agentLessons.id, lessonId))
    .get();
  const finish = async (
    outcome: LearnOutcome,
    status: PiStatus | null
  ): Promise<LearnCheck> => {
    if (lesson && status && status.state !== 'missing')
      await recordLearnUsage(env, lesson, started, status);
    await stub
      .stop()
      .catch((e: unknown) =>
        console.warn('[learn] could not stop the learner', lessonId, e)
      );
    return { state: 'finished', outcome };
  };
  // Requeued, reclaimed by another run, or gone: stop this learner, write nothing.
  if (
    !lesson ||
    lesson.runId !== instanceId ||
    lesson.attempts !== started.attempt
  )
    return finish(
      { verdict: 'skipped' },
      await stub.status().catch(() => null)
    );
  // Ended by an earlier try of this step (its write landed, the step result didn't).
  if (lesson.status !== 'learning')
    return finish(outcomeOf(lesson), await stub.status().catch(() => null));
  const status = await stub.status();
  const durationMs = Date.now() - started.startedAt;
  const failed = async (error: string) =>
    finish(await failLesson(db, lessonId, instanceId, error, true), status);
  if (status.state === 'missing') return failed(LEARN_LOST);
  if (status.state === 'running') {
    const { limits } = started;
    if (durationMs >= limits.wallClockMs || last)
      return failed(learnTimeUp(limits));
    if (
      status.turns > limits.maxModelCalls ||
      (status.tokensIn ?? 0) > limits.maxInputTokens
    )
      return failed(learnBudgetSpent(limits));
    return {
      state: 'running',
      turns: status.turns,
      toolCalls: status.toolCalls,
      durationMs,
    };
  }
  if (status.state === 'unanswered')
    // The DO stops its own run at the limits (piLimitReached); said as the Workflow would.
    return failed(
      status.reason.startsWith(PI_BUDGET_PREFIX)
        ? learnBudgetSpent(started.limits)
        : `${LEARN_FAILED}Pi did not finish (${status.reason}).`
    );
  const { files } = await stub.learned();
  return finish(
    await commitLesson(env, db, lesson, instanceId, files, status.text),
    status
  );
}

/** Ends a started learner from the failure step, best effort: records its spend and stops it. Never throws. */
export async function abandonLesson(
  deps: LearnDeps,
  lessonId: string,
  started: LearnStarted | null
): Promise<void> {
  try {
    const lesson = await deps.db
      .select()
      .from(agentLessons)
      .where(eq(agentLessons.id, lessonId))
      .get();
    if (!lesson || lesson.runId !== deps.instanceId || !deps.learner) return;
    const attempt = started?.attempt ?? lesson.attempts;
    const stub = deps.learner(learnerName(lessonId, attempt));
    try {
      const status = await stub.status().catch(() => null);
      if (status && status.state !== 'missing')
        await recordLearnUsage(
          deps.env,
          lesson,
          {
            attempt,
            model:
              started?.model ??
              (await readLearnSettings(deps.db, deps.env)).model,
          },
          status
        );
    } catch (e) {
      console.warn('[learn] could not record the lesson usage', lessonId, e);
    }
    await stub
      .stop()
      .catch((e: unknown) =>
        console.warn('[learn] could not stop the learner', lessonId, e)
      );
  } catch (e) {
    console.warn('[learn] could not abandon the lesson', lessonId, e);
  }
}

/** Learns one lesson (MERGE_RESOLUTION Workflow, payload `{ learn: { lessonId } }`). */
export async function executeLearn(
  deps: LearnDeps,
  lessonId: string
): Promise<void> {
  const { step, db } = deps;
  const who = await step.do('lesson', async () => {
    const l = await loadLesson(db, lessonId);
    return l ? { handle: l.handle, agentId: l.lesson.agentId } : null;
  });
  if (!who) return;
  const { handle, agentId } = who;
  let started: LearnStarted | null = null;
  try {
    const start = await step.do(`learn:${handle}`, AGENT_REVIEW_RETRIES, () =>
      startLesson(deps, lessonId)
    );
    // The lesson still waits: the run of the agent's learning lesson starts the next one when it ends.
    if (start.verdict === 'waiting') return;
    if (start.verdict === 'started') {
      const s = start.started;
      started = s;
      await awaitChecks(step, {
        wait: `learn-wait:${handle}`,
        check: `learn-check:${handle}`,
        type: learnEventType(lessonId, s.attempt),
        limits: s.limits,
        run: (last) => checkLesson(deps, lessonId, s, last),
      });
    }
  } catch (e) {
    console.error('[learn] lesson failed', lessonId, e);
    const error = `${LEARN_FAILED}${shortError(e)}`;
    await step.do(`learn-failed:${handle}`, async () => {
      await abandonLesson(deps, lessonId, started);
      await failLesson(db, lessonId, deps.instanceId, error, true);
      return true;
    });
  }
  await step.do(`next:${handle}`, () => startNextLesson(deps.env, db, agentId));
}
