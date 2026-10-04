import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  pullRequestComments,
  pullRequests,
  repositories,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import type { GitService } from '../git/service';
import { queueRuns } from '../actions/trigger';
import { ensureResolution } from '../merge/auto';
import { pullRef } from '../merge/land';
import { ensureClassification } from '../review/classify';
import { publishChange } from '../live/publish';

/**
 * The two commits a PR compares. Open PRs track their live branches; once merged or closed
 * they're pinned (`refs/pull/<n>/head`, and the merge commit's first parent for the base).
 */
export async function pullShas(
  git: GitService,
  pr: PullRequest
): Promise<{ base: string; head: string } | null> {
  if (pr.state === 'merged' && pr.mergeCommitSha) {
    const merge = await git.commit(pr.mergeCommitSha);
    const head = (await git.resolve(pullRef(pr.number))) ?? merge?.parents[1];
    if (!merge || !head) return null;
    return { base: merge.parents[0], head };
  }
  const head =
    pr.state === 'open'
      ? await git.resolve(pr.headRef)
      : ((await git.resolve(pullRef(pr.number))) ??
        (await git.resolve(pr.headRef)));
  const base = await git.resolve(pr.baseRef);
  return head && base ? { base, head } : null;
}

export type OpenPullResult =
  | { ok: true; pr: PullRequest }
  | { ok: false; status: 400 | 409; error: string };

/**
 * Opens a pull request from `head` into `base` (both branch names) and starts everything that
 * follows: the auto-merge review, AI conflict resolution if it already conflicts, and Actions
 * `pull_request` runs. The caller has checked push permission.
 */
export async function openPull(opts: {
  env: CloudflareBindings;
  db: DrizzleDB;
  git: GitService;
  repo: Repository;
  repoFullName: string;
  author: { id: string };
  title: string;
  body: string;
  base: string;
  head: string;
  /** Runs follow-up work after the response. */
  after: (work: Promise<unknown>) => void;
}): Promise<OpenPullResult> {
  const { env, db, git, repo, base, head } = opts;
  if (base === head)
    return {
      ok: false,
      status: 400,
      error: 'Base and head must be different branches',
    };
  // Both sides must be branch names: resolve() also accepts SHAs and tags, and a merge
  // pushes to refs/heads/<base>, so a non-branch base would create a stray branch.
  const refs = await git.refs();
  const baseSha = refs.get(`refs/heads/${base}`);
  const headSha = refs.get(`refs/heads/${head}`);
  if (!baseSha || !headSha)
    return { ok: false, status: 400, error: 'Branch not found' };
  if ((await git.mergeBase(baseSha, headSha)) === headSha)
    return {
      ok: false,
      status: 400,
      error: `There isn't anything to compare. ${base} is up to date with ${head}.`,
    };
  const existing = await db
    .select({ number: pullRequests.number })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repo.id),
        eq(pullRequests.state, 'open'),
        eq(pullRequests.baseRef, base),
        eq(pullRequests.headRef, head)
      )
    )
    .get();
  if (existing)
    return {
      ok: false,
      status: 409,
      error: `A pull request already exists for ${head} (#${existing.number}).`,
    };

  // Claim the next number atomically: the bump and the insert share one batch, and the
  // insert reads the number the bump just reserved.
  const id = crypto.randomUUID();
  const now = new Date();
  await db.batch([
    db
      .update(repositories)
      .set({
        nextPrNumber: sql`${repositories.nextPrNumber} + 1`,
        updatedAt: now,
      })
      .where(eq(repositories.id, repo.id)),
    db.insert(pullRequests).values({
      id,
      repositoryId: repo.id,
      number:
        sql`(SELECT next_pr_number - 1 FROM repositories WHERE id = ${repo.id})` as unknown as number,
      title: opts.title.trim(),
      body: opts.body,
      authorId: opts.author.id,
      baseRef: base,
      headRef: head,
      state: 'open',
      createdAt: now,
      updatedAt: now,
    }),
  ]);
  const pr = (await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.id, id))
    .get())!;
  await git
    .setRef(pullRef(pr.number), headSha)
    .catch((e) => console.error('[pulls] pin ref failed', e));
  const shas = { base: baseSha, head: headSha };
  opts.after(
    ensureClassification(env, db, git, pr, shas).catch((e) =>
      console.error('[review] start failed', e)
    )
  );
  // A PR opened against a moved base may already conflict.
  opts.after(
    ensureResolution(env, db, git, pr, shas).catch((e) =>
      console.error('[merge] auto-resolve failed', e)
    )
  );
  opts.after(
    queueRuns(env, db, repo, opts.repoFullName, {
      kind: 'pull_request',
      number: pr.number,
      title: pr.title,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      headSha,
      actorId: opts.author.id,
    }).catch((e) => console.error('[actions] queue failed', e))
  );
  opts.after(publishChange(env, repo.id, { approvals: true }));
  return { ok: true, pr };
}

/** Adds a comment to a pull request. */
export async function addComment(
  env: CloudflareBindings,
  db: DrizzleDB,
  pr: PullRequest,
  authorId: string,
  body: string
) {
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    pullRequestId: pr.id,
    authorId,
    body,
    createdAt: now,
    updatedAt: now,
  };
  await db.batch([
    db.insert(pullRequestComments).values(row),
    db
      .update(pullRequests)
      .set({ updatedAt: now })
      .where(eq(pullRequests.id, pr.id)),
  ]);
  await publishChange(env, pr.repositoryId);
  return row;
}
