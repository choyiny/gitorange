import type { WorkflowStepConfig } from 'cloudflare:workers';
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  notExists,
  notInArray,
} from 'drizzle-orm';
import {
  agents,
  prClassifications,
  prReviewers,
  pullRequests,
  repositories,
  repositoryAgents,
  type PrClassification,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import type { FileChange } from '../git/service';
import { pingingSteps } from '../live/publish';
import { settleStates } from '../pulls/settle';
import { landTargetOf } from '../lib/land-target';
import { findRepoById, gitFor } from '../lib/repos';
import { getSetting } from '../lib/settings';
import { isRateLimited } from '../lib/ai-retry';
import { resolutionConfigured, type StepRunner } from '../merge/resolution';
import { noteDecision } from '../agent-runs/context';
import { shortError } from '../agent-runs/record';
import { readAgentConfig, type AgentEngine } from '../agents/config';
import { ensureStacking } from '../stack/discover';
import { chunks } from '../stack/view';
import { maybeAutoMerge } from './auto-merge';
import { decideDelegated, delegatesAny, type DelegateModel } from './delegate';
import {
  MODEL_RETRIES,
  SUMMARY_BATCH,
  summarizeFile,
  summaryLines,
  type Summarized,
} from './detail';
import { ignoreMatcher, readIgnore } from './ignore';
import { headReviewFor, headReviewId, hasInvitedAgents } from './keys';
import { clipDescription, oneLine } from './contract';
import { classifierModel, type AgentReviewModels } from './models';
import type { RetryResult } from './reviewers';
import {
  failReviewer,
  MAX_SUMMARIZED_FILES,
  MODEL_FAILED,
  NO_FINDINGS,
  PI_FALLBACK_NOTE,
  PI_GONE,
  prepareReview,
  recordedOutcome,
  recordReview,
  carriedAttempt,
  type PiStarted,
  type ReviewContext,
  type ReviewOutcome,
} from './outcome';
import {
  abandonPiReview,
  awaitPiReview,
  quietPiCheck,
  startPiReview,
} from './pi';
import type { PiReviewerApi } from './pi-contract';

export { MAX_SUMMARIZED_FILES } from './outcome';
export type { ReviewContext, ReviewOutcome } from './outcome';

/** Reviews run on the MERGE_RESOLUTION Workflow, like AI conflict resolution. */
export const reviewConfigured = resolutionConfigured;

/** Above this many changed files nothing is reviewed: the review fails and a person approves. */
export const MAX_REVIEW_FILES = 5000;
export const TOO_MANY_FILES =
  'Too many files to review automatically — a person must approve.';

/** The paths listed but not summarized are carried in the load step's result: their total size is capped too. */
export const MAX_MORE_PATH_BYTES = 512 * 1024;

/** A review (or one agent's) still in progress this long after it started was cut off: its Workflow died. */
export const REVIEW_STALE_MS = 2 * 3600_000;
export const REVIEW_STOPPED = 'The review stopped unexpectedly. Try again.';

/** One agent's review: a long prompt, so a long timeout; retried three times (30, 60, 120 s apart). */
export const AGENT_REVIEW_RETRIES: WorkflowStepConfig = {
  retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
};

/**
 * A review whose step still failed only because Workers AI was rate limiting waits this long (plus up to a quarter
 * more, by reviewer) and runs again, round by round; only after the last round is the reviewer marked failed.
 */
export const RATE_LIMIT_WAITS_MS = [120_000, 300_000, 600_000];
export const RATE_LIMITED =
  'The review model was rate limited (Workers AI) for too long. Try again.';

/** A stable spread in [0, 1) per reviewer and round, so a replayed sleep keeps its length. */
function spread(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++)
    h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return h / 2 ** 32;
}

export type InvitedAgent = {
  agentId: string;
  handle: string;
  /** Its repository's default-branch tip: the commit its review reads. */
  agentSha: string | null;
  ask: string | null;
  above: number | null;
  engine: AgentEngine;
  /** Why it can't review (repository gone or unreadable, AGENT.md invalid); null when it can. */
  error: string | null;
};

/**
 * The agents invited to a repository (all, or `only` that one), each with AGENT.md read at its repository's
 * default-branch tip. Deleted agents are never invited.
 */
export async function invitedAgentsAt(
  env: CloudflareBindings,
  db: DrizzleDB,
  repositoryId: string,
  only?: string
): Promise<InvitedAgent[]> {
  const rows = await db
    .select({
      agentId: agents.userId,
      handle: users.username,
      repo: repositories,
    })
    .from(repositoryAgents)
    .innerJoin(agents, eq(agents.userId, repositoryAgents.agentId))
    .innerJoin(users, eq(users.id, agents.userId))
    .leftJoin(repositories, eq(repositories.id, agents.repositoryId))
    .where(
      and(
        eq(repositoryAgents.repositoryId, repositoryId),
        isNull(agents.deletedAt),
        only ? eq(agents.userId, only) : undefined
      )
    )
    .orderBy(asc(users.username))
    .all();
  return Promise.all(
    rows.map(async (r): Promise<InvitedAgent> => {
      const base: InvitedAgent = {
        agentId: r.agentId,
        handle: r.handle ?? r.agentId,
        agentSha: null,
        ask: null,
        above: null,
        engine: 'pass',
        error: null,
      };
      if (!r.repo)
        return { ...base, error: "The agent's repository was deleted." };
      const git = gitFor(env, r.repo);
      const sha = await git.resolve(r.repo.defaultBranch).catch(() => null);
      if (!sha)
        return { ...base, error: "The agent's repository could not be read." };
      const config = await readAgentConfig(git, sha).catch(
        (e: unknown) =>
          ({
            ok: false,
            error: `AGENT.md could not be read: ${shortError(e)}`,
          }) as const
      );
      if (!config.ok) return { ...base, agentSha: sha, error: config.error };
      return {
        ...base,
        agentSha: sha,
        ask: config.config.trigger.ask,
        above: config.config.trigger.above,
        engine: config.config.engine,
      };
    })
  );
}

/**
 * Starts stack discovery for a pull request's reviewed head, if that is still its head. Discovery waits on the
 * review, so every way a review ends (finished, failed, stopped, never started) calls this. Never throws.
 */
async function startStacking(
  env: CloudflareBindings,
  db: DrizzleDB,
  pullRequestId: string,
  headSha: string
) {
  try {
    const pr = await db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.id, pullRequestId))
      .get();
    const found = pr && (await findRepoById(db, pr.repositoryId));
    if (!pr || !found) return;
    const git = gitFor(env, found.repo);
    const [base, head] = await Promise.all([
      git.resolve(landTargetOf(pr)),
      git.resolve(pr.headRef),
    ]);
    if (base && head && head === headSha)
      await ensureStacking(env, db, git, pr, { base, head });
  } catch (e) {
    console.error('[review] could not start stacking', pullRequestId, e);
  }
}

async function failHeadReview(db: DrizzleDB, id: string, message: string) {
  await db
    .update(prClassifications)
    .set({ status: 'failed', errorMessage: message, finishedAt: new Date() })
    .where(eq(prClassifications.id, id));
}

/**
 * Starts reviewing a pull request's head commit, once: only where AI is configured and agents are invited.
 * Returns the commit's review (null when none runs here).
 */
export async function ensureHeadReview(
  env: CloudflareBindings,
  db: DrizzleDB,
  pr: PullRequest,
  shas: { head: string }
): Promise<PrClassification | null> {
  if (!reviewConfigured(env) || pr.state !== 'open') return null;
  const existing = await headReviewFor(db, pr.id, shas.head);
  if (existing && (await isStale(db, existing))) {
    // Its Workflow died: stop it (Retry starts it again) rather than reuse it forever.
    await stopHeadReview(db, existing.id);
    await startStacking(env, db, pr.id, shas.head);
    await settleStates(env, db, pr.repositoryId);
    return (await headReviewFor(db, pr.id, shas.head)) ?? null;
  }
  if (existing) return existing;
  if (!(await hasInvitedAgents(db, pr.repositoryId))) return null;
  const now = new Date();
  const row: PrClassification = {
    id: headReviewId(pr.id, shas.head),
    pullRequestId: pr.id,
    headSha: shas.head,
    status: 'summarizing',
    summaryModel: await getSetting(db, env, 'ai.summary_model'),
    classifierModel: classifierModel('clef'),
    files: null,
    errorMessage: null,
    durationMs: null,
    createdAt: now,
    finishedAt: null,
  };
  const inserted = await db
    .insert(prClassifications)
    .values(row)
    .onConflictDoNothing()
    .returning({ id: prClassifications.id });
  // Another trigger got here first.
  if (!inserted.length)
    return (await headReviewFor(db, pr.id, shas.head)) ?? null;
  try {
    await env.MERGE_RESOLUTION.create({
      id: `review-${crypto.randomUUID()}`,
      params: { headReview: { id: row.id } },
    });
  } catch (e) {
    console.error('[review] could not start', row.id, e);
    await failHeadReview(
      db,
      row.id,
      'The review could not be started. Try again.'
    );
    // Discovery would otherwise wait on a review that never runs.
    await startStacking(env, db, pr.id, shas.head);
    return { ...row, status: 'failed' };
  }
  return row;
}

export type HeadContext = {
  pr: PullRequest;
  repo: Repository;
  /** The first MAX_SUMMARIZED_FILES changed files, in full. */
  changes: FileChange[];
  /** The rest, by path only: they are listed, never read (keeps the load step's result small). */
  more: Pick<FileChange, 'path' | 'status'>[];
  ignoreText: string | null;
};

/**
 * What reviewing `headSha` reads: the pull request, its repository, the files it changes since its merge base
 * with base_ref, and `.orangeignore` from its land target (a pull request can't hide its own files). More than
 * MAX_REVIEW_FILES changed files, or more than MAX_MORE_PATH_BYTES of paths beyond the summarized ones, is an
 * error.
 */
export async function loadHead(
  env: CloudflareBindings,
  db: DrizzleDB,
  pullRequestId: string,
  headSha: string
): Promise<
  { ok: true; value: HeadContext } | { ok: false; error: string } | null
> {
  const pr = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.id, pullRequestId))
    .get();
  const found = pr && (await findRepoById(db, pr.repositoryId));
  if (!pr || !found) return null;
  const git = gitFor(env, found.repo);
  const baseTip = await git.resolve(pr.baseRef);
  const mergeBase = baseTip && (await git.mergeBase(baseTip, headSha));
  const [from, to] = await Promise.all([
    mergeBase ? git.commit(mergeBase) : null,
    git.commit(headSha),
  ]);
  if (!from || !to)
    return { ok: false, error: 'The commits could not be read.' };
  const all = await git.diffTrees(from.treeHash, to.treeHash);
  if (all.length > MAX_REVIEW_FILES)
    return { ok: false, error: TOO_MANY_FILES };
  const changes = all.slice(0, MAX_SUMMARIZED_FILES);
  const more = all
    .slice(MAX_SUMMARIZED_FILES)
    .map(({ path, status }) => ({ path, status }));
  const encoder = new TextEncoder();
  let moreBytes = 0;
  for (const m of more) moreBytes += encoder.encode(m.path).length;
  if (moreBytes > MAX_MORE_PATH_BYTES)
    return { ok: false, error: TOO_MANY_FILES };
  const targetTip = await git.resolve(landTargetOf(pr));
  const ignoreText = targetTip ? await readIgnore(git, targetTip) : null;
  return {
    ok: true,
    value: { pr, repo: found.repo, changes, more, ignoreText },
  };
}

export interface AgentReviewDeps {
  env: CloudflareBindings;
  db: DrizzleDB;
  step: StepRunner;
  models: AgentReviewModels;
  /** The AgentReviewer Durable Object by name; absent where AGENT_REVIEWER isn't bound (engine: pi falls back). */
  pi?: (name: string) => PiReviewerApi;
  /** This Workflow instance, for the Pi reviewer's "settled" event. */
  instanceId?: string;
  /**
   * The model GitOrange AI decides delegated findings with once a review finishes ("Let Claude decide"); undefined:
   * the instance's reasoning model (none without an AI binding), null: none.
   */
  delegate?: DelegateModel | null;
}

/**
 * One agent's review, run inside its `review:<handle>` step: prepare its input (AGENT.md and knowledge at the row's
 * agent_sha, the diff within the budget), then either start its Pi review (engine: pi where AGENT_REVIEWER is bound;
 * the checks that follow finish it) or make the single-pass call and record the outcome in one fenced write. Throws
 * when the model fails (the step retries). Skips a row that is no longer reviewing (its agent was removed, or an
 * earlier attempt finished it).
 */
export async function runAgentReview(
  deps: Omit<AgentReviewDeps, 'step'>,
  ctx: ReviewContext
): Promise<ReviewOutcome> {
  const { env, db, models } = deps;
  const row = await db
    .select()
    .from(prReviewers)
    .where(eq(prReviewers.id, ctx.reviewer.reviewerId))
    .get();
  if (!row) return { verdict: 'skipped', ...NO_FINDINGS };
  if (row.status !== 'reviewing') return recordedOutcome(db, ctx.reviewId, row);
  // A Retry renewed the row after this Workflow requested it: the new attempt is its own Workflow's.
  const { generation } = ctx.reviewer;
  if (generation !== undefined && row.createdAt.getTime() !== generation)
    return { verdict: 'skipped', ...NO_FINDINGS };
  // Every write is fenced by the generation this Workflow carried, never one re-read later.
  const attempt =
    generation === undefined
      ? row
      : { ...row, createdAt: new Date(generation) };
  const prepared = await prepareReview(env, db, ctx, row);
  if (!prepared.ok) return failReviewer(db, attempt, prepared.error);
  const { input, changedPaths, engine } = prepared.value;
  if (engine === 'pi' && deps.pi)
    return startPiReview(
      { env, db, pi: deps.pi, instanceId: deps.instanceId ?? null },
      attempt,
      prepared.value,
      ctx
    );
  const review = await models
    .review(input, changedPaths)
    .catch((e: unknown) => {
      throw new Error(`${MODEL_FAILED}${shortError(e)}`);
    });
  // engine: pi without the AgentReviewer binding: the single pass, said out loud.
  const fallback = engine === 'pi';
  const { recorded, ...counts } = await recordReview(
    env,
    db,
    ctx,
    attempt,
    review,
    {
      modelId: models.reviewModelId ?? null,
      note: fallback ? PI_FALLBACK_NOTE : undefined,
    }
  );
  // The row moved on while the model answered (cancelled, removed, retried): nothing was written.
  if (!recorded) return { verdict: 'skipped', ...NO_FINDINGS };
  return {
    verdict: review.verdict,
    ...counts,
    engine,
    ...(fallback ? { fallback: true } : {}),
  };
}

/**
 * One agent's review: its `review:<handle>` step (the single pass, or a Pi review's start followed by its checks);
 * after the step's retries, a step that records the failure (and stops a started Pi review).
 */
export async function reviewStep(
  deps: AgentReviewDeps,
  step: StepRunner,
  ctx: ReviewContext
): Promise<void> {
  const { db } = deps;
  const { handle, reviewerId } = ctx.reviewer;
  let started: PiStarted | undefined;
  try {
    let outcome: ReviewOutcome;
    // Rate limited after every retry: wait (durably) and run it again; anything else fails the reviewer.
    for (let round = 0; ; round++) {
      try {
        outcome = await step.do(
          round ? `review-again-${round}:${handle}` : `review:${handle}`,
          AGENT_REVIEW_RETRIES,
          () => runAgentReview(deps, ctx)
        );
        break;
      } catch (e) {
        if (!isRateLimited(e)) throw e;
        if (round >= RATE_LIMIT_WAITS_MS.length) throw new Error(RATE_LIMITED);
        const wait = RATE_LIMIT_WAITS_MS[round];
        await step.sleep(
          `rate-limited-${round + 1}:${handle}`,
          Math.round(wait * (1 + spread(`${reviewerId}:${round}`) / 4))
        );
      }
    }
    if (outcome.started) {
      started = outcome.started;
      // Started, but the binding was removed since: nothing can check or finish the review here.
      if (!deps.pi) throw new Error(PI_GONE);
      await awaitPiReview(
        {
          env: deps.env,
          db,
          pi: deps.pi,
          instanceId: deps.instanceId ?? null,
        },
        step,
        ctx,
        started
      );
    }
  } catch (e) {
    console.error('[review] agent review failed', reviewerId, e);
    const message = shortError(e);
    // The model's failures arrive already worded; anything else (git, D1, the DO) says the review failed.
    const error =
      message.startsWith(MODEL_FAILED) ||
      message === PI_GONE ||
      message === RATE_LIMITED
        ? message
        : `The review failed: ${message}`;
    await step.do(`review-failed:${handle}`, async () => {
      // Whether or not the start step returned: it may have failed after the object began (a slow checkout, a lost
      // reply), and an object left running spends until it expires. Stopping one that never started is harmless.
      const generation = started?.generation ?? ctx.reviewer.generation;
      if (deps.pi && generation !== undefined)
        await abandonPiReview(
          {
            env: deps.env,
            db,
            pi: deps.pi,
            instanceId: deps.instanceId ?? null,
          },
          ctx,
          generation,
          started?.model
        );
      // The same fence as every reviewer write: only this attempt, still reviewing.
      await db
        .update(prReviewers)
        .set({ status: 'failed', error, finishedAt: new Date() })
        .where(
          carriedAttempt(
            reviewerId,
            started?.generation ?? ctx.reviewer.generation
          )
        );
      return true;
    });
  }
}

const p2 = (p: number | null) => (p === null ? 'no answer' : p.toFixed(2));

/** The reviewers step's decision: who was requested, who wasn't, who couldn't review. */
function triggerDecision(
  rows: { handle: string; status: string; probability: number | null }[]
) {
  const list = (status: string, withP: boolean) =>
    rows
      .filter((r) => r.status === status)
      .map((r) =>
        withP ? `@${r.handle} (${p2(r.probability)})` : `@${r.handle}`
      )
      .join(', ');
  const requested = list('reviewing', true);
  const notNeeded = list('not_needed', true);
  const failed = list('failed', false);
  return [
    requested ? `Requested ${requested}` : 'Requested nobody',
    notNeeded && `not needed: ${notNeeded}`,
    failed && `can't review: ${failed}`,
  ]
    .filter(Boolean)
    .join('; ');
}

/** Reviews one pull request commit with its repository's agents (MERGE_RESOLUTION Workflow). */
export async function executeHeadReview(deps: AgentReviewDeps, id: string) {
  const { env, db } = deps;
  let step = deps.step;
  const job = await step
    .do('load', async () => {
      const row = await db
        .select()
        .from(prClassifications)
        .where(eq(prClassifications.id, id))
        .get();
      if (!row || row.status === 'done' || row.status === 'failed') return null;
      const loaded = await loadHead(
        env,
        db,
        row.pullRequestId,
        row.headSha
      ).catch(
        (e: unknown) =>
          ({
            ok: false,
            error: `The pull request could not be read: ${shortError(e)}`,
          }) as const
      );
      if (!loaded) return null;
      if (!loaded.ok)
        return {
          ok: false as const,
          error: loaded.error,
          pullRequestId: row.pullRequestId,
          headSha: row.headSha,
        };
      return {
        ok: true as const,
        headSha: row.headSha,
        // The row's generation: a Retry deletes the row and inserts it again with a new created_at.
        createdAt: row.createdAt.getTime(),
        ...loaded.value,
        startedAt: Date.now(),
      };
    })
    .catch((e: unknown) => {
      // Even loading failed (after its retries): never leave the review in progress, or discovery waiting.
      console.error('[review] could not load', id, e);
      return 'stopped' as const;
    });
  if (job === 'stopped') {
    await step
      .do('fail', async () => {
        const stopped = await stopHeadReview(db, id);
        if (stopped) await startStacking(env, db, stopped.pr, stopped.head);
        return true;
      })
      .catch((err: unknown) =>
        console.error('[review] could not record the failure', id, err)
      );
    return;
  }
  if (!job) return;
  if (!job.ok) {
    await step.do('fail', async () => {
      await failHeadReview(db, id, job.error);
      return true;
    });
    // A review that can't load (too many files, unreadable) never finishes: discovery mustn't wait on it.
    await step.do('stacking', async () => {
      await startStacking(env, db, job.pullRequestId, job.headSha);
      return true;
    });
    return;
  }
  step = pingingSteps(env, step, job.pr.repositoryId, {
    approvals: true,
    quiet: quietPiCheck,
  });
  try {
    await reviewHead(deps, step, id, job);
  } catch (e) {
    // Never left in progress: an unfinished review would be reused for this commit and block it for good.
    console.error('[review] stopped', id, e);
    await step
      .do('fail', async () => {
        await stopHeadReview(db, id);
        return true;
      })
      .catch((err: unknown) =>
        console.error('[review] could not record the failure', id, err)
      );
    await step
      .do('stacking', async () => {
        await startStacking(env, db, job.pr.id, job.headSha);
        return true;
      })
      .catch((err: unknown) =>
        console.error('[review] could not start stacking', id, err)
      );
  }
}

/**
 * Fails a review that stopped unexpectedly, and its reviewers still reviewing; a finished review stays. Returns
 * the stopped review's pull request and head (undefined when there was nothing to stop).
 */
async function stopHeadReview(
  db: DrizzleDB,
  id: string
): Promise<{ pr: string; head: string } | undefined> {
  const message = REVIEW_STOPPED;
  const now = new Date();
  const review = await db
    .update(prClassifications)
    .set({ status: 'failed', errorMessage: message, finishedAt: now })
    .where(
      and(
        eq(prClassifications.id, id),
        notInArray(prClassifications.status, ['done', 'failed'])
      )
    )
    .returning({
      pr: prClassifications.pullRequestId,
      head: prClassifications.headSha,
    })
    .get();
  if (review)
    await db
      .update(prReviewers)
      .set({ status: 'failed', error: message, finishedAt: now })
      .where(
        and(
          eq(prReviewers.pullRequestId, review.pr),
          eq(prReviewers.headSha, review.head),
          eq(prReviewers.status, 'reviewing')
        )
      );
  return review;
}

/**
 * A review in progress is stale once it started REVIEW_STALE_MS ago and none of its reviewers started within that
 * time (a reviewer's Retry restarts its clock and puts the commit's review back in progress).
 */
function staleHeadReview(db: DrizzleDB, cutoff: Date) {
  return and(
    notInArray(prClassifications.status, ['done', 'failed']),
    lt(prClassifications.createdAt, cutoff),
    notExists(
      db
        .select({ id: prReviewers.id })
        .from(prReviewers)
        .where(
          and(
            eq(prReviewers.pullRequestId, prClassifications.pullRequestId),
            eq(prReviewers.headSha, prClassifications.headSha),
            eq(prReviewers.status, 'reviewing'),
            gte(prReviewers.createdAt, cutoff)
          )
        )
    )
  );
}

async function isStale(db: DrizzleDB, review: PrClassification) {
  if (review.status === 'done' || review.status === 'failed') return false;
  const cutoff = new Date(Date.now() - REVIEW_STALE_MS);
  if (review.createdAt >= cutoff) return false;
  return !!(await db
    .select({ id: prClassifications.id })
    .from(prClassifications)
    .where(
      and(eq(prClassifications.id, review.id), staleHeadReview(db, cutoff))
    )
    .get());
}

/** Rows handled per batch, and batches per run (a backlog clears over several days). */
const STALE_BATCH = 50;
const STALE_MAX_BATCHES = 20;

/**
 * Stops reviews whose Workflow died (daily retention): head reviews in progress past REVIEW_STALE_MS (with their
 * reviewers; discovery is started as for any review that ends), then single agents' reviews left reviewing that
 * long (a Retry whose Workflow died). Pull states of the pull requests touched are settled. Retry starts either
 * again.
 */
export async function stopStaleReviews(
  env: CloudflareBindings,
  db: DrizzleDB,
  now = new Date()
): Promise<{ reviews: number; reviewers: number }> {
  const cutoff = new Date(now.getTime() - REVIEW_STALE_MS);
  const touched = new Set<string>();
  let reviews = 0;
  for (let i = 0; i < STALE_MAX_BATCHES; i++) {
    const batch = await db
      .select({ id: prClassifications.id })
      .from(prClassifications)
      .where(staleHeadReview(db, cutoff))
      .limit(STALE_BATCH)
      .all();
    for (const r of batch) {
      const stopped = await stopHeadReview(db, r.id);
      if (!stopped) continue;
      reviews += 1;
      touched.add(stopped.pr);
      await startStacking(env, db, stopped.pr, stopped.head);
    }
    if (batch.length < STALE_BATCH) break;
  }
  const failed = await db
    .update(prReviewers)
    .set({ status: 'failed', error: REVIEW_STOPPED, finishedAt: now })
    .where(
      and(
        eq(prReviewers.status, 'reviewing'),
        lt(prReviewers.createdAt, cutoff)
      )
    )
    .returning({ pr: prReviewers.pullRequestId });
  for (const f of failed) touched.add(f.pr);
  if (touched.size) {
    const repos = new Set<string>();
    for (const part of chunks([...touched], 90))
      for (const r of await db
        .select({ repo: pullRequests.repositoryId })
        .from(pullRequests)
        .where(inArray(pullRequests.id, part))
        .all())
        repos.add(r.repo);
    for (const repo of repos) await settleStates(env, db, repo);
  }
  return { reviews, reviewers: failed.length };
}

type LoadedJob = HeadContext & {
  headSha: string;
  createdAt: number;
  startedAt: number;
};

/**
 * Moves this run's review on, only while it is still the row this run loaded (same created_at: not one a Retry
 * inserted again) and still in progress (not stopped meanwhile). False: this run is stale and must stop.
 */
async function advance(
  db: DrizzleDB,
  id: string,
  job: LoadedJob,
  set: Partial<typeof prClassifications.$inferInsert>
): Promise<boolean> {
  const updated = await db
    .update(prClassifications)
    .set(set)
    .where(
      and(
        eq(prClassifications.id, id),
        eq(prClassifications.createdAt, new Date(job.createdAt)),
        notInArray(prClassifications.status, ['done', 'failed'])
      )
    )
    .returning({ id: prClassifications.id });
  return updated.length > 0;
}

async function reviewHead(
  deps: AgentReviewDeps,
  step: StepRunner,
  id: string,
  job: LoadedJob
) {
  const { env, db, models } = deps;
  const { pr, changes, headSha } = job;
  const git = gitFor(env, job.repo);
  const ignored = ignoreMatcher(job.ignoreText);

  // 1. One line per file (the first 300); a summary that still fails after its retries says so.
  const files: Summarized[] = [];
  const summarized = changes;
  for (let i = 0; i < summarized.length; i += SUMMARY_BATCH)
    files.push(
      ...(await Promise.all(
        summarized.slice(i, i + SUMMARY_BATCH).map((ch, j) =>
          step
            .do(`summary:${i + j}`, MODEL_RETRIES, () =>
              summarizeFile(git, models.summarize.bind(models), ch, ignored)
            )
            .catch(
              (e): Summarized => (
                console.error('[review] summary failed', ch.path, e),
                {
                  path: ch.path,
                  status: ch.status,
                  additions: 0,
                  deletions: 0,
                  summary: 'Could not be summarized.',
                  unsummarized: true,
                }
              )
            )
        )
      ))
    );
  for (const ch of job.more)
    files.push({
      path: ch.path,
      status: ch.status,
      additions: 0,
      deletions: 0,
      summary: `Not summarized: more than ${MAX_SUMMARIZED_FILES} files changed.`,
      unsummarized: true,
    });
  const oneLiners = files.map(({ unsummarized: _, ...f }) => f);
  const saved = await step.do('save-files', () =>
    advance(db, id, job, { status: 'triggering', files: oneLiners })
  );
  // Stopped meanwhile, or started again by a Retry: this run makes no more model calls or writes.
  if (!saved) return;

  // 2. Which agents this concerns: one Clef call over the one-liners, never the diff. Unsure means review.
  const invited = await step.do('agents', () =>
    invitedAgentsAt(env, db, pr.repositoryId)
  );
  const askable = invited.filter((a) => !a.error);
  const probabilities = askable.length
    ? await step
        .do('trigger', MODEL_RETRIES, () =>
          models.trigger(
            {
              // Author-controlled text, bounded as in the reviewer's prompt.
              pull_request: {
                title: oneLine(pr.title),
                description: clipDescription(pr.body),
              },
              files: oneLiners,
            },
            Object.fromEntries(askable.map((a) => [a.handle, a.ask!]))
          )
        )
        .catch(
          (e): null => (console.error('[review] trigger failed', id, e), null)
        )
    : null;
  const reviewing = await step.do('reviewers', async () => {
    // First, so a stale run never adds reviewer rows to a review it no longer owns.
    if (!(await advance(db, id, job, { status: 'reviewing' }))) return null;
    const now = new Date();
    const rows = invited.map((a) => {
      const p = a.error ? undefined : probabilities?.[a.handle];
      const requested = a.error !== null || p === undefined || p >= a.above!;
      return {
        id: crypto.randomUUID(),
        pullRequestId: pr.id,
        headSha,
        agentId: a.agentId,
        probability: p ?? null,
        requested,
        agentSha: a.agentSha,
        status: a.error
          ? ('failed' as const)
          : requested
            ? ('reviewing' as const)
            : ('not_needed' as const),
        summary:
          a.error || p !== undefined
            ? null
            : probabilities
              ? 'Clef gave no answer for this agent, so it reviews.'
              : 'Clef could not be reached, so every agent reviews.',
        error: a.error,
        createdAt: now,
        finishedAt: a.error || !requested ? now : null,
      };
    });
    // 13 columns a row: 7 rows stay under D1's 100 bound parameters.
    for (const part of chunks(rows, 7))
      await db.insert(prReviewers).values(part).onConflictDoNothing();
    // As stored: a replayed step keeps the first insert's rows.
    const handleOf = new Map(invited.map((a) => [a.agentId, a.handle]));
    const stored = (
      await db
        .select({
          id: prReviewers.id,
          agentId: prReviewers.agentId,
          status: prReviewers.status,
          probability: prReviewers.probability,
          createdAt: prReviewers.createdAt,
        })
        .from(prReviewers)
        .where(
          and(
            eq(prReviewers.pullRequestId, pr.id),
            eq(prReviewers.headSha, headSha)
          )
        )
        .all()
    )
      .filter((s) => handleOf.has(s.agentId))
      .map((s) => ({ ...s, handle: handleOf.get(s.agentId)! }));
    await noteDecision(triggerDecision(stored));
    return stored
      .filter((s) => s.status === 'reviewing')
      .map((s) => ({
        reviewerId: s.id,
        handle: s.handle,
        generation: s.createdAt.getTime(),
      }));
  });

  if (!reviewing) return;

  // 3. Each requested agent reviews, all at once.
  const summaries = summaryLines(oneLiners);
  await Promise.all(
    reviewing.map((reviewer) =>
      reviewStep(deps, step, {
        reviewId: id,
        pr,
        repo: job.repo,
        changes,
        more: job.more,
        ignoreText: job.ignoreText,
        summaries,
        reviewer,
      })
    )
  );

  const finished = await step.do('finish', () =>
    advance(db, id, job, {
      status: 'done',
      durationMs: Date.now() - job.startedAt,
      finishedAt: new Date(),
    })
  );
  if (!finished) return;
  // Discovery reads this review's one-liners, so it starts once the review ends. Never fails the review.
  await step.do('stacking', async () => {
    await startStacking(env, db, pr.id, headSha);
    return true;
  });
  // Findings of agents the author delegated: GitOrange AI decides them before auto-merge looks. Never throws. A
  // step only for someone who delegates (steps are keyed by name, so a replay that skips or adds it is fine).
  if (await delegatesAny(db, pr.authorId))
    await step.do('delegate', async () => {
      await decideDelegated(env, db, id, { model: deps.delegate });
      return true;
    });
  await step.do('auto-merge', async () => {
    await maybeAutoMerge(env, db, pr.id);
    return true;
  });
}

/** Retries a failed review of a commit as a whole (it never got to its agents): forget it, start again. */
export async function retryHeadReview(
  env: CloudflareBindings,
  db: DrizzleDB,
  pr: PullRequest,
  shas: { head: string }
): Promise<RetryResult> {
  const review = await headReviewFor(db, pr.id, shas.head);
  if (review?.status !== 'failed')
    return {
      ok: false,
      status: 400,
      error: 'Nothing to retry: the review of this commit has not failed',
    };
  await db.batch([
    db
      .delete(prReviewers)
      .where(
        and(
          eq(prReviewers.pullRequestId, pr.id),
          eq(prReviewers.headSha, shas.head)
        )
      ),
    db
      .delete(prClassifications)
      .where(
        and(
          eq(prClassifications.id, review.id),
          eq(prClassifications.status, 'failed')
        )
      ),
  ]);
  const started = await ensureHeadReview(env, db, pr, shas);
  return started
    ? { ok: true }
    : { ok: false, status: 400, error: 'No agents review this repository' };
}

/** Re-runs one agent's review after Retry (MERGE_RESOLUTION Workflow). */
export async function executeReviewerRetry(
  deps: AgentReviewDeps,
  reviewerId: string
) {
  const { env, db } = deps;
  let step = deps.step;
  const job = await step.do('load', async () => {
    const row = await db
      .select()
      .from(prReviewers)
      .where(eq(prReviewers.id, reviewerId))
      .get();
    if (!row || row.status !== 'reviewing') return null;
    const loaded = await loadHead(
      env,
      db,
      row.pullRequestId,
      row.headSha
    ).catch(
      (e: unknown) =>
        ({
          ok: false,
          error: `The pull request could not be read: ${shortError(e)}`,
        }) as const
    );
    if (!loaded) return null;
    if (!loaded.ok)
      return {
        ok: false as const,
        error: loaded.error,
        generation: row.createdAt.getTime(),
      };
    const review = await headReviewFor(db, row.pullRequestId, row.headSha);
    const handle =
      (
        await db
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, row.agentId))
          .get()
      )?.username ?? row.agentId;
    const summaries = summaryLines(review?.files ?? []);
    return {
      ok: true as const,
      reviewId: headReviewId(row.pullRequestId, row.headSha),
      headSha: row.headSha,
      agentId: row.agentId,
      handle,
      generation: row.createdAt.getTime(),
      summaries:
        summaries || loaded.value.changes.map((c) => `- ${c.path}`).join('\n'),
      ...loaded.value,
    };
  });
  if (!job) return;
  if (!job.ok) {
    await step.do('fail', async () => {
      await db
        .update(prReviewers)
        .set({ status: 'failed', error: job.error, finishedAt: new Date() })
        .where(carriedAttempt(reviewerId, job.generation));
      return true;
    });
    return;
  }
  step = pingingSteps(env, step, job.pr.repositoryId, {
    approvals: true,
    quiet: quietPiCheck,
  });
  await reviewStep(deps, step, {
    reviewId: job.reviewId,
    pr: job.pr,
    repo: job.repo,
    changes: job.changes,
    more: job.more,
    ignoreText: job.ignoreText,
    summaries: job.summaries,
    reviewer: { reviewerId, handle: job.handle, generation: job.generation },
  });
  await step.do('finish', async () => {
    const left = await db
      .select({ id: prReviewers.id })
      .from(prReviewers)
      .where(
        and(
          eq(prReviewers.pullRequestId, job.pr.id),
          eq(prReviewers.headSha, job.headSha),
          eq(prReviewers.status, 'reviewing')
        )
      )
      .get();
    if (!left)
      await db
        .update(prClassifications)
        .set({ status: 'done', finishedAt: new Date() })
        .where(
          and(
            eq(prClassifications.id, job.reviewId),
            eq(prClassifications.status, 'reviewing')
          )
        );
    return true;
  });
  // This agent's findings, when the author delegated it (a step cached before agentId existed skips it).
  const agentId = (job as { agentId?: string }).agentId;
  if (agentId && (await delegatesAny(db, job.pr.authorId)))
    await step.do('delegate', async () => {
      await decideDelegated(env, db, job.reviewId, {
        agentId,
        model: deps.delegate,
      });
      return true;
    });
  await step.do('auto-merge', async () => {
    await maybeAutoMerge(env, db, job.pr.id);
    return true;
  });
}
