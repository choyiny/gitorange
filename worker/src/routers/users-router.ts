import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { asc } from 'drizzle-orm';
import { users } from '../db/auth.schema';
import { toPublicUser } from '../lib/users';
import type { AppEnv } from '../variables';
import {
  json200Response,
  json404Response,
  validationHook,
} from './openapi-helpers';
import { publicUserSchema } from './schemas';

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
