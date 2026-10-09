import { describe, expect, it } from 'vitest';
import {
  filterPulls,
  paginate,
  parsePullsView,
  pullsHref,
  PULLS_PAGE_SIZE,
} from './pullsView';
import type { Pull } from './uiApi';

const params = (s: string) => new URLSearchParams(s);

describe('parsePullsView', () => {
  it('opens the board with nothing chosen', () => {
    expect(parsePullsView(params(''), null)).toEqual({
      view: 'board',
      state: 'open',
      q: '',
      page: 1,
    });
  });

  it('takes ?view= when it names a view', () => {
    expect(parsePullsView(params('view=list'), null).view).toBe('list');
    expect(parsePullsView(params('view=graph'), null).view).toBe('graph');
    expect(parsePullsView(params('view=board'), 'list').view).toBe('board');
  });

  it('falls back to the remembered view, then the board', () => {
    expect(parsePullsView(params(''), 'graph').view).toBe('graph');
    expect(parsePullsView(params(''), 'list').view).toBe('list');
    expect(parsePullsView(params('view=sideways'), 'list').view).toBe('list');
    expect(parsePullsView(params(''), 'sideways').view).toBe('board');
  });

  it('shows the list for the filters older links carry', () => {
    for (const state of [
      'closed',
      'agent_followup',
      'human_review',
      'waiting',
      'ready',
    ])
      expect(parsePullsView(params(`state=${state}`), 'graph')).toMatchObject({
        view: 'list',
        state,
      });
  });

  it('lets ?view= win over an old state filter', () => {
    expect(
      parsePullsView(params('state=closed&view=board'), null)
    ).toMatchObject({ view: 'board', state: 'closed' });
  });

  it('ignores a state it does not know', () => {
    expect(parsePullsView(params('state=bogus'), null)).toMatchObject({
      view: 'board',
      state: 'open',
    });
    expect(parsePullsView(params('state=open'), null).state).toBe('open');
  });

  it('reads the search text and the page', () => {
    expect(
      parsePullsView(params('q=%20rate%20limit%20&page=3'), null)
    ).toMatchObject({ q: 'rate limit', page: 3 });
    expect(parsePullsView(params('page=0'), null).page).toBe(1);
    expect(parsePullsView(params('page=-2'), null).page).toBe(1);
    expect(parsePullsView(params('page=abc'), null).page).toBe(1);
    expect(parsePullsView(params('page=2.5'), null).page).toBe(1);
  });
});

describe('pullsHref', () => {
  const base = '/o/r';

  it('leaves out everything that is the default', () => {
    expect(pullsHref(base, {})).toBe('/o/r/pulls');
    expect(pullsHref(base, { view: 'board', state: 'open', page: 1 })).toBe(
      '/o/r/pulls'
    );
  });

  it('names the view and keeps the list filters', () => {
    expect(pullsHref(base, { view: 'list' })).toBe('/o/r/pulls?view=list');
    expect(
      pullsHref(base, { view: 'list', state: 'closed', q: 'a b', page: 2 })
    ).toBe('/o/r/pulls?view=list&state=closed&q=a+b&page=2');
    expect(pullsHref(base, { view: 'graph' })).toBe('/o/r/pulls?view=graph');
  });

  it('only carries filters on the list', () => {
    expect(pullsHref(base, { view: 'board', state: 'closed', q: 'x' })).toBe(
      '/o/r/pulls'
    );
  });
});

const pull = (n: number, extra: Partial<Pull> = {}): Pull =>
  ({
    id: `p${n}`,
    number: n,
    title: `Pull ${n}`,
    author: { id: 'u', username: 'cho', name: 'Cho Yin', image: null },
    headRef: `branch-${n}`,
    createdVia: null,
    sessionLabel: null,
    ...extra,
  }) as Pull;

describe('filterPulls', () => {
  const all = [
    pull(10, { title: 'Bill in US dollars', headRef: 'billing/s4-usd' }),
    pull(11, {
      title: 'Invoice PDF',
      createdVia: 'Claude Code',
      sessionLabel: 's4',
    }),
    pull(12, {
      title: 'Rate limit',
      author: { id: 'm', username: 'mahmoud', name: 'Mahmoud H.', image: null },
    }),
  ];
  const numbers = (ps: Pull[]) => ps.map((p) => p.number);

  it('returns every pull request for an empty search', () => {
    expect(filterPulls(all, '')).toHaveLength(3);
    expect(filterPulls(all, '   ')).toHaveLength(3);
  });

  it('matches the title without caring about case', () => {
    expect(numbers(filterPulls(all, 'DOLLARS'))).toEqual([10]);
  });

  it('matches a number with or without the hash', () => {
    expect(numbers(filterPulls(all, '#11'))).toEqual([11]);
    expect(numbers(filterPulls(all, '12'))).toEqual([12]);
  });

  it('matches the author, the branch and the session', () => {
    expect(numbers(filterPulls(all, 'mahmoud'))).toEqual([12]);
    expect(numbers(filterPulls(all, 's4-usd'))).toEqual([10]);
    expect(numbers(filterPulls(all, 'claude s4'))).toEqual([11]);
    expect(numbers(filterPulls(all, 'Claude·s4'))).toEqual([11]);
  });

  it('needs every word to match', () => {
    expect(numbers(filterPulls(all, 'invoice pdf'))).toEqual([11]);
    expect(filterPulls(all, 'invoice dollars')).toEqual([]);
  });

  it('matches "by hand" on pull requests opened by hand', () => {
    expect(numbers(filterPulls(all, 'by hand'))).toEqual([10, 12]);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: PULLS_PAGE_SIZE * 2 + 3 }, (_, i) => i);

  it('returns the first page', () => {
    const p = paginate(items, 1);
    expect(p.items).toHaveLength(PULLS_PAGE_SIZE);
    expect(p).toMatchObject({ page: 1, pages: 3, total: items.length });
  });

  it('returns the short last page', () => {
    const p = paginate(items, 3);
    expect(p.items).toEqual([
      PULLS_PAGE_SIZE * 2,
      PULLS_PAGE_SIZE * 2 + 1,
      PULLS_PAGE_SIZE * 2 + 2,
    ]);
  });

  it('clamps a page past the end to the last one', () => {
    expect(paginate(items, 99).page).toBe(3);
  });

  it('has one empty page for nothing', () => {
    expect(paginate([], 1)).toEqual({ items: [], page: 1, pages: 1, total: 0 });
  });
});
