import { deleteRepositoryCache } from './cache';
import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { schema } from '../db/schema';
import {
  pullRequests,
  workflowJobs,
  workflowRuns,
  workflowSteps,
  type Repository,
} from '../db/app.schema';
import { ZERO_SHA } from '../git/remote';
import type { GitService } from '../git/service';
import { decoder } from '../git/bytes';
import { gitFor } from '../lib/repos';
import {
  planJobs,
  pullRequestMatches,
  pushMatches,
  type PlannedJob,
} from './plan';
import {
  parseWorkflow,
  WorkflowFileError,
  type WorkflowDef,
} from './workflow-file';

type Db = DrizzleD1Database<typeof schema>;

export const WORKFLOWS_DIR = '.github/workflows';

export type ActionsEvent =
  | {
      kind: 'push';
      ref: string;
      before: string;
      after: string;
      actorId: string | null;
    }
  | {
      kind: 'pull_request';
      number: number;
      title: string;
      baseRef: string;
      headRef: string;
      headSha: string;
      actorId: string | null;
    };

export type RefUpdate = { ref: string; old: string; new: string };

/** Actions is configured when the deployment has the run Workflow binding. */
export function actionsConfigured(env: CloudflareBindings): boolean {
  return Boolean((env as Partial<CloudflareBindings>).ACTIONS_RUN);
}

/** Every `.yml`/`.yaml` file directly under `.github/workflows` at `sha`. */
export async function readWorkflowFiles(
  git: GitService,
  sha: string
): Promise<{ path: string; text: string }[]> {
  const dir = await git.entryAt(sha, WORKFLOWS_DIR);
  if (dir?.type !== 'tree') return [];
  const files = dir.entries.filter(
    (e) => e.type === 'blob' && /\.ya?ml$/i.test(e.name)
  );
  const out: { path: string; text: string }[] = [];
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const bytes = await git.blob(f.hash);
    if (bytes)
      out.push({
        path: `${WORKFLOWS_DIR}/${f.name}`,
        text: decoder.decode(bytes),
      });
  }
  return out;
}

async function changedPaths(
  git: GitService,
  from: string,
  to: string
): Promise<string[] | null> {
  if (from === ZERO_SHA) return null;
  const [a, b] = await Promise.all([git.commit(from), git.commit(to)]);
  if (!a || !b) return null;
  return (await git.diffTrees(a.treeHash, b.treeHash)).map((c) => c.path);
}

/** The `github` expression context known when a run is created. */
export function githubContext(
  repoFullName: string,
  run: {
    event: string;
    ref: string;
    headSha: string;
    runNumber?: number;
    id?: string;
  },
  extra: {
    actor?: string;
    workflow?: string;
    baseRef?: string;
    headRef?: string;
    serverUrl?: string;
  } = {}
) {
  const refName = run.ref.replace(/^refs\/(heads|tags)\//, '');
  return {
    event_name: run.event,
    ref: run.ref,
    ref_name: refName,
    ref_type: run.ref.startsWith('refs/tags/') ? 'tag' : 'branch',
    sha: run.headSha,
    repository: repoFullName,
    repository_owner: repoFullName.split('/')[0],
    actor: extra.actor ?? '',
    workflow: extra.workflow ?? '',
    run_id: run.id ?? '',
    run_number: run.runNumber ?? 0,
    run_attempt: 1,
    base_ref: extra.baseRef ?? '',
    head_ref: extra.headRef ?? '',
    server_url: extra.serverUrl ?? '',
    workspace: '/workspace',
    event: {},
  };
}

/**
 * Creates queued runs for every workflow the event triggers, then starts one Cloudflare Workflow
 * per run. The D1 rows are written before the Workflow is created, so a crash in between leaves
 * a visible queued run rather than a job nobody tracks.
 */
export async function queueRuns(
  env: CloudflareBindings,
  db: Db,
  repo: Repository,
  repoFullName: string,
  event: ActionsEvent
): Promise<string[]> {
  if (!actionsConfigured(env)) return [];
  const git = gitFor(env, repo);
  const headSha = event.kind === 'push' ? event.after : event.headSha;
  const files = await readWorkflowFiles(git, headSha);
  if (!files.length) return [];

  let changed: string[] | null | undefined;
  const changes = async () => {
    if (changed !== undefined) return changed;
    if (event.kind === 'push')
      changed = await changedPaths(git, event.before, event.after);
    else {
      const baseSha = await git.resolve(event.baseRef);
      const base = baseSha ? await git.mergeBase(baseSha, event.headSha) : null;
      changed = base ? await changedPaths(git, base, event.headSha) : null;
    }
    return changed;
  };

  const ref =
    event.kind === 'push' ? event.ref : `refs/pull/${event.number}/head`;
  const displayTitle =
    event.kind === 'push'
      ? ((await git.commit(event.after))?.message.split('\n')[0] ?? event.ref)
      : event.title;
  const github = githubContext(
    repoFullName,
    { event: event.kind, ref, headSha },
    {
      baseRef: event.kind === 'pull_request' ? event.baseRef : '',
      headRef: event.kind === 'pull_request' ? event.headRef : '',
    }
  );

  const created: string[] = [];
  for (const file of files) {
    let wf: WorkflowDef | null = null;
    let jobs: PlannedJob[] = [];
    let error: string | null = null;
    try {
      wf = parseWorkflow(file.text);
      const filter = event.kind === 'push' ? wf.on.push : wf.on.pullRequest;
      if (!filter) continue;
      const matches =
        event.kind === 'push'
          ? pushMatches(
              filter,
              event.ref,
              filter.paths || filter.pathsIgnore ? await changes() : null
            )
          : pullRequestMatches(
              filter,
              event.baseRef,
              filter.paths || filter.pathsIgnore ? await changes() : null
            );
      if (!matches) continue;
      jobs = planJobs(wf, { ...github, workflow: wf.name ?? file.path });
    } catch (e) {
      if (!(e instanceof WorkflowFileError)) throw e;
      error = `Invalid workflow file: ${file.path}\n${e.message}`;
    }
    const id = await insertRun(db, {
      repo,
      path: file.path,
      name: wf?.name ?? file.path,
      event: event.kind,
      ref,
      headSha,
      displayTitle,
      actorId: event.actorId,
      jobs,
      error,
    });
    if (!error) await startRun(env, db, id);
    created.push(id);
  }
  return created;
}

/** Starts the Workflow for a queued run; a failure to start is recorded on the run. */
async function startRun(env: CloudflareBindings, db: Db, id: string) {
  try {
    await env.ACTIONS_RUN.create({ id, params: { runId: id } });
  } catch (e) {
    console.error('[actions] could not start run', id, e);
    await db
      .update(workflowRuns)
      .set({
        status: 'completed',
        conclusion: 'failure',
        errorMessage: 'The run could not be started. Try re-running it.',
        completedAt: new Date(),
      })
      .where(eq(workflowRuns.id, id));
  }
}

/** Re-runs a workflow at the same commit as a new run (GitHub's "Re-run all jobs"). */
export async function rerun(
  env: CloudflareBindings,
  db: Db,
  repo: Repository,
  repoFullName: string,
  run: typeof workflowRuns.$inferSelect,
  actorId: string
): Promise<string> {
  const files = await readWorkflowFiles(gitFor(env, repo), run.headSha);
  const file = files.find((f) => f.path === run.workflowPath);
  let jobs: PlannedJob[] = [];
  let error: string | null = null;
  let name = run.name;
  if (!file)
    error = `${run.workflowPath} does not exist at ${run.headSha.slice(0, 7)}.`;
  else {
    try {
      const wf = parseWorkflow(file.text);
      name = wf.name ?? file.path;
      jobs = planJobs(wf, {
        ...githubContext(repoFullName, run),
        workflow: name,
      });
    } catch (e) {
      if (!(e instanceof WorkflowFileError)) throw e;
      error = `Invalid workflow file: ${run.workflowPath}\n${e.message}`;
    }
  }
  const id = await insertRun(db, {
    repo,
    path: run.workflowPath,
    name,
    event: run.event,
    ref: run.ref,
    headSha: run.headSha,
    displayTitle: run.displayTitle,
    actorId,
    jobs,
    error,
  });
  if (!error) await startRun(env, db, id);
  return id;
}

// D1 caps bound parameters per statement, so wide multi-row inserts go in chunks.
const ROWS_PER_INSERT = 10;

async function insertRun(
  db: Db,
  r: {
    repo: Repository;
    path: string;
    name: string;
    event: 'push' | 'pull_request';
    ref: string;
    headSha: string;
    displayTitle: string;
    actorId: string | null;
    jobs: PlannedJob[];
    error: string | null;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  // The run number is claimed inside the INSERT; concurrent pushes retry on the unique index.
  for (let attempt = 0; ; attempt++) {
    try {
      await db.insert(workflowRuns).values({
        id,
        repositoryId: r.repo.id,
        runNumber:
          sql`(SELECT COALESCE(MAX(run_number), 0) + 1 FROM workflow_runs WHERE repository_id = ${r.repo.id})` as unknown as number,
        workflowPath: r.path,
        name: r.name,
        event: r.event,
        ref: r.ref,
        headSha: r.headSha,
        displayTitle: r.displayTitle.slice(0, 500),
        actorId: r.actorId,
        status: r.error ? 'completed' : 'queued',
        conclusion: r.error ? 'failure' : null,
        errorMessage: r.error,
        createdAt: now,
        completedAt: r.error ? now : null,
      });
      break;
    } catch (e) {
      if (attempt >= 4 || !String(e).includes('UNIQUE')) throw e;
    }
  }
  const stmts = [];
  for (const job of r.jobs) {
    const jobId = crypto.randomUUID();
    stmts.push(
      db.insert(workflowJobs).values({
        id: jobId,
        runId: id,
        jobKey: job.key,
        name: job.name,
        runsOn: job.runsOn,
        needs: job.needs,
        matrixValues: job.matrix,
      })
    );
    for (let i = 0; i < job.steps.length; i += ROWS_PER_INSERT)
      stmts.push(
        db.insert(workflowSteps).values(
          job.steps.slice(i, i + ROWS_PER_INSERT).map((s) => ({
            id: crypto.randomUUID(),
            jobId,
            number: s.number,
            name: s.name.slice(0, 500),
          }))
        )
      );
  }
  if (stmts.length)
    await db.batch(stmts as [(typeof stmts)[0], ...typeof stmts]);
  return id;
}

/**
 * Called after refs change (a git push or an in-app merge): queues `push` runs for each updated
 * branch or tag, and `pull_request` runs for open pull requests whose head branch moved.
 */
export async function onRefsUpdated(
  env: CloudflareBindings,
  db: Db,
  repo: Repository,
  repoFullName: string,
  updates: RefUpdate[],
  actorId: string | null
): Promise<void> {
  if (!actionsConfigured(env)) return;
  for (const u of updates) {
    if (u.new === ZERO_SHA) continue;
    if (!u.ref.startsWith('refs/heads/') && !u.ref.startsWith('refs/tags/'))
      continue;
    try {
      await queueRuns(env, db, repo, repoFullName, {
        kind: 'push',
        ref: u.ref,
        before: u.old,
        after: u.new,
        actorId,
      });
      if (!u.ref.startsWith('refs/heads/')) continue;
      const branch = u.ref.slice('refs/heads/'.length);
      const prs = await db
        .select()
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repositoryId, repo.id),
            eq(pullRequests.state, 'open'),
            eq(pullRequests.headRef, branch)
          )
        );
      for (const pr of prs)
        await queueRuns(env, db, repo, repoFullName, {
          kind: 'pull_request',
          number: pr.number,
          title: pr.title,
          baseRef: pr.baseRef,
          headRef: pr.headRef,
          headSha: u.new,
          actorId,
        });
    } catch (e) {
      console.error('[actions] could not queue runs for', u.ref, e);
    }
  }
}

/** Diffs two ref snapshots into the updates a push made. */
export function diffRefs(
  before: Map<string, string>,
  after: Map<string, string>
): RefUpdate[] {
  const out: RefUpdate[] = [];
  for (const [ref, sha] of after) {
    const old = before.get(ref) ?? ZERO_SHA;
    if (old !== sha) out.push({ ref, old, new: sha });
  }
  for (const [ref, sha] of before)
    if (!after.has(ref)) out.push({ ref, old: sha, new: ZERO_SHA });
  return out;
}

/**
 * Deletes every log a repository has in R2 — Actions step logs and AI merge-resolution
 * transcripts. Their rows go with the repository via cascade.
 */
export async function deleteRepositoryLogs(
  env: CloudflareBindings,
  repositoryId: string
) {
  for (const prefix of [
    `actions/${repositoryId}/`,
    `merge-resolutions/${repositoryId}/`,
  ]) {
    let cursor: string | undefined;
    do {
      const page = await env.ACTIONS_LOGS.list({ prefix, cursor, limit: 1000 });
      if (page.objects.length)
        await env.ACTIONS_LOGS.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  await deleteRepositoryCache(env, repositoryId);
}
