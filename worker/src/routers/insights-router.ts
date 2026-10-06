import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { loadRepo, type RepoEnv } from '../lib/repos';
import { INSIGHT_PERIODS, repoInsights } from '../lib/insights';
import {
  json200Response,
  json400Response,
  json404Response,
  validationHook,
} from './openapi-helpers';
import { ownerRepoParams } from './schemas';

export const insightsRouter = new OpenAPIHono<RepoEnv>({
  defaultHook: validationHook,
});
insightsRouter.use('/:owner/:repo/*', loadRepo);

const seconds = z.number().nullable();
const share = z.number().min(0).max(1).nullable();

const insightsSchema = z
  .object({
    days: z.number(),
    since: z.string(),
    until: z.string(),
    pulls: z.object({
      opened: z.number(),
      merged: z.number(),
      autoMerged: z.number(),
      mergedByPerson: z.number(),
      autoMergeShare: share,
      mergedAfterHumanReview: z.number(),
      mergedHandsOff: z.number(),
      closedUnmerged: z.number(),
      openNow: z.number(),
    }),
    timeToMerge: z.object({ all: seconds, auto: seconds, person: seconds }),
    reviews: z.object({
      runs: z.number(),
      completed: z.number(),
      failed: z.number(),
      autoVerdicts: z.number(),
      humanVerdicts: z.number(),
      pullsReviewed: z.number(),
      pullsNeedingHuman: z.number(),
    }),
    flags: z.object({
      raised: z.number(),
      approved: z.number(),
      medianTimeToApproval: seconds,
      pendingNow: z.number(),
      pendingPullsNow: z.number(),
      byKind: z.array(
        z.object({
          source: z.enum(['question', 'limit', 'agent']),
          key: z.string(),
          title: z.string(),
          raised: z.number(),
          approved: z.number(),
        })
      ),
    }),
    resolutions: z.object({
      attempts: z.number(),
      succeeded: z.number(),
      applied: z.number(),
      failed: z.number(),
      rejected: z.number(),
      inProgress: z.number(),
      pulls: z.number(),
    }),
    ci: z.object({
      runs: z.number(),
      succeeded: z.number(),
      failed: z.number(),
      cancelled: z.number(),
      passRate: share,
      medianTimeToGreen: seconds,
    }),
  })
  .openapi('RepoInsights');

const insightsRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/insights',
  tags: ['Repositories'],
  request: {
    params: ownerRepoParams,
    query: z.object({
      days: z
        .enum(INSIGHT_PERIODS.map(String) as [string, ...string[]])
        .default('30')
        .openapi({ description: 'The period, in days, ending now' }),
    }),
  },
  responses: {
    ...json200Response(
      insightsSchema,
      'Pull request, auto-merge review, AI conflict resolution, and CI numbers for the period'
    ),
    ...json400Response,
    ...json404Response,
  },
});
insightsRouter.openapi(insightsRoute, async (c) => {
  const { days } = c.req.valid('query');
  return c.json(
    await repoInsights(c.env, c.get('db'), c.get('repo'), Number(days)),
    200
  );
});
