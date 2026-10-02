import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import { USERNAME_RE, isReservedUsername } from '../lib/usernames';
import type { AppEnv } from '../variables';
import {
  json200Response,
  json400Response,
  json403Response,
  okSchema,
  validationHook,
} from './openapi-helpers';

export const setupRouter = new OpenAPIHono<AppEnv>({
  defaultHook: validationHook,
});

export async function countUsers(db: DrizzleDB) {
  const r = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(users)
    .get();
  return Number(r?.count ?? 0);
}

export const usernameSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(
    USERNAME_RE,
    'Username may only contain alphanumeric characters or single hyphens, and cannot begin or end with a hyphen.'
  )
  .refine((u) => !isReservedUsername(u), 'Username is reserved.');

const statusRoute = createRoute({
  method: 'get',
  path: '/status',
  tags: ['Setup'],
  responses: {
    ...json200Response(
      z.object({ setupRequired: z.boolean() }),
      'Setup status'
    ),
  },
});

setupRouter.openapi(statusRoute, async (c) => {
  return c.json({ setupRequired: (await countUsers(c.get('db'))) === 0 }, 200);
});

const createAdminRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Setup'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(100),
            username: usernameSchema,
            email: z.email(),
            password: z.string().min(8).max(128),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(okSchema, 'Admin created'),
    ...json400Response,
    ...json403Response,
  },
});

setupRouter.openapi(createAdminRoute, async (c) => {
  const db = c.get('db');
  // Closes forever once any user exists, so it can't be used to escalate later.
  if ((await countUsers(db)) > 0)
    return c.json({ error: 'Setup has already been completed' }, 403);
  const { name, username, email, password } = c.req.valid('json');
  try {
    await c.get('auth').api.createUser({
      body: {
        name,
        email,
        password,
        role: 'admin',
        data: { username: username.toLowerCase(), displayUsername: username },
      },
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'Could not create user' },
      400
    );
  }
  return c.json({ ok: true as const }, 200);
});
