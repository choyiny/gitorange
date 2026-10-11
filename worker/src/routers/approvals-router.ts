import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../variables';
import { approvalsFor, decodeCursor } from '../review/inbox';
import {
  json200Response,
  json400Response,
  json404Response,
  validationHook,
} from './openapi-helpers';
import {
  auditEventSchema,
  flagDecisionFields,
  personRefSchema,
  publicUserSchema,
  pullStateSchema,
} from './schemas';
import { agentFacets } from '../db/app.schema';
import { findingDetail } from '../review/finding';

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
    /** The coding app that opened it over MCP (null: by hand), its session label, and the session's id. */
    createdVia: z.string().nullable(),
    sessionLabel: z.string().nullable(),
    sessionId: z.string(),
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
          ...flagDecisionFields,
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
        /** Findings someone asked you to decide that still wait, across every page. */
        assignedToMe: z.number(),
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

/** One finding for its own page (/approvals/:flagId). */
const findingSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['needs_person', 'change_requested']),
    title: z.string(),
    /** needs_person: the agent's plain yes/no question for the owner. */
    question: z.string().nullable(),
    /** The finding as recorded: its sentence, table, diagram and the diff excerpts it cites (Markdown). */
    detail: z.string().nullable(),
    detailModel: z.string().nullable(),
    paths: z.array(z.string()),
    agentSha: z.string().nullable(),
    /** The commit it was raised on. */
    headSha: z.string(),
    /** Epoch milliseconds. */
    createdAt: z.number(),
    /** Never approved in bulk, by one key or by AI; approving it needs a reason. */
    guarded: z.boolean(),
    state: z.enum(['open', 'approved', 'dismissed', 'changes_requested']),
    decidedBy: personRefSchema.nullable(),
    decidedAt: z.number().nullable(),
    /** A moderator app's name, or "GitOrange AI"; null from the web, or while open. */
    decidedVia: z.string().nullable(),
    reason: z.string().nullable(),
    /** The note sent with a request for changes. */
    note: z.string().nullable(),
    teach: z.string().nullable(),
    teachBy: personRefSchema.nullable(),
    assignee: personRefSchema.nullable(),
    assignedBy: personRefSchema.nullable(),
    assignedAt: z.number().nullable(),
    repo: z.object({ fullName: z.string(), name: z.string() }),
    pull: z.object({
      number: z.number(),
      title: z.string(),
      state: z.enum(['open', 'closed', 'merged']),
      author: personRefSchema,
      headRef: z.string(),
      landTarget: z.string(),
      /** The branch tip now; null once closed or when it can't be read. */
      headSha: z.string().nullable(),
    }),
    agent: z
      .object({
        login: z.string(),
        name: z.string(),
        color: z.string(),
        facet: z.enum(agentFacets).nullable(),
        guarded: z.boolean(),
        bio: z.string(),
        repository: z.string().nullable(),
      })
      .nullable(),
    /** You let GitOrange AI decide this agent's findings on your pull requests. */
    delegated: z.boolean(),
    /** What you can do with it now: decide (push rights, open), undo your decision, delegate it, assign it. */
    can: z.object({
      decide: z.boolean(),
      undo: z.boolean(),
      delegate: z.boolean(),
      assign: z.boolean(),
    }),
    /** Its audit entries, oldest first. */
    history: z.array(auditEventSchema),
  })
  .openapi('Finding');

const findingRoute = createRoute({
  method: 'get',
  path: '/flags/{flagId}',
  tags: ['Pull requests'],
  summary: 'One finding, with its pull request, agent and history',
  request: { params: z.object({ flagId: z.string() }) },
  responses: {
    ...json200Response(findingSchema, 'The finding'),
    ...json404Response,
  },
});
approvalsRouter.openapi(findingRoute, async (c) => {
  const found = await findingDetail(
    c.env,
    c.get('db'),
    c.get('user')!,
    c.req.valid('param').flagId
  );
  if (!found) return c.json({ error: 'Not Found' }, 404);
  return c.json(found, 200);
});
