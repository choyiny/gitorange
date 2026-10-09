import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { rebase, REBASE_COMMITTER } from '../git/rebase';
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import {
  lfsObjects,
  pullRequests,
  repositories,
  teams,
  repositoryCollaborators,
  type Repository,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import { landTargetIs } from '../lib/land-target';
import type { DrizzleDB } from '../db/middleware';
import { isAgentUser } from '../agents/identity';
import { decoder } from '../git/bytes';
import { GitPushError } from '../git/remote';
import type { GitService } from '../git/service';
import {
  REPO_NAME_RE,
  getTeam,
  gitFor,
  loadRepo,
  normalizeRepoName,
  teamNamespace,
  userNamespace,
  visibleTo,
  type Namespace,
  type RepoEnv,
} from '../lib/repos';
import { deleteRepositoryLogs } from '../actions/trigger';
import { recordAudit } from '../lib/audit';
import { createRepository, nameTaken } from '../lib/repo-create';
import { repoStats } from '../lib/repo-stats';
import {
  invalidProtectedPatterns,
  normalizeProtectedPatterns,
  protectedBy,
} from '../lib/protected-branches';
import {
  LFS_NOT_CONFIGURED,
  OID_RE,
  deleteRepositoryObjects,
  lfsConfigured,
  parseLfsPointer,
  presign,
} from '../lib/lfs';
import { toPublicUser, userByUsername, type PublicUser } from '../lib/users';
import { attributeCommits } from '../lib/commit-authors';
import {
  json200Response,
  json201Response,
  json400Response,
  json403Response,
  json404Response,
  json409Response,
  errorSchema,
  okSchema,
  validationHook,
} from './openapi-helpers';
import {
  commitSchema,
  fileDiffSchema,
  ownerRepoParams,
  permsSchema,
  publicUserSchema,
  repoSchema,
  repoWithStatsSchema,
} from './schemas';

const MAX_FILE_VIEW = 1024 * 1024;

export function serializeRepo(r: Repository, ns: Namespace) {
  return {
    id: r.id,
    owner: { id: ns.id, username: ns.username, name: ns.name, image: ns.image },
    ownerType: ns.kind,
    visibility: r.visibility,
    name: r.name,
    fullName: `${ns.username}/${r.name}`,
    description: r.description,
    defaultBranch: r.defaultBranch,
    protectedBranches: r.protectedBranches ?? [],
    deleteMergedBranches: r.deleteMergedBranches,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Splits "feature/x/src/a.ts" into the longest matching branch name and the remaining path. */
export async function resolveRefPath(
  git: GitService,
  refPath: string,
  fallback: string
) {
  const clean = refPath.replace(/^\/+|\/+$/g, '');
  if (!clean) return { ref: fallback, path: '' };
  const branches = (await git.branches())
    .map((b) => b.name)
    .sort((a, b) => b.length - a.length);
  for (const b of branches) {
    if (clean === b) return { ref: b, path: '' };
    if (clean.startsWith(b + '/'))
      return { ref: b, path: clean.slice(b.length + 1) };
  }
  const [first, ...rest] = clean.split('/');
  return { ref: first, path: rest.join('/') };
}

export const reposRouter = new OpenAPIHono<RepoEnv>({
  defaultHook: validationHook,
});
reposRouter.use('/:owner/:repo', loadRepo);
reposRouter.use('/:owner/:repo/*', loadRepo);

// ── list / create ────────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Repositories'],
  request: {
    query: z.object({
      stats: z.enum(['1', 'true', '0', 'false']).optional().openapi({
        description:
          'With 1, each repository also carries `stats`: its open pull requests by whose move it is, what merged this week, its agents, branches and language.',
      }),
    }),
  },
  responses: {
    ...json200Response(z.array(repoWithStatsSchema), 'All repositories'),
  },
});
reposRouter.openapi(listRoute, async (c) => {
  const db = c.get('db');
  const rows = await db
    .select({ repo: repositories, owner: users, team: teams })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .leftJoin(teams, eq(teams.id, repositories.teamId))
    .where(visibleTo(c.get('user')!))
    .orderBy(desc(repositories.updatedAt))
    .all();
  const withStats = ['1', 'true'].includes(c.req.valid('query').stats ?? '');
  const stats = withStats
    ? await repoStats(
        c.env,
        db,
        rows.map((r) => r.repo)
      )
    : null;
  return c.json(
    rows.map((r) => ({
      ...serializeRepo(
        r.repo,
        r.team ? teamNamespace(r.team) : userNamespace(r.owner)
      ),
      ...(stats ? { stats: stats.get(r.repo.id) } : {}),
    })),
    200
  );
});

const createRepoRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Repositories'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(100),
            description: z.string().max(350).optional(),
            addReadme: z.boolean().default(false),
            // Personal repos default to private; team repos are always internal.
            owner: z.enum(['user', 'team']).default('user'),
            visibility: z.enum(['private', 'internal']).default('private'),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(repoSchema, 'Created'),
    ...json400Response,
    ...json409Response,
  },
});
reposRouter.openapi(createRepoRoute, async (c) => {
  const result = await createRepository(
    c.env,
    c.get('db'),
    c.get('user')!,
    c.req.valid('json')
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  await recordAudit(c.get('db'), {
    repositoryId: result.repo.id,
    actorId: c.get('user')!.id,
    action: 'repository.created',
    target: `${result.namespace.username}/${result.repo.name}`,
    data: { visibility: result.repo.visibility },
  });
  return c.json(serializeRepo(result.repo, result.namespace), 201);
});

// ── one repo ─────────────────────────────────────────────────────────────────

const repoDetailSchema = repoSchema.extend({
  permissions: permsSchema,
  cloneUrl: z.string(),
  empty: z.boolean(),
  branches: z.array(z.object({ name: z.string(), sha: z.string() })),
  openPullCount: z.number(),
});

const getRepoRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}',
  tags: ['Repositories'],
  request: { params: ownerRepoParams },
  responses: {
    ...json200Response(repoDetailSchema, 'Repository'),
    ...json404Response,
  },
});
reposRouter.openapi(getRepoRoute, async (c) => {
  const repo = c.get('repo');
  const ns = c.get('namespace');
  const branches = await c.get('git').branches();
  const open = await c
    .get('db')
    .select({ n: sql<number>`COUNT(*)` })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repo.id),
        eq(pullRequests.state, 'open')
      )
    )
    .get();
  return c.json(
    {
      ...serializeRepo(repo, ns),
      permissions: c.get('perms'),
      cloneUrl: `${new URL(c.req.url).origin}/${ns.username}/${repo.name}.git`,
      empty: branches.length === 0,
      branches,
      openPullCount: Number(open?.n ?? 0),
    },
    200
  );
});

const updateRepoRoute = createRoute({
  method: 'patch',
  path: '/{owner}/{repo}',
  tags: ['Repositories'],
  request: {
    params: ownerRepoParams,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(100).optional(),
            description: z.string().max(350).nullable().optional(),
            defaultBranch: z.string().min(1).optional(),
            visibility: z.enum(['private', 'internal']).optional(),
            // Replaces the list; [] or null clears it.
            protectedBranches: z
              .array(z.string())
              .nullable()
              .optional()
              .openapi({
                description:
                  'Branch name patterns GitOrange never rebases: exact names, or globs (* within one path segment, ** across segments). At most 50, each 1–100 characters without whitespace.',
                example: ['release/*', 'develop'],
              }),
            deleteMergedBranches: z.boolean().optional().openapi({
              description:
                'Delete a pull request’s head branch when it lands, by the merge button or auto-merge (never the default or a protected branch, or one another open pull request uses).',
            }),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(repoSchema, 'Updated'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
    ...json409Response,
  },
});
reposRouter.openapi(updateRepoRoute, async (c) => {
  if (!c.get('perms').admin)
    return c.json({ error: 'You must be an admin of this repository' }, 403);
  const db = c.get('db');
  const repo = c.get('repo');
  const body = c.req.valid('json');
  const patch: Partial<Repository> = { updatedAt: new Date() };
  if (body.name !== undefined && body.name !== repo.name) {
    const name = normalizeRepoName(body.name);
    if (!REPO_NAME_RE.test(name))
      return c.json({ error: 'Repository name is invalid' }, 400);
    if (await nameTaken(db, repo, name))
      return c.json({ error: 'Name already exists in this namespace' }, 409);
    patch.name = name;
  }
  if (body.description !== undefined)
    patch.description = body.description?.trim() || null;
  if (body.visibility !== undefined && body.visibility !== repo.visibility) {
    if (repo.teamId)
      return c.json(
        { error: 'Team repositories are always visible to every member' },
        400
      );
    patch.visibility = body.visibility;
  }
  if (body.defaultBranch !== undefined) {
    if (!(await c.get('git').resolve(body.defaultBranch)))
      return c.json({ error: 'Branch not found' }, 400);
    patch.defaultBranch = body.defaultBranch;
  }
  if (body.protectedBranches !== undefined) {
    const patterns = (body.protectedBranches ?? []).map((p) => p.trim());
    const invalid = invalidProtectedPatterns(patterns);
    if (invalid) return c.json({ error: invalid }, 400);
    patch.protectedBranches = normalizeProtectedPatterns(patterns);
  }
  if (body.deleteMergedBranches !== undefined)
    patch.deleteMergedBranches = body.deleteMergedBranches;
  await db.update(repositories).set(patch).where(eq(repositories.id, repo.id));
  await auditRepoChanges(
    db,
    c.get('user')!.id,
    repo,
    patch,
    c.get('namespace')
  );
  return c.json(serializeRepo({ ...repo, ...patch }, c.get('namespace')), 200);
});

/** What the settings route changed, for the audit log: visibility on its own, the rest as one `settings.changed`. */
async function auditRepoChanges(
  db: DrizzleDB,
  actorId: string,
  before: Repository,
  patch: Partial<Repository>,
  ns: Namespace
) {
  const target = `${ns.username}/${patch.name ?? before.name}`;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of [
    'name',
    'description',
    'defaultBranch',
    'protectedBranches',
    'deleteMergedBranches',
  ] as const) {
    if (!(key in patch)) continue;
    const list = key === 'protectedBranches';
    const from = list ? (before[key] ?? []) : before[key];
    const to = list ? (patch[key] ?? []) : patch[key];
    if (JSON.stringify(from) !== JSON.stringify(to))
      changes[key] = { from, to };
  }
  if (Object.keys(changes).length)
    await recordAudit(db, {
      repositoryId: before.id,
      actorId,
      action: 'settings.changed',
      target,
      data: { changes },
    });
  if (patch.visibility !== undefined && patch.visibility !== before.visibility)
    await recordAudit(db, {
      repositoryId: before.id,
      actorId,
      action: 'visibility.changed',
      target,
      data: { from: before.visibility, to: patch.visibility },
    });
}

const deleteRepoRoute = createRoute({
  method: 'delete',
  path: '/{owner}/{repo}',
  tags: ['Repositories'],
  request: { params: ownerRepoParams },
  responses: {
    ...json200Response(okSchema, 'Deleted'),
    ...json403Response,
    ...json404Response,
  },
});
reposRouter.openapi(deleteRepoRoute, async (c) => {
  if (!c.get('perms').admin)
    return c.json({ error: 'You must be an admin of this repository' }, 403);
  const repo = c.get('repo');
  await c.get('db').delete(repositories).where(eq(repositories.id, repo.id));
  // An instance event: the repository's own log went with it.
  await recordAudit(c.get('db'), {
    repositoryId: null,
    actorId: c.get('user')!.id,
    action: 'repository.deleted',
    target: `${c.get('namespace').username}/${repo.name}`,
    data: { repository: repo.id },
  });
  await c.env.ARTIFACTS.delete(repo.artifactsName);
  // LFS rows cascade with the repository; their R2 bytes have to go explicitly.
  await deleteRepositoryObjects(c.env, repo.id);
  await deleteRepositoryLogs(c.env, repo.id);
  return c.json({ ok: true as const }, 200);
});

// ── collaborators ────────────────────────────────────────────────────────────

const collabParams = ownerRepoParams.extend({ username: z.string() });

const listCollabRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/collaborators',
  tags: ['Collaborators'],
  request: { params: ownerRepoParams },
  responses: {
    ...json200Response(z.array(publicUserSchema), 'Collaborators'),
    ...json404Response,
  },
});
reposRouter.openapi(listCollabRoute, async (c) => {
  const rows = await c
    .get('db')
    .select({ user: users })
    .from(repositoryCollaborators)
    .innerJoin(users, eq(users.id, repositoryCollaborators.userId))
    .where(eq(repositoryCollaborators.repositoryId, c.get('repo').id))
    .all();
  return c.json(
    rows.map((r) => toPublicUser(r.user)),
    200
  );
});

const addCollabRoute = createRoute({
  method: 'put',
  path: '/{owner}/{repo}/collaborators/{username}',
  tags: ['Collaborators'],
  request: { params: collabParams },
  responses: {
    ...json200Response(okSchema, 'Added'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
  },
});
reposRouter.openapi(addCollabRoute, async (c) => {
  if (!c.get('perms').admin)
    return c.json({ error: 'You must be an admin of this repository' }, 403);
  const user = await userByUsername(c.get('db'), c.req.valid('param').username);
  if (!user) return c.json({ error: 'User not found' }, 404);
  if (await isAgentUser(c.get('db'), user.id))
    return c.json(
      {
        error:
          'Agents can’t be collaborators. Invite it under Settings → Agents.',
      },
      400
    );
  const added = await c
    .get('db')
    .insert(repositoryCollaborators)
    .values({
      repositoryId: c.get('repo').id,
      userId: user.id,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: repositoryCollaborators.userId });
  if (added.length)
    await recordAudit(c.get('db'), {
      repositoryId: c.get('repo').id,
      actorId: c.get('user')!.id,
      action: 'collaborator.added',
      target: user.username ?? user.id,
    });
  return c.json({ ok: true as const }, 200);
});

const removeCollabRoute = createRoute({
  method: 'delete',
  path: '/{owner}/{repo}/collaborators/{username}',
  tags: ['Collaborators'],
  request: { params: collabParams },
  responses: {
    ...json200Response(okSchema, 'Removed'),
    ...json403Response,
    ...json404Response,
  },
});
reposRouter.openapi(removeCollabRoute, async (c) => {
  if (!c.get('perms').admin)
    return c.json({ error: 'You must be an admin of this repository' }, 403);
  const user = await userByUsername(c.get('db'), c.req.valid('param').username);
  if (!user) return c.json({ error: 'User not found' }, 404);
  const removed = await c
    .get('db')
    .delete(repositoryCollaborators)
    .where(
      and(
        eq(repositoryCollaborators.repositoryId, c.get('repo').id),
        eq(repositoryCollaborators.userId, user.id)
      )
    )
    .returning({ id: repositoryCollaborators.userId });
  if (removed.length)
    await recordAudit(c.get('db'), {
      repositoryId: c.get('repo').id,
      actorId: c.get('user')!.id,
      action: 'collaborator.removed',
      target: user.username ?? user.id,
    });
  return c.json({ ok: true as const }, 200);
});

// ── branches ─────────────────────────────────────────────────────────────────

const deleteBranchRoute = createRoute({
  method: 'delete',
  path: '/{owner}/{repo}/branches',
  tags: ['Branches'],
  request: { params: ownerRepoParams, query: z.object({ name: z.string() }) },
  responses: {
    ...json200Response(okSchema, 'Deleted'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
    ...json409Response,
  },
});
reposRouter.openapi(deleteBranchRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have push access' }, 403);
  const { name } = c.req.valid('query');
  const repo = c.get('repo');
  if (name === repo.defaultBranch)
    return c.json({ error: 'Cannot delete the default branch' }, 400);
  if (protectedBy(repo.protectedBranches, name))
    return c.json({ error: `${name} is a protected branch.` }, 409);
  // A branch an open pull request comes from, builds on or lands on is in use (as Clean up and landing keep it).
  const usedBy = await c
    .get('db')
    .select({ number: pullRequests.number })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repo.id),
        eq(pullRequests.state, 'open'),
        or(
          eq(pullRequests.headRef, name),
          eq(pullRequests.baseRef, name),
          landTargetIs(name)
        )
      )
    )
    .orderBy(asc(pullRequests.number))
    .get();
  if (usedBy)
    return c.json(
      { error: `Open pull request #${usedBy.number} uses ${name}.` },
      409
    );
  // The branch itself, not a tag or commit of that name; deleting one that isn't there does nothing and records nothing.
  const sha = (await c.get('git').refs()).get(`refs/heads/${name}`);
  if (sha) {
    // Compare-and-swap on the tip just read: a push in between wins and the deletion is refused.
    try {
      await c.get('git').deleteBranch(name, sha);
    } catch (e) {
      if (e instanceof GitPushError)
        return c.json(
          { error: 'The branch has new commits since you looked. Try again.' },
          409
        );
      throw e;
    }
    await recordAudit(c.get('db'), {
      repositoryId: c.get('repo').id,
      actorId: c.get('user')!.id,
      action: 'branch.deleted',
      target: name,
      data: { sha },
    });
  }
  return c.json({ ok: true as const }, 200);
});

// ── contents ─────────────────────────────────────────────────────────────────

const entrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.string(),
  mode: z.string(),
  hash: z.string(),
});

const contentsSchema = z.object({
  ref: z.string(),
  path: z.string(),
  commitSha: z.string().nullable(),
  latestCommit: commitSchema.nullable(),
  kind: z.enum(['tree', 'blob', 'empty']),
  entries: z.array(entrySchema).optional(),
  readme: z
    .object({ path: z.string(), text: z.string() })
    .nullable()
    .optional(),
  file: z
    .object({
      path: z.string(),
      size: z.number(),
      binary: z.boolean(),
      tooLarge: z.boolean(),
      text: z.string().nullable(),
      // Set when the blob is a Git LFS pointer; `stored` says whether the content was uploaded.
      lfs: z
        .object({ oid: z.string(), size: z.number(), stored: z.boolean() })
        .nullable(),
    })
    .optional(),
});

const contentsRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/contents',
  tags: ['Contents'],
  request: {
    params: ownerRepoParams,
    query: z.object({ refPath: z.string().default('') }),
  },
  responses: {
    ...json200Response(contentsSchema, 'Tree or file'),
    ...json404Response,
  },
});
reposRouter.openapi(contentsRoute, async (c) => {
  const git = c.get('git');
  const repo = c.get('repo');
  const { ref, path } = await resolveRefPath(
    git,
    c.req.valid('query').refPath,
    repo.defaultBranch
  );
  const sha = await git.resolve(ref);
  if (!sha) {
    if ((await git.branches()).length === 0) {
      return c.json(
        {
          ref,
          path,
          commitSha: null,
          latestCommit: null,
          kind: 'empty' as const,
        },
        200
      );
    }
    return c.json({ error: 'Ref not found' }, 404);
  }
  const [entry, latest] = await Promise.all([
    git.entryAt(sha, path),
    git.log(sha, 1),
  ]);
  if (!entry) return c.json({ error: 'Path not found' }, 404);
  const [latestCommit = null] = await attributeCommits(
    c.get('db'),
    latest.slice(0, 1)
  );
  const base = { ref, path, commitSha: sha, latestCommit };
  if (entry.type === 'tree') {
    const entries = entry.entries
      .map((e) => ({ ...e, path: path ? `${path}/${e.name}` : e.name }))
      .sort((a, b) =>
        (a.type === 'tree') === (b.type === 'tree')
          ? a.name.localeCompare(b.name)
          : a.type === 'tree'
            ? -1
            : 1
      );
    const readmeEntry = entries.find(
      (e) => e.type !== 'tree' && /^readme(\.(md|markdown|txt))?$/i.test(e.name)
    );
    let readme = null;
    if (readmeEntry) {
      const bytes = await git.blob(readmeEntry.hash);
      if (bytes && bytes.length < MAX_FILE_VIEW)
        readme = { path: readmeEntry.path, text: decoder.decode(bytes) };
    }
    return c.json({ ...base, kind: 'tree' as const, entries, readme }, 200);
  }
  const bytes = (await git.blob(entry.entry.hash)) ?? new Uint8Array();
  const binary = bytes.subarray(0, 8000).includes(0);
  const tooLarge = bytes.length > MAX_FILE_VIEW;
  const pointer =
    !binary && bytes.length <= 1024
      ? parseLfsPointer(decoder.decode(bytes))
      : null;
  const lfs = pointer
    ? {
        ...pointer,
        stored: !!(await c
          .get('db')
          .select({ id: lfsObjects.id })
          .from(lfsObjects)
          .where(
            and(
              eq(lfsObjects.repositoryId, repo.id),
              eq(lfsObjects.oid, pointer.oid)
            )
          )
          .get()),
      }
    : null;
  return c.json(
    {
      ...base,
      kind: 'blob' as const,
      file: {
        path,
        size: bytes.length,
        binary,
        tooLarge,
        text: binary || tooLarge ? null : decoder.decode(bytes),
        lfs,
      },
    },
    200
  );
});

const treeCommitsRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/tree-commits',
  tags: ['Contents'],
  request: {
    params: ownerRepoParams,
    query: z.object({ ref: z.string(), path: z.string().default('') }),
  },
  responses: {
    ...json200Response(
      z.record(z.string(), commitSchema),
      'Last commit per entry'
    ),
    ...json404Response,
  },
});
reposRouter.openapi(treeCommitsRoute, async (c) => {
  const { ref, path } = c.req.valid('query');
  const sha = await c.get('git').resolve(ref);
  if (!sha) return c.json({ error: 'Ref not found' }, 404);
  const byName = await c.get('git').lastCommitsForTree(sha, path);
  // Many entries share a commit: attribute each distinct commit once.
  const distinct = [
    ...new Map(Object.values(byName).map((x) => [x.hash, x])).values(),
  ];
  const attributed = new Map(
    (await attributeCommits(c.get('db'), distinct)).map((x) => [x.hash, x])
  );
  return c.json(
    Object.fromEntries(
      Object.entries(byName).map(([name, x]) => [name, attributed.get(x.hash)!])
    ),
    200
  );
});

const SVG_TYPE = 'image/svg+xml';
const isSvg = (path: string) => /\.svg$/i.test(path);

/**
 * Raw file Content-Type. SVG is an image so Markdown `<img>` shows it (`<img>` never runs its
 * scripts); HTML is never served as a document from our origin.
 */
function rawContentType(path: string, blobType: string): string {
  if (isSvg(path) || /^image\/svg/.test(blobType)) return SVG_TYPE;
  if (/^(text\/html|application\/xhtml)/.test(blobType)) return 'text/plain';
  return blobType || 'application/octet-stream';
}

/** Sandboxed CSP for raw files (SVGs can carry script); allows only inline styles. */
const RAW_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
};

const rawRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/raw',
  tags: ['Contents'],
  request: {
    params: ownerRepoParams,
    query: z.object({ ref: z.string(), path: z.string() }),
  },
  responses: {
    200: { description: 'Raw file bytes' },
    302: {
      description: 'Redirect to the Git LFS object behind a pointer file',
    },
    ...json404Response,
  },
});
reposRouter.openapi(rawRoute, async (c) => {
  const { ref, path } = c.req.valid('query');
  const blob = await (await c.get('git').client.repo()).readFile({ ref, path });
  if (!blob) return c.json({ error: 'Not Found' }, 404);
  // LFS pointer: redirect to the R2 bytes; a pointer whose object isn't uploaded is served as text.
  const pointer =
    blob.size <= 1024 && lfsConfigured(c.env)
      ? parseLfsPointer(await blob.text())
      : null;
  if (pointer) {
    const row = await c
      .get('db')
      .select({ r2Key: lfsObjects.r2Key })
      .from(lfsObjects)
      .where(
        and(
          eq(lfsObjects.repositoryId, c.get('repo').id),
          eq(lfsObjects.oid, pointer.oid)
        )
      )
      .get();
    if (row)
      return c.redirect(
        await presign(c.env, row.r2Key, 'GET', {
          contentType: isSvg(path) ? SVG_TYPE : undefined,
        }),
        302
      );
  }
  return new Response(blob.stream(), {
    headers: {
      'Content-Type': rawContentType(path, blob.type),
      ...RAW_HEADERS,
    },
  }) as never;
});

const lfsDownloadRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/lfs/{oid}',
  tags: ['Contents'],
  request: {
    params: ownerRepoParams.extend({ oid: z.string().regex(OID_RE) }),
    query: z.object({ filename: z.string().max(255).optional() }),
  },
  responses: {
    302: { description: 'Redirect to a short-lived download URL' },
    ...json404Response,
    501: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'LFS not configured',
    },
  },
});
reposRouter.openapi(lfsDownloadRoute, async (c) => {
  if (!lfsConfigured(c.env)) return c.json({ error: LFS_NOT_CONFIGURED }, 501);
  const { oid } = c.req.valid('param');
  const row = await c
    .get('db')
    .select()
    .from(lfsObjects)
    .where(
      and(
        eq(lfsObjects.repositoryId, c.get('repo').id),
        eq(lfsObjects.oid, oid)
      )
    )
    .get();
  if (!row) return c.json({ error: 'LFS object not found' }, 404);
  // Minted after the permission check (loadRepo) and never stored.
  const url = await presign(c.env, row.r2Key, 'GET', {
    filename: c.req.valid('query').filename,
  });
  return c.redirect(url, 302);
});

// ── history ──────────────────────────────────────────────────────────────────

const commitsRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/commits',
  tags: ['Commits'],
  request: {
    params: ownerRepoParams,
    query: z.object({
      ref: z.string(),
      page: z.coerce.number().int().min(1).default(1),
    }),
  },
  responses: {
    ...json200Response(
      z.object({ commits: z.array(commitSchema), hasMore: z.boolean() }),
      'Commits'
    ),
    ...json404Response,
  },
});
reposRouter.openapi(commitsRoute, async (c) => {
  const { ref, page } = c.req.valid('query');
  const sha = await c.get('git').resolve(ref);
  if (!sha) return c.json({ error: 'Ref not found' }, 404);
  const perPage = 35;
  const commits = await c
    .get('git')
    .log(sha, perPage + 1, (page - 1) * perPage);
  return c.json(
    {
      commits: await attributeCommits(c.get('db'), commits.slice(0, perPage)),
      hasMore: commits.length > perPage,
    },
    200
  );
});

const commitRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/commit/{sha}',
  tags: ['Commits'],
  request: {
    params: ownerRepoParams.extend({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  },
  responses: {
    ...json200Response(
      z.object({ commit: commitSchema, files: z.array(fileDiffSchema) }),
      'Commit with diff'
    ),
    ...json404Response,
  },
});
reposRouter.openapi(commitRoute, async (c) => {
  const git = c.get('git');
  const commit = await git.commit(c.req.valid('param').sha);
  if (!commit) return c.json({ error: 'Not Found' }, 404);
  const parent = commit.parents[0] ? await git.commit(commit.parents[0]) : null;
  const files = await git.fileDiffs(
    await git.diffTrees(parent?.treeHash ?? null, commit.treeHash)
  );
  const [attributed] = await attributeCommits(c.get('db'), [commit]);
  return c.json({ commit: attributed, files }, 200);
});

const compareRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/compare',
  tags: ['Commits'],
  request: {
    params: ownerRepoParams,
    query: z.object({ base: z.string(), head: z.string() }),
  },
  responses: {
    ...json200Response(
      z.object({
        baseSha: z.string(),
        headSha: z.string(),
        status: z.enum(['identical', 'ahead', 'behind', 'diverged']),
        mergeable: z.boolean(),
        conflicts: z.array(z.string()),
        commits: z.array(commitSchema),
        files: z.array(fileDiffSchema),
      }),
      'Comparison'
    ),
    ...json404Response,
  },
});
reposRouter.openapi(compareRoute, async (c) => {
  const git = c.get('git');
  const { base, head } = c.req.valid('query');
  const [baseSha, headSha] = await Promise.all([
    git.resolve(base),
    git.resolve(head),
  ]);
  if (!baseSha || !headSha) return c.json({ error: 'Branch not found' }, 404);
  const result = await compareShas(git, baseSha, headSha);
  return c.json(
    { ...result, commits: await attributeCommits(c.get('db'), result.commits) },
    200
  );
});

export async function compareShas(
  git: GitService,
  baseSha: string,
  headSha: string,
  opts: { mergeability?: boolean } = {}
) {
  if (baseSha === headSha) {
    return {
      baseSha,
      headSha,
      status: 'identical' as const,
      mergeable: false,
      conflicts: [],
      commits: [],
      files: [],
    };
  }
  const mb = await git.mergeBase(baseSha, headSha);
  const commits = await git.commitsBetween(baseSha, headSha);
  // Whether landing's rebase would replay it cleanly (a dry run: nothing is pushed).
  const dry =
    opts.mergeability === false || mb === headSha
      ? null
      : await rebase(git, {
          head: headSha,
          onto: baseSha,
          committer: { ...REBASE_COMMITTER, timestamp: 0 },
          ontoLabel: 'base',
        });
  const mbCommit = mb ? await git.commit(mb) : null;
  const headCommit = await git.commit(headSha);
  const files = await git.fileDiffs(
    await git.diffTrees(
      mbCommit?.treeHash ?? null,
      headCommit?.treeHash ?? null
    )
  );
  const status =
    mb === headSha ? 'behind' : mb === baseSha ? 'ahead' : 'diverged';
  return {
    baseSha,
    headSha,
    status: status as 'behind' | 'ahead' | 'diverged',
    mergeable:
      dry?.kind === 'up_to_date' ||
      (dry?.kind === 'done' && dry.commits.length > 0),
    conflicts: dry?.kind === 'conflict' ? dry.conflicts : [],
    commits,
    files,
  };
}
