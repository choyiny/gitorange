import { eq, inArray } from 'drizzle-orm';
import { agents } from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import { agentColor } from '../agents/presets';

/** Someone a page names: a member, or a reviewer agent (then `isAgent`, with its colour). `login` is the handle. */
export type PersonRef = {
  login: string;
  name: string | null;
  isAgent: boolean;
  color: string | null;
};

/** The person behind each of `ids` (members and agents), keyed by user id; ids with no account are left out. */
export async function personRefs(
  db: DrizzleDB,
  ids: (string | null | undefined)[]
): Promise<Map<string, PersonRef>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  const out = new Map<string, PersonRef>();
  if (!unique.length) return out;
  // D1 caps a statement's parameters; ids come from one page of rows, but stay well under it anyway.
  for (let i = 0; i < unique.length; i += 90) {
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        name: users.name,
        agentColor: agents.color,
        agent: agents.userId,
      })
      .from(users)
      .leftJoin(agents, eq(agents.userId, users.id))
      .where(inArray(users.id, unique.slice(i, i + 90)))
      .all();
    for (const r of rows) {
      const login = r.username ?? r.id;
      out.set(r.id, {
        login,
        name: r.name,
        isAgent: r.agent !== null,
        color:
          r.agent !== null ? agentColor({ color: r.agentColor }, login) : null,
      });
    }
  }
  return out;
}

/** Stands in for an author whose account is gone, as the pull request pages do ("Deleted user"). */
export const GHOST: PersonRef = {
  login: 'ghost',
  name: 'Deleted user',
  isAgent: false,
  color: null,
};

/** The same stand-in, under the name the approvals code uses. */
export const GHOST_REF = GHOST;
