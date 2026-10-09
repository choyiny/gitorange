import { describe, expect, it } from 'vitest';
import {
  CLEARED,
  SEARCH_GROUPS,
  blurCloses,
  flattenSections,
  hitsFromResults,
  jumpHits,
  localResults,
  pageHits,
  searchKey,
  searchSections,
  type SearchHit,
  type SearchResults,
} from './searchKeys';

const hit = (kind: SearchHit['kind'], label: string): SearchHit => ({
  kind,
  label,
  sub: null,
  to: `/${kind}/${label}`,
});

const empty: SearchResults = {
  repos: [],
  pulls: [],
  agents: [],
  people: [],
  branches: [],
  files: [],
};

describe('searchSections (grouping)', () => {
  it('groups hits in the spec order, whatever order they arrive in', () => {
    const sections = searchSections('a', [
      hit('page', 'Approvals'),
      hit('file', 'src/a.ts'),
      hit('person', 'amira'),
      hit('repo', 'a/app'),
      hit('branch', 'add-x'),
      hit('agent', 'dataagent'),
      hit('pull', '#3 Add'),
    ]);
    expect(sections.map((s) => s.title)).toEqual([
      'Repositories',
      'Pull requests',
      'Agents',
      'People',
      'Branches',
      'Files',
      'Pages',
    ]);
    expect(SEARCH_GROUPS.map((g) => g.title)).toEqual(
      sections.map((s) => s.title)
    );
  });

  it('drops empty groups and caps each one', () => {
    const repos = Array.from({ length: 9 }, (_, i) => hit('repo', `o/r${i}`));
    const sections = searchSections('r', [...repos, hit('person', 'rae')], {
      perGroup: 4,
    });
    expect(sections.map((s) => [s.title, s.hits.length])).toEqual([
      ['Repositories', 4],
      ['People', 1],
    ]);
  });

  it('with no query offers one "Jump to" list', () => {
    const sections = searchSections('  ', [hit('repo', 'a/one')]);
    expect(sections).toEqual([
      { title: 'Jump to', hits: [hit('repo', 'a/one')] },
    ]);
  });

  it('flattens back to the order the keys move through', () => {
    const sections = searchSections('a', [
      hit('person', 'amira'),
      hit('repo', 'a/app'),
    ]);
    expect(flattenSections(sections).map((h) => h.label)).toEqual([
      'a/app',
      'amira',
    ]);
  });
});

describe('searchKey (keyboard)', () => {
  const hits = [hit('repo', 'a'), hit('repo', 'b'), hit('repo', 'c')];

  it('ArrowDown moves down and wraps from the last to the first', () => {
    let state = { q: 'x', sel: 0 };
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = searchKey(state, 'ArrowDown', hits);
      expect(r.handled).toBe(true);
      state = r.state;
      seen.push(state.sel);
    }
    expect(seen).toEqual([1, 2, 0, 1]);
  });

  it('ArrowUp moves up and wraps from the first to the last', () => {
    const r = searchKey({ q: 'x', sel: 0 }, 'ArrowUp', hits);
    expect(r.state.sel).toBe(2);
    expect(searchKey(r.state, 'ArrowUp', hits).state.sel).toBe(1);
  });

  it('arrows with no results stay put (and still keep the caret still)', () => {
    const r = searchKey({ q: 'zz', sel: 0 }, 'ArrowDown', []);
    expect(r).toMatchObject({ handled: true, state: { q: 'zz', sel: 0 } });
  });

  it('Enter goes to the selected hit and clears the search', () => {
    const r = searchKey({ q: 'x', sel: 1 }, 'Enter', hits);
    expect(r).toEqual({
      handled: true,
      close: true,
      go: '/repo/b',
      state: CLEARED,
    });
  });

  it('Enter with nothing to open does nothing', () => {
    expect(searchKey({ q: 'zz', sel: 0 }, 'Enter', [])).toMatchObject({
      handled: false,
      go: null,
      close: false,
    });
  });

  it('Escape clears the query and closes', () => {
    expect(searchKey({ q: 'abc', sel: 2 }, 'Escape', hits)).toEqual({
      handled: true,
      close: true,
      go: null,
      state: CLEARED,
    });
    expect(CLEARED).toEqual({ q: '', sel: 0 });
  });

  it('leaves every other key to the input', () => {
    const r = searchKey({ q: 'ab', sel: 1 }, 'a', hits);
    expect(r).toEqual({
      handled: false,
      close: false,
      go: null,
      state: { q: 'ab', sel: 1 },
    });
  });

  it('clamps a stale selection after the results shrank', () => {
    expect(searchKey({ q: 'x', sel: 7 }, 'Enter', hits).go).toBe('/repo/c');
  });
});

describe('blurCloses (leaving the search box)', () => {
  const tabbedOut = {
    windowFocused: true,
    pressedInside: false,
    focusInside: false,
  };

  it('closes when focus moves elsewhere in the page (Tab out)', () => {
    expect(blurCloses(tabbedOut)).toBe(true);
  });

  it('stays open when the whole window lost focus (switching apps)', () => {
    expect(blurCloses({ ...tabbedOut, windowFocused: false })).toBe(false);
  });

  it('stays open after a press inside the box (the results scrollbar)', () => {
    expect(blurCloses({ ...tabbedOut, pressedInside: true })).toBe(false);
  });

  it('stays open when focus moved to something inside the box', () => {
    expect(blurCloses({ ...tabbedOut, focusInside: true })).toBe(false);
  });
});

describe('localResults (the client-side source until /api/search)', () => {
  const data = {
    repos: [
      {
        fullName: 'choyiny/gitorange',
        description: 'A code host',
        updatedAt: '2026-10-08T00:00:00Z',
      },
      {
        fullName: 'mahmoud/orange-notes',
        description: null,
        updatedAt: '2026-10-07T00:00:00Z',
      },
      {
        fullName: 'mahmoud/website',
        description: 'Uses Orange colours',
        updatedAt: '2026-10-06T00:00:00Z',
      },
    ],
    agents: [
      { username: 'dataagent', name: 'Data', color: '#199e70' },
      { username: 'securityagent', name: 'Security' },
    ],
    people: [
      { username: 'mahmoud', name: 'Mahmoud Halat' },
      { username: 'cho', name: 'Cho Yin Yong' },
    ],
  };

  it('filters repositories, agents and people case-insensitively', () => {
    const r = localResults('ORANGE', data);
    expect(r.repos.map((x) => x.name)).toEqual([
      'mahmoud/orange-notes',
      'choyiny/gitorange',
      'mahmoud/website',
    ]);
    expect(localResults('data', data).agents).toEqual([
      { handle: 'dataagent', name: 'Data', color: '#199e70' },
    ]);
    expect(localResults('yong', data).people).toEqual([
      { login: 'cho', name: 'Cho Yin Yong' },
    ]);
  });

  it('ranks a name that starts with the query above one that contains it', () => {
    expect(localResults('m', data).people.map((p) => p.login)).toEqual([
      'mahmoud',
    ]);
    expect(localResults('a', data).agents.map((a) => a.handle)).toEqual([
      'dataagent',
      'securityagent',
    ]);
  });

  it("searches the current repository's branches, and nothing it can't know", () => {
    const r = localResults('fix', {
      ...data,
      repo: { fullName: 'choyiny/gitorange', branches: ['main', 'fix-x'] },
    });
    expect(r.branches).toEqual([{ repo: 'choyiny/gitorange', name: 'fix-x' }]);
    expect(r.pulls).toEqual([]);
    expect(r.files).toEqual([]);
  });

  it('returns at most eight of each, like the API', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      fullName: `o/r${i}`,
      description: null,
      updatedAt: '',
    }));
    expect(localResults('r', { ...data, repos: many }).repos).toHaveLength(8);
  });

  it('returns nothing for a blank query', () => {
    expect(localResults('  ', data)).toEqual(empty);
  });
});

describe('hitsFromResults', () => {
  it('links every kind of result to its page', () => {
    const hits = hitsFromResults(
      {
        repos: [{ name: 'o/r', description: 'd' }],
        pulls: [{ repo: 'o/r', number: 4, title: 'Fix', state: 'open' }],
        agents: [{ handle: 'dataagent', name: 'Data', color: '#199e70' }],
        people: [{ login: 'cho', name: null }],
        branches: [{ repo: 'o/r', name: 'feat/a b' }],
        files: [{ repo: 'o/r', path: 'src/a b.ts' }],
      },
      { defaultBranch: 'main' }
    );
    expect(hits.map((h) => [h.kind, h.label, h.to])).toEqual([
      ['repo', 'o/r', '/o/r'],
      ['pull', '#4 Fix', '/o/r/pull/4'],
      ['agent', 'Data', '/dataagent'],
      ['person', 'cho', '/cho'],
      ['branch', 'feat/a b', '/o/r/tree/feat/a%20b'],
      ['file', 'src/a b.ts', '/o/r/blob/main/src/a%20b.ts'],
    ]);
    expect(hits[2].color).toBe('#199e70');
  });
});

describe('jumpHits', () => {
  it('lists recently visited repositories first, then the rest', () => {
    const hits = jumpHits(
      [
        { fullName: 'a/one', description: null },
        { fullName: 'a/two', description: 'Two' },
        { fullName: 'a/three', description: null },
      ],
      ['a/three', 'gone/repo']
    );
    expect(hits.map((h) => h.label)).toEqual(['a/three', 'a/one', 'a/two']);
  });
});

describe('pageHits', () => {
  it('finds pages by name, and Site admin pages only for admins', () => {
    expect(pageHits('usage', { admin: false, repo: null })).toEqual([]);
    expect(
      pageHits('usage', { admin: true, repo: null }).map((h) => h.to)
    ).toEqual(['/admin/usage']);
    expect(
      pageHits('email', { admin: false, repo: null }).map((h) => h.to)
    ).toEqual(['/settings/emails']);
  });

  it('matches keywords from the start of a word, not inside one', () => {
    // "password" and "cursor" are keywords of the token and MCP pages; "or" is inside them, not a word start.
    expect(
      pageHits('or', { admin: false, repo: null }).map((h) => h.label)
    ).toEqual(['Repositories', 'New repository']);
    expect(
      pageHits('curs', { admin: false, repo: null }).map((h) => h.label)
    ).toEqual(['MCP server']);
  });

  it("adds the current repository's tabs inside a repository", () => {
    expect(pageHits('actions', { admin: false, repo: null })).toEqual([]);
    expect(
      pageHits('actions', { admin: false, repo: 'o/r' }).map((h) => [
        h.label,
        h.to,
      ])
    ).toEqual([['Actions', '/o/r/actions']]);
  });
});
