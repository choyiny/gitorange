import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq } from 'drizzle-orm';
import { personalAccessTokens } from '../db/app.schema';
import { hashToken, randomToken } from '../lib/tokens';
import type { AppEnv } from '../variables';
import {
  json200Response,
  json201Response,
  okSchema,
  validationHook,
} from './openapi-helpers';

export const tokensRouter = new OpenAPIHono<AppEnv>({
  defaultHook: validationHook,
});

const tokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

const serialize = (t: typeof personalAccessTokens.$inferSelect) => ({
  id: t.id,
  name: t.name,
  lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
  expiresAt: t.expiresAt?.toISOString() ?? null,
  createdAt: t.createdAt.toISOString(),
});

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Tokens'],
  responses: { ...json200Response(z.array(tokenSchema), 'Your tokens') },
});
tokensRouter.openapi(listRoute, async (c) => {
  const rows = await c
    .get('db')
    .select()
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.userId, c.get('user')!.id))
    .orderBy(desc(personalAccessTokens.createdAt))
    .all();
  return c.json(rows.map(serialize), 200);
});

const createTokenRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Tokens'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(100),
            expiresInDays: z
              .number()
              .int()
              .min(1)
              .max(366)
              .nullable()
              .default(30),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(
      z.object({ token: tokenSchema, plaintext: z.string() }),
      'Token created'
    ),
  },
});
tokensRouter.openapi(createTokenRoute, async (c) => {
  const { name, expiresInDays } = c.req.valid('json');
  const plaintext = randomToken('gop_');
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    userId: c.get('user')!.id,
    name,
    tokenHash: await hashToken(plaintext),
    lastUsedAt: null,
    expiresAt: expiresInDays
      ? new Date(now.getTime() + expiresInDays * 86400_000)
      : null,
    createdAt: now,
  };
  await c.get('db').insert(personalAccessTokens).values(row);
  return c.json({ token: serialize(row), plaintext }, 201);
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Tokens'],
  request: { params: z.object({ id: z.string() }) },
  responses: { ...json200Response(okSchema, 'Deleted') },
});
tokensRouter.openapi(deleteRoute, async (c) => {
  await c
    .get('db')
    .delete(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.id, c.req.valid('param').id),
        eq(personalAccessTokens.userId, c.get('user')!.id)
      )
    );
  return c.json({ ok: true as const }, 200);
});
