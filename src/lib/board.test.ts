import { describe, expect, it } from 'vitest';
import {
  boardRows,
  boardTotals,
  crewActivity,
  dayLabels,
  filterBoard,
  filterCounts,
  flightSegments,
  languageColor,
  mostPressing,
  needsAttention,
  parseBoardParams,
  pullChip,
  type BoardRow,
} from './board';
import type { Agent, RepoStats, RepoWithStats } from './uiApi';

type StatsOver = Omit<Partial<RepoStats>, 'pulls'> & {
  pulls?: Partial<RepoStats['pulls']>;
};

const stats = ({ pulls, ...over }: StatsOver = {}): RepoStats => ({
  pulls: {
    open: 0,
    needsPerson: 0,
    changesRequested: 0,
    checking: 0,
    queued: 0,
    ...pulls,
  },
  merged7d: 0,
  mergedByDay: [0, 0, 0, 0, 0, 0, 0],
  mergedAutomaticallyPct: null,
  agents: [],
  branchCount: 1,
  language: null,
  updatedAt: 1000,
  ...over,
});

const repo = (
  owner: string,
  name: string,
  over: StatsOver = {},
  description: string | null = null
): RepoWithStats => ({
  id: `${owner}-${name}`,
  owner: { id: owner, username: owner, name: owner, image: null },
  ownerType: 'user',
  visibility: 'internal',
  name,
  fullName: `${owner}/${name}`,
  description,
  defaultBranch: 'main',
  protectedBranches: [],
  deleteMergedBranches: true,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  stats: stats(over),
});

const agent = (handle: string, over: Partial<Agent> = {}): Agent => ({
  id: handle,
  username: handle,
  name: handle,
  image: null,
  bio: 'Checks things.',
  trigger: { ask: 'Does it?', above: 0.5 },
  engine: 'pass',
  color: '#2a78d6',
  facet: null,
  guarded: false,
  repository: `${handle}/${handle}`,
  configSha: null,
  configError: null,
  createdAt: '2026-10-01T00:00:00Z',
  deletedAt: null,
  ...over,
});

describe('boardRows', () => {
  it('pairs a repository with the agent whose instructions it holds', () => {
    const rows = boardRows(
      [repo('mahmoud', 'invoices'), repo('dataagent', 'dataagent')],
      [agent('dataagent')]
    );
    expect(rows.map((r) => r.agent?.username ?? null)).toEqual([
      null,
      'dataagent',
    ]);
  });

  it('needs both the owner and the name to be the agent handle', () => {
    const rows = boardRows(
      [repo('mahmoud', 'dataagent'), repo('dataagent', 'notes')],
      [agent('dataagent')]
    );
    expect(rows.every((r) => r.agent === null)).toBe(true);
  });

  it('ignores a deleted agent', () => {
    const rows = boardRows(
      [repo('dataagent', 'dataagent')],
      [agent('dataagent', { deletedAt: '2026-10-02T00:00:00Z' })]
    );
    expect(rows[0].agent).toBeNull();
  });
});

describe('needsAttention', () => {
  it('is a person having a move, not an agent', () => {
    expect(
      needsAttention(
        boardRows([repo('a', 'b', { pulls: { needsPerson: 1 } })], [])[0]
      )
    ).toBe(true);
    expect(
      needsAttention(
        boardRows([repo('a', 'b', { pulls: { changesRequested: 3 } })], [])[0]
      )
    ).toBe(false);
  });
});

describe('filterBoard', () => {
  const rows: BoardRow[] = boardRows(
    [
      repo('mahmoud', 'website', { updatedAt: 10 }, 'Marketing site'),
      repo(
        'mahmoud',
        'invoices',
        { updatedAt: 30, pulls: { needsPerson: 2 } },
        'Invoices and PDFs'
      ),
      repo('dataagent', 'dataagent', { updatedAt: 20 }, 'Keeps data safe'),
    ],
    [agent('dataagent')]
  );
  const names = (r: BoardRow[]) => r.map((x) => x.repo.fullName);

  it('sorts by most recently updated, or by name', () => {
    expect(
      names(filterBoard(rows, { query: '', filter: 'all', sort: 'updated' }))
    ).toEqual(['mahmoud/invoices', 'dataagent/dataagent', 'mahmoud/website']);
    expect(
      names(filterBoard(rows, { query: '', filter: 'all', sort: 'name' }))
    ).toEqual(['dataagent/dataagent', 'mahmoud/invoices', 'mahmoud/website']);
  });

  it('filters code, agent instructions and what needs attention', () => {
    expect(
      names(filterBoard(rows, { query: '', filter: 'code', sort: 'name' }))
    ).toEqual(['mahmoud/invoices', 'mahmoud/website']);
    expect(
      names(filterBoard(rows, { query: '', filter: 'agent', sort: 'name' }))
    ).toEqual(['dataagent/dataagent']);
    expect(
      names(filterBoard(rows, { query: '', filter: 'attention', sort: 'name' }))
    ).toEqual(['mahmoud/invoices']);
  });

  it('searches the name and the description, ignoring case', () => {
    expect(
      names(filterBoard(rows, { query: 'PDF', filter: 'all', sort: 'name' }))
    ).toEqual(['mahmoud/invoices']);
    expect(
      names(
        filterBoard(rows, {
          query: ' MAHMOUD/web ',
          filter: 'all',
          sort: 'name',
        })
      )
    ).toEqual(['mahmoud/website']);
    expect(
      names(filterBoard(rows, { query: 'zzz', filter: 'all', sort: 'name' }))
    ).toEqual([]);
  });

  it('counts each filter within the search', () => {
    expect(filterCounts(rows, '')).toEqual({
      all: 3,
      attention: 1,
      code: 2,
      agent: 1,
    });
    expect(filterCounts(rows, 'data')).toEqual({
      all: 1,
      attention: 0,
      code: 0,
      agent: 1,
    });
  });
});

describe('boardTotals', () => {
  it('adds up open and merged, and weights the share merged on its own', () => {
    const rows = boardRows(
      [
        repo('a', 'one', {
          pulls: { open: 4 },
          merged7d: 10,
          mergedAutomaticallyPct: 80,
        }),
        repo('a', 'two', {
          pulls: { open: 1 },
          merged7d: 10,
          mergedAutomaticallyPct: 40,
        }),
        repo('a', 'three', {}),
      ],
      []
    );
    expect(boardTotals(rows)).toEqual({
      repositories: 3,
      open: 5,
      merged7d: 20,
      automatic: 12,
      automaticPct: 60,
    });
  });

  it('has no share when nothing merged', () => {
    expect(boardTotals(boardRows([repo('a', 'one')], [])).automaticPct).toBe(
      null
    );
    expect(boardTotals([])).toEqual({
      repositories: 0,
      open: 0,
      merged7d: 0,
      automatic: 0,
      automaticPct: null,
    });
  });
});

describe('flightSegments', () => {
  it('lists the buckets that have pull requests, in the order of whose move it is', () => {
    expect(
      flightSegments({
        open: 6,
        needsPerson: 1,
        changesRequested: 2,
        checking: 2,
        queued: 1,
      })
    ).toEqual([
      { key: 'needs', label: 'needs a person', count: 1 },
      { key: 'asked', label: 'changes requested', count: 2 },
      { key: 'reviewing', label: 'checking', count: 2 },
      { key: 'clear', label: 'queued', count: 1 },
    ]);
  });

  it('leaves out empty buckets, and may add up to less than open', () => {
    expect(
      flightSegments({
        open: 5,
        needsPerson: 0,
        changesRequested: 0,
        checking: 2,
        queued: 0,
      })
    ).toEqual([{ key: 'reviewing', label: 'checking', count: 2 }]);
    expect(
      flightSegments({
        open: 0,
        needsPerson: 0,
        changesRequested: 0,
        checking: 0,
        queued: 0,
      })
    ).toEqual([]);
  });
});

describe('pullChip', () => {
  const p = (o: Partial<RepoStats['pulls']>) => ({
    open: 0,
    needsPerson: 0,
    changesRequested: 0,
    checking: 0,
    queued: 0,
    ...o,
  });
  it('leads with a person having a move', () => {
    expect(pullChip(p({ open: 3, needsPerson: 1, checking: 2 }))).toEqual({
      tone: 'warn',
      label: '1 needs a person',
    });
    expect(pullChip(p({ open: 3, needsPerson: 2 }))).toEqual({
      tone: 'warn',
      label: '2 need a person',
    });
  });
  it('then changes an agent has to make, checks running and the merge line', () => {
    expect(pullChip(p({ open: 2, changesRequested: 2 }))).toEqual({
      tone: 'serious',
      label: '2 with changes requested',
    });
    expect(pullChip(p({ open: 1, checking: 1 }))).toEqual({
      tone: 'info',
      label: '1 being checked',
    });
    expect(pullChip(p({ open: 2, queued: 2 }))).toEqual({
      tone: 'good',
      label: '2 queued to merge',
    });
  });
  it('is neutral with nothing open, and plain when the buckets miss a pull request', () => {
    expect(pullChip(p({}))).toEqual({
      tone: 'off',
      label: 'No open pull requests',
    });
    expect(pullChip(p({ open: 2 }))).toEqual({ tone: 'off', label: '2 open' });
  });
});

describe('mostPressing and crewActivity', () => {
  it('picks what blocks a merge before what is in progress before what is done', () => {
    expect(mostPressing(['idle', 'approved', 'reviewing'])).toBe('reviewing');
    expect(mostPressing(['approved', 'flagged', 'changes_requested'])).toBe(
      'changes_requested'
    );
    expect(mostPressing(['failed', 'flagged'])).toBe('failed');
    expect(mostPressing(['idle', 'not_needed'])).toBe('idle');
    expect(mostPressing([])).toBe('idle');
  });

  it('folds an agent across repositories', () => {
    const a = { handle: 'dataagent', name: 'Data', color: '#199e70' };
    const rows = boardRows(
      [
        repo('a', 'one', { agents: [{ ...a, status: 'approved' }] }),
        repo('a', 'two', { agents: [{ ...a, status: 'flagged' }] }),
        repo('a', 'three', {
          agents: [
            {
              handle: 'speedagent',
              name: 'Speed',
              color: '#c98500',
              status: 'idle',
            },
          ],
        }),
      ],
      []
    );
    const crew = crewActivity(rows);
    expect(crew.map((c) => [c.handle, c.status])).toEqual([
      ['dataagent', 'flagged'],
      ['speedagent', 'idle'],
    ]);
    expect(crew[0]).toMatchObject({ name: 'Data', color: '#199e70' });
  });
});

describe('dayLabels', () => {
  it('names the last days in UTC, oldest first, today last', () => {
    const labels = dayLabels(7, Date.UTC(2026, 9, 9, 23, 30));
    expect(labels).toHaveLength(7);
    expect(labels[6]).toBe('Fri, Oct 9');
    expect(labels[0]).toBe('Sat, Oct 3');
  });
});

describe('languageColor', () => {
  it('knows the languages the board names, and falls back to grey', () => {
    expect(languageColor('TypeScript')).toBe('#3178c6');
    expect(languageColor('Python')).toBe('#3572a5');
    expect(languageColor('Brainfuck')).toBe('#8b949e');
    expect(languageColor(null)).toBe('#8b949e');
  });
});

describe('parseBoardParams', () => {
  it('reads the search, filter and sort from the address, ignoring junk', () => {
    expect(
      parseBoardParams(new URLSearchParams('q=inv&filter=agent&sort=name'))
    ).toEqual({ query: 'inv', filter: 'agent', sort: 'name' });
    expect(
      parseBoardParams(new URLSearchParams('filter=nope&sort=up'))
    ).toEqual({ query: '', filter: 'all', sort: 'updated' });
    expect(parseBoardParams(new URLSearchParams(''))).toEqual({
      query: '',
      filter: 'all',
      sort: 'updated',
    });
  });
});
