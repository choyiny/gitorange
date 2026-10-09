import { describe, expect, it } from 'vitest';
import {
  boardLanes,
  etaLine,
  etaText,
  laneChip,
  laneLabel,
  laneOf,
  LANE_ORDER,
  recentlyMerged,
  reviewersOf,
} from './pullBoard';
import type { Pull, PullReason, PullState, QueueTarget } from './uiApi';

const state = (
  name: PullState['state'],
  ...reasons: PullReason[]
): PullState => ({ state: name, reasons });

describe('laneOf', () => {
  it('puts each state in its lane', () => {
    expect(laneOf(state('human_review'))).toBe('needs');
    expect(laneOf(state('agent_followup'))).toBe('fixing');
    expect(laneOf(state('waiting'))).toBe('checking');
    expect(laneOf(state('ready'))).toBe('queued');
  });

  it('puts a pull request that only waits for merging to resume in the queue', () => {
    expect(
      laneOf(
        state('waiting', { kind: 'merging_paused' }, { kind: 'checks_running' })
      )
    ).toBe('queued');
  });

  it('keeps a person’s or an agent’s move in its own lane while paused', () => {
    expect(laneOf(state('human_review', { kind: 'merging_paused' }))).toBe(
      'needs'
    );
    expect(laneOf(state('agent_followup', { kind: 'merging_paused' }))).toBe(
      'fixing'
    );
  });

  it('checks a pull request whose state cannot be read', () => {
    expect(laneOf(null)).toBe('checking');
    expect(laneOf(undefined)).toBe('checking');
  });
});

describe('laneLabel', () => {
  it('reads the lane in words', () => {
    expect(laneLabel('needs', false)).toBe('Needs you');
    expect(laneLabel('fixing', false)).toBe('Being fixed');
    expect(laneLabel('checking', false)).toBe('Checking');
    expect(laneLabel('queued', false)).toBe('Queued');
  });

  it('calls the queue Paused while merging is paused', () => {
    expect(laneLabel('queued', true)).toBe('Paused');
    expect(laneLabel('needs', true)).toBe('Needs you');
  });

  it('lists the lanes in order', () => {
    expect(LANE_ORDER).toEqual(['needs', 'fixing', 'checking', 'queued']);
  });
});

describe('laneChip', () => {
  it('names the lane in the lane’s tone', () => {
    expect(laneChip(state('human_review'))).toEqual({
      lane: 'needs',
      label: 'Needs you',
      tone: 'warn',
    });
    expect(laneChip(state('agent_followup'))).toMatchObject({
      label: 'Being fixed',
      tone: 'serious',
    });
    expect(laneChip(state('waiting'))).toMatchObject({
      label: 'Checking',
      tone: 'info',
    });
    expect(laneChip(state('ready'))).toMatchObject({
      label: 'Queued',
      tone: 'good',
    });
  });

  it('says Paused for a pull request merging is paused on', () => {
    expect(
      laneChip(state('waiting', { kind: 'merging_paused' }))
    ).toMatchObject({ lane: 'queued', label: 'Paused', tone: 'off' });
    expect(
      laneChip(state('human_review', { kind: 'merging_paused' })).label
    ).toBe('Needs you');
  });

  it('calls a pull request without a state checking', () => {
    expect(laneChip(null).label).toBe('Checking');
  });
});

describe('reviewersOf', () => {
  it('reads each agent a reason names, in its state', () => {
    expect(
      reviewersOf(
        state(
          'human_review',
          {
            kind: 'agent_flagged',
            agent: 'dataagent',
            flags: [{ id: 'f', title: 'T' }],
          },
          {
            kind: 'agent_changes_requested',
            agent: 'securityagent',
            changes: [],
          },
          { kind: 'agent_reviewing', agent: 'speedagent' },
          { kind: 'agent_review_failed', agent: 'privacyagent', error: null }
        )
      )
    ).toEqual([
      { handle: 'dataagent', status: 'flagged' },
      { handle: 'securityagent', status: 'changes_requested' },
      { handle: 'speedagent', status: 'reviewing' },
      { handle: 'privacyagent', status: 'failed' },
    ]);
  });

  it('keeps the most urgent state when an agent appears twice', () => {
    expect(
      reviewersOf(
        state(
          'human_review',
          { kind: 'agent_reviewing', agent: 'dataagent' },
          { kind: 'agent_flagged', agent: 'dataagent', flags: [] }
        )
      )
    ).toEqual([{ handle: 'dataagent', status: 'flagged' }]);
  });

  it('skips a review that names no agent and reasons that are not reviews', () => {
    expect(
      reviewersOf(
        state(
          'waiting',
          { kind: 'agent_reviewing', agent: null },
          { kind: 'checks_running', check: null, started: true }
        )
      )
    ).toEqual([]);
    expect(reviewersOf(null)).toEqual([]);
  });
});

describe('etaText', () => {
  it('says nothing without an estimate', () => {
    expect(etaText(null)).toBeNull();
    expect(etaText(Number.NaN)).toBeNull();
  });

  it('reads minutes and hours', () => {
    expect(etaText(0)).toBe('under a minute');
    expect(etaText(1)).toBe('about 1 min');
    expect(etaText(4)).toBe('about 4 min');
    expect(etaText(60)).toBe('about 1 h');
    expect(etaText(95)).toBe('about 1 h 35 min');
  });
});

describe('etaLine', () => {
  it('says when a queued or checking pull request lands', () => {
    expect(etaLine('queued', 4, false)).toBe('Lands in about 4 min');
    expect(etaLine('checking', 20, false)).toBe('Lands in about 20 min');
  });

  it('says it only counts once a blocked one is unblocked', () => {
    expect(etaLine('needs', 6, false)).toBe('About 6 min once it is unblocked');
    expect(etaLine('fixing', 15, false)).toBe(
      'About 15 min once it is unblocked'
    );
  });

  it('says nothing when merging is paused or there is no estimate', () => {
    expect(etaLine('queued', 4, true)).toBeNull();
    expect(etaLine('queued', null, false)).toBeNull();
  });
});

const pull = (n: number, extra: Partial<Pull> = {}): Pull =>
  ({
    id: `p${n}`,
    number: n,
    title: `Pull ${n}`,
    state: 'open',
    author: { id: 'u', username: 'cho', name: 'Cho', image: null },
    headRef: `b${n}`,
    createdVia: null,
    sessionLabel: null,
    sessionId: 's-x',
    commentCount: 0,
    createdAt: '2026-10-08T10:00:00.000Z',
    mergedAt: null,
    pullState: state('ready'),
    ...extra,
  }) as Pull;

const target = (
  entries: Partial<QueueTarget['entries'][number]>[],
  paused: QueueTarget['paused'] = null
): QueueTarget => ({
  target: 'main',
  paused,
  entries: entries.map((e, i) => ({
    position: i + 1,
    number: 0,
    title: '',
    author: { login: 'cho', name: 'Cho', isAgent: false, color: null },
    createdVia: null,
    session: null,
    sessionId: 's-x',
    state: 'ready',
    blockers: [],
    etaMinutes: null,
    ...e,
  })),
});

describe('boardLanes', () => {
  it('sorts open pull requests into lanes, in landing order', () => {
    const open = [
      pull(11, {
        pullState: state('waiting', {
          kind: 'checks_running',
          check: null,
          started: true,
        }),
      }),
      pull(10, { pullState: state('ready') }),
      pull(12, { pullState: state('human_review') }),
      pull(13, { pullState: state('agent_followup') }),
      pull(14, { pullState: state('ready') }),
    ];
    const queue = [
      target([
        { number: 10, position: 1 },
        { number: 14, position: 2 },
        { number: 11, position: 3 },
        { number: 12, position: 4 },
        { number: 13, position: 5 },
      ]),
    ];
    const { lanes, paused } = boardLanes(open, queue);
    expect(paused).toBe(false);
    expect(lanes.needs.map((c) => c.pull.number)).toEqual([12]);
    expect(lanes.fixing.map((c) => c.pull.number)).toEqual([13]);
    expect(lanes.checking.map((c) => c.pull.number)).toEqual([11]);
    expect(lanes.queued.map((c) => c.pull.number)).toEqual([10, 14]);
  });

  it('orders pull requests the queue does not list after the ones it does, oldest first', () => {
    const open = [
      pull(20, { createdAt: '2026-10-08T12:00:00.000Z' }),
      pull(21, { createdAt: '2026-10-08T09:00:00.000Z' }),
      pull(22, { createdAt: '2026-10-08T11:00:00.000Z' }),
    ];
    const { lanes } = boardLanes(open, [target([{ number: 22, position: 1 }])]);
    expect(lanes.queued.map((c) => c.pull.number)).toEqual([22, 21, 20]);
  });

  it('uses the queue’s blocker, and says how many more there are', () => {
    const open = [pull(10, { pullState: state('human_review') })];
    const queue = [
      target([
        {
          number: 10,
          blockers: [
            'Data needs a person to decide 1 finding',
            'Lands after #9',
            'Tests are running',
          ],
        },
      ]),
    ];
    const card = boardLanes(open, queue).lanes.needs[0];
    expect(card.blocker.text).toBe('Data needs a person to decide 1 finding');
    expect(card.blocker.more).toEqual(['Lands after #9', 'Tests are running']);
  });

  it('says what a ready pull request waits for, which is nothing', () => {
    const open = [pull(10), pull(11)];
    const queue = [target([{ number: 10 }, { number: 11 }])];
    const [first, second] = boardLanes(open, queue).lanes.queued;
    expect(first.blocker.text).toBe(
      'Nothing is holding it back. It lands next.'
    );
    expect(second.blocker.text).toBe('Nothing is holding it back.');
  });

  it('falls back to the pull request’s own reason without a queue', () => {
    const open = [
      pull(10, {
        pullState: state('agent_followup', {
          kind: 'check_failed',
          run_number: 7,
          check: 'test (pulls)',
        }),
      }),
    ];
    const card = boardLanes(open, []).lanes.fixing[0];
    expect(card.blocker.text).toBe('The "test (pulls)" check failed (run #7)');
    expect(card.position).toBeNull();
  });

  it('shows the reviewers a reason names and the estimate', () => {
    const open = [
      pull(10, {
        pullState: state('human_review', {
          kind: 'agent_flagged',
          agent: 'dataagent',
          flags: [],
        }),
      }),
    ];
    const card = boardLanes(open, [
      target([{ number: 10, etaMinutes: 6, blockers: ['x'] }]),
    ]).lanes.needs[0];
    expect(card.reviewers).toEqual([
      { handle: 'dataagent', status: 'flagged' },
    ]);
    expect(card.eta).toBe('About 6 min once it is unblocked');
  });

  it('notes what it is stacked on or waits on, unless the blocker says so', () => {
    const open = [
      pull(11, {
        pullState: state('ready', { kind: 'stacked_on', pr: 10 }),
      }),
      pull(12, {
        pullState: state(
          'human_review',
          { kind: 'agent_flagged', agent: 'dataagent', flags: [] },
          { kind: 'waits_on', pr: 9 }
        ),
      }),
    ];
    const queue = [
      target([
        { number: 11, blockers: ['Lands after #10'] },
        {
          number: 12,
          blockers: ['Data needs a person to decide 1 finding', 'Waits on #9'],
        },
      ]),
    ];
    const { lanes } = boardLanes(open, queue);
    expect(lanes.queued[0].notes).toEqual([]);
    expect(lanes.needs[0].notes).toEqual(['Waits on #9']);
  });

  it('reports merging as paused from the queue or from the pull requests', () => {
    const paused = {
      at: 1,
      by: { login: 'cho', name: 'Cho', isAgent: false, color: null },
    };
    const open = [
      pull(10, {
        pullState: state('waiting', { kind: 'merging_paused' }),
      }),
    ];
    const viaQueue = boardLanes(open, [target([{ number: 10 }], paused)]);
    expect(viaQueue.paused).toBe(true);
    expect(viaQueue.lanes.queued.map((c) => c.pull.number)).toEqual([10]);
    expect(boardLanes(open, []).paused).toBe(true);
    expect(boardLanes([pull(10)], []).paused).toBe(false);
  });

  it('drops the estimate while paused', () => {
    const paused = {
      at: 1,
      by: { login: 'cho', name: 'Cho', isAgent: false, color: null },
    };
    const open = [
      pull(10, { pullState: state('waiting', { kind: 'merging_paused' }) }),
    ];
    const card = boardLanes(open, [
      target([{ number: 10, etaMinutes: 4 }], paused),
    ]).lanes.queued[0];
    expect(card.eta).toBeNull();
  });
});

describe('recentlyMerged', () => {
  const merged = (
    n: number,
    at: string | null,
    state: Pull['state'] = 'merged'
  ) => pull(n, { state, mergedAt: at });

  it('lists the newest merges first and leaves out closed ones', () => {
    const list = [
      merged(1, '2026-10-01T10:00:00.000Z'),
      merged(2, '2026-10-03T10:00:00.000Z'),
      merged(3, null, 'closed'),
      merged(4, '2026-10-02T10:00:00.000Z'),
    ];
    expect(recentlyMerged(list).map((p) => p.number)).toEqual([2, 4, 1]);
  });

  it('keeps only the newest few', () => {
    const list = Array.from({ length: 9 }, (_, i) =>
      merged(i + 1, `2026-10-0${i + 1}T10:00:00.000Z`)
    );
    expect(recentlyMerged(list, 5).map((p) => p.number)).toEqual([
      9, 8, 7, 6, 5,
    ]);
  });
});
