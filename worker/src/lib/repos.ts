import { and, eq, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import {
  repositories,
  repositoryCollaborators,
  teams,
  type Repository,
  type Team,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import { ArtifactsRepoClient } from '../git/remote';
import { GitService } from '../git/service';
import type { AppEnv, SessionUser } from '../variables';

export const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function normalizeRepoName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, '-');
}

/** A repo's URL owner: a user or the team; `username` is the URL segment either way. */
export interface Namespace {
  kind: 'user' | 'team';
  id: string;
  username: string;
  name: string;
  image: string | null;
}

export function userNamespace(u: {
  id: string;
  username?: string | null;
  name: string;
  image?: string | null;
}): Namespace {
  return {
    kind: 'user',
    id: u.id,
    username: u.username ?? u.id,
    name: u.name,
    image: u.image ?? null,
  };
}

export function teamNamespace(t: Team): Namespace {
  return {
    kind: 'team',
    id: t.id,
    username: t.slug,
    name: t.name,
    image: null,
  };
}

/** The shared team, if created. */
export async function getTeam(db: DrizzleDB): Promise<Team | null> {
  return (await db.select().from(teams).limit(1).get()) ?? null;
}

/** Resolves `/<owner>/<name>`: the team slug first, then a username. */
export async function findRepo(db: DrizzleDB, owner: string, name: string) {
  const slug = owner.toLowerCase();
  const team = await db.select().from(teams).where(eq(teams.slug, slug)).get();
  if (team) {
    const row = await db
      .select({ repo: repositories, owner: users })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(and(eq(repositories.teamId, team.id), eq(repositories.name, name)))
      .get();
    return row ? { ...row, namespace: teamNamespace(team) } : undefined;
  }
  const row = await db
    .select({ repo: repositories, owner: users })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(
      and(
        eq(users.username, slug),
        sql`${repositories.teamId} IS NULL`,
        eq(repositories.name, name)
      )
    )
    .get();
  return row ? { ...row, namespace: userNamespace(row.owner) } : undefined;
}

/** Loads a repository and its namespace by id. */
export async function findRepoById(db: DrizzleDB, id: string) {
  const row = await db
    .select({ repo: repositories, owner: users })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(eq(repositories.id, id))
    .get();
  if (!row) return undefined;
  if (row.repo.teamId) {
    const team = await db
      .select()
      .from(teams)
      .where(eq(teams.id, row.repo.teamId))
      .get();
    if (team) return { ...row, namespace: teamNamespace(team) };
  }
  return { ...row, namespace: userNamespace(row.owner) };
}

/** findRepoById for many ids in one query, keyed by id; ids that don't exist are left out. */
export async function findReposByIds(db: DrizzleDB, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map<string, FoundRepo>();
  const rows = await db
    .select({ repo: repositories, owner: users, team: teams })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .leftJoin(teams, eq(teams.id, repositories.teamId))
    .where(inArray(repositories.id, unique))
    .all();
  return new Map<string, FoundRepo>(
    rows.map(({ repo, owner, team }) => [
      repo.id,
      {
        repo,
        owner,
        namespace: team ? teamNamespace(team) : userNamespace(owner),
      },
    ])
  );
}

export type FoundRepo = NonNullable<Awaited<ReturnType<typeof findRepoById>>>;

export interface RepoPermissions {
  read: boolean;
  write: boolean;
  admin: boolean;
}

/**
 * Admins and owner/creator: everything. Collaborators: read and push. Others: read team and
 * internal repos only. Must agree with `visibleTo`.
 */
export async function permissionsFor(
  db: DrizzleDB,
  repo: Repository,
  user: SessionUser | undefined
): Promise<RepoPermissions> {
  if (!user || user.banned || !needsCollaboration(repo, user))
    return permissionsOf(repo, user, false);
  const collab = await db
    .select()
    .from(repositoryCollaborators)
    .where(
      and(
        eq(repositoryCollaborators.repositoryId, repo.id),
        eq(repositoryCollaborators.userId, user.id)
      )
    )
    .get();
  return permissionsOf(repo, user, !!collab);
}

/**
 * permissionsFor for many repositories at once: one query for the user's collaborations
 * instead of one per repository. Keyed by repository id.
 */
export async function permissionsForMany(
  db: DrizzleDB,
  repos: Repository[],
  user: SessionUser | undefined
): Promise<Map<string, RepoPermissions>> {
  const ask =
    user && !user.banned
      ? [
          ...new Set(
            repos.filter((r) => needsCollaboration(r, user)).map((r) => r.id)
          ),
        ]
      : [];
  const collaborating = new Set(
    ask.length
      ? (
          await db
            .select({ id: repositoryCollaborators.repositoryId })
            .from(repositoryCollaborators)
            .where(
              and(
                eq(repositoryCollaborators.userId, user!.id),
                inArray(repositoryCollaborators.repositoryId, ask)
              )
            )
            .all()
        ).map((r) => r.id)
      : []
  );
  return new Map(
    repos.map((r) => [r.id, permissionsOf(r, user, collaborating.has(r.id))])
  );
}

/** Whether `user`'s access to `repo` depends on being a collaborator. */
function needsCollaboration(repo: Repository, user: SessionUser) {
  return user.role !== 'admin' && repo.ownerId !== user.id;
}

/** The permission rule itself, given whether the user collaborates on the repository. */
function permissionsOf(
  repo: Repository,
  user: SessionUser | undefined,
  collaborator: boolean
): RepoPermissions {
  if (!user || user.banned) return { read: false, write: false, admin: false };
  if (!needsCollaboration(repo, user))
    return { read: true, write: true, admin: true };
  if (collaborator) return { read: true, write: true, admin: false };
  const read = repo.teamId !== null || repo.visibility === 'internal';
  return { read, write: false, admin: false };
}

/** SQL filter for listings; mirrors permissionsFor's read rule. */
export function visibleTo(user: SessionUser): SQL | undefined {
  if (user.role === 'admin') return undefined;
  return or(
    isNotNull(repositories.teamId),
    eq(repositories.visibility, 'internal'),
    eq(repositories.ownerId, user.id),
    sql`${repositories.id} IN (SELECT repository_id FROM repository_collaborators WHERE user_id = ${user.id})`
  );
}

export function gitFor(env: CloudflareBindings, repo: Repository) {
  return new GitService(
    new ArtifactsRepoClient(env.ARTIFACTS, repo.artifactsName)
  );
}

export type RepoEnv = AppEnv & {
  Variables: AppEnv['Variables'] & {
    repo: Repository;
    /** Owner (personal) or creator (team). */
    repoOwner: typeof users.$inferSelect;
    namespace: Namespace;
    perms: RepoPermissions;
    git: GitService;
  };
};

/** Loads `/:owner/:repo` into context; 404s if missing or not visible. */
export const loadRepo: MiddlewareHandler<RepoEnv> = async (c, next) => {
  const owner = c.req.param('owner');
  const name = c.req.param('repo');
  if (!owner || !name) return c.json({ error: 'Not Found' }, 404);
  const found = await findRepo(c.get('db'), owner, name);
  if (!found) return c.json({ error: 'Not Found' }, 404);
  const perms = await permissionsFor(c.get('db'), found.repo, c.get('user'));
  if (!perms.read) return c.json({ error: 'Not Found' }, 404);
  c.set('repo', found.repo);
  c.set('repoOwner', found.owner);
  c.set('namespace', found.namespace);
  c.set('perms', perms);
  c.set('git', gitFor(c.env, found.repo));
  await next();
};
