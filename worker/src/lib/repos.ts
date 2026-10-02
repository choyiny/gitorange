import { and, eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import {
  repositories,
  repositoryCollaborators,
  type Repository,
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

export async function findRepo(db: DrizzleDB, owner: string, name: string) {
  return db
    .select({ repo: repositories, owner: users })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(
      and(eq(users.username, owner.toLowerCase()), eq(repositories.name, name))
    )
    .get();
}

export interface RepoPermissions {
  read: boolean;
  write: boolean;
  admin: boolean;
}

/** All members read every repo; owner, site admins, and collaborators may push and merge. */
export async function permissionsFor(
  db: DrizzleDB,
  repo: Repository,
  user: SessionUser | undefined
): Promise<RepoPermissions> {
  if (!user || user.banned) return { read: false, write: false, admin: false };
  const isAdmin = user.role === 'admin' || repo.ownerId === user.id;
  if (isAdmin) return { read: true, write: true, admin: true };
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
  return { read: true, write: !!collab, admin: false };
}

export function gitFor(env: CloudflareBindings, repo: Repository) {
  return new GitService(
    new ArtifactsRepoClient(env.ARTIFACTS, repo.artifactsName)
  );
}

export type RepoEnv = AppEnv & {
  Variables: AppEnv['Variables'] & {
    repo: Repository;
    repoOwner: typeof users.$inferSelect;
    perms: RepoPermissions;
    git: GitService;
  };
};

/** Loads `/:owner/:repo` into context; 404s when it doesn't exist. */
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
  c.set('perms', perms);
  c.set('git', gitFor(c.env, found.repo));
  await next();
};
