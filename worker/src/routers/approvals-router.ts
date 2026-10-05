import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../variables';
import { approvalsFor, decodeCursor } from '../review/inbox';
import {
  json200Response,
  json400Response,
  validationHook,
} from './openapi-helpers';
import { publicUserSchema, pullStateSchema } from './schemas';

export const approvalsRouter = new OpenAPIHono<AppEnv>({
  defaultHook: validationHook,
});

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
  /** The latest recorded state: human_review items may have no flag (e.g. a dependency cycle). */
  pullState: pullStateSchema.nullable(),
  /** Flags of the latest review that nobody approved yet (some may have changes requested). */
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
      changesRequestedBy: publicUserSchema.nullable(),
      changesRequestedAt: z.string().nullable(),
      changesRequestedNote: z.string().nullable(),
    })
  ),
});

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Pull requests'],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      /** `nextCursor` from the previous page. */
      cursor: z.string().optional(),
    }),
  },
  responses: {
    ...json200Response(
      z.object({
        /** One page, most recently updated pull request first. */
        items: z.array(itemSchema),
        /** How many things wait on you across every page: each unapproved flag, failed review and
         * failed resolution, and each pull request requiring human review that has none of those. */
        count: z.number(),
        /** Pass as `cursor` for the next page; null on the last page. */
        nextCursor: z.string().nullable(),
      }),
      'Open pull requests waiting on a person, in repositories you can merge in'
    ),
    ...json400Response,
  },
});
approvalsRouter.openapi(listRoute, async (c) => {
  const { limit, cursor: raw } = c.req.valid('query');
  const cursor = raw === undefined ? null : decodeCursor(raw);
  if (raw !== undefined && !cursor)
    return c.json({ error: 'Invalid cursor' }, 400);
  return c.json(
    await approvalsFor(c.env, c.get('db'), c.get('user')!, { limit, cursor }),
    200
  );
});
