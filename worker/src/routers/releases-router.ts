import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { releases } from '../db/app.schema';
import {
  cutRelease,
  getRelease,
  listReleases,
  unreleased,
  updateRelease,
} from '../lib/releases';
import { loadRepo, type RepoEnv } from '../lib/repos';
import {
  json200Response,
  json201Response,
  json400Response,
  json403Response,
  json404Response,
  validationHook,
} from './openapi-helpers';
import { ownerRepoParams } from './schemas';

// Releases (worker/src/lib/releases.ts): the changelog, what is waiting for the next release, cutting one, and editing
// its title or notes. There is no DELETE: a release, once cut, is permanent.

const bumpSchema = z.enum(['major', 'minor', 'patch']);

const releaseSchema = z
  .object({
    tag: z.string(),
    title: z.string(),
    notes: z.string(),
    commitSha: z.string(),
    createdAt: z.number(),
    createdBy: z.string().nullable(),
    /** The pull requests it shipped; empty for a first release. */
    pulls: z.array(
      z.object({
        number: z.number(),
        title: z.string(),
        bump: bumpSchema.nullable(),
      })
    ),
  })
  .openapi('Release');

const unreleasedSchema = z
  .object({
    pulls: z.array(
      z.object({
        number: z.number(),
        title: z.string(),
        author: z.string(),
        /** Null: it asked for none, which counts as patch. */
        bump: bumpSchema.nullable(),
        mergedAt: z.number(),
      })
    ),
    /** The latest release's tag. */
    latest: z.string().nullable(),
    /** The version the pull requests make; null for a first release (typed) or with nothing landed. */
    next: z.string().nullable(),
    /** The default branch head, the `headSha` to cut with. */
    head: z.string().nullable(),
    notesPreview: z.string(),
  })
  .openapi('UnreleasedChanges');

const tagSchema = z
  .object({
    name: z.string(),
    sha: z.string(),
    /** The release this tag is, else null (a hand-pushed tag). */
    release: z.string().nullable(),
  })
  .openapi('Tag');

const conflictSchema = z.object({
  error: z.string(),
  head: z.string().optional(),
});

const tagParams = ownerRepoParams.extend({ tag: z.string() });

export const releasesRouter = new OpenAPIHono<RepoEnv>({
  defaultHook: validationHook,
});
// Only these routes: the other repository routers load the repository for their own paths.
releasesRouter.use('/:owner/:repo/releases', loadRepo);
releasesRouter.use('/:owner/:repo/releases/*', loadRepo);
releasesRouter.use('/:owner/:repo/tags', loadRepo);

const listRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/releases',
  tags: ['Releases'],
  summary: 'Releases',
  description: 'Every release, newest version first.',
  request: { params: ownerRepoParams },
  responses: {
    ...json200Response(z.array(releaseSchema), 'Releases'),
    ...json404Response,
  },
});
releasesRouter.openapi(listRoute, async (c) =>
  c.json(await listReleases(c.get('db'), c.get('repo')), 200)
);

// Registered before `/releases/{tag}` so "unreleased" is not read as a tag.
const unreleasedRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/releases/unreleased',
  tags: ['Releases'],
  summary: 'Unreleased changes',
  description:
    'Pull requests merged into the default branch since the latest release, the version they would make, the default branch head to cut with, and the notes a cut would write.',
  request: { params: ownerRepoParams },
  responses: {
    ...json200Response(unreleasedSchema, 'Unreleased changes'),
    ...json404Response,
  },
});
releasesRouter.openapi(unreleasedRoute, async (c) => {
  const repo = c.get('repo');
  const { owner, repo: name } = c.req.valid('param');
  const [u, refs] = await Promise.all([
    unreleased(
      c.get('db'),
      repo,
      new URL(c.req.url).origin,
      `${owner}/${name}`
    ),
    c.get('git').refs(),
  ]);
  return c.json(
    {
      pulls: u.pulls,
      latest: u.latest?.tag ?? null,
      next: u.next,
      head: refs.get(`refs/heads/${repo.defaultBranch}`) ?? null,
      notesPreview: u.notesPreview,
    },
    200
  );
});

const getRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/releases/{tag}',
  tags: ['Releases'],
  summary: 'Release',
  request: { params: tagParams },
  responses: {
    ...json200Response(releaseSchema, 'The release'),
    ...json404Response,
  },
});
releasesRouter.openapi(getRoute, async (c) => {
  const release = await getRelease(
    c.get('db'),
    c.get('repo'),
    c.req.valid('param').tag
  );
  return release ? c.json(release, 200) : c.json({ error: 'Not found' }, 404);
});

const createReleaseRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/releases',
  tags: ['Releases'],
  summary: 'Cut a release',
  description:
    'Tags the default branch head and records the release. `headSha` is the head the caller saw (`GET /releases/unreleased`); a moved branch is a 409 carrying the new `head`. Without `version` the next one is computed (a first release needs one). Needs push access.',
  request: {
    params: ownerRepoParams,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            headSha: z.string().min(1),
            version: z.string().optional(),
            title: z.string().max(256).optional(),
            notes: z.string().max(65536).optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(releaseSchema, 'The release'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
    409: {
      content: { 'application/json': { schema: conflictSchema } },
      description: 'Conflict',
    },
  },
});
releasesRouter.openapi(createReleaseRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have push access' }, 403);
  const { owner, repo: name } = c.req.valid('param');
  const body = c.req.valid('json');
  const result = await cutRelease({
    env: c.env,
    db: c.get('db'),
    repo: c.get('repo'),
    repoFullName: `${owner}/${name}`,
    origin: new URL(c.req.url).origin,
    actor: { id: c.get('user')!.id },
    headSha: body.headSha,
    version: body.version,
    title: body.title,
    notes: body.notes,
  });
  if (result.ok) return c.json(result.release, 201);
  if (result.status === 409)
    return c.json(
      {
        error: result.message,
        ...(result.head ? { head: result.head } : {}),
      },
      409
    );
  if (result.status === 403) return c.json({ error: result.message }, 403);
  return c.json({ error: result.message }, 400);
});

const updateRoute = createRoute({
  method: 'patch',
  path: '/{owner}/{repo}/releases/{tag}',
  tags: ['Releases'],
  summary: 'Edit a release',
  description:
    'Changes a release title or notes; nothing else about a release changes. Needs push access. Recorded in the audit log as `release.updated`.',
  request: {
    params: tagParams,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            title: z.string().min(1).max(256).optional(),
            notes: z.string().max(65536).optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(releaseSchema, 'The release'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
  },
});
releasesRouter.openapi(updateRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have push access' }, 403);
  const release = await updateRelease(
    c.get('db'),
    c.get('repo'),
    c.req.valid('param').tag,
    c.req.valid('json'),
    { id: c.get('user')!.id }
  );
  return release ? c.json(release, 200) : c.json({ error: 'Not found' }, 404);
});

const tagsRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/tags',
  tags: ['Releases'],
  summary: 'Tags',
  description:
    'Every tag with the release it is (null for a tag pushed by hand), newest name first.',
  request: { params: ownerRepoParams },
  responses: {
    ...json200Response(z.array(tagSchema), 'Tags'),
    ...json404Response,
  },
});
releasesRouter.openapi(tagsRoute, async (c) => {
  const [tags, cutTags] = await Promise.all([
    c.get('git').tags(),
    c
      .get('db')
      .select({ tag: releases.tag })
      .from(releases)
      .where(eq(releases.repositoryId, c.get('repo').id)),
  ]);
  const cut = new Set(cutTags.map((r) => r.tag));
  return c.json(
    tags.map((t) => ({ ...t, release: cut.has(t.name) ? t.name : null })),
    200
  );
});
