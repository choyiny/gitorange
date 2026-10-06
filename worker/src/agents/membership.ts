import { and, eq } from 'drizzle-orm';
import { repositoryAgents } from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import { d1Of } from '../pulls/events';
import { settleStates } from '../pulls/settle';
import { autoMergeRepository } from '../review/auto-merge';
import {
  cancelAgentReviews,
  MAX_AGENTS_PER_REPOSITORY,
} from '../review/reviewers';
import { agentByHandle } from './accounts';

// Inviting and removing an agent, shared by Repository settings → Agents and the MCP tools. Callers check that the
// user is an admin of the repository.

export type MembershipResult =
  { ok: true } | { ok: false; status: 400 | 404; error: string };

const NOT_FOUND = {
  ok: false,
  status: 404,
  error: 'Agent not found',
} as const;

/** Invites a live agent; inviting it again is a no-op. Refused past `MAX_AGENTS_PER_REPOSITORY`. */
export async function inviteAgent(
  db: DrizzleDB,
  repositoryId: string,
  handle: string,
  inviterId: string
): Promise<MembershipResult> {
  const view = await agentByHandle(db, handle);
  if (!view || view.agent.deletedAt) return NOT_FOUND;
  // One guarded insert, so racing invitations never pass the cap.
  const { meta } = await d1Of(db)
    .prepare(
      `INSERT INTO repository_agents (repository_id, agent_id, invited_by_id, created_at)
       SELECT ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM repository_agents WHERE repository_id = ?) < ?
       ON CONFLICT DO NOTHING`
    )
    .bind(
      repositoryId,
      view.agent.userId,
      inviterId,
      Math.floor(Date.now() / 1000),
      repositoryId,
      MAX_AGENTS_PER_REPOSITORY
    )
    .run();
  if (meta.changes) return { ok: true };
  const already = await db
    .select({ id: repositoryAgents.agentId })
    .from(repositoryAgents)
    .where(
      and(
        eq(repositoryAgents.repositoryId, repositoryId),
        eq(repositoryAgents.agentId, view.agent.userId)
      )
    )
    .get();
  if (already) return { ok: true };
  return {
    ok: false,
    status: 400,
    error: `A repository can invite at most ${MAX_AGENTS_PER_REPOSITORY} agents. Remove one first.`,
  };
}

/**
 * Uninvites an agent (a no-op if it wasn't invited) and cancels its reviews here. Pull request states change and
 * ones it held back may land: that work goes to `after`.
 */
export async function removeAgent(
  env: CloudflareBindings,
  db: DrizzleDB,
  repositoryId: string,
  handle: string,
  after: (work: Promise<unknown>) => void
): Promise<{ ok: true } | typeof NOT_FOUND> {
  const view = await agentByHandle(db, handle);
  if (!view) return NOT_FOUND;
  await db
    .delete(repositoryAgents)
    .where(
      and(
        eq(repositoryAgents.repositoryId, repositoryId),
        eq(repositoryAgents.agentId, view.agent.userId)
      )
    );
  await cancelAgentReviews(db, view.agent.userId, repositoryId);
  after(settleStates(env, db, repositoryId));
  after(autoMergeRepository(env, db, repositoryId));
  return { ok: true };
}
