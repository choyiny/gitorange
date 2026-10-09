/**
 * The rail's "recently visited" repositories: the five most recent, newest first, kept per person in this browser
 * (localStorage). Storage can be missing, blocked or hold junk (private windows, cleared site data, an older
 * format), so every read and write is wrapped and a bad value reads as an empty list. Pure apart from the
 * `Storage` passed in; the shell supplies `localStorage`.
 */

export const RECENT_MAX = 5;

export interface RecentRepo {
  /** `owner/name`. */
  fullName: string;
  /** Set for an agent's instruction repository (`<handle>/<handle>`): the rail shows the agent's avatar. */
  agent?: { handle: string; color: string | null };
}

/** The part of `Storage` this module uses. */
export type RecentStorage = Pick<Storage, 'getItem' | 'setItem'>;

const FULL_NAME = /^[^/\s]+\/[^/\s]+$/;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** One list per person, so a shared browser never shows someone else's repositories. */
export function recentKey(userId: string): string {
  return `go-recent-repos:${userId}`;
}

/** Records a visit: the repository moves to the front (one entry, newest details), at most `RECENT_MAX` kept. */
export function addRecent(list: RecentRepo[], entry: RecentRepo): RecentRepo[] {
  return [
    entry,
    ...list.filter((r) => !same(r.fullName, entry.fullName)),
  ].slice(0, RECENT_MAX);
}

/** Forgets a repository the person can no longer open (deleted, renamed or access removed). */
export function removeRecent(
  list: RecentRepo[],
  fullName: string
): RecentRepo[] {
  return list.filter((r) => !same(r.fullName, fullName));
}

function parseEntry(value: unknown): RecentRepo | null {
  if (!value || typeof value !== 'object') return null;
  const { fullName, agent } = value as Record<string, unknown>;
  if (typeof fullName !== 'string' || !FULL_NAME.test(fullName)) return null;
  if (agent && typeof agent === 'object') {
    const { handle, color } = agent as Record<string, unknown>;
    if (typeof handle === 'string' && handle)
      return {
        fullName,
        agent: { handle, color: typeof color === 'string' ? color : null },
      };
  }
  return { fullName };
}

/** Reads a stored list, keeping the well-formed entries; anything unreadable is an empty list. */
export function parseRecent(raw: string | null | undefined): RecentRepo[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: RecentRepo[] = [];
  for (const item of value) {
    const entry = parseEntry(item);
    if (entry && !out.some((r) => same(r.fullName, entry.fullName)))
      out.push(entry);
    if (out.length === RECENT_MAX) break;
  }
  return out;
}

export function readRecent(
  storage: RecentStorage | null | undefined,
  key: string
): RecentRepo[] {
  try {
    return parseRecent(storage?.getItem(key));
  } catch {
    return [];
  }
}

export function writeRecent(
  storage: RecentStorage | null | undefined,
  key: string,
  list: RecentRepo[]
): void {
  try {
    storage?.setItem(key, JSON.stringify(list));
  } catch {
    // Blocked or full storage: the list lasts for this page only.
  }
}

/** `localStorage`, or null where reading it throws (blocked site data) or it doesn't exist. */
export function browserStorage(): RecentStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
