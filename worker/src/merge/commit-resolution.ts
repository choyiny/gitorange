/**
 * AI resolution of one pull request commit whose replay conflicted during a rebase (merge/rebase.ts). The
 * MergeResolver Durable Object (named by the row id, so a retried step rejoins its run) gets that commit's conflicted
 * files with diff3 markers, its message and diff, and the pull request's title and description; the resolved contents
 * go on the commit's merge_resolutions row, and the rebase replays on with them.
 */
import type { WorkflowStepConfig } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  mergeResolutions,
  pullRequests,
  type MergeResolution,
  type PullRequest,
} from '../db/app.schema';
import { rebase, REBASE_COMMITTER, type RebaseResult } from '../git/rebase';
import type { GitService } from '../git/service';
import { findRepoById, gitFor } from '../lib/repos';
import { recordAiUsage, usageFromTranscript } from '../usage/record';
import {
  rebaseTips,
  resolutionId,
  resolutionsFor,
  type RebaseTips,
} from './rebase';
import { resolverModel, SUPERSEDED, transcriptKey } from './resolution';
import type { ConflictResolverApi, ResolveRequest } from './resolver';

/** The model's run: pi retries model errors itself; this covers the run dying (the run is idempotent). */
export const RESOLVE_RETRIES: WorkflowStepConfig = {
  retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
  timeout: '15 minutes',
};
export const MODEL_UNREACHABLE =
  'The model could not be reached or failed to answer.';

const CONFLICT_MARKER = /^(<{7}|\|{7}|={7}|>{7})( |$)/m;
const MAX_DIFF_CHARS = 20_000;
const MAX_INTENT_COMMITS = 30;
const DESCRIPTION_CHARS = 4000;
const sha7 = (s: string) => s.slice(0, 7);

/**
 * Claims the AI resolution of one conflicting commit: its row, inserted once (a replayed step finds it). A stop a
 * person set aside to try again (`rejected`, merge/rebase.ts retryRebase) is claimed afresh: a new attempt, with a
 * new created_at and so a new resolver (resolverName).
 */
export async function claimResolution(
  env: CloudflareBindings,
  db: DrizzleDB,
  pullRequestId: string,
  tips: RebaseTips,
  c: { commit: string; paths: string[] }
): Promise<{ id: string; status: MergeResolution['status'] }> {
  const id = resolutionId(pullRequestId, tips, c.commit);
  const model = await resolverModel(db, env);
  const now = new Date();
  await db
    .insert(mergeResolutions)
    .values({
      id,
      pullRequestId,
      baseSha: tips.onto,
      headSha: tips.head,
      commitSha: c.commit,
      status: 'running',
      model,
      conflictedPaths: c.paths,
      createdAt: now,
    })
    .onConflictDoNothing();
  await db
    .update(mergeResolutions)
    .set({
      status: 'running',
      model,
      conflictedPaths: c.paths,
      resolvedFiles: null,
      touchedExtraPaths: null,
      explanation: null,
      errorMessage: null,
      resultSha: null,
      transcriptR2Key: null,
      durationMs: null,
      // A later second than the attempt set aside, even within the same one: resolverName must differ.
      createdAt: sql`max(${Math.floor(now.getTime() / 1000)}, ${mergeResolutions.createdAt} + 1)`,
      decidedAt: null,
    })
    .where(
      and(eq(mergeResolutions.id, id), eq(mergeResolutions.status, 'rejected'))
    );
  const row = await db
    .select({ status: mergeResolutions.status })
    .from(mergeResolutions)
    .where(eq(mergeResolutions.id, id))
    .get();
  return { id, status: row!.status };
}

/**
 * The resolver (MergeResolver Durable Object), transcript and usage record of one attempt at a row: its id and when it
 * was claimed. A retried step rejoins its attempt; a stop tried again (retryRebase) gets a fresh resolver, whose model
 * run starts over instead of returning the failed one, and keeps the earlier attempt's usage.
 */
export const resolverName = (row: Pick<MergeResolution, 'id' | 'createdAt'>) =>
  `${row.id}:${row.createdAt.getTime()}`;

/** Fails a running resolution; returns the error. */
export async function failResolution(
  db: DrizzleDB,
  id: string,
  error: string
): Promise<string> {
  await db
    .update(mergeResolutions)
    .set({ status: 'failed', errorMessage: error, decidedAt: new Date() })
    .where(
      and(eq(mergeResolutions.id, id), eq(mergeResolutions.status, 'running'))
    );
  return error;
}

/** A commit's diff against its first parent, as unified text, clipped. */
async function commitDiff(git: GitService, sha: string): Promise<string> {
  const c = await git.commit(sha);
  const parent = c?.parents[0] ? await git.commit(c.parents[0]) : null;
  const files = await git.fileDiffs(
    await git.diffTrees(parent?.treeHash ?? null, c?.treeHash ?? null)
  );
  const out: string[] = [];
  for (const f of files) {
    out.push(`--- ${f.path} (${f.status})`);
    if (f.binary || f.tooLarge) {
      out.push('(binary or too large)');
      continue;
    }
    for (const h of f.hunks)
      out.push(
        `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
        ...h.lines
      );
  }
  const text = out.join('\n');
  return text.length > MAX_DIFF_CHARS
    ? `${text.slice(0, MAX_DIFF_CHARS)}\n… (diff clipped)`
    : text;
}

/** The model's request for the commit a replay stopped at. */
export async function commitRequest(
  git: GitService,
  pr: Pick<PullRequest, 'number' | 'title' | 'body'>,
  tips: RebaseTips,
  stop: Extract<RebaseResult, { kind: 'conflict' }>
): Promise<ResolveRequest> {
  const landed = await git.commitsBetween(tips.head, tips.onto);
  const subjects =
    landed
      .slice(-MAX_INTENT_COMMITS)
      .map((c) => `- ${c.message.split('\n')[0]}`)
      .join('\n') || '- (no commit messages)';
  const sha = stop.commit.hash;
  return {
    files: Object.fromEntries(stop.files.map((f) => [f.path, f.withMarkers])),
    labels: { ours: tips.ontoBranch, theirs: sha7(sha) },
    oursIntent: `Commits on ${tips.ontoBranch} the pull request is being rebased onto:\n${subjects}`,
    theirsIntent:
      `Pull request #${pr.number}: ${pr.title}\n${pr.body ? `${pr.body.slice(0, DESCRIPTION_CHARS)}\n` : ''}\n` +
      `The commit being replayed (${sha7(sha)}):\n${stop.commit.message}\n\nIts diff:\n${await commitDiff(git, sha)}`,
  };
}

/**
 * Resolves one claimed commit (row `running`): asks the model, checks its files, and stores them (`resolved`) or why
 * not (`failed`). Throws only when the model can't be reached (the step retries). A finished row returns its outcome.
 */
export async function resolveCommit(
  deps: {
    env: CloudflareBindings;
    db: DrizzleDB;
    resolver: (id: string) => ConflictResolverApi;
  },
  id: string
): Promise<{ status: 'resolved' | 'failed'; error?: string }> {
  const { env, db } = deps;
  const row = await db
    .select()
    .from(mergeResolutions)
    .where(eq(mergeResolutions.id, id))
    .get();
  if (!row) return { status: 'failed', error: SUPERSEDED };
  if (row.status === 'resolved' || row.status === 'applied')
    return { status: 'resolved' };
  if (row.status !== 'running')
    return { status: 'failed', error: row.errorMessage ?? undefined };
  const fail = async (error: string) => ({
    status: 'failed' as const,
    error: await failResolution(db, id, error),
  });
  const pr = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.id, row.pullRequestId))
    .get();
  const found = pr ? await findRepoById(db, pr.repositoryId) : undefined;
  if (!pr || pr.state !== 'open' || !found) return fail(SUPERSEDED);
  const git = gitFor(env, found.repo);
  // The model is never asked about commits nobody will land.
  const tips = await rebaseTips(git, pr);
  if (!tips || tips.onto !== row.baseSha || tips.head !== row.headSha)
    return fail(SUPERSEDED);
  const committer = { ...REBASE_COMMITTER, timestamp: 0 };
  const earlier = await resolutionsFor(db, pr.id, tips);
  const stop = await rebase(git, {
    head: tips.head,
    onto: tips.onto,
    committer,
    ontoLabel: tips.ontoBranch,
    resolutions: earlier,
  });
  if (stop.kind !== 'conflict' || stop.commit.hash !== row.commitSha)
    return fail('There is nothing to resolve anymore.');
  const request = await commitRequest(git, pr, tips, stop);
  const attempt = resolverName(row);
  const r = await deps
    .resolver(attempt)
    .resolve({ ...request, model: row.model });
  await env.ACTIONS_LOGS.put(
    transcriptKey(pr.repositoryId, attempt),
    r.transcript,
    {
      httpMetadata: { contentType: 'application/json' },
    }
  );
  let messages: unknown = [];
  try {
    messages = JSON.parse(r.transcript);
  } catch {
    // Not JSON: recorded without token counts.
  }
  // One usage row per resolution (a retried step rejoins the same run, so its record replaces this one).
  await recordAiUsage(env, {
    id: `merge-resolution:${attempt}`,
    feature: 'merge-resolution',
    model: row.model,
    repositoryId: pr.repositoryId,
    pullRequestId: pr.id,
    mergeResolutionId: id,
    ...usageFromTranscript(messages),
  });
  if (r.status !== 'done')
    return fail(`The model didn't finish${r.reason ? ` (${r.reason})` : ''}.`);
  const files: Record<string, string> = {};
  for (const path of row.conflictedPaths) {
    const text = r.files[path];
    if (text === undefined)
      return fail(`The model deleted ${path} instead of resolving it.`);
    if (CONFLICT_MARKER.test(text))
      return fail(`${path} still has conflict markers.`);
    files[path] = text;
  }
  // The commit must now replay: the rebase gets past it (done, or a later commit's conflict).
  const after = await rebase(git, {
    head: tips.head,
    onto: tips.onto,
    committer,
    ontoLabel: tips.ontoBranch,
    resolutions: new Map([
      ...earlier,
      [row.commitSha!, new Map(Object.entries(files))],
    ]),
  });
  if (after.kind === 'conflict' && after.commit.hash === row.commitSha)
    return fail('The resolved files still left conflicts.');
  const extra = Object.keys(r.files).filter(
    (p) => !row.conflictedPaths.includes(p)
  );
  await db
    .update(mergeResolutions)
    .set({
      status: 'resolved',
      resolvedFiles: files,
      explanation: r.explanation.trim() || null,
      touchedExtraPaths: extra.length ? extra : null,
      transcriptR2Key: transcriptKey(pr.repositoryId, attempt),
      durationMs: Date.now() - row.createdAt.getTime(),
      decidedAt: new Date(),
    })
    .where(
      and(eq(mergeResolutions.id, id), eq(mergeResolutions.status, 'running'))
    );
  return { status: 'resolved' };
}
