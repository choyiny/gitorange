import { useRef } from 'react';

/**
 * The class for a page's wrapper: `enter` (the short fade-up) when the data arrived after a skeleton, nothing
 * when the page painted straight from the cache, so revisits are instant.
 */
export function useEnter(ready: boolean): string {
  const afterSkeleton = useRef(!ready);
  if (!ready) afterSkeleton.current = true;
  return ready && afterSkeleton.current ? 'enter' : '';
}
