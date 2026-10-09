import type { z } from '@hono/zod-openapi';
import { and, desc, eq, lt, lte, ne, or, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
  agents,
  auditEvents,
  prEvents,
  pullRequests,
  type AuditAction,
  type AuditActorKind,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import type { auditEventSchema, auditPageSchema } from '../routers/schemas';
import { findReposByIds } from './repos';

// The audit log: who did what, in a repository or on the instance. recordAudit writes audit_events rows next to the
// mutation they describe and never throws; listAudit reads them merged with the pull request timeline (pr_events).

export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditPage = z.infer<typeof auditPageSchema>;

export type NewAuditEvent = {
  /** Null for an instance event (tokens, instance settings, agents, a deleted repository). */
  repositoryId: string | null;
  actorId: string | null;
  /** Defaults to `person` when there is an actor, else `system`. */
  actorKind?: AuditActorKind;
  /** The app it went through: a connected MCP app's name, or "GitOrange AI". */
  via?: string | null;
  action: AuditAction;
  /** What it was done to, as people read it: "#12", a branch, a handle, a token or setting name. */
  target: string;
  /** Short facts about it; never secrets, prompts or diffs. */
  data?: Record<string, unknown>;
  /** The pull request it concerns (stored as `data.pull`). */
  pull?: number;
};

/** Records one event. Never throws: a failed write is logged and the caller carries on. */
export async function recordAudit(
  db: DrizzleDB,
  e: NewAuditEvent
): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      id: crypto.randomUUID(),
      repositoryId: e.repositoryId,
      actorId: e.actorId,
      actorKind: e.actorKind ?? (e.actorId ? 'person' : 'system'),
      via: e.via ?? null,
      action: e.action,
      target: e.target,
      data: { ...e.data, ...(e.pull === undefined ? {} : { pull: e.pull }) },
      createdAt: new Date(),
    });
  } catch (err) {
    console.error('[audit] could not record', e.action, e.target, err);
  }
}

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 100;

/**
 * Where a page ended: the last event's time, its source (`a` audit_events, `p` pr_events) and id. Events are ordered
 * newest first, then `p` before `a` at the same millisecond, then by id descending.
 */
type Cursor = { at: number; src: 'a' | 'p'; id: string };

const toBase64Url = (s: string) =>
  btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function encodeCursor(c: Cursor): string {
  return toBase64Url(JSON.stringify([c.at, c.src, c.id]));
}

/** The cursor a page handed out, or null for anything else. */
export function decodeCursor(s: string): Cursor | null {
  try {
    const json = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const v: unknown = JSON.parse(json);
    if (
      Array.isArray(v) &&
      v.length === 3 &&
      Number.isSafeInteger(v[0]) &&
      (v[1] === 'a' || v[1] === 'p') &&
      typeof v[2] === 'string'
    )
      return { at: v[0], src: v[1], id: v[2] };
  } catch {
    // Not base64 or not JSON: not ours.
  }
  return null;
}

/** Rows of a source that come after `c` in the order above. */
function after(
  c: Cursor,
  src: 'a' | 'p',
  col: { createdAt: AnySQLiteColumn; id: AnySQLiteColumn }
): SQL {
  const at = new Date(c.at);
  // Same millisecond: `p` rows come before `a` rows, so after an `a` cursor no `p` row at that time is left, and
  // after a `p` cursor every `a` row at that time is.
  if (src === c.src)
    return or(
      lt(col.createdAt, at),
      and(eq(col.createdAt, at), lt(col.id, c.id))
    )!;
  return src === 'a' ? lte(col.createdAt, at) : lt(col.createdAt, at);
}

type Listed = AuditEvent & { src: 'a' | 'p'; repositoryId: string | null };

const newestFirst = (x: Listed, y: Listed) =>
  y.at - x.at ||
  (x.src === y.src ? 0 : x.src === 'p' ? -1 : 1) ||
  (x.id < y.id ? 1 : x.id > y.id ? -1 : 0);

/**
 * One page of the audit log, newest first: audit_events merged with pr_events (as `pull.<kind>`), for one repository,
 * or (`repositoryId` null) the whole instance, instance events included. The caller checks who may read it. A
 * person's approval is in audit_events (`pull.approved`), so its pr_events row is left out. Throws on a cursor
 * `decodeCursor` refuses.
 */
export async function listAudit(
  db: DrizzleDB,
  opts: { repositoryId: string | null; cursor?: string | null; limit?: number }
): Promise<AuditPage> {
  const limit = Math.min(
    Math.max(Math.trunc(opts.limit ?? AUDIT_PAGE_DEFAULT), 1),
    AUDIT_PAGE_MAX
  );
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (opts.cursor && !cursor) throw new Error('Invalid audit cursor');
  const repo = opts.repositoryId;
  const [audit, timeline] = await db.batch([
    db
      .select({
        e: auditEvents,
        login: users.username,
        name: users.name,
      })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorId))
      .where(
        and(
          repo === null ? undefined : eq(auditEvents.repositoryId, repo),
          cursor ? after(cursor, 'a', auditEvents) : undefined
        )
      )
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(limit + 1),
    db
      .select({
        e: prEvents,
        number: pullRequests.number,
        login: users.username,
        name: users.name,
        agent: agents.userId,
      })
      .from(prEvents)
      .innerJoin(pullRequests, eq(pullRequests.id, prEvents.pullRequestId))
      .leftJoin(users, eq(users.id, prEvents.actorId))
      .leftJoin(agents, eq(agents.userId, prEvents.actorId))
      .where(
        and(
          repo === null ? undefined : eq(prEvents.repositoryId, repo),
          ne(prEvents.kind, 'approved'),
          cursor ? after(cursor, 'p', prEvents) : undefined
        )
      )
      .orderBy(desc(prEvents.createdAt), desc(prEvents.id))
      .limit(limit + 1),
  ]);

  const listed: Listed[] = [
    ...audit.map(({ e, login, name }): Listed => {
      const data = e.data ?? {};
      return {
        src: 'a',
        repositoryId: e.repositoryId,
        id: e.id,
        at: e.createdAt.getTime(),
        actor: {
          kind: e.actorKind,
          login: e.actorKind === 'system' ? null : (login ?? null),
          name: e.actorKind === 'system' ? null : (name ?? null),
        },
        via: e.via,
        action: e.action,
        target: e.target,
        data,
        repo: null,
        pull: typeof data.pull === 'number' ? data.pull : null,
      };
    }),
    ...timeline.map(({ e, number, login, name, agent }): Listed => {
      const data: Record<string, unknown> = {
        ...(e.state ? { state: e.state } : {}),
        ...e.data,
      };
      return {
        src: 'p',
        repositoryId: e.repositoryId,
        id: e.id,
        at: e.createdAt.getTime(),
        actor: {
          kind: !e.actorId ? 'system' : agent ? 'agent' : 'person',
          login: e.actorId ? (login ?? null) : null,
          name: e.actorId ? (name ?? null) : null,
        },
        via: typeof data.via === 'string' ? data.via : null,
        action: `pull.${e.kind}`,
        target: `#${number}`,
        data,
        repo: null,
        pull: number,
      };
    }),
  ].sort(newestFirst);

  const page = listed.slice(0, limit);
  const repos = await findReposByIds(
    db,
    page.flatMap((e) => (e.repositoryId ? [e.repositoryId] : []))
  );
  const last = page.at(-1);
  return {
    events: page.map(({ src: _src, repositoryId, ...e }) => {
      const found = repositoryId ? repos.get(repositoryId) : undefined;
      return {
        ...e,
        repo: found ? `${found.namespace.username}/${found.repo.name}` : null,
      };
    }),
    nextCursor:
      listed.length > limit && last
        ? encodeCursor({ at: last.at, src: last.src, id: last.id })
        : null,
  };
}
