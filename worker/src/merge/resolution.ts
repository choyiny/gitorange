import type { WorkflowStepConfig } from 'cloudflare:workers';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
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
import { maybeAutoMerge } from '../review/auto-merge';
import {
  DEFAULT_RESOLVER_MODEL,
  type ConflictResolverApi,
  type ResolveRequest,
} from './resolver';

/** Where a proposed resolution's commit waits until it is applied. */
export const resolutionRef = (id: string) => `refs/resolutions/${id}`;

/** R2 key of a resolution's transcript. */
export const transcriptKey = (repoId: string, id: string) =>
  `merge-resolutions/${repoId}/${id}.json`;

const CONFLICT_MARKER = /^(<{7}|\|{7}|={7}|>{7})( |$)/m;
const MAX_INTENT_COMMITS = 30;

export const resolverModel = (env: CloudflareBindings) =>
  env.RESOLVER_MODEL || DEFAULT_RESOLVER_MODEL;

/** AI resolution is available when the deployment has the Workflow binding. */
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
 * Starts resolving a pull request's conflicts with AI. Only text conflicts can be resolved;
 * binary files and delete-versus-edit conflicts still need a human. Asking again while an
 * attempt for the same commits is running returns that attempt.
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

  // Same commits already in hand: return that attempt rather than starting another.
  const existing = await latestResolution(db, pr.id);
  if (
    existing &&
    (existing.status === 'running' || existing.status === 'queued') &&
    existing.baseSha === shas.base &&
    existing.headSha === shas.head
  )
    return { ok: true, resolution: existing };
  await supersede(env, db, pr.id, shas);

  // Cap concurrent model runs per repository so a burst of PRs can't trip rate limits;
  // the rest wait their turn and start as running ones finish (startNext).
  const busy = await activeCount(db, pr.repositoryId);
  const row: MergeResolution = {
    id: crypto.randomUUID(),
    pullRequestId: pr.id,
    baseSha: shas.base,
    headSha: shas.head,
    status: busy >= MAX_CONCURRENT_PER_REPO ? 'queued' : 'running',
    model: resolverModel(env),
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
  await db.insert(mergeResolutions).values(row);
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
 * A PR's commits moved: attempts for its older commits can't be applied anymore, so stop
 * them — terminating running Workflows saves their model time — and mark them superseded.
 */
async function supersede(
  env: CloudflareBindings,
  db: DrizzleDB,
  pullRequestId: string,
  current: { base: string; head: string }
) {
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
  for (const r of open) {
    if (r.baseSha === current.base && r.headSha === current.head) continue;
    if (r.status === 'running')
      await env.MERGE_RESOLUTION.get(r.id)
        .then((instance) => instance.terminate())
        .catch(() => {}); // already finished, or never started
    await fail(db, r.id, 'Superseded by newer commits.', ['queued', 'running']);
  }
}

/**
 * Fills free slots in a repository with its oldest queued attempts, skipping any whose
 * commits moved on while they waited.
 */
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
      git.resolve(next.pr.baseRef),
      git.resolve(next.pr.headRef),
    ]);
    if (
      next.pr.state !== 'open' ||
      base !== next.row.baseSha ||
      head !== next.row.headSha
    ) {
      await fail(db, next.row.id, 'Superseded by newer commits.', ['queued']);
      continue;
    }
    // Claim it; another worker finishing at the same moment may have claimed it first.
    const claimed = await db
      .update(mergeResolutions)
      .set({ status: 'running' })
      .where(
        and(
          eq(mergeResolutions.id, next.row.id),
          eq(mergeResolutions.status, 'queued')
        )
      )
      .returning({ id: mergeResolutions.id });
    if (claimed.length) await launch(env, db, next.row.id);
  }
}

/**
 * Reuses an earlier AI resolution of the same pull request on new commits, with no model call,
 * when that is safe: every file conflicting now was resolved before, and neither side changed
 * that file since (the target branch moved, but not in those files). The resolved files are
 * re-applied on top of the new commits and land as a new proposal.
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
    // Zero model time: this resolution was carried over, not recomputed.
    durationMs: 0,
    createdById: null,
    createdAt: new Date(),
    decidedAt: null,
  };
  await git.client.push(
    [{ ref: resolutionRef(row.id), old: ZERO_SHA, new: commit.sha }],
    [...merged.objects, commit]
  );
  await db.insert(mergeResolutions).values(row);
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
}

export interface ResolutionDeps {
  env: CloudflareBindings;
  db: DrizzleDB;
  step: StepRunner;
  resolver: (resolutionId: string) => ConflictResolverApi;
}

class ResolutionError extends Error {}

/**
 * Workflow steps serialize what they return and retry what throws, so an expected failure is
 * returned as a value; anything else throws (and the step's retry policy applies).
 */
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
 * Runs one resolution: rebuild the conflicted files, gather both sides' intent, let the model
 * resolve them, check the result, and commit it — the pull request squashed onto the base tip —
 * to the resolution's side ref. A valid result becomes part of the pull request: merging it
 * lands that commit. Only a failure to get an answer from the model needs a person.
 */
export async function executeResolution(deps: ResolutionDeps, id: string) {
  const { env, db, step } = deps;
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
    const labels = { a: pr.baseRef, o: 'base', b: pr.headRef };

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
        // pi already retries rate limits and transient model errors inside the run; this
        // covers the run itself dying (eviction, a failed RPC). The run is idempotent.
        retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
        timeout: '15 minutes',
      },
      async () => {
        const r = await deps.resolver(id).resolve(request);
        await env.ACTIONS_LOGS.put(transcriptKey(repo.id, id), r.transcript, {
          httpMetadata: { contentType: 'application/json' },
        });
        const { transcript: _, ...rest } = r;
        return rest;
      }
    );

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
            // From the request, not from this replay: Workflow code re-runs on resume.
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
  // Resolved: the pull request may now be ready to merge on its own.
  if (proposed && job)
    await step.do('auto-merge', async () => {
      await maybeAutoMerge(env, db, job!.pr.id).catch((e) =>
        console.error('[merge] auto-merge failed', id, e)
      );
      return true;
    });
  // This attempt's slot is free: start the repository's next queued one.
  if (job)
    await step.do('next', async () => {
      await startNext(env, db, job!.pr.repositoryId);
      return true;
    });
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
    oursIntent: `Commits that landed on ${pr.baseRef} since the pull request branched:\n${subjects(landed)}`,
    theirsIntent:
      `Pull request #${pr.number}: ${pr.title}\n${pr.body ? `${pr.body.slice(0, 4000)}\n` : ''}` +
      `Its commits:\n${subjects(proposed)}`,
  };
}
