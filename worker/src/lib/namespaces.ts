import { eq, sql } from 'drizzle-orm';
import { teams } from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import { isReservedUsername, USERNAME_RE } from './usernames';

/**
 * Usernames and the team slug share one URL namespace (`/<name>/<repo>`), so neither may take
 * a name the other already uses. Comparison is case-insensitive, like the URLs.
 */
export async function namespaceTaken(
  db: DrizzleDB,
  name: string,
  except?: { teamId?: string; userId?: string }
) {
  const n = name.toLowerCase();
  const team = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.slug, n))
    .get();
  if (team && team.id !== except?.teamId) return true;
  const user = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = ${n}`)
    .get();
  return !!user && user.id !== except?.userId;
}

export function isValidSlug(slug: string) {
  return USERNAME_RE.test(slug) && !isReservedUsername(slug);
}
