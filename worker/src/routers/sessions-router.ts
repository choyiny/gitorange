import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { repoSessions } from '../lib/sessions';
import { loadRepo, type RepoEnv } from '../lib/repos';
import {
  json200Response,
  json404Response,
  validationHook,
} from './openapi-helpers';
import { ownerRepoParams, pullStateSchema } from './schemas';

// Coding sessions (worker/src/lib/sessions.ts): the pull requests an app such as Claude Code opened, grouped by the
// app, the label it gave the session and the person it worked for. Anyone who can read the repository can read them.

/** Someone a page names: a member, or a reviewer agent. `login` is the username or agent handle. */
export const personRefSchema = z
  .object({
    login: z.string(),
    name: z.string().nullable(),
    isAgent: z.boolean(),
    /** An agent's colour (#rrggbb); null for a person. */
    color: z.string().nullable(),
  })
  .openapi('PersonRef');

export const sessionSummarySchema = z
  .object({
    id: z.string().openapi({ example: 's-a3e258a5a3' }),
    client: z.string().nullable().openapi({
      description: 'The app that opened them; null means by hand.',
    }),
    label: z
      .string()
      .nullable()
      .openapi({ description: 'The label the app gave the session.' }),
    author: personRefSchema,
    pulls: z.array(
      z.object({
        number: z.number(),
        title: z.string(),
        state: z.enum(['open', 'closed', 'merged']),
        /** Whose move it is; null unless the pull request is open (with both branches). */
        pullState: pullStateSchema.nullable(),
      })
    ),
    requests: z.array(z.object({ number: z.number(), text: z.string() })),
    /** When any of its pull requests last changed, epoch milliseconds. */
    lastActivity: z.number(),
  })
  .openapi('SessionSummary');

export const sessionsRouter = new OpenAPIHono<RepoEnv>({
  defaultHook: validationHook,
});
// Only these routes: the other repository routers load the repository for their own paths.
sessionsRouter.use('/:owner/:repo/sessions', loadRepo);
sessionsRouter.use('/:owner/:repo/sessions/*', loadRepo);

const listRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/sessions',
  tags: ['Sessions'],
  summary: 'Coding sessions',
  description:
    'The repository’s pull requests grouped by the app that opened them, the session label it reported and the person it worked for, most recently active first. Pull requests opened on the web or by `git push` form one "by hand" session per person (client and label null).',
  request: { params: ownerRepoParams },
  responses: {
    ...json200Response(z.array(sessionSummarySchema), 'Sessions'),
    ...json404Response,
  },
});
sessionsRouter.openapi(listRoute, async (c) =>
  c.json(
    await repoSessions(c.env, c.get('db'), c.get('git'), c.get('repo')),
    200
  )
);

const getRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/sessions/{id}',
  tags: ['Sessions'],
  summary: 'One coding session',
  request: { params: ownerRepoParams.extend({ id: z.string() }) },
  responses: {
    ...json200Response(sessionSummarySchema, 'The session'),
    ...json404Response,
  },
});
sessionsRouter.openapi(getRoute, async (c) => {
  const [session] = await repoSessions(
    c.env,
    c.get('db'),
    c.get('git'),
    c.get('repo'),
    { id: c.req.valid('param').id }
  );
  if (!session) return c.json({ error: 'Not Found' }, 404);
  return c.json(session, 200);
});
