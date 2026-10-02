import { and, eq, sql } from 'drizzle-orm';
import { repositories, type Repository } from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import {
  REPO_NAME_RE,
  getTeam,
  gitFor,
  normalizeRepoName,
  teamNamespace,
  userNamespace,
  type Namespace,
} from './repos';

/** The same name may exist once per namespace: per user for personal repos, per team for team repos. */
export async function nameTaken(
  db: DrizzleDB,
  repo: { ownerId: string; teamId: string | null },
  name: string
) {
  const scope = repo.teamId
    ? eq(repositories.teamId, repo.teamId)
    : and(
        eq(repositories.ownerId, repo.ownerId),
        sql`${repositories.teamId} IS NULL`
      );
  return !!(await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(scope, eq(repositories.name, name)))
    .get());
}

export interface CreateRepositoryInput {
  name: string;
  description?: string;
  addReadme?: boolean;
  /** Personal repos default to private; team repos are always visible to every member. */
  owner?: 'user' | 'team';
  visibility?: 'private' | 'internal';
}

export type CreateRepositoryResult =
  | { ok: true; repo: Repository; namespace: Namespace }
  | { ok: false; status: 400 | 409; error: string };

/**
 * Creates a repository for `user`: the Artifacts repo first, then the D1 row (rolling storage
 * back if the insert fails), then an optional README commit. Shared by the REST API and MCP.
 */
export async function createRepository(
  env: CloudflareBindings,
  db: DrizzleDB,
  user: {
    id: string;
    name: string;
    email: string;
    username?: string | null;
    image?: string | null;
  },
  input: CreateRepositoryInput
): Promise<CreateRepositoryResult> {
  const name = normalizeRepoName(input.name);
  if (
    !REPO_NAME_RE.test(name) ||
    name === '.' ||
    name === '..' ||
    name.endsWith('.git')
  ) {
    return { ok: false, status: 400, error: 'Repository name is invalid' };
  }
  const owner = input.owner ?? 'user';
  const team = owner === 'team' ? await getTeam(db) : null;
  if (owner === 'team' && !team)
    return {
      ok: false,
      status: 400,
      error: 'There is no team yet. A site admin can create one in Site admin.',
    };
  if (await nameTaken(db, { ownerId: user.id, teamId: team?.id ?? null }, name))
    return {
      ok: false,
      status: 409,
      error: `${team ? team.name : 'You'} already ${team ? 'has' : 'have'} a repository named ${name}`,
    };
  const ns = team ? teamNamespace(team) : userNamespace(user);

  const id = crypto.randomUUID();
  const now = new Date();
  const row: Repository = {
    id,
    ownerId: user.id,
    teamId: team?.id ?? null,
    visibility: team ? 'internal' : (input.visibility ?? 'private'),
    name,
    description: input.description?.trim() || null,
    defaultBranch: 'main',
    artifactsName: `r_${id}`,
    nextPrNumber: 1,
    createdAt: now,
    updatedAt: now,
  };
  // Storage first: if the D1 insert then fails, roll the Artifacts repo back.
  await env.ARTIFACTS.create(row.artifactsName, {
    setDefaultBranch: 'main',
    description: `${ns.username}/${name}`,
  });
  try {
    await db.insert(repositories).values(row);
  } catch (e) {
    await env.ARTIFACTS.delete(row.artifactsName);
    throw e;
  }
  if (input.addReadme) {
    const readme = `# ${name}\n${row.description ? `\n${row.description}\n` : ''}`;
    await gitFor(env, row).initialCommit(
      'main',
      { 'README.md': readme },
      {
        name: user.name,
        email: user.email,
        timestamp: Math.floor(Date.now() / 1000),
      },
      'Initial commit'
    );
  }
  return { ok: true, repo: row, namespace: ns };
}
