import { queryOptions } from '@tanstack/react-query';
import { SEARCH_STALE_MS } from './searchKeys';
import { api, qk, type SearchResults } from './uiApi';

/**
 * The global search's query (`GET /api/search`): one per term and scope, never run for an empty term.
 *
 * - A superseded request is cancelled: the query function hands the signal on, and TanStack aborts it when the
 *   term changes and nothing watches that query any more.
 * - The previous answer stays up while the next one loads, but only within the same scope: another repository's
 *   branches and files would be wrong.
 * - No retries: an error says so at once, and typing again asks again.
 */
export function searchQueryOptions(
  term: string,
  scope: string | null,
  enabled = true
) {
  return queryOptions({
    queryKey: qk.search(term, scope),
    queryFn: ({ signal }) => api.search(term, scope, signal),
    enabled: enabled && term !== '',
    staleTime: SEARCH_STALE_MS,
    retry: false,
    placeholderData: (previous: SearchResults | undefined, previousQuery) =>
      previousQuery?.queryKey[2] === scope ? previous : undefined,
  });
}
