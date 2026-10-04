import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  workflowJobs,
  workflowRuns,
  workflowSteps,
  type WorkflowRun,
} from '../db/app.schema';
import { actionsConfigured, rerun } from '../actions/trigger';
import { loadRepo, type RepoEnv } from '../lib/repos';
import { usersById, type PublicUser } from '../lib/users';
import {
  json200Response,
  json201Response,
  json400Response,
  json403Response,
  json404Response,
  validationHook,
} from './openapi-helpers';
import { ownerRepoParams, publicUserSchema } from './schemas';

export const actionsRouter = new OpenAPIHono<RepoEnv>({
  defaultHook: validationHook,
});
actionsRouter.use('/:owner/:repo/*', loadRepo);

const statusEnum = z.enum(['queued', 'in_progress', 'completed']);
const conclusionEnum = z
  .enum(['success', 'failure', 'cancelled', 'skipped'])
  .nullable();

const runSchema = z
  .object({
    id: z.string(),
    runNumber: z.number(),
    name: z.string(),
    workflowPath: z.string(),
    event: z.enum(['push', 'pull_request']),
    ref: z.string(),
    /** Branch or tag name for pushes; the head branch's PR number for pull_request runs. */
    refName: z.string(),
    pullRequestNumber: z.number().nullable(),
    headSha: z.string(),
    displayTitle: z.string(),
    actor: publicUserSchema.nullable(),
    status: statusEnum,
    conclusion: conclusionEnum,
    errorMessage: z.string().nullable(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .openapi('WorkflowRun');

const stepSchema = z.object({
  number: z.number(),
  name: z.string(),
  status: statusEnum,
  conclusion: conclusionEnum,
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

const jobSchema = z
  .object({
    id: z.string(),
    jobKey: z.string(),
    name: z.string(),
    runsOn: z.string(),
    needs: z.array(z.string()),
    status: statusEnum,
    conclusion: conclusionEnum,
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    steps: z.array(stepSchema),
  })
  .openapi('WorkflowJob');

function serializeRun(r: WorkflowRun, people: Map<string, PublicUser>) {
  const pr = /^refs\/pull\/(\d+)\/head$/.exec(r.ref);
  return {
    id: r.id,
    runNumber: r.runNumber,
    name: r.name,
    workflowPath: r.workflowPath,
    event: r.event,
    ref: r.ref,
    refName: r.ref.replace(/^refs\/(heads|tags)\//, ''),
    pullRequestNumber: pr ? Number(pr[1]) : null,
    headSha: r.headSha,
    displayTitle: r.displayTitle,
    actor: r.actorId ? (people.get(r.actorId) ?? null) : null,
    status: r.status,
    conclusion: r.conclusion,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
  };
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

const PAGE_SIZE = 25;

// ── list ─────────────────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/actions/runs',
  tags: ['Actions'],
  request: {
    params: ownerRepoParams,
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      workflow: z.string().optional(),
    }),
  },
  responses: {
    ...json200Response(
      z.object({
        configured: z.boolean(),
        totalCount: z.number(),
        workflows: z.array(z.object({ path: z.string(), name: z.string() })),
        runs: z.array(runSchema),
      }),
      'Workflow runs, newest first'
    ),
  },
});
actionsRouter.openapi(listRoute, async (c) => {
  const db = c.get('db');
  const repo = c.get('repo');
  const { page, workflow } = c.req.valid('query');
  const where = and(
    eq(workflowRuns.repositoryId, repo.id),
    workflow ? eq(workflowRuns.workflowPath, workflow) : undefined
  );
  const [total, rows, workflows] = await Promise.all([
    db
      .select({ n: sql<number>`COUNT(*)` })
      .from(workflowRuns)
      .where(where)
      .get(),
    db
      .select()
      .from(workflowRuns)
      .where(where)
      .orderBy(desc(workflowRuns.runNumber))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE)
      .all(),
    // The latest name each workflow file ran under. With MAX() in a grouped query, SQLite takes
    // the other columns from the row holding the maximum, i.e. each file's newest run.
    db
      .select({
        path: workflowRuns.workflowPath,
        name: workflowRuns.name,
        latest: sql<number>`MAX(${workflowRuns.runNumber})`,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.repositoryId, repo.id))
      .groupBy(workflowRuns.workflowPath)
      .orderBy(asc(workflowRuns.workflowPath))
      .all()
      .then((list) => list.map(({ path, name }) => ({ path, name }))),
  ]);
  const people = await usersById(
    db,
    rows.map((r) => r.actorId ?? '')
  );
  return c.json(
    {
      configured: actionsConfigured(c.env),
      totalCount: Number(total?.n ?? 0),
      workflows,
      runs: rows.map((r) => serializeRun(r, people)),
    },
    200
  );
});

// ── one run ──────────────────────────────────────────────────────────────────

const runParams = ownerRepoParams.extend({
  number: z.coerce.number().int().min(1),
});

async function getRun(
  c: { get: (k: 'db' | 'repo') => any },
  number: number
): Promise<WorkflowRun | undefined> {
  const db = c.get('db');
  return db
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.repositoryId, c.get('repo').id),
        eq(workflowRuns.runNumber, number)
      )
    )
    .get();
}

/**
 * A run whose Workflow died (crashed, or was terminated outside the app) would otherwise stay
 * "in progress" forever. When a viewer looks at an unfinished run, ask Workflows for the truth.
 */
async function reconcile(
  env: CloudflareBindings,
  db: RepoEnv['Variables']['db'],
  run: WorkflowRun
): Promise<WorkflowRun> {
  if (run.status === 'completed' || !actionsConfigured(env)) return run;
  if (Date.now() - run.createdAt.getTime() < 60_000) return run;
  try {
    const { status } = await (await env.ACTIONS_RUN.get(run.id)).status();
    if (status !== 'errored' && status !== 'terminated') return run;
    await finishAbandoned(
      db,
      run.id,
      status === 'terminated' ? 'cancelled' : 'failure'
    );
    return (await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, run.id))
      .get())!;
  } catch {
    return run;
  }
}

/** Marks a run and everything still open in it as finished. */
async function finishAbandoned(
  db: RepoEnv['Variables']['db'],
  runId: string,
  conclusion: 'cancelled' | 'failure'
) {
  const now = new Date();
  const open = inArray(workflowJobs.status, ['queued', 'in_progress']);
  const jobIds = (
    await db
      .select({ id: workflowJobs.id })
      .from(workflowJobs)
      .where(and(eq(workflowJobs.runId, runId), open))
      .all()
  ).map((j) => j.id);
  await db.batch([
    db
      .update(workflowRuns)
      .set({
        status: 'completed',
        conclusion,
        completedAt: now,
        errorMessage:
          conclusion === 'failure'
            ? 'The run stopped unexpectedly. Try re-running it.'
            : null,
      })
      .where(
        and(
          eq(workflowRuns.id, runId),
          inArray(workflowRuns.status, ['queued', 'in_progress'])
        )
      ),
    db
      .update(workflowJobs)
      .set({ status: 'completed', conclusion, completedAt: now })
      .where(and(eq(workflowJobs.runId, runId), open)),
    ...(jobIds.length
      ? [
          db
            .update(workflowSteps)
            .set({
              status: 'completed',
              conclusion: sql`CASE WHEN status = 'in_progress' THEN ${conclusion} ELSE 'skipped' END`,
              completedAt: now,
            })
            .where(
              and(
                inArray(workflowSteps.jobId, jobIds),
                inArray(workflowSteps.status, ['queued', 'in_progress'])
              )
            ),
        ]
      : []),
  ]);
  return jobIds;
}

const getRunRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/actions/runs/{number}',
  tags: ['Actions'],
  request: { params: runParams },
  responses: {
    ...json200Response(
      z.object({ run: runSchema, jobs: z.array(jobSchema) }),
      'A run with its jobs and steps'
    ),
    ...json404Response,
  },
});
actionsRouter.openapi(getRunRoute, async (c) => {
  const db = c.get('db');
  const found = await getRun(c, c.req.valid('param').number);
  if (!found) return c.json({ error: 'Not Found' }, 404);
  const run = await reconcile(c.env, db, found);
  const jobs = await db
    .select()
    .from(workflowJobs)
    .where(eq(workflowJobs.runId, run.id))
    .all();
  const steps = jobs.length
    ? await db
        .select()
        .from(workflowSteps)
        .where(
          inArray(
            workflowSteps.jobId,
            jobs.map((j) => j.id)
          )
        )
        .orderBy(asc(workflowSteps.number))
        .all()
    : [];
  const people = await usersById(db, [run.actorId ?? '']);
  return c.json(
    {
      run: serializeRun(run, people),
      jobs: jobs.map((j) => ({
        id: j.id,
        jobKey: j.jobKey,
        name: j.name,
        runsOn: j.runsOn,
        needs: j.needs,
        status: j.status,
        conclusion: j.conclusion,
        startedAt: iso(j.startedAt),
        completedAt: iso(j.completedAt),
        steps: steps
          .filter((s) => s.jobId === j.id)
          .map((s) => ({
            number: s.number,
            name: s.name,
            status: s.status,
            conclusion: s.conclusion,
            startedAt: iso(s.startedAt),
            completedAt: iso(s.completedAt),
          })),
      })),
    },
    200
  );
});

// ── logs ─────────────────────────────────────────────────────────────────────

const logsRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/actions/runs/{number}/jobs/{jobId}/steps/{step}/logs',
  tags: ['Actions'],
  request: {
    params: runParams.extend({
      jobId: z.string(),
      step: z.coerce.number().int().min(1),
    }),
  },
  responses: {
    200: {
      content: { 'text/plain': { schema: z.string() } },
      description: 'The step log; partial while the step is running',
    },
    ...json404Response,
  },
});
actionsRouter.openapi(logsRoute, async (c) => {
  const db = c.get('db');
  const { number, jobId, step } = c.req.valid('param');
  const run = await getRun(c, number);
  if (!run) return c.json({ error: 'Not Found' }, 404);
  const row = await db
    .select({ step: workflowSteps })
    .from(workflowSteps)
    .innerJoin(workflowJobs, eq(workflowJobs.id, workflowSteps.jobId))
    .where(
      and(
        eq(workflowJobs.runId, run.id),
        eq(workflowSteps.jobId, jobId),
        eq(workflowSteps.number, step)
      )
    )
    .get();
  if (!row) return c.json({ error: 'Not Found' }, 404);
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (row.step.status === 'in_progress' && actionsConfigured(c.env)) {
    try {
      const live = await c.env.JOB_RUNNER.getByName(jobId).live(step);
      if (live !== null) return c.text(live, 200, headers);
    } catch {
      // The runner is between steps or gone; fall through to the stored log.
    }
  }
  const obj = row.step.logR2Key
    ? await c.env.ACTIONS_LOGS.get(row.step.logR2Key)
    : null;
  return c.text(obj ? await obj.text() : '', 200, headers);
});

// ── cancel / re-run ──────────────────────────────────────────────────────────

const cancelRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/actions/runs/{number}/cancel',
  tags: ['Actions'],
  request: { params: runParams },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), 'Cancelled'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
  },
});
actionsRouter.openapi(cancelRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to cancel runs' }, 403);
  const db = c.get('db');
  const run = await getRun(c, c.req.valid('param').number);
  if (!run) return c.json({ error: 'Not Found' }, 404);
  if (run.status === 'completed')
    return c.json({ error: 'This run has already finished' }, 400);
  if (actionsConfigured(c.env)) {
    try {
      await (await c.env.ACTIONS_RUN.get(run.id)).terminate();
    } catch (e) {
      console.error('[actions] terminate failed', run.id, e);
    }
  }
  const jobIds = await finishAbandoned(db, run.id, 'cancelled');
  if (actionsConfigured(c.env))
    c.executionCtx.waitUntil(
      Promise.allSettled(
        jobIds.map((id) => c.env.JOB_RUNNER.getByName(id).destroy())
      )
    );
  return c.json({ ok: true as const }, 200);
});

const rerunRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/actions/runs/{number}/rerun',
  tags: ['Actions'],
  request: { params: runParams },
  responses: {
    ...json201Response(z.object({ runNumber: z.number() }), 'The new run'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
  },
});
actionsRouter.openapi(rerunRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to re-run runs' }, 403);
  if (!actionsConfigured(c.env))
    return c.json({ error: 'Actions is not set up on this server' }, 400);
  const db = c.get('db');
  const run = await getRun(c, c.req.valid('param').number);
  if (!run) return c.json({ error: 'Not Found' }, 404);
  const ns = c.get('namespace');
  const id = await rerun(
    c.env,
    db,
    c.get('repo'),
    `${ns.username}/${c.get('repo').name}`,
    run,
    c.get('user')!.id
  );
  const created = await db
    .select({ runNumber: workflowRuns.runNumber })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, id))
    .get();
  return c.json({ runNumber: created!.runNumber }, 201);
});

// ── commit status ────────────────────────────────────────────────────────────

const checksRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/commits/{sha}/runs',
  tags: ['Actions'],
  request: {
    params: ownerRepoParams.extend({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  },
  responses: {
    ...json200Response(
      z.object({
        state: z.enum(['success', 'failure', 'pending']).nullable(),
        runs: z.array(runSchema),
      }),
      'The latest run of each workflow for a commit, and their combined state'
    ),
  },
});
actionsRouter.openapi(checksRoute, async (c) => {
  const db = c.get('db');
  const { sha } = c.req.valid('param');
  const rows = await db
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.repositoryId, c.get('repo').id),
        eq(workflowRuns.headSha, sha)
      )
    )
    .orderBy(desc(workflowRuns.runNumber))
    .all();
  // Re-runs supersede earlier runs of the same workflow and event.
  const seen = new Set<string>();
  const latest = rows.filter((r) => {
    const k = `${r.workflowPath}\0${r.event}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const state = !latest.length
    ? null
    : latest.some((r) => r.status !== 'completed')
      ? 'pending'
      : latest.some(
            (r) => r.conclusion === 'failure' || r.conclusion === 'cancelled'
          )
        ? 'failure'
        : 'success';
  const people = await usersById(
    db,
    latest.map((r) => r.actorId ?? '')
  );
  return c.json(
    { state, runs: latest.map((r) => serializeRun(r, people)) },
    200
  );
});
