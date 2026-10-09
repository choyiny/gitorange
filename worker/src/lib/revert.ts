import type { PullRequest, Repository } from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import { makeCommit, makeTree, type GitObject } from '../git/objects';
import { GitPushError, ZERO_SHA } from '../git/remote';
import type { GitService } from '../git/service';
import { recordAudit } from './audit';
import { landTargetOf } from './land-target';
import { openPull, pullShas } from './pulls';
import { gitFor } from './repos';

// Reverting a merged pull request (Decision 8): GitOrange computes the inverse of the commits it landed, on top of
// the target branch as it is now, pushes that as a new branch and opens a pull request for it. It never pushes to the
// target: the revert is reviewed and lands like any other change.

export type RevertResult =
  | { ok: true; pr: PullRequest; branch: string; sha: string }
  | { ok: false; status: 409; message: string };

const refuse = (message: string): RevertResult => ({
  ok: false,
  status: 409,
  message,
});

/** The most branch names tried after `revert-<n>` (`revert-<n>-2`, `-3`, ...). */
const MAX_SUFFIX = 50;

/** `revert-<n>`, or the first free `revert-<n>-<k>`. */
function freeBranch(refs: Map<string, string>, n: number): string | null {
  const base = `revert-${n}`;
  if (!refs.has(`refs/heads/${base}`)) return base;
  for (let k = 2; k <= MAX_SUFFIX; k++)
    if (!refs.has(`refs/heads/${base}-${k}`)) return `${base}-${k}`;
  return null;
}

/**
 * The commits a merged pull request landed: `head` its landed head (`merge_commit_sha`) and `parent` what its target
 * pointed at before. Rebase landings (`landed_commits` set) landed that many first-parent commits; older squash
 * landings (`landed_commits` NULL) one squash commit.
 */
async function landedRange(
  git: GitService,
  pr: PullRequest
): Promise<{ head: string; parent: string; commits: number } | null> {
  if (!pr.mergeCommitSha) return null;
  if (pr.landedCommits === null) {
    const squash = await git.commit(pr.mergeCommitSha);
    const parent = squash?.parents[0];
    return parent ? { head: pr.mergeCommitSha, parent, commits: 1 } : null;
  }
  if (pr.landedCommits === 0) return null;
  const shas = await pullShas(git, pr);
  return shas
    ? { head: shas.head, parent: shas.base, commits: pr.landedCommits }
    : null;
}

/**
 * Opens a pull request that reverts merged pull request `pr`: a commit on top of its target's tip whose tree is the
 * three-way merge of the tip and the landed range's parent over the landed head (`GitService.mergeTrees`), so later
 * changes to other lines stay. Authored by `user`, on branch `revert-<n>` (or the first free suffix). Refused (409)
 * when the pull request isn't merged, the target is gone, the change no longer applies cleanly, or the target already
 * undoes it. The caller checks push access.
 */
export async function revertPull(opts: {
  env: CloudflareBindings;
  db: DrizzleDB;
  git: GitService;
  repo: Repository;
  repoFullName: string;
  pr: PullRequest;
  user: { id: string; name: string; email: string };
  after: (work: Promise<unknown>) => void;
}): Promise<RevertResult> {
  const { env, db, git, repo, pr, user } = opts;
  if (pr.state !== 'merged')
    return refuse('Only a merged pull request can be reverted.');
  const range = await landedRange(git, pr);
  if (!range)
    return refuse(
      'GitOrange can’t find the commits this pull request landed, so it can’t revert it.'
    );
  const target = landTargetOf(pr);
  const refs = await git.client.listRefs().then((ad) => ad.refs);
  const tip = refs.get(`refs/heads/${target}`);
  if (!tip)
    return refuse(`${target}, the branch it merged into, no longer exists.`);
  const [landed, parent, now] = await Promise.all([
    git.commit(range.head),
    git.commit(range.parent),
    git.commit(tip),
  ]);
  if (!landed || !parent || !now)
    return refuse('GitOrange can’t read the commits it would revert.');

  // Undo the landed range (landed head → its parent) on top of the tip.
  const state = { created: [] as GitObject[], conflicts: [] as string[] };
  let tree = await git.mergeTrees(
    landed.treeHash,
    now.treeHash,
    parent.treeHash,
    state
  );
  if (state.conflicts.length)
    return refuse(
      `#${pr.number} can’t be reverted cleanly: later changes to ${target} touch the same lines in ${state.conflicts.join(', ')}. Revert it by hand.`
    );
  if (tree === null) {
    const empty = await makeTree([]);
    state.created.push(empty);
    tree = empty.sha;
  }
  if (tree === now.treeHash)
    return refuse(
      `${target} already undoes #${pr.number}: there is nothing to revert.`
    );

  const branch = freeBranch(refs, pr.number);
  if (!branch)
    return refuse(
      `Too many revert-${pr.number} branches exist. Delete some, then try again.`
    );
  const at = Math.floor(Date.now() / 1000);
  const signature = { name: user.name, email: user.email, timestamp: at };
  const reverted =
    range.commits === 1
      ? `commit ${range.head}`
      : `commits ${range.parent.slice(0, 7)}..${range.head.slice(0, 7)}`;
  const commit = await makeCommit({
    tree,
    parents: [tip],
    author: signature,
    message: `Revert #${pr.number}: ${pr.title}\n\nThis reverts ${reverted}.`,
  });
  try {
    await git.client.push(
      [{ ref: `refs/heads/${branch}`, old: ZERO_SHA, new: commit.sha }],
      [...state.created, commit]
    );
  } catch (e) {
    if (e instanceof GitPushError)
      return refuse(`The branch ${branch} was just created. Try again.`);
    throw e;
  }

  const count =
    range.commits === 1 ? 'the commit' : `the ${range.commits} commits`;
  // No pull request, no branch: a failed open takes the branch back down (only if it still points at our commit).
  const dropBranch = () =>
    git.client
      .push(
        [{ ref: `refs/heads/${branch}`, old: commit.sha, new: ZERO_SHA }],
        []
      )
      .catch((e) => console.error(`[revert] could not delete ${branch}`, e));
  let result: Awaited<ReturnType<typeof openPull>>;
  try {
    result = await openPull({
      env,
      db,
      // A fresh service: this one's ref listing predates the new branch.
      git: gitFor(env, repo),
      repo,
      repoFullName: opts.repoFullName,
      author: user,
      title: `Revert #${pr.number}: ${pr.title}`.slice(0, 256),
      body: `Reverts #${pr.number} (${pr.title}).\n\nThis undoes ${count} #${pr.number} landed on \`${target}\` (up to ${range.head.slice(0, 7)}), on top of \`${target}\` as it is now (${tip.slice(0, 7)}).`,
      base: target,
      head: branch,
      after: opts.after,
    });
  } catch (e) {
    await dropBranch();
    throw e;
  }
  if (!result.ok) {
    await dropBranch();
    return refuse(result.error);
  }
  await recordAudit(db, {
    repositoryId: repo.id,
    actorId: user.id,
    action: 'pull.reverted',
    target: `#${pr.number}`,
    pull: pr.number,
    data: {
      title: pr.title,
      revert: result.pr.number,
      branch,
      sha: commit.sha,
    },
  });
  return { ok: true, pr: result.pr, branch, sha: commit.sha };
}
