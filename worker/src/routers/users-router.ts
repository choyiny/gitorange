import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { asc, desc, eq } from 'drizzle-orm';
import { repositories } from '../db/app.schema';
import { users } from '../db/auth.schema';
import { toPublicUser, userByUsername } from '../lib/users';
import type { AppEnv } from '../variables';
import {
  json200Response,
  json404Response,
  validationHook,
} from './openapi-helpers';
import { publicUserSchema, repoSchema } from './schemas';
import { serializeRepo } from './repos-router';

export const usersRouter = new OpenAPIHono<AppEnv>({
  defaultHook: validationHook,
});

const memberSchema = publicUserSchema.extend({
  // Only site admins (and the user themself) see email addresses.
  email: z.string().nullable(),
  role: z.string(),
  createdAt: z.string(),
});

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Users'],
  responses: { ...json200Response(z.array(memberSchema), 'All members') },
});
usersRouter.openapi(listRoute, async (c) => {
  const viewer = c.get('user')!;
  const rows = await c
    .get('db')
    .select()
    .from(users)
    .orderBy(asc(users.username))
    .all();
  return c.json(
    rows.map((u) => ({
      ...toPublicUser(u),
      email: viewer.role === 'admin' || viewer.id === u.id ? u.email : null,
      role: u.role ?? 'user',
      createdAt: u.createdAt.toISOString(),
    })),
    200
  );
});

const profileRoute = createRoute({
  method: 'get',
  path: '/{username}',
  tags: ['Users'],
  request: { params: z.object({ username: z.string() }) },
  responses: {
    ...json200Response(
      z.object({
        user: publicUserSchema.extend({ createdAt: z.string() }),
        repositories: z.array(repoSchema),
      }),
      'Profile'
    ),
    ...json404Response,
  },
});
usersRouter.openapi(profileRoute, async (c) => {
  const db = c.get('db');
  const user = await userByUsername(db, c.req.valid('param').username);
  if (!user) return c.json({ error: 'Not Found' }, 404);
  const repos = await db
    .select()
    .from(repositories)
    .where(eq(repositories.ownerId, user.id))
    .orderBy(desc(repositories.updatedAt))
    .all();
  const owner = toPublicUser(user);
  return c.json(
    {
      user: { ...owner, createdAt: user.createdAt.toISOString() },
      repositories: repos.map((r) => serializeRepo(r, owner)),
    },
    200
  );
});
