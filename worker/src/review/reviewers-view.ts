import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  agents,
  prReviewers,
  prReviewFlags,
  repositories,
  repositoryAgents,
  type PrReviewFlag,
  type PullRequest,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { GitService } from '../git/service';
import { personRefs, type PersonRef } from '../lib/person-ref';
import { usersById, type PublicUser } from '../lib/users';
import { resolutionConfigured } from '../merge/resolution';
import { autoMergeStatus, type AutoMergeStatus } from './auto-merge';
import { flagTitleOf, reviewGateFor, type ReviewVerdict } from './gate';
import { chunks } from '../stack/view';
import { hasInvitedAgents, headReviewFor, headReviewId } from './keys';

/** Earlier commits' reviews the page shows, newest first. */
export const EARLIER_REVIEWS_MAX = 50;

/**
 * A flag as the API shows it. `guarded`: its agent's (agents.guarded); `refs`: PersonRefs holding its assignee (a
 * flag whose assignee isn't in them shows none).
 */
export function flagJson(
  f: PrReviewFlag,
  people: Map<string, PublicUser>,
  opts: { guarded?: boolean; refs?: Map<string, PersonRef> } = {}
) {
  const decided = !!(f.approvedAt || f.changesRequestedAt);
  return {
    id: f.id,
    kind: f.kind,
    title: flagTitleOf(f),
    paths: f.paths,
    detail: f.detail,
    detailModel: f.detailModel,
    agentSha: f.agentSha,
    approvedBy: f.approvedById ? (people.get(f.approvedById) ?? null) : null,
    approvedAt: f.approvedAt?.toISOString() ?? null,
    approvedVia: f.approvedAt ? f.approvedVia : null,
    changesRequestedBy: f.changesRequestedById
      ? (people.get(f.changesRequestedById) ?? null)
      : null,
    changesRequestedAt: f.changesRequestedAt?.toISOString() ?? null,
    changesRequestedNote: f.changesRequestedAt ? f.changesRequestedNote : null,
    /** needs_person: the agent's plain yes/no question for the owner. */
    question: f.question,
    /** Never approved in bulk, by one key or by AI; approving it needs a reason. */
    guarded: opts.guarded ?? false,
    assignee: f.assigneeId ? (opts.refs?.get(f.assigneeId) ?? null) : null,
    /** How the current decision was made: a moderator app, or "GitOrange AI"; null from the web or while open. */
    decidedVia: decided ? f.approvedVia : null,
    /** The decider's reason (GitOrange AI's, or a person's for an approval). */
    reason: decided ? f.decisionReason : null,
    /** What the decider taught the agent with the decision. */
    teach: decided ? f.teachNote : null,
  };
}
export type FlagJson = ReturnType<typeof flagJson>;

/**
 * The review of a pull request's head commit, for its page and MCP: every invited agent's row (requested or
 * not), their findings, who approved, the verdict and auto-merge. `earlier`: requested agents' reviews of the
 * pull request's previous head commits, read-only history (MCP leaves them out).
 */
export async function reviewersView(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest,
  shas: { base: string; head: string } | null
) {
  if (!shas) return null;
  const open = pr.state === 'open';
  const review = await headReviewFor(db, pr.id, shas.head);
  const rows = await db
    .select({
      r: prReviewers,
      handle: users.username,
      name: users.name,
      image: users.image,
      agentRepo: repositories.name,
      invited: repositoryAgents.agentId,
      guarded: agents.guarded,
    })
    .from(prReviewers)
    .innerJoin(users, eq(users.id, prReviewers.agentId))
    .leftJoin(agents, eq(agents.userId, prReviewers.agentId))
    .leftJoin(repositories, eq(repositories.id, agents.repositoryId))
    .leftJoin(
      repositoryAgents,
      and(
        eq(repositoryAgents.repositoryId, pr.repositoryId),
        eq(repositoryAgents.agentId, prReviewers.agentId)
      )
    )
    .where(
      and(
        eq(prReviewers.pullRequestId, pr.id),
        eq(prReviewers.headSha, shas.head)
      )
    )
    .orderBy(asc(users.username))
    .all();
  const flags = review
    ? await db
        .select()
        .from(prReviewFlags)
        .where(eq(prReviewFlags.classificationId, review.id))
        // `<agent id>:<index>`: an agent's findings in the order it gave them (they share a created_at second).
        .orderBy(asc(prReviewFlags.key))
        .all()
    : [];
  const earlierRows = await db
    .select({
      r: prReviewers,
      handle: users.username,
      name: users.name,
      image: users.image,
    })
    .from(prReviewers)
    .innerJoin(users, eq(users.id, prReviewers.agentId))
    .where(
      and(
        eq(prReviewers.pullRequestId, pr.id),
        ne(prReviewers.headSha, shas.head),
        eq(prReviewers.requested, true),
        ne(prReviewers.status, 'not_needed')
      )
    )
    .orderBy(desc(prReviewers.createdAt), desc(prReviewers.id))
    .limit(EARLIER_REVIEWS_MAX)
    .all();
  // Their findings in one query (EARLIER_REVIEWS_MAX keeps it to one chunk), matched to agents below.
  const earlierFlags: PrReviewFlag[] = [];
  for (const part of chunks(
    [...new Set(earlierRows.map(({ r }) => headReviewId(pr.id, r.headSha)))],
    90
  ))
    earlierFlags.push(
      ...(await db
        .select()
        .from(prReviewFlags)
        .where(inArray(prReviewFlags.classificationId, part))
        .orderBy(asc(prReviewFlags.key))
        .all())
    );
  const people = await usersById(
    db,
    [...flags, ...earlierFlags]
      .flatMap((f) => [f.approvedById, f.changesRequestedById])
      .filter((id): id is string => !!id)
  );
  const refs = await personRefs(
    db,
    flags.map((f) => f.assigneeId)
  );
  const status: AutoMergeStatus = open
    ? await autoMergeStatus(env, db, git, pr)
    : { state: 'off' };
  const verdict: ReviewVerdict | null = open
    ? await reviewGateFor(db, resolutionConfigured(env), pr, shas.head)
    : null;
  return {
    headSha: shas.head,
    agentsInvited: await hasInvitedAgents(db, pr.repositoryId),
    status: review?.status ?? null,
    errorMessage: review?.errorMessage ?? null,
    summaryModel: review?.summaryModel ?? null,
    files: review?.files ?? [],
    createdAt: review?.createdAt.toISOString() ?? null,
    durationMs: review?.durationMs ?? null,
    reviewers: rows.map(
      ({ r, handle, name, image, agentRepo, invited, guarded }) => ({
        id: r.id,
        agent: { id: r.agentId, username: handle ?? r.agentId, name, image },
        agentRepository: agentRepo && handle ? `${handle}/${agentRepo}` : null,
        invited: !!invited,
        status: r.status,
        requested: r.requested,
        probability: r.probability,
        agentSha: r.agentSha,
        summary: r.summary,
        error: r.error,
        createdAt: r.createdAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        flags: flags
          .filter((f) => f.agentId === r.agentId)
          .map((f) => flagJson(f, people, { guarded: !!guarded, refs })),
      })
    ),
    earlier: earlierRows.map(({ r, handle, name, image }) => ({
      id: r.id,
      headSha: r.headSha,
      agent: { id: r.agentId, username: handle ?? r.agentId, name, image },
      status: r.status,
      summary: r.summary,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      flags: earlierFlags
        .filter(
          (f) =>
            f.classificationId === headReviewId(pr.id, r.headSha) &&
            f.agentId === r.agentId
        )
        .map((f) => flagJson(f, people)),
    })),
    verdict,
    autoMerge: {
      state: status.state,
      reasons: 'reasons' in status ? status.reasons : [],
      disabledAt: status.state === 'disabled' ? status.at.toISOString() : null,
    },
  };
}
export type ReviewersView = NonNullable<
  Awaited<ReturnType<typeof reviewersView>>
>;
