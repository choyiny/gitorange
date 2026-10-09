import { and, eq, sql } from 'drizzle-orm';
import { agentColor } from '../agents/presets';
import {
  agents,
  aiDelegations,
  auditEvents,
  prClassifications,
  prReviewFlags,
  pullRequests,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import { auditEventsWhere } from '../lib/audit';
import { landTargetOf } from '../lib/land-target';
import { GHOST_REF, personRefs } from '../lib/person-ref';
import { findRepoById, gitFor, permissionsFor } from '../lib/repos';
import type { SessionUser } from '../variables';
import { flagTitleOf } from './gate';

/** How many audit entries one finding's history shows. */
const HISTORY_MAX = 100;

const ms = (d: Date | null) => (d ? d.getTime() : null);

/**
 * One finding for its own page (/approvals/:flagId): what the agent found (its question, the detail with the diff
 * excerpts it cites), its pull request and agent, who decides it and how it was decided, its audit history (oldest
 * first), and what `user` can do with it. Null when there is no such finding or `user` can't read its repository.
 */
export async function findingDetail(
  env: CloudflareBindings,
  db: DrizzleDB,
  user: SessionUser,
  flagId: string
) {
  const row = await db
    .select({
      flag: prReviewFlags,
      headSha: prClassifications.headSha,
      pr: pullRequests,
      agent: agents,
      handle: users.username,
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
    .leftJoin(agents, eq(agents.userId, prReviewFlags.agentId))
    .leftJoin(users, eq(users.id, prReviewFlags.agentId))
    .where(eq(prReviewFlags.id, flagId))
    .get();
  if (!row) return null;
  const found = await findRepoById(db, row.pr.repositoryId);
  if (!found) return null;
  const perms = await permissionsFor(db, found.repo, user);
  if (!perms.read) return null;
  const { flag: f, pr, agent } = row;
  const handle = row.handle ?? f.agentId ?? 'agent';
  const [refs, tip, history, delegation] = await Promise.all([
    personRefs(db, [
      pr.authorId,
      f.approvedById,
      f.changesRequestedById,
      f.assigneeId,
      f.assignedById,
      f.teachById,
    ]),
    pr.state === 'open'
      ? gitFor(env, found.repo)
          .resolve(pr.headRef)
          .catch(() => null)
      : Promise.resolve(null),
    auditEventsWhere(
      db,
      and(
        eq(auditEvents.repositoryId, found.repo.id),
        sql`json_extract(${auditEvents.data}, '$.finding') = ${f.id}`
      ),
      { order: 'asc', limit: HISTORY_MAX }
    ),
    agent
      ? db
          .select({ id: aiDelegations.agentId })
          .from(aiDelegations)
          .where(
            and(
              eq(aiDelegations.userId, user.id),
              eq(aiDelegations.agentId, agent.userId)
            )
          )
          .get()
      : Promise.resolve(undefined),
  ]);
  const ref = (id: string | null) => (id ? (refs.get(id) ?? GHOST_REF) : null);
  const approved = f.approvedAt !== null;
  const decided = approved || f.changesRequestedAt !== null;
  const deciderId = approved ? f.approvedById : f.changesRequestedById;
  const guarded = agent?.guarded ?? false;
  const open = pr.state === 'open';
  const write = perms.write && open;
  return {
    id: f.id,
    kind: f.kind,
    title: flagTitleOf(f),
    question: f.question,
    detail: f.detail,
    detailModel: f.detailModel,
    paths: f.paths,
    agentSha: f.agentSha,
    /** The commit the finding was raised on. */
    headSha: row.headSha,
    createdAt: f.createdAt.getTime(),
    guarded,
    state: approved
      ? f.kind === 'change_requested'
        ? ('dismissed' as const)
        : ('approved' as const)
      : f.changesRequestedAt
        ? ('changes_requested' as const)
        : ('open' as const),
    decidedBy: decided ? ref(deciderId) : null,
    decidedAt: ms(f.approvedAt ?? f.changesRequestedAt),
    decidedVia: decided ? f.approvedVia : null,
    reason: decided ? f.decisionReason : null,
    note: f.changesRequestedAt ? f.changesRequestedNote : null,
    teach: decided ? f.teachNote : null,
    teachBy: decided ? ref(f.teachById) : null,
    assignee: ref(f.assigneeId),
    assignedBy: ref(f.assignedById),
    assignedAt: ms(f.assignedAt),
    repo: {
      fullName: `${found.namespace.username}/${found.repo.name}`,
      name: found.repo.name,
    },
    pull: {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      author: ref(pr.authorId) ?? GHOST_REF,
      headRef: pr.headRef,
      landTarget: landTargetOf(pr),
      /** The branch tip now (null once closed, or when it can't be read). */
      headSha: tip,
    },
    agent: agent
      ? {
          login: handle,
          name: agent.name,
          color: agentColor(agent, handle),
          facet: agent.facet,
          guarded,
          bio: agent.bio,
          repository: agent.repositoryId ? `${handle}/${handle}` : null,
        }
      : null,
    /** The viewer lets GitOrange AI decide this agent's findings on their pull requests. */
    delegated: !!delegation && !guarded,
    can: {
      decide: write,
      undo: write && decided && deciderId === user.id,
      delegate: write && !decided && f.kind === 'needs_person' && !guarded,
      assign: write,
    },
    history: history.map(({ repositoryId: _r, ...e }) => e),
  };
}
export type FindingDetail = NonNullable<
  Awaited<ReturnType<typeof findingDetail>>
>;
