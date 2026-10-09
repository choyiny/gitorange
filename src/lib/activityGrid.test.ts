import { describe, expect, it } from 'vitest';
import {
  activityGrid,
  activitySummary,
  activityTitle,
  levelOf,
} from './activityGrid';

/** `count` consecutive UTC days ending on `last` ('YYYY-MM-DD'), each with `reviews(i)` reviews. */
function days(
  last: string,
  count: number,
  reviews: (i: number) => number = () => 0
) {
  const end = Date.parse(`${last}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(end - (count - 1 - i) * 86_400_000)
      .toISOString()
      .slice(0, 10),
    reviews: reviews(i),
  }));
}

describe('levelOf', () => {
  it('is 0 for no reviews and scales the rest against the busiest day', () => {
    expect(levelOf(0, 8)).toBe(0);
    expect(levelOf(1, 8)).toBe(1);
    expect(levelOf(2, 8)).toBe(1);
    expect(levelOf(3, 8)).toBe(2);
    expect(levelOf(4, 8)).toBe(2);
    expect(levelOf(5, 8)).toBe(3);
    expect(levelOf(6, 8)).toBe(3);
    expect(levelOf(7, 8)).toBe(4);
    expect(levelOf(8, 8)).toBe(4);
  });
  it('gives any day with a review at least level 1, even next to a very busy one', () => {
    expect(levelOf(1, 1000)).toBe(1);
  });
  it('is 0 when nothing happened at all', () => {
    expect(levelOf(0, 0)).toBe(0);
  });
});

describe('activityGrid', () => {
  it('lays 182 days out in weeks of seven rows, Sunday first', () => {
    // 2026-10-08 is a Thursday.
    const grid = activityGrid(days('2026-10-08', 182));
    expect(grid.columns.every((c) => c.length === 7)).toBe(true);
    const cells = grid.columns.flat().filter((c) => c !== null);
    expect(cells).toHaveLength(182);
    // The last day sits in the Thursday row (index 4) of the last column; Friday and Saturday are beyond today.
    const last = grid.columns[grid.columns.length - 1];
    expect(last[4]).toMatchObject({ date: '2026-10-08' });
    expect(last[5]).toBeNull();
    expect(last[6]).toBeNull();
  });

  it('pads the first week above its first day and keeps days in order', () => {
    const grid = activityGrid(days('2026-10-08', 182));
    const first = grid.columns[0];
    const firstDay = first.find((c) => c !== null)!;
    // 182 days before Thu 8 Oct 2026 is Fri 10 Apr 2026: Friday is index 5, so Sunday to Thursday are empty.
    expect(firstDay.date).toBe('2026-04-10');
    expect(first.indexOf(firstDay)).toBe(5);
    expect(first.slice(0, 5).every((c) => c === null)).toBe(true);
    const dates = grid.columns.flat().flatMap((c) => (c ? [c.date] : []));
    expect(dates).toEqual([...dates].sort());
  });

  it('needs no padding when the range starts on a Sunday and ends on a Saturday', () => {
    // 2026-10-10 is a Saturday; 28 days back from it starts on a Sunday.
    const grid = activityGrid(days('2026-10-10', 28));
    expect(grid.columns).toHaveLength(4);
    expect(grid.columns.flat().every((c) => c !== null)).toBe(true);
  });

  it('counts the total and finds the busiest day', () => {
    const grid = activityGrid(
      days('2026-10-08', 10, (i) => (i === 3 ? 9 : i === 7 ? 2 : 0))
    );
    expect(grid.total).toBe(11);
    expect(grid.max).toBe(9);
    const busy = grid.columns.flat().find((c) => c?.reviews === 9);
    expect(busy?.level).toBe(4);
    const quiet = grid.columns.flat().find((c) => c?.reviews === 2);
    expect(quiet?.level).toBe(1);
    const none = grid.columns.flat().find((c) => c?.reviews === 0);
    expect(none?.level).toBe(0);
  });

  it('is empty for no days', () => {
    expect(activityGrid([])).toEqual({
      columns: [],
      months: [],
      max: 0,
      total: 0,
    });
  });

  it('labels the column where each month starts', () => {
    const grid = activityGrid(days('2026-10-08', 182));
    expect(grid.months.map((m) => m.label)).toEqual([
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
    ]);
    // Each label's column is in range and increasing.
    const cols = grid.months.map((m) => m.column);
    expect(cols).toEqual([...cols].sort((a, b) => a - b));
    expect(cols.every((c) => c >= 0 && c < grid.columns.length)).toBe(true);
    expect(cols[0]).toBe(0);
  });

  it('drops the first month label when it would crowd the next one', () => {
    // Sat 25 Apr to Wed 20 May: April has one column to itself before May starts two columns on.
    const grid = activityGrid(days('2026-05-20', 26));
    expect(grid.months.map((m) => m.label)).toEqual(['May']);
  });

  it('keeps the first month label when there is room for it', () => {
    // Sun 6 Sep to Wed 14 Oct: October starts four columns after September.
    const grid = activityGrid(days('2026-10-14', 39));
    expect(grid.months.map((m) => [m.label, m.column])).toEqual([
      ['Sep', 0],
      ['Oct', 4],
    ]);
  });
});

describe('activityTitle', () => {
  it('names the day and its reviews', () => {
    expect(activityTitle({ date: '2026-10-08', reviews: 3, level: 2 })).toBe(
      'Oct 8: 3 reviews'
    );
    expect(activityTitle({ date: '2026-10-08', reviews: 1, level: 1 })).toBe(
      'Oct 8: 1 review'
    );
    expect(activityTitle({ date: '2026-01-02', reviews: 0, level: 0 })).toBe(
      'Jan 2: no reviews'
    );
  });
});

describe('activitySummary', () => {
  it('says how much happened over how long, in words for a screen reader', () => {
    expect(activitySummary(182, 41)).toBe('41 reviews in the last 26 weeks');
    expect(activitySummary(182, 1)).toBe('1 review in the last 26 weeks');
    expect(activitySummary(182, 0)).toBe('No reviews in the last 26 weeks');
    expect(activitySummary(30, 5)).toBe('5 reviews in the last 30 days');
  });
});
