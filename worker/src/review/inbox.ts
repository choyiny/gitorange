import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { DrizzleDB } from '../db/middleware';
import {
  mergeResolutions,
  prClassifications,
  prEdges,
  prReviewFlags,
  pullRequests,
  type PrClassification,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import { NO_MODEL, SUPERSEDED } from '../merge/resolution';
import { latestStates } from '../pulls/events';
import type { PullState } from '../pulls/state';
import { decoder } from '../git/bytes';
import { findReposByIds, gitFor, permissionsForMany } from '../lib/repos';
import { usersById, type PublicUser } from '../lib/users';
import { chunks } from '../stack/view';
import type { SessionUser } from '../variables';
import { parsePolicy, type ReviewPolicy } from './policy';
import { flagTitle } from './view';

/** The latest row per pull request, from rows sorted newest first. */
function latestPer<T extends { pullRequestId: string }>(rows: T[]) {
  const out = new Map<string, T>();
  for (const r of rows)
    if (!out.has(r.pullRequestId)) out.set(r.pullRequestId, r);
  return out;
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
 * Items waiting on a person in repositories the user can merge in: unapproved flags, failed
 * reviews, failed or discarded AI conflict resolutions, and PRs whose state is Requires Human Review
 * (from the latest recorded state). One page of them, newest first: the list of visible items is
 * built cheaply in full (so `count` and the cursor hold after permission filtering), and only the
 * page's items get authors and flag titles. `count` is how many things wait on the user over all
 * items: each unapproved flag, failed review and failed resolution, and each human_review pull
 * request that has none of those.
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
  if (!open.length) return { items: [], count: 0, nextCursor: null };
  const ids = open.map((p) => p.id);
  const reviewRows: PrClassification[] = [];
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
  // Chunks split by pull request, so each one's rows stay newest first.
  const reviews = latestPer(reviewRows);
  const resolutions = latestPer(resolutionRows);
  const recorded = await latestStates(db, ids);
  const humanReviews = [...reviews.values()].filter(
    (r) => r.status === 'done' && r.verdict === 'human'
  );
  const flags: (typeof prReviewFlags.$inferSelect)[] = [];
  for (const part of chunks(
    humanReviews.map((r) => r.id),
    CHUNK
  ))
    flags.push(
      ...(await db
        .select()
        .from(prReviewFlags)
        .where(inArray(prReviewFlags.classificationId, part))
        .all())
    );
  const pendingFlags = flags.filter((f) => !f.approvedAt);
  const flagsOf = new Map<string, typeof pendingFlags>();
  for (const f of pendingFlags)
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
  const openIds = new Set(ids);
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
    review: PrClassification | null;
    flags: typeof pendingFlags;
    reviewFailed: boolean;
    resolutionFailed: string | null;
    pullState: PullState | null;
    stackStale: { pr: number; since: string }[];
    stackUnchecked: number[];
  };
  const items: Item[] = [];
  for (const pr of open) {
    const review = reviews.get(pr.id) ?? null;
    const resolution = resolutions.get(pr.id);
    const prFlags = review ? (flagsOf.get(review.id) ?? []) : [];
    const reviewFailed = review?.status === 'failed';
    // Conflicts AI can't resolve (NO_MODEL) are the agent's to resolve locally, not a person's.
    const resolutionFailed =
      resolution &&
      resolution.model !== NO_MODEL &&
      (resolution.status === 'rejected' ||
        (resolution.status === 'failed' &&
          resolution.errorMessage !== SUPERSEDED))
        ? resolution.status === 'rejected'
          ? 'The AI resolution of its conflicts was discarded.'
          : `AI couldn't resolve its conflicts: ${resolution.errorMessage ?? 'unknown error'}`
        : null;
    const pullState = recorded.get(pr.id) ?? null;
    const stackStale = (stale.get(pr.id) ?? []).sort((x, y) => x.pr - y.pr);
    const stackUnchecked = (unchecked.get(pr.id) ?? []).sort((x, y) => x - y);
    if (
      prFlags.length ||
      reviewFailed ||
      resolutionFailed ||
      pullState?.state === 'human_review' ||
      stackStale.length ||
      stackUnchecked.length
    )
      items.push({
        pr,
        review,
        flags: prFlags,
        reviewFailed,
        resolutionFailed,
        pullState,
        stackStale,
        stackUnchecked,
      });
  }

  // Approving and retrying require merge access.
  const repos = new Map<
    string,
    { repo: Repository; fullName: string; canMerge: boolean }
  >();
  for (const part of chunks(
    [...new Set(items.map((i) => i.pr.repositoryId))],
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
  const key = (i: Item): ApprovalsCursor => ({
    updatedAt: i.pr.updatedAt.getTime(),
    id: i.pr.id,
  });
  const visible = items
    .filter((i) => repos.get(i.pr.repositoryId)?.canMerge)
    .sort((a, b) => (before(key(a), key(b)) ? -1 : 1));
  const count = visible.reduce(
    (n, i) =>
      n +
      i.flags.length +
      (i.reviewFailed ? 1 : 0) +
      (i.resolutionFailed ? 1 : 0) +
      i.stackStale.length +
      (i.stackUnchecked.length ? 1 : 0) +
      (i.pullState?.state === 'human_review' &&
      !i.flags.length &&
      !i.reviewFailed &&
      !i.resolutionFailed &&
      !i.stackStale.length &&
      !i.stackUnchecked.length
        ? 1
        : 0),
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

  // Flag titles come from the review's own policy version.
  const policies = new Map<string, ReviewPolicy | null>();
  const policyOf = async (repo: Repository, sha: string) => {
    if (!policies.has(sha)) {
      const bytes = await gitFor(env, repo)
        .blob(sha)
        .catch(() => null);
      let policy: ReviewPolicy | null = null;
      try {
        if (bytes) policy = parsePolicy(decoder.decode(bytes));
      } catch {
        // Invalid: titles fall back to question ids.
      }
      policies.set(sha, policy);
    }
    return policies.get(sha)!;
  };
  const people = new Map<string, PublicUser>();
  for (const part of chunks(
    [
      ...new Set([
        ...page.map((i) => i.pr.authorId),
        ...page.flatMap((i) =>
          i.flags
            .map((f) => f.changesRequestedById)
            .filter((id): id is string => !!id)
        ),
      ]),
    ],
    CHUNK
  ))
    for (const [id, u] of await usersById(db, part)) people.set(id, u);
  const out = [];
  for (const i of page) {
    const r = repos.get(i.pr.repositoryId)!;
    const policy = i.flags.length
      ? await policyOf(r.repo, i.review!.policySha)
      : null;
    out.push({
      repo: { fullName: r.fullName, name: r.repo.name },
      pull: {
        number: i.pr.number,
        title: i.pr.title,
        author: people.get(i.pr.authorId) ?? null,
        updatedAt: i.pr.updatedAt.toISOString(),
      },
      reviewFailed: i.reviewFailed
        ? (i.review?.errorMessage ?? 'The review failed.')
        : null,
      resolutionFailed: i.resolutionFailed,
      pullState: i.pullState,
      stackStale: i.stackStale,
      stackUnchecked: i.stackUnchecked,
      flags: i.flags.map((f) => ({
        id: f.id,
        source: f.source,
        key: f.key,
        title: flagTitle(policy, f),
        value: f.value ?? null,
        paths: f.paths,
        detail: f.detail,
        detailModel: f.detailModel,
        approvedBy: null,
        approvedAt: null,
        changesRequestedBy: f.changesRequestedById
          ? (people.get(f.changesRequestedById) ?? null)
          : null,
        changesRequestedAt: f.changesRequestedAt?.toISOString() ?? null,
        changesRequestedNote: f.changesRequestedAt
          ? f.changesRequestedNote
          : null,
      })),
    });
  }
  return { items: out, count, nextCursor };
}
