import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { liveFeed } from '../lib/live-feed';
import { mergeQueue, setMergingPaused } from '../lib/queue';
import { loadRepo, type RepoEnv } from '../lib/repos';
import {
  json200Response,
  json400Response,
  json403Response,
  json404Response,
  validationHook,
} from './openapi-helpers';
import { auditEventSchema, ownerRepoParams } from './schemas';
import { personRefSchema, sessionSummarySchema } from './sessions-router';

// The merge queue and pausing merging (worker/src/lib/queue.ts), and the Live page's payload
// (worker/src/lib/live-feed.ts). Anyone who can read the repository reads them; pausing and resuming take push access.

const pausedSchema = z
  .object({
    /** Since when, epoch milliseconds. */
    at: z.number(),
    by: personRefSchema,
  })
  .nullable()
  .openapi('MergingPaused');

export const queueTargetSchema = z
  .object({
    /** The branch they land on. */
    target: z.string(),
    /** Set while merging is paused on the repository (every target alike). */
    paused: pausedSchema,
    /** In the order they are expected to land. */
    entries: z.array(
      z.object({
        position: z.number(),
        number: z.number(),
        title: z.string(),
        author: personRefSchema,
        /** The app that opened it; null means by hand. */
        createdVia: z.string().nullable(),
        /** The session label that app reported. */
        session: z.string().nullable(),
        /** The id `GET /sessions` gives its session; never null (a pull request by hand is its author's session). */
        sessionId: z.string(),
        /** Its pull request state: agent_followup, human_review, waiting or ready. */
        state: z.string(),
        /** What holds it back, in plain words; empty when it is ready. */
        blockers: z.array(z.string()),
        /** Minutes until it is expected to land; null without run or review history. */
        etaMinutes: z.number().nullable(),
      })
    ),
  })
  .openapi('QueueTarget');

const livePayloadSchema = z
  .object({
    queue: z.array(queueTargetSchema),
    /** Open pull requests grouped by coding session or person. */
    floor: z.array(sessionSummarySchema),
    /** The newest 50 audit and pull request events, newest first. */
    events: z.array(auditEventSchema),
  })
  .openapi('LivePayload');

export const queueRouter = new OpenAPIHono<RepoEnv>({
  defaultHook: validationHook,
});
// Only these routes: the other repository routers load the repository for their own paths.
queueRouter.use('/:owner/:repo/queue', loadRepo);
queueRouter.use('/:owner/:repo/merging/pause', loadRepo);
queueRouter.use('/:owner/:repo/live', loadRepo);

const fullName = (c: Context<RepoEnv>) =>
  `${c.get('namespace').username}/${c.get('repo').name}`;

const queueRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/queue',
  tags: ['Merge queue'],
  summary: 'Merge queue',
  description:
    'Per land target (the default branch first, then others with open pull requests), the open pull requests in the order they are expected to land: oldest first, after what each is stacked on or waits on. `blockers` say what holds each back; `etaMinutes` adds the median recent Actions run and review time down the queue.',
  request: { params: ownerRepoParams },
  responses: {
    ...json200Response(z.array(queueTargetSchema), 'The merge queue'),
    ...json404Response,
  },
});
queueRouter.openapi(queueRoute, async (c) =>
  c.json(
    (await mergeQueue(c.env, c.get('db'), c.get('git'), c.get('repo'))).targets,
    200
  )
);

const pauseResponses = {
  ...json200Response(
    z.object({ paused: pausedSchema }),
    'Whether merging is paused now'
  ),
  ...json400Response,
  ...json403Response,
  ...json404Response,
};

const pauseRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/merging/pause',
  tags: ['Merge queue'],
  summary: 'Pause merging',
  description:
    'Stops every landing on the repository (the merge button, MCP and auto-merge) until someone resumes. Pull requests keep their place and agents keep working. Needs push access; recorded in the audit log (`merging.paused`, with the reason given). Pausing again changes nothing.',
  request: {
    params: ownerRepoParams,
    body: {
      required: false,
      content: {
        'application/json': {
          schema: z.object({
            /** Why, for the audit log. */
            reason: z.string().trim().max(200).optional(),
          }),
        },
      },
    },
  },
  responses: pauseResponses,
});
queueRouter.openapi(pauseRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have push access' }, 403);
  // The body is optional.
  const body = (c.req.valid('json') ?? {}) as { reason?: string };
  const paused = await setMergingPaused({
    env: c.env,
    db: c.get('db'),
    repo: c.get('repo'),
    repoFullName: fullName(c),
    user: c.get('user')!,
    paused: true,
    reason: body.reason || null,
    after: (work) => c.executionCtx.waitUntil(work),
  });
  return c.json({ paused }, 200);
});

const resumeRoute = createRoute({
  method: 'delete',
  path: '/{owner}/{repo}/merging/pause',
  tags: ['Merge queue'],
  summary: 'Resume merging',
  description:
    'Lets landings happen again, and lands whatever auto-merge finds ready now. Needs push access; recorded in the audit log (`merging.resumed`) when merging was paused.',
  request: { params: ownerRepoParams },
  responses: pauseResponses,
});
queueRouter.openapi(resumeRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have push access' }, 403);
  const paused = await setMergingPaused({
    env: c.env,
    db: c.get('db'),
    repo: c.get('repo'),
    repoFullName: fullName(c),
    user: c.get('user')!,
    paused: false,
    after: (work) => c.executionCtx.waitUntil(work),
  });
  return c.json({ paused }, 200);
});

const liveRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/live',
  tags: ['Merge queue'],
  summary: 'Live',
  description:
    'What the Live page shows: the merge queue, the requests floor (open pull requests grouped by coding session or person, with their states) and the newest 50 events of the audit log. Refetch it on the repository’s live pings.',
  request: { params: ownerRepoParams },
  responses: {
    ...json200Response(livePayloadSchema, 'The live payload'),
    ...json404Response,
  },
});
queueRouter.openapi(liveRoute, async (c) =>
  c.json(await liveFeed(c.env, c.get('db'), c.get('git'), c.get('repo')), 200)
);
