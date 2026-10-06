import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { asc, eq, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import type { AppEnv } from '../variables';
import { requireAdmin } from '../auth/guards';
import { instanceSettings, workflowRuns } from '../db/app.schema';
import {
  isSettingKey,
  listSettings,
  RETENTION_STATUS_KEY,
  setSetting,
} from '../lib/settings';
import type { RetentionStatus } from '../actions/retention';
import {
  json200Response,
  json400Response,
  json403Response,
  json404Response,
} from './openapi-helpers';

/** Site admin: instance settings (worker/src/lib/settings.ts). Site admins only. */
export const adminRouter = new OpenAPIHono<AppEnv>();
adminRouter.use('*', requireAdmin);

const settingSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  group: z.enum(['General', 'AI models', 'Reviews', 'Actions']),
  value: z.unknown(),
  default: z.unknown(),
  /** Saved in Site admin, rather than the default from wrangler or the built-in one. */
  overridden: z.boolean(),
  updatedAt: z.string().nullable(),
  /** Inclusive limits of a number setting. */
  min: z.number().optional(),
  max: z.number().optional(),
});

const listRoute = createRoute({
  method: 'get',
  path: '/settings',
  tags: ['Admin'],
  responses: {
    ...json200Response(
      z.object({
        settings: z.array(settingSchema),
        actions: z.object({
          runs: z.number(),
          oldestFinishedAt: z.string().nullable(),
          retention: z
            .object({
              at: z.string(),
              retentionDays: z.number().nullable(),
              deletedRuns: z.number(),
              more: z.boolean(),
            })
            .nullable(),
        }),
      }),
      'Every setting with its current value and default, plus Actions storage'
    ),
    ...json403Response,
  },
});
adminRouter.openapi(listRoute, async (c) => {
  const db = c.get('db');
  const [settings, runs, oldest, status] = await Promise.all([
    listSettings(db, c.env),
    db
      .select({ n: sql<number>`COUNT(*)` })
      .from(workflowRuns)
      .get(),
    db
      .select({ at: workflowRuns.completedAt })
      .from(workflowRuns)
      .where(eq(workflowRuns.status, 'completed'))
      .orderBy(asc(workflowRuns.completedAt))
      .limit(1)
      .get(),
    db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.key, RETENTION_STATUS_KEY))
      .get(),
  ]);
  return c.json(
    {
      settings,
      actions: {
        runs: Number(runs?.n ?? 0),
        oldestFinishedAt: oldest?.at?.toISOString() ?? null,
        retention: (status?.value as RetentionStatus | undefined) ?? null,
      },
    },
    200
  );
});

const keyParams = z.object({ key: z.string() });

const updateRoute = createRoute({
  method: 'put',
  path: '/settings/{key}',
  tags: ['Admin'],
  request: {
    params: keyParams,
    body: {
      content: {
        'application/json': { schema: z.object({ value: z.unknown() }) },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), 'Saved'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
  },
});
adminRouter.openapi(updateRoute, async (c) => {
  const { key } = c.req.valid('param');
  if (!isSettingKey(key)) return c.json({ error: 'Unknown setting' }, 404);
  try {
    await setSetting(
      c.get('db'),
      key,
      c.req.valid('json').value ?? null,
      c.get('user')!.id
    );
  } catch (e) {
    if (e instanceof ZodError)
      return c.json({ error: e.issues[0]?.message ?? 'Invalid value' }, 400);
    throw e;
  }
  return c.json({ ok: true as const }, 200);
});

const resetRoute = createRoute({
  method: 'delete',
  path: '/settings/{key}',
  tags: ['Admin'],
  request: { params: keyParams },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), 'Back to default'),
    ...json403Response,
    ...json404Response,
  },
});
adminRouter.openapi(resetRoute, async (c) => {
  const { key } = c.req.valid('param');
  if (!isSettingKey(key)) return c.json({ error: 'Unknown setting' }, 404);
  await setSetting(c.get('db'), key, undefined, c.get('user')!.id);
  return c.json({ ok: true as const }, 200);
});
