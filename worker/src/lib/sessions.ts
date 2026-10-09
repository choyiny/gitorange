import { and, eq } from 'drizzle-orm';
import { pullRequests, type Repository } from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import type { GitService } from '../git/service';
import { pullStates } from '../pulls/signals';
import type { PullState } from '../pulls/state';
import { reviewConfigured } from '../review/head';
import { GHOST, personRefs, type PersonRef } from './person-ref';

// Coding sessions: the pull requests an app such as Claude Code opened for one person, grouped as the app reported
// them (the OAuth client's name, the session label, and who was signed in). A session is derived, never stored: it is
// the group of `pull_requests` rows that share `(author_id, created_via, session_label)`. Pull requests opened on the
// web or by `git push` have neither a client nor a label, and form one "by hand" session per person.

export type SessionSummary = {
  /** `s-` and the first 10 hex of sha256(author id NUL client NUL label): the same group always has the same id. */
  id: string;
  /** The app that opened them (`created_via`, e.g. "Claude Code"); null means by hand. */
  client: string | null;
  /** The label the app gave the session (`session_label`, e.g. "s4"). */
  label: string | null;
  author: PersonRef;
  /** Oldest first. `pullState` is whose move it is, for an open pull request; null for the others. */
  pulls: {
    number: number;
    title: string;
    state: 'open' | 'closed' | 'merged';
    pullState: PullState | null;
  }[];
  /** What the person asked for, for each pull request that carries it. */
  requests: { number: number; text: string }[];
  /** When any of its pull requests last changed, epoch milliseconds. */
  lastActivity: number;
};

/** The id of a session: `s-` and the first 10 hex of sha256(authorId + NUL + (client ?? '') + NUL + (label ?? '')). */
export async function sessionId(
  authorId: string,
  client: string | null,
  label: string | null
): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${authorId}\0${client ?? ''}\0${label ?? ''}`
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest.subarray(0, 5), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
  return `s-${hex}`;
}

type Row = {
  id: string;
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  authorId: string;
  createdVia: string | null;
  sessionLabel: string | null;
  request: string | null;
  updatedAt: Date;
};

/** A group of one person's pull requests from one app and session. */
type Group = {
  id: string;
  authorId: string;
  client: string | null;
  label: string | null;
  pulls: Row[];
};

/**
 * The repository's sessions, most recently active first, or (`id`) just that one (an empty list when there is no
 * such session). `openOnly` keeps only open pull requests, and so only the sessions that have one: the requests
 * "floor" of the Live page.
 *
 * One read of the repository's pull requests, one of its refs and the batched `pullStates` for the open ones: never a
 * query per session or per pull request. When the refs cannot be read the pull requests show no state.
 */
export async function repoSessions(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  repo: Repository,
  opts: { id?: string; openOnly?: boolean } = {}
): Promise<SessionSummary[]> {
  // Only what grouping and display need (not the descriptions, which can be long); open ones are read in full below.
  const rows = await db
    .select({
      id: pullRequests.id,
      number: pullRequests.number,
      title: pullRequests.title,
      state: pullRequests.state,
      authorId: pullRequests.authorId,
      createdVia: pullRequests.createdVia,
      sessionLabel: pullRequests.sessionLabel,
      request: pullRequests.request,
      updatedAt: pullRequests.updatedAt,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repo.id),
        opts.openOnly ? eq(pullRequests.state, 'open') : undefined
      )
    )
    .orderBy(pullRequests.number)
    .all();

  const groups = new Map<string, Group>();
  for (const pr of rows) {
    const client = pr.createdVia || null;
    const label = pr.sessionLabel || null;
    // The same key as the id's input, so a group and its id are one thing.
    const key = `${pr.authorId}\0${client ?? ''}\0${label ?? ''}`;
    const group = groups.get(key);
    if (group) group.pulls.push(pr);
    else
      groups.set(key, {
        id: '',
        authorId: pr.authorId,
        client,
        label,
        pulls: [pr],
      });
  }
  let chosen = [...groups.values()];
  for (const g of chosen) g.id = await sessionId(g.authorId, g.client, g.label);
  if (opts.id) chosen = chosen.filter((g) => g.id === opts.id);
  if (!chosen.length) return [];

  const openIds = new Set(
    chosen
      .flatMap((g) => g.pulls.filter((p) => p.state === 'open'))
      .map((p) => p.id)
  );
  let states = new Map<string, PullState>();
  if (openIds.size)
    try {
      const open = (
        await db
          .select()
          .from(pullRequests)
          .where(
            and(
              eq(pullRequests.repositoryId, repo.id),
              eq(pullRequests.state, 'open')
            )
          )
          .all()
      ).filter((p) => openIds.has(p.id));
      states = await pullStates(db, git, repo.id, open, {
        reviewConfigured: reviewConfigured(env),
      });
    } catch (e) {
      console.error('[sessions] could not compute pull states', repo.id, e);
    }
  const people = await personRefs(
    db,
    chosen.map((g) => g.authorId)
  );

  return chosen
    .map((g): SessionSummary => ({
      id: g.id,
      client: g.client,
      label: g.label,
      author: people.get(g.authorId) ?? GHOST,
      pulls: g.pulls.map((p) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        pullState: p.state === 'open' ? (states.get(p.id) ?? null) : null,
      })),
      requests: g.pulls.flatMap((p) =>
        p.request ? [{ number: p.number, text: p.request }] : []
      ),
      lastActivity: Math.max(...g.pulls.map((p) => p.updatedAt.getTime())),
    }))
    .sort((a, b) => b.lastActivity - a.lastActivity || (a.id < b.id ? -1 : 1));
}
