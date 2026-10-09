import { and, desc, eq, gte, sql } from 'drizzle-orm';
import {
  pullRequests,
  workflowRuns,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import type { Commit, GitService } from '../git/service';
import { latestStates } from '../pulls/events';
import { pullStates } from '../pulls/signals';
import type { PullState } from '../pulls/state';
import { reviewConfigured } from '../review/head';
import { recordAudit } from './audit';
import { usersByCommitEmail } from './commit-authors';
import { landTargetIs, landTargetOf } from './land-target';
import { GHOST, personRefs, type PersonRef } from './person-ref';
import { pullRef } from '../merge/land';
import { protectedBy } from './protected-branches';
import { pullSessionIds } from './sessions';

// Branches: the list with each branch's pull request, the merged branches nobody deleted (and their clean-up), and the
// branch map, which draws the default branch, what landed on it, and the branches in flight.

const DAY = 86_400_000;

export type BranchInfo = {
  name: string;
  sha: string;
  isDefault: boolean;
  /** The default branch is always protected; so is any branch matching `repositories.protected_branches`. */
  isProtected: boolean;
  /** When the tip commit was committed, epoch milliseconds; null when it can't be read. */
  updatedAt: number | null;
  /** Who made it: whoever opened its pull request, else the member whose email is on the tip commit. */
  author: PersonRef | null;
  /** The branch's newest pull request (by head branch), whatever its state. */
  pull: {
    number: number;
    title: string;
    state: 'open' | 'closed' | 'merged';
    pullState: PullState | null;
    createdVia: string | null;
    session: string | null;
    /** The id `GET /sessions` gives its session; never null (a pull request by hand is its author's session). */
    sessionId: string;
  } | null;
  mergedNotDeleted: boolean;
};

// ── Which branches are merged, not deleted ───────────────────────────────────

type Tip = { name: string; sha: string };

/** What the branch list and the clean-up both read: the tips, each branch's newest pull request, what is in use. */
async function branchPulls(db: DrizzleDB, git: GitService, repo: Repository) {
  const refs = await git.refs();
  const tips: Tip[] = [...refs]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), sha }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // The newest pull request (highest number) of each branch that still exists, and no older ones.
  const names = JSON.stringify(tips.map((t) => t.name));
  const rows = tips.length
    ? await db
        .select()
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repositoryId, repo.id),
            sql`${pullRequests.headRef} IN (SELECT value FROM json_each(${names}))`,
            sql`${pullRequests.number} = (SELECT MAX(p2.number) FROM pull_requests p2 WHERE p2.repository_id = ${pullRequests.repositoryId} AND p2.head_ref = ${pullRequests.headRef})`
          )
        )
        .all()
    : [];
  const newest = new Map<string, PullRequest>(
    rows.map((pr) => [pr.headRef, pr])
  );

  // A branch an open pull request builds on, merges into or comes from is in use (as merge/land.ts keeps it too).
  const open = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repo.id),
        eq(pullRequests.state, 'open')
      )
    )
    .all();
  const inUse = new Set(
    open.flatMap((pr) => [pr.baseRef, pr.headRef, landTargetOf(pr)])
  );

  /** Whether `tip` is a branch Clean up may delete: its newest pull request landed, and nothing else needs it. */
  const mergedNotDeleted = (tip: Tip): boolean => {
    if (tip.name === repo.defaultBranch) return false;
    if (protectedBy(repo.protectedBranches, tip.name)) return false;
    const pr = newest.get(tip.name);
    if (!pr || pr.state !== 'merged' || inUse.has(tip.name)) return false;
    return unchangedSinceMerge(pr, tip.sha);
  };

  /**
   * Whether the branch still ends where its pull request landed it: anything past that was pushed since, and never
   * merged, so Clean up must not delete it. Needs evidence, and with none the answer is no:
   *  - landed by fast-forward (`landed_commits` set): the tip is the landed head, `merge_commit_sha`;
   *  - landed before that (squash or merge commit, `landed_commits` null): the merge pinned the head it merged at
   *    `refs/pull/<n>/head` and nothing moves that pin afterwards, so the tip must still be it.
   */
  const unchangedSinceMerge = (pr: PullRequest, tip: string): boolean =>
    pr.landedCommits !== null
      ? pr.mergeCommitSha !== null && tip === pr.mergeCommitSha
      : refs.get(pullRef(pr.number)) === tip;

  return { refs, tips, newest, open, mergedNotDeleted };
}

/** The pull requests' states, batched; null when they can't be computed. */
async function statesOf(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  repo: Repository,
  prs: PullRequest[],
  refs: Map<string, string>
): Promise<Map<string, PullState> | null> {
  if (!prs.length) return new Map();
  try {
    return await pullStates(db, git, repo.id, prs, {
      refs,
      reviewConfigured: reviewConfigured(env),
    });
  } catch (e) {
    console.error('[branches] could not compute pull states', repo.id, e);
    return null;
  }
}

/** Runs `fn` over `items`, at most `limit` at a time; results in order. */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++)
        out[i] = await fn(items[i]);
    })
  );
  return out;
}

/** Tip commits read from Artifacts at once. */
const CONCURRENT_COMMITS = 6;

/**
 * Every branch with its newest pull request, whether it is merged and not deleted, and who made it. Reads D1 in a
 * fixed number of queries and the refs once; the tip commits (for `updatedAt`, and an author where there is no pull
 * request) a few at a time. A tip that can't be read has a null `updatedAt` and author.
 */
export async function branchInfos(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  repo: Repository
): Promise<BranchInfo[]> {
  const { refs, tips, newest, mergedNotDeleted } = await branchPulls(
    db,
    git,
    repo
  );
  const states =
    (await statesOf(
      env,
      db,
      git,
      repo,
      [...newest.values()].filter((p) => p.state === 'open'),
      refs
    )) ?? new Map<string, PullState>();
  const commits = await pool(tips, CONCURRENT_COMMITS, (t) =>
    git.commit(t.sha).catch((e) => {
      console.warn('[branches] could not read a tip', repo.id, t.name, e);
      return null as Commit | null;
    })
  );

  // The member behind a tip commit's email, only for branches with no pull request to say who made them.
  const byEmail = await usersByCommitEmail(
    db,
    tips.flatMap((t, i) =>
      !newest.has(t.name) && commits[i] ? [commits[i]!.author.email] : []
    )
  );
  const [people, sessionIds] = await Promise.all([
    personRefs(db, [
      ...[...newest.values()].map((p) => p.authorId),
      ...[...byEmail.values()].map((u) => u.id),
    ]),
    pullSessionIds([...newest.values()]),
  ]);

  return tips.map((t, i): BranchInfo => {
    const pr = newest.get(t.name);
    const commit = commits[i];
    const viaEmail = commit
      ? byEmail.get(commit.author.email.trim().toLowerCase())
      : undefined;
    return {
      name: t.name,
      sha: t.sha,
      isDefault: t.name === repo.defaultBranch,
      isProtected:
        t.name === repo.defaultBranch ||
        protectedBy(repo.protectedBranches, t.name) !== null,
      updatedAt: commit ? commit.committedAt * 1000 : null,
      author: pr
        ? (people.get(pr.authorId) ?? GHOST)
        : viaEmail
          ? (people.get(viaEmail.id) ?? null)
          : null,
      pull: pr
        ? {
            number: pr.number,
            title: pr.title,
            state: pr.state,
            pullState: pr.state === 'open' ? (states.get(pr.id) ?? null) : null,
            createdVia: pr.createdVia || null,
            session: pr.sessionLabel || null,
            sessionId: sessionIds.get(pr.id)!,
          }
        : null,
      mergedNotDeleted: mergedNotDeleted(t),
    };
  });
}

/** The branches that are merged and not deleted, with the pull request that merged each. */
function leftoverOf({
  tips,
  newest,
  mergedNotDeleted,
}: Awaited<ReturnType<typeof branchPulls>>) {
  return tips
    .filter(mergedNotDeleted)
    .map((t) => ({ name: t.name, sha: t.sha, pull: newest.get(t.name)! }));
}

/**
 * Deletes every merged, not deleted branch (never the default branch, a protected one, or one an open pull request
 * uses), each with compare-and-swap on the tip it was read at, so a branch someone pushed to since is kept. Records one
 * `branches.cleaned` audit row naming them and the tip each had; nothing when none were deleted. Returns the names
 * deleted.
 */
export async function cleanBranches(
  db: DrizzleDB,
  git: GitService,
  repo: Repository,
  actorId: string
): Promise<string[]> {
  const deleted: string[] = [];
  // Each deleted branch's tip, so a branch deleted by mistake can be put back from the audit log.
  const shas: Record<string, string> = {};
  // One at a time: a refused deletion (the branch moved) must not stop, or hide, the others.
  for (const b of leftoverOf(await branchPulls(db, git, repo))) {
    try {
      await git.deleteBranch(b.name, b.sha);
      deleted.push(b.name);
      shas[b.name] = b.sha;
    } catch (e) {
      console.warn('[branches] could not delete', repo.id, b.name, e);
    }
  }
  if (deleted.length)
    await recordAudit(db, {
      repositoryId: repo.id,
      actorId,
      action: 'branches.cleaned',
      target: `${deleted.length} ${deleted.length === 1 ? 'branch' : 'branches'}`,
      data: { branches: deleted, shas },
    });
  return deleted;
}

// ── The branch map ───────────────────────────────────────────────────────────

export const MAP_DAYS_DEFAULT = 10;
export const MAP_DAYS_MAX = 30;

export type MainStatus = 'passing' | 'failing' | 'running' | 'unknown';

export type BranchMap = {
  from: number;
  to: number;
  main: {
    name: string;
    status: MainStatus;
    landings: { number: number; title: string; at: number; sha: string }[];
  };
  open: {
    branch: string;
    number: number;
    title: string;
    openedAt: number;
    state: 'agent_followup' | 'human_review' | 'waiting' | 'ready';
    reasons: string[];
    author: PersonRef;
    createdVia: string | null;
    session: string | null;
    /** The id `GET /sessions` gives its session; never null (a pull request by hand is its author's session). */
    sessionId: string;
    stackedOn: number | null;
  }[];
  leftover: { branch: string; number: number; mergedAt: number }[];
};

/**
 * Whether the default branch's checks pass: from the newest commit pushed to it that Actions ran for, the latest run
 * of each workflow (a re-run replaces the run before it). Failed or cancelled if any is, else running if any hasn't
 * finished, else passing. `unknown` when no run has happened on the branch.
 */
export async function mainStatus(
  db: DrizzleDB,
  repo: Repository
): Promise<MainStatus> {
  const runs = await db
    .select({
      runNumber: workflowRuns.runNumber,
      workflowPath: workflowRuns.workflowPath,
      headSha: workflowRuns.headSha,
      status: workflowRuns.status,
      conclusion: workflowRuns.conclusion,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.repositoryId, repo.id),
        eq(workflowRuns.event, 'push'),
        eq(workflowRuns.ref, `refs/heads/${repo.defaultBranch}`)
      )
    )
    .orderBy(desc(workflowRuns.runNumber))
    .limit(50)
    .all();
  if (!runs.length) return 'unknown';
  const sha = runs[0].headSha;
  const latest = new Map<string, (typeof runs)[number]>();
  for (const r of runs)
    if (r.headSha === sha && !latest.has(r.workflowPath))
      latest.set(r.workflowPath, r);
  const now = [...latest.values()];
  if (
    now.some(
      (r) =>
        r.status === 'completed' &&
        (r.conclusion === 'failure' || r.conclusion === 'cancelled')
    )
  )
    return 'failing';
  if (now.some((r) => r.status !== 'completed')) return 'running';
  return 'passing';
}

/**
 * The model behind the branch map, for the last `days` days: what landed on the default branch, the open pull requests
 * into it (with whose move it is and, for a stacked one, the pull request it builds on), and the merged branches
 * nobody deleted. Pull requests whose head branch is gone are left out, as `pullStates` leaves them out.
 */
export async function branchMap(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  repo: Repository,
  days: number,
  now = Date.now()
): Promise<BranchMap> {
  const from = now - days * DAY;
  const target = landTargetIs(repo.defaultBranch);

  const [landed, status, pulls] = await Promise.all([
    db
      .select({
        number: pullRequests.number,
        title: pullRequests.title,
        mergedAt: pullRequests.mergedAt,
        updatedAt: pullRequests.updatedAt,
        mergeCommitSha: pullRequests.mergeCommitSha,
      })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repo.id),
          eq(pullRequests.state, 'merged'),
          target,
          gte(pullRequests.mergedAt, new Date(from))
        )
      )
      .orderBy(pullRequests.mergedAt, pullRequests.number)
      .all(),
    mainStatus(db, repo),
    branchPulls(db, git, repo),
  ]);
  const { refs, open } = pulls;
  const leftover = leftoverOf(pulls);

  const intoMain = open
    .filter((p) => landTargetOf(p) === repo.defaultBranch)
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() || a.number - b.number
    );
  // Computed now; when that fails, the states last recorded.
  const states =
    (await statesOf(env, db, git, repo, intoMain, refs)) ??
    (await latestStates(
      db,
      intoMain.map((p) => p.id)
    ).catch(() => new Map<string, PullState>()));

  const [people, sessionIds] = await Promise.all([
    personRefs(
      db,
      intoMain.map((p) => p.authorId)
    ),
    pullSessionIds(intoMain),
  ]);
  // A stacked pull request's base is another open pull request's head branch.
  const opened = (base: string, landsOn: string) => {
    const candidates = open.filter((p) => p.headRef === base);
    return candidates.find((p) => landTargetOf(p) === landsOn) ?? candidates[0];
  };

  return {
    from,
    to: now,
    main: {
      name: repo.defaultBranch,
      status,
      landings: landed.map((p) => ({
        number: p.number,
        title: p.title,
        at: (p.mergedAt ?? p.updatedAt).getTime(),
        sha: p.mergeCommitSha ?? '',
      })),
    },
    open: intoMain.flatMap((p) => {
      const state = states.get(p.id);
      if (!state) return [];
      const parent =
        p.baseRef === landTargetOf(p)
          ? undefined
          : opened(p.baseRef, landTargetOf(p));
      return [
        {
          branch: p.headRef,
          number: p.number,
          title: p.title,
          openedAt: p.createdAt.getTime(),
          state: state.state,
          reasons: state.reasons.map((r) => r.kind),
          author: people.get(p.authorId) ?? GHOST,
          createdVia: p.createdVia || null,
          session: p.sessionLabel || null,
          sessionId: sessionIds.get(p.id)!,
          stackedOn: parent && parent.id !== p.id ? parent.number : null,
        },
      ];
    }),
    leftover: leftover
      .map((b) => ({
        branch: b.name,
        number: b.pull.number,
        mergedAt: (b.pull.mergedAt ?? b.pull.updatedAt).getTime(),
      }))
      .sort((a, b) => a.mergedAt - b.mergedAt || a.number - b.number),
  };
}
