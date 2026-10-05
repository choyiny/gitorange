import type { WorkflowStepConfig } from 'cloudflare:workers';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { pingingSteps } from '../live/publish';
import type { DrizzleDB } from '../db/middleware';
import { users } from '../db/auth.schema';
import {
  mergeResolutions,
  pullRequests,
  type MergeResolution,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import { makeCommit } from '../git/objects';
import { decoder } from '../git/bytes';
import { ZERO_SHA } from '../git/remote';
import type { GitService } from '../git/service';
import { findRepoById, gitFor } from '../lib/repos';
import { getSetting } from '../lib/settings';
import { maybeAutoMerge } from '../review/auto-merge';
import { type ConflictResolverApi, type ResolveRequest } from './resolver';
import { generatedConflicts } from './generated';
import { recordAiUsage, usageFromTranscript } from '../usage/record';
import { closeAgentRun } from '../agent-runs/record';
import { landTargetOf } from '../lib/land-target';

/** Where a proposed resolution's commit waits until it is applied. */
export const resolutionRef = (id: string) => `refs/resolutions/${id}`;

/** R2 key of a resolution's transcript. */
export const transcriptKey = (repoId: string, id: string) =>
  `merge-resolutions/${repoId}/${id}.json`;

const CONFLICT_MARKER = /^(<{7}|\|{7}|={7}|>{7})( |$)/m;
const MAX_INTENT_COMMITS = 30;
/** The error a resolution gets when newer commits replace the ones it was for. */
export const SUPERSEDED = 'Superseded by newer commits.';
/** The model of a failed row recording conflicts AI can't resolve (binary, delete/edit): never an AI attempt. */
export const NO_MODEL = 'none';

/**
 * How long a conflict sweep waits before it checks pull requests, so a burst of landings on the
 * target wakes to the same tip and ends in one attempt per PR instead of one per landing.
 */
export const SETTLE_MS = 45_000;

/** Running attempts in a repository, as a subquery for atomic cap checks. */
const runningIn = (repositoryId: string) =>
  sql`(SELECT COUNT(*) FROM merge_resolutions m
       JOIN pull_requests p ON p.id = m.pull_request_id
       WHERE p.repository_id = ${repositoryId} AND m.status = 'running')`;

/** A row cancelled because its commits moved on: it doesn't count as having tried them. */
export const notSuperseded = sql`NOT (${mergeResolutions.status} = 'failed'
  AND COALESCE(${mergeResolutions.errorMessage}, '') = ${SUPERSEDED})`;

/** The model conflict resolution uses: Site admin's setting, else `RESOLVER_MODEL`. */
export const resolverModel = (db: DrizzleDB, env: CloudflareBindings) =>
  getSetting(db, env, 'ai.resolver_model');

export function resolutionConfigured(env: CloudflareBindings): boolean {
  return Boolean((env as Partial<CloudflareBindings>).MERGE_RESOLUTION);
}

/** The latest resolution attempt of a pull request. */
export async function latestResolution(
  db: DrizzleDB,
  pullRequestId: string
): Promise<MergeResolution | undefined> {
  return db
    .select()
    .from(mergeResolutions)
    .where(eq(mergeResolutions.pullRequestId, pullRequestId))
    .orderBy(desc(mergeResolutions.createdAt))
    .limit(1)
    .get();
}

type StartResult =
  | { ok: true; resolution: MergeResolution }
  | { ok: false; status: 400 | 409; error: string };

/**
 * Starts an AI resolution of text conflicts (binary and delete/edit conflicts need a human).
 * Returns the running attempt for the same commits if there is one.
 */
export async function startResolution(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest,
  shas: { base: string; head: string },
  /** Who asked; null when it started on its own after a push. */
  userId: string | null
): Promise<StartResult> {
  if (!resolutionConfigured(env))
    return {
      ok: false,
      status: 400,
      error: 'AI conflict resolution is not set up on this server',
    };
  const plan = await git.planMerge(shas.base, shas.head, {
    collectConflictFiles: true,
  });
  if (plan.upToDate || plan.conflicts.length === 0)
    return {
      ok: false,
      status: 400,
      error: 'This pull request has no conflicts to resolve',
    };
  const textual = new Set(plan.conflictFiles.map((f) => f.path));
  const other = plan.conflicts.filter((p) => !textual.has(p));
  if (other.length)
    return {
      ok: false,
      status: 400,
      error: `These conflicts can't be resolved automatically (binary files, or a file deleted on one side and changed on the other): ${other.join(', ')}. Resolve them locally.`,
    };
  const generated = await generatedConflicts(git, shas.base, plan.conflicts);
  if (generated.length)
    return {
      ok: false,
      status: 400,
      error: `These conflicts are in generated files, which aren't sent to the model: ${generated.join(', ')}. Regenerate them on the branch.`,
    };

  const active = () => activeFor(db, pr.id, shas);
  const existing = await active();
  if (existing) return { ok: true, resolution: existing };
  await supersede(env, db, pr.id, shas);

  // Cap concurrent runs per repository to avoid rate limits; the rest queue for startNext.
  const row: MergeResolution = {
    id: crypto.randomUUID(),
    pullRequestId: pr.id,
    baseSha: shas.base,
    headSha: shas.head,
    status: 'running',
    model: await resolverModel(db, env),
    conflictedPaths: plan.conflicts,
    touchedExtraPaths: null,
    explanation: null,
    errorMessage: null,
    resultSha: null,
    transcriptR2Key: null,
    durationMs: null,
    createdById: userId,
    createdAt: new Date(),
    decidedAt: null,
  };
  // A person may retry after a failure; on its own, an attempt runs once per pair of commits.
  const status = await insertOnce(db, row, pr.repositoryId, {
    onlyActive: userId !== null,
  });
  if (!status) {
    // Another trigger created the attempt for these commits first.
    const winner = userId !== null ? await active() : undefined;
    if (winner) return { ok: true, resolution: winner };
    return {
      ok: false,
      status: 409,
      error: 'An attempt for these commits already exists.',
    };
  }
  row.status = status;
  if (row.status === 'queued') return { ok: true, resolution: row };
  if (!(await launch(env, db, row.id)))
    return {
      ok: false,
      status: 409,
      error: 'The resolution could not be started. Try again.',
    };
  return { ok: true, resolution: row };
}

/** Concurrent AI resolutions per repository; more wait in `queued`. */
export const MAX_CONCURRENT_PER_REPO = 5;

/** The queued or running attempt for exactly these commits, if any. */
async function activeFor(
  db: DrizzleDB,
  pullRequestId: string,
  shas: { base: string; head: string }
) {
  return db
    .select()
    .from(mergeResolutions)
    .where(
      and(
        eq(mergeResolutions.pullRequestId, pullRequestId),
        eq(mergeResolutions.baseSha, shas.base),
        eq(mergeResolutions.headSha, shas.head),
        inArray(mergeResolutions.status, ['queued', 'running'])
      )
    )
    .orderBy(desc(mergeResolutions.createdAt))
    .get();
}

/**
 * Inserts an attempt unless one already exists for the same PR and commits (any status, or only
 * queued/running ones with `onlyActive`), as one statement so racing triggers can't both insert.
 * A `running` row becomes `queued` when the repository's slots are full. Returns the stored
 * status, or null when another attempt won.
 */
async function insertOnce(
  db: DrizzleDB,
  row: MergeResolution,
  repositoryId: string,
  opts: { onlyActive: boolean }
): Promise<MergeResolution['status'] | null> {
  const status =
    row.status === 'running'
      ? sql`CASE WHEN ${runningIn(repositoryId)} >= ${MAX_CONCURRENT_PER_REPO}
            THEN 'queued' ELSE 'running' END`
      : sql`${row.status}`;
  const json = (v: string[] | null) => (v ? JSON.stringify(v) : null);
  const seconds = (d: Date | null) =>
    d ? Math.floor(d.getTime() / 1000) : null;
  const rows = await db.all<{ status: MergeResolution['status'] }>(sql`
    INSERT INTO merge_resolutions (id, pull_request_id, base_sha, head_sha, status, model,
      conflicted_paths, touched_extra_paths, explanation, error_message, result_sha,
      transcript_r2_key, duration_ms, created_by_id, created_at, decided_at)
    SELECT ${row.id}, ${row.pullRequestId}, ${row.baseSha}, ${row.headSha}, ${status},
      ${row.model}, ${json(row.conflictedPaths)}, ${json(row.touchedExtraPaths)},
      ${row.explanation}, ${row.errorMessage}, ${row.resultSha}, ${row.transcriptR2Key},
      ${row.durationMs}, ${row.createdById}, ${seconds(row.createdAt)}, ${seconds(row.decidedAt)}
    WHERE NOT EXISTS (
      SELECT 1 FROM merge_resolutions
      WHERE pull_request_id = ${row.pullRequestId} AND base_sha = ${row.baseSha}
        AND head_sha = ${row.headSha}
        ${
          opts.onlyActive
            ? sql`AND status IN ('queued', 'running')`
            : sql`AND NOT (status = 'failed' AND COALESCE(error_message, '') = ${SUPERSEDED})`
        }
    )
    RETURNING status`);
  return rows[0]?.status ?? null;
}

async function activeCount(db: DrizzleDB, repositoryId: string) {
  const row = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(mergeResolutions)
    .innerJoin(
      pullRequests,
      eq(pullRequests.id, mergeResolutions.pullRequestId)
    )
    .where(
      and(
        eq(pullRequests.repositoryId, repositoryId),
        eq(mergeResolutions.status, 'running')
      )
    )
    .get();
  return Number(row?.n ?? 0);
}

/** Starts the Workflow for a running attempt; a failure to start is recorded on it. */
async function launch(env: CloudflareBindings, db: DrizzleDB, id: string) {
  try {
    await env.MERGE_RESOLUTION.create({ id, params: { resolutionId: id } });
    return true;
  } catch (e) {
    console.error('[merge] could not start resolution', id, e);
    await fail(db, id, 'The resolution could not be started. Try again.');
    return false;
  }
}

/**
 * Cancels a PR's queued or running attempts for commits other than its branches' tips right now,
 * then fills the freed slots from the queue. Run whenever a PR's branches may have moved, whether
 * or not a new attempt follows. The tips are resolved here, not trusted from the caller: when
 * `seen` (what the caller resolved earlier) is already behind them, it does nothing and returns
 * `stale`, so a slow caller can't cancel the attempt for the newest commits.
 */
export async function cancelStale(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: Pick<
    PullRequest,
    'id' | 'repositoryId' | 'baseRef' | 'landTarget' | 'headRef'
  >,
  seen: { base: string; head: string }
): Promise<{ stale: boolean; cancelled: number }> {
  // Straight from the remote: a request's GitService caches the refs it saw when it began.
  const { refs } = await git.client.listRefs();
  const tip = (name: string) =>
    refs.get(`refs/heads/${name}`) ?? refs.get(name) ?? null;
  if (tip(landTargetOf(pr)) !== seen.base || tip(pr.headRef) !== seen.head)
    return { stale: true, cancelled: 0 };
  const cancelled = await supersede(env, db, pr.id, seen);
  if (cancelled) await startNext(env, db, pr.repositoryId);
  return { stale: false, cancelled };
}

/** Terminates attempts for a PR's older commits and marks them superseded. */
async function supersede(
  env: CloudflareBindings,
  db: DrizzleDB,
  pullRequestId: string,
  current: { base: string; head: string }
): Promise<number> {
  const open = await db
    .select({
      id: mergeResolutions.id,
      status: mergeResolutions.status,
      baseSha: mergeResolutions.baseSha,
      headSha: mergeResolutions.headSha,
    })
    .from(mergeResolutions)
    .where(
      and(
        eq(mergeResolutions.pullRequestId, pullRequestId),
        inArray(mergeResolutions.status, ['queued', 'running'])
      )
    )
    .all();
  let cancelled = 0;
  for (const r of open) {
    if (r.baseSha === current.base && r.headSha === current.head) continue;
    if (r.status === 'running')
      await env.MERGE_RESOLUTION.get(r.id)
        .then((instance) => instance.terminate())
        .catch(() => {}); // already finished, or never started
    // A terminated Workflow never closes its agent run itself.
    await closeAgentRun(db, r.id, SUPERSEDED).catch(() => {});
    await fail(db, r.id, SUPERSEDED, ['queued', 'running']);
    cancelled++;
  }
  return cancelled;
}

/** Starts the oldest queued attempts into free slots, skipping any whose commits moved. */
export async function startNext(
  env: CloudflareBindings,
  db: DrizzleDB,
  repositoryId: string
) {
  const found = await findRepoById(db, repositoryId);
  if (!found) return;
  const git = gitFor(env, found.repo);
  for (;;) {
    if ((await activeCount(db, repositoryId)) >= MAX_CONCURRENT_PER_REPO)
      return;
    const next = await db
      .select({ row: mergeResolutions, pr: pullRequests })
      .from(mergeResolutions)
      .innerJoin(
        pullRequests,
        eq(pullRequests.id, mergeResolutions.pullRequestId)
      )
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          eq(mergeResolutions.status, 'queued')
        )
      )
      .orderBy(asc(mergeResolutions.createdAt))
      .limit(1)
      .get();
    if (!next) return;
    const [base, head] = await Promise.all([
      git.resolve(landTargetOf(next.pr)),
      git.resolve(next.pr.headRef),
    ]);
    if (
      next.pr.state !== 'open' ||
      base !== next.row.baseSha ||
      head !== next.row.headSha
    ) {
      await fail(db, next.row.id, SUPERSEDED, ['queued']);
      continue;
    }
    // Claim it if a slot is still free; a concurrent worker may have claimed it, or the slot.
    const claimed = await db
      .update(mergeResolutions)
      .set({ status: 'running' })
      .where(
        and(
          eq(mergeResolutions.id, next.row.id),
          eq(mergeResolutions.status, 'queued'),
          sql`${runningIn(repositoryId)} < ${MAX_CONCURRENT_PER_REPO}`
        )
      )
      .returning({ id: mergeResolutions.id });
    if (claimed.length) await launch(env, db, next.row.id);
    else if (
      (
        await db
          .select({ status: mergeResolutions.status })
          .from(mergeResolutions)
          .where(eq(mergeResolutions.id, next.row.id))
          .get()
      )?.status === 'queued'
    )
      return; // the slots filled up meanwhile
  }
}

/**
 * Reapplies an earlier resolution on new commits without a model call when every conflicting
 * file was resolved before and neither side changed it since. Lands as a new proposal.
 */
export async function carryForward(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest,
  shas: { base: string; head: string }
): Promise<MergeResolution | null> {
  const prev = await db
    .select()
    .from(mergeResolutions)
    .where(
      and(
        eq(mergeResolutions.pullRequestId, pr.id),
        eq(mergeResolutions.status, 'proposed')
      )
    )
    .orderBy(desc(mergeResolutions.createdAt))
    .limit(1)
    .get();
  if (!prev?.resultSha) return null;
  const plan = await git.planMerge(shas.base, shas.head);
  if (plan.upToDate || !plan.conflicts.length) return null;
  if (!plan.conflicts.every((p) => prev.conflictedPaths.includes(p)))
    return null;
  const blobAt = async (commit: string, path: string) => {
    const e = await git.entryAt(commit, path);
    return e?.type === 'blob' ? e.entry.hash : null;
  };
  const resolutions = new Map<string, string | null>();
  for (const path of plan.conflicts) {
    const [baseNow, baseThen, headNow, headThen, resolved] = await Promise.all([
      blobAt(shas.base, path),
      blobAt(prev.baseSha, path),
      blobAt(shas.head, path),
      blobAt(prev.headSha, path),
      blobAt(prev.resultSha, path),
    ]);
    if (baseNow !== baseThen || headNow !== headThen || !resolved) return null;
    const bytes = await git.blob(resolved);
    if (!bytes) return null;
    resolutions.set(path, decoder.decode(bytes));
  }
  const merged = await git.planMerge(shas.base, shas.head, { resolutions });
  if (merged.upToDate || merged.conflicts.length) return null;
  const author = await db
    .select()
    .from(users)
    .where(eq(users.id, pr.authorId))
    .get();
  const commit = await makeCommit({
    tree: merged.tree,
    parents: [shas.base],
    author: {
      name: author?.name ?? 'GitOrange',
      email: author?.email ?? 'noreply@gitorange',
      timestamp: Math.floor(Date.now() / 1000),
    },
    message: `${pr.title} (#${pr.number})`,
  });
  await supersede(env, db, pr.id, shas);
  const row: MergeResolution = {
    id: crypto.randomUUID(),
    pullRequestId: pr.id,
    baseSha: shas.base,
    headSha: shas.head,
    status: 'proposed',
    model: prev.model,
    conflictedPaths: plan.conflicts,
    touchedExtraPaths: null,
    explanation: prev.explanation,
    errorMessage: null,
    resultSha: commit.sha,
    transcriptR2Key: prev.transcriptR2Key,
    // Carried over: no model time.
    durationMs: 0,
    createdById: null,
    createdAt: new Date(),
    decidedAt: null,
  };
  await git.client.push(
    [{ ref: resolutionRef(row.id), old: ZERO_SHA, new: commit.sha }],
    [...merged.objects, commit]
  );
  // A racing trigger carried it forward first: theirs stands, and our ref goes.
  if (!(await insertOnce(db, row, pr.repositoryId, { onlyActive: false }))) {
    await git.client
      .push(
        [{ ref: resolutionRef(row.id), old: commit.sha, new: ZERO_SHA }],
        []
      )
      .catch((e) =>
        console.error('[merge] could not delete resolution ref', row.id, e)
      );
    return null;
  }
  return row;
}

async function fail(
  db: DrizzleDB,
  id: string,
  message: string,
  from: MergeResolution['status'][] = ['running']
) {
  await db
    .update(mergeResolutions)
    .set({ status: 'failed', errorMessage: message, decidedAt: new Date() })
    .where(
      and(eq(mergeResolutions.id, id), inArray(mergeResolutions.status, from))
    );
}

/** The part of WorkflowStep the executor uses; tests pass a direct-call fake. */
export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    fn: () => Promise<T>
  ): Promise<T>;
  /** A durable sleep (milliseconds). */
  sleep(name: string, duration: number): Promise<void>;
}

export interface ResolutionDeps {
  env: CloudflareBindings;
  db: DrizzleDB;
  step: StepRunner;
  resolver: (resolutionId: string) => ConflictResolverApi;
}

class ResolutionError extends Error {}

/** Expected failures are returned as values; steps retry what throws. */
type Outcome<T> =
  { value: T; error?: undefined } | { error: string; value?: undefined };
async function outcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { value: await fn() };
  } catch (e) {
    if (e instanceof ResolutionError) return { error: e.message };
    throw e;
  }
}
const ONCE = { retries: { limit: 0, delay: 0 } } as const;

/**
 * Runs one resolution: rebuild conflicted files, let the model resolve them, validate, and commit
 * the PR squashed onto the base tip to the resolution's side ref.
 */
export async function executeResolution(deps: ResolutionDeps, id: string) {
  const { env, db } = deps;
  let step = deps.step;
  let job: {
    row: MergeResolution;
    pr: PullRequest;
    repo: Repository;
    author: { name: string; email: string };
  } | null = null;
  let proposed = false;
  try {
    job = await step.do('load', async () => {
      const row = await db
        .select()
        .from(mergeResolutions)
        .where(eq(mergeResolutions.id, id))
        .get();
      if (!row || row.status !== 'running') return null;
      const pr = await db
        .select()
        .from(pullRequests)
        .where(eq(pullRequests.id, row.pullRequestId))
        .get();
      if (!pr) return null;
      const found = await findRepoById(db, pr.repositoryId);
      if (!found) return null;
      const author = await db
        .select()
        .from(users)
        .where(eq(users.id, pr.authorId))
        .get();
      return {
        row,
        pr,
        repo: found.repo,
        author: {
          name: author?.name ?? 'GitOrange',
          email: author?.email ?? 'noreply@gitorange',
        },
      };
    });
    if (!job) return;
    const { row, pr, repo, author } = job;
    step = pingingSteps(env, step, pr.repositoryId, { approvals: true });
    const labels = { a: landTargetOf(pr), o: 'base', b: pr.headRef };
    const current = (when: string) =>
      step.do(`current:${when}`, () =>
        outcome(() => ensureCurrent(env, db, row, repo as Repository))
      );

    const fresh = await current('before-resolve');
    if (fresh.error !== undefined) throw new ResolutionError(fresh.error);

    const prepared = await step.do('prepare', ONCE, () =>
      outcome(() =>
        prepareRequest(
          gitFor(env, repo as Repository),
          row,
          pr as PullRequest,
          labels
        )
      )
    );
    if (prepared.error !== undefined) throw new ResolutionError(prepared.error);
    const request = prepared.value;

    const result = await step.do(
      'resolve',
      {
        // pi retries model errors itself; this covers the run dying. The run is idempotent.
        retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
        timeout: '15 minutes',
      },
      async () => {
        // The model recorded when the attempt started, so a retry uses the same one.
        const r = await deps
          .resolver(id)
          .resolve({ ...request, model: row.model });
        await env.ACTIONS_LOGS.put(transcriptKey(repo.id, id), r.transcript, {
          httpMetadata: { contentType: 'application/json' },
        });
        // Usage & cost: the whole conversation's tokens, one row per resolution (a retried
        // step rejoins the same run, so its record replaces this one).
        let messages: unknown = [];
        try {
          messages = JSON.parse(r.transcript);
        } catch {
          // Not JSON: recorded without token counts.
        }
        await recordAiUsage(env, {
          id: `merge-resolution:${id}`,
          feature: 'merge-resolution',
          model: row.model,
          repositoryId: repo.id,
          pullRequestId: pr.id,
          mergeResolutionId: id,
          ...usageFromTranscript(messages),
        });
        const { transcript: _, ...rest } = r;
        return rest;
      }
    );

    const still = await current('before-commit');
    if (still.error !== undefined) throw new ResolutionError(still.error);

    const committed = await step.do('commit', ONCE, () =>
      outcome(async () => {
        if (result.status !== 'done')
          throw new ResolutionError(
            `The model didn't finish${result.reason ? ` (${result.reason})` : ''}.`
          );
        const resolutions = new Map<string, string | null>();
        for (const path of row.conflictedPaths) {
          const text = result.files[path];
          if (text === undefined)
            throw new ResolutionError(
              `The model deleted ${path} instead of resolving it.`
            );
          if (CONFLICT_MARKER.test(text))
            throw new ResolutionError(`${path} still has conflict markers.`);
          resolutions.set(path, text);
        }
        const extra = Object.keys(result.files).filter(
          (p) => !row.conflictedPaths.includes(p)
        );
        const git = gitFor(env, repo as Repository);
        const plan = await git.planMerge(row.baseSha, row.headSha, {
          resolutions,
          labels,
        });
        if (plan.upToDate || plan.conflicts.length)
          throw new ResolutionError('The resolved files still left conflicts.');
        const commit = await makeCommit({
          tree: plan.tree,
          parents: [row.baseSha],
          author: { ...author, timestamp: Math.floor(Date.now() / 1000) },
          message: `${pr.title} (#${pr.number})`,
        });
        await git.client.push(
          [{ ref: resolutionRef(id), old: ZERO_SHA, new: commit.sha }],
          [...plan.objects, commit]
        );
        await db
          .update(mergeResolutions)
          .set({
            status: 'proposed',
            resultSha: commit.sha,
            explanation: result.explanation.trim() || null,
            touchedExtraPaths: extra.length ? extra : null,
            transcriptR2Key: transcriptKey(repo.id, id),
            // From the request: Workflow code re-runs on resume.
            durationMs: Date.now() - new Date(row.createdAt).getTime(),
          })
          .where(
            and(
              eq(mergeResolutions.id, id),
              eq(mergeResolutions.status, 'running')
            )
          );
        return commit.sha;
      })
    );
    if (committed.error !== undefined)
      throw new ResolutionError(committed.error);
    proposed = true;
  } catch (e) {
    const message =
      e instanceof ResolutionError
        ? e.message
        : 'The model could not be reached or failed to answer. Try again.';
    if (!(e instanceof ResolutionError))
      console.error('[merge] resolution failed', id, e);
    await step.do('fail', async () => {
      await fail(db, id, message);
      return true;
    });
  }
  if (proposed && job)
    await step.do('auto-merge', async () => {
      await maybeAutoMerge(env, db, job!.pr.id).catch((e) =>
        console.error('[merge] auto-merge failed', id, e)
      );
      return true;
    });
  if (job)
    await step.do('next', async () => {
      await startNext(env, db, job!.pr.repositoryId);
      return true;
    });
}

/**
 * Throws when the attempt no longer applies: its PR closed, its branches moved on, or it was
 * cancelled meanwhile. The model is never asked about commits nobody will merge.
 */
async function ensureCurrent(
  env: CloudflareBindings,
  db: DrizzleDB,
  row: MergeResolution,
  repo: Repository
): Promise<true> {
  const now = await db
    .select({ status: mergeResolutions.status })
    .from(mergeResolutions)
    .where(eq(mergeResolutions.id, row.id))
    .get();
  if (now?.status !== 'running') throw new ResolutionError(SUPERSEDED);
  const pr = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.id, row.pullRequestId))
    .get();
  // Superseded, not failed: reopening the PR may try these commits again.
  if (pr?.state !== 'open') throw new ResolutionError(SUPERSEDED);
  const git = gitFor(env, repo);
  const [base, head] = await Promise.all([
    git.resolve(landTargetOf(pr)),
    git.resolve(pr.headRef),
  ]);
  if (base !== row.baseSha || head !== row.headSha)
    throw new ResolutionError(SUPERSEDED);
  return true;
}

/** Rebuilds the conflicted files and describes what each side was trying to do. */
async function prepareRequest(
  git: GitService,
  row: MergeResolution,
  pr: PullRequest,
  labels: { a: string; o: string; b: string }
): Promise<ResolveRequest> {
  const plan = await git.planMerge(row.baseSha, row.headSha, {
    collectConflictFiles: true,
    labels,
  });
  if (plan.upToDate || !plan.conflictFiles.length)
    throw new ResolutionError('There is nothing to resolve anymore.');
  const subjects = (commits: { message: string }[]) =>
    commits
      .slice(-MAX_INTENT_COMMITS)
      .map((c) => `- ${c.message.split('\n')[0]}`)
      .join('\n') || '- (no commit messages)';
  const [landed, proposed] = await Promise.all([
    git.commitsBetween(row.headSha, row.baseSha),
    git.commitsBetween(row.baseSha, row.headSha),
  ]);
  return {
    files: Object.fromEntries(
      plan.conflictFiles.map((f) => [f.path, f.withMarkers])
    ),
    labels: { ours: labels.a, theirs: labels.b },
    oursIntent: `Commits that landed on ${landTargetOf(pr)} since the pull request branched:\n${subjects(landed)}`,
    theirsIntent:
      `Pull request #${pr.number}: ${pr.title}\n${pr.body ? `${pr.body.slice(0, 4000)}\n` : ''}` +
      `Its commits:\n${subjects(proposed)}`,
  };
}
