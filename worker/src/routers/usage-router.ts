import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../variables';
import { isMonth, usageReport } from '../usage/report';
import {
  addDays,
  analyticsConfigured,
  dayOf,
  latestSync,
  syncUsage,
} from '../usage/sync';
import {
  json200Response,
  json400Response,
  json429Response,
  validationHook,
} from './openapi-helpers';

/** Site admins only (mounted behind requireAdmin). */
export const usageRouter = new OpenAPIHono<AppEnv>({
  defaultHook: validationHook,
});

const reportSchema = z
  .object({
    month: z.string(),
    analyticsConfigured: z.boolean(),
    totals: z.object({
      listCost: z.number(),
      dedicatedCost: z.number(),
      projectedListCost: z.number(),
      projectedDedicatedCost: z.number(),
    }),
  })
  .passthrough();

const reportRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Usage'],
  request: {
    query: z.object({
      month: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM')
        .optional(),
    }),
  },
  responses: {
    ...json200Response(
      reportSchema,
      "This deployment's usage and estimated cost for a month"
    ),
    ...json400Response,
  },
});
usageRouter.openapi(reportRoute, async (c) => {
  const month = c.req.valid('query').month ?? dayOf(new Date()).slice(0, 7);
  if (!isMonth(month)) return c.json({ error: 'month must be YYYY-MM' }, 400);
  return c.json(await usageReport(c.get('db'), c.env, month), 200);
});

/** Manual syncs re-read today and the last few days; older days are the cron's job. */
const MANUAL_SYNC_DAYS = 3;
const MANUAL_SYNC_INTERVAL_MS = 5 * 60_000;

const syncRoute = createRoute({
  method: 'post',
  path: '/sync',
  tags: ['Usage'],
  responses: {
    ...json200Response(
      z.object({
        days: z.array(z.string()),
        errors: z.record(z.string(), z.record(z.string(), z.string())),
      }),
      'Synced'
    ),
    ...json400Response,
    ...json429Response,
  },
});
usageRouter.openapi(syncRoute, async (c) => {
  if (!analyticsConfigured(c.env))
    return c.json(
      {
        error:
          'Cloudflare analytics are not set up: add the CF_ANALYTICS_TOKEN secret (Account Analytics: Read).',
      },
      400
    );
  const db = c.get('db');
  const last = await latestSync(db);
  if (
    last?.completedAt &&
    Date.now() - last.completedAt.getTime() < MANUAL_SYNC_INTERVAL_MS
  )
    return c.json(
      { error: 'Synced less than 5 minutes ago. Try again shortly.' },
      429
    );
  const today = dayOf(new Date());
  const days = Array.from({ length: MANUAL_SYNC_DAYS + 1 }, (_, i) =>
    addDays(today, -i)
  );
  const res = await syncUsage(c.env, days, { db });
  return c.json({ days: res.days, errors: res.errors }, 200);
});
