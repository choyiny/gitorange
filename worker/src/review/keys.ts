import { eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  prClassifications,
  repositoryAgents,
  type PrClassification,
} from '../db/app.schema';

/**
 * The review of one pull request commit. Deterministic, so racing triggers insert one row and a branch that
 * returns to a reviewed commit finds its review; review.yml reviews (random ids) never collide with it.
 */
export const headReviewId = (pullRequestId: string, headSha: string) =>
  `${pullRequestId}-${headSha}`;

export async function headReviewFor(
  db: DrizzleDB,
  pullRequestId: string,
  headSha: string
): Promise<PrClassification | undefined> {
  return db
    .select()
    .from(prClassifications)
    .where(eq(prClassifications.id, headReviewId(pullRequestId, headSha)))
    .get();
}

/** Whether any agent is invited to the repository: reviews run, and auto-merge is on, only then. */
export async function hasInvitedAgents(
  db: DrizzleDB,
  repositoryId: string
): Promise<boolean> {
  return !!(await db
    .select({ id: repositoryAgents.agentId })
    .from(repositoryAgents)
    .where(eq(repositoryAgents.repositoryId, repositoryId))
    .limit(1)
    .get());
}
