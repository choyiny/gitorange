import { DurableObject } from 'cloudflare:workers';
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { workflowJobs, workflowRuns } from '../db/app.schema';
import { schema } from '../db/schema';
import { finishAbandoned } from './abandon';

/**
 * The instance's Actions job queue: at most `actions.max_concurrent_jobs` jobs hold a slot (run a
 * container) at once; the rest wait first-in, first-out. One Durable Object for the whole
 * instance, so the limit holds exactly however many runs ask at the same time.
 */
export const QUEUE_NAME = 'instance';
/**
 * A started job's slot is reclaimed this long after its deadline (start + timeout-minutes + its
 * cache-save window); the runner's own hard stop is 10 minutes past the timeout.
 */
export const RECLAIM_MARGIN_MS = 15 * 60_000;
/** How often the queue checks its entries against D1 while it isn't empty. */
export const SWEEP_MS = 5 * 60_000;
/** How long a waiting job waits for its grant event before asking again: 5, 10, 20, then 30 minutes. */
const RECHECKS = ['5 minutes', '10 minutes', '20 minutes', '30 minutes'];
export const slotRecheck = (i: number) =>
  RECHECKS[Math.min(Math.max(i, 1), RECHECKS.length) - 1];
/** The longest recheck: a granted job whose event was lost notices within this long. */
export const MAX_RECHECK_MS = 30 * 60_000;
/** A run whose entries are all waiting, the newest for less than this, isn't checked against its Workflow. */
export const FRESH_WAIT_MS = 10 * 60_000;
/** Job ids per D1 lookup (bound-parameter limit). */
const CHUNK = 50;

export interface SlotRequest {
  jobId: string;
  runId: string;
  /** The job's timeout-minutes plus its cache-save window: a started job holding its slot much longer is reclaimed. */
  maxMinutes: number;
  /** `actions.max_concurrent_jobs` when the job asked; the newest value wins. */
  limit: number;
}

export interface SlotStatus {
  granted: boolean;
  /** Jobs waiting in front of this one (0 once granted). */
  ahead: number;
}

/** A waiting job that was just given a slot; its Workflow is told with `slotEventType`. */
export interface Grant {
  jobId: string;
  runId: string;
}

/** RPC surface of the Durable Object. */
export interface ActionsQueueApi {
  acquire(req: SlotRequest): Promise<SlotStatus>;
  /** The job's container is starting: its reclaim deadline counts from now. */
  started(jobId: string, now?: number): Promise<void>;
  release(jobId: string): Promise<Grant[]>;
  cancelRun(runId: string): Promise<Grant[]>;
  positions(jobIds: string[]): Promise<Record<string, number>>;
  reclaim(now?: number): Promise<{ reclaimed: string[]; grants: Grant[] }>;
}

/** The Workflow event a waiting job listens for. */
export const slotEventType = (jobId: string) => `slot-${jobId}`;

export function queueConfigured(env: CloudflareBindings): boolean {
  return Boolean((env as Partial<CloudflareBindings>).ACTIONS_QUEUE);
}

export function actionsQueue(env: CloudflareBindings): ActionsQueueApi {
  return env.ACTIONS_QUEUE.getByName(QUEUE_NAME) as unknown as ActionsQueueApi;
}

/** Tells each granted job's Workflow to go on. Never throws: a lost event costs one recheck. */
export async function notifyGranted(
  env: CloudflareBindings,
  grants: Grant[]
): Promise<void> {
  if (!grants.length || !(env as Partial<CloudflareBindings>).ACTIONS_RUN)
    return;
  await Promise.allSettled(
    grants.map(async (g) => {
      const instance = await env.ACTIONS_RUN.get(g.runId);
      await instance.sendEvent({ type: slotEventType(g.jobId), payload: {} });
    })
  );
}

/** Gives a job's slot back and starts whoever was next. Never throws: a leak is reclaimed later. */
export async function releaseSlot(env: CloudflareBindings, jobId: string) {
  if (!queueConfigured(env)) return;
  try {
    await notifyGranted(env, await actionsQueue(env).release(jobId));
  } catch (e) {
    console.warn('[actions] could not release slot', jobId, e);
  }
}

/**
 * Marks a granted job as started (its container is about to boot). Throws, so a Workflow step
 * around it can retry; the caller decides what a final failure means.
 */
export async function markStarted(env: CloudflareBindings, jobId: string) {
  if (!queueConfigured(env)) return;
  await actionsQueue(env).started(jobId);
}

/** Takes a finished (cancelled or abandoned) run's jobs out of the queue. Never throws. */
export async function dropRun(env: CloudflareBindings, runId: string) {
  if (!queueConfigured(env)) return;
  try {
    await notifyGranted(env, await actionsQueue(env).cancelRun(runId));
  } catch (e) {
    console.warn('[actions] could not drop run from the queue', runId, e);
  }
}

/** Jobs ahead of each waiting job, for the run page. Never throws. */
export async function queuePositions(
  env: CloudflareBindings,
  jobIds: string[]
): Promise<Record<string, number>> {
  if (!jobIds.length || !queueConfigured(env)) return {};
  try {
    return await actionsQueue(env).positions(jobIds);
  } catch (e) {
    console.warn('[actions] could not read queue positions', e);
    return {};
  }
}

type Entry = {
  seq: number;
  job_id: string;
  run_id: string;
  max_ms: number;
  granted_at: number | null;
  started_at: number | null;
  queued_at: number;
};

export class ActionsQueue
  extends DurableObject<CloudflareBindings>
  implements ActionsQueueApi
{
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // seq is the arrival order; granted_at is null while the job waits; started_at is set when
    // its container starts booting.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      max_ms INTEGER NOT NULL,
      granted_at INTEGER,
      started_at INTEGER,
      queued_at INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec(
      'CREATE INDEX IF NOT EXISTS entries_run_idx ON entries (run_id)'
    );
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)'
    );
  }

  private limit(): number {
    const row = this.sql
      .exec<{ value: number }>("SELECT value FROM meta WHERE key = 'limit'")
      .toArray()[0];
    return row?.value ?? 10;
  }

  private statusOf(jobId: string): SlotStatus | null {
    const row = this.sql
      .exec<{
        seq: number;
        granted_at: number | null;
      }>('SELECT seq, granted_at FROM entries WHERE job_id = ?', jobId)
      .toArray()[0];
    if (!row) return null;
    if (row.granted_at !== null) return { granted: true, ahead: 0 };
    const { n } = this.sql
      .exec<{
        n: number;
      }>(
        'SELECT COUNT(*) AS n FROM entries WHERE granted_at IS NULL AND seq < ?',
        row.seq
      )
      .one();
    return { granted: false, ahead: n };
  }

  /** Gives free slots to the longest-waiting jobs. Synchronous, so no other call interleaves. */
  private pump(now = Date.now()): Grant[] {
    const { n } = this.sql
      .exec<{
        n: number;
      }>('SELECT COUNT(*) AS n FROM entries WHERE granted_at IS NOT NULL')
      .one();
    const free = this.limit() - n;
    if (free <= 0) return [];
    const next = this.sql
      .exec<{
        job_id: string;
        run_id: string;
      }>(
        'SELECT job_id, run_id FROM entries WHERE granted_at IS NULL ORDER BY seq LIMIT ?',
        free
      )
      .toArray();
    for (const e of next)
      this.sql.exec(
        'UPDATE entries SET granted_at = ? WHERE job_id = ?',
        now,
        e.job_id
      );
    return next.map((e) => ({ jobId: e.job_id, runId: e.run_id }));
  }

  /** An alarm sweeps for leaked slots while anything is queued or running. */
  private async keepSweeping() {
    const { n } = this.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM entries')
      .one();
    if (!n) await this.ctx.storage.deleteAlarm();
    else if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  async acquire(req: SlotRequest): Promise<SlotStatus> {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('limit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      Math.max(1, Math.floor(req.limit))
    );
    // Asking again (a replayed Workflow step) keeps the job's place.
    if (!this.statusOf(req.jobId))
      this.sql.exec(
        'INSERT INTO entries (job_id, run_id, max_ms, queued_at) VALUES (?, ?, ?, ?)',
        req.jobId,
        req.runId,
        Math.round(req.maxMinutes * 60_000),
        Date.now()
      );
    // A raised limit can start others too; they hear about it by event.
    const others = this.pump().filter((g) => g.jobId !== req.jobId);
    const status = this.statusOf(req.jobId)!;
    await this.keepSweeping();
    await notifyGranted(this.env, others);
    return status;
  }

  async started(jobId: string, now = Date.now()): Promise<void> {
    this.sql.exec(
      'UPDATE entries SET started_at = ? WHERE job_id = ? AND granted_at IS NOT NULL',
      now,
      jobId
    );
  }

  async release(jobId: string): Promise<Grant[]> {
    this.sql.exec('DELETE FROM entries WHERE job_id = ?', jobId);
    const grants = this.pump();
    await this.keepSweeping();
    return grants;
  }

  async cancelRun(runId: string): Promise<Grant[]> {
    this.sql.exec('DELETE FROM entries WHERE run_id = ?', runId);
    const grants = this.pump();
    await this.keepSweeping();
    return grants;
  }

  async positions(jobIds: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const id of jobIds) {
      const s = this.statusOf(id);
      if (s && !s.granted) out[id] = s.ahead;
    }
    return out;
  }

  /**
   * Frees slots a crash leaked: entries whose job row is gone (its repository was deleted) or
   * already finished; entries of runs that are finished in D1, or whose Workflow errored, was
   * terminated, or completed (an errored or terminated run is marked finished, as viewing it
   * would); and slots held past their deadline plus RECLAIM_MARGIN_MS. A started job's deadline is
   * its start plus timeout-minutes and cache-save window; a granted job that hasn't started yet
   * gets the longest recheck to notice its grant.
   */
  async reclaim(
    now = Date.now()
  ): Promise<{ reclaimed: string[]; grants: Grant[] }> {
    const entries = this.sql
      .exec<Entry>(
        'SELECT seq, job_id, run_id, max_ms, granted_at, started_at, queued_at FROM entries ORDER BY seq'
      )
      .toArray();
    const reclaimed = new Set<string>();
    for (const e of entries) {
      if (e.granted_at === null) continue;
      const deadline =
        e.started_at !== null
          ? e.started_at + e.max_ms
          : e.granted_at + MAX_RECHECK_MS;
      if (now > deadline + RECLAIM_MARGIN_MS) reclaimed.add(e.job_id);
    }
    const ids = entries.map((e) => e.job_id);
    const open = new Set<string>();
    const db = drizzle(this.env.DB, { schema });
    for (let i = 0; i < ids.length; i += CHUNK) {
      const rows = await db
        .select({ id: workflowJobs.id, status: workflowJobs.status })
        .from(workflowJobs)
        .where(inArray(workflowJobs.id, ids.slice(i, i + CHUNK)))
        .all();
      for (const r of rows) if (r.status !== 'completed') open.add(r.id);
    }
    for (const id of ids) if (!open.has(id)) reclaimed.add(id);

    // Runs whose Workflow is gone never give their slots back on their own.
    const runIds = [
      ...new Set(
        entries.filter((e) => !reclaimed.has(e.job_id)).map((e) => e.run_id)
      ),
    ];
    const finished = new Set<string>();
    for (let i = 0; i < runIds.length; i += CHUNK) {
      const rows = await db
        .select({ id: workflowRuns.id, status: workflowRuns.status })
        .from(workflowRuns)
        .where(inArray(workflowRuns.id, runIds.slice(i, i + CHUNK)))
        .all();
      for (const r of rows) if (r.status === 'completed') finished.add(r.id);
    }
    // Only runs holding a slot, or waiting a while, are worth a Workflow status call: a fresh
    // waiter's Workflow is plainly alive (it just asked).
    const worthChecking = new Set(
      entries
        .filter(
          (e) =>
            !reclaimed.has(e.job_id) &&
            (e.granted_at !== null || now - e.queued_at > FRESH_WAIT_MS)
        )
        .map((e) => e.run_id)
    );
    if ((this.env as Partial<CloudflareBindings>).ACTIONS_RUN)
      for (const runId of runIds) {
        if (finished.has(runId) || !worthChecking.has(runId)) continue;
        try {
          const { status } = await (
            await this.env.ACTIONS_RUN.get(runId)
          ).status();
          if (status === 'errored' || status === 'terminated')
            await finishAbandoned(
              db,
              runId,
              status === 'terminated' ? 'cancelled' : 'failure'
            );
          if (
            status === 'errored' ||
            status === 'terminated' ||
            status === 'complete'
          )
            finished.add(runId);
        } catch {
          // Unknown instance or a transient error: the D1 checks above still apply.
        }
      }
    for (const e of entries)
      if (finished.has(e.run_id)) reclaimed.add(e.job_id);

    for (const id of reclaimed)
      this.sql.exec('DELETE FROM entries WHERE job_id = ?', id);
    const grants = this.pump(now);
    await this.keepSweeping();
    await notifyGranted(this.env, grants);
    if (reclaimed.size)
      console.warn('[actions] reclaimed queue slots', [...reclaimed]);
    return { reclaimed: [...reclaimed], grants };
  }

  async alarm() {
    await this.reclaim();
  }
}
