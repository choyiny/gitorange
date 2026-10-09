import { and, eq } from 'drizzle-orm';
import {
  agents,
  prReviewers,
  prReviewFlags,
  repositories,
  type PrReviewer,
} from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import { d1Of } from '../pulls/events';
import { gitFor } from '../lib/repos';
import { readAgentConfig, type AgentEngine } from '../agents/config';
import {
  plainQuestion,
  type AgentReview,
  type AgentReviewInput,
} from './contract';
import { composeDetail, diffsFor } from './detail';
import type { HeadContext } from './head';
import { ignoreMatcher } from './ignore';
import { readKnowledge } from './knowledge';
import type { PiLimits } from './pi-contract';

/** Files summarized per head; the rest get a fixed one-liner without a model call. */
export const MAX_SUMMARIZED_FILES = 300;

/** How a failed model call is worded on the reviewer row. */
export const MODEL_FAILED = 'The review model failed: ';

/** Ends the summary of an engine: pi review that ran as a single pass because Pi isn't set up here. */
export const PI_FALLBACK_NOTE =
  "engine: pi isn't set up on this server (no AGENT_REVIEWER binding), so this review ran as a single pass.";

/** A started Pi review whose Workflow resumed where the AgentReviewer binding is gone: nothing can finish it. */
export const PI_GONE = "Pi isn't set up any more; Retry the review.";

export type ReviewContext = HeadContext & {
  reviewId: string;
  summaries: string;
  reviewer: {
    reviewerId: string;
    handle: string;
    /**
     * The row's created_at in ms when the review was requested; absent only in a step result cached by a
     * milestone 2 Workflow, which then writes unfenced as before.
     */
    generation?: number;
  };
};

/** A started Pi review: its Durable Object is named from the row's id and this generation. */
export type PiStarted = {
  generation: number;
  startedAt: number;
  /** The deep review model and the limits, read from Site admin when the review started. */
  model: string;
  limits: PiLimits;
};

/** What a Pi review spent, for the agent run (never its transcript). */
export type PiRun = { turns: number; toolCalls: number; durationMs: number };

export type ReviewOutcome = {
  verdict: 'approve' | 'findings' | 'failed' | 'skipped' | 'started';
  needsPerson: number;
  changeRequested: number;
  engine: AgentEngine | null;
  /** engine: pi reviewed as a single pass because Pi isn't set up on this server. */
  fallback?: boolean;
  /** Set with verdict 'started': where the Pi review runs, and with what. */
  started?: PiStarted;
  pi?: PiRun;
  /** Set on a skipped Pi review: why it was stopped (superseded, cancelled). */
  stopped?: string;
  error?: string;
};

export const NO_FINDINGS = {
  needsPerson: 0,
  changeRequested: 0,
  engine: null,
} as const;

const seconds = (ms: number) => Math.floor(ms / 1000);

export type PreparedReview = {
  input: AgentReviewInput;
  changedPaths: string[];
  engine: AgentEngine;
};

/**
 * What one agent reviews with: AGENT.md and knowledge at the row's agent_sha, the pull request, the one-liners, and
 * the numbered diff within the budget. An unreadable agent repository or invalid AGENT.md is an error to record.
 */
export async function prepareReview(
  env: CloudflareBindings,
  db: DrizzleDB,
  ctx: ReviewContext,
  row: PrReviewer
): Promise<{ ok: true; value: PreparedReview } | { ok: false; error: string }> {
  const own = await db
    .select({ repo: repositories })
    .from(agents)
    .innerJoin(repositories, eq(repositories.id, agents.repositoryId))
    .where(eq(agents.userId, row.agentId))
    .get();
  if (!own || !row.agentSha)
    return { ok: false, error: "The agent's repository could not be read." };
  const agentGit = gitFor(env, own.repo);
  const config = await readAgentConfig(agentGit, row.agentSha);
  if (!config.ok) return { ok: false, error: config.error };
  const knowledge = await readKnowledge(agentGit, row.agentSha);
  const git = gitFor(env, ctx.repo);
  const ignored = ignoreMatcher(ctx.ignoreText);
  const notShown = ctx.more.length
    ? `\n\nNot shown (more than ${MAX_SUMMARIZED_FILES} files changed): ${ctx.more.length} more files, listed in the summaries.`
    : '';
  const diffs = (await diffsFor(git, ctx.changes, [], ignored)) + notShown;
  return {
    ok: true,
    value: {
      engine: config.config.engine,
      changedPaths: [...ctx.changes, ...ctx.more].map((c) => c.path),
      input: {
        handle: ctx.reviewer.handle,
        agentSha: row.agentSha,
        instructions: config.config.instructions,
        knowledge,
        title: ctx.pr.title,
        description: ctx.pr.body,
        summaries: ctx.summaries,
        diffs,
      },
    },
  };
}

/** The row is still this attempt: reviewing, with the created_at the review began with. Every reviewer write uses it. */
export const sameAttempt = (row: Pick<PrReviewer, 'id' | 'createdAt'>) =>
  and(
    eq(prReviewers.id, row.id),
    eq(prReviewers.status, 'reviewing'),
    eq(prReviewers.createdAt, row.createdAt)
  );

/**
 * The fence for a write carrying the generation a Workflow step read: this attempt of the row when it has one, or
 * (a step result cached by a milestone 2 Workflow, without one) the row while it is still reviewing.
 */
export const carriedAttempt = (reviewerId: string, generation?: number) =>
  generation === undefined
    ? and(eq(prReviewers.id, reviewerId), eq(prReviewers.status, 'reviewing'))
    : sameAttempt({ id: reviewerId, createdAt: new Date(generation) });

/** Fails a reviewer row, only while this attempt of it is still reviewing. */
export async function failReviewer(
  db: DrizzleDB,
  row: Pick<PrReviewer, 'id' | 'createdAt'>,
  error: string
): Promise<ReviewOutcome> {
  await db
    .update(prReviewers)
    .set({ status: 'failed', error, finishedAt: new Date() })
    .where(sameAttempt(row));
  return { verdict: 'failed', ...NO_FINDINGS, error };
}

/**
 * Records one agent's answer: its findings as agent-owned flags (details composed from the real diff) and the row's
 * outcome, in one D1 batch (a transaction; a raw batch because drizzle's can't bind raw statements). Every statement
 * applies only while the row is still this attempt (reviewing, same created_at), so a cancelled, removed or retried
 * row is never resurrected and keeps no findings of an answer it no longer owns. Inserts go first: after the update
 * the row isn't reviewing.
 */
export async function recordReview(
  env: CloudflareBindings,
  db: DrizzleDB,
  ctx: ReviewContext,
  row: Pick<PrReviewer, 'id' | 'agentId' | 'agentSha' | 'createdAt'>,
  review: AgentReview,
  opts: { modelId: string | null; note?: string }
): Promise<{
  needsPerson: number;
  changeRequested: number;
  /** False when the row was no longer this attempt: nothing was written. */
  recorded: boolean;
}> {
  const git = gitFor(env, ctx.repo);
  const ignored = ignoreMatcher(ctx.ignoreText);
  const flags = await Promise.all(
    review.findings.map(async (f, i) => ({
      id: crypto.randomUUID(),
      key: `${row.agentId}:${i}`,
      finding: f,
      detail: await composeDetail(git, ctx.changes, f, ignored),
    }))
  );
  const changeRequested = review.findings.filter(
    (f) => f.kind === 'change_requested'
  ).length;
  const needsPerson = review.findings.length - changeRequested;
  const summary =
    [review.summary, opts.note ?? ''].filter(Boolean).join(' ') || null;
  const status = changeRequested
    ? 'changes_requested'
    : needsPerson
      ? 'flagged'
      : 'approved';
  const d1 = d1Of(db);
  const at = seconds(Date.now());
  const generation = seconds(row.createdAt.getTime());
  const results = await d1.batch([
    ...flags.map((f) =>
      d1
        .prepare(
          `INSERT OR IGNORE INTO pr_review_flags
             (id, classification_id, key, value, paths, detail, detail_model, agent_id, kind, agent_sha, question,
              created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM pr_reviewers WHERE id = ? AND status = 'reviewing' AND created_at = ?)`
        )
        .bind(
          f.id,
          ctx.reviewId,
          f.key,
          JSON.stringify({ title: f.finding.title }),
          JSON.stringify(f.finding.paths),
          f.detail,
          opts.modelId,
          row.agentId,
          f.finding.kind,
          row.agentSha,
          // The owner's yes/no question: findings for a person only, and only a plain one.
          f.finding.kind === 'needs_person'
            ? plainQuestion(f.finding.question)
            : null,
          at,
          row.id,
          generation
        )
    ),
    d1
      .prepare(
        `UPDATE pr_reviewers SET status = ?, summary = ?, error = NULL, finished_at = ?
          WHERE id = ? AND status = 'reviewing' AND created_at = ?`
      )
      .bind(status, summary, at, row.id, generation),
  ]);
  const recorded = (results[results.length - 1]?.meta.changes ?? 0) > 0;
  return { needsPerson, changeRequested, recorded };
}

/**
 * The outcome a reviewer row already records, for a step re-run after its write landed: its verdict from its
 * status, its findings counted from this review's flags. Rows that never reviewed (not needed, removed) skip.
 */
export async function recordedOutcome(
  db: DrizzleDB,
  reviewId: string,
  row: PrReviewer
): Promise<ReviewOutcome> {
  if (row.status === 'failed')
    return {
      verdict: 'failed',
      ...NO_FINDINGS,
      error: row.error ?? undefined,
    };
  if (
    row.status !== 'approved' &&
    row.status !== 'flagged' &&
    row.status !== 'changes_requested'
  )
    return { verdict: 'skipped', ...NO_FINDINGS };
  const kinds = await db
    .select({ kind: prReviewFlags.kind })
    .from(prReviewFlags)
    .where(
      and(
        eq(prReviewFlags.classificationId, reviewId),
        eq(prReviewFlags.agentId, row.agentId)
      )
    )
    .all();
  const changeRequested = kinds.filter(
    (k) => k.kind === 'change_requested'
  ).length;
  return {
    verdict: row.status === 'approved' ? 'approve' : 'findings',
    needsPerson: kinds.length - changeRequested,
    changeRequested,
    ...(row.summary?.includes(PI_FALLBACK_NOTE)
      ? { engine: 'pi' as const, fallback: true }
      : { engine: 'pass' as const }),
  };
}
