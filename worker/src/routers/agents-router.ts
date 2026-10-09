import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, inArray, sql } from 'drizzle-orm';
import { requireAdmin } from '../auth/guards';
import { repositoryAgents, teams } from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import {
  agentByHandle,
  createAgent,
  deleteAgent,
  listAgents,
  repositoryAgentList,
  serializeAgent,
} from '../agents/accounts';
import { AVATAR_PATH } from '../agents/config';
import { inviteAgent, removeAgent } from '../agents/membership';
import { PRESET_FACETS, PRESETS } from '../agents/presets';
import { agentStats, builtinAgents } from '../lib/agent-stats';
import { recordAudit } from '../lib/audit';
import { settleStates } from '../pulls/settle';
import { autoMergeRepository } from '../review/auto-merge';
import { cancelAgentReviews } from '../review/reviewers';
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
import {
  agentPresetSchema,
  agentSchema,
  agentStatsSchema,
  builtinAgentSchema,
  ownerRepoParams,
} from './schemas';

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

/** Which of `handles` are taken by a user (an agent's included) or the team. */
async function takenHandles(db: DrizzleDB, handles: string[]) {
  const [byUsers, byTeam] = await db.batch([
    db
      .select({ name: sql<string>`lower(${users.username})` })
      .from(users)
      .where(inArray(sql`lower(${users.username})`, handles)),
    db
      .select({ name: teams.slug })
      .from(teams)
      .where(inArray(teams.slug, handles)),
  ]);
  return new Set([...byUsers, ...byTeam].map((r) => r.name));
}

const presetsRoute = createRoute({
  method: 'get',
  path: '/presets',
  tags: ['Agents'],
  responses: {
    ...json200Response(
      z.array(agentPresetSchema),
      'The seven reviewer presets, and whether each one exists'
    ),
  },
});
agentsRouter.openapi(presetsRoute, async (c) => {
  const taken = await takenHandles(
    c.get('db'),
    PRESET_FACETS.map((f) => PRESETS[f].handle)
  );
  return c.json(
    PRESET_FACETS.map((f) => {
      const p = PRESETS[f];
      return {
        facet: p.facet,
        name: p.name,
        handle: p.handle,
        bio: p.bio,
        color: p.color,
        guarded: p.guarded,
        triggerAsk: p.triggerAsk,
        triggerAbove: p.triggerAbove,
        engine: p.engine,
        recommended: p.recommended,
        exists: taken.has(p.handle),
      };
    }),
    200
  );
});

const builtinRoute = createRoute({
  method: 'get',
  path: '/builtin',
  tags: ['Agents'],
  summary: 'Clef and Fixer',
  description:
    'The two agents GitOrange has built in, with their last seven days: what Clef routed and how long a decision took, ' +
    'and what Fixer attempted, combined itself and saw merged anyway. Only repositories the caller can see count.',
  responses: {
    ...json200Response(z.array(builtinAgentSchema), 'Clef, then Fixer'),
  },
});
agentsRouter.openapi(builtinRoute, async (c) => {
  return c.json(await builtinAgents(c.get('db'), c.get('user')!), 200);
});

const statsRoute = createRoute({
  method: 'get',
  path: '/{handle}/stats',
  tags: ['Agents'],
  summary: "An agent's record",
  description:
    'How its findings fared (raised, kept, dismissed), the rules it learned, its reviews per day over the last 182 ' +
    'days, its best catch, and what it is doing in each repository it is invited to. Only repositories the caller ' +
    'can see count. A deleted agent keeps its history.',
  request: { params: handleParams },
  responses: {
    ...json200Response(agentStatsSchema, 'The agent’s stats'),
    ...json404Response,
  },
});
agentsRouter.openapi(statsRoute, async (c) => {
  const db = c.get('db');
  const view = await agentByHandle(db, c.req.valid('param').handle);
  if (!view) return c.json({ error: 'Agent not found' }, 404);
  return c.json(
    await agentStats(
      db,
      {
        userId: view.agent.userId,
        handle: view.user.username ?? view.user.id,
      },
      c.get('user')!
    ),
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
            /** Required without `preset`; with it, defaults to the preset's handle. */
            handle: z.string().min(1).max(39).optional(),
            /** Required without `preset`; with it, defaults to the preset's name. */
            name: z.string().trim().min(1).max(100).optional(),
            /** Start from a preset's AGENT.md (GET /api/agents/presets) instead of the blank one. */
            preset: z.enum(PRESET_FACETS).optional(),
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
  const body = c.req.valid('json');
  const preset = body.preset ? PRESETS[body.preset] : null;
  const handle = body.handle ?? preset?.handle;
  const name = body.name ?? preset?.name;
  if (!handle || !name)
    return c.json(
      {
        error: 'Give the agent a handle and a display name, or pick a preset.',
      },
      400
    );
  const result = await createAgent(c.env, c.get('db'), c.get('user')!, {
    handle,
    name,
    preset: body.preset,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ agent: serializeAgent(result.agent) }, 201);
});

const crewRoute = createRoute({
  method: 'post',
  path: '/crew',
  tags: ['Agents'],
  summary: 'Create the recommended crew',
  description:
    'Creates every recommended preset whose handle is free, each from its preset AGENT.md. Running it again ' +
    'creates only the ones still missing.',
  responses: {
    ...json200Response(
      z.object({
        created: z.array(agentSchema),
        /** Presets not created: their handle is taken, or creating them failed. */
        skipped: z.array(z.object({ handle: z.string(), reason: z.string() })),
      }),
      'The agents created, and the presets skipped'
    ),
    ...json403Response,
  },
});
adminAgentsRouter.openapi(crewRoute, async (c) => {
  const db = c.get('db');
  const crew = PRESET_FACETS.map((f) => PRESETS[f]).filter(
    (p) => p.recommended
  );
  const taken = await takenHandles(
    db,
    crew.map((p) => p.handle)
  );
  const created = [];
  const skipped: { handle: string; reason: string }[] = [];
  // One at a time: each creates a repository and its first commit.
  for (const p of crew) {
    if (taken.has(p.handle)) {
      skipped.push({ handle: p.handle, reason: 'Already exists' });
      continue;
    }
    const result = await createAgent(c.env, db, c.get('user')!, {
      handle: p.handle,
      name: p.name,
      preset: p.facet,
    });
    if (result.ok) created.push(serializeAgent(result.agent));
    else skipped.push({ handle: p.handle, reason: result.error });
  }
  return c.json({ created, skipped }, 200);
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
  const invited = await db
    .select({ id: repositoryAgents.repositoryId })
    .from(repositoryAgents)
    .where(eq(repositoryAgents.agentId, view.agent.userId))
    .all();
  await deleteAgent(db, view.agent.userId);
  await cancelAgentReviews(db, view.agent.userId);
  await recordAudit(db, {
    repositoryId: null,
    actorId: c.get('user')!.id,
    action: 'agent.deleted',
    target: view.user.username ?? view.user.id,
  });
  // Its reviews stop counting everywhere: states change, and pull requests it held back may land.
  for (const { id } of invited) {
    c.executionCtx.waitUntil(settleStates(c.env, db, id));
    c.executionCtx.waitUntil(autoMergeRepository(c.env, db, id));
  }
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
    ...json400Response,
    ...json403Response,
    ...json404Response,
  },
});
repoAgentsRouter.openapi(inviteRoute, async (c) => {
  if (!c.get('perms').admin) return c.json({ error: ADMIN_ONLY }, 403);
  const result = await inviteAgent(
    c.get('db'),
    c.get('repo').id,
    c.req.valid('param').handle,
    c.get('user')!.id
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
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
  const result = await removeAgent(
    c.env,
    c.get('db'),
    c.get('repo').id,
    c.req.valid('param').handle,
    c.get('user')!.id,
    (work) => c.executionCtx.waitUntil(work)
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true as const }, 200);
});
