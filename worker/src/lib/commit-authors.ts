import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import { users } from '../db/auth.schema';
import { userEmails } from '../db/app.schema';
import type { Commit } from '../git/service';
import { toPublicUser, type PublicUser } from './users';

type Identity = { name: string; email: string };
export type AttributedCommit<C extends Commit = Commit> = Omit<
  C,
  'author' | 'committer'
> & {
  author: Identity & { user: PublicUser | null };
  committer: Identity & { user: PublicUser | null };
};

/**
 * Members by commit email: their account (primary) email or a *verified* alternate. Two queries
 * for any number of emails, so a page of commits never costs a lookup per commit.
 */
export async function usersByCommitEmail(
  db: DrizzleDB,
  emails: string[]
): Promise<Map<string, PublicUser>> {
  const wanted = [
    ...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean)),
  ];
  if (!wanted.length) return new Map();
  const [primary, alternates] = await Promise.all([
    db
      .select()
      .from(users)
      .where(inArray(sql`lower(${users.email})`, wanted))
      .all(),
    db
      .select({ email: userEmails.email, user: users })
      .from(userEmails)
      .innerJoin(users, eq(users.id, userEmails.userId))
      .where(
        and(inArray(userEmails.email, wanted), isNotNull(userEmails.verifiedAt))
      )
      .all(),
  ]);
  const found = new Map<string, PublicUser>();
  for (const r of alternates) found.set(r.email, toPublicUser(r.user));
  // The account email wins if an address were ever both.
  for (const u of primary) found.set(u.email.toLowerCase(), toPublicUser(u));
  return found;
}

/** Adds `user` (the member who owns the email, or null) to each commit's author and committer. */
export async function attributeCommits<C extends Commit>(
  db: DrizzleDB,
  commits: C[]
): Promise<AttributedCommit<C>[]> {
  const people = await usersByCommitEmail(
    db,
    commits.flatMap((c) => [c.author.email, c.committer.email])
  );
  const who = (i: Identity) => ({
    ...i,
    user: people.get(i.email.trim().toLowerCase()) ?? null,
  });
  // New objects: GitService caches commit metadata, so never mutate what it returns.
  return commits.map((c) => ({
    ...c,
    author: who(c.author),
    committer: who(c.committer),
  }));
}
