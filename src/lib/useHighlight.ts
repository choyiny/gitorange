import { useEffect, useState } from 'react';

type Highlighter = typeof import('./highlight');

let loading: Promise<Highlighter> | null = null;
const load = () => (loading ??= import('./highlight'));

/**
 * Lazily loads the highlighter and runs `fn` with it. Returns null until it's ready (or when
 * `enabled` is false), so callers render plain text first and upgrade in place.
 */
export function useHighlighter<T>(
  enabled: boolean,
  fn: (h: Highlighter) => T,
  deps: unknown[]
): T | null {
  const [result, setResult] = useState<T | null>(null);
  useEffect(() => {
    if (!enabled) {
      setResult(null);
      return;
    }
    let cancelled = false;
    load().then((h) => {
      if (!cancelled) setResult(fn(h));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
  return result;
}
