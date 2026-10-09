/**
 * A coding session's page: its name, its one-line description and its timeline. A session is the pull requests one
 * app opened for one person (`GET …/sessions/{id}`); pull requests opened on the web or by `git push` are that
 * person's "by hand" session. The timeline comes from the pull request lists (opened, merged, closed), which carry
 * each pull request's session id.
 */
import type { Pull, PersonRef, SessionSummary } from './uiApi';

const who = (p: Pick<PersonRef, 'login' | 'name'>) => p.name || p.login;

/** "Claude Code · s4", "Codex", or "Mahmoud H. by hand". */
export function sessionName(
  s: Pick<SessionSummary, 'client' | 'label' | 'author'>
): string {
  if (!s.client) return `${who(s.author)} by hand`;
  return s.label ? `${s.client} · ${s.label}` : s.client;
}

/** "Claude Code session for Mahmoud H. · 2 pull requests". */
export function sessionLede(s: {
  client: string | null;
  author: Pick<PersonRef, 'login' | 'name'>;
  pulls: unknown[];
}): string {
  const n = s.pulls.length;
  const count = `${n} pull request${n === 1 ? '' : 's'}`;
  return s.client
    ? `${s.client} session for ${who(s.author)} · ${count}`
    : `Opened by hand by ${who(s.author)} · ${count}`;
}

/** The parts of a pull request list row the timeline reads. */
export type TimelinePull = Pick<
  Pull,
  | 'number'
  | 'title'
  | 'state'
  | 'sessionId'
  | 'createdAt'
  | 'mergedAt'
  | 'closedAt'
  | 'mergedAutomatically'
> & { mergedBy: Pick<NonNullable<Pull['mergedBy']>, 'username'> | null };

export interface SessionEvent {
  /** Epoch milliseconds. */
  at: number;
  kind: 'opened' | 'merged' | 'closed';
  number: number;
  title: string;
  /** Who merged it (a username); null when GitOrange merged it, and for the other kinds. */
  actor: string | null;
  /** GitOrange merged it on its own. */
  automatic: boolean;
}

const ORDER: Record<SessionEvent['kind'], number> = {
  opened: 0,
  merged: 1,
  closed: 2,
};

/** The session's pull requests opening, merging and closing, oldest first. */
export function sessionTimeline(
  pulls: TimelinePull[],
  sessionId: string
): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const p of pulls) {
    if (p.sessionId !== sessionId) continue;
    const base = { number: p.number, title: p.title };
    events.push({
      ...base,
      at: Date.parse(p.createdAt),
      kind: 'opened',
      actor: null,
      automatic: false,
    });
    if (p.state === 'merged' && p.mergedAt)
      events.push({
        ...base,
        at: Date.parse(p.mergedAt),
        kind: 'merged',
        actor: p.mergedAutomatically ? null : (p.mergedBy?.username ?? null),
        automatic: p.mergedAutomatically,
      });
    else if (p.state === 'closed' && p.closedAt)
      events.push({
        ...base,
        at: Date.parse(p.closedAt),
        kind: 'closed',
        actor: null,
        automatic: false,
      });
  }
  return events.sort(
    (a, b) =>
      a.at - b.at || a.number - b.number || ORDER[a.kind] - ORDER[b.kind]
  );
}
