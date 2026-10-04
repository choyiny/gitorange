import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { invitations, userEmails, type UserEmail } from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import { emailConfigured, sendEmailVerification } from '../lib/email';
import { hashToken, randomToken } from '../lib/tokens';
import type { AppEnv } from '../variables';
import {
  json200Response,
  json201Response,
  json400Response,
  json404Response,
  json409Response,
  json429Response,
  okSchema,
  validationHook,
} from './openapi-helpers';

/**
 * Settings → Emails: the alternate addresses a member authors commits with.
 *
 * Rules: an address belongs to one member instance-wide and is stored lowercased. A new alternate
 * is unverified and gets a link by email; only verified alternates (and account emails) attribute
 * commits. An unverified row reserves its address until its link expires; after that, another
 * member adding the address replaces the stale row.
 */
export const emailsRouter = new OpenAPIHono<AppEnv>({
  defaultHook: validationHook,
});

export const VERIFY_TTL_HOURS = 24;
export const RESEND_INTERVAL_MS = 60_000;
const MAX_ALTERNATES = 20;

const alternateSchema = z.object({
  id: z.string(),
  email: z.string(),
  label: z.string().nullable(),
  verified: z.boolean(),
  verifiedAt: z.string().nullable(),
  verificationExpiresAt: z.string().nullable(),
  createdAt: z.string(),
});

const serialize = (e: UserEmail) => ({
  id: e.id,
  email: e.email,
  label: e.label,
  verified: e.verifiedAt !== null,
  verifiedAt: e.verifiedAt?.toISOString() ?? null,
  verificationExpiresAt: e.verificationExpiresAt?.toISOString() ?? null,
  createdAt: e.createdAt.toISOString(),
});

const labelSchema = z
  .string()
  .trim()
  .max(40)
  .nullish()
  .transform((s) => s || null);

/** Issues a fresh verification link for `row` and emails it. Returns whether it was sent. */
async function sendVerification(
  c: { env: CloudflareBindings; req: { url: string } },
  db: DrizzleDB,
  row: UserEmail,
  username: string
): Promise<boolean> {
  const token = randomToken('gve_', 24);
  const now = new Date();
  await db
    .update(userEmails)
    .set({
      verificationTokenHash: await hashToken(token),
      verificationExpiresAt: new Date(
        now.getTime() + VERIFY_TTL_HOURS * 3600_000
      ),
      verificationSentAt: now,
    })
    .where(eq(userEmails.id, row.id));
  const origin = (c.env.BASE_URL || new URL(c.req.url).origin).replace(
    /\/$/,
    ''
  );
  return sendEmailVerification(c.env, {
    to: row.email,
    username,
    url: `${origin}/settings/emails/verify?token=${token}`,
    hours: VERIFY_TTL_HOURS,
  });
}

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Emails'],
  responses: {
    ...json200Response(
      z.object({
        primary: z.string(),
        alternates: z.array(alternateSchema),
        // False when the EMAIL binding or FROM_EMAIL is missing: links cannot be sent.
        emailConfigured: z.boolean(),
      }),
      'Your emails'
    ),
  },
});
emailsRouter.openapi(listRoute, async (c) => {
  const user = c.get('user')!;
  const rows = await c
    .get('db')
    .select()
    .from(userEmails)
    .where(eq(userEmails.userId, user.id))
    .orderBy(asc(userEmails.createdAt))
    .all();
  return c.json(
    {
      primary: user.email,
      alternates: rows.map(serialize),
      emailConfigured: emailConfigured(c.env),
    },
    200
  );
});

const addRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Emails'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
            label: labelSchema,
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(
      z.object({ email: alternateSchema, emailed: z.boolean() }),
      'Added (unverified); a verification link was emailed if possible'
    ),
    ...json400Response,
    ...json409Response,
  },
});
emailsRouter.openapi(addRoute, async (c) => {
  const db = c.get('db');
  const user = c.get('user')!;
  const { label } = c.req.valid('json');
  const email = c.req.valid('json').email;
  const now = new Date();

  const [owner, existing, invite, count] = await Promise.all([
    db
      .select({ id: users.id })
      .from(users)
      .where(eq(sql`lower(${users.email})`, email))
      .get(),
    db.select().from(userEmails).where(eq(userEmails.email, email)).get(),
    db
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, now)
        )
      )
      .get(),
    db
      .select({ n: sql<number>`count(*)` })
      .from(userEmails)
      .where(eq(userEmails.userId, user.id))
      .get(),
  ]);
  if (owner)
    return c.json(
      {
        error:
          owner.id === user.id
            ? 'That is already your primary email'
            : 'That email belongs to another member',
      },
      409
    );
  if (existing?.userId === user.id)
    return c.json({ error: 'You have already added that email' }, 409);
  if (existing) {
    const stale =
      !existing.verifiedAt &&
      (!existing.verificationExpiresAt ||
        existing.verificationExpiresAt <= now);
    if (!stale)
      return c.json({ error: 'That email belongs to another member' }, 409);
  }
  if (invite)
    return c.json(
      { error: 'That email has a pending invitation to this instance' },
      409
    );
  if (Number(count?.n ?? 0) >= MAX_ALTERNATES)
    return c.json(
      { error: `You can add at most ${MAX_ALTERNATES} emails` },
      400
    );

  const row: UserEmail = {
    id: crypto.randomUUID(),
    userId: user.id,
    email,
    label,
    verifiedAt: null,
    verificationTokenHash: null,
    verificationExpiresAt: null,
    verificationSentAt: null,
    createdAt: now,
  };
  try {
    // Replacing another member's expired, unverified claim and inserting ours happen together.
    if (existing)
      await db.batch([
        db.delete(userEmails).where(eq(userEmails.id, existing.id)),
        db.insert(userEmails).values(row),
      ]);
    else await db.insert(userEmails).values(row);
  } catch {
    // Lost a race for the same address.
    return c.json({ error: 'That email belongs to another member' }, 409);
  }
  const emailed = await sendVerification(
    c,
    db,
    row,
    user.username ?? user.name
  );
  const saved = await db
    .select()
    .from(userEmails)
    .where(eq(userEmails.id, row.id))
    .get();
  return c.json({ email: serialize(saved ?? row), emailed }, 201);
});

const idParams = z.object({ id: z.string() });

const ownRow = (db: DrizzleDB, id: string, userId: string) =>
  db
    .select()
    .from(userEmails)
    .where(and(eq(userEmails.id, id), eq(userEmails.userId, userId)))
    .get();

const updateRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Emails'],
  request: {
    params: idParams,
    body: {
      content: {
        'application/json': { schema: z.object({ label: labelSchema }) },
      },
    },
  },
  responses: {
    ...json200Response(alternateSchema, 'Updated'),
    ...json404Response,
  },
});
emailsRouter.openapi(updateRoute, async (c) => {
  const db = c.get('db');
  const row = await ownRow(db, c.req.valid('param').id, c.get('user')!.id);
  if (!row) return c.json({ error: 'Not Found' }, 404);
  const { label } = c.req.valid('json');
  await db.update(userEmails).set({ label }).where(eq(userEmails.id, row.id));
  return c.json(serialize({ ...row, label }), 200);
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Emails'],
  request: { params: idParams },
  responses: { ...json200Response(okSchema, 'Removed') },
});
emailsRouter.openapi(deleteRoute, async (c) => {
  await c
    .get('db')
    .delete(userEmails)
    .where(
      and(
        eq(userEmails.id, c.req.valid('param').id),
        eq(userEmails.userId, c.get('user')!.id)
      )
    );
  return c.json({ ok: true as const }, 200);
});

const resendRoute = createRoute({
  method: 'post',
  path: '/{id}/resend',
  tags: ['Emails'],
  request: { params: idParams },
  responses: {
    ...json200Response(
      z.object({ email: alternateSchema, emailed: z.boolean() }),
      'A new verification link was issued'
    ),
    ...json400Response,
    ...json404Response,
    ...json429Response,
  },
});
emailsRouter.openapi(resendRoute, async (c) => {
  const db = c.get('db');
  const user = c.get('user')!;
  const row = await ownRow(db, c.req.valid('param').id, user.id);
  if (!row) return c.json({ error: 'Not Found' }, 404);
  if (row.verifiedAt)
    return c.json({ error: 'That email is already verified' }, 400);
  if (
    row.verificationSentAt &&
    Date.now() - row.verificationSentAt.getTime() < RESEND_INTERVAL_MS
  )
    return c.json(
      { error: 'A link was sent less than a minute ago. Try again shortly.' },
      429
    );
  const emailed = await sendVerification(
    c,
    db,
    row,
    user.username ?? user.name
  );
  const saved = (await ownRow(db, row.id, user.id)) ?? row;
  return c.json({ email: serialize(saved), emailed }, 200);
});

const verifyRoute = createRoute({
  method: 'post',
  path: '/verify',
  tags: ['Emails'],
  request: {
    body: {
      content: {
        'application/json': { schema: z.object({ token: z.string().min(1) }) },
      },
    },
  },
  responses: {
    ...json200Response(alternateSchema, 'Verified'),
    ...json400Response,
    ...json404Response,
  },
});
emailsRouter.openapi(verifyRoute, async (c) => {
  const db = c.get('db');
  const user = c.get('user')!;
  const row = await db
    .select()
    .from(userEmails)
    .where(
      eq(
        userEmails.verificationTokenHash,
        await hashToken(c.req.valid('json').token)
      )
    )
    .get();
  // A link for someone else's address looks the same as a bad link.
  if (!row || row.userId !== user.id)
    return c.json({ error: 'This verification link is not valid' }, 404);
  if (!row.verificationExpiresAt || row.verificationExpiresAt <= new Date())
    return c.json(
      { error: 'This verification link has expired. Send a new one.' },
      400
    );
  const verified = {
    verifiedAt: new Date(),
    verificationTokenHash: null,
    verificationExpiresAt: null,
  };
  await db.update(userEmails).set(verified).where(eq(userEmails.id, row.id));
  return c.json(serialize({ ...row, ...verified }), 200);
});
