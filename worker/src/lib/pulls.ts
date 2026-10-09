import { and, eq, sql } from 'drizzle-orm';
import { settleStates } from '../pulls/settle';
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
import { ensureRebase } from '../merge/rebase';
import { pullRef } from '../merge/land';
import { ensureHeadReview } from '../review/head';
import { publishChange } from '../live/publish';
import { ensureStacking } from '../stack/discover';
import { landTargetIs, landTargetOf } from './land-target';

/**
 * The commits a PR compares: live branches while open; once merged, the landed commits (or, for a squash-era merge,
 * the squash commit's first parent and `refs/pull/<n>/head`); once closed, `refs/pull/<n>/head`.
 */
export async function pullShas(
  git: GitService,
  pr: PullRequest
): Promise<{ base: string; head: string } | null> {
  if (pr.state === 'merged' && pr.mergeCommitSha) {
    if (pr.landedCommits != null) {
      // Landed by fast-forward: its commits are the first-parent run below the landed head.
      if (pr.landedCommits === 0)
        return { base: pr.mergeCommitSha, head: pr.mergeCommitSha };
      const landed = await git.log(pr.mergeCommitSha, pr.landedCommits);
      const oldest = landed.at(-1);
      if (landed.length < pr.landedCommits || !oldest?.parents[0]) return null;
      return { base: oldest.parents[0], head: pr.mergeCommitSha };
    }
    // Landed before rebase merging, as one squash commit: its first parent, and the pinned head.
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
 * Opens a PR and starts its review, AI conflict resolution if needed, stack discovery, and
 * `pull_request` runs.
 * Caller checks push permission.
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
  /**
   * Provenance, self-reported by the MCP client that opens it (all null otherwise): the app's name, its coding
   * session's label, and the person's original request.
   */
  createdVia?: string | null;
  sessionLabel?: string | null;
  request?: string | null;
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
  // Branches only: resolve() accepts SHAs/tags, and merging pushes to refs/heads/<base>.
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
        // Stacked PRs keep their land target; their base_ref is a parent's branch.
        landTargetIs(base),
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

  // Atomic number claim: bump and insert share a batch; the insert reads the bumped value.
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
      landTarget: base,
      headRef: head,
      state: 'open',
      createdVia: opts.createdVia ?? null,
      sessionLabel: opts.sessionLabel ?? null,
      request: opts.request ?? null,
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
  // A new PR's base is its land target, so these are also its land shas.
  const shas = { base: baseSha, head: headSha };
  opts.after(
    ensureHeadReview(env, db, pr, shas).catch((e) =>
      console.error('[review] start failed', e)
    )
  );
  // A PR opened against a moved base is rebased onto it.
  opts.after(ensureRebase(env, db, git, pr));
  // Stack discovery: starts now where no agent reviews (nothing to wait for); otherwise the review starts it.
  opts.after(
    ensureStacking(env, db, git, pr, shas).catch((e) =>
      console.error('[stack] start failed', e)
    )
  );
  opts.after(
    queueRuns(env, db, repo, opts.repoFullName, {
      kind: 'pull_request',
      number: pr.number,
      title: pr.title,
      baseRef: landTargetOf(pr),
      headRef: pr.headRef,
      headSha,
      actorId: opts.author.id,
    }).catch((e) => console.error('[actions] queue failed', e))
  );
  opts.after(publishChange(env, repo.id, { approvals: true }));
  opts.after(settleStates(env, db, repo.id));
  return { ok: true, pr };
}

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
