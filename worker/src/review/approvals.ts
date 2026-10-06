import { and, asc, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import { prApprovals, type PullRequest } from '../db/app.schema';
import type { GitService } from '../git/service';
import { resolutionConfigured } from '../merge/resolution';
import { d1Of } from '../pulls/events';
import { settleStates } from '../pulls/settle';
import { maybeAutoMerge } from './auto-merge';
import { approvalOverrides, reviewInputs } from './gate';

type OpenHead =
  { ok: true; headSha: string } | { ok: false; status: 400; error: string };
/** Approving can also refuse a head the person didn't see (409); withdrawing can't. */
export type ApprovalResult =
  OpenHead | { ok: false; status: 409; error: string };

/** The people who approved one commit of a pull request, oldest first. */
export async function approvalsAt(
  db: DrizzleDB,
  pullRequestId: string,
  headSha: string
): Promise<{ userId: string; createdAt: Date; via: string | null }[]> {
  return db
    .select({
      userId: prApprovals.userId,
      createdAt: prApprovals.createdAt,
      via: prApprovals.via,
    })
    .from(prApprovals)
    .where(
      and(
        eq(prApprovals.pullRequestId, pullRequestId),
        eq(prApprovals.headSha, headSha)
      )
    )
    .orderBy(asc(prApprovals.createdAt))
    .all();
}

async function openHead(git: GitService, pr: PullRequest): Promise<OpenHead> {
  if (pr.state !== 'open')
    return {
      ok: false,
      status: 400,
      error: 'This pull request is no longer open',
    };
  const head = await git.resolve(pr.headRef);
  if (!head)
    return {
      ok: false,
      status: 400,
      error: 'The head branch no longer exists',
    };
  return { ok: true, headSha: head };
}

/** What may change once approvals change: auto-merge, and the pull request's state. */
function afterApprovals(
  env: CloudflareBindings,
  db: DrizzleDB,
  pr: PullRequest,
  after: (work: Promise<unknown>) => void,
  followUps = true
) {
  // Approve-and-merge lands the pull request itself: starting auto-merge here would race it.
  if (!followUps) return;
  after(
    maybeAutoMerge(env, db, pr.id).catch((e) =>
      console.error('[review] auto-merge failed', e)
    )
  );
  after(settleStates(env, db, pr.repositoryId));
}

/**
 * Approves the pull request's current head commit as `userId`; the caller checked they can merge. Approving
 * twice keeps the first approval. A new commit needs a new approval; `expectedHead` (the head the person saw)
 * refuses with 409 when the branch moved since. `followUps: false` (approve-and-merge) skips starting auto-merge
 * and settling states: the caller lands the pull request and settles itself. An approval stays recorded even
 * when the merge that follows is refused. `via` (a moderator app over MCP) is recorded with the approval and its
 * timeline event; an existing approval keeps its own.
 */
export async function approvePull(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest,
  userId: string,
  after: (work: Promise<unknown>) => void,
  opts: { followUps?: boolean; expectedHead?: string; via?: string | null } = {}
): Promise<ApprovalResult> {
  const head = await openHead(git, pr);
  if (!head.ok) return head;
  // The person approves the commit they saw, never one pushed since.
  if (opts.expectedHead && opts.expectedHead !== head.headSha)
    return {
      ok: false,
      status: 409,
      error:
        'The pull request has new commits since you looked. Review them, then approve again.',
    };
  // What this approval stands over right now (findings for a person, failed or unfinished agent reviews).
  const inputs = await reviewInputs(
    db,
    pr.repositoryId,
    [{ pullRequestId: pr.id, head: head.headSha }],
    resolutionConfigured(env)
  );
  const over = approvalOverrides({ ...inputs.get(pr.id)!, approvedBy: [] });
  const now = Date.now();
  const d1 = d1Of(db);
  const via = opts.via ?? null;
  // One transaction: the approval and its timeline entry (once per person and commit) are written together.
  await d1.batch([
    d1
      .prepare(
        `INSERT INTO pr_approvals (pull_request_id, head_sha, user_id, created_at, via) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`
      )
      .bind(pr.id, head.headSha, userId, Math.floor(now / 1000), via),
    // changes(): rows the INSERT above added (same transaction, the statement just before).
    d1
      .prepare(
        `INSERT INTO pr_events (id, repository_id, pull_request_id, kind, state, data, actor_id, computed_at, created_at)
         SELECT ?, ?, ?, 'approved', NULL, ?, ?, ?, ? WHERE changes() > 0`
      )
      .bind(
        crypto.randomUUID(),
        pr.repositoryId,
        pr.id,
        JSON.stringify({
          head_sha: head.headSha,
          over,
          ...(via ? { via } : {}),
        }),
        userId,
        now,
        now
      ),
  ]);
  afterApprovals(env, db, pr, after, opts.followUps ?? true);
  return head;
}

/**
 * Withdraws `userId`'s approval of the current head commit (nothing to withdraw is fine), recorded as a
 * `withdrawn` timeline event.
 */
export async function withdrawApproval(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest,
  userId: string,
  after: (work: Promise<unknown>) => void
): Promise<OpenHead> {
  const head = await openHead(git, pr);
  if (!head.ok) return head;
  const now = Date.now();
  const d1 = d1Of(db);
  // One transaction: the withdrawal and its timeline entry, only when there was an approval to withdraw.
  await d1.batch([
    d1
      .prepare(
        `DELETE FROM pr_approvals WHERE pull_request_id = ? AND head_sha = ? AND user_id = ?`
      )
      .bind(pr.id, head.headSha, userId),
    // changes(): rows the DELETE above removed (same transaction, the statement just before).
    d1
      .prepare(
        `INSERT INTO pr_events (id, repository_id, pull_request_id, kind, state, data, actor_id, computed_at, created_at)
         SELECT ?, ?, ?, 'withdrawn', NULL, ?, ?, ?, ? WHERE changes() > 0`
      )
      .bind(
        crypto.randomUUID(),
        pr.repositoryId,
        pr.id,
        JSON.stringify({ head_sha: head.headSha }),
        userId,
        now,
        now
      ),
  ]);
  afterApprovals(env, db, pr, after);
  return head;
}
