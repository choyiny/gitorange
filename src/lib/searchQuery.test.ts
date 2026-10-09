import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { searchQueryOptions } from './searchQuery';
import type { SearchResults } from './uiApi';

const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

const results = (repo: string): SearchResults => ({
  repos: [{ name: repo, description: null }],
  pulls: [],
  agents: [],
  people: [],
  branches: [],
  files: [],
});

/** Every request the page made, with a way to answer it and the signal it would be aborted by. */
let requests: {
  url: string;
  signal: AbortSignal | null | undefined;
  answer(body: SearchResults): void;
}[];

beforeEach(() => {
  requests = [];
  vi.stubGlobal(
    'fetch',
    (url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        requests.push({
          url: String(url),
          signal: init?.signal,
          answer: (body) =>
            resolve(
              new Response(JSON.stringify(body), {
                headers: { 'content-type': 'application/json' },
              })
            ),
        });
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        );
      })
  );
});
afterEach(() => vi.unstubAllGlobals());

/** What the search box does: one observer whose options change as the (debounced) term and scope do. */
function watch() {
  const client = new QueryClient();
  const observer = new QueryObserver(client, searchQueryOptions('a', null));
  const unsubscribe = observer.subscribe(() => {});
  return {
    observer,
    type: (term: string, scope: string | null = null) =>
      observer.setOptions(searchQueryOptions(term, scope)),
    now: () => observer.getCurrentResult(),
    stop: () => {
      unsubscribe();
      client.clear();
    },
  };
}

describe('searchQueryOptions', () => {
  it('asks /api/search for the term, in the scope of the repository being viewed', async () => {
    const s = watch();
    await wait();
    s.type('auth', 'o/r');
    await wait();
    expect(requests.map((r) => r.url)).toEqual([
      '/api/search?q=a',
      '/api/search?q=auth&repo=o%2Fr',
    ]);
    s.stop();
  });

  it('never asks for an empty term', async () => {
    const s = watch();
    await wait();
    requests[0].answer(results('o/a'));
    await wait();
    s.type('');
    await wait();
    expect(requests).toHaveLength(1);
    expect(s.now().fetchStatus).toBe('idle');
    s.stop();
  });

  it('keeps the previous results up while the next ones load', async () => {
    const s = watch();
    await wait();
    requests[0].answer(results('o/a'));
    await wait();
    s.type('ab');
    await wait();
    expect(s.now()).toMatchObject({
      isFetching: true,
      isPlaceholderData: true,
      data: results('o/a'),
    });
    requests[1].answer(results('o/ab'));
    await wait();
    expect(s.now()).toMatchObject({
      isFetching: false,
      isPlaceholderData: false,
      data: results('o/ab'),
    });
    s.stop();
  });

  it('cancels a request the next keystroke made stale', async () => {
    const s = watch();
    await wait();
    s.type('ab');
    await wait();
    expect(requests[0].signal?.aborted).toBe(true);
    expect(requests[1].signal?.aborted).toBe(false);
    s.stop();
  });

  it("doesn't carry results over to another repository", async () => {
    const s = watch();
    await wait();
    requests[0].answer(results('o/a'));
    await wait();
    s.type('a', 'o/r');
    await wait();
    expect(s.now().data).toBeUndefined();
    s.stop();
  });

  it('answers from memory when a term is typed again within a few seconds', async () => {
    const s = watch();
    await wait();
    requests[0].answer(results('o/a'));
    await wait();
    s.type('ab');
    await wait();
    requests[1].answer(results('o/ab'));
    await wait();
    s.type('a');
    await wait();
    expect(requests).toHaveLength(2);
    expect(s.now().data).toEqual(results('o/a'));
    s.stop();
  });

  it('shows an error at once instead of retrying', async () => {
    const s = watch();
    await wait();
    // The server refused it.
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 400 }));
    s.type('b');
    await wait();
    expect(s.now().isError).toBe(true);
    s.stop();
  });
});
