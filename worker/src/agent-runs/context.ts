/**
 * The agent run step a piece of code runs in. The recorder (record.ts) enters it around each
 * Workflow step's callback, so model calls (`recordAiUsage`) and decisions (`noteDecision`) made
 * inside land on that step without the executors passing anything around. Never throws.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { eq } from 'drizzle-orm';
import { agentSteps, aiUsage } from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import { aiTokenCost, priceBookFor } from '../usage/pricing';

export interface AgentStepContext {
  /** The recorder's database handle. */
  db: DrizzleDB;
  stepId: string;
}

const current = new AsyncLocalStorage<AgentStepContext>();

export const inAgentStep = <T>(ctx: AgentStepContext, fn: () => Promise<T>) =>
  current.run(ctx, fn);

export const currentAgentStep = (): AgentStepContext | undefined =>
  current.getStore();

/** Decisions are short: never more than this many characters. */
export const MAX_DECISION = 1000;

export function clip(text: string, max = MAX_DECISION): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Records what the current step decided, in a few words (never a prompt, a diff, or long model
 * text). Outside an agent run step it does nothing.
 */
export async function noteDecision(summary: string): Promise<void> {
  const ctx = currentAgentStep();
  if (!ctx || !summary.trim()) return;
  try {
    await ctx.db
      .update(agentSteps)
      .set({ decision: clip(summary) })
      .where(eq(agentSteps.id, ctx.stepId));
  } catch (e) {
    console.warn('[agent-runs] could not note a decision', ctx.stepId, e);
  }
}

/** Recomputes a step's models, tokens and cost from the ai_usage rows that point at it. */
export async function refreshStepUsage(
  db: DrizzleDB,
  stepId: string
): Promise<void> {
  try {
    const rows = await db
      .select({
        model: aiUsage.model,
        tokensIn: aiUsage.tokensIn,
        tokensOut: aiUsage.tokensOut,
        createdAt: aiUsage.createdAt,
      })
      .from(aiUsage)
      .where(eq(aiUsage.agentStepId, stepId))
      .all();
    if (!rows.length) return;
    const models = [...new Set(rows.map((r) => r.model))];
    const sum = (k: 'tokensIn' | 'tokensOut') =>
      rows.some((r) => r[k] !== null)
        ? rows.reduce((n, r) => n + (r[k] ?? 0), 0)
        : null;
    let cost: number | null = null;
    for (const r of rows) {
      const c = aiTokenCost(
        priceBookFor(r.createdAt.toISOString().slice(0, 10)),
        r.model,
        r.tokensIn ?? 0,
        r.tokensOut ?? 0
      );
      if (c !== null) cost = (cost ?? 0) + c;
    }
    await db
      .update(agentSteps)
      .set({
        model: models.join(', '),
        tokensIn: sum('tokensIn'),
        tokensOut: sum('tokensOut'),
        costEstimate: cost,
      })
      .where(eq(agentSteps.id, stepId));
  } catch (e) {
    console.warn('[agent-runs] could not record step usage', stepId, e);
  }
}
