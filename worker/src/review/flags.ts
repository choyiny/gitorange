import { and, eq, isNull } from 'drizzle-orm';
import { settleStates } from '../pulls/settle';
import type { DrizzleDB } from '../db/middleware';
import {
  agents,
  prClassifications,
  prReviewFlags,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { GitService } from '../git/service';
import { recordAudit } from '../lib/audit';
import { personRefs, type PersonRef } from '../lib/person-ref';
import { permissionsFor } from '../lib/repos';
import { userByUsername } from '../lib/users';
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
/** The longest reason for a decision (a guarded agent's finding needs one to be approved). */
export const DECISION_REASON_MAX = 1000;
/** The longest teach note: what the decider teaches the agent with the decision. */
export const TEACH_NOTE_MAX = 1000;

/**
 * `reason`: why the person approves (required for a guarded agent's finding). `teach`: a rule for the agent in the
 * person's words, learned when the pull request closes (learn/lessons.ts).
 */
export type FlagDecision =
  | { kind: 'approve'; reason?: string | null; teach?: string | null }
  | {
      kind: 'request_changes';
      note?: string | null;
      teach?: string | null;
    };

export type FlagKind = 'needs_person' | 'change_requested';

/** The head-moved refusal (409), shared with the MCP tools' wording. */
export const STALE_HEAD =
  'The pull request has new commits since you looked. Review them, then decide again.';

/**
 * Options the web routes don't pass. `via`: the moderator app's name (or "GitOrange AI"), recorded on the decision.
 * `kind`: only a flag of this kind (400 otherwise). `expectedHead`: the head commit the decider looked at — refused
 * (409) unless it is the pull request's current head and the flag was raised on it. `ai`: GitOrange AI deciding as
 * the user ("Let Claude decide", review/delegate.ts): never a guarded agent's finding (422), only one nobody decided
 * yet (409), recorded once as `finding.delegated` (actor kind `ai`) with the decision and its reason.
 */
export type FlagDecisionOpts = {
  via?: string | null;
  kind?: FlagKind;
  expectedHead?: { sha: string; git: GitService };
  ai?: { reason: string };
};

export type FlagDecisionResult =
  { ok: true } | { ok: false; status: 400 | 404 | 409 | 422; error: string };

/** One finding of a pull request, with what deciding it needs to know about its agent. */
async function loadFlag(db: DrizzleDB, pr: PullRequest, flagId: string) {
  return db
    .select({
      id: prReviewFlags.id,
      kind: prReviewFlags.kind,
      value: prReviewFlags.value,
      approvedAt: prReviewFlags.approvedAt,
      approvedById: prReviewFlags.approvedById,
      approvedVia: prReviewFlags.approvedVia,
      changesRequestedAt: prReviewFlags.changesRequestedAt,
      changesRequestedById: prReviewFlags.changesRequestedById,
      agent: users.username,
      agentName: agents.name,
      guarded: agents.guarded,
      headSha: prClassifications.headSha,
    })
    .from(prReviewFlags)
    .innerJoin(
      prClassifications,
      eq(prClassifications.id, prReviewFlags.classificationId)
    )
    .leftJoin(users, eq(users.id, prReviewFlags.agentId))
    .leftJoin(agents, eq(agents.userId, prReviewFlags.agentId))
    .where(
      and(
        eq(prReviewFlags.id, flagId),
        eq(prClassifications.pullRequestId, pr.id)
      )
    )
    .get();
}

/** An agent's name as owner-facing copy says it: "Security's findings". */
export const agentLabel = (f: {
  agentName: string | null;
  agent: string | null;
}) => f.agentName ?? (f.agent ? `@${f.agent}` : 'This agent');

/** The refusal for a guarded agent's finding approved without a reason (422). */
export const guardedNeedsReason = (label: string) =>
  `Approving ${label}'s findings needs a reason. It goes in the audit log with your name.`;

/** The refusal for GitOrange AI and a guarded agent's finding (422). */
export const guardedNotForAi = (label: string) =>
  `${label}'s findings always come to a person: GitOrange AI never decides them.`;

/** A trimmed optional text, null when blank; `false` when longer than `max`. */
function text(
  v: string | null | undefined,
  max: number
): string | null | false {
  const t = (v ?? '').trim();
  if (!t) return null;
  return t.length > max ? false : t;
}

/**
 * Approves a review flag, or requests changes on it, as `userId`. Approving clears a request
 * for changes; requesting changes only applies to a flag nobody approved (the latest request
 * wins). Approving an agent's `change_requested` flag dismisses it; nobody can request changes
 * on one (it is already the agent's change request). Approving a guarded agent's finding (either kind) needs a
 * reason (422). The caller checks the user can merge in the repository, the same check for both.
 * Either way the pull request may now auto-merge (or no longer), so `after` gets that work.
 * `opts` (moderator apps over MCP, GitOrange AI) records the app, restricts the kind, refuses a head the decider
 * didn't see, and (`ai`) applies the AI's rules. A decision's reason and teach note belong to it: a new decision
 * replaces them, and `undoFlag` clears them.
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
      ? text(decision.note, CHANGES_NOTE_MAX)
      : null;
  if (note === false)
    return {
      ok: false,
      status: 400,
      error: `The note can be at most ${CHANGES_NOTE_MAX} characters`,
    };
  const reason =
    decision.kind === 'approve'
      ? text(decision.reason, DECISION_REASON_MAX)
      : null;
  if (reason === false)
    return {
      ok: false,
      status: 400,
      error: `The reason can be at most ${DECISION_REASON_MAX} characters`,
    };
  const teach = text(decision.teach, TEACH_NOTE_MAX);
  if (teach === false)
    return {
      ok: false,
      status: 400,
      error: `What you teach can be at most ${TEACH_NOTE_MAX} characters`,
    };
  const flag = await loadFlag(db, pr, flagId);
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
  const label = agentLabel(flag);
  if (flag.guarded && opts.ai)
    return { ok: false, status: 422, error: guardedNotForAi(label) };
  // A guarded agent's finding is never approved (or dismissed) without a written reason.
  if (flag.guarded && decision.kind === 'approve' && !reason)
    return { ok: false, status: 422, error: guardedNeedsReason(label) };
  if (opts.expectedHead) {
    const { sha, git } = opts.expectedHead;
    // The decider saw this head, and this flag belongs to it: never a commit pushed since, nor an older review.
    if (flag.headSha !== sha || (await git.resolve(pr.headRef)) !== sha)
      return { ok: false, status: 409, error: STALE_HEAD };
  }

  // GitOrange AI decides only what nobody has decided; a person's approval may replace a request for changes.
  const open = and(
    eq(prReviewFlags.id, flagId),
    isNull(prReviewFlags.approvedAt),
    opts.ai ? isNull(prReviewFlags.changesRequestedAt) : undefined
  );
  const via = opts.via ?? null;
  const taught = { teachNote: teach, teachById: teach ? userId : null };
  const audit = {
    repositoryId: pr.repositoryId,
    actorId: userId,
    actorKind: opts.ai ? ('ai' as const) : ('person' as const),
    via,
    target: flagTitle(flag.value),
    pull: pr.number,
  };
  const facts = { finding: flag.id, kind: flag.kind, agent: flag.agent };
  let decided: boolean;
  if (decision.kind === 'approve') {
    // Approving twice keeps the first approval (and how it was made), and records it once.
    const approved = await db
      .update(prReviewFlags)
      .set({
        approvedById: userId,
        approvedAt: new Date(),
        approvedVia: via,
        changesRequestedById: null,
        changesRequestedAt: null,
        changesRequestedNote: null,
        decisionReason: opts.ai ? opts.ai.reason : reason,
        ...taught,
      })
      .where(open)
      .returning({ id: prReviewFlags.id });
    decided = approved.length > 0;
    if (!decided && opts.ai)
      return {
        ok: false,
        status: 409,
        error: 'Someone already decided this finding',
      };
    if (decided)
      await recordAudit(
        db,
        opts.ai
          ? {
              ...audit,
              action: 'finding.delegated',
              data: { ...facts, decision: 'approve', reason: opts.ai.reason },
            }
          : {
              ...audit,
              action: 'finding.approved',
              data: { ...facts, ...(reason ? { reason } : {}) },
            }
      );
  } else {
    const updated = await db
      .update(prReviewFlags)
      .set({
        changesRequestedById: userId,
        changesRequestedAt: new Date(),
        changesRequestedNote: note,
        // How this decision was made (approved_at stays null): the moderator app, or GitOrange AI.
        approvedVia: via,
        decisionReason: opts.ai ? opts.ai.reason : null,
        ...taught,
      })
      .where(open)
      .returning({ id: prReviewFlags.id });
    if (!updated.length)
      return opts.ai
        ? {
            ok: false,
            status: 409,
            error: 'Someone already decided this finding',
          }
        : { ok: false, status: 400, error: 'This flag is already approved' };
    decided = true;
    await recordAudit(
      db,
      opts.ai
        ? {
            ...audit,
            action: 'finding.delegated',
            data: {
              ...facts,
              decision: 'request_changes',
              reason: opts.ai.reason,
            },
          }
        : {
            ...audit,
            action: 'finding.changes_requested',
            data: { ...facts, note },
          }
    );
  }
  if (decided && teach)
    await recordAudit(db, {
      ...audit,
      action: 'finding.taught',
      data: { ...facts, teach },
    });
  after(
    maybeAutoMerge(env, db, pr.id).catch((e) =>
      console.error('[review] auto-merge failed', e)
    )
  );
  after(settleStates(env, db, pr.repositoryId));
  return { ok: true };
}

export type AssignResult =
  | { ok: true; assignee: PersonRef | null }
  | { ok: false; status: 400 | 404 | 422; error: string };

/**
 * Asks `login` to decide a finding (null clears it), as `byId`. The caller checks `byId` can push to the repository;
 * the assignee must be able to as well (the same rule as merging), and be a person, not a reviewer agent.
 */
export async function assignFlag(
  db: DrizzleDB,
  repo: { repo: Repository; fullName: string },
  pr: PullRequest,
  flagId: string,
  byId: string,
  login: string | null
): Promise<AssignResult> {
  if (pr.state !== 'open')
    return {
      ok: false,
      status: 400,
      error: 'This pull request is no longer open',
    };
  const flag = await loadFlag(db, pr, flagId);
  if (!flag) return { ok: false, status: 404, error: 'Not Found' };
  let assignee: { id: string; ref: PersonRef } | null = null;
  if (login !== null) {
    const user = await userByUsername(db, login.trim().replace(/^@/, ''));
    if (!user)
      return { ok: false, status: 404, error: `No one is called @${login}` };
    const agent = await db
      .select({ id: agents.userId })
      .from(agents)
      .where(eq(agents.userId, user.id))
      .get();
    if (agent)
      return {
        ok: false,
        status: 422,
        error: 'Reviewer agents raise findings: ask a person to decide them.',
      };
    if (!(await permissionsFor(db, repo.repo, user)).write)
      return {
        ok: false,
        status: 422,
        error: `@${user.username ?? login} can't push to ${repo.fullName}, so they can't decide its findings.`,
      };
    const ref = (await personRefs(db, [user.id])).get(user.id)!;
    assignee = { id: user.id, ref };
  }
  await db
    .update(prReviewFlags)
    .set({
      assigneeId: assignee?.id ?? null,
      assignedById: assignee ? byId : null,
      assignedAt: assignee ? new Date() : null,
    })
    .where(eq(prReviewFlags.id, flag.id));
  await recordAudit(db, {
    repositoryId: pr.repositoryId,
    actorId: byId,
    action: 'finding.assigned',
    target: flagTitle(flag.value),
    pull: pr.number,
    data: {
      finding: flag.id,
      kind: flag.kind,
      agent: flag.agent,
      assignee: assignee?.ref.login ?? null,
    },
  });
  return { ok: true, assignee: assignee?.ref ?? null };
}

export type UndoResult =
  { ok: true } | { ok: false; status: 403 | 404 | 409; error: string };

/**
 * Reopens a decision on a finding (an approval, a dismissal or a request for changes) while the pull request is
 * open: only for the person who made it, or whose GitOrange AI made it as them. Its reason and teach note go with
 * it, so nothing is learned from an undone decision.
 */
export async function undoFlag(
  env: CloudflareBindings,
  db: DrizzleDB,
  pr: PullRequest,
  flagId: string,
  userId: string,
  after: (work: Promise<unknown>) => void
): Promise<UndoResult> {
  const flag = await loadFlag(db, pr, flagId);
  if (!flag) return { ok: false, status: 404, error: 'Not Found' };
  if (pr.state !== 'open')
    return {
      ok: false,
      status: 409,
      error:
        pr.state === 'merged'
          ? 'This pull request already merged, so its decisions stay. Revert it instead.'
          : 'This pull request is closed, so its decisions stay.',
    };
  const approved = flag.approvedAt !== null;
  if (!approved && flag.changesRequestedAt === null)
    return {
      ok: false,
      status: 409,
      error: 'Nobody has decided this finding yet',
    };
  const decider = approved ? flag.approvedById : flag.changesRequestedById;
  if (decider !== userId)
    return {
      ok: false,
      status: 403,
      error:
        'Only the person who decided this finding (or whose GitOrange AI did) can undo it',
    };
  const reopened = await db
    .update(prReviewFlags)
    .set({
      approvedById: null,
      approvedAt: null,
      approvedVia: null,
      changesRequestedById: null,
      changesRequestedAt: null,
      changesRequestedNote: null,
      decisionReason: null,
      teachNote: null,
      teachById: null,
    })
    .where(
      and(
        eq(prReviewFlags.id, flag.id),
        approved
          ? eq(prReviewFlags.approvedAt, flag.approvedAt!)
          : eq(prReviewFlags.changesRequestedAt, flag.changesRequestedAt!)
      )
    )
    .returning({ id: prReviewFlags.id });
  if (!reopened.length)
    return {
      ok: false,
      status: 409,
      error: 'The decision changed since you looked',
    };
  await recordAudit(db, {
    repositoryId: pr.repositoryId,
    actorId: userId,
    action: 'finding.undone',
    target: flagTitle(flag.value),
    pull: pr.number,
    data: {
      finding: flag.id,
      kind: flag.kind,
      agent: flag.agent,
      undid: approved
        ? flag.kind === 'change_requested'
          ? 'dismissed'
          : 'approved'
        : 'changes_requested',
      via: flag.approvedVia,
    },
  });
  after(settleStates(env, db, pr.repositoryId));
  return { ok: true };
}
