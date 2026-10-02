import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { repositories, teams } from '../db/app.schema';
import { users } from '../db/auth.schema';
import { requireAdmin } from '../auth/guards';
import { isValidSlug, namespaceTaken } from '../lib/namespaces';
import { getTeam, teamNamespace, userNamespace, visibleTo } from '../lib/repos';
import type { AppEnv } from '../variables';
import { serializeRepo } from './repos-router';
import { publicUserSchema, repoSchema } from './schemas';
import {
  json200Response,
  json400Response,
  json404Response,
  json409Response,
  validationHook,
} from './openapi-helpers';

const teamSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    createdAt: z.string(),
  })
  .openapi('Team');
const serializeTeam = (t: typeof teams.$inferSelect) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  createdAt: t.createdAt.toISOString(),
});

// ── /api/team: the instance's one shared team ────────────────────────────────

export const teamRouter = new OpenAPIHono<AppEnv>({
  defaultHook: validationHook,
});

const getTeamRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Team'],
  responses: {
    ...json200Response(
      z.object({ team: teamSchema.nullable() }),
      'The shared team, if created'
    ),
  },
});
teamRouter.openapi(getTeamRoute, async (c) => {
  const team = await getTeam(c.get('db'));
  return c.json({ team: team ? serializeTeam(team) : null }, 200);
});

const putTeamRoute = createRoute({
  method: 'put',
  path: '/',
  tags: ['Team'],
  middleware: [requireAdmin] as const,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().trim().min(1).max(100),
            slug: z.string().min(1).max(39),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ team: teamSchema }), 'Created or renamed'),
    ...json400Response,
    ...json409Response,
  },
});
teamRouter.openapi(putTeamRoute, async (c) => {
  const db = c.get('db');
  const { name } = c.req.valid('json');
  const slug = c.req.valid('json').slug.toLowerCase();
  if (!isValidSlug(slug)) {
    return c.json(
      {
        error:
          'Use letters, numbers, and single hyphens (no leading or trailing hyphen); some names are reserved.',
      },
      400
    );
  }
  const existing = await getTeam(db);
  if (await namespaceTaken(db, slug, { teamId: existing?.id })) {
    return c.json(
      { error: `"${slug}" is already a username or team name` },
      409
    );
  }
  if (existing) {
    await db.update(teams).set({ name, slug }).where(eq(teams.id, existing.id));
    return c.json({ team: serializeTeam({ ...existing, name, slug }) }, 200);
  }
  const team = { id: crypto.randomUUID(), slug, name, createdAt: new Date() };
  await db.insert(teams).values(team);
  return c.json({ team: serializeTeam(team) }, 200);
});

// ── /api/namespaces/{slug}: a user's or the team's page ──────────────────────

export const namespacesRouter = new OpenAPIHono<AppEnv>({
  defaultHook: validationHook,
});

const namespaceRoute = createRoute({
  method: 'get',
  path: '/{slug}',
  tags: ['Users', 'Team'],
  request: { params: z.object({ slug: z.string() }) },
  responses: {
    ...json200Response(
      z.object({
        kind: z.enum(['user', 'team']),
        owner: publicUserSchema.extend({ createdAt: z.string() }),
        repositories: z.array(repoSchema),
      }),
      'A user or the team, with the repositories the viewer can see'
    ),
    ...json404Response,
  },
});
namespacesRouter.openapi(namespaceRoute, async (c) => {
  const db = c.get('db');
  const viewer = c.get('user')!;
  const slug = c.req.valid('param').slug.toLowerCase();
  const team = await db.select().from(teams).where(eq(teams.slug, slug)).get();
  if (team) {
    const repos = await db
      .select()
      .from(repositories)
      .where(eq(repositories.teamId, team.id))
      .orderBy(desc(repositories.updatedAt))
      .all();
    const ns = teamNamespace(team);
    return c.json(
      {
        kind: 'team' as const,
        owner: {
          id: ns.id,
          username: ns.username,
          name: ns.name,
          image: null,
          createdAt: team.createdAt.toISOString(),
        },
        repositories: repos.map((r) => serializeRepo(r, ns)),
      },
      200
    );
  }
  const user = await db
    .select()
    .from(users)
    .where(eq(users.username, slug))
    .get();
  if (!user) return c.json({ error: 'Not Found' }, 404);
  const visible = visibleTo(viewer);
  const repos = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.ownerId, user.id),
        isNull(repositories.teamId),
        ...(visible ? [visible] : [])
      )
    )
    .orderBy(desc(repositories.updatedAt))
    .all();
  const ns = userNamespace(user);
  return c.json(
    {
      kind: 'user' as const,
      owner: {
        id: ns.id,
        username: ns.username,
        name: ns.name,
        image: ns.image,
        createdAt: user.createdAt.toISOString(),
      },
      repositories: repos.map((r) => serializeRepo(r, ns)),
    },
    200
  );
});
