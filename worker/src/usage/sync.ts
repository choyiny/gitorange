/**
 * Pulls Cloudflare's per-day usage for this deployment's resources into usage_daily. Runs from
 * the daily cron (worker/src/cron.ts) and from the Site admin "Sync now" button. Idempotent: a
 * day synced again replaces its numbers, so recent days are re-read while analytics settle.
 */
import { desc, gte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { usageDaily, usageSyncs } from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import { buildProbes, runProbe, usageResources } from './probes';
import { productOf } from './pricing';

/** Cloudflare keeps most datasets for 31 days; older days can't be filled in. */
export const RETENTION_DAYS = 30;
/** Days re-read on every run: analytics arrive late and settle over a few days. */
const RECENT_DAYS = 3;
/** Older missing days filled per run, keeping one run well under 300 queries per 5 minutes. */
const BACKFILL_DAYS_PER_RUN = 4;
const CONCURRENCY = 4;

export const dayOf = (d: Date) => d.toISOString().slice(0, 10);
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return dayOf(d);
}

export function analyticsConfigured(env: CloudflareBindings): boolean {
  return Boolean(
    (env.CF_ANALYTICS_TOKEN as string | undefined)?.trim() &&
    usageResources(env).accountId
  );
}

/**
 * Days to sync: the last few complete days, plus the oldest days of the retention window that
 * have never been synced (a few per run, so the first month fills in over a week of cron runs).
 */
export async function daysToSync(db: DrizzleDB, now: Date): Promise<string[]> {
  const today = dayOf(now);
  const recent = Array.from({ length: RECENT_DAYS }, (_, i) =>
    addDays(today, -(i + 1))
  );
  const oldest = addDays(today, -RETENTION_DAYS);
  const synced = new Set(
    (
      await db
        .select({ id: usageSyncs.id })
        .from(usageSyncs)
        .where(gte(usageSyncs.id, oldest))
        .all()
    ).map((r) => r.id)
  );
  const missing: string[] = [];
  for (let d = oldest; d < recent[recent.length - 1]; d = addDays(d, 1))
    if (!synced.has(d)) missing.push(d);
  return [...recent, ...missing.slice(0, BACKFILL_DAYS_PER_RUN)];
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift())
        await fn(item);
    })
  );
}

export interface SyncResult {
  configured: boolean;
  days: string[];
  /** Day → probe id → error, for days where something failed. */
  errors: Record<string, Record<string, string>>;
}

/** Syncs the given UTC days. Each probe and day stands alone: a failure is recorded, not thrown. */
export async function syncUsage(
  env: CloudflareBindings,
  days: string[],
  opts: { fetch?: typeof fetch; db?: DrizzleDB; now?: () => Date } = {}
): Promise<SyncResult> {
  if (!analyticsConfigured(env)) return { configured: false, days, errors: {} };
  const db = opts.db ?? drizzle(env.DB, { schema });
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const token = (env.CF_ANALYTICS_TOKEN as string).trim();
  const resources = usageResources(env);
  const { probes, unconfigured } = buildProbes(resources);
  const result: SyncResult = { configured: true, days, errors: {} };

  for (const day of days) {
    const startedAt = now();
    const errors: Record<string, string> = Object.fromEntries(
      Object.entries(unconfigured).map(([k, v]) => [`${k}:unconfigured`, v])
    );
    const rows: { metric: string; resource: string; quantity: number }[] = [];
    let failed = 0;
    await pool(probes, CONCURRENCY, async (p) => {
      try {
        rows.push(
          ...(await runProbe(fetchImpl, token, resources.accountId, p, day))
        );
      } catch (e) {
        failed++;
        errors[p.id] = e instanceof Error ? e.message : String(e);
      }
    });
    const fetchedAt = now();
    const writes = rows.map((r) =>
      db
        .insert(usageDaily)
        .values({
          date: day,
          product: productOf(r.metric),
          metric: r.metric,
          resource: r.resource,
          quantity: r.quantity,
          source: 'cloudflare',
          fetchedAt,
        })
        .onConflictDoUpdate({
          target: [usageDaily.date, usageDaily.metric, usageDaily.resource],
          set: { quantity: r.quantity, fetchedAt },
        })
    );
    const status =
      failed === 0 ? 'ok' : failed === probes.length ? 'error' : 'partial';
    const syncRow = db
      .insert(usageSyncs)
      .values({ id: day, startedAt, completedAt: now(), status, errors })
      .onConflictDoUpdate({
        target: usageSyncs.id,
        set: { startedAt, completedAt: now(), status, errors },
      });
    // D1 batches are atomic: a day's numbers and its sync record land together.
    await db.batch([syncRow, ...writes]);
    if (Object.keys(errors).length) result.errors[day] = errors;
  }
  return result;
}

/** The daily cron: recent days plus a few never-synced ones. */
export async function syncUsageCron(env: CloudflareBindings) {
  if (!analyticsConfigured(env)) return;
  const db = drizzle(env.DB, { schema });
  const days = await daysToSync(db, new Date());
  const res = await syncUsage(env, days, { db });
  const failedDays = Object.keys(res.errors).filter((d) =>
    Object.keys(res.errors[d]).some((k) => !k.endsWith(':unconfigured'))
  );
  if (failedDays.length)
    console.warn('[usage] some analytics were unavailable', failedDays);
}

/** The latest sync, for the page header and the "Sync now" rate limit. */
export async function latestSync(db: DrizzleDB) {
  return (
    (await db
      .select()
      .from(usageSyncs)
      .orderBy(desc(usageSyncs.completedAt))
      .limit(1)
      .get()) ?? null
  );
}
