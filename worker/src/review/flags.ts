import { and, eq, isNull } from 'drizzle-orm';
import { settleStates } from '../pulls/settle';
import type { DrizzleDB } from '../db/middleware';
import {
  prClassifications,
  prReviewFlags,
  type PullRequest,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { GitService } from '../git/service';
import { recordAudit } from '../lib/audit';
import { maybeAutoMerge } from './auto-merge';

/** A finding's title (its `value.title`), for the audit log. */
function flagTitle(value: unknown): string {
  const title = (value as { title?: unknown } | null)?.title;
  return typeof title === 'string' && title.trim()
    ? title.trim().slice(0, 200)
    : 'Finding';
}

/** The longest note a person can leave when requesting changes on a flag. */
export const CHANGES_NOTE_MAX = 1000;

export type FlagDecision =
  { kind: 'approve' } | { kind: 'request_changes'; note?: string | null };

export type FlagKind = 'needs_person' | 'change_requested';

/** The head-moved refusal (409), shared with the MCP tools' wording. */
export const STALE_HEAD =
  'The pull request has new commits since you looked. Review them, then decide again.';

/**
 * Options the web routes don't pass. `via`: the moderator app's name, recorded on an approval. `kind`: only a flag of
 * this kind (400 otherwise). `expectedHead`: the head commit the decider looked at — refused (409) unless it is the
 * pull request's current head and the flag was raised on it.
 */
export type FlagDecisionOpts = {
  via?: string | null;
  kind?: FlagKind;
  expectedHead?: { sha: string; git: GitService };
};

export type FlagDecisionResult =
  { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Approves a review flag, or requests changes on it, as `userId`. Approving clears a request
 * for changes; requesting changes only applies to a flag nobody approved (the latest request
 * wins). Approving an agent's `change_requested` flag dismisses it; nobody can request changes
 * on one (it is already the agent's change request). The caller checks the user can merge in the repository, the same check for both.
 * Either way the pull request may now auto-merge (or no longer), so `after` gets that work.
 * `opts` (moderator apps over MCP) records the app, restricts the kind, and refuses a head the decider didn't see.
 */
export async function decideFlag(
  env: CloudflareBindings,
  db: DrizzleDB,
  pr: PullRequest,
  flagId: string,
  userId: string,
  decision: FlagDecision,
  after: (work: Promise<unknown>) => void,
  opts: FlagDecisionOpts = {}
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
    .select({
      id: prReviewFlags.id,
      kind: prReviewFlags.kind,
      value: prReviewFlags.value,
      agent: users.username,
      headSha: prClassifications.headSha,
    })
    .from(prReviewFlags)
    .innerJoin(
      prClassifications,
      eq(prClassifications.id, prReviewFlags.classificationId)
    )
    .leftJoin(users, eq(users.id, prReviewFlags.agentId))
    .where(
      and(
        eq(prReviewFlags.id, flagId),
        eq(prClassifications.pullRequestId, pr.id)
      )
    )
    .get();
  if (!flag) return { ok: false, status: 404, error: 'Not Found' };
  if (opts.kind && flag.kind !== opts.kind)
    return {
      ok: false,
      status: 400,
      error:
        flag.kind === 'change_requested'
          ? "This finding is an agent's change request: dismiss it instead"
          : "This finding needs a person's approval, not a dismissal",
    };
  // An agent's change request goes to the PR's agent; a person may only dismiss it (approve does that).
  if (decision.kind === 'request_changes' && flag.kind === 'change_requested')
    return {
      ok: false,
      status: 400,
      error:
        "This is the agent's own change request: push the change, or dismiss it",
    };
  if (opts.expectedHead) {
    const { sha, git } = opts.expectedHead;
    // The decider saw this head, and this flag belongs to it: never a commit pushed since, nor an older review.
    if (flag.headSha !== sha || (await git.resolve(pr.headRef)) !== sha)
      return { ok: false, status: 409, error: STALE_HEAD };
  }

  const unapproved = and(
    eq(prReviewFlags.id, flagId),
    isNull(prReviewFlags.approvedAt)
  );
  const audit = {
    repositoryId: pr.repositoryId,
    actorId: userId,
    via: opts.via ?? null,
    target: flagTitle(flag.value),
    pull: pr.number,
  };
  const facts = { finding: flag.id, kind: flag.kind, agent: flag.agent };
  if (decision.kind === 'approve') {
    // Approving twice keeps the first approval (and how it was made), and records it once.
    const approved = await db
      .update(prReviewFlags)
      .set({
        approvedById: userId,
        approvedAt: new Date(),
        approvedVia: opts.via ?? null,
        changesRequestedById: null,
        changesRequestedAt: null,
        changesRequestedNote: null,
      })
      .where(unapproved)
      .returning({ id: prReviewFlags.id });
    if (approved.length)
      await recordAudit(db, {
        ...audit,
        action: 'finding.approved',
        data: facts,
      });
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
    await recordAudit(db, {
      ...audit,
      action: 'finding.changes_requested',
      data: { ...facts, note },
    });
  }
  after(
    maybeAutoMerge(env, db, pr.id).catch((e) =>
      console.error('[review] auto-merge failed', e)
    )
  );
  after(settleStates(env, db, pr.repositoryId));
  return { ok: true };
}
