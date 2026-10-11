import { describe, expect, it } from 'vitest';
import {
  areaKind,
  areaSpark,
  clientMark,
  contributorLine,
  decisionCopy,
  healthLede,
  noReviewersBody,
  notReviewing,
  pickDecision,
  reviewerRecord,
  reviewerState,
  TREND_LOOK,
  weekLabels,
} from './health';
import type {
  Agent,
  AgentStats,
  ApprovalItem,
  HealthArea,
  HealthReport,
  ReviewFlag,
} from './uiApi';

const area = (over: Partial<HealthArea> = {}): HealthArea => ({
  id: 'agent:dataagent',
  label: 'Data',
  color: '#199e70',
  agent: 'dataagent',
  thisWeek: 3,
  lastWeek: 1,
  weeks: [0, 1, 0, 2, 1, 0, 1, 3],
  trend: 'worse',
  status: '2 open problems',
  detail: '3 raised this week, 2 more than last week',
  open: 2,
  ...over,
});

const report = (over: Partial<HealthReport> = {}): HealthReport => ({
  summary: 'Nothing got worse this week.',
  decisionsWaiting: 0,
  areas: [],
  contributors: [],
  ...over,
});

describe('areaKind', () => {
  it('tells agent rows from the two built-in rows', () => {
    expect(areaKind(area())).toBe('agent');
    expect(areaKind(area({ id: 'tests', agent: null }))).toBe('tests');
    expect(areaKind(area({ id: 'merging', agent: null }))).toBe('merging');
  });
});

describe('TREND_LOOK', () => {
  it('has words and a tone for every trend, so colour is never the only signal', () => {
    expect(TREND_LOOK.better).toEqual({ label: 'Better', tone: 'good' });
    expect(TREND_LOOK.same).toEqual({ label: 'Same', tone: 'off' });
    expect(TREND_LOOK.worse).toEqual({ label: 'Worse', tone: 'serious' });
  });
});

describe('weekLabels', () => {
  it('names the eight weeks oldest first, ending with this week', () => {
    expect(weekLabels(8)).toEqual([
      '7 weeks ago',
      '6 weeks ago',
      '5 weeks ago',
      '4 weeks ago',
      '3 weeks ago',
      '2 weeks ago',
      'Last week',
      'This week',
    ]);
  });
  it('copes with a different number of weeks', () => {
    expect(weekLabels(2)).toEqual(['Last week', 'This week']);
    expect(weekLabels(1)).toEqual(['This week']);
    expect(weekLabels(0)).toEqual([]);
  });
});

describe('areaSpark', () => {
  it('charts an agent by findings raised', () => {
    const s = areaSpark(area());
    expect(s.values).toEqual([0, 1, 0, 2, 1, 0, 1, 3]);
    expect(s.unit).toBe(' raised');
    expect(s.label).toBe('Data, findings raised, last 8 weeks');
    expect(s.labels).toHaveLength(8);
    expect(s.trend).toBe('worse');
  });

  it('titles the tests row as failures, never as a pass rate', () => {
    const s = areaSpark(
      area({
        id: 'tests',
        agent: null,
        label: 'Tests on main',
        weeks: [0, 0, 10, 0, 0, 0, 0, 20],
        trend: 'worse',
      })
    );
    expect(s.unit).toBe('% of runs failed');
    expect(s.label).toBe(
      'Tests on main, share of runs that failed, last 8 weeks'
    );
    expect(`${s.label} ${s.unit}`).not.toMatch(/pass/i);
  });

  it('charts merging by reverts', () => {
    const s = areaSpark(
      area({ id: 'merging', agent: null, label: 'Merging', weeks: [0, 1] })
    );
    expect(s.unit).toBe(' reverted');
    expect(s.label).toBe('Merging, reverts, last 2 weeks');
    expect(s.labels).toEqual(['Last week', 'This week']);
  });
});

describe('areaSpark gaps', () => {
  const tests = (over: Partial<HealthArea> = {}) =>
    area({
      id: 'tests',
      agent: null,
      label: 'Tests on main',
      weeks: [0, 0, 0, 0, 25, 0, 0, 50],
      noRuns: [true, true, true, true, false, true, true, false],
      trend: 'worse',
      ...over,
    });

  it('draws the weeks with no test runs as gaps, with a tooltip that says so', () => {
    const s = areaSpark(tests());
    expect(s.missing).toEqual([
      true,
      true,
      true,
      true,
      false,
      true,
      true,
      false,
    ]);
    expect(s.missingText).toBe('no test runs');
    // The numbers are unchanged: a gap week keeps its 0 in `values`, it is the flag that says it is not a measurement.
    expect(s.values).toEqual([0, 0, 0, 0, 25, 0, 0, 50]);
    expect(s.label).toContain('weeks with no test runs are gaps');
  });

  it('draws no gaps when every week had runs, when the API sent none, or off the tests row', () => {
    expect(
      areaSpark(tests({ noRuns: Array(8).fill(false) })).missing
    ).toBeUndefined();
    expect(areaSpark(tests({ noRuns: undefined })).missing).toBeUndefined();
    expect(areaSpark(tests({ noRuns: undefined })).label).not.toContain('gaps');
    // Only the tests row has gaps, whatever another row carries.
    expect(
      areaSpark(area({ noRuns: Array(8).fill(true) })).missing
    ).toBeUndefined();
  });

  it('ignores a noRuns list that does not line up with the weeks', () => {
    expect(areaSpark(tests({ noRuns: [true, false] })).missing).toBeUndefined();
  });
});

describe('healthLede', () => {
  it('leads with the summary, then what waits and what is open', () => {
    expect(healthLede(report({ decisionsWaiting: 1 }), 6)).toBe(
      'Nothing got worse this week. 1 decision needs you. 6 pull requests open.'
    );
  });
  it('says nothing about decisions when none wait, and handles one or none open', () => {
    expect(healthLede(report(), 1)).toBe(
      'Nothing got worse this week. 1 pull request open.'
    );
    expect(healthLede(report({ summary: 'Data got worse.' }), 0)).toBe(
      'Data got worse. No pull requests open.'
    );
    expect(healthLede(report({ decisionsWaiting: 3 }), 2)).toContain(
      '3 decisions need you.'
    );
  });
});

const flag = (over: Partial<ReviewFlag> = {}): ReviewFlag => ({
  id: 'f1',
  kind: 'needs_person',
  title: 'Invoices change currency',
  paths: ['src/invoices.ts'],
  detail: null,
  detailModel: null,
  agentSha: null,
  approvedBy: null,
  approvedAt: null,
  approvedVia: null,
  changesRequestedBy: null,
  changesRequestedAt: null,
  changesRequestedNote: null,
  question: null,
  guarded: false,
  assignee: null,
  decidedVia: null,
  reason: null,
  teach: null,
  ...over,
});

const item = (
  fullName: string,
  number: number,
  flags: ReviewFlag[],
  agentName = 'Data'
): ApprovalItem => ({
  repo: { fullName, name: fullName.split('/')[1] },
  pull: {
    number,
    title: `Pull ${number}`,
    author: null,
    updatedAt: '2026-10-08T10:00:00.000Z',
    headSha: 'a'.repeat(40),
    createdVia: null,
    sessionLabel: null,
    sessionId: 'sess-1',
  },
  reviewFailed: null,
  resolutionFailed: null,
  needsApproval: false,
  agents: [
    {
      reviewerId: `rv-${number}`,
      agent: {
        id: 'u',
        username: `${agentName.toLowerCase()}agent`,
        name: agentName,
        image: null,
      },
      status: 'flagged',
      error: null,
      flags,
    },
  ],
  pullState: null,
  stackStale: [],
  stackUnchecked: [],
});

describe('pickDecision', () => {
  it('finds nothing in other repositories or when there are no items', () => {
    expect(pickDecision([], 'o/r')).toBeNull();
    expect(pickDecision([item('o/other', 1, [flag()])], 'o/r')).toBeNull();
  });

  it('matches the repository without regard to case', () => {
    const d = pickDecision([item('O/R', 4, [flag()])], 'o/r');
    expect(d?.flag.id).toBe('f1');
    expect(d?.pull.number).toBe(4);
  });

  it('prefers a question for the owner over an ordinary finding', () => {
    const d = pickDecision(
      [
        item('o/r', 1, [flag({ id: 'plain' })]),
        item('o/r', 2, [flag({ id: 'ask', question: 'Is this right?' })]),
      ],
      'o/r'
    );
    expect(d?.flag.id).toBe('ask');
  });

  it('skips findings somebody already decided and change requests', () => {
    expect(
      pickDecision(
        [
          item('o/r', 1, [
            flag({ id: 'done', approvedAt: '2026-10-08T00:00:00.000Z' }),
            flag({
              id: 'asked',
              changesRequestedAt: '2026-10-08T00:00:00.000Z',
            }),
            flag({ id: 'cr', kind: 'change_requested' }),
          ]),
        ],
        'o/r'
      )
    ).toBeNull();
  });
});

describe('decisionCopy', () => {
  const row = (f: ReviewFlag) => pickDecision([item('o/r', 7, [f])], 'o/r')!;

  it('puts an owner question in plain words', () => {
    const c = decisionCopy(
      row(
        flag({
          question: 'Were all your invoices in Canadian dollars?',
          detail: 'The change will mark 1,284 invoices as Canadian dollars.',
        })
      )
    );
    expect(c.from).toBe('Data is asking');
    expect(c.title).toBe('Were all your invoices in Canadian dollars?');
    expect(c.body).toBe(
      'The change will mark 1,284 invoices as Canadian dollars.'
    );
  });

  it('uses the finding title when the agent asked no question', () => {
    const c = decisionCopy(row(flag()));
    expect(c.from).toBe('Data wants a person to decide');
    expect(c.title).toBe('Invoices change currency');
    expect(c.body).toBeNull();
  });
});

describe('contributorLine', () => {
  const c = (over: Partial<HealthReport['contributors'][number]> = {}) => ({
    who: {
      kind: 'person' as const,
      label: 'Cho',
      login: 'cho',
      client: null,
      sessionId: 's-0123456789',
    },
    merged: 4,
    findings: 0,
    note: null,
    trend: 'same' as const,
    ...over,
  });

  it('says nothing got worse when reviewers raised nothing', () => {
    expect(contributorLine(c())).toEqual({
      text: 'Nothing got worse',
      detail: 'No findings from your reviewers',
      dir: 'same',
    });
  });

  it('marks fewer findings as better', () => {
    expect(contributorLine(c({ trend: 'better' }))).toEqual({
      text: 'Nothing got worse',
      detail: 'No findings this week, fewer than last week',
      dir: 'better',
    });
  });

  it('shows the note and compares with last week when findings were raised', () => {
    expect(
      contributorLine(
        c({ findings: 2, note: '2 findings, most on #74', trend: 'worse' })
      )
    ).toEqual({
      text: '2 findings, most on #74',
      detail: 'More than last week',
      dir: 'worse',
    });
    expect(contributorLine(c({ findings: 1, trend: 'same' }))).toEqual({
      text: '1 finding',
      detail: 'Same as last week',
      dir: 'same',
    });
    expect(contributorLine(c({ findings: 3, trend: 'better' })).detail).toBe(
      'Fewer than last week'
    );
  });
});

describe('clientMark', () => {
  it('takes the first letter of the app; Codex is an X drawn as an outline', () => {
    expect(clientMark('Claude Code')).toEqual({ mark: 'C', codex: false });
    expect(clientMark('Codex')).toEqual({ mark: 'X', codex: true });
    expect(clientMark('  cursor')).toEqual({ mark: 'C', codex: false });
  });
  it('has a placeholder for a missing name', () => {
    expect(clientMark(null)).toEqual({ mark: '?', codex: false });
    expect(clientMark('')).toEqual({ mark: '?', codex: false });
  });
});

describe('reviewer record and state', () => {
  const stats = (over: Partial<AgentStats> = {}): AgentStats => ({
    handle: 'dataagent',
    raised: 12,
    kept: 8,
    dismissed: 2,
    keptPct: 80,
    rules: 3,
    reviews: 30,
    byDay: [],
    bestCatch: null,
    repos: [
      { repo: 'O/R', status: 'flagged', number: 9 },
      { repo: 'o/other', status: 'approved', number: 2 },
    ],
    ...over,
  });

  it('writes the record from this week and the overall numbers', () => {
    expect(reviewerRecord(area(), stats())).toBe(
      '3 raised this week · 80% kept overall · 3 rules learned overall'
    );
  });

  it('uses singular forms and leaves out what is not known', () => {
    expect(
      reviewerRecord(area({ thisWeek: 1 }), stats({ keptPct: null, rules: 1 }))
    ).toBe('1 raised this week · 1 rule learned overall');
  });

  it('still says something when only one source loaded', () => {
    expect(reviewerRecord(area({ thisWeek: 0 }), undefined)).toBe(
      'Nothing raised this week'
    );
    expect(reviewerRecord(undefined, stats())).toBe(
      '80% kept overall · 3 rules learned overall'
    );
    expect(reviewerRecord(undefined, undefined)).toBeNull();
  });

  it('reads the state from what the agent is doing in this repository', () => {
    expect(reviewerState(stats(), 'o/r')).toBe('flagged');
    expect(reviewerState(stats(), 'o/other')).toBe('approved');
    expect(reviewerState(stats(), 'o/none')).toBe('idle');
    expect(reviewerState(undefined, 'o/r')).toBeNull();
  });
});

describe('notReviewing', () => {
  const agent = (username: string, deletedAt: string | null = null) =>
    ({
      id: `id-${username}`,
      username,
      name: username,
      image: null,
      deletedAt,
    }) as unknown as Agent;

  it('lists the agents that exist but are not on this repository, skipping deleted ones', () => {
    const all = [
      agent('dataagent'),
      agent('securityagent'),
      agent('gone', '2026-01-01'),
    ];
    expect(
      notReviewing(all, [{ username: 'DataAgent' }]).map((a) => a.username)
    ).toEqual(['securityagent']);
  });
});

describe('noReviewersBody', () => {
  it('tells an admin to add one and anyone else who can', () => {
    expect(noReviewersBody({ admin: true, available: 3 })).toBe(
      'Reviewers look at each change before it merges. Add one below.'
    );
    const other = noReviewersBody({ admin: false, available: 3 });
    expect(other).toBe(
      'Reviewers look at each change before it merges. An admin of this repository can add one.'
    );
    expect(other).not.toMatch(/below/i);
  });

  it('points at Agents when there is nothing to add, for everyone', () => {
    for (const admin of [true, false])
      expect(noReviewersBody({ admin, available: 0 })).toBe(
        'Reviewers look at each change before it merges. A site admin can create them from Agents.'
      );
  });
});
