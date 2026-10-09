import { and, eq, isNull, sql } from 'drizzle-orm';
import { agents, repositories } from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import { gitFor } from '../lib/repos';
import { avatarUrl } from './identity';
import { AVATAR_PATH, readAgentConfig } from './config';

/**
 * After a push or merge: if `repositoryId` is an agent's repository and its default branch moved, re-reads
 * AGENT.md and avatar.png there. A valid AGENT.md replaces the cached fields (and the account's display
 * name); an invalid one only records `config_error`, keeping the last valid fields. Costs one indexed lookup
 * for every other repository. Never throws.
 *
 * Concurrent refreshes (two quick pushes) can finish out of order, so the write is skipped if the default
 * branch has moved since it was read, and the agents update is a compare-and-swap on the `config_sha` and
 * `config_error` read at the start; the users update runs only if that swap took (`changes()` in the same
 * batch), so a stale refresh writes nothing. A refresh that loses the swap runs once more from a fresh read
 * of the row and the head, so the last refresh to finish never leaves an older commit's fields behind.
 */
export async function refreshAgentConfig(
  env: CloudflareBindings,
  db: DrizzleDB,
  repositoryId: string
): Promise<void> {
  try {
    if ((await refreshOnce(env, db, repositoryId)) === 'lost')
      await refreshOnce(env, db, repositoryId);
  } catch (e) {
    console.error('[agents] config refresh failed', repositoryId, e);
  }
}

/** One read-and-write pass; `lost` when another write changed the agents row in between. */
async function refreshOnce(
  env: CloudflareBindings,
  db: DrizzleDB,
  repositoryId: string
): Promise<'done' | 'lost'> {
  const row = await db
    .select({ agent: agents, username: users.username })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(eq(agents.repositoryId, repositoryId))
    .get();
  if (!row || row.agent.deletedAt) return 'done';
  const { agent } = row;
  const repo = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .get();
  if (!repo) return 'done';
  const git = gitFor(env, repo);
  const head = await git.resolve(repo.defaultBranch);
  // Re-read an unchanged head only to clear an error (a force-push back to the last valid commit).
  if (!head || (head === agent.configSha && !agent.configError)) return 'done';
  const [read, avatar] = await Promise.all([
    readAgentConfig(git, head),
    git.entryAt(head, AVATAR_PATH),
  ]);
  const image =
    avatar?.type === 'blob' && row.username
      ? avatarUrl(row.username, head)
      : null;
  // A newer push moved the branch while this one read it: that push's refresh writes instead.
  const now = await git.client.listRefs();
  if (now.refs.get(`refs/heads/${repo.defaultBranch}`) !== head) return 'done';
  const unchanged = and(
    eq(agents.userId, agent.userId),
    agent.configSha === null
      ? isNull(agents.configSha)
      : eq(agents.configSha, agent.configSha),
    agent.configError === null
      ? isNull(agents.configError)
      : eq(agents.configError, agent.configError)
  );
  // Only after the compare-and-swap above changed the agents row (statements in a batch run in order).
  const swapped = and(eq(users.id, agent.userId), sql`changes() = 1`);
  let results;
  if (read.ok) {
    const c = read.config;
    results = await db.batch([
      db
        .update(agents)
        .set({
          name: c.name,
          bio: c.bio,
          triggerAsk: c.trigger.ask,
          triggerAbove: c.trigger.above,
          engine: c.engine,
          color: c.color ?? null,
          facet: c.facet ?? null,
          guarded: c.guarded ?? false,
          configSha: head,
          configError: null,
        })
        .where(unchanged),
      db.update(users).set({ name: c.name, image }).where(swapped),
    ]);
  } else {
    results = await db.batch([
      db.update(agents).set({ configError: read.error }).where(unchanged),
      db.update(users).set({ image }).where(swapped),
    ]);
  }
  return results[0].meta.changes === 0 ? 'lost' : 'done';
}
