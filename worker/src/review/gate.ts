import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  prApprovals,
  prClassifications,
  prReviewers,
  prReviewFlags,
  workflowRuns,
  type PullRequest,
  type ReviewerStatus,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { Reason } from '../pulls/state';
import { chunks } from '../stack/view';
import { checkVerdict, type CheckVerdict } from './checks';
import { hasInvitedAgents, headReviewId } from './keys';

export type ReviewReason = Extract<
  Reason,
  {
    kind:
      | 'agent_reviewing'
      | 'agent_flagged'
      | 'agent_changes_requested'
      | 'agent_review_failed'
      | 'needs_approval'
      | 'changes_requested';
  }
>;

export type GateReviewer = {
  agentId: string;
  handle: string;
  status: ReviewerStatus;
  requested: boolean;
  error: string | null;
};

export type GateFlag = {
  id: string;
  agentId: string | null;
  kind: 'needs_person' | 'change_requested';
  title: string;
  detail: string | null;
  /** Approved (needs_person) or dismissed (change_requested) by a person. */
  approved: boolean;
  /** A person asked for changes on it (needs_person only). */
  changesRequested: boolean;
};

export type GateInput = {
  agentsInvited: boolean;
  /** Reviews can run here (`reviewConfigured(env)`). */
  aiReview: boolean;
  /** The head commit's review; null when none ran. */
  review: { status: string; errorMessage: string | null } | null;
  /** Its reviewer rows whose agent is still invited. */
  reviewers: GateReviewer[];
  /** Its agent flags. */
  flags: GateFlag[];
  /** People who approved the head commit. */
  approvedBy: string[];
};

export type ReviewVerdict = { satisfied: boolean; reasons: ReviewReason[] };

const sentence = (detail: string | null) =>
  detail ? (detail.trim().split('\n')[0] ?? '').slice(0, 300) || null : null;

/**
 * Whether review is satisfied for one head commit, and if not, why (as pull-state reasons). Every requested agent
 * that is still invited must have approved, or have every needs_person flag approved and every change request
 * dismissed; with no such agent, the commit needs a person's approval (or waits while its review hasn't requested
 * anyone yet). A person's approval of the commit stands over everything except an agent's open change request:
 * that must be dismissed, or a new commit pushed, first.
 */
export function reviewVerdict(i: GateInput): ReviewVerdict {
  const agents = agentVerdict(i);
  if (!i.approvedBy.length) return agents;
  const changes = agents.reasons.filter(
    (r) => r.kind === 'agent_changes_requested'
  );
  return { satisfied: !changes.length, reasons: changes };
}

/**
 * What a person's approval of the commit stands over (recorded with it): agents' findings for a person, people's
 * change requests on them, unfinished and failed agent reviews. Not open change requests (it doesn't stand over
 * them) and not needs_approval (that is what an approval is for).
 */
export function approvalOverrides(i: GateInput): ReviewReason[] {
  return agentVerdict(i).reasons.filter(
    (r) => r.kind !== 'agent_changes_requested' && r.kind !== 'needs_approval'
  );
}

/** The verdict from agents alone, before any person's approval. */
function agentVerdict(i: GateInput): ReviewVerdict {
  const counted = i.reviewers.filter(
    (r) => r.requested && r.status !== 'not_needed'
  );
  if (!counted.length) {
    if (i.review?.status === 'failed')
      return {
        satisfied: false,
        reasons: [
          {
            kind: 'agent_review_failed',
            agent: null,
            error: i.review.errorMessage,
          },
        ],
      };
    if (i.agentsInvited && i.aiReview && i.review?.status !== 'done')
      return {
        satisfied: false,
        reasons: [{ kind: 'agent_reviewing', agent: null }],
      };
    return { satisfied: false, reasons: [{ kind: 'needs_approval' }] };
  }
  const reasons: ReviewReason[] = [];
  let personChanges = 0;
  for (const r of counted) {
    if (r.status === 'reviewing') {
      reasons.push({ kind: 'agent_reviewing', agent: r.handle });
      continue;
    }
    if (r.status === 'failed') {
      reasons.push({
        kind: 'agent_review_failed',
        agent: r.handle,
        error: r.error,
      });
      continue;
    }
    const open = i.flags.filter((f) => f.agentId === r.agentId && !f.approved);
    const changes = open.filter((f) => f.kind === 'change_requested');
    if (changes.length)
      reasons.push({
        kind: 'agent_changes_requested',
        agent: r.handle,
        changes: changes.map((f) => ({
          id: f.id,
          title: f.title,
          detail: sentence(f.detail),
        })),
      });
    const person = open.filter((f) => f.kind === 'needs_person');
    personChanges += person.filter((f) => f.changesRequested).length;
    const waiting = person.filter((f) => !f.changesRequested);
    if (waiting.length)
      reasons.push({
        kind: 'agent_flagged',
        agent: r.handle,
        flags: waiting.map((f) => ({ id: f.id, title: f.title })),
      });
  }
  if (personChanges)
    reasons.push({ kind: 'changes_requested', flags: personChanges });
  return { satisfied: !reasons.length, reasons };
}

export type ListReview = {
  state:
    | 'reviewing'
    | 'failed'
    | 'changes_requested'
    | 'review_required'
    | 'needs_approval'
    | 'approved';
  /** Findings waiting for a person (review_required). */
  flags: number;
};

/** The pull request list's one-word review state, most urgent first. */
export function listReview(v: ReviewVerdict): ListReview {
  const has = (k: ReviewReason['kind']) => v.reasons.some((r) => r.kind === k);
  const flags = v.reasons.reduce(
    (n, r) => n + (r.kind === 'agent_flagged' ? r.flags.length : 0),
    0
  );
  if (v.satisfied) return { state: 'approved', flags: 0 };
  if (has('agent_review_failed')) return { state: 'failed', flags };
  if (has('agent_changes_requested') || has('changes_requested'))
    return { state: 'changes_requested', flags };
  if (flags) return { state: 'review_required', flags };
  if (has('agent_reviewing')) return { state: 'reviewing', flags: 0 };
  return { state: 'needs_approval', flags: 0 };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A reason in a few words: auto-merge's waiting list and a refused merge's message. */
export function reviewReasonText(r: ReviewReason): string {
  switch (r.kind) {
    case 'agent_reviewing':
      return r.agent
        ? `@${r.agent} is reviewing`
        : 'Agents are reviewing the changes';
    case 'agent_flagged':
      return `@${r.agent} flagged ${plural(r.flags.length, 'finding')} for a person`;
    case 'agent_changes_requested':
      return `@${r.agent} requested ${plural(r.changes.length, 'change')}`;
    case 'agent_review_failed':
      return `${r.agent ? `@${r.agent}'s review` : 'The review'} failed${r.error ? `: ${r.error}` : ''}`;
    case 'needs_approval':
      return 'No agent reviewed it: a person needs to approve it';
    case 'changes_requested':
      return `Changes requested on ${plural(r.flags, 'flag')}`;
  }
}

/** A flag's heading: an agent finding's title, or a retired review.yml flag's question id or limit. */
export function flagTitleOf(f: {
  source: string;
  key: string;
  value: unknown;
}): string {
  if (f.source === 'agent') {
    const title = (f.value as { title?: unknown } | null)?.title;
    return typeof title === 'string' && title ? title : 'Finding';
  }
  if (f.source === 'limit')
    return f.key === 'max_files'
      ? 'Too many files to review automatically'
      : 'Files that could not be summarized';
  return f.key;
}

/**
 * The gate's inputs for many pull requests of one repository at their head commits, in a fixed number of
 * chunked queries (D1 binds at most 100 parameters).
 */
export async function reviewInputs(
  db: DrizzleDB,
  repositoryId: string,
  tips: { pullRequestId: string; head: string }[],
  aiReview: boolean
): Promise<Map<string, GateInput>> {
  const out = new Map<string, GateInput>();
  if (!tips.length) return out;
  const agentsInvited = await hasInvitedAgents(db, repositoryId);
  const ids = tips.map((t) => headReviewId(t.pullRequestId, t.head));
  const reviews = new Map<
    string,
    { status: string; errorMessage: string | null }
  >();
  const flags: (GateFlag & { classificationId: string })[] = [];
  for (const part of chunks(ids, 90)) {
    for (const r of await db
      .select({
        id: prClassifications.id,
        status: prClassifications.status,
        errorMessage: prClassifications.errorMessage,
      })
      .from(prClassifications)
      .where(inArray(prClassifications.id, part))
      .all())
      reviews.set(r.id, r);
    for (const f of await db
      .select({
        id: prReviewFlags.id,
        classificationId: prReviewFlags.classificationId,
        agentId: prReviewFlags.agentId,
        kind: prReviewFlags.kind,
        source: prReviewFlags.source,
        key: prReviewFlags.key,
        value: prReviewFlags.value,
        detail: prReviewFlags.detail,
        approvedAt: prReviewFlags.approvedAt,
        changesRequestedAt: prReviewFlags.changesRequestedAt,
      })
      .from(prReviewFlags)
      .where(
        and(
          inArray(prReviewFlags.classificationId, part),
          eq(prReviewFlags.source, 'agent')
        )
      )
      .all())
      flags.push({
        id: f.id,
        classificationId: f.classificationId,
        agentId: f.agentId,
        kind: f.kind,
        title: flagTitleOf(f),
        detail: f.detail,
        approved: !!f.approvedAt,
        changesRequested: !!f.changesRequestedAt,
      });
  }
  const reviewerRows: (GateReviewer & {
    pullRequestId: string;
    headSha: string;
    invited: number;
  })[] = [];
  const approvals: {
    pullRequestId: string;
    headSha: string;
    userId: string;
  }[] = [];
  // 45 pull requests and at most 45 heads (+1) per statement.
  for (const part of chunks(tips, 45)) {
    const prIds = part.map((t) => t.pullRequestId);
    const heads = [...new Set(part.map((t) => t.head))];
    for (const r of await db
      .select({
        pullRequestId: prReviewers.pullRequestId,
        headSha: prReviewers.headSha,
        agentId: prReviewers.agentId,
        handle: users.username,
        status: prReviewers.status,
        requested: prReviewers.requested,
        error: prReviewers.error,
        invited: sql<number>`EXISTS (SELECT 1 FROM repository_agents ra WHERE ra.repository_id = ${repositoryId} AND ra.agent_id = ${prReviewers.agentId})`,
      })
      .from(prReviewers)
      .innerJoin(users, eq(users.id, prReviewers.agentId))
      .where(
        and(
          inArray(prReviewers.pullRequestId, prIds),
          inArray(prReviewers.headSha, heads)
        )
      )
      .all())
      reviewerRows.push({ ...r, handle: r.handle ?? r.agentId });
    approvals.push(
      ...(await db
        .select({
          pullRequestId: prApprovals.pullRequestId,
          headSha: prApprovals.headSha,
          userId: prApprovals.userId,
        })
        .from(prApprovals)
        .where(
          and(
            inArray(prApprovals.pullRequestId, prIds),
            inArray(prApprovals.headSha, heads)
          )
        )
        .all())
    );
  }
  for (const t of tips) {
    const id = headReviewId(t.pullRequestId, t.head);
    const at = (x: { pullRequestId: string; headSha: string }) =>
      x.pullRequestId === t.pullRequestId && x.headSha === t.head;
    out.set(t.pullRequestId, {
      agentsInvited,
      aiReview,
      review: reviews.get(id) ?? null,
      reviewers: reviewerRows
        .filter((r) => at(r) && Number(r.invited))
        .sort((a, b) => a.handle.localeCompare(b.handle))
        .map(({ agentId, handle, status, requested, error }) => ({
          agentId,
          handle,
          status,
          requested,
          error,
        })),
      flags: flags.filter((f) => f.classificationId === id),
      approvedBy: approvals.filter(at).map((a) => a.userId),
    });
  }
  return out;
}

/** The gate for one pull request at `head`. */
export async function reviewGateFor(
  db: DrizzleDB,
  aiReview: boolean,
  pr: Pick<PullRequest, 'id' | 'repositoryId'>,
  head: string
): Promise<ReviewVerdict> {
  const inputs = await reviewInputs(
    db,
    pr.repositoryId,
    [{ pullRequestId: pr.id, head }],
    aiReview
  );
  return reviewVerdict(inputs.get(pr.id)!);
}

/** Whether a commit's Actions runs hold it up: a failed latest run fails, an unfinished one waits, none is fine. */
export async function checksAt(
  db: DrizzleDB,
  repositoryId: string,
  sha: string
): Promise<CheckVerdict | null> {
  const runs = await db
    .select({
      runNumber: workflowRuns.runNumber,
      status: workflowRuns.status,
      conclusion: workflowRuns.conclusion,
      workflowPath: workflowRuns.workflowPath,
      event: workflowRuns.event,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.repositoryId, repositoryId),
        eq(workflowRuns.headSha, sha)
      )
    )
    .all();
  return checkVerdict(runs, [], 'any');
}
