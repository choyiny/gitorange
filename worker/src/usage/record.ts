/**
 * Usage GitOrange attributes itself, as it happens: Actions runner containers (boot to destroy)
 * and Workers AI calls with their token counts. Recording never fails the work it describes.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import {
  aiUsage,
  prClassifications,
  pullRequests,
  runnerSessions,
  usageDaily,
} from '../db/app.schema';
import { productOf } from './pricing';
import type { DrizzleDB } from '../db/middleware';
import type { AiFeature } from '../lib/ai-gateway';
import { currentAgentStep, refreshStepUsage } from '../agent-runs/context';

export interface TokenUsage {
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCached: number | null;
}

const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Token counts from a Workers AI response (OpenAI-style `usage`), when the model reports them. */
export function usageFromResponse(out: unknown): TokenUsage {
  const u = (out as { usage?: Record<string, any> } | null)?.usage;
  if (!u || typeof u !== 'object')
    return { tokensIn: null, tokensOut: null, tokensCached: null };
  return {
    tokensIn: num(u.prompt_tokens) ?? num(u.input_tokens),
    tokensOut: num(u.completion_tokens) ?? num(u.output_tokens),
    tokensCached:
      num(u.prompt_tokens_details?.cached_tokens) ??
      num(u.input_tokens_details?.cached_tokens),
  };
}

/**
 * Summed token counts of a pi transcript (the merge resolver's messages: entry records whose `model` holds the
 * messages, or plain messages): every assistant message carries `usage: { input, output, cacheRead }`. Returns the
 * call count too.
 */
export function usageFromTranscript(
  messages: unknown
): TokenUsage & { requests: number } {
  let requests = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCached = 0;
  let reported = false;
  // The pi harness's transcript is entry records, each carrying its model messages under `model`.
  const flat = (Array.isArray(messages) ? messages : []).flatMap((e) =>
    e && typeof e === 'object' && Array.isArray((e as any).model)
      ? ((e as any).model as unknown[])
      : [e]
  );
  for (const m of flat) {
    if (!m || typeof m !== 'object' || (m as any).role !== 'assistant')
      continue;
    requests++;
    const u = (m as any).usage;
    if (!u || typeof u !== 'object') continue;
    reported = true;
    // pi reports cache reads apart from `input`; Workers AI bills them as input tokens.
    tokensIn += (num(u.input) ?? 0) + (num(u.cacheRead) ?? 0);
    tokensOut += num(u.output) ?? 0;
    tokensCached += num(u.cacheRead) ?? 0;
  }
  return reported
    ? { requests, tokensIn, tokensOut, tokensCached }
    : { requests, tokensIn: null, tokensOut: null, tokensCached: null };
}

export interface AiUsageRecord extends TokenUsage {
  /** Set to make the record replace an earlier one (e.g. a retried resolution). */
  id?: string;
  feature: AiFeature;
  model: string;
  requests?: number;
  repositoryId?: string | null;
  pullRequestId?: string | null;
  classificationId?: string | null;
  mergeResolutionId?: string | null;
}

export async function recordAiUsage(
  env: Pick<CloudflareBindings, 'DB'>,
  r: AiUsageRecord
): Promise<void> {
  // Inside an agent run step (the MERGE_RESOLUTION Workflow), the call also lands on that step.
  const step = currentAgentStep();
  try {
    const db = drizzle(env.DB, { schema });
    const values = {
      id: r.id ?? crypto.randomUUID(),
      createdAt: new Date(),
      feature: r.feature,
      model: r.model,
      requests: r.requests ?? 1,
      repositoryId: r.repositoryId ?? null,
      pullRequestId: r.pullRequestId ?? null,
      classificationId: r.classificationId ?? null,
      mergeResolutionId: r.mergeResolutionId ?? null,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      tokensCached: r.tokensCached,
      agentStepId: step?.stepId ?? null,
    };
    const { id: _, createdAt: __, ...update } = values;
    await db
      .insert(aiUsage)
      .values(values)
      .onConflictDoUpdate({ target: aiUsage.id, set: update });
  } catch (e) {
    console.warn('[usage] could not record AI usage', r.feature, e);
  }
  if (step) await refreshStepUsage(step.db, step.stepId);
}

/** The pull request and repository an auto-merge review belongs to. */
export async function classificationTarget(
  env: Pick<CloudflareBindings, 'DB'>,
  classificationId: string
): Promise<{ repositoryId: string; pullRequestId: string } | null> {
  try {
    const db = drizzle(env.DB, { schema });
    const row = await db
      .select({
        pullRequestId: pullRequests.id,
        repositoryId: pullRequests.repositoryId,
      })
      .from(prClassifications)
      .innerJoin(
        pullRequests,
        eq(pullRequests.id, prClassifications.pullRequestId)
      )
      .where(eq(prClassifications.id, classificationId))
      .get();
    return row ?? null;
  } catch {
    return null;
  }
}

/** Marks a runner container as started (or restarted, when a boot step is retried). */
export async function runnerStarted(
  db: DrizzleDB,
  s: {
    id: string;
    jobId: string;
    repositoryId: string;
    instanceType: string;
    /** When the JobRunner's orphan alarm destroys the container at the latest. */
    deadlineAt: Date;
  }
) {
  try {
    const startedAt = new Date();
    await db
      .insert(runnerSessions)
      .values({ ...s, startedAt, stoppedAt: null })
      .onConflictDoUpdate({
        target: runnerSessions.id,
        set: {
          instanceType: s.instanceType,
          startedAt,
          stoppedAt: null,
          deadlineAt: s.deadlineAt,
        },
      });
  } catch (e) {
    console.warn('[usage] could not record runner start', s.id, e);
  }
}

/** Marks every running container of these jobs as stopped. */
export async function runnersStopped(db: DrizzleDB, jobIds: string[]) {
  if (!jobIds.length) return;
  try {
    await db
      .update(runnerSessions)
      .set({ stoppedAt: new Date() })
      .where(
        and(
          inArray(runnerSessions.jobId, jobIds),
          isNull(runnerSessions.stoppedAt)
        )
      );
  } catch (e) {
    console.warn('[usage] could not record runner stop', jobIds, e);
  }
}

/** Adds to a GitOrange-counted metric for today (e.g. an email sent). Never throws. */
export async function countUsage(
  env: Pick<CloudflareBindings, 'DB'>,
  metric: string,
  amount = 1,
  resource = ''
) {
  try {
    const db = drizzle(env.DB, { schema });
    const now = new Date();
    await db
      .insert(usageDaily)
      .values({
        date: now.toISOString().slice(0, 10),
        product: productOf(metric),
        metric,
        resource,
        quantity: amount,
        source: 'gitorange',
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: [usageDaily.date, usageDaily.metric, usageDaily.resource],
        set: {
          quantity: sql`${usageDaily.quantity} + ${amount}`,
          fetchedAt: now,
        },
      });
  } catch (e) {
    console.warn('[usage] could not count', metric, e);
  }
}
