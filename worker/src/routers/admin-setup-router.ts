import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { runSetupChecks, testAiGateway } from '../lib/setup-checks';
import type { AppEnv } from '../variables';
import {
  json200Response,
  json401Response,
  json403Response,
  validationHook,
} from './openapi-helpers';

/** Site admin → Setup. Mounted at /api/admin/setup behind requireAdmin. */
export const adminSetupRouter = new OpenAPIHono<AppEnv>({
  defaultHook: validationHook,
});

const status = z.enum(['ok', 'warning', 'error']);
const checkSchema = z.object({
  id: z.string(),
  category: z.enum([
    'Secrets',
    'Bindings',
    'Connectivity',
    'Variables',
    'AI Gateway',
    'Usage & cost',
  ]),
  title: z.string(),
  status,
  /** One line: what's wrong and what breaks. Never a secret's value. */
  detail: z.string(),
  fix: z.array(
    z.object({
      text: z.string(),
      code: z.string().optional(),
      link: z.string().optional(),
    })
  ),
});

const getRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Admin'],
  summary: 'Check secrets, bindings, and variables (errors first)',
  responses: {
    ...json200Response(
      z.object({
        checks: z.array(checkSchema),
        counts: z.object({
          error: z.number(),
          warning: z.number(),
          ok: z.number(),
        }),
        checkedAt: z.string(),
      }),
      'Setup checks'
    ),
    ...json401Response,
    ...json403Response,
  },
});

adminSetupRouter.openapi(getRoute, async (c) => {
  const checks = await runSetupChecks(c.env, new URL(c.req.url).origin);
  const counts = { error: 0, warning: 0, ok: 0 };
  for (const ch of checks) counts[ch.status]++;
  c.header('Cache-Control', 'no-store');
  return c.json({ checks, counts, checkedAt: new Date().toISOString() }, 200);
});

const aiTestRoute = createRoute({
  method: 'post',
  path: '/ai-test',
  tags: ['Admin'],
  summary: 'Send one tiny Workers AI request through AI Gateway',
  responses: {
    ...json200Response(
      z.object({
        ok: z.boolean(),
        gateway: z.string().nullable(),
        logged: z.boolean(),
        detail: z.string(),
      }),
      'Test result'
    ),
    ...json401Response,
    ...json403Response,
  },
});

adminSetupRouter.openapi(aiTestRoute, async (c) =>
  c.json(await testAiGateway(c.env), 200)
);
