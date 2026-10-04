import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../variables';
import { approvalsFor } from '../review/inbox';
import { json200Response } from './openapi-helpers';
import { publicUserSchema } from './schemas';

export const approvalsRouter = new OpenAPIHono<AppEnv>();

const itemSchema = z.object({
  repo: z.object({ fullName: z.string(), name: z.string() }),
  pull: z.object({
    number: z.number(),
    title: z.string(),
    author: publicUserSchema.nullable(),
    updatedAt: z.string(),
  }),
  /** The latest review failed; a person can retry it or merge by hand. */
  reviewFailed: z.string().nullable(),
  /** AI couldn't resolve the conflicts, or its resolution was discarded. */
  resolutionFailed: z.string().nullable(),
  /** Flags of the latest review that nobody approved yet. */
  flags: z.array(
    z.object({
      id: z.string(),
      source: z.enum(['question', 'limit']),
      key: z.string(),
      title: z.string(),
      value: z.unknown(),
      paths: z.array(z.string()),
      detail: z.string().nullable(),
      detailModel: z.string().nullable(),
      approvedBy: z.null(),
      approvedAt: z.null(),
    })
  ),
});

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Pull requests'],
  responses: {
    ...json200Response(
      z.array(itemSchema),
      'Open pull requests waiting on a person, in repositories you can merge in'
    ),
  },
});
approvalsRouter.openapi(listRoute, async (c) =>
  c.json(await approvalsFor(c.env, c.get('db'), c.get('user')!), 200)
);
