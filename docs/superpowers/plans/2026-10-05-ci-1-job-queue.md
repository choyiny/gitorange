# Actions Job Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitOrange Actions never runs more than `actions.max_concurrent_jobs` job containers at once across the instance; extra jobs wait first-in, first-out in a queue, and the run page shows "Queued (N ahead)".

**Architecture:** One SQLite-backed Durable Object, `ActionsQueue` (binding `ACTIONS_QUEUE`, one instance named `instance`), holds every waiting and running job and grants slots in arrival order up to the limit. Before booting its container, a job asks for a slot in a durable Workflow step; if it must wait, the `ActionsRun` Workflow blocks in `step.waitForEvent` for a grant event (sent by whoever freed the slot) with a 5-minute timeout, after which it asks again. Waiting holds no container, a lost event costs at most 5 minutes, and the step count stays small (two steps per 5 minutes of waiting). Slots are released when a job completes (any conclusion), when its runner is interrupted (it queues again for the restart), and when a run is cancelled or found abandoned; an alarm reclaims slots whose job row is gone or finished, or whose holder overran its `timeout-minutes` by 15 minutes.

**Tech Stack:** Cloudflare Durable Objects (SQLite storage, RPC, alarms), Cloudflare Workflows (`step.waitForEvent`, `instance.sendEvent`), Hono + Zod OpenAPI, Drizzle/D1, React + Primer CSS, Vitest in workerd (`@cloudflare/vitest-pool-workers`).

**Spec:** `docs/superpowers/specs/2026-10-05-ci-relevance-design.md` (section 1, "Instance-wide job queue"; Testing: "Queue").

## Global Constraints

- Setting: `actions.max_concurrent_jobs` in `worker/src/lib/settings.ts` (Site admin → Settings), default `10`, minimum `1`.
- Slots are granted first-in, first-out across the instance by one Durable Object (`ActionsQueue`), so the limit holds exactly under concurrency.
- A job without a slot stays `queued` and the run page shows "Queued (N ahead)".
- Release on complete, fail, cancel, or interrupted runner (the existing restart path); the next waiter is granted.
- A slot held by a job that no longer exists, or running past its `timeout-minutes` plus a margin, is reclaimed.
- Waiting is durable and never holds a container. Cancelling a run removes its queued jobs from the queue.
- Non-goals: `strategy.max-parallel` and `concurrency:` groups (still parsed and ignored).
- Project rules (CLAUDE.md): `yarn` only; a new binding goes in `wrangler.jsonc.example` (top level **and** `env.dev`), `wrangler.jsonc.ci`, `wrangler.test.jsonc`, `docs/configuration.md`, then `yarn cf-typegen`; never commit `wrangler.jsonc`; keep `/gitorange-onboarding` in sync; tests under `worker/src/__tests__/` against real D1 (never mock `env.DB`); done = `yarn test`, `yarn typecheck`, `yarn format`. No D1 schema change (the queue lives in the Durable Object's own storage), so no migration.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9
  ```

## Review Focus

- **A grant event that is lost or arrives before the Workflow waits** — the job must still start, at the latest one recheck (5 minutes) later. Pinned by "starts waiting jobs even when every grant event is lost" (Task 3).
- **The same job asking twice** (a Workflow step replayed after a crash) — must not take two slots. Pinned by "asking again is idempotent" (Task 2).
- **A limit lowered while jobs run** — running jobs keep going; nothing new starts until the count drops below the new limit. Pinned by "a raised limit grants on the next request; a lowered one only stops new grants" (Task 2).
- **A repository deleted (job rows gone) while its jobs hold or wait for slots** — slots must come back. Pinned by "reclaims slots whose job is gone or finished, and slots held past the timeout" (Task 2).
- **A deployer who has not added the `ACTIONS_QUEUE` binding yet** — runs must still work, unlimited, and Site admin → Setup must say why. Pinned by "runs jobs without a limit when the queue binding is missing" (Task 3) and the setup check (Task 2).

---

## File Structure

- Create `worker/src/actions/queue.ts` — the `ActionsQueue` Durable Object and the worker-side helpers (`actionsQueue`, `queueConfigured`, `releaseSlot`, `dropRun`, `queuePositions`, `notifyGranted`, `slotEventType`).
- Modify `worker/src/lib/settings.ts` — the `actions.max_concurrent_jobs` setting.
- Modify `src/components/AdminSettings.tsx` — numeric input for number settings.
- Modify `worker/src/index.ts` — export `ActionsQueue`.
- Modify `worker/src/lib/setup-checks.ts` — `ACTIONS_QUEUE` binding check.
- Modify `wrangler.jsonc.example`, `wrangler.jsonc.ci`, `wrangler.test.jsonc`; regenerate `worker/worker-configuration.d.ts`.
- Modify `worker/src/actions/executor.ts` — `StepRunner.waitForEvent`, `waitForSlot`, releases.
- Modify `worker/src/live/publish.ts` — `pingingSteps` passes `waitForEvent` through.
- Modify `worker/src/routers/actions-router.ts` — `queuedAhead` on jobs; cancel and reconcile drop the run from the queue.
- Modify `src/lib/uiApi.ts`, `src/pages/RunView.tsx` — "Queued (N ahead)".
- Create `worker/src/__tests__/helpers/actions.ts` — Actions test helpers moved out of `actions.test.ts` (plus `waitForEvent` and concurrency tracking in the harness).
- Modify `worker/src/__tests__/actions.test.ts` — imports the moved helpers.
- Modify `worker/src/__tests__/helpers/app.ts` — fake `sendEvent`, recorded events, and a per-test `ACTIONS_QUEUE`.
- Create `worker/src/__tests__/actions-queue.test.ts` — queue unit tests and executor/API integration tests.
- Modify `worker/src/__tests__/settings.test.ts` — the new setting.
- Modify `docs/configuration.md`, `docs/architecture.md`, `README.md`, `CLAUDE.md`, `.claude/skills/gitorange-onboarding/SKILL.md`.

---

### Task 1: The `actions.max_concurrent_jobs` setting

**Files:**

- Modify: `worker/src/lib/settings.ts` (the `SETTINGS` object, after `'actions.retention_days'`)
- Modify: `src/components/AdminSettings.tsx` (`SettingRow`)
- Test: `worker/src/__tests__/settings.test.ts`

**Interfaces:**

- Produces: `getSetting(db, env, 'actions.max_concurrent_jobs'): Promise<number>` (default `10`, integer, `1..500`).

- [ ] **Step 1: Write the failing test**

Add to the `describe('instance settings', …)` block in `worker/src/__tests__/settings.test.ts` (it already imports `drizzle`, `schema`, `makeEnv`, `bootstrapAdmin`, `call` and defines `get`/`put`):

```ts
it('limits Actions jobs running at once: 10 by default, a whole number of at least 1', async () => {
  const t = makeEnv();
  const admin = await bootstrapAdmin(t);
  expect(
    (await get(t, admin)).settings.find(
      (s) => s.key === 'actions.max_concurrent_jobs'
    )
  ).toMatchObject({ value: 10, default: 10, overridden: false });
  expect((await put(t, admin, 'actions.max_concurrent_jobs', 0)).status).toBe(
    400
  );
  expect((await put(t, admin, 'actions.max_concurrent_jobs', 2.5)).status).toBe(
    400
  );
  expect((await put(t, admin, 'actions.max_concurrent_jobs', '3')).status).toBe(
    400
  );
  expect((await put(t, admin, 'actions.max_concurrent_jobs', 3)).status).toBe(
    200
  );
  const db = drizzle(t.env.DB, { schema });
  expect(await getSetting(db, t.env, 'actions.max_concurrent_jobs')).toBe(3);
});
```

Add `getSetting` to the imports: `import { getSetting } from '../lib/settings';`

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test worker/src/__tests__/settings.test.ts`
Expected: FAIL — the setting is not found (`toMatchObject` on `undefined`) and TypeScript-wise `'actions.max_concurrent_jobs'` is not a `SettingKey` (vitest still runs; the assertion fails).

- [ ] **Step 3: Add the setting**

In `worker/src/lib/settings.ts`, after the `'actions.retention_days'` entry and before `} as const;`:

```ts
  'actions.max_concurrent_jobs': {
    label: 'Jobs running at once',
    description:
      'The most Actions jobs that run at the same time across the instance, each in its own container. Jobs past the limit wait in a queue, first come first served, and the run page shows how many are ahead.',
    group: 'Actions',
    schema: z.number().int().min(1).max(500),
    default: () => 10,
  } satisfies Definition<number>,
```

- [ ] **Step 4: Give number settings a number input in Site admin**

`SettingRow` in `src/components/AdminSettings.tsx` treats every setting other than retention as text, which would save `"10"` (a string) and fail validation. Make it:

```tsx
const retention = s.key === 'actions.retention_days';
// Other number settings (e.g. actions.max_concurrent_jobs) save numbers, not text.
const numeric = !retention && typeof s.default === 'number';
```

Replace the `current` line with:

```tsx
const current = retention
  ? forever
    ? null
    : Number(text)
  : numeric
    ? Number(text)
    : text.trim();
```

Replace the final text-input branch (`) : ( <input id={`setting-${s.key}`} className="form-control flex-1" … /> )}`) with a numeric branch in front of it:

```tsx
        ) : numeric ? (
          <input
            id={`setting-${s.key}`}
            className="form-control"
            type="number"
            min={1}
            step={1}
            style={{ width: 100 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
          />
        ) : (
          <input
            id={`setting-${s.key}`}
            className="form-control flex-1"
            style={{ minWidth: 200 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
          />
        )}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn test worker/src/__tests__/settings.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/settings.ts src/components/AdminSettings.tsx worker/src/__tests__/settings.test.ts
git commit -m "Actions: max_concurrent_jobs setting (default 10)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 2: The `ActionsQueue` Durable Object and its binding

**Files:**

- Create: `worker/src/actions/queue.ts`
- Modify: `worker/src/index.ts` (exports, next to `export { JobRunner } …`)
- Modify: `wrangler.jsonc.example` (top-level `durable_objects.bindings` and `exports`, and `env.dev.durable_objects.bindings`), `wrangler.jsonc.ci` (`durable_objects.bindings`, `exports`), `wrangler.test.jsonc` (`durable_objects`, `migrations`)
- Modify: `worker/src/lib/setup-checks.ts` (`BINDINGS`, after the `JOB_RUNNER` entry)
- Modify: `worker/src/__tests__/helpers/app.ts` (`fakeActions`)
- Regenerate: `worker/worker-configuration.d.ts` (`yarn cf-typegen`)
- Test: `worker/src/__tests__/actions-queue.test.ts` (new)

**Interfaces:**

- Consumes: `workflowJobs` (`worker/src/db/app.schema.ts`), `schema` (`worker/src/db/schema.ts`), `env.ACTIONS_RUN.get(id).sendEvent({ type, payload })`.
- Produces (all in `worker/src/actions/queue.ts`):
  - `QUEUE_NAME = 'instance'`, `RECLAIM_MARGIN_MS = 15 * 60_000`, `SWEEP_MS = 5 * 60_000`, `SLOT_RECHECK = '5 minutes'`
  - `interface SlotRequest { jobId: string; runId: string; maxMinutes: number; limit: number }`
  - `interface SlotStatus { granted: boolean; ahead: number }`
  - `interface Grant { jobId: string; runId: string }`
  - `interface ActionsQueueApi { acquire(req: SlotRequest): Promise<SlotStatus>; release(jobId: string): Promise<Grant[]>; cancelRun(runId: string): Promise<Grant[]>; positions(jobIds: string[]): Promise<Record<string, number>>; reclaim(now?: number): Promise<{ reclaimed: string[]; grants: Grant[] }> }`
  - `class ActionsQueue extends DurableObject<CloudflareBindings> implements ActionsQueueApi`
  - `slotEventType(jobId: string): string` → `` `slot-${jobId}` ``
  - `queueConfigured(env): boolean`, `actionsQueue(env): ActionsQueueApi`
  - `notifyGranted(env, grants: Grant[]): Promise<void>` (never throws)
  - `releaseSlot(env, jobId): Promise<void>`, `dropRun(env, runId): Promise<void>`, `queuePositions(env, jobIds): Promise<Record<string, number>>` (never throw)
  - Test env: `makeEnv({ actions: true })` gains `ACTIONS_QUEUE` (the real Durable Object under a fresh name per call), `ACTIONS_RUN.get(id).sendEvent`, and `t.actions.events: { id: string; type: string; payload: unknown }[]`.

- [ ] **Step 1: Write the failing unit tests**

Create `worker/src/__tests__/actions-queue.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  RECLAIM_MARGIN_MS,
  type ActionsQueueApi,
  type SlotRequest,
} from '../actions/queue';
import { bootstrapAdmin, call, makeEnv } from './helpers/app';
import { commitPaths } from './helpers/seed';

/** A queue of its own: tests share storage, so each one names a fresh instance. */
const fresh = () =>
  env.ACTIONS_QUEUE.getByName(
    `unit-${crypto.randomUUID()}`
  ) as unknown as ActionsQueueApi;
const ask = (
  jobId: string,
  limit: number,
  extra: Partial<SlotRequest> = {}
): SlotRequest => ({ jobId, runId: 'run-1', maxMinutes: 30, limit, ...extra });

describe('ActionsQueue', () => {
  it('grants at most the limit, even when many jobs ask at once', async () => {
    const q = fresh();
    const all = await Promise.all(
      Array.from({ length: 25 }, (_, i) => q.acquire(ask(`job-${i}`, 3)))
    );
    expect(all.filter((s) => s.granted)).toHaveLength(3);
    expect(
      all
        .filter((s) => !s.granted)
        .map((s) => s.ahead)
        .sort((a, b) => a - b)
    ).toEqual(Array.from({ length: 22 }, (_, i) => i));
  });

  it('grants in arrival order as slots free up', async () => {
    const q = fresh();
    expect(await q.acquire(ask('a', 1))).toEqual({ granted: true, ahead: 0 });
    expect(await q.acquire(ask('b', 1))).toEqual({ granted: false, ahead: 0 });
    expect(await q.acquire(ask('c', 1, { runId: 'run-2' }))).toEqual({
      granted: false,
      ahead: 1,
    });
    expect(await q.positions(['a', 'b', 'c', 'nope'])).toEqual({ b: 0, c: 1 });
    expect(await q.release('a')).toEqual([{ jobId: 'b', runId: 'run-1' }]);
    expect(await q.release('b')).toEqual([{ jobId: 'c', runId: 'run-2' }]);
    expect(await q.release('c')).toEqual([]);
  });

  it('asking again is idempotent, and releasing an unknown job does nothing', async () => {
    const q = fresh();
    await q.acquire(ask('a', 1));
    expect(await q.acquire(ask('a', 1))).toEqual({ granted: true, ahead: 0 });
    expect(await q.acquire(ask('b', 1))).toEqual({ granted: false, ahead: 0 });
    expect(await q.acquire(ask('b', 1))).toEqual({ granted: false, ahead: 0 });
    expect(await q.release('ghost')).toEqual([]);
    expect(await q.positions(['b'])).toEqual({ b: 0 });
  });

  it('releasing a waiting job takes it out of line', async () => {
    const q = fresh();
    await q.acquire(ask('a', 1));
    await q.acquire(ask('b', 1));
    await q.acquire(ask('c', 1));
    expect(await q.release('b')).toEqual([]);
    expect(await q.positions(['c'])).toEqual({ c: 0 });
  });

  it("cancelling a run drops all of its jobs, waiting or running, and grants the next run's", async () => {
    const q = fresh();
    await q.acquire(ask('a1', 2));
    await q.acquire(ask('a2', 2));
    await q.acquire(ask('a3', 2));
    await q.acquire(ask('b1', 2, { runId: 'run-2' }));
    expect(await q.cancelRun('run-1')).toEqual([
      { jobId: 'b1', runId: 'run-2' },
    ]);
    expect(await q.positions(['a3'])).toEqual({});
    expect(await q.acquire(ask('c1', 2, { runId: 'run-3' }))).toEqual({
      granted: true,
      ahead: 0,
    });
  });

  it('a raised limit grants on the next request; a lowered one only stops new grants', async () => {
    const q = fresh();
    await q.acquire(ask('a', 2));
    await q.acquire(ask('b', 2));
    expect(await q.acquire(ask('c', 2))).toEqual({ granted: false, ahead: 0 });
    // The limit came from Site admin when the job asked; a later job brings the new value.
    expect(await q.acquire(ask('d', 3))).toEqual({ granted: false, ahead: 0 });
    expect(await q.acquire(ask('c', 3))).toEqual({ granted: true, ahead: 0 });
    // Lowered to 1: the three running keep going, nothing new starts until fewer than 1 run.
    expect(await q.acquire(ask('e', 1))).toEqual({ granted: false, ahead: 1 });
    expect(await q.release('a')).toEqual([]);
    expect(await q.release('b')).toEqual([]);
    expect(await q.release('c')).toEqual([{ jobId: 'd', runId: 'run-1' }]);
  });

  it('reclaims slots whose job is gone or finished, and slots held past the timeout', async () => {
    // Real job rows: one workflow with three jobs.
    const t = makeEnv({ actions: true });
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', addReadme: true, visibility: 'internal' },
    });
    const repo = [...t.fake.repos.values()][0];
    const repoId = (await t.env.DB.prepare(
      "SELECT id FROM repositories WHERE name = 'app'"
    ).first<{ id: string }>())!.id;
    const runId = crypto.randomUUID();
    const sha = await commitPaths(repo, 'main', { 'a.txt': 'a' }, 'One');
    await t.env.DB.prepare(
      `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title, status, created_at)
       VALUES (?, ?, 1, '.github/workflows/ci.yml', 'CI', 'push', 'refs/heads/main', ?, 'One', 'in_progress', ?)`
    )
      .bind(runId, repoId, sha, Math.floor(Date.now() / 1000))
      .run();
    for (const [id, status] of [
      ['job-a', 'in_progress'],
      ['job-b', 'completed'],
      ['job-c', 'queued'],
    ])
      await t.env.DB.prepare(
        `INSERT INTO workflow_jobs (id, run_id, job_key, name, runs_on, needs, status)
         VALUES (?, ?, ?, ?, 'ubuntu-latest', '[]', ?)`
      )
        .bind(id, runId, id, id, status)
        .run();

    const q = fresh();
    await q.acquire(ask('job-a', 3, { runId, maxMinutes: 30 }));
    await q.acquire(ask('job-b', 3, { runId }));
    await q.acquire(ask('ghost', 3, { runId: 'deleted-run' }));
    await q.acquire(ask('job-c', 3, { runId, maxMinutes: 120 }));
    const t0 = Date.now();

    const first = await q.reclaim(t0);
    expect(first.reclaimed.sort()).toEqual(['ghost', 'job-b']);
    expect(first.grants).toEqual([{ jobId: 'job-c', runId }]);

    // job-a ran 30 minutes plus the margin; job-c (120 minutes) is still within its timeout.
    const later = await q.reclaim(
      t0 + 30 * 60_000 + RECLAIM_MARGIN_MS + 60_000
    );
    expect(later.reclaimed).toEqual(['job-a']);
    expect(await q.acquire(ask('job-c', 3, { runId }))).toEqual({
      granted: true,
      ahead: 0,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test worker/src/__tests__/actions-queue.test.ts`
Expected: FAIL — `Cannot find module '../actions/queue'` (and `env.ACTIONS_QUEUE` is undefined).

- [ ] **Step 3: Write `worker/src/actions/queue.ts`**

```ts
import { DurableObject } from 'cloudflare:workers';
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { workflowJobs } from '../db/app.schema';
import { schema } from '../db/schema';

/**
 * The instance's Actions job queue: at most `actions.max_concurrent_jobs` jobs hold a slot (run a
 * container) at once; the rest wait first-in, first-out. One Durable Object for the whole
 * instance, so the limit holds exactly however many runs ask at the same time.
 */
export const QUEUE_NAME = 'instance';
/** A slot held this long past its job's timeout-minutes is reclaimed (the runner's own hard stop is 10 minutes). */
export const RECLAIM_MARGIN_MS = 15 * 60_000;
/** How often the queue checks its entries against D1 while it isn't empty. */
export const SWEEP_MS = 5 * 60_000;
/** How long a waiting job waits for its grant event before asking the queue again. */
export const SLOT_RECHECK = '5 minutes';
/** Job ids per D1 lookup (bound-parameter limit). */
const CHUNK = 50;

export interface SlotRequest {
  jobId: string;
  runId: string;
  /** The job's timeout-minutes: a slot held much longer than this is reclaimed. */
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
};

export class ActionsQueue
  extends DurableObject<CloudflareBindings>
  implements ActionsQueueApi
{
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // seq is the arrival order; granted_at is null while the job waits.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      max_ms INTEGER NOT NULL,
      granted_at INTEGER
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
        'INSERT INTO entries (job_id, run_id, max_ms) VALUES (?, ?, ?)',
        req.jobId,
        req.runId,
        Math.round(req.maxMinutes * 60_000)
      );
    // A raised limit can start others too; they hear about it by event.
    const others = this.pump().filter((g) => g.jobId !== req.jobId);
    const status = this.statusOf(req.jobId)!;
    await this.keepSweeping();
    await notifyGranted(this.env, others);
    return status;
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
   * already finished, and slots held past the job's timeout plus RECLAIM_MARGIN_MS.
   */
  async reclaim(
    now = Date.now()
  ): Promise<{ reclaimed: string[]; grants: Grant[] }> {
    const entries = this.sql
      .exec<Entry>(
        'SELECT seq, job_id, run_id, max_ms, granted_at FROM entries ORDER BY seq'
      )
      .toArray();
    const reclaimed = new Set<string>();
    for (const e of entries)
      if (
        e.granted_at !== null &&
        now > e.granted_at + e.max_ms + RECLAIM_MARGIN_MS
      )
        reclaimed.add(e.job_id);
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
```

- [ ] **Step 4: Export the class**

In `worker/src/index.ts`, after `export { JobRunner } from './actions/job-runner';`:

```ts
export { ActionsQueue } from './actions/queue';
```

- [ ] **Step 5: Add the binding everywhere CLAUDE.md requires**

`wrangler.jsonc.example`, top level — `durable_objects.bindings` becomes:

```jsonc
  "durable_objects": {
    "bindings": [
      { "name": "JOB_RUNNER", "class_name": "JobRunner" },
      { "name": "ACTIONS_QUEUE", "class_name": "ActionsQueue" },
      { "name": "MERGE_RESOLVER", "class_name": "MergeResolver" },
      { "name": "LIVE", "class_name": "LiveHub" }
    ]
  },
  "exports": {
    "JobRunner": { "type": "durable-object", "storage": "sqlite" },
    "ActionsQueue": { "type": "durable-object", "storage": "sqlite" },
    "MergeResolver": { "type": "durable-object", "storage": "sqlite" },
    "LiveHub": { "type": "durable-object", "storage": "sqlite" }
  },
```

and in the comment above `"containers"`, replace `Step logs go to R2. Remove these four entries to deploy without Actions.` with `Step logs go to R2. The ActionsQueue Durable Object caps how many jobs run at once (Site admin → Settings). Remove these entries to deploy without Actions.`

`wrangler.jsonc.example`, `env.dev.durable_objects.bindings` becomes:

```jsonc
      "durable_objects": {
        "bindings": [
          { "name": "JOB_RUNNER", "class_name": "JobRunner" },
          { "name": "ACTIONS_QUEUE", "class_name": "ActionsQueue" },
          { "name": "MERGE_RESOLVER", "class_name": "MergeResolver" },
          { "name": "LIVE", "class_name": "LiveHub" }
        ]
      },
```

`wrangler.jsonc.ci` — the same top-level `durable_objects` and `exports` blocks as the example above.

`wrangler.test.jsonc` — replace the `durable_objects` and `migrations` entries and the comment under them with:

```jsonc
  // Live updates: the real hub, so tests can open a WebSocket and hear pings. The Actions job
  // queue: the real Durable Object (makeEnv gives each test a fresh instance name).
  "durable_objects": {
    "bindings": [
      { "name": "LIVE", "class_name": "LiveHub" },
      { "name": "ACTIONS_QUEUE", "class_name": "ActionsQueue" },
    ],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["LiveHub"] },
    { "tag": "v2", "new_sqlite_classes": ["ActionsQueue"] },
  ],
```

Then regenerate the types:

Run: `yarn cf-typegen`
Expected: `worker/worker-configuration.d.ts` now contains `ACTIONS_QUEUE: DurableObjectNamespace<import("./src/index").ActionsQueue>;`

- [ ] **Step 6: Add the setup check**

In `worker/src/lib/setup-checks.ts`, in `BINDINGS`, right after the `JOB_RUNNER` entry:

```ts
  {
    name: 'ACTIONS_QUEUE',
    required: false,
    without:
      'Actions jobs start as soon as they are ready, with no limit on how many run at once (Site admin → Settings → Jobs running at once is ignored).',
    snippet: `"durable_objects": { "bindings": [{ "name": "ACTIONS_QUEUE", "class_name": "ActionsQueue" }, …] },
"exports": { "ActionsQueue": { "type": "durable-object", "storage": "sqlite" }, … }`,
  },
```

- [ ] **Step 7: Give tests a queue of their own and record Workflow events**

In `worker/src/__tests__/helpers/app.ts`, inside `fakeActions()`:

Add next to the other recorders:

```ts
const events: { id: string; type: string; payload: unknown }[] = [];
```

In `ACTIONS_RUN.get`, add `sendEvent` to the returned object:

```ts
    get: async (id: string) => ({
      id,
      status: async () => ({ status: instanceStatus.get(id) ?? 'running' }),
      terminate: async () => void terminated.push(id),
      sendEvent: async (e: { type: string; payload?: unknown }) =>
        void events.push({ id, type: e.type, payload: e.payload ?? null }),
    }),
```

After `JOB_RUNNER`, add:

```ts
// The real ActionsQueue Durable Object, under a name of its own per makeEnv() so tests never
// share slots (test files share storage).
const queueName = `test-${crypto.randomUUID()}`;
const ACTIONS_QUEUE = {
  getByName: () => env.ACTIONS_QUEUE.getByName(queueName),
};
```

and change the return to:

```ts
return {
  bindings: { ACTIONS_RUN, JOB_RUNNER, MERGE_RESOLUTION, ACTIONS_QUEUE },
  started,
  terminated,
  destroyed,
  resolutions,
  terminatedResolutions,
  instanceStatus,
  live,
  events,
};
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `yarn test worker/src/__tests__/actions-queue.test.ts worker/src/__tests__/admin-setup.test.ts`
Expected: PASS (admin-setup's "everything OK" test now also sees `binding-ACTIONS_QUEUE` present through `makeEnv({ actions: true })`).

- [ ] **Step 9: Commit**

```bash
git add worker/src/actions/queue.ts worker/src/index.ts wrangler.jsonc.example wrangler.jsonc.ci wrangler.test.jsonc worker/worker-configuration.d.ts worker/src/lib/setup-checks.ts worker/src/__tests__/helpers/app.ts worker/src/__tests__/actions-queue.test.ts
git commit -m "Actions: ActionsQueue Durable Object (FIFO slots, exact cap, reclaim)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 3: Jobs wait for a slot before their container starts

**Files:**

- Modify: `worker/src/actions/executor.ts` (`StepRunner`, `runJob`'s attempt loop and its restart and complete steps; new `waitForSlot`)
- Modify: `worker/src/live/publish.ts` (`pingingSteps`)
- Create: `worker/src/__tests__/helpers/actions.ts`
- Modify: `worker/src/__tests__/actions.test.ts` (header only)
- Test: `worker/src/__tests__/actions-queue.test.ts`

**Interfaces:**

- Consumes: `actionsQueue`, `queueConfigured`, `releaseSlot`, `slotEventType`, `SLOT_RECHECK` (Task 2); `getSetting(db, env, 'actions.max_concurrent_jobs')` (Task 1).
- Produces:
  - `StepRunner.waitForEvent<T = unknown>(name: string, options: { type: string; timeout?: string }): Promise<{ payload: T }>` (executor's own `StepRunner`, not `merge/resolution`'s).
  - Durable step names per job attempt `prefix` (`job:<id>` or `job:<id>:attempt:<n>`): `${prefix}:queue`, then `${prefix}:queue:wait:<i>` (waitForEvent) and `${prefix}:queue:<i>` for each recheck.
  - `worker/src/__tests__/helpers/actions.ts` exports: `CI`, `type Run`, `type Job` (with `queuedAhead: number | null`), `pat`, `push`, `setup`, `pushFiles`, `runs`, `runDetail`, `harness`, `script`, `type Setup`. `harness(t, onStep?, opts?: { loseEvents?: boolean })` returns `{ run, requests, destroyed, boots, stepNames, peak }` where `peak(): number` is the most containers alive at once.

- [ ] **Step 1: Move the Actions test helpers into `helpers/actions.ts`**

Create `worker/src/__tests__/helpers/actions.ts` (the code is what `actions.test.ts` has above `describe('Actions triggers'`, plus `queuedAhead`, `waitForEvent`, and `peak`):

```ts
import { expect } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { handleGitRequest } from '../../git-http';
import { concat } from '../../git/bytes';
import { FLUSH, pktLine } from '../../git/pktline';
import { buildPack } from '../../git/pack';
import { schema } from '../../db/schema';
import { executeRun, type StepRunner } from '../../actions/executor';
import type {
  JobRunnerApi,
  StepRequest,
  StepResult,
} from '../../actions/job-runner';
import { bootstrapAdmin, call, makeEnv, settle, type TestEnv } from './app';
import { commitPaths } from './seed';

export const CI = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: build
        run: echo building
      - run: npm test
`;

export type Run = {
  id: string;
  runNumber: number;
  name: string;
  event: string;
  ref: string;
  refName: string;
  pullRequestNumber: number | null;
  headSha: string;
  displayTitle: string;
  actor: { username: string } | null;
  status: string;
  conclusion: string | null;
  errorMessage: string | null;
};
export type Job = {
  id: string;
  name: string;
  status: string;
  conclusion: string | null;
  /** Jobs ahead of this one in the instance's queue; null when it isn't waiting for a slot. */
  queuedAhead: number | null;
  steps: {
    number: number;
    name: string;
    status: string;
    conclusion: string | null;
  }[];
};

export async function pat(t: TestEnv, cookie: string) {
  const res = await call(t, '/api/tokens', {
    cookie,
    json: { name: 'cli', expiresInDays: 30 },
  });
  return ((await res.json()) as { plaintext: string }).plaintext;
}

/** A `git push` through the proxy: objects go into the fake repo, receive-pack moves the ref. */
export async function push(
  t: TestEnv,
  token: string,
  path: string,
  ref: string,
  oldSha: string,
  newSha: string
) {
  const body = concat([
    pktLine(`${oldSha} ${newSha} ${ref}\0report-status\n`),
    FLUSH,
    await buildPack([]),
  ]);
  const res = await handleGitRequest(
    new Request(`http://test.local${path}/git-receive-pack`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`u:${token}`)}`,
        'Content-Type': 'application/x-git-receive-pack-request',
      },
      body,
    }),
    t.env,
    t.ctx
  );
  expect(res.status).toBe(200);
  await settle(t);
}

export async function setup() {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', addReadme: true, visibility: 'internal' },
  });
  const repo = [...t.fake.repos.values()][0];
  const token = await pat(t, admin);
  return { t, admin, repo, token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

/** Commits `files` on `branch` and pushes it through the proxy. Returns the new sha. */
export async function pushFiles(
  s: Setup,
  branch: string,
  files: Record<string, string>,
  message = 'Add CI'
) {
  const old = s.repo.refs.get(`refs/heads/${branch}`) ?? '0'.repeat(40);
  // Build on the branch's tip without moving it; the push moves it.
  const sha = await commitPaths(s.repo, branch, files, message, {
    moveRef: false,
  });
  await push(
    s.t,
    s.token,
    '/octocat/app.git',
    `refs/heads/${branch}`,
    old,
    sha
  );
  return sha;
}

export async function runs(t: TestEnv, cookie: string) {
  const res = await call(t, '/api/repos/octocat/app/actions/runs', { cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    configured: boolean;
    totalCount: number;
    workflows: { path: string; name: string }[];
    runs: Run[];
  };
}

export async function runDetail(t: TestEnv, cookie: string, n: number) {
  const res = await call(t, `/api/repos/octocat/app/actions/runs/${n}`, {
    cookie,
  });
  return (await res.json()) as { run: Run; jobs: Job[] };
}

/**
 * Drives executeRun with a direct-call step and a scripted container. `waitForEvent` polls the
 * events the fake ACTIONS_RUN received (briefly, then times out like a real wait); with
 * `loseEvents` it never sees one, so only rechecks start waiting jobs.
 */
export function harness(
  t: TestEnv,
  onStep: (
    req: StepRequest
  ) => Partial<StepResult> | Promise<Partial<StepResult>> = () => ({}),
  opts: { loseEvents?: boolean } = {}
) {
  const requests: StepRequest[] = [];
  const destroyed: string[] = [];
  const boots: string[] = [];
  const stepNames: string[] = [];
  const alive = new Set<string>();
  let peak = 0;
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      stepNames.push(name);
      return ((b ?? a) as () => Promise<unknown>)();
    },
    waitForEvent: async (name: string, o: { type: string }) => {
      stepNames.push(name);
      for (let i = 0; i < 100; i++) {
        const k = opts.loseEvents
          ? -1
          : t.actions.events.findIndex((e) => e.type === o.type);
        if (k >= 0)
          return { payload: t.actions.events.splice(k, 1)[0].payload };
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`${name}: timed out`);
    },
  } as unknown as StepRunner;
  const runner = (jobId: string): JobRunnerApi => ({
    boot: async () => {
      boots.push(jobId);
      alive.add(jobId);
      peak = Math.max(peak, alive.size);
      return { ms: 420 };
    },
    runStep: async (req) => {
      requests.push(req);
      const scripted = await onStep(req);
      return {
        exitCode: 0,
        timedOut: false,
        log: `ran ${req.argv[req.argv.length - 1].split('\n')[0]}`,
        outputs: {},
        envAdds: {},
        pathAdds: [],
        ...scripted,
      };
    },
    destroy: async () => {
      destroyed.push(jobId);
      alive.delete(jobId);
    },
  });
  const run = (runId: string) =>
    executeRun(
      {
        env: t.env,
        db: drizzle(t.env.DB, { schema }),
        step,
        runner,
        restartDelayMs: 0,
      },
      runId
    );
  return { run, requests, destroyed, boots, stepNames, peak: () => peak };
}

export const script = (r: StepRequest) => r.argv[r.argv.length - 1];
```

In `worker/src/__tests__/actions.test.ts`, delete everything above the line `describe('Actions triggers', () => {` and put this header in its place:

```ts
import { describe, expect, it } from 'vitest';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
  type TestEnv,
} from './helpers/app';
import { commitPaths } from './helpers/seed';
import {
  CI,
  harness,
  pat,
  push,
  pushFiles,
  runDetail,
  runs,
  script,
  setup,
} from './helpers/actions';
```

- [ ] **Step 2: Run the moved tests to verify nothing changed**

Run: `yarn test worker/src/__tests__/actions.test.ts`
Expected: PASS (all existing Actions tests; the queue isn't wired in yet).

- [ ] **Step 3: Write the failing executor tests**

Append to `worker/src/__tests__/actions-queue.test.ts`, and add these imports at the top of the file:

```ts
import { actionsQueue } from '../actions/queue';
import { settle } from './helpers/app';
import {
  CI,
  harness,
  pushFiles,
  runDetail,
  runs,
  setup,
  type Setup,
} from './helpers/actions';
```

(Merge `settle` into the existing `./helpers/app` import line.)

```ts
const MATRIX = `on: push
jobs:
  work:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2, 3, 4, 5]
    steps:
      - run: work-\${{ matrix.n }}
`;

const setLimit = async (s: Setup, n: number) =>
  expect(
    (
      await call(s.t, '/api/admin/settings/actions.max_concurrent_jobs', {
        cookie: s.admin,
        method: 'PUT',
        json: { value: n },
      })
    ).status
  ).toBe(200);

/** A slot is free right now (every job gave its slot back). */
const queueIsEmpty = async (s: Setup) =>
  expect(
    await actionsQueue(s.t.env).acquire({
      jobId: `probe-${crypto.randomUUID()}`,
      runId: 'probe',
      maxMinutes: 1,
      limit: 1,
    })
  ).toEqual({ granted: true, ahead: 0 });

const slow = async () => {
  await new Promise((r) => setTimeout(r, 20));
  return {};
};

describe('Actions jobs wait for a slot', () => {
  it('never runs more jobs at once than the limit; waiting jobs start as slots free up', async () => {
    const s = await setup();
    await setLimit(s, 2);
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': MATRIX });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const h = harness(s.t, slow);
    expect(await h.run(queued.id)).toBe('success');
    expect(h.boots).toHaveLength(5);
    expect(h.peak()).toBe(2);
    expect(
      h.stepNames.filter((n) => n.includes(':queue:wait:')).length
    ).toBeGreaterThanOrEqual(3);
    const { jobs } = await runDetail(s.t, s.admin, 1);
    expect(jobs.every((j) => j.conclusion === 'success')).toBe(true);
    await queueIsEmpty(s);
  });

  it('starts waiting jobs even when every grant event is lost', async () => {
    const s = await setup();
    await setLimit(s, 1);
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': MATRIX });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const h = harness(s.t, slow, { loseEvents: true });
    expect(await h.run(queued.id)).toBe('success');
    expect(h.boots).toHaveLength(5);
    expect(h.peak()).toBe(1);
  });

  it('gives the slot back when a job fails', async () => {
    const s = await setup();
    await setLimit(s, 1);
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const h = harness(s.t, () => ({ exitCode: 1 }));
    expect(await h.run(queued.id)).toBe('failure');
    await queueIsEmpty(s);
  });

  it('gives the slot back when the runner is interrupted, and queues again for the restart', async () => {
    const s = await setup();
    await setLimit(s, 1);
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [queued] = (await runs(s.t, s.admin)).runs;
    let interrupted = false;
    const h = harness(s.t, (r) => {
      if (r.argv[r.argv.length - 1] === 'npm test' && !interrupted) {
        interrupted = true;
        throw new Error('Durable Object reset because its code was updated.');
      }
      return {};
    });
    expect(await h.run(queued.id)).toBe('success');
    const { jobs } = await runDetail(s.t, s.admin, 1);
    expect(h.stepNames).toContain(`job:${jobs[0].id}:queue`);
    expect(h.stepNames).toContain(`job:${jobs[0].id}:attempt:2:queue`);
    await queueIsEmpty(s);
  });

  it('runs jobs without a limit when the queue binding is missing', async () => {
    const s = await setup();
    await setLimit(s, 1);
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': MATRIX });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const t = {
      ...s.t,
      env: { ...s.t.env, ACTIONS_QUEUE: undefined },
    } as unknown as typeof s.t;
    const h = harness(t, slow);
    expect(await h.run(queued.id)).toBe('success');
    expect(h.peak()).toBe(5);
    expect(h.stepNames.some((n) => n.endsWith(':queue'))).toBe(false);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `yarn test worker/src/__tests__/actions-queue.test.ts`
Expected: FAIL — "never runs more jobs at once than the limit" sees `peak` 5, the interruption test finds no `:queue` step names, `queueIsEmpty` passes trivially only in some.

- [ ] **Step 5: Teach `pingingSteps` to pass `waitForEvent` through**

In `worker/src/live/publish.ts`, replace the `Steps` interface and `pingingSteps`:

```ts
/** The parts of a Workflow step runner the executors use. */
interface Steps {
  do<T>(name: string, ...args: unknown[]): Promise<T>;
  waitForEvent?(name: string, options: unknown): Promise<unknown>;
}

/** Wraps a Workflow step runner so each completed step pings the repository. */
export function pingingSteps<S>(
  env: CloudflareBindings,
  step: S,
  repositoryId: string,
  opts: { approvals?: boolean } = {}
): S {
  const inner = step as unknown as Steps;
  const wrapped: Steps = {
    async do<T>(name: string, ...args: unknown[]): Promise<T> {
      const result = await inner.do<T>(name, ...args);
      await publishChange(env, repositoryId, opts);
      return result;
    },
  };
  // Waiting changes nothing on screen; the step after it pings.
  if (inner.waitForEvent)
    wrapped.waitForEvent = (name, options) =>
      inner.waitForEvent!(name, options);
  return wrapped as unknown as S;
}
```

- [ ] **Step 6: Wire the queue into the executor**

In `worker/src/actions/executor.ts`:

Add imports:

```ts
import { getSetting } from '../lib/settings';
import {
  actionsQueue,
  queueConfigured,
  releaseSlot,
  SLOT_RECHECK,
  slotEventType,
} from './queue';
```

Extend `StepRunner`:

```ts
/** Subset of WorkflowStep used here; results must be JSON-serializable. */
export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    fn: () => Promise<T>
  ): Promise<T>;
  /** Waits for `instance.sendEvent({ type })`; throws when `timeout` passes first. */
  waitForEvent<T = unknown>(
    name: string,
    options: { type: string; timeout?: string }
  ): Promise<{ payload: T }>;
}
```

Add `waitForSlot` right after `skipJob`:

```ts
/**
 * Waits durably for one of the instance's job slots (ActionsQueue) before a container starts.
 * The grant arrives as a Workflow event; a lost or early event costs at most SLOT_RECHECK, after
 * which the queue is asked again. Returns false when the run was cancelled while waiting.
 */
async function waitForSlot(
  deps: ExecutorDeps,
  ctx: RunContext,
  def: JobDef,
  job: RunContext['jobs'][number],
  prefix: string
): Promise<boolean> {
  const { env, db, step } = deps;
  if (!queueConfigured(env)) return true;
  const ask = async () => {
    const run = await db
      .select({ status: workflowRuns.status })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, ctx.runId))
      .get();
    if (!run || run.status === 'completed')
      return { cancelled: true, granted: false, ahead: 0 };
    const limit = await getSetting(db, env, 'actions.max_concurrent_jobs');
    const s = await actionsQueue(env).acquire({
      jobId: job.id,
      runId: ctx.runId,
      maxMinutes: def.timeoutMinutes,
      limit,
    });
    return { cancelled: false, granted: s.granted, ahead: s.ahead };
  };
  const config: WorkflowStepConfig = {
    retries: { limit: 3, delay: '5 seconds' },
    timeout: '1 minute',
  };
  let state = await step.do(`${prefix}:queue`, config, ask);
  for (let i = 1; !state.cancelled && !state.granted; i++) {
    try {
      await step.waitForEvent(`${prefix}:queue:wait:${i}`, {
        type: slotEventType(job.id),
        timeout: SLOT_RECHECK,
      });
    } catch {
      // Timed out: ask again (this also picks up a grant whose event was lost).
    }
    state = await step.do(`${prefix}:queue:${i}`, config, ask);
  }
  return !state.cancelled;
}
```

In `runJob`'s attempt loop, wait before each attempt:

```ts
  for (;;) {
    const prefix = attempt === 1 ? name : `${name}:attempt:${attempt}`;
    if (!(await waitForSlot(deps, ctx, def, job, prefix)))
      return { key: def.key, result: 'cancelled', outputs: {} };
    attemptState = await runAttempt(
```

In the `${prefix}:restart` step, give the slot back first (the restart queues again):

```ts
      async () => {
        // The restart queues again; meanwhile someone else may use the slot.
        await releaseSlot(env, job.id);
        const run = await db
```

In the `${name}:complete` step, after `await runnersStopped(db, [job.id]);`:

```ts
await releaseSlot(env, job.id);
```

`worker/src/actions/run-workflow.ts` needs no change: it already passes the real `WorkflowStep` (which has `waitForEvent`) cast to `StepRunner`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `yarn test worker/src/__tests__/actions-queue.test.ts worker/src/__tests__/actions.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add worker/src/actions/executor.ts worker/src/live/publish.ts worker/src/__tests__/helpers/actions.ts worker/src/__tests__/actions.test.ts worker/src/__tests__/actions-queue.test.ts
git commit -m "Actions: jobs wait durably for a queue slot before their container starts

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 4: Cancel drops queued jobs; the run page shows "Queued (N ahead)"

**Files:**

- Modify: `worker/src/routers/actions-router.ts` (`jobSchema`, `reconcile`, `getRunRoute` handler, `cancelRoute` handler)
- Modify: `src/lib/uiApi.ts` (`WorkflowJob`)
- Modify: `src/pages/RunView.tsx` (`JobLog` header, job cards)
- Test: `worker/src/__tests__/actions-queue.test.ts`

**Interfaces:**

- Consumes: `dropRun`, `queuePositions`, `actionsQueue` (Task 2).
- Produces: `GET /api/repos/{owner}/{repo}/actions/runs/{number}` jobs carry `queuedAhead: number | null`; `WorkflowJob.queuedAhead` in `src/lib/uiApi.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `worker/src/__tests__/actions-queue.test.ts`:

```ts
describe('Queued jobs on the run page and when cancelling', () => {
  it('shows how many jobs are ahead, and cancelling takes the run out of the queue', async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [run] = (await runs(s.t, s.admin)).runs;
    const { jobs } = await runDetail(s.t, s.admin, 1);
    const q = actionsQueue(s.t.env);
    await q.acquire({
      jobId: 'busy',
      runId: 'other',
      maxMinutes: 30,
      limit: 1,
    });
    await q.acquire({
      jobId: 'next',
      runId: 'other',
      maxMinutes: 30,
      limit: 1,
    });
    await q.acquire({
      jobId: jobs[0].id,
      runId: run.id,
      maxMinutes: 30,
      limit: 1,
    });
    expect((await runDetail(s.t, s.admin, 1)).jobs[0].queuedAhead).toBe(1);

    const res = await call(
      s.t,
      '/api/repos/octocat/app/actions/runs/1/cancel',
      { cookie: s.admin, method: 'POST' }
    );
    expect(res.status).toBe(200);
    await settle(s.t);
    expect(await q.positions([jobs[0].id])).toEqual({});
    expect((await runDetail(s.t, s.admin, 1)).jobs[0].queuedAhead).toBeNull();
    expect(await q.release('busy')).toEqual([
      { jobId: 'next', runId: 'other' },
    ]);
  });

  it('never starts a waiting job whose run was cancelled', async () => {
    const s = await setup();
    await setLimit(s, 1);
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const q = actionsQueue(s.t.env);
    await q.acquire({
      jobId: 'busy',
      runId: 'other',
      maxMinutes: 30,
      limit: 1,
    });
    const h = harness(s.t);
    const done = h.run(queued.id);
    while (!h.stepNames.some((n) => n.includes(':queue:wait:')))
      await new Promise((r) => setTimeout(r, 5));
    const res = await call(
      s.t,
      '/api/repos/octocat/app/actions/runs/1/cancel',
      { cookie: s.admin, method: 'POST' }
    );
    expect(res.status).toBe(200);
    await settle(s.t);
    expect(await q.release('busy')).toEqual([]);
    expect(await done).toBe('cancelled');
    expect(h.boots).toHaveLength(0);
  });

  it('drops the jobs of a run whose Workflow crashed when the run is viewed', async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [run] = (await runs(s.t, s.admin)).runs;
    const { jobs } = await runDetail(s.t, s.admin, 1);
    const q = actionsQueue(s.t.env);
    await q.acquire({
      jobId: 'busy',
      runId: 'other',
      maxMinutes: 30,
      limit: 1,
    });
    await q.acquire({
      jobId: jobs[0].id,
      runId: run.id,
      maxMinutes: 30,
      limit: 1,
    });
    // reconcile() only looks at runs older than a minute.
    await s.t.env.DB.prepare(
      'UPDATE workflow_runs SET created_at = created_at - 600'
    ).run();
    s.t.actions.instanceStatus.set(run.id, 'errored');
    const detail = await runDetail(s.t, s.admin, 1);
    expect(detail.run.conclusion).toBe('failure');
    expect(await q.positions([jobs[0].id])).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test worker/src/__tests__/actions-queue.test.ts`
Expected: FAIL — `queuedAhead` is `undefined`; positions still list the cancelled job; the cancelled run's waiting job is granted when `busy` is released.

- [ ] **Step 3: Drop runs from the queue on cancel and on reconcile; report positions**

In `worker/src/routers/actions-router.ts`, add the import:

```ts
import { dropRun, queuePositions } from '../actions/queue';
```

In `jobSchema`, after `needs: z.array(z.string()),`:

```ts
    /** Jobs ahead of this one in the instance's queue; null when it isn't waiting for a slot. */
    queuedAhead: z.number().nullable(),
```

In `reconcile`, after `await finishAbandoned(…);`:

```ts
await dropRun(env, run.id);
```

In the `getRunRoute` handler, after `const people = …;`:

```ts
const waiting =
  run.status === 'completed'
    ? []
    : jobs.filter((j) => j.status === 'queued').map((j) => j.id);
const ahead = await queuePositions(c.env, waiting);
```

and in the job mapping, after `needs: j.needs,`:

```ts
        queuedAhead: ahead[j.id] ?? null,
```

In the `cancelRoute` handler, replace the `waitUntil` block with:

```ts
if (actionsConfigured(c.env))
  c.executionCtx.waitUntil(
    Promise.allSettled(
      jobIds.map((id) => c.env.JOB_RUNNER.getByName(id).destroy())
    )
      .then(() => runnersStopped(db, jobIds))
      .then(() => dropRun(c.env, run.id))
  );
```

- [ ] **Step 4: Show it on the run page**

`src/lib/uiApi.ts`, in `WorkflowJob` after `needs: string[];`:

```ts
/** Jobs ahead of this one in the instance's queue; null when it isn't waiting for a slot. */
queuedAhead: number | null;
```

`src/pages/RunView.tsx`, `JobLog` header: replace

```tsx
                : 'Waiting for a runner'}
```

with

```tsx
                : job.queuedAhead !== null
                  ? `Queued (${job.queuedAhead} ahead)`
                  : 'Waiting for a runner'}
```

and in the job cards of the run summary, replace

```tsx
<span className="f6 color-fg-muted">
  {j.startedAt && j.conclusion !== 'skipped'
    ? duration(j.startedAt, j.completedAt, now)
    : ''}
</span>
```

with

```tsx
<span className="f6 color-fg-muted">
  {j.queuedAhead !== null
    ? `Queued (${j.queuedAhead} ahead)`
    : j.startedAt && j.conclusion !== 'skipped'
      ? duration(j.startedAt, j.completedAt, now)
      : ''}
</span>
```

The page already polls every 2 seconds while the run is unfinished and refetches on live pings (each queue check is a pinging step), so the count moves on its own.

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test worker/src/__tests__/actions-queue.test.ts worker/src/__tests__/actions.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/routers/actions-router.ts src/lib/uiApi.ts src/pages/RunView.tsx worker/src/__tests__/actions-queue.test.ts
git commit -m "Actions: cancel drops queued jobs; run page shows Queued (N ahead)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 5: Docs and the definition of done

**Files:**

- Modify: `docs/configuration.md`, `docs/architecture.md`, `README.md`, `CLAUDE.md`, `.claude/skills/gitorange-onboarding/SKILL.md`

- [ ] **Step 1: `docs/configuration.md`**

In the Bindings table, after the `JOB_RUNNER` row, add:

```markdown
| `durable_objects.bindings[].name` | `"ACTIONS_QUEUE"` | One `ActionsQueue` Durable Object: the instance's queue of Actions jobs. At most **Site admin → Settings → Jobs running at once** (default 10) job containers run at a time; the rest wait, first come first served. Without it jobs start as soon as they're ready, with no limit |
```

In the paragraph under the table, replace `remove the \`JobRunner\` container, its Durable Object binding and export,`with`remove the \`JobRunner\` container, its Durable Object binding and export, the \`ActionsQueue\` Durable Object binding and export,`.

- [ ] **Step 2: `docs/architecture.md`**

In "## Actions", item 3 ("**Run.**"), append:

```markdown
Before its container starts, each job asks the `ActionsQueue` Durable Object ([`queue.ts`](../worker/src/actions/queue.ts)) for a slot: at most `actions.max_concurrent_jobs` (Site admin → Settings, default 10) jobs run at once across the instance, granted first come, first served. A waiting job holds no container: its Workflow waits for a grant event and asks again every 5 minutes in case one was lost, and the run page shows "Queued (N ahead)". A job gives its slot back when it finishes or its runner is interrupted (the restart queues again); cancelling a run drops its jobs from the queue; and an alarm reclaims slots whose job is gone or finished, or that were held 15 minutes past the job's `timeout-minutes`.
```

- [ ] **Step 3: `README.md`** ("GitHub Actions compatibility" table)

In the last row, replace `Step and job outputs, \`GITHUB_ENV\`, \`GITHUB_OUTPUT\`, \`GITHUB_PATH\``with`Step and job outputs, \`GITHUB_ENV\`, \`GITHUB_OUTPUT\`, \`GITHUB_PATH\`; an instance-wide limit on jobs running at once (Site admin → Settings), with a queue`, and replace `Concurrency limits, caching, and artifacts` with `` `concurrency:`groups,`max-parallel`, and artifacts ``.

- [ ] **Step 4: `CLAUDE.md`** (Actions bullet)

Replace `` `makeEnv({ actions: true })` adds fake `ACTIONS_RUN`/`JOB_RUNNER` bindings. `` with:

```markdown
`makeEnv({ actions: true })` adds fake `ACTIONS_RUN`/`JOB_RUNNER` bindings and a fresh real `ACTIONS_QUEUE`. A job waits
for a slot from the one `ActionsQueue` DO (`actions/queue.ts`, setting `actions.max_concurrent_jobs`) before its container
starts (`step.waitForEvent` with a 5-minute recheck); it gives the slot back on complete, restart, and cancel.
```

- [ ] **Step 5: `.claude/skills/gitorange-onboarding/SKILL.md`**

In the "Do not rename bindings" list, replace `` `ACTIONS_RUN`, `JOB_RUNNER`, `` with `` `ACTIONS_RUN`, `JOB_RUNNER`, `ACTIONS_QUEUE`, ``.

- [ ] **Step 6: Definition of done**

Run: `yarn test`
Expected: all test files PASS.

Run: `yarn typecheck`
Expected: no errors.

Run: `yarn format`
Expected: files formatted (tables realigned).

- [ ] **Step 7: Commit**

```bash
git add -A docs README.md CLAUDE.md .claude/skills/gitorange-onboarding/SKILL.md
git add -u
git commit -m "Docs: Actions job queue and Jobs running at once

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

Deployers must add the `ACTIONS_QUEUE` binding and the `ActionsQueue` export to their own `wrangler.jsonc` before deploying (Site admin → Setup warns until they do); say so in the pull request description.
