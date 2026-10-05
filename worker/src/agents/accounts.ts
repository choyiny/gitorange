import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  agents,
  repositories,
  repositoryAgents,
  repositoryCollaborators,
  teams,
  type Agent,
  type Repository,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import { namespaceTaken } from '../lib/namespaces';
import { createRepository } from '../lib/repo-create';
import { gitFor, teamNamespace, userNamespace, visibleTo } from '../lib/repos';
import { isValidUsername } from '../lib/usernames';
import { toPublicUser } from '../lib/users';
import type { SessionUser } from '../variables';
import { AGENT_PATH, parseAgentConfig } from './config';
import { agentEmail, avatarUrl } from './identity';
import { agentTemplate } from './template';

export type AgentView = {
  user: typeof users.$inferSelect;
  agent: Agent;
  /** The agent's repository; null once deleted, or when the viewer can't read it. */
  repo: Repository | null;
};

/** The API shape (`agentSchema`). */
export function serializeAgent(v: AgentView) {
  return {
    ...toPublicUser(v.user),
    bio: v.agent.bio,
    trigger: { ask: v.agent.triggerAsk, above: v.agent.triggerAbove },
    engine: v.agent.engine,
    // Always a personal repository of the agent's own user. Its name and what was read from it (the
    // config commit, why AGENT.md is invalid) only for viewers who can read it.
    repository: v.repo
      ? `${v.user.username ?? v.user.id}/${v.repo.name}`
      : null,
    configSha: v.repo ? v.agent.configSha : null,
    configError: v.repo ? v.agent.configError : null,
    createdAt: v.agent.createdAt.toISOString(),
    deletedAt: v.agent.deletedAt?.toISOString() ?? null,
  };
}

/** The agent's repository, if it still exists and `viewer` (when given) can read it. */
function ownRepository(viewer?: SessionUser) {
  const visible = viewer ? visibleTo(viewer) : undefined;
  return and(eq(repositories.id, agents.repositoryId), visible);
}

function agentQuery(db: DrizzleDB, viewer?: SessionUser) {
  return db
    .select({ agent: agents, user: users, repo: repositories })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .leftJoin(repositories, ownRepository(viewer));
}

/** Live (not deleted) agents, by handle, as `viewer` may see them. */
export async function listAgents(
  db: DrizzleDB,
  viewer: SessionUser
): Promise<AgentView[]> {
  return agentQuery(db, viewer)
    .where(isNull(agents.deletedAt))
    .orderBy(asc(users.username))
    .all();
}

/** An agent by handle, deleted ones included; its repository only if `viewer` (when given) can read it. */
export async function agentByHandle(
  db: DrizzleDB,
  handle: string,
  viewer?: SessionUser
): Promise<AgentView | undefined> {
  return agentQuery(db, viewer)
    .where(eq(users.username, handle.toLowerCase()))
    .get();
}

export async function agentByUserId(db: DrizzleDB, userId: string) {
  return db.select().from(agents).where(eq(agents.userId, userId)).get();
}

export const MAX_AGENT_NAME = 100;

/**
 * Why a (trimmed) display name can't be used, if it can't. The template writes it into AGENT.md's
 * frontmatter and its `# <name>` heading, so a line break or control character would reshape the file.
 */
export function displayNameError(name: string): string | null {
  if (!name) return 'Give the agent a display name.';
  if (name.length > MAX_AGENT_NAME)
    return `The display name can be at most ${MAX_AGENT_NAME} characters.`;
  if (/[\p{Cc}\u2028\u2029]/u.test(name))
    return 'The display name must be one line, without control characters.';
  return null;
}

/** A UNIQUE constraint failure, however the driver wrapped it (drizzle keeps D1's error as `cause`). */
function isUniqueViolation(e: unknown): boolean {
  let err = e;
  for (let depth = 0; err && depth < 5; depth++) {
    const message = (err as { message?: unknown }).message ?? err;
    if (String(message).includes('UNIQUE constraint failed')) return true;
    err = (err as { cause?: unknown }).cause;
  }
  return false;
}

export type CreateAgentResult =
  | { ok: true; agent: AgentView }
  | { ok: false; status: 400 | 409; error: string };

/**
 * Creates the agent's user (no credential), its `<handle>/<handle>` repository seeded from the template
 * with `creator` as author and collaborator, and its `agents` row (in the same batch as the user). On
 * failure removes what it made.
 */
export async function createAgent(
  env: CloudflareBindings,
  db: DrizzleDB,
  creator: SessionUser,
  input: { handle: string; name: string }
): Promise<CreateAgentResult> {
  const handle = input.handle.trim().toLowerCase();
  const name = input.name.trim();
  if (!isValidUsername(handle))
    return {
      ok: false,
      status: 400,
      error:
        'Use letters, numbers, and single hyphens (no leading or trailing hyphen); some names are reserved.',
    };
  const nameError = displayNameError(name);
  if (nameError) return { ok: false, status: 400, error: nameError };
  if (await namespaceTaken(db, handle))
    return {
      ok: false,
      status: 409,
      error: `"${handle}" is already a username or team name`,
    };

  const id = crypto.randomUUID();
  const now = new Date();
  const files = await agentTemplate(handle, name);
  const config = parseAgentConfig(files[AGENT_PATH] as string);
  const user = {
    id,
    name,
    email: agentEmail(id),
    emailVerified: false,
    username: handle,
    displayUsername: handle,
    role: 'user',
    image: null as string | null,
    createdAt: now,
    updatedAt: now,
  };
  // The user and agents rows land together, so the account is never a plain user: the auth layer
  // refuses agents from the first moment. The repository fields are filled in below.
  try {
    await db.batch([
      db.insert(users).values(user),
      db.insert(agents).values({
        userId: id,
        repositoryId: null,
        name: config.name,
        bio: config.bio,
        triggerAsk: config.trigger.ask,
        triggerAbove: config.trigger.above,
        engine: config.engine,
        configSha: null,
        configError: null,
        createdById: creator.id,
        createdAt: now,
        deletedAt: null,
      }),
    ]);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Lost a race for the username.
    return {
      ok: false,
      status: 409,
      error: `"${handle}" is already a username or team name`,
    };
  }
  let repo: Repository | null = null;
  try {
    const created = await createRepository(env, db, user, {
      name: handle,
      description: `Who @${handle} is and how it reviews.`,
      visibility: 'internal',
    });
    if (!created.ok) throw new Error(created.error);
    repo = created.repo;
    const sha = await gitFor(env, repo).initialCommit(
      'main',
      files,
      {
        name: creator.name,
        email: creator.email,
        timestamp: Math.floor(now.getTime() / 1000),
      },
      `Create agent @${handle}`
    );
    await db.batch([
      db
        .update(agents)
        .set({ repositoryId: repo.id, configSha: sha })
        .where(eq(agents.userId, id)),
      db.insert(repositoryCollaborators).values({
        repositoryId: repo.id,
        userId: creator.id,
        createdAt: now,
      }),
      db
        .update(users)
        .set({ image: avatarUrl(handle, sha) })
        .where(eq(users.id, id)),
    ]);
  } catch (e) {
    if (repo) await env.ARTIFACTS.delete(repo.artifactsName).catch(() => {});
    // Cascades to the agents and repository rows. A failed cleanup is logged; the original error is the one
    // worth surfacing.
    try {
      await db.delete(users).where(eq(users.id, id));
    } catch (cleanup) {
      console.error(
        '[agents] cleanup after a failed create failed',
        id,
        cleanup
      );
    }
    throw e;
  }
  return { ok: true, agent: (await agentByHandle(db, handle, creator))! };
}

/** A "deleted agent": uninvited everywhere; the user row, cached fields and repository stay. */
export async function deleteAgent(db: DrizzleDB, userId: string) {
  await db.batch([
    db
      .update(agents)
      .set({ deletedAt: new Date() })
      .where(eq(agents.userId, userId)),
    db.delete(repositoryAgents).where(eq(repositoryAgents.agentId, userId)),
  ]);
}

/** The agents invited to a repository, by handle, each with its own repository as `viewer` may see it. One query. */
export async function repositoryAgentList(
  db: DrizzleDB,
  repositoryId: string,
  viewer: SessionUser
): Promise<(AgentView & { invitedAt: Date })[]> {
  // The invited repository is only a filter, so `repositories` here is the agent's own.
  return db
    .select({
      agent: agents,
      user: users,
      repo: repositories,
      invitedAt: repositoryAgents.createdAt,
    })
    .from(repositoryAgents)
    .innerJoin(agents, eq(agents.userId, repositoryAgents.agentId))
    .innerJoin(users, eq(users.id, agents.userId))
    .leftJoin(repositories, ownRepository(viewer))
    .where(eq(repositoryAgents.repositoryId, repositoryId))
    .orderBy(asc(users.username))
    .all();
}

/** Repositories an agent is invited to that `viewer` can see, with their namespaces. One query. */
export async function invitedRepositories(
  db: DrizzleDB,
  agentId: string,
  viewer: SessionUser
) {
  const visible = visibleTo(viewer);
  const rows = await db
    .select({ repo: repositories, owner: users, team: teams })
    .from(repositoryAgents)
    .innerJoin(repositories, eq(repositories.id, repositoryAgents.repositoryId))
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .leftJoin(teams, eq(teams.id, repositories.teamId))
    .where(
      and(eq(repositoryAgents.agentId, agentId), ...(visible ? [visible] : []))
    )
    .orderBy(asc(repositories.name))
    .all();
  return rows.map(({ repo, owner, team }) => ({
    repo,
    namespace: team ? teamNamespace(team) : userNamespace(owner),
  }));
}
