import { and, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  prApprovals,
  prReviewers,
  pullRequests,
  type PullRequest,
} from '../db/app.schema';
import type { RefUpdate } from '../actions/trigger';
import type { GitService } from '../git/service';
import { ZERO_SHA } from '../git/remote';
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

/**
 * A push that changes no files (an empty "re-run checks" commit) keeps people's approvals: where a pushed branch's
 * new tip has the same tree as its old one, the open pull requests from it have their approvals re-keyed to the new
 * head (as a clean rebase does). A pull request nobody approved costs one indexed lookup, no git reads. Returns the
 * pull requests whose approvals moved.
 */
export async function carryApprovalsOnSameTree(
  db: DrizzleDB,
  git: GitService,
  repositoryId: string,
  updates: RefUpdate[]
): Promise<string[]> {
  const moved: string[] = [];
  for (const u of updates) {
    if (!u.ref.startsWith('refs/heads/')) continue;
    if (u.old === ZERO_SHA || u.new === ZERO_SHA) continue;
    const approved = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .innerJoin(prApprovals, eq(prApprovals.pullRequestId, pullRequests.id))
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          eq(pullRequests.state, 'open'),
          eq(pullRequests.headRef, u.ref.slice('refs/heads/'.length)),
          eq(prApprovals.headSha, u.old)
        )
      )
      .groupBy(pullRequests.id)
      .all();
    if (!approved.length) continue;
    const [before, after] = await Promise.all([
      git.commit(u.old),
      git.commit(u.new),
    ]);
    if (!before || !after || before.treeHash !== after.treeHash) continue;
    const d1 = d1Of(db);
    await d1.batch(
      approved.map((p) =>
        d1
          .prepare(
            'UPDATE OR IGNORE pr_approvals SET head_sha = ? WHERE pull_request_id = ? AND head_sha = ?'
          )
          .bind(u.new, p.id, u.old)
      )
    );
    moved.push(...approved.map((p) => p.id));
  }
  return moved;
}
