import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  lfsObjects,
  pullRequests,
  repositories,
  teams,
  repositoryCollaborators,
  type Repository,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import { decoder } from '../git/bytes';
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
import {
  LFS_NOT_CONFIGURED,
  OID_RE,
  deleteRepositoryObjects,
  lfsConfigured,
  parseLfsPointer,
  presign,
} from '../lib/lfs';
import { toPublicUser, userByUsername, type PublicUser } from '../lib/users';
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
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The same name may exist once per namespace: per user for personal repos, per team for team repos. */
async function nameTaken(
  db: RepoEnv['Variables']['db'],
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
  responses: { ...json200Response(z.array(repoSchema), 'All repositories') },
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
  return c.json(
    rows.map((r) =>
      serializeRepo(
        r.repo,
        r.team ? teamNamespace(r.team) : userNamespace(r.owner)
      )
    ),
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
            // Personal repos default to private; team repos are always visible to every member.
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
  const db = c.get('db');
  const user = c.get('user')!;
  const body = c.req.valid('json');
  const name = normalizeRepoName(body.name);
  if (
    !REPO_NAME_RE.test(name) ||
    name === '.' ||
    name === '..' ||
    name.endsWith('.git')
  ) {
    return c.json({ error: 'Repository name is invalid' }, 400);
  }
  const team = body.owner === 'team' ? await getTeam(db) : null;
  if (body.owner === 'team' && !team)
    return c.json(
      {
        error:
          'There is no team yet. A site admin can create one in Site admin.',
      },
      400
    );
  if (await nameTaken(db, { ownerId: user.id, teamId: team?.id ?? null }, name))
    return c.json(
      {
        error: `${team ? team.name : 'You'} already ${team ? 'has' : 'have'} a repository named ${name}`,
      },
      409
    );
  const ns = team ? teamNamespace(team) : userNamespace(user);

  const id = crypto.randomUUID();
  const now = new Date();
  const row: Repository = {
    id,
    ownerId: user.id,
    teamId: team?.id ?? null,
    visibility: team ? 'internal' : body.visibility,
    name,
    description: body.description?.trim() || null,
    defaultBranch: 'main',
    artifactsName: `r_${id}`,
    nextPrNumber: 1,
    createdAt: now,
    updatedAt: now,
  };
  // Storage first: if the D1 insert then fails, roll the Artifacts repo back.
  await c.env.ARTIFACTS.create(row.artifactsName, {
    setDefaultBranch: 'main',
    description: `${ns.username}/${name}`,
  });
  try {
    await db.insert(repositories).values(row);
  } catch (e) {
    await c.env.ARTIFACTS.delete(row.artifactsName);
    throw e;
  }
  if (body.addReadme) {
    const readme = `# ${name}\n${row.description ? `\n${row.description}\n` : ''}`;
    await gitFor(c.env, row).initialCommit(
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
  return c.json(serializeRepo(row, ns), 201);
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
  await db.update(repositories).set(patch).where(eq(repositories.id, repo.id));
  return c.json(serializeRepo({ ...repo, ...patch }, c.get('namespace')), 200);
});

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
    ...json403Response,
    ...json404Response,
  },
});
reposRouter.openapi(addCollabRoute, async (c) => {
  if (!c.get('perms').admin)
    return c.json({ error: 'You must be an admin of this repository' }, 403);
  const user = await userByUsername(c.get('db'), c.req.valid('param').username);
  if (!user) return c.json({ error: 'User not found' }, 404);
  await c
    .get('db')
    .insert(repositoryCollaborators)
    .values({
      repositoryId: c.get('repo').id,
      userId: user.id,
      createdAt: new Date(),
    })
    .onConflictDoNothing();
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
  await c
    .get('db')
    .delete(repositoryCollaborators)
    .where(
      and(
        eq(repositoryCollaborators.repositoryId, c.get('repo').id),
        eq(repositoryCollaborators.userId, user.id)
      )
    );
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
  },
});
reposRouter.openapi(deleteBranchRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have push access' }, 403);
  const { name } = c.req.valid('query');
  if (name === c.get('repo').defaultBranch)
    return c.json({ error: 'Cannot delete the default branch' }, 400);
  await c.get('git').deleteBranch(name);
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
  const base = { ref, path, commitSha: sha, latestCommit: latest[0] ?? null };
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
  return c.json(await c.get('git').lastCommitsForTree(sha, path), 200);
});

const rawRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/raw',
  tags: ['Contents'],
  request: {
    params: ownerRepoParams,
    query: z.object({ ref: z.string(), path: z.string() }),
  },
  responses: { 200: { description: 'Raw file bytes' }, ...json404Response },
});
reposRouter.openapi(rawRoute, async (c) => {
  const { ref, path } = c.req.valid('query');
  const blob = await (await c.get('git').client.repo()).readFile({ ref, path });
  if (!blob) return c.json({ error: 'Not Found' }, 404);
  // Never render repo content as HTML on our origin.
  const type = /^(text\/html|image\/svg|application\/xhtml)/.test(blob.type)
    ? 'text/plain'
    : blob.type || 'application/octet-stream';
  return new Response(blob.stream(), {
    headers: {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
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
    { commits: commits.slice(0, perPage), hasMore: commits.length > perPage },
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
  return c.json({ commit, files }, 200);
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
  return c.json(result, 200);
});

export async function compareShas(
  git: GitService,
  baseSha: string,
  headSha: string
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
  const [commits, plan] = await Promise.all([
    git.commitsBetween(baseSha, headSha),
    git.planMerge(baseSha, headSha),
  ]);
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
    mergeable: !plan.upToDate && plan.conflicts.length === 0,
    conflicts: plan.upToDate ? [] : plan.conflicts,
    commits,
    files,
  };
}
