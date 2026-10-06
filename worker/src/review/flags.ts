import { and, eq, isNull } from 'drizzle-orm';
import { settleStates } from '../pulls/settle';
import type { DrizzleDB } from '../db/middleware';
import {
  prClassifications,
  prReviewFlags,
  type PullRequest,
} from '../db/app.schema';
import { maybeAutoMerge } from './auto-merge';

/** The longest note a person can leave when requesting changes on a flag. */
export const CHANGES_NOTE_MAX = 1000;

export type FlagDecision =
  { kind: 'approve' } | { kind: 'request_changes'; note?: string | null };

export type FlagDecisionResult =
  { ok: true } | { ok: false; status: 400 | 404; error: string };

/**
 * Approves a review flag, or requests changes on it, as `userId`. Approving clears a request
 * for changes; requesting changes only applies to a flag nobody approved (the latest request
 * wins). Approving an agent's `change_requested` flag dismisses it; nobody can request changes
 * on one (it is already the agent's change request). The caller checks the user can merge in the repository, the same check for both.
 * Either way the pull request may now auto-merge (or no longer), so `after` gets that work.
 */
export async function decideFlag(
  env: CloudflareBindings,
  db: DrizzleDB,
  pr: PullRequest,
  flagId: string,
  userId: string,
  decision: FlagDecision,
  after: (work: Promise<unknown>) => void
): Promise<FlagDecisionResult> {
  if (pr.state !== 'open')
    return {
      ok: false,
      status: 400,
      error: 'This pull request is no longer open',
    };
  const note =
    decision.kind === 'request_changes'
      ? (decision.note ?? '').trim() || null
      : null;
  if (note && note.length > CHANGES_NOTE_MAX)
    return {
      ok: false,
      status: 400,
      error: `The note can be at most ${CHANGES_NOTE_MAX} characters`,
    };
  const flag = await db
    .select({ id: prReviewFlags.id, kind: prReviewFlags.kind })
    .from(prReviewFlags)
    .innerJoin(
      prClassifications,
      eq(prClassifications.id, prReviewFlags.classificationId)
    )
    .where(
      and(
        eq(prReviewFlags.id, flagId),
        eq(prClassifications.pullRequestId, pr.id)
      )
    )
    .get();
  if (!flag) return { ok: false, status: 404, error: 'Not Found' };
  // An agent's change request goes to the PR's agent; a person may only dismiss it (approve does that).
  if (decision.kind === 'request_changes' && flag.kind === 'change_requested')
    return {
      ok: false,
      status: 400,
      error:
        "This is the agent's own change request: push the change, or dismiss it",
    };

  const unapproved = and(
    eq(prReviewFlags.id, flagId),
    isNull(prReviewFlags.approvedAt)
  );
  if (decision.kind === 'approve') {
    // Approving twice keeps the first approval.
    await db
      .update(prReviewFlags)
      .set({
        approvedById: userId,
        approvedAt: new Date(),
        changesRequestedById: null,
        changesRequestedAt: null,
        changesRequestedNote: null,
      })
      .where(unapproved);
  } else {
    const updated = await db
      .update(prReviewFlags)
      .set({
        changesRequestedById: userId,
        changesRequestedAt: new Date(),
        changesRequestedNote: note,
      })
      .where(unapproved)
      .returning({ id: prReviewFlags.id });
    if (!updated.length)
      return { ok: false, status: 400, error: 'This flag is already approved' };
  }
  after(
    maybeAutoMerge(env, db, pr.id).catch((e) =>
      console.error('[review] auto-merge failed', e)
    )
  );
  after(settleStates(env, db, pr.repositoryId));
  return { ok: true };
}
