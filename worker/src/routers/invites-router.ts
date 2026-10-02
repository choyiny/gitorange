import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { invitations } from '../db/app.schema';
import { users } from '../db/auth.schema';
import { sendInviteEmail } from '../lib/email';
import { hashToken, randomToken } from '../lib/tokens';
import { requireAdmin } from '../auth/guards';
import type { AppEnv } from '../variables';
import { usernameSchema } from './setup-router';
import {
  json200Response,
  json201Response,
  json400Response,
  json404Response,
  json409Response,
  okSchema,
  validationHook,
} from './openapi-helpers';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const invitesRouter = new OpenAPIHono<AppEnv>({
  defaultHook: validationHook,
});

const inviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(['admin', 'user']),
  acceptedAt: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
});

const serialize = (i: typeof invitations.$inferSelect) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  acceptedAt: i.acceptedAt?.toISOString() ?? null,
  expiresAt: i.expiresAt.toISOString(),
  createdAt: i.createdAt.toISOString(),
});

// ── admin ────────────────────────────────────────────────────────────────────
invitesRouter.use('/', requireAdmin);
invitesRouter.use('/manage/*', requireAdmin);

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Invitations'],
  responses: { ...json200Response(z.array(inviteSchema), 'Invitations') },
});
invitesRouter.openapi(listRoute, async (c) => {
  const rows = await c
    .get('db')
    .select()
    .from(invitations)
    .orderBy(desc(invitations.createdAt))
    .all();
  return c.json(rows.map(serialize), 200);
});

const createInviteRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Invitations'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            email: z.email(),
            role: z.enum(['admin', 'user']).default('user'),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(
      z.object({
        invitation: inviteSchema,
        inviteUrl: z.string(),
        emailed: z.boolean(),
      }),
      'Invitation created'
    ),
    ...json409Response,
  },
});
invitesRouter.openapi(createInviteRoute, async (c) => {
  const db = c.get('db');
  const { email, role } = c.req.valid('json');
  const normalized = email.toLowerCase();
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalized))
    .get();
  if (existing)
    return c.json({ error: 'A user with that email already exists' }, 409);
  const token = randomToken('inv_', 24);
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    email: normalized,
    role,
    tokenHash: await hashToken(token),
    invitedById: c.get('user')!.id,
    acceptedAt: null,
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    createdAt: now,
  };
  await db.insert(invitations).values(row);
  const inviteUrl = `${new URL(c.req.url).origin}/invite/${token}`;
  const inviter = c.get('user')!;
  const emailed = await sendInviteEmail(c.env, {
    to: normalized,
    inviterName: inviter.username ?? inviter.name,
    url: inviteUrl,
  });
  return c.json({ invitation: serialize(row), inviteUrl, emailed }, 201);
});

const revokeRoute = createRoute({
  method: 'delete',
  path: '/manage/{id}',
  tags: ['Invitations'],
  request: { params: z.object({ id: z.string() }) },
  responses: { ...json200Response(okSchema, 'Revoked') },
});
invitesRouter.openapi(revokeRoute, async (c) => {
  await c
    .get('db')
    .delete(invitations)
    .where(eq(invitations.id, c.req.valid('param').id));
  return c.json({ ok: true as const }, 200);
});

// ── public ───────────────────────────────────────────────────────────────────
async function findValidInvite(db: AppEnv['Variables']['db'], token: string) {
  const invite = await db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.tokenHash, await hashToken(token)),
        isNull(invitations.acceptedAt)
      )
    )
    .get();
  if (!invite || invite.expiresAt < new Date()) return null;
  return invite;
}

const validateRoute = createRoute({
  method: 'get',
  path: '/token/{token}',
  tags: ['Invitations'],
  request: { params: z.object({ token: z.string() }) },
  responses: {
    ...json200Response(
      z.object({ email: z.string(), inviter: z.string().nullable() }),
      'Valid invitation'
    ),
    ...json404Response,
  },
});
invitesRouter.openapi(validateRoute, async (c) => {
  const db = c.get('db');
  const invite = await findValidInvite(db, c.req.valid('param').token);
  if (!invite)
    return c.json({ error: 'This invitation is invalid or has expired' }, 404);
  const inviter = invite.invitedById
    ? await db
        .select()
        .from(users)
        .where(eq(users.id, invite.invitedById))
        .get()
    : null;
  return c.json(
    { email: invite.email, inviter: inviter?.username ?? null },
    200
  );
});

const acceptRoute = createRoute({
  method: 'post',
  path: '/accept',
  tags: ['Invitations'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            token: z.string(),
            name: z.string().min(1).max(100),
            username: usernameSchema,
            password: z.string().min(8).max(128),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ email: z.string() }), 'Account created'),
    ...json400Response,
  },
});
invitesRouter.openapi(acceptRoute, async (c) => {
  const db = c.get('db');
  const body = c.req.valid('json');
  const invite = await findValidInvite(db, body.token);
  if (!invite)
    return c.json({ error: 'This invitation is invalid or has expired' }, 400);
  const taken = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, body.username.toLowerCase()))
    .get();
  if (taken)
    return c.json(
      { error: `Username ${body.username} is not available.` },
      400
    );
  try {
    await c.get('auth').api.createUser({
      body: {
        email: invite.email,
        password: body.password,
        name: body.name,
        role: invite.role,
        data: {
          username: body.username.toLowerCase(),
          displayUsername: body.username,
        },
      },
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'Could not create account' },
      400
    );
  }
  await db
    .update(invitations)
    .set({ acceptedAt: new Date() })
    .where(eq(invitations.id, invite.id));
  return c.json({ email: invite.email }, 200);
});
