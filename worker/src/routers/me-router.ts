import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../variables';
import { delegationsFor, setDelegations } from '../review/delegate';
import {
  errorSchema,
  json200Response,
  json400Response,
  validationHook,
} from './openapi-helpers';
import { auditEventSchema } from './schemas';

/** The signed-in person's own preferences: `/api/me/...`. */
export const meRouter = new OpenAPIHono<AppEnv>({
  defaultHook: validationHook,
});

const delegationsSchema = z
  .object({
    /** Every reviewer agent, and whether GitOrange AI decides its findings on your pull requests. */
    agents: z.array(
      z.object({
        handle: z.string(),
        name: z.string(),
        color: z.string(),
        /** Its findings always come to you: it can't be delegated. */
        guarded: z.boolean(),
        delegated: z.boolean(),
      })
    ),
    /**
     * GitOrange AI's answers for you since UTC midnight, newest first (`finding.delegated`). Each one's `data` holds
     * `finding` (its id), `decision` (approve, request_changes, leave), `reason`, `undone` (it no longer stands) and
     * `undoable` (still standing, on an open pull request: POST .../review/flags/{finding}/undo).
     */
    today: z.array(auditEventSchema),
  })
  .openapi('Delegations');

const getRoute = createRoute({
  method: 'get',
  path: '/delegations',
  tags: ['Users'],
  summary: 'Let GitOrange AI decide: your agents and what it did today',
  responses: {
    ...json200Response(delegationsSchema, 'Your delegations'),
  },
});
meRouter.openapi(getRoute, async (c) =>
  c.json(await delegationsFor(c.get('db'), c.get('user')!), 200)
);

const putRoute = createRoute({
  method: 'put',
  path: '/delegations',
  tags: ['Users'],
  summary: 'Choose the agents whose findings GitOrange AI decides for you',
  description:
    'Replaces the set: GitOrange AI decides these agents’ findings on pull requests you open, as you, right ' +
    'after each review. 400 for an agent nobody has; 422 for a guarded agent (its findings always come to a person).',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            /** Agent handles. */
            agents: z.array(z.string().min(1).max(100)).max(200),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(delegationsSchema, 'Your delegations now'),
    ...json400Response,
    422: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'A guarded agent',
    },
  },
});
meRouter.openapi(putRoute, async (c) => {
  const user = c.get('user')!;
  const result = await setDelegations(
    c.get('db'),
    user,
    c.req.valid('json').agents
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(await delegationsFor(c.get('db'), user), 200);
});
