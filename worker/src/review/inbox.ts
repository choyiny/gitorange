import { desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  mergeResolutions,
  prClassifications,
  prReviewFlags,
  pullRequests,
  type PrClassification,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import { decoder } from '../git/bytes';
import { findRepoById, gitFor, permissionsFor } from '../lib/repos';
import { usersById } from '../lib/users';
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

/**
 * Everything waiting on a person, across the repositories the user can merge in: flags of each
 * open pull request's latest review that nobody approved, reviews that failed, and AI conflict
 * resolutions that failed or were discarded.
 */
export async function approvalsFor(
  env: CloudflareBindings,
  db: DrizzleDB,
  user: SessionUser
) {
  const open = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.state, 'open'))
    .orderBy(desc(pullRequests.updatedAt))
    .all();
  if (!open.length) return [];
  const ids = open.map((p) => p.id);
  const reviews = latestPer(
    await db
      .select()
      .from(prClassifications)
      .where(inArray(prClassifications.pullRequestId, ids))
      .orderBy(desc(prClassifications.createdAt))
      .all()
  );
  const resolutions = latestPer(
    await db
      .select()
      .from(mergeResolutions)
      .where(inArray(mergeResolutions.pullRequestId, ids))
      .orderBy(desc(mergeResolutions.createdAt))
      .all()
  );
  const humanReviews = [...reviews.values()].filter(
    (r) => r.status === 'done' && r.verdict === 'human'
  );
  const flags = humanReviews.length
    ? await db
        .select()
        .from(prReviewFlags)
        .where(
          inArray(
            prReviewFlags.classificationId,
            humanReviews.map((r) => r.id)
          )
        )
        .all()
    : [];
  const pendingFlags = flags.filter((f) => !f.approvedAt);

  type Item = {
    pr: PullRequest;
    review: PrClassification | null;
    reviewFailed: boolean;
    resolutionFailed: string | null;
  };
  const items: Item[] = [];
  for (const pr of open) {
    const review = reviews.get(pr.id) ?? null;
    const resolution = resolutions.get(pr.id);
    const hasFlags =
      !!review && pendingFlags.some((f) => f.classificationId === review.id);
    const reviewFailed = review?.status === 'failed';
    const resolutionFailed =
      resolution &&
      (resolution.status === 'rejected' ||
        (resolution.status === 'failed' &&
          resolution.errorMessage !== 'Superseded by newer commits.'))
        ? resolution.status === 'rejected'
          ? 'The AI resolution of its conflicts was discarded.'
          : `AI couldn't resolve its conflicts: ${resolution.errorMessage ?? 'unknown error'}`
        : null;
    if (hasFlags || reviewFailed || resolutionFailed)
      items.push({ pr, review, reviewFailed, resolutionFailed });
  }

  // Only repositories the user can merge in, since approving and retrying take that.
  const repos = new Map<
    string,
    { repo: Repository; fullName: string; canMerge: boolean }
  >();
  for (const repoId of new Set(items.map((i) => i.pr.repositoryId))) {
    const found = await findRepoById(db, repoId);
    if (!found) continue;
    const perms = await permissionsFor(db, found.repo, user);
    repos.set(repoId, {
      repo: found.repo,
      fullName: `${found.namespace.username}/${found.repo.name}`,
      canMerge: perms.write,
    });
  }
  const visible = items.filter((i) => repos.get(i.pr.repositoryId)?.canMerge);

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
  const people = await usersById(
    db,
    visible.map((i) => i.pr.authorId)
  );
  const out = [];
  for (const i of visible) {
    const r = repos.get(i.pr.repositoryId)!;
    const policy = i.review ? await policyOf(r.repo, i.review.policySha) : null;
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
      flags: i.review
        ? pendingFlags
            .filter((f) => f.classificationId === i.review!.id)
            .map((f) => ({
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
            }))
        : [],
    });
  }
  return out;
}
