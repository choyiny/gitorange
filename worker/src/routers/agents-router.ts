import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { requireAdmin } from '../auth/guards';
import { repositoryAgents } from '../db/app.schema';
import {
  agentByHandle,
  createAgent,
  deleteAgent,
  listAgents,
  repositoryAgentList,
  serializeAgent,
} from '../agents/accounts';
import { AVATAR_PATH } from '../agents/config';
import {
  findRepoById,
  gitFor,
  loadRepo,
  permissionsFor,
  type RepoEnv,
} from '../lib/repos';
import type { AppEnv } from '../variables';
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
import { agentSchema, ownerRepoParams } from './schemas';

const handleParams = z.object({ handle: z.string() });

// ── /api/agents: every member ────────────────────────────────────────────────

export const agentsRouter = new OpenAPIHono<AppEnv>({
  defaultHook: validationHook,
});

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Agents'],
  responses: {
    ...json200Response(z.array(agentSchema), 'Every agent, by handle'),
  },
});
agentsRouter.openapi(listRoute, async (c) => {
  return c.json(
    (await listAgents(c.get('db'), c.get('user')!)).map(serializeAgent),
    200
  );
});

const avatarRoute = createRoute({
  method: 'get',
  path: '/{handle}/avatar',
  tags: ['Agents'],
  request: {
    params: handleParams,
    query: z.object({
      /** The commit to read avatar.png at; the default branch without it. */
      v: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional(),
    }),
  },
  responses: {
    200: { description: 'avatar.png from the agent repository' },
    ...json404Response,
  },
});
agentsRouter.openapi(avatarRoute, async (c) => {
  const db = c.get('db');
  const { v } = c.req.valid('query');
  const view = await agentByHandle(db, c.req.valid('param').handle);
  const found = view?.agent.repositoryId
    ? await findRepoById(db, view.agent.repositoryId)
    : undefined;
  if (!found || !(await permissionsFor(db, found.repo, c.get('user'))).read)
    return c.json({ error: 'Not Found' }, 404);
  const repo = await gitFor(c.env, found.repo).client.repo();
  const blob = v
    ? // Artifacts throws for an object ID that is a tree or blob rather than a commit: not found here.
      await repo.readFile({ ref: v, path: AVATAR_PATH }).catch(() => null)
    : await repo.readFile({ ref: found.repo.defaultBranch, path: AVATAR_PATH });
  if (!blob) return c.json({ error: 'Not Found' }, 404);
  return new Response(blob.stream(), {
    headers: {
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      // A commit's avatar never changes; the URL changes with each push.
      'Cache-Control': v
        ? 'private, max-age=31536000, immutable'
        : 'private, max-age=60',
    },
  }) as never;
});

// ── /api/admin/agents: Site admin → Agents ───────────────────────────────────

export const adminAgentsRouter = new OpenAPIHono<AppEnv>({
  defaultHook: validationHook,
});
adminAgentsRouter.use('*', requireAdmin);

const createAgentRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Agents'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            handle: z.string().min(1).max(39),
            name: z.string().trim().min(1).max(100),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(z.object({ agent: agentSchema }), 'Agent created'),
    ...json400Response,
    ...json403Response,
    ...json409Response,
  },
});
adminAgentsRouter.openapi(createAgentRoute, async (c) => {
  const result = await createAgent(
    c.env,
    c.get('db'),
    c.get('user')!,
    c.req.valid('json')
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ agent: serializeAgent(result.agent) }, 201);
});

const deleteAgentRoute = createRoute({
  method: 'delete',
  path: '/{handle}',
  tags: ['Agents'],
  request: { params: handleParams },
  responses: {
    ...json200Response(okSchema, 'Deleted: uninvited everywhere, history kept'),
    ...json403Response,
    ...json404Response,
  },
});
adminAgentsRouter.openapi(deleteAgentRoute, async (c) => {
  const db = c.get('db');
  const view = await agentByHandle(db, c.req.valid('param').handle);
  if (!view || view.agent.deletedAt)
    return c.json({ error: 'Agent not found' }, 404);
  await deleteAgent(db, view.agent.userId);
  return c.json({ ok: true as const }, 200);
});

// ── /api/repos/{owner}/{repo}/agents: Repository settings → Agents ───────────

export const repoAgentsRouter = new OpenAPIHono<RepoEnv>({
  defaultHook: validationHook,
});
repoAgentsRouter.use('/:owner/:repo/*', loadRepo);

const repoAgentParams = ownerRepoParams.extend({ handle: z.string() });
const ADMIN_ONLY = 'You must be an admin of this repository';

const listRepoAgentsRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/agents',
  tags: ['Agents'],
  request: { params: ownerRepoParams },
  responses: {
    ...json200Response(
      z.array(agentSchema.extend({ invitedAt: z.string() })),
      'Agents invited to review this repository'
    ),
    ...json404Response,
  },
});
repoAgentsRouter.openapi(listRepoAgentsRoute, async (c) => {
  const rows = await repositoryAgentList(
    c.get('db'),
    c.get('repo').id,
    c.get('user')!
  );
  return c.json(
    rows.map((r) => ({
      ...serializeAgent(r),
      invitedAt: r.invitedAt.toISOString(),
    })),
    200
  );
});

const inviteRoute = createRoute({
  method: 'put',
  path: '/{owner}/{repo}/agents/{handle}',
  tags: ['Agents'],
  request: { params: repoAgentParams },
  responses: {
    ...json200Response(okSchema, 'Invited (or already invited)'),
    ...json403Response,
    ...json404Response,
  },
});
repoAgentsRouter.openapi(inviteRoute, async (c) => {
  if (!c.get('perms').admin) return c.json({ error: ADMIN_ONLY }, 403);
  const db = c.get('db');
  const view = await agentByHandle(db, c.req.valid('param').handle);
  if (!view || view.agent.deletedAt)
    return c.json({ error: 'Agent not found' }, 404);
  await db
    .insert(repositoryAgents)
    .values({
      repositoryId: c.get('repo').id,
      agentId: view.agent.userId,
      invitedById: c.get('user')!.id,
      createdAt: new Date(),
    })
    .onConflictDoNothing();
  return c.json({ ok: true as const }, 200);
});

const removeRoute = createRoute({
  method: 'delete',
  path: '/{owner}/{repo}/agents/{handle}',
  tags: ['Agents'],
  request: { params: repoAgentParams },
  responses: {
    ...json200Response(okSchema, 'Removed'),
    ...json403Response,
    ...json404Response,
  },
});
repoAgentsRouter.openapi(removeRoute, async (c) => {
  if (!c.get('perms').admin) return c.json({ error: ADMIN_ONLY }, 403);
  const db = c.get('db');
  const view = await agentByHandle(db, c.req.valid('param').handle);
  if (!view) return c.json({ error: 'Agent not found' }, 404);
  await db
    .delete(repositoryAgents)
    .where(
      and(
        eq(repositoryAgents.repositoryId, c.get('repo').id),
        eq(repositoryAgents.agentId, view.agent.userId)
      )
    );
  return c.json({ ok: true as const }, 200);
});
