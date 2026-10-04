import { and, eq } from 'drizzle-orm';
import { publishChange } from '../live/publish';
import type { DrizzleDB } from '../db/middleware';
import {
  mergeResolutions,
  pullRequests,
  repositories,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import { makeCommit } from '../git/objects';
import { GitPushError, ZERO_SHA } from '../git/remote';
import { MergeConflictError, type GitService } from '../git/service';
import { onRefsUpdated } from '../actions/trigger';
import { autoResolveConflicts } from './auto';
import { latestResolution } from './resolution';

export const pullRef = (n: number) => `refs/pull/${n}/head`;

export type LandResult =
  { ok: true; sha: string } | { ok: false; status: 400 | 409; error: string };

/**
 * Squashes a pull request onto the target tip and pushes with compare-and-swap, including any
 * valid AI resolution for the current commits. `by` is null for auto-merge (PR author commits).
 */
export async function landPull(opts: {
  env: CloudflareBindings;
  db: DrizzleDB;
  repo: Repository;
  repoFullName: string;
  git: GitService;
  pr: PullRequest;
  by: { id: string; name: string; email: string } | null;
  author: { name: string; email: string };
  title?: string;
  message?: string;
  resolutionId?: string;
  /** Runs follow-up work (Actions, conflict sweeps) after the merge. */
  after: (work: Promise<unknown>) => void;
}): Promise<LandResult> {
  const { env, db, git, pr } = opts;
  if (pr.state !== 'open')
    return { ok: false, status: 400, error: 'Pull request is not open' };
  const headSha = await git.resolve(pr.headRef);
  if (!headSha)
    return {
      ok: false,
      status: 400,
      error: 'The head branch no longer exists',
    };
  const title = opts.title?.trim() || `${pr.title} (#${pr.number})`;
  const message = opts.message ?? '';
  const author = { ...opts.author, timestamp: Math.floor(Date.now() / 1000) };
  const fullMessage = message ? `${title}\n\n${message}` : title;
  const refsBefore = await git.refs();
  const baseBefore = refsBefore.get(`refs/heads/${pr.baseRef}`);
  let sha: string;
  let appliedResolution: string | null = null;
  try {
    let resolutionId = opts.resolutionId;
    if (!resolutionId) {
      const latest = await latestResolution(db, pr.id);
      if (
        latest?.status === 'proposed' &&
        latest.baseSha === baseBefore &&
        latest.headSha === headSha
      )
        resolutionId = latest.id;
    }
    if (resolutionId) {
      const row = await db
        .select()
        .from(mergeResolutions)
        .where(
          and(
            eq(mergeResolutions.id, resolutionId),
            eq(mergeResolutions.pullRequestId, pr.id)
          )
        )
        .get();
      if (!row || row.status !== 'proposed' || !row.resultSha)
        return {
          ok: false,
          status: 400,
          error: 'This resolution is no longer available',
        };
      if (row.baseSha !== baseBefore || row.headSha !== headSha)
        return {
          ok: false,
          status: 409,
          error:
            'The branches changed since this resolution was made. Resolve the conflicts again.',
        };
      const resolved = await git.commit(row.resultSha);
      if (!resolved)
        return {
          ok: false,
          status: 400,
          error: 'Resolution commit is missing',
        };
      // The resolved tree is already stored on the resolution's side ref.
      const commit = await makeCommit({
        tree: resolved.treeHash,
        parents: [row.baseSha],
        author,
        message: fullMessage,
      });
      await git.client.push(
        [
          {
            ref: `refs/heads/${pr.baseRef}`,
            old: row.baseSha,
            new: commit.sha,
          },
          {
            ref: pullRef(pr.number),
            old: refsBefore.get(pullRef(pr.number)) ?? ZERO_SHA,
            new: headSha,
          },
        ],
        [commit]
      );
      sha = commit.sha;
      appliedResolution = row.id;
    } else {
      ({ sha } = await git.merge({
        base: pr.baseRef,
        head: pr.headRef,
        method: 'squash',
        message: fullMessage,
        author,
        extraRefs: [{ ref: pullRef(pr.number), sha: headSha }],
      }));
    }
  } catch (e) {
    if (e instanceof MergeConflictError)
      return { ok: false, status: 409, error: e.message };
    if (e instanceof GitPushError)
      return {
        ok: false,
        status: 409,
        error: 'Base branch was modified. Review and try the merge again.',
      };
    return {
      ok: false,
      status: 400,
      error: e instanceof Error ? e.message : 'Merge failed',
    };
  }
  if (appliedResolution)
    await db
      .update(mergeResolutions)
      .set({ status: 'applied', decidedAt: new Date() })
      .where(eq(mergeResolutions.id, appliedResolution));
  const now = new Date();
  // The push is the commit point; record only after it succeeds.
  await db
    .update(pullRequests)
    .set({
      state: 'merged',
      mergeCommitSha: sha,
      mergedById: opts.by?.id ?? null,
      mergedAutomatically: !opts.by,
      mergedAt: now,
      closedAt: now,
      updatedAt: now,
    })
    .where(eq(pullRequests.id, pr.id));
  await db
    .update(repositories)
    .set({ updatedAt: now })
    .where(eq(repositories.id, pr.repositoryId));
  // Auto-merges happen in the background.
  opts.after(publishChange(env, pr.repositoryId, { approvals: true }));
  if (baseBefore) {
    const updates = [
      { ref: `refs/heads/${pr.baseRef}`, old: baseBefore, new: sha },
    ];
    opts.after(autoResolveConflicts(env, opts.repo, updates));
    opts.after(
      onRefsUpdated(
        env,
        db,
        opts.repo,
        opts.repoFullName,
        updates,
        opts.by?.id ?? pr.authorId
      )
    );
  }
  return { ok: true, sha };
}
