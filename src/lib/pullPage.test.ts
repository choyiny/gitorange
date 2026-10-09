import { describe, expect, it } from 'vitest';
import {
  canDeleteMergedBranch,
  etaText,
  fixerAttempts,
  nextStep,
  openQuestion,
  ordinal,
  participants,
  pullBlockers,
  pullChip,
  pullTab,
  queueLine,
  queueSpot,
  type NextStepInput,
} from './pullPage';
import type {
  AgentRun,
  PullState,
  QueueTarget,
  RebaseView,
  ReviewFlag,
  User,
} from './uiApi';

const person = (id: string): User => ({
  id,
  username: id,
  name: id.toUpperCase(),
  image: null,
});

const flag = (over: Partial<ReviewFlag> = {}): ReviewFlag => ({
  id: 'f1',
  kind: 'needs_person',
  title: 'Existing invoices become Canadian dollars',
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
  question: null,
  guarded: false,
  assignee: null,
  decidedVia: null,
  reason: null,
  teach: null,
  ...over,
});

const state = (
  s: PullState['state'],
  ...kinds: (string | Record<string, unknown>)[]
): PullState => ({
  state: s,
  reasons: kinds.map((k) => (typeof k === 'string' ? { kind: k } : k)) as {
    kind: string;
  }[],
});

const rebase = (over: Partial<RebaseView> = {}): RebaseView => ({
  status: 'up_to_date',
  onto: 'main',
  commit: null,
  files: [],
  error: null,
  ...over,
});

const input = (over: Partial<NextStepInput> = {}): NextStepInput => ({
  state: 'open',
  headRef: 'claude/s4-usd-invoices',
  baseRef: 'main',
  headBranchExists: true,
  pullState: state('ready'),
  rebase: rebase(),
  autoMerge: 'waiting',
  ...over,
});

const ctx = (over: Partial<Parameters<typeof nextStep>[1]> = {}) => ({
  blockers: [],
  question: null,
  coder: 'Claude Code',
  ...over,
});

describe('pullTab', () => {
  it('reads the conversation from no tab and the other tabs by name', () => {
    expect(pullTab(undefined)).toBe('conversation');
    expect(pullTab('')).toBe('conversation');
    expect(pullTab('commits')).toBe('commits');
    expect(pullTab('files')).toBe('files');
    expect(pullTab('checks')).toBe('checks');
  });
  it('refuses anything else', () => {
    expect(pullTab('conversation')).toBeNull();
    expect(pullTab('Files')).toBeNull();
    expect(pullTab('settings')).toBeNull();
  });
});

describe('ordinal', () => {
  it('says 1st, 2nd, 3rd and th, with the teens', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual(
      [
        '1st',
        '2nd',
        '3rd',
        '4th',
        '11th',
        '12th',
        '13th',
        '21st',
        '22nd',
        '23rd',
        '101st',
        '111th',
      ]
    );
  });
});

describe('etaText', () => {
  it('has no estimate without history', () => {
    expect(etaText(null)).toBeNull();
  });
  it('reads minutes and hours in plain words', () => {
    expect(etaText(0)).toBe('any minute now');
    expect(etaText(1)).toBe('about 1 min');
    expect(etaText(14)).toBe('about 14 min');
    expect(etaText(60)).toBe('about 1 h');
    expect(etaText(95)).toBe('about 1 h 35 min');
  });
});

describe('queueSpot and queueLine', () => {
  const entry = (n: number, position: number) => ({
    position,
    number: n,
    title: `#${n}`,
    author: { login: 'a', name: null, isAgent: false, color: null },
    createdVia: null,
    session: null,
    sessionId: 's-1',
    state: 'waiting',
    blockers: [],
    etaMinutes: position * 3,
  });
  const queue: QueueTarget[] = [
    { target: 'main', paused: null, entries: [entry(9, 1), entry(10, 2)] },
    { target: 'release', paused: null, entries: [entry(12, 1)] },
  ];
  it('finds the pull request in its target', () => {
    expect(queueSpot(queue, 10)).toMatchObject({
      target: 'main',
      total: 2,
      entry: { number: 10, position: 2 },
    });
    expect(queueSpot(queue, 12)?.target).toBe('release');
    expect(queueSpot(queue, 99)).toBeNull();
    expect(queueSpot(undefined, 10)).toBeNull();
  });
  it('says where it is in line', () => {
    expect(queueLine(queueSpot(queue, 9)!)).toBe(
      'First in line to land on main.'
    );
    expect(queueLine(queueSpot(queue, 10)!)).toBe(
      '2nd of 2 in line to land on main.'
    );
  });
});

describe('openQuestion', () => {
  const data = person('dataagent');
  it('finds the first open finding that asks a person a question', () => {
    const q = flag({ id: 'q', question: 'Were all your invoices in CAD?' });
    const found = openQuestion([
      { agent: person('securityagent'), flags: [flag({ id: 'x' })] },
      { agent: data, flags: [q] },
    ]);
    expect(found).toEqual({ agent: data, flag: q });
  });
  it('skips answered, refused and change-request findings', () => {
    expect(
      openQuestion([
        {
          agent: data,
          flags: [
            flag({ question: 'A?', approvedAt: '2026-10-08T00:00:00Z' }),
            flag({ question: 'B?', changesRequestedAt: '2026-10-08' }),
            flag({ question: 'C?', kind: 'change_requested' }),
          ],
        },
      ])
    ).toBeNull();
    expect(openQuestion(undefined)).toBeNull();
  });
});

describe('pullBlockers', () => {
  it('prefers the queue’s plain words', () => {
    expect(
      pullBlockers(state('waiting', 'checks_running'), [
        'The test check is running',
      ])
    ).toEqual(['The test check is running']);
  });
  it('falls back to the state’s blocking reasons, capitalised', () => {
    expect(
      pullBlockers(
        state(
          'human_review',
          { kind: 'agent_flagged', agent: 'dataagent', flags: [1] },
          { kind: 'stacked_on', pr: 9 }
        ),
        undefined
      )
    ).toEqual(['@dataagent flagged 1 finding for a person']);
    expect(pullBlockers(null, undefined)).toEqual([]);
  });
});

describe('nextStep', () => {
  it('says a merged or closed pull request is done', () => {
    expect(nextStep(input({ state: 'merged' }), ctx())).toEqual({
      tone: 'good',
      headline: 'Merged into main.',
      detail: null,
      listed: [],
    });
    expect(nextStep(input({ state: 'closed' }), ctx()).headline).toBe(
      'Closed without merging.'
    );
  });

  it('puts a missing branch first', () => {
    const s = nextStep(input({ headBranchExists: false, rebase: null }), ctx());
    expect(s.tone).toBe('critical');
    expect(s.headline).toBe(
      'The claude/s4-usd-invoices branch is gone, so this can’t merge.'
    );
  });

  it('explains a clash Fixer could not combine, and a branch GitOrange never rebases', () => {
    const clash = nextStep(
      input({
        rebase: rebase({ status: 'conflict', commit: 'abc1234def' }),
        pullState: state('agent_followup', 'rebase_conflict'),
      }),
      ctx({
        blockers: [
          'Clashes with newer changes in a.ts',
          'The test check failed',
        ],
      })
    );
    expect(clash.tone).toBe('serious');
    expect(clash.headline).toBe(
      'It clashes with newer changes on main, and Fixer couldn’t combine them.'
    );
    // The headline is the clash; only the rest is listed.
    expect(clash.listed).toEqual(['The test check failed']);
    const blocked = nextStep(
      input({
        rebase: rebase({
          status: 'conflict',
          error: 'Not rebased: release/* is protected',
        }),
      }),
      ctx()
    );
    expect(blocked.headline).toBe(
      'GitOrange doesn’t rebase this branch, and it is behind main.'
    );
    expect(blocked.detail).toBe('Not rebased: release/* is protected');
  });

  it('says Fixer is working while it resolves', () => {
    const s = nextStep(
      input({ rebase: rebase({ status: 'resolving' }) }),
      ctx({ blockers: ['GitOrange is fixing a clash', 'Lands after #9'] })
    );
    expect(s).toMatchObject({
      tone: 'info',
      headline: 'Fixer is combining it with newer changes on main.',
      listed: ['Lands after #9'],
    });
    // The state's own words (when the queue didn't load) are left out the same way.
    expect(
      nextStep(
        input({ rebase: rebase({ status: 'resolving' }) }),
        ctx({ blockers: ['AI is resolving conflicts'] })
      ).listed
    ).toEqual([]);
  });

  it('reads a ready pull request by its auto-merge', () => {
    expect(nextStep(input({ autoMerge: 'ready' }), ctx()).headline).toBe(
      'Ready. GitOrange is merging it now.'
    );
    expect(nextStep(input({ autoMerge: 'disabled' }), ctx()).headline).toBe(
      'Ready to merge. Auto-merge is off, so it waits for someone to merge it.'
    );
    expect(nextStep(input({ autoMerge: null }), ctx())).toMatchObject({
      tone: 'good',
      headline: 'Ready to merge.',
    });
  });

  it('says when only the pause holds it', () => {
    const s = nextStep(
      input({ pullState: state('waiting', 'merging_paused', 'stacked_on') }),
      ctx({ blockers: ['Merging is paused', 'Lands after #9'] })
    );
    expect(s.tone).toBe('warn');
    expect(s.headline).toBe(
      'Ready, but merging is paused. It merges once someone resumes merging.'
    );
    const more = nextStep(
      input({
        pullState: state('waiting', 'merging_paused', 'checks_running'),
      }),
      ctx({ blockers: ['Merging is paused', 'Tests are running'] })
    );
    expect(more.headline).toBe(
      'Merging is paused, and it is still waiting on other things.'
    );
    // The pause is the headline; only what else it waits on is listed.
    expect(more.listed).toEqual(['Tests are running']);
  });

  it('leads a wait with its first blocker', () => {
    const s = nextStep(
      input({ pullState: state('waiting', 'checks_running') }),
      ctx({ blockers: ['The test check is running', 'Lands after #9'] })
    );
    expect(s).toEqual({
      tone: 'info',
      headline: 'Waiting. The test check is running.',
      detail: null,
      listed: ['Lands after #9'],
    });
    expect(
      nextStep(input({ pullState: state('waiting') }), ctx()).headline
    ).toBe('Waiting.');
  });

  it('asks the owner’s question in its own words', () => {
    const s = nextStep(
      input({ pullState: state('human_review', 'agent_flagged') }),
      ctx({
        blockers: ['Data needs a person to decide 1 finding', 'Lands after #9'],
        question: {
          agent: 'Data',
          text: 'Were all your invoices so far in Canadian dollars?',
          assignee: null,
        },
      })
    );
    expect(s).toEqual({
      tone: 'warn',
      headline: 'Data asks: Were all your invoices so far in Canadian dollars?',
      detail: null,
      // The question says what Data waits on; only the other blockers are listed.
      listed: ['Lands after #9'],
    });
    expect(
      nextStep(
        input({ pullState: state('human_review') }),
        ctx({
          question: { agent: 'Data', text: 'Is it CAD?', assignee: 'Cho' },
        })
      ).headline
    ).toBe('Data asks Cho: Is it CAD?');
  });

  it('otherwise says what a person has to decide', () => {
    const s = nextStep(
      input({ pullState: state('human_review', 'needs_approval') }),
      ctx({ blockers: ['Needs a person to approve it'] })
    );
    expect(s).toMatchObject({
      tone: 'warn',
      headline: 'Needs a person to approve it.',
      listed: [],
    });
    expect(
      nextStep(input({ pullState: state('human_review') }), ctx()).headline
    ).toBe('Needs a person before it can merge.');
  });

  it('names who has to make changes', () => {
    const s = nextStep(
      input({ pullState: state('agent_followup', 'agent_changes_requested') }),
      ctx({ blockers: ['Security asked for 1 change'], coder: 'Codex' })
    );
    expect(s).toEqual({
      tone: 'serious',
      headline: 'Waiting for Codex to make changes.',
      detail: 'Security asked for 1 change.',
      listed: [],
    });
  });

  it('checks before it knows', () => {
    expect(nextStep(input({ pullState: null }), ctx()).headline).toBe(
      'Checking where it stands.'
    );
  });
});

describe('fixerAttempts', () => {
  const run = (id: string, at: string): AgentRun => ({
    id,
    kind: 'rebase',
    status: 'succeeded',
    title: `Rebase ${id}`,
    pullRequest: null,
    startedAt: at,
    finishedAt: null,
    error: null,
  });
  it('merges the kinds newest first, once each, at most five', () => {
    const a = [run('a', '2026-10-08T10:00:00Z'), run('b', '2026-10-08T08:00Z')];
    const b = [
      run('c', '2026-10-08T09:00:00Z'),
      run('a', '2026-10-08T10:00:00Z'),
    ];
    expect(fixerAttempts([a, b, undefined]).map((r) => r.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
    const many = Array.from({ length: 8 }, (_, i) =>
      run(`r${i}`, `2026-10-0${i + 1}T00:00:00Z`)
    );
    expect(fixerAttempts([many]).map((r) => r.id)).toEqual([
      'r7',
      'r6',
      'r5',
      'r4',
      'r3',
    ]);
  });
});

describe('participants', () => {
  it('lists the author, commenters and the merger once each', () => {
    const a = person('a');
    const b = person('b');
    const c = person('c');
    expect(
      participants({ author: a, mergedBy: c }, [
        { author: b },
        { author: a },
        { author: b },
      ]).map((u) => u.id)
    ).toEqual(['a', 'b', 'c']);
    expect(participants({ author: a, mergedBy: null }, []).length).toBe(1);
  });
});

describe('pullChip', () => {
  it('reads an open pull request by whose move it is', () => {
    expect(pullChip('open', state('human_review'))).toEqual({
      tone: 'warn',
      label: 'Requires human review',
    });
    expect(pullChip('open', state('waiting', 'merging_paused'))).toEqual({
      tone: 'info',
      label: 'Paused',
    });
    expect(pullChip('open', null)).toEqual({ tone: 'info', label: 'Open' });
  });
  it('reads merged and closed as they are', () => {
    expect(pullChip('merged', null)).toEqual({
      tone: 'merged',
      label: 'Merged',
    });
    expect(pullChip('closed', state('ready'))).toEqual({
      tone: 'off',
      label: 'Closed',
    });
  });
});

describe('canDeleteMergedBranch', () => {
  const branch = {
    name: 'feature',
    isProtected: false,
    mergedNotDeleted: true,
  };
  it('waits for the server to confirm the merged branch is safe to delete', () => {
    expect(canDeleteMergedBranch('feature', undefined)).toBe(false);
    expect(canDeleteMergedBranch('feature', branch)).toBe(true);
  });
  it('keeps protected, reused and advanced branches, including stale data for another branch', () => {
    expect(
      canDeleteMergedBranch('feature', { ...branch, isProtected: true })
    ).toBe(false);
    expect(
      canDeleteMergedBranch('feature', { ...branch, mergedNotDeleted: false })
    ).toBe(false);
    expect(canDeleteMergedBranch('other', branch)).toBe(false);
  });
});
