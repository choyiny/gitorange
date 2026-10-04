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
const MAX_BACKOFF_MS = 30_000;

/**
 * One WebSocket per tab to `/api/live`. The server only says *what* changed (a repository, or
 * approvals); the matching queries refetch through the normal API, so pages update live without
 * a reload. It reconnects with backoff and refetches everything after reconnecting, in case a
 * ping was missed while offline.
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
    let retry: ReturnType<typeof setTimeout> | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let flush: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();

    // Bursts (an Actions run finishing several steps) collapse into one refetch.
    const schedule = (type: string) => {
      pending.add(type);
      clearTimeout(flush);
      flush = setTimeout(() => {
        if (pending.has('repo') && repo) {
          const [owner, name] = repo.split('/');
          void qc.invalidateQueries({ queryKey: ['repo', owner, name] });
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
        keepalive = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send('ping');
        }, KEEPALIVE_MS);
      };
      ws.onmessage = (e) => {
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

/** Follows a repository live while the calling component (the repository layout) is shown. */
export function useLiveRepo(owner: string, repo: string) {
  const setRepo = useContext(LiveRepoContext);
  useEffect(() => {
    if (!owner || !repo) return;
    setRepo(`${owner}/${repo}`);
    return () => setRepo(null);
  }, [setRepo, owner, repo]);
}
