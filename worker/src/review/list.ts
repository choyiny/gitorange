import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  prClassifications,
  prReviewFlags,
  pullRequests,
  type PullRequest,
} from '../db/app.schema';
import type { GitService } from '../git/service';
import { reviewProgress, type ReviewProgress } from './auto-merge';
import { readPolicy } from './policy';
import { landTargetOf } from '../lib/land-target';

/**
 * Review progress of a repository's open PRs at their current tips, in two queries; PRs
 * whose target branch has no review.yml are left out.
 */
export async function reviewProgressFor(
  db: DrizzleDB,
  git: GitService,
  repositoryId: string,
  prs: Pick<
    PullRequest,
    'id' | 'state' | 'baseRef' | 'landTarget' | 'headRef'
  >[],
  refs: Map<string, string>
): Promise<Map<string, ReviewProgress>> {
  const out = new Map<string, ReviewProgress>();
  const tips = prs.flatMap((pr) => {
    const base = refs.get(`refs/heads/${landTargetOf(pr)}`);
    const head = refs.get(`refs/heads/${pr.headRef}`);
    return pr.state === 'open' && base && head ? [{ pr, base, head }] : [];
  });
  if (!tips.length) return out;
  const policies = new Map(
    await Promise.all(
      [...new Set(tips.map((t) => t.base))].map(
        async (base) =>
          [base, (await readPolicy(git, base).catch(() => null))?.sha] as const
      )
    )
  );
  const openPrs = and(
    eq(pullRequests.repositoryId, repositoryId),
    eq(pullRequests.state, 'open')
  );
  const [reviews, unapproved] = await Promise.all([
    db
      .select({
        id: prClassifications.id,
        pullRequestId: prClassifications.pullRequestId,
        headSha: prClassifications.headSha,
        policySha: prClassifications.policySha,
        status: prClassifications.status,
        verdict: prClassifications.verdict,
        errorMessage: prClassifications.errorMessage,
      })
      .from(prClassifications)
      .innerJoin(
        pullRequests,
        eq(pullRequests.id, prClassifications.pullRequestId)
      )
      .where(openPrs)
      .all(),
    db
      .select({
        classificationId: prReviewFlags.classificationId,
        n: sql<number>`COUNT(*)`,
      })
      .from(prReviewFlags)
      .innerJoin(
        prClassifications,
        eq(prClassifications.id, prReviewFlags.classificationId)
      )
      .innerJoin(
        pullRequests,
        eq(pullRequests.id, prClassifications.pullRequestId)
      )
      .where(and(openPrs, isNull(prReviewFlags.approvedAt)))
      .groupBy(prReviewFlags.classificationId)
      .all(),
  ]);
  const byTip = new Map(
    reviews.map((r) => [`${r.pullRequestId} ${r.headSha} ${r.policySha}`, r])
  );
  const flags = new Map(
    unapproved.map((u) => [u.classificationId, Number(u.n)])
  );
  for (const { pr, base, head } of tips) {
    const policySha = policies.get(base);
    if (!policySha) continue;
    const review = byTip.get(`${pr.id} ${head} ${policySha}`);
    out.set(
      pr.id,
      reviewProgress(review, review ? (flags.get(review.id) ?? 0) : 0)
    );
  }
  return out;
}
