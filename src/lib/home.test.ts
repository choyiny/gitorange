import { describe, expect, it } from 'vitest';
import {
  brokenRepos,
  dateEyebrow,
  decisionsOf,
  healthState,
  homeHeadline,
  homeLede,
  isNotable,
  mergeActivity,
  repoVerdict,
  sinceLastWeek,
  topByActivity,
} from './home';
import { boardRows } from './board';
import type {
  ApprovalItem,
  AuditEvent,
  HealthArea,
  HealthReport,
  RepoStats,
  RepoWithStats,
  ReviewFlag,
} from './uiApi';

const flag = (id: string, over: Partial<ReviewFlag> = {}): ReviewFlag => ({
  id,
  kind: 'needs_person',
  title: `Finding ${id}`,
  paths: [],
  detail: null,
  detailModel: null,
  agentSha: null,
  approvedBy: null,
  approvedAt: null,
  approvedVia: null,
  changesRequestedBy: null,
  changesRequestedAt: null,
  changesRequestedNote: null,
  question: `Question ${id}?`,
  guarded: false,
  assignee: null,
  decidedVia: null,
  reason: null,
  teach: null,
  ...over,
});

const item = (n: number, flags: ReviewFlag[]): ApprovalItem => ({
  repo: { fullName: 'a/b', name: 'b' },
  pull: {
    number: n,
    title: `PR ${n}`,
    author: null,
    updatedAt: '2026-10-09T00:00:00Z',
    headSha: 'abc',
  },
  reviewFailed: null,
  resolutionFailed: null,
  needsApproval: false,
  agents: [
    {
      reviewerId: `r${n}`,
      agent: { id: 'x', username: 'dataagent', name: 'Data', image: null },
      status: 'flagged',
      error: null,
      flags,
    },
  ],
  pullState: null,
  stackStale: [],
  stackUnchecked: [],
});

describe('decisionsOf', () => {
  it('lists the open findings that carry a plain question for the owner', () => {
    const ds = decisionsOf(
      [
        item(1, [flag('a'), flag('b', { question: null })]),
        item(2, [flag('c', { question: '  ' }), flag('d')]),
      ],
      'me'
    );
    expect(ds.map((d) => d.flag.id)).toEqual(['a', 'd']);
    expect(ds[0].item.pull.number).toBe(1);
    expect(ds[0].agent.agent.username).toBe('dataagent');
  });

  it('skips change requests and findings someone already decided', () => {
    const ds = decisionsOf(
      [
        item(1, [
          flag('a', { kind: 'change_requested' }),
          flag('b', { approvedAt: '2026-10-09T00:00:00Z' }),
          flag('c'),
        ]),
      ],
      'me'
    );
    expect(ds.map((d) => d.flag.id)).toEqual(['c']);
  });

  it('puts what is assigned to you first, and what is assigned to someone else last', () => {
    const person = (login: string) => ({
      login,
      name: null,
      isAgent: false,
      color: null,
    });
    const ds = decisionsOf(
      [
        item(1, [
          flag('other', { assignee: person('cho') }),
          flag('nobody'),
          flag('mine', { assignee: person('me') }),
        ]),
      ],
      'me'
    );
    expect(ds.map((d) => d.flag.id)).toEqual(['mine', 'nobody', 'other']);
  });
});

describe('homeHeadline', () => {
  const fine = { kind: 'fine', checked: 3, total: 3 } as const;

  it('reassures when every repository was checked and nothing is broken', () => {
    const h = (decisions: number, others: number) =>
      homeHeadline({ decisions, others, health: fine });
    expect(h(1, 3)).toBe(
      'Nothing is broken. 1 decision and 3 other items need you.'
    );
    expect(h(1, 0)).toBe('Nothing is broken. 1 decision needs you.');
    expect(h(2, 0)).toBe('Nothing is broken. 2 decisions need you.');
    expect(h(0, 1)).toBe('Nothing is broken. 1 item needs you.');
    expect(h(0, 4)).toBe('Nothing is broken. 4 items need you.');
    expect(h(0, 0)).toBe('Nothing is broken. Nothing needs you.');
  });

  it('only claims what was checked when there are more repositories', () => {
    expect(
      homeHeadline({
        decisions: 1,
        others: 0,
        health: { kind: 'fine', checked: 3, total: 7 },
      })
    ).toBe(
      'Nothing is broken in your 3 busiest repositories. 1 decision needs you.'
    );
    expect(
      homeHeadline({
        decisions: 0,
        others: 0,
        health: { kind: 'fine', checked: 1, total: 2 },
      })
    ).toBe('Nothing is broken in your busiest repository. Nothing needs you.');
  });

  it('says what is failing instead of reassuring', () => {
    expect(
      homeHeadline({
        decisions: 0,
        others: 0,
        health: { kind: 'failing', repos: ['a/one', 'a/two'] },
      })
    ).toBe('Tests are failing on a/one and a/two. Nothing needs you.');
  });

  it('makes no claim when health could not be read', () => {
    expect(
      homeHeadline({
        decisions: 1,
        others: 0,
        health: { kind: 'unavailable' },
      })
    ).toBe('1 decision needs you.');
    expect(
      homeHeadline({
        decisions: 0,
        others: 0,
        health: { kind: 'unavailable' },
      })
    ).toBe('Nothing needs you.');
  });

  it('says nothing while it is still loading', () => {
    expect(
      homeHeadline({ decisions: 1, others: 0, health: { kind: 'loading' } })
    ).toBeNull();
  });
});

describe('healthState', () => {
  const base = {
    loading: false,
    unavailable: false,
    total: 5,
    checked: 3,
    pending: 0,
    failed: 0,
    failing: [] as string[],
  };

  it('is loading until the board, the agents and every report have settled', () => {
    expect(healthState({ ...base, loading: true })).toEqual({
      kind: 'loading',
    });
    expect(healthState({ ...base, pending: 1 })).toEqual({ kind: 'loading' });
    // Even a repository already known to fail waits for the others, so the sentence does not grow.
    expect(healthState({ ...base, pending: 1, failing: ['a/b'] })).toEqual({
      kind: 'loading',
    });
  });

  it('is fine for as many repositories as were checked', () => {
    expect(healthState(base)).toEqual({ kind: 'fine', checked: 3, total: 5 });
    expect(healthState({ ...base, total: 0, checked: 0 })).toEqual({
      kind: 'fine',
      checked: 0,
      total: 0,
    });
  });

  it('reports failing tests whatever else failed', () => {
    expect(healthState({ ...base, failing: ['a/b'], failed: 1 })).toEqual({
      kind: 'failing',
      repos: ['a/b'],
    });
  });

  it('is unavailable when a report or the lists could not be read', () => {
    expect(healthState({ ...base, failed: 1 })).toEqual({
      kind: 'unavailable',
    });
    expect(healthState({ ...base, unavailable: true, loading: true })).toEqual({
      kind: 'unavailable',
    });
  });
});

describe('homeLede', () => {
  it('tells what merged and how much needed no merge click', () => {
    expect(homeLede({ merged7d: 67, automatic: 56 })).toBe(
      'GitOrange merged 67 changes in the last 7 days; 56 needed no merge click.'
    );
    expect(homeLede({ merged7d: 1, automatic: 1 })).toBe(
      'GitOrange merged 1 change in the last 7 days, and it needed no merge click.'
    );
    expect(homeLede({ merged7d: 3, automatic: 3 })).toBe(
      'GitOrange merged 3 changes in the last 7 days, and none needed a merge click.'
    );
    expect(homeLede({ merged7d: 0, automatic: 0 })).toBe(
      'Nothing has merged in the last 7 days.'
    );
  });
});

describe('dateEyebrow', () => {
  it('writes the day as people say it', () => {
    expect(dateEyebrow(new Date(2026, 9, 9, 15))).toBe('Friday 9 October');
    expect(dateEyebrow(new Date(2026, 0, 1, 0, 5))).toBe('Thursday 1 January');
  });
});

const stats = (
  over: Partial<RepoStats> & { open?: number } = {}
): RepoStats => {
  const { open = 0, ...rest } = over;
  return {
    pulls: {
      open,
      needsPerson: 0,
      changesRequested: 0,
      checking: 0,
      queued: 0,
    },
    merged7d: 0,
    mergedByDay: [0, 0, 0, 0, 0, 0, 0],
    mergedAutomaticallyPct: null,
    agents: [],
    branchCount: 1,
    language: null,
    updatedAt: 1000,
    ...rest,
  };
};
const repo = (
  owner: string,
  name: string,
  over: Partial<RepoStats> & { open?: number } = {}
): RepoWithStats => ({
  id: `${owner}-${name}`,
  owner: { id: owner, username: owner, name: owner, image: null },
  ownerType: 'user',
  visibility: 'internal',
  name,
  fullName: `${owner}/${name}`,
  description: null,
  defaultBranch: 'main',
  protectedBranches: [],
  deleteMergedBranches: true,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  stats: stats(over),
});

describe('topByActivity', () => {
  it('ranks code repositories by open pull requests plus merges this week, then by recency', () => {
    const rows = boardRows(
      [
        repo('a', 'quiet', { updatedAt: 50 }),
        repo('a', 'busy', { open: 3, merged7d: 4, updatedAt: 10 }),
        repo('a', 'newer', { open: 1, updatedAt: 99 }),
        repo('a', 'older', { open: 1, updatedAt: 20 }),
        repo('dataagent', 'dataagent', { open: 9, merged7d: 9 }),
      ],
      [
        {
          id: 'x',
          username: 'dataagent',
          name: 'Data',
          image: null,
          bio: '',
          trigger: { ask: '', above: 0 },
          engine: 'pass',
          color: '#199e70',
          facet: 'data',
          guarded: true,
          repository: 'dataagent/dataagent',
          configSha: null,
          configError: null,
          createdAt: '',
          deletedAt: null,
        },
      ]
    );
    expect(topByActivity(rows, 3).map((r) => r.repo.fullName)).toEqual([
      'a/busy',
      'a/newer',
      'a/older',
    ]);
  });
});

const area = (over: Partial<HealthArea> = {}): HealthArea => ({
  id: 'agent:securityagent',
  label: 'Security',
  color: '#2a78d6',
  agent: 'securityagent',
  thisWeek: 0,
  lastWeek: 0,
  weeks: [0, 0, 0, 0, 0, 0, 0, 0],
  trend: 'same',
  status: 'No open problems',
  detail: 'None raised this week or last',
  open: 0,
  ...over,
});
const report = (
  areas: HealthArea[],
  over: Partial<HealthReport> = {}
): HealthReport => ({
  summary: '',
  decisionsWaiting: 0,
  areas,
  contributors: [],
  ...over,
});

describe('sinceLastWeek', () => {
  it('tells what got worse, then better, then what stayed the same', () => {
    const lines = sinceLastWeek([
      {
        repo: 'a/b',
        report: report([
          area({ id: 'agent:dataagent', label: 'Data' }),
          area({
            label: 'Security',
            trend: 'better',
            detail: '1 raised this week, 2 fewer than last week',
          }),
          area({
            id: 'merging',
            label: 'Merging',
            trend: 'worse',
            detail: '2 reverts this week, 1 more than last week',
          }),
        ]),
      },
    ]);
    expect(lines).toEqual([
      {
        trend: 'worse',
        text: 'Merging: 2 reverts this week, 1 more than last week',
      },
      {
        trend: 'better',
        text: 'Security: 1 raised this week, 2 fewer than last week',
      },
      { trend: 'same', text: 'No change in Data' },
    ]);
  });

  it('names an area that stayed the same but still has open problems', () => {
    const lines = sinceLastWeek([
      {
        repo: 'a/b',
        report: report([
          area({ open: 2, status: '2 open problems' }),
          area({ id: 'tests', label: 'Tests on main' }),
        ]),
      },
    ]);
    expect(lines).toEqual([
      { trend: 'same', text: 'Security: 2 open problems' },
      { trend: 'same', text: 'No change in Tests on main' },
    ]);
  });

  it('names the repository when there are several', () => {
    const lines = sinceLastWeek([
      {
        repo: 'a/one',
        report: report([area({ trend: 'worse', detail: 'x' })]),
      },
      { repo: 'a/two', report: report([area()]) },
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      'Security in a/one: x',
      '1 area in a/two unchanged',
    ]);
  });

  it('joins several quiet areas', () => {
    const lines = sinceLastWeek([
      {
        repo: 'a/b',
        report: report([
          area({ label: 'Security' }),
          area({ id: 'agent:dataagent', label: 'Data' }),
          area({ id: 'merging', label: 'Merging' }),
        ]),
      },
    ]);
    expect(lines).toEqual([
      { trend: 'same', text: 'No change in Security, Data and Merging' },
    ]);
  });

  it('has nothing to say without a report', () => {
    expect(sinceLastWeek([])).toEqual([]);
  });
});

describe('brokenRepos and repoVerdict', () => {
  const failing = report([
    area({
      id: 'tests',
      label: 'Tests on main',
      open: 1,
      status: 'Failing now',
    }),
  ]);

  it('finds the repositories whose tests on main are failing', () => {
    expect(
      brokenRepos([
        { repo: 'a/one', report: failing },
        { repo: 'a/two', report: report([area()]) },
      ])
    ).toEqual(['a/one']);
  });

  it('gives a verdict: failing tests, then decisions, then what got worse, else healthy', () => {
    expect(repoVerdict(failing)).toEqual({
      tone: 'critical',
      label: 'Tests are failing on main',
    });
    expect(repoVerdict(report([area()], { decisionsWaiting: 1 }))).toEqual({
      tone: 'warn',
      label: '1 decision for you',
    });
    expect(repoVerdict(report([area()], { decisionsWaiting: 3 }))).toEqual({
      tone: 'warn',
      label: '3 decisions for you',
    });
    expect(repoVerdict(report([area({ trend: 'worse' })]))).toEqual({
      tone: 'serious',
      label: 'Security got worse',
    });
    expect(
      repoVerdict(
        report([
          area({ trend: 'worse' }),
          area({ id: 'merging', label: 'Merging', trend: 'worse' }),
        ])
      )
    ).toEqual({ tone: 'serious', label: '2 areas got worse' });
    expect(repoVerdict(report([area()]))).toEqual({
      tone: 'good',
      label: 'Healthy',
    });
  });
});

const ev = (
  id: string,
  at: number,
  action: string,
  over: Partial<AuditEvent> = {}
): AuditEvent => ({
  id,
  at,
  actor: { kind: 'person', login: 'me', name: 'Me' },
  via: null,
  action,
  target: '#1',
  data: {},
  repo: 'a/b',
  pull: 1,
  ...over,
});

describe('isNotable and mergeActivity', () => {
  it('keeps what an owner cares about and drops the timeline noise', () => {
    expect(isNotable(ev('1', 1, 'pull.merged'))).toBe(true);
    expect(isNotable(ev('1', 1, 'finding.approved'))).toBe(true);
    expect(isNotable(ev('1', 1, 'merging.paused'))).toBe(true);
    expect(isNotable(ev('1', 1, 'pull.state_changed'))).toBe(false);
    expect(isNotable(ev('1', 1, 'pull.stacked'))).toBe(false);
    expect(isNotable(ev('1', 1, 'branch.deleted'))).toBe(false);
    expect(isNotable(ev('1', 1, 'pull.something_new'))).toBe(false);
  });

  it('merges several repositories newest first, once each, up to the limit', () => {
    const merged = mergeActivity(
      [
        [ev('a', 10, 'pull.merged'), ev('b', 30, 'pull.state_changed')],
        [ev('c', 20, 'finding.approved'), ev('a', 10, 'pull.merged')],
        [ev('d', 5, 'pull.reverted')],
      ],
      3
    );
    expect(merged.map((e) => e.id)).toEqual(['c', 'a', 'd']);
    expect(mergeActivity([[ev('a', 10, 'pull.merged')]], 0)).toEqual([]);
  });
});
