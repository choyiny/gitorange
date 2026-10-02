import { eq, inArray } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import { users } from '../db/auth.schema';

export type PublicUser = {
  id: string;
  username: string;
  name: string;
  image: string | null;
};

export function toPublicUser(u: {
  id: string;
  username?: string | null;
  name: string;
  image?: string | null;
}): PublicUser {
  return {
    id: u.id,
    username: u.username ?? u.id,
    name: u.name,
    image: u.image ?? null,
  };
}

export async function usersById(
  db: DrizzleDB,
  ids: string[]
): Promise<Map<string, PublicUser>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await db
    .select()
    .from(users)
    .where(inArray(users.id, unique))
    .all();
  return new Map(rows.map((u) => [u.id, toPublicUser(u)]));
}

export async function userByUsername(db: DrizzleDB, username: string) {
  return db
    .select()
    .from(users)
    .where(eq(users.username, username.toLowerCase()))
    .get();
}
