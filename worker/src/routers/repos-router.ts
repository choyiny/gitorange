import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  pullRequests,
  repositories,
  repositoryCollaborators,
  type Repository,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import { decoder } from '../git/bytes';
import type { GitService } from '../git/service';
import {
  REPO_NAME_RE,
  gitFor,
  loadRepo,
  normalizeRepoName,
  type RepoEnv,
} from '../lib/repos';
import { toPublicUser, userByUsername, type PublicUser } from '../lib/users';
import {
  json200Response,
  json201Response,
  json400Response,
  json403Response,
  json404Response,
  json409Response,
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

export function serializeRepo(r: Repository, owner: PublicUser) {
  return {
    id: r.id,
    owner,
    name: r.name,
    fullName: `${owner.username}/${r.name}`,
    description: r.description,
    defaultBranch: r.defaultBranch,
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
  responses: { ...json200Response(z.array(repoSchema), 'All repositories') },
});
reposRouter.openapi(listRoute, async (c) => {
  const db = c.get('db');
  const rows = await db
    .select({ repo: repositories, owner: users })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .orderBy(desc(repositories.updatedAt))
    .all();
  return c.json(
    rows.map((r) => serializeRepo(r.repo, toPublicUser(r.owner))),
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
  const dupe = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerId, user.id), eq(repositories.name, name)))
    .get();
  if (dupe)
    return c.json({ error: 'Name already exists on this account' }, 409);

  const id = crypto.randomUUID();
  const now = new Date();
  const row: Repository = {
    id,
    ownerId: user.id,
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
    description: `${user.username}/${name}`,
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
  return c.json(serializeRepo(row, toPublicUser(user)), 201);
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
  const owner = toPublicUser(c.get('repoOwner'));
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
      ...serializeRepo(repo, owner),
      permissions: c.get('perms'),
      cloneUrl: `${new URL(c.req.url).origin}/${owner.username}/${repo.name}.git`,
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
    const dupe = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(eq(repositories.ownerId, repo.ownerId), eq(repositories.name, name))
      )
      .get();
    if (dupe)
      return c.json({ error: 'Name already exists on this account' }, 409);
    patch.name = name;
  }
  if (body.description !== undefined)
    patch.description = body.description?.trim() || null;
  if (body.defaultBranch !== undefined) {
    if (!(await c.get('git').resolve(body.defaultBranch)))
      return c.json({ error: 'Branch not found' }, 400);
    patch.defaultBranch = body.defaultBranch;
  }
  await db.update(repositories).set(patch).where(eq(repositories.id, repo.id));
  return c.json(
    serializeRepo({ ...repo, ...patch }, toPublicUser(c.get('repoOwner'))),
    200
  );
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
