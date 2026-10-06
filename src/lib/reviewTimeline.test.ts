import { describe, expect, it } from 'vitest';
import {
  anchoredReviewer,
  earlierEntries,
  earlierVerb,
  reviewEntries,
  reviewTime,
  reviewVerb,
  slotOf,
  timelineSlots,
} from './reviewTimeline';
import type { ReviewerStatus } from './uiApi';

type R = {
  id: string;
  status: ReviewerStatus;
  requested: boolean;
  createdAt: string;
  finishedAt: string | null;
  flags: { approvedAt: string | null }[];
};
const r = (over: Partial<R> & { id: string }): R => ({
  status: 'approved',
  requested: true,
  createdAt: '2026-01-01T10:00:00Z',
  finishedAt: '2026-01-01T10:05:00Z',
  flags: [],
  ...over,
});
/** A reviewer the conversation shows (never `not_needed`). */
const shown = (
  over: Partial<R> & {
    id: string;
    status: Exclude<ReviewerStatus, 'not_needed'>;
  }
) => ({ ...r(over), status: over.status });
const flag = (approvedAt: string | null = null) => ({ approvedAt });

describe('reviewVerb', () => {
  it('reads like a person’s review', () => {
    expect(reviewVerb(shown({ id: 'a', status: 'approved' }))).toBe(
      'approved these changes'
    );
    expect(reviewVerb(shown({ id: 'a', status: 'changes_requested' }))).toBe(
      'requested changes'
    );
    expect(reviewVerb(shown({ id: 'a', status: 'reviewing' }))).toBe(
      'is reviewing…'
    );
    expect(reviewVerb(shown({ id: 'a', status: 'failed' }))).toBe(
      'couldn’t finish its review'
    );
  });
  it('counts only findings still waiting on a person', () => {
    expect(
      reviewVerb(shown({ id: 'a', status: 'flagged', flags: [flag()] }))
    ).toBe('flagged 1 finding for a person');
    expect(
      reviewVerb(
        shown({
          id: 'a',
          status: 'flagged',
          flags: [flag(), flag('x'), flag()],
        })
      )
    ).toBe('flagged 2 findings for a person');
  });
  it('says so once a person approved every finding', () => {
    expect(
      reviewVerb(shown({ id: 'a', status: 'flagged', flags: [flag('x')] }))
    ).toBe('flagged 1 finding, approved');
    expect(
      reviewVerb(
        shown({ id: 'a', status: 'flagged', flags: [flag('x'), flag('y')] })
      )
    ).toBe('flagged 2 findings, all approved');
  });
});

describe('reviewTime', () => {
  it('is the finish time, or the start while reviewing', () => {
    expect(reviewTime(r({ id: 'a' }))).toBe('2026-01-01T10:05:00Z');
    expect(
      reviewTime(r({ id: 'a', status: 'reviewing', finishedAt: null }))
    ).toBe('2026-01-01T10:00:00Z');
    expect(reviewTime(r({ id: 'a', finishedAt: null }))).toBe(
      '2026-01-01T10:00:00Z'
    );
  });
});

describe('reviewEntries', () => {
  it('keeps requested agents only, not cancelled ones', () => {
    const list = [
      r({ id: 'a' }),
      r({ id: 'b', requested: false, status: 'not_needed' }),
      r({ id: 'c', requested: true, status: 'not_needed' }),
      r({ id: 'd', status: 'reviewing' }),
    ];
    expect(reviewEntries(list).map((x) => x.id)).toEqual(['a', 'd']);
  });
});

describe('timelineSlots', () => {
  const c = (createdAt: string) => ({ createdAt });
  const e = (id: string, createdAt: string) => ({ id, createdAt });
  it('puts events and reviews between the comments they happened between, in time order', () => {
    const comments = [c('2026-01-01T09:00:00Z'), c('2026-01-01T11:00:00Z')];
    const events = [
      e('push1', '2026-01-01T08:00:00Z'),
      e('push2', '2026-01-01T10:30:00Z'),
    ];
    const reviews = [
      r({
        id: 'old',
        createdAt: '2026-01-01T08:01:00Z',
        finishedAt: '2026-01-01T08:10:00Z',
      }),
      r({
        id: 'new',
        createdAt: '2026-01-01T10:31:00Z',
        finishedAt: null,
        status: 'reviewing',
      }),
      r({
        id: 'late',
        createdAt: '2026-01-01T10:31:00Z',
        finishedAt: '2026-01-01T12:00:00Z',
      }),
    ];
    const slots = timelineSlots(comments, events, reviews);
    const ids = slots.map((s) =>
      s.map((x) => (x.kind === 'event' ? x.event.id : x.review.id))
    );
    expect(ids).toEqual([['push1', 'old'], ['push2', 'new'], ['late']]);
  });
  it('orders an event before a review at the same instant', () => {
    const slots = timelineSlots(
      [],
      [e('push', '2026-01-01T10:05:00Z')],
      [r({ id: 'a' })]
    );
    expect(slots).toHaveLength(1);
    expect(slots[0].map((x) => x.kind)).toEqual(['event', 'review']);
  });
  it('keeps the given order of events with no reviews', () => {
    const slots = timelineSlots(
      [c('2026-01-01T09:00:00Z')],
      [e('a', '2026-01-01T08:00:00Z'), e('b', '2026-01-01T08:00:00Z')],
      []
    );
    expect(slots[0].map((x) => (x.kind === 'event' ? x.event.id : ''))).toEqual(
      ['a', 'b']
    );
    expect(slots[1]).toEqual([]);
  });
});

describe("earlier commits' reviews", () => {
  const c = (createdAt: string) => ({ createdAt });
  const p = (
    id: string,
    finishedAt: string | null,
    status: ReviewerStatus = 'flagged'
  ) => ({
    id,
    headSha: 'abc1234',
    status,
    createdAt: '2026-01-01T07:00:00Z',
    finishedAt,
    flags: [flag()],
  });
  it('sit at their own time among comments, events and head reviews', () => {
    const slots = timelineSlots(
      [c('2026-01-01T09:00:00Z')],
      [{ id: 'push', createdAt: '2026-01-01T08:30:00Z' }],
      [r({ id: 'head' })],
      [p('old', '2026-01-01T08:00:00Z'), p('unfinished', null)]
    );
    const ids = slots.map((s) =>
      s.map((x) => `${x.kind}:${x.kind === 'event' ? x.event.id : x.review.id}`)
    );
    expect(ids).toEqual([
      ['earlier:unfinished', 'earlier:old', 'event:push'],
      ['review:head'],
    ]);
  });
  it('never anchor "Review the flags", even with findings left open', () => {
    const slots = timelineSlots(
      [],
      [],
      [r({ id: 'head' })],
      [p('old', '2026-01-01T08:00:00Z')]
    );
    expect(anchoredReviewer(slots)).toBe(null);
    const both = timelineSlots(
      [],
      [],
      [r({ id: 'head', flags: [flag()] })],
      [p('old', '2026-01-01T08:00:00Z')]
    );
    expect(anchoredReviewer(both)).toBe('head');
  });
  it('leave out cancelled ones', () => {
    expect(
      earlierEntries([
        p('a', null),
        p('b', null, 'not_needed'),
        p('c', null, 'failed'),
      ]).map((x) => x.id)
    ).toEqual(['a', 'c']);
  });
  it('count every finding, since none waits on anyone any more', () => {
    expect(earlierVerb({ status: 'flagged', flags: [flag(), flag('x')] })).toBe(
      'flagged 2 findings'
    );
    expect(earlierVerb({ status: 'approved', flags: [] })).toBe(
      'approved these changes'
    );
  });
});

describe('anchoredReviewer', () => {
  it('is the first review in timeline order with a finding waiting on a person', () => {
    const slots = timelineSlots(
      [c2('2026-01-01T10:02:00Z')],
      [],
      [
        r({
          id: 'done',
          flags: [flag('x')],
          finishedAt: '2026-01-01T10:01:00Z',
        }),
        r({ id: 'later', flags: [flag()], finishedAt: '2026-01-01T10:09:00Z' }),
        r({
          id: 'earlier',
          flags: [flag()],
          finishedAt: '2026-01-01T10:03:00Z',
        }),
      ]
    );
    expect(anchoredReviewer(slots)).toBe('earlier');
  });
  it('is null when nothing waits on a person', () => {
    expect(anchoredReviewer(timelineSlots([], [], [r({ id: 'a' })]))).toBe(
      null
    );
  });
});
function c2(createdAt: string) {
  return { createdAt };
}

describe('slotOf', () => {
  it('is the index of the first later comment, or after them all', () => {
    const comments = [{ createdAt: '2026-01-01T09:00:00Z' }];
    expect(slotOf(comments, '2026-01-01T08:00:00Z')).toBe(0);
    expect(slotOf(comments, '2026-01-01T09:00:00Z')).toBe(1);
    expect(slotOf([], '2026-01-01T08:00:00Z')).toBe(0);
  });
});
