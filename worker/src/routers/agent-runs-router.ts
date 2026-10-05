import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, inArray, lt, or } from 'drizzle-orm';
import {
  agentRunKinds,
  agentRuns,
  agentSteps,
  pullRequests,
  type AgentRun,
  type AgentStep,
} from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import { loadRepo, type RepoEnv } from '../lib/repos';
import { stepDisplayName, stepPullId } from '../agent-runs/names';
import { displayedStatus } from '../agent-runs/record';
import {
  json200Response,
  json400Response,
  json404Response,
  validationHook,
} from './openapi-helpers';
import { ownerRepoParams } from './schemas';

/** Agent runs: AI processing (reviews, conflict resolutions, stack discovery, sweeps) in the Actions tab. */
export const agentRunsRouter = new OpenAPIHono<RepoEnv>({
  defaultHook: validationHook,
});
agentRunsRouter.use('/:owner/:repo/*', loadRepo);

const kindEnum = z.enum(agentRunKinds);
const statusEnum = z.enum(['running', 'succeeded', 'failed']);

const runSchema = z
  .object({
    id: z.string(),
    kind: kindEnum,
    status: statusEnum,
    title: z.string(),
    pullRequest: z.object({ number: z.number(), title: z.string() }).nullable(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    error: z.string().nullable(),
  })
  .openapi('AgentRun');

const stepSchema = z
  .object({
    id: z.string(),
    /** The Workflow step name, e.g. `summary:3`. */
    name: z.string(),
    displayName: z.string(),
    status: statusEnum,
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    attempts: z.number(),
    model: z.string().nullable(),
    tokensIn: z.number().nullable(),
    tokensOut: z.number().nullable(),
    /** Dollars at list price. */
    costEstimate: z.number().nullable(),
    decision: z.string().nullable(),
    error: z.string().nullable(),
  })
  .openapi('AgentStep');

const iso = (d: Date | null) => d?.toISOString() ?? null;
/** Ids bound per `IN (...)`: D1 allows 100 parameters per statement. */
const CHUNK = 90;

/** Rows of `ids`, looked up in chunks. */
async function pullsById(db: DrizzleDB, ids: string[]) {
  const out = new Map<string, { number: number; title: string }>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const rows = await db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        title: pullRequests.title,
      })
      .from(pullRequests)
      .where(inArray(pullRequests.id, unique.slice(i, i + CHUNK)))
      .all();
    for (const r of rows) out.set(r.id, { number: r.number, title: r.title });
  }
  return out;
}

function serializeRun(
  r: AgentRun,
  pulls: Map<string, { number: number; title: string }>
) {
  // A run left running long after it started shows as not finished (retention closes it later).
  const { status, error } = displayedStatus(r);
  return {
    id: r.id,
    kind: r.kind,
    status,
    title: r.title,
    pullRequest: r.pullRequestId ? (pulls.get(r.pullRequestId) ?? null) : null,
    startedAt: r.startedAt.toISOString(),
    finishedAt: iso(r.finishedAt),
    error,
  };
}

/** `<started at ms>.<id>`: the last run of a page. */
const encodeCursor = (r: AgentRun) => `${r.startedAt.getTime()}.${r.id}`;
function decodeCursor(cursor: string) {
  const dot = cursor.indexOf('.');
  const ms = Number(cursor.slice(0, dot));
  if (dot < 1 || !Number.isFinite(ms)) return null;
  return { startedAt: new Date(ms), id: cursor.slice(dot + 1) };
}

// ── list ─────────────────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/agent-runs',
  tags: ['Actions'],
  request: {
    params: ownerRepoParams,
    query: z.object({
      kind: kindEnum.optional(),
      /** A pull request number: only its runs. */
      pull: z.coerce.number().int().min(1).optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }),
  },
  responses: {
    ...json200Response(
      z.object({ runs: z.array(runSchema), nextCursor: z.string().nullable() }),
      'Agent runs, newest first'
    ),
    ...json400Response,
  },
});
agentRunsRouter.openapi(listRoute, async (c) => {
  const db = c.get('db');
  const repo = c.get('repo');
  const { kind, pull, cursor, limit } = c.req.valid('query');
  const after = cursor ? decodeCursor(cursor) : null;
  if (cursor && !after) return c.json({ error: 'cursor: invalid' }, 400);
  let pullId: string | undefined;
  if (pull) {
    const pr = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repo.id),
          eq(pullRequests.number, pull)
        )
      )
      .get();
    if (!pr) return c.json({ runs: [], nextCursor: null }, 200);
    pullId = pr.id;
  }
  const rows = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.repositoryId, repo.id),
        kind ? eq(agentRuns.kind, kind) : undefined,
        pullId ? eq(agentRuns.pullRequestId, pullId) : undefined,
        after
          ? or(
              lt(agentRuns.startedAt, after.startedAt),
              and(
                eq(agentRuns.startedAt, after.startedAt),
                lt(agentRuns.id, after.id)
              )
            )
          : undefined
      )
    )
    .orderBy(desc(agentRuns.startedAt), desc(agentRuns.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const pulls = await pullsById(
    db,
    page.flatMap((r) => (r.pullRequestId ? [r.pullRequestId] : []))
  );
  return c.json(
    {
      runs: page.map((r) => serializeRun(r, pulls)),
      nextCursor:
        rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    },
    200
  );
});

// ── one run ──────────────────────────────────────────────────────────────────

const getRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/agent-runs/{id}',
  tags: ['Actions'],
  request: { params: ownerRepoParams.extend({ id: z.string() }) },
  responses: {
    ...json200Response(
      z.object({
        run: runSchema.extend({
          tokensIn: z.number(),
          tokensOut: z.number(),
          costEstimate: z.number().nullable(),
        }),
        steps: z.array(stepSchema),
      }),
      'An agent run with its steps'
    ),
    ...json404Response,
  },
});
agentRunsRouter.openapi(getRoute, async (c) => {
  const db = c.get('db');
  const repo = c.get('repo');
  const { id } = c.req.valid('param');
  const run = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, id), eq(agentRuns.repositoryId, repo.id)))
    .get();
  if (!run) return c.json({ error: 'Not Found' }, 404);
  const steps: AgentStep[] = await db
    .select()
    .from(agentSteps)
    .where(eq(agentSteps.runId, run.id))
    .orderBy(asc(agentSteps.position))
    .all();
  const pulls = await pullsById(db, [
    ...(run.pullRequestId ? [run.pullRequestId] : []),
    ...steps.flatMap((s) => {
      const p = stepPullId(s.name);
      return p ? [p] : [];
    }),
  ]);
  const numbers = new Map([...pulls].map(([k, v]) => [k, v.number]));
  const costs = steps.flatMap((s) =>
    s.costEstimate === null ? [] : [s.costEstimate]
  );
  return c.json(
    {
      run: {
        ...serializeRun(run, pulls),
        tokensIn: steps.reduce((n, s) => n + (s.tokensIn ?? 0), 0),
        tokensOut: steps.reduce((n, s) => n + (s.tokensOut ?? 0), 0),
        costEstimate: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      },
      steps: steps.map((s) => ({
        id: s.id,
        name: s.name,
        displayName: stepDisplayName(s.name, numbers),
        status: s.status,
        startedAt: iso(s.startedAt),
        finishedAt: iso(s.finishedAt),
        attempts: s.attempts,
        model: s.model,
        tokensIn: s.tokensIn,
        tokensOut: s.tokensOut,
        costEstimate: s.costEstimate,
        decision: s.decision,
        error: s.error,
      })),
    },
    200
  );
});
