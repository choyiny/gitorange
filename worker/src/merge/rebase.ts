/**
 * Rebase runs. GitOrange keeps each open pull request rebased onto its base_ref (a parent pull request's branch while
 * stacked, else the land target): a `rebase` payload on MERGE_RESOLUTION replays the pull request's own commits
 * (git/rebase.ts) and replaces the branch with compare-and-swap on the old head, keeping the old head as
 * refs/pull/N/pre-rebase/<sha7>. A commit whose replay conflicts gets a merge_resolutions row: AI resolves its text
 * conflicts (merge/commit-resolution.ts) and the replay goes on; where the run stops (AI can't take the conflict, or
 * failed), the pull request shows `rebase_conflict` and its agent rebases locally. A rebase that would leave no
 * commits (the base already has every change) never rewrites the branch: the run records NOTHING_TO_MERGE instead.
 * Nor does a rebase of a branch others build on (rebaseBlocked: the default branch, a branch matching one of the
 * repository's protected branch patterns, or the head of another open pull request into a different base), which
 * would rewrite shared history, or flip between two bases forever.
 */
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  ne,
  notLike,
  or,
} from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  agentRuns,
  mergeResolutions,
  pullRequests,
  repositories,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import { onRefsUpdated } from '../actions/trigger';
import type { GitObject, Signature } from '../git/objects';
import { GitPushError, ZERO_SHA } from '../git/remote';
import {
  MAX_REBASE_COMMITS,
  rebase,
  REBASE_COMMITTER,
  type CommitResolutions,
  type RebaseResult,
} from '../git/rebase';
import type { GitService } from '../git/service';
import { landTargetOf } from '../lib/land-target';
import { protectedBy } from '../lib/protected-branches';
import { findRepoById, gitFor } from '../lib/repos';
import { pingingSteps, publishChange } from '../live/publish';
import { recordEvent } from '../pulls/events';
import { maybeAutoMerge } from '../review/auto-merge';
import { carryReview } from '../review/carry';
import { contains } from '../stack/contains';
import { startSweep } from './auto';
import {
  claimResolution,
  failResolution,
  MODEL_UNREACHABLE,
  RESOLVE_RETRIES,
  resolveCommit,
} from './commit-resolution';
import { generatedConflicts } from './generated';
import {
  isNotRebased,
  latestResolution,
  NO_MODEL,
  NOT_REBASED,
  NOTHING_TO_MERGE,
  rebaseRow,
  resolutionConfigured,
  SUPERSEDED,
  type StepRunner,
} from './resolution';
import type { ConflictResolverApi } from './resolver';

export type RebaseParams = { pullRequestId: string };

/** What a rebase is between: the tip it goes onto (and that branch), and the pull request's head. */
export type RebaseTips = { onto: string; ontoBranch: string; head: string };

/** Tries per run: a push to the branch while it rebases starts it over from the new tips. */
export const MAX_REBASE_ATTEMPTS = 3;
/** A rebase run still marked running this long after it started no longer holds back a new one. */
export const REBASE_RUN_FRESH_MS = 15 * 60_000;
/** At most this many commits of one rebase run are resolved by AI; then the agent rebases locally. */
export const MAX_AI_COMMITS = 20;

const ONCE = { retries: { limit: 0, delay: 0 } } as const;
const sha7 = (s: string) => s.slice(0, 7);

/** Where a rebase keeps the head it replaced. */
export const preRebaseRef = (number: number, sha: string) =>
  `refs/pull/${number}/pre-rebase/${sha7(sha)}`;

/** A merge_resolutions row's id: one per pull request, tips and commit (null: the rebase as a whole). */
export const resolutionId = (
  pullRequestId: string,
  tips: { onto: string; head: string },
  commit: string | null
) =>
  `${pullRequestId}-${tips.onto.slice(0, 12)}-${tips.head.slice(0, 12)}-${commit ? commit.slice(0, 12) : 'all'}`;

/** Why a rebase stopped for the agent (merge_resolutions.error_message, shown with `rebase_conflict`). */
export const stopMessage = {
  tooMany: (n: number) =>
    `Too many commits to rebase (${n}; at most ${MAX_REBASE_COMMITS}) — squash locally.`,
  notText: (commit: string, paths: string[]) =>
    `Commit ${sha7(commit)} conflicts in ${paths.join(', ')}: binary files, or a file deleted on one side and changed on the other. Rebase locally.`,
  generated: (commit: string, paths: string[]) =>
    `Commit ${sha7(commit)} conflicts in generated files (${paths.join(', ')}). Rebase locally and regenerate them.`,
  noAi: (commit: string, paths: string[]) =>
    `Commit ${sha7(commit)} conflicts in ${paths.join(', ')}. Rebase locally.`,
  tooManyConflicts: (commit: string, paths: string[]) =>
    `Commit ${sha7(commit)} conflicts in ${paths.join(', ')}; AI already resolved ${MAX_AI_COMMITS} commits of this rebase. Rebase locally.`,
  defaultBranch: (branch: string) =>
    `${NOT_REBASED} ${branch} is the default branch.`,
  sharedHead: (branch: string, number: number) =>
    `${NOT_REBASED} ${branch} is the head of another open pull request (#${number}).`,
  protectedBranch: (branch: string) =>
    `${NOT_REBASED} ${branch} is a protected branch; bring it up to date yourself.`,
};

/**
 * Why GitOrange must not rewrite this pull request's branch, or null. The default branch is shared history, and so is
 * any branch matching the repository's protected branch patterns (release/*, develop: lib/protected-branches.ts); a
 * head that another open pull request uses with a different base would be rebased onto each base in turn, each write
 * re-queueing the other, forever. A pull request opened against this branch (hand-stacked) doesn't block it: it
 * rebases onto the rewritten branch in turn. Checked before a rebase is queued, again before one is written, by
 * landing's rebase, and by the page's rebase view.
 */
export async function rebaseBlocked(
  db: DrizzleDB,
  pr: Pick<PullRequest, 'id' | 'repositoryId' | 'headRef' | 'baseRef'>
): Promise<string | null> {
  const repo = await db
    .select({
      defaultBranch: repositories.defaultBranch,
      protectedBranches: repositories.protectedBranches,
    })
    .from(repositories)
    .where(eq(repositories.id, pr.repositoryId))
    .get();
  if (repo?.defaultBranch === pr.headRef)
    return stopMessage.defaultBranch(pr.headRef);
  if (protectedBy(repo?.protectedBranches, pr.headRef))
    return stopMessage.protectedBranch(pr.headRef);
  const other = await db
    .select({ number: pullRequests.number })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, pr.repositoryId),
        eq(pullRequests.state, 'open'),
        eq(pullRequests.headRef, pr.headRef),
        ne(pullRequests.baseRef, pr.baseRef),
        ne(pullRequests.id, pr.id)
      )
    )
    .orderBy(asc(pullRequests.number))
    .get();
  return other ? stopMessage.sharedHead(pr.headRef, other.number) : null;
}

/** The tips a pull request rebases between: base_ref's (the land target's when that branch is gone) and its head. */
export async function rebaseTips(
  git: GitService,
  pr: Pick<PullRequest, 'baseRef' | 'landTarget' | 'headRef'>
): Promise<RebaseTips | null> {
  const [base, target, head] = await Promise.all([
    git.resolve(pr.baseRef),
    git.resolve(landTargetOf(pr)),
    git.resolve(pr.headRef),
  ]);
  const onto = base ?? target;
  if (!onto || !head) return null;
  return { onto, ontoBranch: base ? pr.baseRef : landTargetOf(pr), head };
}

/**
 * The resolved contents of the pull request's conflicting commits at these tips, by original commit. Applied ones
 * count too: an agent that pushes its pre-rebase head back gets the same rebase again.
 */
export async function resolutionsFor(
  db: DrizzleDB,
  pullRequestId: string,
  tips: { onto: string; head: string }
): Promise<CommitResolutions> {
  const resolved = await db
    .select({
      commitSha: mergeResolutions.commitSha,
      files: mergeResolutions.resolvedFiles,
    })
    .from(mergeResolutions)
    .where(
      and(
        eq(mergeResolutions.pullRequestId, pullRequestId),
        eq(mergeResolutions.baseSha, tips.onto),
        eq(mergeResolutions.headSha, tips.head),
        inArray(mergeResolutions.status, ['resolved', 'applied'])
      )
    )
    .all();
  const out: CommitResolutions = new Map();
  for (const r of resolved)
    if (r.commitSha && r.files)
      out.set(r.commitSha, new Map(Object.entries(r.files)));
  return out;
}

/** Rebases the pull request's head onto `tips.onto` in memory, with every resolution made for these tips. */
export async function rebaseAt(
  git: GitService,
  db: DrizzleDB,
  pr: Pick<PullRequest, 'id'>,
  tips: RebaseTips,
  committer: Signature
): Promise<RebaseResult> {
  return rebase(git, {
    head: tips.head,
    onto: tips.onto,
    committer,
    ontoLabel: tips.ontoBranch,
    resolutions: await resolutionsFor(db, pr.id, tips),
  });
}

/** Records where a rebase stopped for the agent (a failed row AI never attempted); returns the message. */
export async function recordStop(
  db: DrizzleDB,
  pullRequestId: string,
  tips: { onto: string; head: string },
  stop: { commit: string | null; paths: string[]; error: string }
): Promise<string> {
  const now = new Date();
  const blocked = isNotRebased(stop.error);
  // A "not rebased" stop has its own id: it may be lifted, and a real stop at the same tips must still record.
  const id = `${resolutionId(pullRequestId, tips, stop.commit)}${blocked ? '-not-rebased' : ''}`;
  if (blocked) {
    // Recorded on every check while the block holds (page views): write only when it isn't there already.
    const had = await db
      .select({ error: mergeResolutions.errorMessage })
      .from(mergeResolutions)
      .where(eq(mergeResolutions.id, id))
      .get();
    if (had?.error === stop.error) return stop.error;
  }
  const row = {
    id,
    pullRequestId,
    baseSha: tips.onto,
    headSha: tips.head,
    commitSha: stop.commit,
    status: 'failed' as const,
    model: NO_MODEL,
    conflictedPaths: stop.paths,
    errorMessage: stop.error,
    createdAt: now,
    decidedAt: now,
  };
  // An AI claim of this commit left running (its run died; AI isn't configured now, or this run is past
  // MAX_AI_COMMITS) becomes this stop: the row is the stop, never a resolution that will not come. So does a stop a
  // person set aside to try again (retryRebase): stopping at the same place again, it is the stop again.
  if (!blocked)
    await db
      .update(mergeResolutions)
      .set({
        status: 'failed',
        model: NO_MODEL,
        conflictedPaths: stop.paths,
        errorMessage: stop.error,
        decidedAt: now,
      })
      .where(
        and(
          eq(mergeResolutions.id, id),
          inArray(mergeResolutions.status, ['running', 'rejected'])
        )
      );
  await db
    .insert(mergeResolutions)
    .values(row)
    // The same stop again (a block's other PR changed; a run stopping where an earlier one did): it is the latest now.
    .onConflictDoUpdate({
      target: mergeResolutions.id,
      // Only a block's own row takes the new message; another row at this id keeps what it recorded.
      set: blocked
        ? { errorMessage: row.errorMessage, createdAt: now, decidedAt: now }
        : { createdAt: now, decidedAt: now },
    });
  // A real stop means any block at these tips was lifted: drop its row, so no reader shows it over this one.
  if (!blocked) await clearLiftedBlock(db, pullRequestId, tips);
  return stop.error;
}

/** Deletes the pull request's "not rebased" rows at these tips (the block no longer applies). */
async function clearLiftedBlock(
  db: DrizzleDB,
  pullRequestId: string,
  tips: { onto: string; head: string }
) {
  await db
    .delete(mergeResolutions)
    .where(
      and(
        eq(mergeResolutions.pullRequestId, pullRequestId),
        eq(mergeResolutions.baseSha, tips.onto),
        eq(mergeResolutions.headSha, tips.head),
        like(mergeResolutions.errorMessage, `${NOT_REBASED}%`)
      )
    );
}

/**
 * Starts a rebase run for a pull request behind its base, unless one started in the last REBASE_RUN_FRESH_MS is still
 * running for it, or the last rebase at these tips stopped (a conflict: the agent's move, or a person's retryRebase;
 * or nothing to merge). A run that died, or a resolution left running by one, doesn't hold it back: the new run picks
 * it up. Never throws.
 */
export async function ensureRebase(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest,
  /** `ignoreRun`: the calling rebase run's own id (its agent run is still running while it requeues). */
  opts: { ignoreRun?: string } = {}
): Promise<boolean> {
  if (!resolutionConfigured(env) || pr.state !== 'open') return false;
  try {
    const tips = await rebaseTips(git, pr);
    if (!tips) return false;
    // Up to date (or git can't say), or the base already has all of it: nothing to replay.
    if ((await contains(git, tips.onto, tips.head)) !== false) return false;
    if ((await contains(git, tips.head, tips.onto)) === true) return false;
    // A branch GitOrange must not rewrite: say why, and queue nothing.
    const blocked = await rebaseBlocked(db, pr);
    if (blocked) {
      await recordStop(db, pr.id, tips, {
        commit: null,
        paths: [],
        error: blocked,
      });
      return false;
    }
    // Not blocked now: a block recorded at these tips was lifted (the other pull request closed, the default
    // branch changed, or the protected patterns changed). Drop its row so the pull request's state stops showing it.
    const lifted = await db
      .select({ id: mergeResolutions.id })
      .from(mergeResolutions)
      .where(
        and(
          eq(mergeResolutions.pullRequestId, pr.id),
          eq(mergeResolutions.baseSha, tips.onto),
          eq(mergeResolutions.headSha, tips.head),
          like(mergeResolutions.errorMessage, `${NOT_REBASED}%`)
        )
      )
      .get();
    if (lifted) await clearLiftedBlock(db, pr.id, tips);
    // The real outcome at these tips (latestResolution never returns a "not rebased" row).
    const last = await latestResolution(db, pr.id);
    if (
      last &&
      last.baseSha === tips.onto &&
      last.headSha === tips.head &&
      last.status === 'failed' &&
      last.errorMessage !== SUPERSEDED
    )
      return false;
    const running = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.pullRequestId, pr.id),
          eq(agentRuns.kind, 'rebase'),
          eq(agentRuns.status, 'running'),
          gt(agentRuns.startedAt, new Date(Date.now() - REBASE_RUN_FRESH_MS)),
          ...(opts.ignoreRun ? [ne(agentRuns.id, opts.ignoreRun)] : [])
        )
      )
      .get();
    if (running) return false;
    await env.MERGE_RESOLUTION.create({
      id: `rebase-${crypto.randomUUID()}`,
      params: { rebase: { pullRequestId: pr.id } },
    });
    return true;
  } catch (e) {
    console.error('[rebase] could not start', pr.id, e);
    return false;
  }
}

export type RetryRebase =
  | { ok: true; view: RebaseView; started: boolean }
  | { ok: false; error: string };

/**
 * A person tries a stopped rebase again (the page's "Try the rebase again", MCP gitorange_retry_rebase): the stop at
 * the current tips (failed rows: AI failing on a commit, too many commits for AI, a conflict AI never took) is set
 * aside as `rejected`, so it no longer reads as the pull request's outcome (rebase_conflict, rebaseView, ensureRebase),
 * then a rebase run starts. The run reuses those rows: it claims a set-aside commit afresh, asking AI again with a new
 * resolver (claimResolution; the failed attempt's usage and transcript keep their own keys), or records the same stop
 * again (recordStop). Refused when
 * nothing is stopped, or for a branch GitOrange doesn't rewrite ("Not rebased: ..."), which only that branch's owner
 * can bring up to date.
 */
export async function retryRebase(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest
): Promise<RetryRebase> {
  if (pr.state !== 'open')
    return { ok: false, error: 'Only open pull requests are rebased.' };
  if (!resolutionConfigured(env))
    return {
      ok: false,
      error:
        'GitOrange does not rebase pull requests on this instance: rebase it locally.',
    };
  const tips = await rebaseTips(git, pr);
  if (!tips)
    return { ok: false, error: 'The pull request has no branch to rebase.' };
  const view = await rebaseView(env, db, git, pr, tips);
  if (view.status !== 'conflict')
    return {
      ok: false,
      error:
        view.status === 'resolving'
          ? `Nothing to retry: AI is resolving ${view.commit ? `commit ${sha7(view.commit)}` : 'a conflict'} now.`
          : view.status === 'behind'
            ? `Nothing to retry: GitOrange is rebasing it onto ${view.onto}.`
            : `Nothing to retry: it is up to date with ${view.onto}.`,
    };
  if (isNotRebased(view.error)) return { ok: false, error: view.error! };
  const now = new Date();
  const stop = and(
    eq(mergeResolutions.pullRequestId, pr.id),
    eq(mergeResolutions.baseSha, tips.onto),
    eq(mergeResolutions.headSha, tips.head),
    eq(mergeResolutions.status, 'failed'),
    rebaseRow('merge_resolutions'),
    or(
      isNull(mergeResolutions.errorMessage),
      and(
        notLike(mergeResolutions.errorMessage, `${NOT_REBASED}%`),
        ne(mergeResolutions.errorMessage, NOTHING_TO_MERGE)
      )
    )
  );
  const before = await db
    .select({ id: mergeResolutions.id, decidedAt: mergeResolutions.decidedAt })
    .from(mergeResolutions)
    .where(stop);
  const setAside = await db
    .update(mergeResolutions)
    .set({ status: 'rejected', decidedAt: now })
    .where(stop)
    .returning({ id: mergeResolutions.id });
  // Another retry set the stop aside first: it starts the run.
  if (setAside.length === 0)
    return { ok: false, error: 'A retry is already in progress.' };
  const started = await ensureRebase(env, db, git, pr);
  if (!started) {
    // No run started (one is still finishing, or it could not be created): put the stop back, as it was.
    const changed = new Set(setAside.map((r) => r.id));
    for (const r of before.filter((r) => changed.has(r.id)))
      await db
        .update(mergeResolutions)
        .set({ status: 'failed', decidedAt: r.decidedAt })
        .where(
          and(
            eq(mergeResolutions.id, r.id),
            eq(mergeResolutions.status, 'rejected')
          )
        );
    return {
      ok: false,
      error: 'A rebase run is still finishing; try again in a moment.',
    };
  }
  return {
    ok: true,
    view: await rebaseView(env, db, git, pr, tips),
    started,
  };
}

/**
 * Replaces the pull request's branch with the rebased head, compare-and-swap on the head it was rebased from (that ref
 * alone in the push), then keeps that head as its pre-rebase ref in a second, best-effort push. `moved`: the branch is
 * no longer where the rebase started (pushed, or deleted).
 */
export async function writeRebase(
  git: GitService,
  pr: Pick<PullRequest, 'number' | 'headRef'>,
  tips: RebaseTips,
  result: Extract<RebaseResult, { kind: 'done' }>
): Promise<'written' | 'moved'> {
  // From the remote: a cached listing may predate a push.
  const { refs } = await git.client.listRefs();
  const branch = `refs/heads/${pr.headRef}`;
  const now = refs.get(branch);
  // now === result.head: a retried step already pushed it.
  if (now !== result.head) {
    if (now !== tips.head) return 'moved';
    // Each object once (the engine dedupes too; a push must never carry a duplicate).
    const objects = [
      ...new Map(
        result.objects.map((o): [string, GitObject] => [o.sha, o])
      ).values(),
    ];
    try {
      await git.client.push(
        [{ ref: branch, old: tips.head, new: result.head }],
        objects
      );
    } catch (e) {
      if (e instanceof GitPushError) return 'moved';
      throw e;
    }
  }
  const pre = preRebaseRef(pr.number, tips.head);
  if (!refs.has(pre))
    try {
      // The old head's objects are already in the repository: nothing to send.
      await git.client.push([{ ref: pre, old: ZERO_SHA, new: tips.head }], []);
    } catch (e) {
      // Only a convenience for the agent: the rebase itself is written.
      console.warn('[rebase] could not keep the pre-rebase head', pre, e);
    }
  return 'written';
}

/** What a written rebase changed, small enough for a step result. */
export type Written = {
  from: string;
  to: string;
  ontoBranch: string;
  skipped: number;
  /** Commits whose conflicts AI resolved: original → rebased. */
  resolved: { original: string; rebased: string }[];
  /** Nothing needed resolving and every replayed commit makes the same change: the review carries over. */
  clean: boolean;
};

export function written(
  tips: RebaseTips,
  result: Extract<RebaseResult, { kind: 'done' }>
): Written {
  const resolved = result.commits
    .filter((c) => c.resolved)
    .map(({ original, rebased }) => ({ original, rebased }));
  return {
    from: tips.head,
    to: result.head,
    ontoBranch: tips.ontoBranch,
    skipped: result.skipped,
    resolved,
    clean: !resolved.length && result.samePatches,
  };
}

/**
 * The first thing after a rebase was written, before anything that can fail: Actions on the new head, as a push of the
 * branch queues them. Until its runs exist checksAt sees nothing to wait for, so a head whose runs were never queued
 * would land untested.
 */
export async function queueRebasedActions(
  env: CloudflareBindings,
  db: DrizzleDB,
  opts: { repo: Repository; repoFullName: string; pr: PullRequest; w: Written }
): Promise<void> {
  const { pr, w } = opts;
  await onRefsUpdated(
    env,
    db,
    opts.repo,
    opts.repoFullName,
    [{ ref: `refs/heads/${pr.headRef}`, old: w.from, new: w.to }],
    null
  );
}

/**
 * After a rebase was written and its Actions queued (queueRebasedActions): the `rebased` timeline event, the review and
 * approvals carried to the new head when the rebase was clean, then the sweep a push of the branch starts (review of
 * the new head unless carried; pull requests stacked on this branch rebase).
 */
export async function afterRebase(
  env: CloudflareBindings,
  db: DrizzleDB,
  opts: { repo: Repository; repoFullName: string; pr: PullRequest; w: Written }
): Promise<{ carried: boolean }> {
  const { repo, pr, w } = opts;
  await recordEvent(db, {
    id: `rebased:${pr.id}:${w.to}`,
    repositoryId: pr.repositoryId,
    pullRequestId: pr.id,
    kind: 'rebased',
    data: {
      from: w.from,
      to: w.to,
      onto: w.ontoBranch,
      skipped: w.skipped,
      resolved: w.resolved.length,
    },
  });
  // The resolutions the written rebase used.
  for (const c of w.resolved)
    await db
      .update(mergeResolutions)
      .set({ status: 'applied', resultSha: c.rebased })
      .where(
        and(
          eq(mergeResolutions.pullRequestId, pr.id),
          eq(mergeResolutions.headSha, w.from),
          eq(mergeResolutions.commitSha, c.original),
          eq(mergeResolutions.status, 'resolved')
        )
      );
  // A clean rebase keeps the review; otherwise the sweep below starts a fresh one for the new head. The carry is one
  // batch: if it fails nothing moved, and the sweep (which this step must still reach) reviews the new head.
  let carried = false;
  if (w.clean)
    try {
      carried = await carryReview(db, pr, w.from, w.to);
    } catch (e) {
      console.error('[rebase] could not carry the review', pr.id, e);
    }
  const update = { ref: `refs/heads/${pr.headRef}`, old: w.from, new: w.to };
  await startSweep(env, repo, [update]);
  await publishChange(env, pr.repositoryId, { approvals: true });
  return { carried };
}

export interface RebaseDeps {
  env: CloudflareBindings;
  db: DrizzleDB;
  step: StepRunner;
  /** The AI resolver of one conflicting commit's attempt (commit-resolution.ts resolverName); absent without AI. */
  resolver?: (resolutionId: string) => ConflictResolverApi;
  /** The Workflow instance id (also its agent run's id), so a requeue doesn't wait on this very run. */
  instanceId?: string;
}

type Job = {
  pullRequestId: string;
  repositoryId: string;
  fullName: string;
  timestamp: number;
};

/** A replay's outcome, small for a step result. */
export type Replay =
  | { kind: 'gone' }
  | { kind: 'up_to_date' }
  | { kind: 'done' }
  /** Every commit was skipped: the base already has all of it. */
  | { kind: 'empty' }
  | { kind: 'too_many'; count: number }
  | {
      kind: 'conflict';
      commit: string;
      paths: string[];
      textual: boolean;
      generated: string[];
    };

/** The pull request (open, unless `open` is false) and its repository, read afresh. */
async function context(
  env: CloudflareBindings,
  db: DrizzleDB,
  id: string,
  open = true
) {
  const pr = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.id, id))
    .get();
  if (!pr || (open && pr.state !== 'open')) return null;
  const found = await findRepoById(db, pr.repositoryId);
  return found
    ? {
        pr,
        repo: found.repo,
        fullName: `${found.namespace.username}/${found.repo.name}`,
        git: gitFor(env, found.repo),
      }
    : null;
}

/** Rebases one pull request (MERGE_RESOLUTION payload `{ rebase: { pullRequestId } }`). */
export async function executeRebase(
  deps: RebaseDeps,
  params: RebaseParams
): Promise<void> {
  const { env, db } = deps;
  const job = await deps.step.do('load', async (): Promise<Job | null> => {
    const ctx = await context(env, db, params.pullRequestId);
    if (!ctx) return null;
    return {
      pullRequestId: ctx.pr.id,
      repositoryId: ctx.pr.repositoryId,
      fullName: ctx.fullName,
      // One committer date for the run: a replayed step rebuilds the same commits.
      timestamp: Math.floor(Date.now() / 1000),
    };
  });
  if (!job) return;
  const step = pingingSteps(env, deps.step, job.repositoryId, {
    approvals: true,
  });
  let last: Attempt = { outcome: 'done', tips: null };
  for (let attempt = 0; attempt < MAX_REBASE_ATTEMPTS; attempt++) {
    last = await rebaseAttempt(deps, step, job, attempt);
    if (last.outcome !== 'moved') break;
  }
  // A written rebase starts a sweep of its own branch, which covers whatever moved since. Any other end (a stop,
  // nothing to do, the branch kept moving) may have swallowed a move that came while this run was running: a
  // sweep's ensureRebase skipped this PR because this run was. Once per run end: if the tips moved, queue another.
  if (last.outcome === 'written') return;
  const before = last.tips;
  await step.do('requeue', async () => {
    const ctx = await context(env, db, job.pullRequestId);
    if (!ctx) return false;
    const now = await rebaseTips(ctx.git, ctx.pr);
    if (
      !now ||
      (before && now.onto === before.onto && now.head === before.head)
    )
      return false;
    return ensureRebase(env, db, ctx.git, ctx.pr, {
      ignoreRun: deps.instanceId,
    });
  });
}

/** How one attempt ended, and the tips it rebased between (null: the PR or a branch was gone). */
type Attempt = {
  outcome: 'written' | 'moved' | 'done';
  tips: RebaseTips | null;
};

async function rebaseAttempt(
  deps: RebaseDeps,
  step: StepRunner,
  job: Job,
  attempt: number
): Promise<Attempt> {
  const { env, db } = deps;
  const committer: Signature = {
    ...REBASE_COMMITTER,
    timestamp: job.timestamp,
  };
  const tips = await step.do(`tips:${attempt}`, async () => {
    const ctx = await context(env, db, job.pullRequestId);
    return ctx ? rebaseTips(ctx.git, ctx.pr) : null;
  });
  if (!tips) return { outcome: 'done', tips: null };
  for (let k = 0; ; k++) {
    const r = await step.do(
      `replay:${attempt}:${k}`,
      async (): Promise<Replay> => {
        const ctx = await context(env, db, job.pullRequestId);
        if (!ctx) return { kind: 'gone' };
        const result = await rebaseAt(ctx.git, db, ctx.pr, tips, committer);
        if (result.kind === 'too_many')
          return { kind: 'too_many', count: result.count };
        if (result.kind === 'done' && !result.commits.length)
          return { kind: 'empty' };
        if (result.kind !== 'conflict') return { kind: result.kind };
        return {
          kind: 'conflict',
          commit: result.commit.hash,
          paths: result.conflicts,
          textual: result.files.length === result.conflicts.length,
          generated: await generatedConflicts(
            ctx.git,
            tips.onto,
            result.conflicts
          ),
        };
      }
    );
    if (r.kind === 'gone' || r.kind === 'up_to_date')
      return { outcome: 'done', tips };
    if (r.kind === 'done') break;
    if (r.kind === 'empty') {
      // Rewriting the branch to the base's tip would leave a pull request with nothing in it: leave it alone.
      await step.do(`stop:${attempt}:${k}`, () =>
        recordStop(db, job.pullRequestId, tips, {
          commit: null,
          paths: [],
          error: NOTHING_TO_MERGE,
        })
      );
      return { outcome: 'done', tips };
    }
    if (r.kind === 'too_many') {
      await step.do(`stop:${attempt}:${k}`, () =>
        recordStop(db, job.pullRequestId, tips, {
          commit: null,
          paths: [],
          error: stopMessage.tooMany(r.count),
        })
      );
      return { outcome: 'done', tips };
    }
    if ((await onConflict(deps, step, job, tips, r, attempt, k)) === 'stop')
      return { outcome: 'done', tips };
  }
  const out = await step.do(
    `write:${attempt}`,
    async (): Promise<
      | { kind: 'written'; w: Written }
      | { kind: 'moved' }
      | { kind: 'stale' }
      | { kind: 'blocked'; error: string }
    > => {
      const ctx = await context(env, db, job.pullRequestId);
      if (!ctx) return { kind: 'stale' };
      // Checked again: another pull request may have opened on this head, or the default branch changed.
      const blocked = await rebaseBlocked(db, ctx.pr);
      if (blocked)
        return {
          kind: 'blocked',
          error: await recordStop(db, ctx.pr.id, tips, {
            commit: null,
            paths: [],
            error: blocked,
          }),
        };
      const result = await rebaseAt(ctx.git, db, ctx.pr, tips, committer);
      if (result.kind !== 'done' || !result.commits.length)
        return { kind: 'stale' };
      return (await writeRebase(ctx.git, ctx.pr, tips, result)) === 'moved'
        ? { kind: 'moved' }
        : { kind: 'written', w: written(tips, result) };
    }
  );
  if (out.kind === 'moved') return { outcome: 'moved', tips };
  if (out.kind !== 'written') return { outcome: 'done', tips };
  // Actions first, in a step of their own (retried): whatever happens to the rest, the new head has its runs to wait on.
  await step.do(`actions:${attempt}`, async () => {
    const ctx = await context(env, db, job.pullRequestId, false);
    if (!ctx) return false;
    await queueRebasedActions(env, db, {
      repo: ctx.repo,
      repoFullName: job.fullName,
      pr: ctx.pr,
      w: out.w,
    });
    return true;
  });
  const after = await step.do(`after:${attempt}`, ONCE, async () => {
    const ctx = await context(env, db, job.pullRequestId, false);
    if (!ctx) return { carried: false };
    return afterRebase(env, db, {
      repo: ctx.repo,
      repoFullName: job.fullName,
      pr: ctx.pr,
      w: out.w,
    });
  });
  // A carried review ends no review run, which would check auto-merge: check here (as a review's last step does), so a
  // pull request with no Actions to wait on doesn't sit approved.
  if (after.carried)
    await step.do(`auto-merge:${attempt}`, async () => {
      await maybeAutoMerge(env, db, job.pullRequestId);
      return true;
    });
  return { outcome: 'written', tips };
}

/**
 * A commit's replay conflicted. AI resolves text conflicts outside generated files (one resolution per commit, at most
 * MAX_AI_COMMITS a run); anything else, or AI failing, stops the rebase for the agent.
 */
async function onConflict(
  deps: RebaseDeps,
  step: StepRunner,
  job: Job,
  tips: RebaseTips,
  r: Extract<Replay, { kind: 'conflict' }>,
  attempt: number,
  k: number
): Promise<'continue' | 'stop'> {
  const { env, db, resolver } = deps;
  const why = !r.textual
    ? stopMessage.notText(r.commit, r.paths)
    : r.generated.length
      ? stopMessage.generated(r.commit, r.generated)
      : !resolver
        ? stopMessage.noAi(r.commit, r.paths)
        : k >= MAX_AI_COMMITS
          ? stopMessage.tooManyConflicts(r.commit, r.paths)
          : null;
  if (why || !resolver) {
    await step.do(`stop:${attempt}:${k}`, () =>
      recordStop(db, job.pullRequestId, tips, {
        commit: r.commit,
        paths: r.paths,
        error: why!,
      })
    );
    return 'stop';
  }
  const claimed = await step.do(`claim:${attempt}:${k}`, () =>
    claimResolution(env, db, job.pullRequestId, tips, r)
  );
  if (claimed.status === 'resolved' || claimed.status === 'applied')
    return 'continue';
  // A failed row at this commit (an earlier stop or AI failure at these tips): the agent's move. Re-recorded, so it is
  // the pull request's latest outcome again (a row at other tips may be newer: the agent pushed back an older head).
  if (claimed.status !== 'running') {
    await step.do(`stop:${attempt}:${k}`, async () => {
      const had = await db
        .select({ error: mergeResolutions.errorMessage })
        .from(mergeResolutions)
        .where(eq(mergeResolutions.id, claimed.id))
        .get();
      return recordStop(db, job.pullRequestId, tips, {
        commit: r.commit,
        paths: r.paths,
        error: had?.error ?? stopMessage.noAi(r.commit, r.paths),
      });
    });
    return 'stop';
  }
  try {
    const out = await step.do(
      `resolve:${sha7(r.commit)}:${attempt}`,
      RESOLVE_RETRIES,
      () => resolveCommit({ env, db, resolver }, claimed.id)
    );
    return out.status === 'resolved' ? 'continue' : 'stop';
  } catch (e) {
    console.error('[rebase] resolution failed', claimed.id, e);
    await step.do(`fail:${attempt}:${k}`, () =>
      failResolution(db, claimed.id, MODEL_UNREACHABLE)
    );
    return 'stop';
  }
}

export type RebaseStatus =
  'nothing_to_merge' | 'up_to_date' | 'behind' | 'resolving' | 'conflict';
export type RebaseView = {
  status: RebaseStatus;
  /** The branch it rebases onto. */
  onto: string;
  /** The commit being resolved, or where the rebase stopped; null when it stopped before any. */
  commit: string | null;
  files: string[];
  error: string | null;
};

/**
 * Where an open pull request stands against its base: nothing to merge (the base has it all, by ancestry or as a
 * rebase run found), up to date, behind (GitOrange rebases it, and landing does too), resolving (AI is resolving a
 * commit), or a conflict for the agent. Where no rebase runs (no
 * MERGE_RESOLUTION binding), a dry run says whether landing's rebase would stop.
 */
export async function rebaseView(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: Pick<PullRequest, 'id' | 'repositoryId' | 'headRef' | 'baseRef'>,
  tips: RebaseTips
): Promise<RebaseView> {
  const view = {
    onto: tips.ontoBranch,
    commit: null,
    files: [] as string[],
    error: null,
  };
  if ((await contains(git, tips.head, tips.onto)) === true)
    return { ...view, status: 'nothing_to_merge' };
  if ((await contains(git, tips.onto, tips.head)) === true)
    return { ...view, status: 'up_to_date' };
  // A branch GitOrange doesn't rewrite: why, whatever was recorded (a lifted block's row is ignored below).
  const blocked = await rebaseBlocked(db, pr);
  if (blocked) return { ...view, status: 'conflict', error: blocked };
  const row = await latestResolution(db, pr.id);
  // The real outcome at these tips (latestResolution never returns a "not rebased" row).
  if (row && row.baseSha === tips.onto && row.headSha === tips.head) {
    // A per-commit resolution (a squash-era row, commit_sha NULL, is never resumed).
    if (
      (row.status === 'running' || row.status === 'resolved') &&
      row.commitSha
    )
      return {
        ...view,
        status: 'resolving',
        commit: row.commitSha,
        files: row.conflictedPaths,
      };
    if (row.status === 'failed' && row.errorMessage === NOTHING_TO_MERGE)
      return { ...view, status: 'nothing_to_merge' };
    if (row.status === 'failed' && row.errorMessage !== SUPERSEDED)
      return {
        ...view,
        status: 'conflict',
        commit: row.commitSha,
        files: row.conflictedPaths,
        error: row.errorMessage,
      };
  }
  if (!resolutionConfigured(env)) {
    const dry = await rebaseAt(git, db, pr, tips, {
      ...REBASE_COMMITTER,
      timestamp: 0,
    });
    if (dry.kind === 'done' && !dry.commits.length)
      return { ...view, status: 'nothing_to_merge' };
    if (dry.kind === 'too_many')
      return {
        ...view,
        status: 'conflict',
        error: stopMessage.tooMany(dry.count),
      };
    if (dry.kind === 'conflict')
      return {
        ...view,
        status: 'conflict',
        commit: dry.commit.hash,
        files: dry.conflicts,
        error: stopMessage.noAi(dry.commit.hash, dry.conflicts),
      };
  }
  return { ...view, status: 'behind' };
}
