import { eq } from 'drizzle-orm';
import { agents } from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';

/** The domain of every agent's account email. */
export const AGENT_EMAIL_DOMAIN = 'agents.invalid';

/** An agent's account email: unique, and unable to receive mail (RFC 2606 reserves `.invalid`). */
export const agentEmail = (userId: string) => `${userId}@${AGENT_EMAIL_DOMAIN}`;

/** The agent's profile picture: avatar.png in its repository at `sha`. Stable across repository renames. */
export const avatarUrl = (handle: string, sha: string) =>
  `/api/agents/${handle}/avatar?v=${sha}`;

/** Whether this account is an agent's (deleted agents included). The auth layer refuses these. */
export async function isAgentUser(db: DrizzleDB, userId: string) {
  return !!(await db
    .select({ id: agents.userId })
    .from(agents)
    .where(eq(agents.userId, userId))
    .get());
}
