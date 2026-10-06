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
    /** The head commit its review (and what you'd approve) is of; null before any review. */
    headSha: z.string().nullable(),
  }),
  /** The latest review failed; a person can retry it or merge by hand. */
  reviewFailed: z.string().nullable(),
  /** AI couldn't resolve the conflicts, or its resolution was discarded. */
  resolutionFailed: z.string().nullable(),
  /** The latest recorded state: human_review items may have no flag (e.g. a dependency cycle). */
  pullState: pullStateSchema.nullable(),
  /** Must account for #pr, with nothing new since `since` (24 hours or more). */
  stackStale: z.array(z.object({ pr: z.number(), since: z.string() })),
  /** Other pull requests it couldn't be checked against. */
  stackUnchecked: z.array(z.number()),
  /** No agent was requested: a person approves the head commit. */
  needsApproval: z.boolean(),
  /** Agents waiting on a person: their failed reviews, and findings for a person. */
  agents: z.array(
    z.object({
      reviewerId: z.string(),
      agent: publicUserSchema,
      status: z.enum(['flagged', 'changes_requested', 'failed']),
      error: z.string().nullable(),
      flags: z.array(
        z.object({
          id: z.string(),
          source: z.enum(['question', 'limit', 'agent']),
          kind: z.enum(['needs_person', 'change_requested']),
          title: z.string(),
          paths: z.array(z.string()),
          detail: z.string().nullable(),
          detailModel: z.string().nullable(),
          agentSha: z.string().nullable(),
          approvedBy: publicUserSchema.nullable(),
          approvedAt: z.string().nullable(),
          approvedVia: z.string().nullable(),
          changesRequestedBy: publicUserSchema.nullable(),
          changesRequestedAt: z.string().nullable(),
          changesRequestedNote: z.string().nullable(),
        })
      ),
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
         * failed resolution, each stale must-account-for block, each pull request with unchecked stack pairs, and each pull request requiring human review that has none of those. */
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
