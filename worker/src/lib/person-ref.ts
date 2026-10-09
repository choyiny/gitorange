import { eq, inArray } from 'drizzle-orm';
import { agentColor } from '../agents/presets';
import { agents } from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import { chunks } from '../stack/view';

/** Who someone is, as the crew pages show them: a person or a reviewer agent (with its colour). */
export type PersonRef = {
  /** The username, or the agent's handle. */
  login: string;
  name: string | null;
  isAgent: boolean;
  /** An agent's colour (agentColor); null for a person. */
  color: string | null;
};

/** A user id nothing resolves any more. */
export const GHOST_REF: PersonRef = {
  login: 'ghost',
  name: 'Deleted user',
  isAgent: false,
  color: null,
};

/** PersonRefs for user ids, in a fixed number of chunked queries; ids nobody has are left out. */
export async function personRefs(
  db: DrizzleDB,
  ids: (string | null | undefined)[]
): Promise<Map<string, PersonRef>> {
  const out = new Map<string, PersonRef>();
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  for (const part of chunks(unique, 90))
    for (const r of await db
      .select({
        id: users.id,
        username: users.username,
        name: users.name,
        agent: agents.userId,
        color: agents.color,
      })
      .from(users)
      .leftJoin(agents, eq(agents.userId, users.id))
      .where(inArray(users.id, part))
      .all()) {
      const login = r.username ?? r.id;
      out.set(r.id, {
        login,
        name: r.name ?? null,
        isAgent: !!r.agent,
        color: r.agent ? agentColor({ color: r.color }, login) : null,
      });
    }
  return out;
}
