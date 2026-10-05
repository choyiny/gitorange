import { and, eq, ne, or } from 'drizzle-orm';
import { settleStates } from '../pulls/settle';
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
import { landTargetIs, landTargetOf } from '../lib/land-target';
import { stackGate } from '../stack/gate';
import { onPullClosed } from '../stack/retarget';
import { refreshAgentConfig } from '../agents/refresh';

export const pullRef = (n: number) => `refs/pull/${n}/head`;

type Person = { name: string; email: string };

const TRAILER = /^co-authored-by:\s*(.+?)\s*<([^>]+)>\s*$/gim;

/**
 * Who a squash credits: the author of most of the PR's commits (earliest on a tie), and as
 * co-authors every other commit author plus every Co-authored-by trailer, deduplicated by email.
 */
export function squashCredits(
  commits: { author: Person; message: string }[],
  fallback: Person
): { author: Person; coAuthors: Person[] } {
  const key = (p: Person) => p.email.trim().toLowerCase();
  const counts = new Map<string, { person: Person; n: number }>();
  for (const c of commits) {
    const k = key(c.author);
    if (!k) continue;
    const seen = counts.get(k);
    if (seen) seen.n++;
    else counts.set(k, { person: c.author, n: 1 });
  }
  let author = fallback;
  let best = 0;
  for (const { person, n } of counts.values())
    if (n > best) [author, best] = [person, n];
  const coAuthors = new Map<string, Person>();
  const add = (p: Person) => {
    const k = key(p);
    if (k && k !== key(author) && !coAuthors.has(k)) coAuthors.set(k, p);
  };
  for (const c of commits) {
    add(c.author);
    for (const m of c.message.matchAll(TRAILER))
      add({ name: m[1], email: m[2].trim() });
  }
  return { author, coAuthors: [...coAuthors.values()] };
}

export type LandResult =
  | { ok: true; sha: string; headSha: string }
  | { ok: false; status: 400 | 409; error: string };

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
  /** The committer; also the author when the PR's commits can't be read. */
  author: { name: string; email: string };
  title?: string;
  message?: string;
  resolutionId?: string;
  /** Runs follow-up work (Actions, conflict sweeps) after the merge. */
  after: (work: Promise<unknown>) => void;
  /**
   * Delete the head branch once it has landed (auto-merge), after its stacked children have been sent back to
   * the land target, so a branch a child was stacked on isn't kept for that child.
   */
  deleteBranch?: boolean;
}): Promise<LandResult> {
  const { env, db, git, pr } = opts;
  if (pr.state !== 'open')
    return { ok: false, status: 400, error: 'Pull request is not open' };
  const target = landTargetOf(pr);
  const headSha = await git.resolve(pr.headRef);
  if (!headSha)
    return {
      ok: false,
      status: 400,
      error: 'The head branch no longer exists',
    };
  const gate = await stackGate(db, git, pr);
  if (gate.error)
    return {
      ok: false,
      status: 409,
      error:
        'Couldn’t check how it relates to other open pull requests (the stack tree). Try again.',
    };
  if (gate.blocks.length)
    return {
      ok: false,
      status: 409,
      error: `${gate.blocks.map((b) => b.message.replace(/[.\s]+$/, '')).join('. ')}. A maintainer can dismiss a dependency on the pull request page.`,
    };
  const title = opts.title?.trim() || `${pr.title} (#${pr.number})`;
  const message = opts.message ?? '';
  const timestamp = Math.floor(Date.now() / 1000);
  const committer = { ...opts.author, timestamp };
  const refsBefore = await git.refs();
  const baseBefore = refsBefore.get(`refs/heads/${target}`);
  // Credit the PR's commit authors and co-authors, not the account that merged.
  const prCommits = baseBefore
    ? await git.commitsBetween(baseBefore, headSha).catch(() => [])
    : [];
  const credits = squashCredits(prCommits, opts.author);
  const author = { ...credits.author, timestamp };
  const trailers = credits.coAuthors
    .map((p) => `Co-authored-by: ${p.name} <${p.email}>`)
    .filter((t) => !message.toLowerCase().includes(t.toLowerCase()));
  const body = [message, trailers.join('\n')].filter(Boolean).join('\n\n');
  const fullMessage = body ? `${title}\n\n${body}` : title;
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
        committer,
        message: fullMessage,
      });
      await git.client.push(
        [
          {
            ref: `refs/heads/${target}`,
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
        base: target,
        head: pr.headRef,
        method: 'squash',
        message: fullMessage,
        author,
        committer,
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
  opts.after(settleStates(env, db, pr.repositoryId));
  // Children stacked on its branch go back to the land target; a reconcile restacks them. Only then is the
  // branch free to delete.
  opts.after(
    onPullClosed(env, db, pr, 'landed').then(() =>
      opts.deleteBranch
        ? deleteMergedBranch({
            env,
            db,
            repo: opts.repo,
            git,
            pr,
            headSha,
          })
        : false
    )
  );
  if (baseBefore) {
    const updates = [
      { ref: `refs/heads/${target}`, old: baseBefore, new: sha },
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
    if (target === opts.repo.defaultBranch)
      opts.after(refreshAgentConfig(env, db, opts.repo.id));
  }
  return { ok: true, sha, headSha };
}

/**
 * After auto-merge lands a pull request, deletes its head branch with compare-and-swap on the
 * merged head commit. Keeps it when someone pushed since, when it's the default branch, or when
 * another open pull request uses it as base, head or land target (a stack builds on it). Never throws.
 */
export async function deleteMergedBranch(opts: {
  env: CloudflareBindings;
  db: DrizzleDB;
  repo: Repository;
  git: GitService;
  pr: Pick<PullRequest, 'id' | 'repositoryId' | 'headRef'>;
  /** The head commit that was merged. */
  headSha: string;
}): Promise<boolean> {
  const { env, db, repo, git, pr } = opts;
  const branch = pr.headRef;
  try {
    if (branch === repo.defaultBranch) return false;
    const inUse = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, pr.repositoryId),
          eq(pullRequests.state, 'open'),
          ne(pullRequests.id, pr.id),
          or(
            eq(pullRequests.baseRef, branch),
            eq(pullRequests.headRef, branch),
            landTargetIs(branch)
          )
        )
      )
      .get();
    if (inUse) return false;
    if ((await git.resolve(branch)) !== opts.headSha) return false;
    // A deletion starts no Actions run and leaves no PR to sweep, so a live ping is all it needs.
    await git.deleteBranch(branch, opts.headSha);
  } catch (e) {
    console.warn('[merge] could not delete merged branch', pr.id, branch, e);
    return false;
  }
  await publishChange(env, pr.repositoryId);
  return true;
}
