import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { DrizzleDB } from '../db/middleware';
import {
  agents,
  mergeResolutions,
  prClassifications,
  prEdges,
  prReviewers,
  prReviewFlags,
  pullRequests,
  type PullRequest,
  type Repository,
  type ReviewerStatus,
} from '../db/app.schema';
import { NO_MODEL, SUPERSEDED } from '../merge/resolution';
import { latestStates } from '../pulls/events';
import type { PullState } from '../pulls/state';
import { findReposByIds, gitFor, permissionsForMany } from '../lib/repos';
import { personRefs } from '../lib/person-ref';
import { pullSessionIds } from '../lib/sessions';
import { usersById, type PublicUser } from '../lib/users';
import { chunks } from '../stack/view';
import type { SessionUser } from '../variables';
import { flagJson } from './reviewers-view';

/** The latest row per pull request, from rows sorted newest first. */
function latestPer<T extends { pullRequestId: string }>(rows: T[]) {
  const out = new Map<string, T>();
  for (const r of rows)
    if (!out.has(r.pullRequestId)) out.set(r.pullRequestId, r);
  return out;
}

/**
 * Each pull request's head: its branch tip, refs read once per repository (`repos` holds every repository the
 * pull requests are in). A pull request whose branch is gone has no head; `unreadable` holds the repositories
 * whose refs couldn't be read (callers fall back to the newest head review there).
 */
export async function branchTips(
  env: CloudflareBindings,
  repos: Map<string, Repository>,
  pulls: PullRequest[]
): Promise<{ heads: Map<string, string>; unreadable: Set<string> }> {
  const heads = new Map<string, string>();
  const unreadable = new Set<string>();
  const refsOf = new Map<string, Map<string, string>>();
  await Promise.all(
    [...new Set(pulls.map((p) => p.repositoryId))].map(async (id) => {
      const repo = repos.get(id);
      const refs = repo
        ? await gitFor(env, repo)
            .refs()
            .catch(() => null)
        : null;
      if (refs) refsOf.set(id, refs);
      else unreadable.add(id);
    })
  );
  for (const p of pulls) {
    const sha = refsOf.get(p.repositoryId)?.get(`refs/heads/${p.headRef}`);
    if (sha) heads.set(p.id, sha);
  }
  return { heads, unreadable };
}

/** A must-account-for block with no change for this long shows on Approvals. */
const STALE_MS = 24 * 3600 * 1000;

/** D1 binds at most 100 parameters per statement. */
const CHUNK = 90;

/** Where a page ends: the last item's pull request (`updatedAt` in ms, id). */
export type ApprovalsCursor = { updatedAt: number; id: string };

export function encodeCursor(c: ApprovalsCursor) {
  return btoa(`${c.updatedAt}:${c.id}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** The cursor in an opaque string, or null when it isn't one. */
export function decodeCursor(s: string): ApprovalsCursor | null {
  let text: string;
  try {
    text = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  const m = /^(\d{1,15}):(.+)$/.exec(text);
  return m ? { updatedAt: Number(m[1]), id: m[2] } : null;
}

/** Newest first, then by id: whether `a` comes before `b`. */
const before = (a: ApprovalsCursor, b: ApprovalsCursor) =>
  a.updatedAt !== b.updatedAt ? a.updatedAt > b.updatedAt : a.id > b.id;

/**
 * Items waiting on a person in repositories the user can merge in: agents' findings for a person (grouped
 * by agent), failed agent reviews, failed or discarded AI conflict resolutions, pull requests that need a
 * person's approval, and stack items. One page of them, newest first: the list of visible items is built
 * cheaply in full (so `count` and the cursor hold after permission filtering), and only the page's items get
 * authors and flag titles. `count` is how many things wait on the user over all items: each unapproved
 * finding for a person, failed review and failed resolution, and each other pull request in Requires Human Review.
 */
export async function approvalsFor(
  env: CloudflareBindings,
  db: DrizzleDB,
  user: SessionUser,
  opts: { limit: number; cursor: ApprovalsCursor | null }
) {
  const open = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.state, 'open'))
    .orderBy(desc(pullRequests.updatedAt))
    .all();
  if (!open.length)
    return { items: [], count: 0, assignedToMe: 0, nextCursor: null };
  // Only repositories the user can merge in (approving and retrying need it) are read any further.
  const repos = new Map<
    string,
    { repo: Repository; fullName: string; canMerge: boolean }
  >();
  for (const part of chunks(
    [...new Set(open.map((p) => p.repositoryId))],
    CHUNK
  )) {
    const found = await findReposByIds(db, part);
    const perms = await permissionsForMany(
      db,
      [...found.values()].map((f) => f.repo),
      user
    );
    for (const [repoId, f] of found)
      repos.set(repoId, {
        repo: f.repo,
        fullName: `${f.namespace.username}/${f.repo.name}`,
        canMerge: perms.get(repoId)!.write,
      });
  }
  const openIds = new Set(open.map((p) => p.id));
  const mergeable = open.filter((p) => repos.get(p.repositoryId)?.canMerge);
  if (!mergeable.length)
    return { items: [], count: 0, assignedToMe: 0, nextCursor: null };
  const ids = mergeable.map((p) => p.id);
  const reviewRows: (typeof prClassifications.$inferSelect)[] = [];
  const resolutionRows: (typeof mergeResolutions.$inferSelect)[] = [];
  for (const part of chunks(ids, CHUNK)) {
    reviewRows.push(
      ...(await db
        .select()
        .from(prClassifications)
        .where(inArray(prClassifications.pullRequestId, part))
        .orderBy(desc(prClassifications.createdAt))
        .all())
    );
    resolutionRows.push(
      ...(await db
        .select()
        .from(mergeResolutions)
        .where(inArray(mergeResolutions.pullRequestId, part))
        .orderBy(desc(mergeResolutions.createdAt))
        .all())
    );
  }
  // Each pull request's head is its branch tip, refs read once per repository; its review is that commit's (a
  // branch back on an older reviewed commit shows that review, never the newest row).
  const tips = await branchTips(
    env,
    new Map([...repos].map(([id, r]) => [id, r.repo])),
    mergeable
  );
  // Where refs can't be read, the newest head review stands in (chunks split by pull request: newest first).
  const newest = latestPer(reviewRows);
  const headOf = new Map(tips.heads);
  for (const pr of mergeable) {
    const fallback = newest.get(pr.id);
    if (tips.unreadable.has(pr.repositoryId) && fallback)
      headOf.set(pr.id, fallback.headSha);
  }
  const reviews = new Map<string, (typeof reviewRows)[number]>();
  const byId = new Map(reviewRows.map((r) => [r.id, r]));
  for (const pr of mergeable) {
    const head = headOf.get(pr.id);
    const review = head && byId.get(`${pr.id}-${head}`);
    if (review) reviews.set(pr.id, review);
  }
  // Chunks split by pull request, so each one's rows stay newest first.
  const resolutions = latestPer(resolutionRows);
  const recorded = await latestStates(db, ids);
  // Each latest review's requested agents that still count (invited) and wait on a person: failed, or with
  // findings for a person. Change requests are the pull request's agent's to act on, so they aren't listed.
  type Group = {
    reviewerId: string;
    agentId: string;
    status: ReviewerStatus;
    error: string | null;
  };
  const groupsOf = new Map<string, Group[]>();
  for (const part of chunks(ids, CHUNK))
    for (const r of await db
      .select({
        reviewerId: prReviewers.id,
        pullRequestId: prReviewers.pullRequestId,
        headSha: prReviewers.headSha,
        agentId: prReviewers.agentId,
        status: prReviewers.status,
        error: prReviewers.error,
      })
      .from(prReviewers)
      .innerJoin(pullRequests, eq(pullRequests.id, prReviewers.pullRequestId))
      .where(
        and(
          inArray(prReviewers.pullRequestId, part),
          eq(prReviewers.requested, true),
          inArray(prReviewers.status, [
            'failed',
            'flagged',
            'changes_requested',
          ]),
          sql`EXISTS (SELECT 1 FROM repository_agents ra WHERE ra.repository_id = ${pullRequests.repositoryId} AND ra.agent_id = ${prReviewers.agentId})`
        )
      )
      .all())
      if (reviews.get(r.pullRequestId)?.headSha === r.headSha)
        groupsOf.set(r.pullRequestId, [
          ...(groupsOf.get(r.pullRequestId) ?? []),
          r,
        ]);
  const flagsOf = new Map<string, (typeof prReviewFlags.$inferSelect)[]>();
  for (const part of chunks(
    [...reviews.values()].map((r) => r.id),
    CHUNK
  ))
    for (const f of await db
      .select()
      .from(prReviewFlags)
      .where(
        and(
          inArray(prReviewFlags.classificationId, part),
          eq(prReviewFlags.kind, 'needs_person'),
          isNull(prReviewFlags.approvedAt)
        )
      )
      .all())
      flagsOf.set(f.classificationId, [
        ...(flagsOf.get(f.classificationId) ?? []),
        f,
      ]);

  const pa = alias(pullRequests, 'pa');
  const pb = alias(pullRequests, 'pb');
  const staleBefore = new Date(Date.now() - STALE_MS);
  const stackRows = new Map<
    string,
    {
      aId: string;
      bId: string;
      aNumber: number;
      bNumber: number;
      aState: string;
      bState: string;
      stage: string;
      prerequisite: 'a' | 'b' | null;
      updatedAt: Date;
    }
  >();
  for (const part of chunks(ids, CHUNK))
    for (const side of [prEdges.prAId, prEdges.prBId])
      for (const r of await db
        .select({
          id: prEdges.id,
          aId: prEdges.prAId,
          bId: prEdges.prBId,
          aNumber: pa.number,
          bNumber: pb.number,
          aState: pa.state,
          bState: pb.state,
          stage: prEdges.stage,
          prerequisite: prEdges.prerequisite,
          updatedAt: prEdges.updatedAt,
        })
        .from(prEdges)
        .innerJoin(pa, eq(pa.id, prEdges.prAId))
        .innerJoin(pb, eq(pb.id, prEdges.prBId))
        .where(
          and(
            inArray(side, part),
            eq(prEdges.slot, 'pair'),
            isNull(prEdges.dismissedAt),
            or(
              eq(prEdges.stage, 'failed'),
              and(
                eq(prEdges.kind, 'must_account_for'),
                isNull(prEdges.accountedForAt),
                lt(prEdges.updatedAt, staleBefore)
              )
            )
          )
        )
        .all())
        stackRows.set(r.id, r);
  const stale = new Map<string, { pr: number; since: string }[]>();
  const unchecked = new Map<string, number[]>();
  const push = <T>(m: Map<string, T[]>, k: string, v: T) =>
    m.set(k, [...(m.get(k) ?? []), v]);
  for (const r of stackRows.values()) {
    if (r.stage === 'failed') {
      // Only against pull requests that are still open.
      if (openIds.has(r.aId) && openIds.has(r.bId)) {
        push(unchecked, r.aId, r.bNumber);
        push(unchecked, r.bId, r.aNumber);
      }
      continue;
    }
    if (!r.prerequisite) continue;
    const [pre, dependent, preState] =
      r.prerequisite === 'a'
        ? [r.aNumber, r.bId, r.aState]
        : [r.bNumber, r.aId, r.bState];
    // A prerequisite closed without landing no longer blocks (the tree ignores it too).
    if (preState === 'closed') continue;
    if (openIds.has(dependent))
      push(stale, dependent, { pr: pre, since: r.updatedAt.toISOString() });
  }

  type Item = {
    pr: PullRequest;
    headSha: string | null;
    reviewFailed: string | null;
    groups: (Group & { flags: (typeof prReviewFlags.$inferSelect)[] })[];
    resolutionFailed: string | null;
    needsApproval: boolean;
    pullState: PullState | null;
    stackStale: { pr: number; since: string }[];
    stackUnchecked: number[];
  };
  const items: Item[] = [];
  for (const pr of mergeable) {
    const review = reviews.get(pr.id) ?? null;
    const resolution = resolutions.get(pr.id);
    const reviewFailed =
      review?.status === 'failed'
        ? (review.errorMessage ?? 'The review failed.')
        : null;
    const flags = review ? (flagsOf.get(review.id) ?? []) : [];
    const groups = (groupsOf.get(pr.id) ?? [])
      .map((g) => ({
        ...g,
        flags: flags.filter((f) => f.agentId === g.agentId),
      }))
      .filter((g) => g.status === 'failed' || g.flags.length);
    // Conflicts AI can't resolve (NO_MODEL) are the agent's to resolve locally, not a person's; so is a rebase
    // conflict AI failed on (a per-commit row, commit_sha set): it shows as rebase_conflict, for the agent.
    const resolutionFailed =
      resolution &&
      resolution.model !== NO_MODEL &&
      resolution.commitSha === null &&
      (resolution.status === 'rejected' ||
        (resolution.status === 'failed' &&
          resolution.errorMessage !== SUPERSEDED))
        ? resolution.status === 'rejected'
          ? 'The AI resolution of its conflicts was discarded.'
          : `AI couldn't resolve its conflicts: ${resolution.errorMessage ?? 'unknown error'}`
        : null;
    const pullState = recorded.get(pr.id) ?? null;
    const needsApproval = !!pullState?.reasons.some(
      (r) => r.kind === 'needs_approval'
    );
    const stackStale = (stale.get(pr.id) ?? []).sort((x, y) => x.pr - y.pr);
    const stackUnchecked = (unchecked.get(pr.id) ?? []).sort((x, y) => x - y);
    if (
      groups.length ||
      reviewFailed ||
      resolutionFailed ||
      pullState?.state === 'human_review' ||
      stackStale.length ||
      stackUnchecked.length
    )
      items.push({
        pr,
        headSha: headOf.get(pr.id) ?? null,
        reviewFailed,
        groups,
        resolutionFailed,
        needsApproval,
        pullState,
        stackStale,
        stackUnchecked,
      });
  }

  const key = (i: Item): ApprovalsCursor => ({
    updatedAt: i.pr.updatedAt.getTime(),
    id: i.pr.id,
  });
  const visible = items
    .filter((i) => repos.get(i.pr.repositoryId)?.canMerge)
    .sort((a, b) => (before(key(a), key(b)) ? -1 : 1));
  const count = visible.reduce((n, i) => {
    // A failed review fails every agent's row too: its error shows once, with each agent's retry target.
    const own =
      i.groups.reduce(
        (k, g) =>
          k +
          (g.status === 'failed' ? (i.reviewFailed ? 0 : 1) : g.flags.length),
        0
      ) +
      (i.reviewFailed ? 1 : 0) +
      (i.resolutionFailed ? 1 : 0) +
      i.stackStale.length +
      (i.stackUnchecked.length ? 1 : 0);
    // A pull request that needs a person for another reason (needs_approval, a cycle) counts once.
    return (
      n + own + (own === 0 && i.pullState?.state === 'human_review' ? 1 : 0)
    );
  }, 0);
  // Findings someone asked this person to decide, over every page.
  const assignedToMe = visible.reduce(
    (n, i) =>
      n +
      i.groups.reduce(
        (k, g) =>
          k +
          (g.status === 'failed'
            ? 0
            : g.flags.filter((f) => f.assigneeId === user.id).length),
        0
      ),
    0
  );
  const cursor = opts.cursor;
  const after = cursor
    ? visible.filter((i) => before(cursor, key(i)))
    : visible;
  const page = after.slice(0, opts.limit);
  const nextCursor =
    after.length > page.length
      ? encodeCursor(key(page[page.length - 1]))
      : null;

  const people = new Map<string, PublicUser>();
  for (const part of chunks(
    [
      ...new Set([
        ...page.map((i) => i.pr.authorId),
        ...page.flatMap((i) => i.groups.map((g) => g.agentId)),
        ...page.flatMap((i) =>
          i.groups.flatMap((g) =>
            g.flags
              .map((f) => f.changesRequestedById)
              .filter((id): id is string => !!id)
          )
        ),
      ]),
    ],
    CHUNK
  ))
    for (const [id, u] of await usersById(db, part)) people.set(id, u);
  const pageFlags = page.flatMap((i) => i.groups.flatMap((g) => g.flags));
  const refs = await personRefs(
    db,
    pageFlags.map((f) => f.assigneeId)
  );
  const guarded = new Set<string>();
  for (const part of chunks(
    [...new Set(page.flatMap((i) => i.groups.map((g) => g.agentId)))],
    CHUNK
  ))
    for (const a of await db
      .select({ id: agents.userId })
      .from(agents)
      .where(and(inArray(agents.userId, part), eq(agents.guarded, true)))
      .all())
      guarded.add(a.id);
  const sessionIds = await pullSessionIds(page.map((i) => i.pr));
  const out = [];
  for (const i of page) {
    const r = repos.get(i.pr.repositoryId)!;
    out.push({
      repo: { fullName: r.fullName, name: r.repo.name },
      pull: {
        number: i.pr.number,
        title: i.pr.title,
        author: people.get(i.pr.authorId) ?? null,
        updatedAt: i.pr.updatedAt.toISOString(),
        headSha: i.headSha,
        createdVia: i.pr.createdVia,
        sessionLabel: i.pr.sessionLabel,
        sessionId: sessionIds.get(i.pr.id)!,
      },
      reviewFailed: i.reviewFailed,
      resolutionFailed: i.resolutionFailed,
      needsApproval: i.needsApproval,
      pullState: i.pullState,
      stackStale: i.stackStale,
      stackUnchecked: i.stackUnchecked,
      agents: i.groups
        .map((g) => ({
          reviewerId: g.reviewerId,
          agent: people.get(g.agentId) ?? {
            id: g.agentId,
            username: g.agentId,
            name: 'Deleted agent',
            image: null,
          },
          status: g.status as 'flagged' | 'changes_requested' | 'failed',
          error: g.error,
          flags: g.flags.map((f) =>
            flagJson(f, people, { guarded: guarded.has(g.agentId), refs })
          ),
        }))
        .sort((a, b) => a.agent.username.localeCompare(b.agent.username)),
    });
  }
  return { items: out, count, assignedToMe, nextCursor };
}
