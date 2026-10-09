import { useQuery } from '@tanstack/react-query';
import { api, qk } from './uiApi';

/**
 * How often the board's numbers are read again while the page is open. Live pings refresh only the repository being
 * followed and Approvals, never `['repos', 'stats']`, so Home and the board poll (and refresh when the window is
 * focused again).
 */
export const BOARD_REFRESH_MS = 30_000;

/** Every repository you can see, with its board numbers. Shared by Home and the Repositories board. */
export function useRepoStats() {
  return useQuery({
    queryKey: qk.repoStats,
    queryFn: api.repoStats,
    refetchInterval: BOARD_REFRESH_MS,
    refetchOnWindowFocus: true,
  });
}

/** Reviewer agents, for their names, colours and instruction repositories. */
export function useAgentList() {
  return useQuery({ queryKey: qk.agents, queryFn: api.agents });
}

/**
 * Home's own read of a repository's log: the newest 40 events, of which only the notable ones are shown. Not
 * `qk.repoAudit` (the Audit log page's key holds 50-event pages), but under the same repository prefix.
 */
export const homeAuditKey = (owner: string, name: string) =>
  ['repo', owner, name, 'audit', 'home'] as const;
export const HOME_AUDIT_LIMIT = 40;
