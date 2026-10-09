import { describe, expect, it } from 'vitest';
import {
  sessionLede,
  sessionName,
  sessionTimeline,
  type TimelinePull,
} from './sessionPage';
import type { PersonRef } from './uiApi';

const mahmoud: PersonRef = {
  login: 'mahmoud',
  name: 'Mahmoud H.',
  isAgent: false,
  color: null,
};

describe('sessionName', () => {
  it('names an app’s session by the app and its label', () => {
    expect(
      sessionName({ client: 'Claude Code', label: 's4', author: mahmoud })
    ).toBe('Claude Code · s4');
    expect(sessionName({ client: 'Codex', label: null, author: mahmoud })).toBe(
      'Codex'
    );
  });
  it('names pull requests opened by hand after their author', () => {
    expect(sessionName({ client: null, label: null, author: mahmoud })).toBe(
      'Mahmoud H. by hand'
    );
    expect(
      sessionName({
        client: null,
        label: null,
        author: { ...mahmoud, name: null },
      })
    ).toBe('mahmoud by hand');
  });
});

describe('sessionLede', () => {
  it('says whose session it is and how big', () => {
    expect(
      sessionLede({ client: 'Claude Code', author: mahmoud, pulls: [1, 2] })
    ).toBe('Claude Code session for Mahmoud H. · 2 pull requests');
    expect(sessionLede({ client: null, author: mahmoud, pulls: [1] })).toBe(
      'Opened by hand by Mahmoud H. · 1 pull request'
    );
  });
});

describe('sessionTimeline', () => {
  const pull = (over: Partial<TimelinePull>): TimelinePull => ({
    number: 1,
    title: 'One',
    state: 'open',
    sessionId: 's-a',
    createdAt: '2026-10-07T10:00:00.000Z',
    mergedAt: null,
    closedAt: null,
    mergedBy: null,
    mergedAutomatically: false,
    ...over,
  });

  it('keeps the session’s own pull requests, oldest first', () => {
    const events = sessionTimeline(
      [
        pull({
          number: 11,
          title: 'PDF',
          createdAt: '2026-10-07T12:00:00.000Z',
        }),
        pull({ number: 9, sessionId: 's-other' }),
        pull({
          number: 10,
          title: 'USD',
          createdAt: '2026-10-07T11:00:00.000Z',
          state: 'merged',
          mergedAt: '2026-10-08T09:00:00.000Z',
          closedAt: '2026-10-08T09:00:00.000Z',
          mergedAutomatically: true,
        }),
      ],
      's-a'
    );
    expect(events).toEqual([
      {
        at: Date.parse('2026-10-07T11:00:00.000Z'),
        kind: 'opened',
        number: 10,
        title: 'USD',
        actor: null,
        automatic: false,
      },
      {
        at: Date.parse('2026-10-07T12:00:00.000Z'),
        kind: 'opened',
        number: 11,
        title: 'PDF',
        actor: null,
        automatic: false,
      },
      {
        at: Date.parse('2026-10-08T09:00:00.000Z'),
        kind: 'merged',
        number: 10,
        title: 'USD',
        actor: null,
        automatic: true,
      },
    ]);
  });

  it('records who merged it, and a close without a merge', () => {
    const events = sessionTimeline(
      [
        pull({
          number: 3,
          state: 'merged',
          mergedAt: '2026-10-07T11:00:00.000Z',
          closedAt: '2026-10-07T11:00:00.000Z',
          mergedBy: { username: 'cho' },
        }),
        pull({
          number: 4,
          state: 'closed',
          closedAt: '2026-10-07T12:00:00.000Z',
        }),
      ],
      's-a'
    );
    expect(events.map((e) => [e.kind, e.number, e.actor])).toEqual([
      ['opened', 3, null],
      ['opened', 4, null],
      ['merged', 3, 'cho'],
      ['closed', 4, null],
    ]);
  });

  it('orders events at the same moment by pull request, opening first', () => {
    const at = '2026-10-07T10:00:00.000Z';
    const events = sessionTimeline(
      [
        pull({ number: 6, createdAt: at }),
        pull({
          number: 5,
          createdAt: at,
          state: 'closed',
          closedAt: at,
        }),
      ],
      's-a'
    );
    expect(events.map((e) => `${e.kind} #${e.number}`)).toEqual([
      'opened #5',
      'closed #5',
      'opened #6',
    ]);
  });
});
