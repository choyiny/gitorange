import { and, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import { prReviewers, type PullRequest } from '../db/app.schema';
import { d1Of } from '../pulls/events';
import { headReviewFor, headReviewId } from './keys';

/**
 * A clean rebase keeps the pull request's review. The agents' finished review of the old head (pr_classifications, its
 * findings, each agent's verdict) moves to the new head, and so do people's approvals: rows are re-keyed, not copied,
 * so a finding or a dismissal never counts twice (nor shows again among earlier commits' reviews). A review still
 * running, or with an agent still reviewing, stays with the old head (the sweep reviews the new one), as does a
 * finished one when the new head already has its own. One D1 batch; running it again moves nothing more. Returns
 * whether a review moved.
 */
export async function carryReview(
  db: DrizzleDB,
  pr: Pick<PullRequest, 'id'>,
  from: string,
  to: string
): Promise<boolean> {
  const old = await headReviewFor(db, pr.id, from);
  const moveReview =
    !!old &&
    (old.status === 'done' || old.status === 'failed') &&
    // An agent still reviewing (a deep review finishing late) would write its findings under the old id.
    !(await db
      .select({ id: prReviewers.id })
      .from(prReviewers)
      .where(
        and(
          eq(prReviewers.pullRequestId, pr.id),
          eq(prReviewers.headSha, from),
          eq(prReviewers.status, 'reviewing')
        )
      )
      .limit(1)
      .get()) &&
    !(await headReviewFor(db, pr.id, to));
  const d1 = d1Of(db);
  const oldId = headReviewId(pr.id, from);
  const newId = headReviewId(pr.id, to);
  const statements: D1PreparedStatement[] = [];
  if (moveReview)
    statements.push(
      d1
        .prepare(
          `INSERT INTO pr_classifications (id, pull_request_id, head_sha, status, summary_model, classifier_model,
             files, error_message, duration_ms, created_at, finished_at)
           SELECT ?, pull_request_id, ?, status, summary_model, classifier_model, files, error_message, duration_ms,
             created_at, finished_at
             FROM pr_classifications WHERE id = ?`
        )
        .bind(newId, to, oldId),
      d1
        .prepare(
          'UPDATE pr_review_flags SET classification_id = ? WHERE classification_id = ?'
        )
        .bind(newId, oldId),
      d1
        .prepare(
          'UPDATE OR IGNORE pr_reviewers SET head_sha = ? WHERE pull_request_id = ? AND head_sha = ?'
        )
        .bind(to, pr.id, from),
      d1.prepare('DELETE FROM pr_classifications WHERE id = ?').bind(oldId)
    );
  statements.push(
    d1
      .prepare(
        'UPDATE OR IGNORE pr_approvals SET head_sha = ? WHERE pull_request_id = ? AND head_sha = ?'
      )
      .bind(to, pr.id, from)
  );
  await d1.batch(statements);
  return moveReview;
}
