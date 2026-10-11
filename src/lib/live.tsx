import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCurrentUser } from './auth';

/** Sets which repository the live connection also follows (null: none). */
const LiveRepoContext = createContext<(repo: string | null) => void>(() => {});

const KEEPALIVE_MS = 30_000;
/**
 * How often pages that watch work move (the Pulls board and graph) refetch on their own while visible, so a ping that
 * was missed or answered by a lagging read never leaves them wrong for long. Hidden tabs don't poll.
 */
export const WATCH_REFETCH_MS = 20_000;
/** The second refetch after a ping (see `schedule`). */
const SETTLE_MS = 3_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * One WebSocket per tab to `/api/live`; pings invalidate the matching queries. Reconnects with
 * backoff and refetches everything after reconnecting, since pings may have been missed.
 */
export function LiveUpdates({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const user = useCurrentUser();
  const [repo, setRepo] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let connectedBefore = false;
    let heard = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let flush: ReturnType<typeof setTimeout> | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();

    // Bursts (an Actions run finishing several steps) collapse into one refetch.
    const schedule = (type: string) => {
      pending.add(type);
      clearTimeout(flush);
      flush = setTimeout(() => {
        if (pending.has('repo') && repo) {
          const [owner, name] = repo.split('/');
          const key = ['repo', owner, name];
          void qc.invalidateQueries({ queryKey: key });
          // Once more a moment later: a read made right after the write can come from a replica that hasn't caught
          // up, and the page would keep that answer until the next ping.
          clearTimeout(settle);
          settle = setTimeout(
            () => void qc.invalidateQueries({ queryKey: key }),
            SETTLE_MS
          );
        }
        if (pending.has('approvals'))
          void qc.invalidateQueries({ queryKey: ['approvals'] });
        pending.clear();
      }, 150);
    };

    const connect = () => {
      const url = new URL('/api/live', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      if (repo) url.searchParams.set('repo', repo);
      ws = new WebSocket(url);
      ws.onopen = () => {
        attempt = 0;
        if (connectedBefore) {
          schedule('repo');
          schedule('approvals');
        }
        connectedBefore = true;
        heard = Date.now();
        keepalive = setInterval(() => {
          if (ws?.readyState !== WebSocket.OPEN) return;
          // A socket that went quiet without closing (sleep, network change) never gets another ping: replace it.
          if (Date.now() - heard > 2 * KEEPALIVE_MS + 5_000) {
            ws.onclose = null;
            ws.close();
            clearInterval(keepalive);
            connect();
            return;
          }
          ws.send('ping');
        }, KEEPALIVE_MS);
      };
      ws.onmessage = (e) => {
        heard = Date.now();
        if (e.data === 'pong') return;
        try {
          const msg = JSON.parse(String(e.data)) as { type?: string };
          if (msg.type) schedule(msg.type);
        } catch {
          // Not ours.
        }
      };
      ws.onclose = () => {
        clearInterval(keepalive);
        if (closed) return;
        retry = setTimeout(
          connect,
          Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt++)
        );
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(flush);
      clearTimeout(settle);
      clearInterval(keepalive);
      ws?.close();
    };
  }, [qc, user?.id, repo]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <LiveRepoContext.Provider value={setRepo}>
      {children}
    </LiveRepoContext.Provider>
  );
}

/** Follows a repository live while the calling component is mounted. */
export function useLiveRepo(owner: string, repo: string) {
  const setRepo = useContext(LiveRepoContext);
  useEffect(() => {
    if (!owner || !repo) return;
    setRepo(`${owner}/${repo}`);
    return () => setRepo(null);
  }, [setRepo, owner, repo]);
}
