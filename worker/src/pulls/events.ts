import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  prEvents,
  type PrEvent,
  type PrEventKind,
  type PullRequest,
} from '../db/app.schema';
import { chunks } from '../stack/view';
import type { PullState, PullStateName, Reason } from './state';

type PrRef = Pick<PullRequest, 'id' | 'repositoryId'>;

const LATEST_STATE_ID = `SELECT id FROM pr_events
  WHERE pull_request_id = ? AND kind = 'state_changed'
  ORDER BY computed_at DESC, rowid DESC LIMIT 1`;

/**
 * The two statements recording `s` for the PR, to run in one D1 batch (a transaction):
 * 1. if its latest recorded state is already `s.state`, advance that row's computed_at to `computedAt` (the
 *    "last settled at"), so an older computation finishing later sees a newer one even when it recorded nothing;
 * 2. insert `s`, unless the latest recorded state is already `s.state` or anything computed after `computedAt` is
 *    recorded (a slower, older computation never overwrites a newer one).
 */
export function stateEventStatements(
  d1: D1Database,
  pr: PrRef,
  s: PullState,
  computedAt: number
): [D1PreparedStatement, D1PreparedStatement] {
  const data = JSON.stringify({ reasons: s.reasons });
  return [
    d1
      .prepare(
        `UPDATE pr_events SET computed_at = ?
          WHERE id = (${LATEST_STATE_ID}) AND state = ? AND computed_at < ?`
      )
      .bind(computedAt, pr.id, s.state, computedAt),
    d1
      .prepare(
        `INSERT INTO pr_events (id, repository_id, pull_request_id, kind, state, data, computed_at, created_at)
         SELECT ?, ?, ?, 'state_changed', ?, ?, ?, ?
          WHERE COALESCE((SELECT state FROM pr_events WHERE id = (${LATEST_STATE_ID})), '') <> ?
            AND NOT EXISTS (
              SELECT 1 FROM pr_events
               WHERE pull_request_id = ? AND kind = 'state_changed' AND computed_at > ?)`
      )
      .bind(
        crypto.randomUUID(),
        pr.repositoryId,
        pr.id,
        s.state,
        data,
        computedAt,
        Date.now(),
        pr.id,
        s.state,
        pr.id,
        computedAt
      ),
  ];
}

/** The D1 binding under a drizzle instance (its batch is a transaction; drizzle's batch rejects raw statements). */
export function d1Of(db: DrizzleDB): D1Database {
  const d1 = (db as DrizzleDB & { $client?: D1Database }).$client;
  if (!d1) throw new Error('drizzle instance has no D1 client');
  return d1;
}

/** Records each PR's state if it changed, in transactional batches; returns how many were recorded. */
export async function recordStates(
  db: DrizzleDB,
  prs: PrRef[],
  states: Map<string, PullState>,
  computedAt: number
): Promise<number> {
  const listed = prs.filter((pr) => states.has(pr.id));
  if (!listed.length) return 0;
  const d1 = d1Of(db);
  let inserted = 0;
  for (const part of chunks(listed, 50)) {
    const results = await d1.batch(
      part.flatMap((pr) =>
        stateEventStatements(d1, pr, states.get(pr.id)!, computedAt)
      )
    );
    // Pairs of [bump, insert]: count the inserts.
    for (let i = 1; i < results.length; i += 2)
      inserted += results[i].meta?.changes ?? 0;
  }
  return inserted;
}

/**
 * Records one of GitOrange's own timeline entries (not a state change). Pass a deterministic `id` from inside a
 * Workflow step so a retried step records it once.
 */
export async function recordEvent(
  db: DrizzleDB,
  e: {
    id?: string;
    repositoryId: string;
    pullRequestId: string;
    kind: Exclude<PrEventKind, 'state_changed'>;
    data?: Record<string, unknown>;
    actorId?: string | null;
  }
): Promise<void> {
  const now = new Date();
  await db
    .insert(prEvents)
    .values({
      id: e.id ?? crypto.randomUUID(),
      repositoryId: e.repositoryId,
      pullRequestId: e.pullRequestId,
      kind: e.kind,
      state: null,
      data: e.data ?? null,
      actorId: e.actorId ?? null,
      // eventsFor orders by computed_at: a timeline entry sorts at when it happened.
      computedAt: now,
      createdAt: now,
    })
    .onConflictDoNothing({ target: prEvents.id });
}

/** A PR's newest `limit` timeline events, oldest first. */
export async function eventsFor(
  db: DrizzleDB,
  pullRequestId: string,
  limit = 500
): Promise<PrEvent[]> {
  const newest = await db
    .select()
    .from(prEvents)
    .where(eq(prEvents.pullRequestId, pullRequestId))
    .orderBy(desc(prEvents.computedAt), sql`rowid DESC`)
    .limit(limit)
    .all();
  return newest.reverse();
}

/** Each PR's latest recorded state, in chunked queries. */
export async function latestStates(
  db: DrizzleDB,
  pullRequestIds: string[]
): Promise<Map<string, PullState>> {
  const out = new Map<string, PullState>();
  for (const part of chunks(pullRequestIds, 90))
    for (const e of await db
      .select({
        pullRequestId: prEvents.pullRequestId,
        state: prEvents.state,
        data: prEvents.data,
      })
      .from(prEvents)
      .where(
        and(
          inArray(prEvents.pullRequestId, part),
          eq(prEvents.kind, 'state_changed'),
          sql`${prEvents}.rowid = (SELECT x.rowid FROM pr_events x WHERE x.pull_request_id = ${prEvents.pullRequestId} AND x.kind = 'state_changed' ORDER BY x.computed_at DESC, x.rowid DESC LIMIT 1)`
        )
      )
      .all())
      if (e.state)
        out.set(e.pullRequestId, {
          state: e.state as PullStateName,
          reasons: (e.data as { reasons?: Reason[] } | null)?.reasons ?? [],
        });
  return out;
}
