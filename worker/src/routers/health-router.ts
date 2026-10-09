import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { repoHealth } from '../lib/health';
import { loadRepo, type RepoEnv } from '../lib/repos';
import {
  json200Response,
  json404Response,
  validationHook,
} from './openapi-helpers';
import { ownerRepoParams } from './schemas';

// A repository's health (worker/src/lib/health.ts), for anyone who can read the repository.

const trendSchema = z.enum(['better', 'same', 'worse']);

const healthAreaSchema = z
  .object({
    /** `agent:<handle>`, `tests` or `merging`. */
    id: z.string(),
    label: z.string(),
    /** An agent's colour; null for the other rows. */
    color: z.string().nullable(),
    /** The agent's handle, for an agent's row. */
    agent: z.string().nullable(),
    /** Problems this ISO week and last: an agent's findings, the percentage of test runs on main that failed, reverts. */
    thisWeek: z.number(),
    lastWeek: z.number(),
    /** The last 8 ISO weeks (Monday 00:00 UTC), oldest first. */
    weeks: z.array(z.number()),
    /** worse: more problems this week than last. */
    trend: trendSchema,
    status: z.string(),
    detail: z.string(),
    /** Problems open now. */
    open: z.number(),
  })
  .openapi('HealthArea');

const healthReportSchema = z
  .object({
    summary: z.string(),
    /** Findings waiting for a person, plus pull requests waiting for a person's approval for another reason. */
    decisionsWaiting: z.number(),
    /** One row per invited agent, then "Tests on main" and "Merging". */
    areas: z.array(healthAreaSchema),
    /** People and coding sessions that merged this week, most merged first. */
    contributors: z.array(
      z.object({
        who: z.object({
          kind: z.enum(['person', 'session']),
          label: z.string(),
          login: z.string(),
          client: z.string().nullable(),
        }),
        merged: z.number(),
        findings: z.number(),
        note: z.string().nullable(),
        trend: trendSchema,
      })
    ),
  })
  .openapi('HealthReport');

export const healthRouter = new OpenAPIHono<RepoEnv>({
  defaultHook: validationHook,
});
// Only this route: the other repository routers load the repository for their own paths.
healthRouter.use('/:owner/:repo/health', loadRepo);

const healthRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/health',
  tags: ['Health'],
  summary: 'Repository health',
  description:
    'Did anything get worse? Week over week (ISO weeks), from what GitOrange itself knows: each invited agent’s findings, the share of test runs on the default branch that failed, and reverts. Plus decisions waiting for a person and who merged what this week.',
  request: { params: ownerRepoParams },
  responses: {
    ...json200Response(healthReportSchema, 'The health report'),
    ...json404Response,
  },
});
healthRouter.openapi(healthRoute, async (c) =>
  c.json(await repoHealth(c.env, c.get('db'), c.get('git'), c.get('repo')), 200)
);
