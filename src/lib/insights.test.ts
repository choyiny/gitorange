import { describe, expect, it } from 'vitest';
import {
  barWidths,
  of,
  parsePeriod,
  pct,
  PERIOD_OPTIONS,
  rangeText,
  span,
} from './insights';

describe('parsePeriod', () => {
  it('accepts the four periods and defaults to 30 days', () => {
    expect(parsePeriod('7')).toBe(7);
    expect(parsePeriod('30')).toBe(30);
    expect(parsePeriod('90')).toBe(90);
    expect(parsePeriod('365')).toBe(365);
    expect(parsePeriod(null)).toBe(30);
    expect(parsePeriod('14')).toBe(30);
    expect(parsePeriod('abc')).toBe(30);
  });
  it('lists the periods with their words', () => {
    expect(PERIOD_OPTIONS.map((o) => o.label)).toEqual([
      '1 week',
      '1 month',
      '3 months',
      '1 year',
    ]);
    expect(PERIOD_OPTIONS.map((o) => o.value)).toEqual([
      '7',
      '30',
      '90',
      '365',
    ]);
  });
});

describe('numbers', () => {
  it('shows a share as a percentage, or a dash when there is none', () => {
    expect(pct(0.84)).toBe('84%');
    expect(pct(1)).toBe('100%');
    expect(pct(0)).toBe('0%');
    expect(pct(null)).toBe('—');
  });
  it('shows a span of seconds, or a dash', () => {
    expect(span(null)).toBe('—');
    expect(span(45)).toBe('45s');
    expect(span(720)).toBe('12m');
  });
  it('divides without dividing by zero', () => {
    expect(of(3, 4)).toBe(0.75);
    expect(of(0, 0)).toBeNull();
  });
});

describe('barWidths', () => {
  it('scales raised against the busiest reviewer and approved against raised', () => {
    expect(barWidths(42, 19, 42)).toEqual({
      raised: 100,
      approved: (19 / 42) * 100,
    });
    expect(barWidths(21, 21, 42)).toEqual({ raised: 50, approved: 100 });
  });
  it('is empty when nothing was raised', () => {
    expect(barWidths(0, 0, 42)).toEqual({ raised: 0, approved: 0 });
    expect(barWidths(0, 0, 0)).toEqual({ raised: 0, approved: 0 });
  });
  it('never exceeds the track', () => {
    expect(barWidths(5, 9, 5)).toEqual({ raised: 100, approved: 100 });
  });
});

describe('rangeText', () => {
  it('writes the period as a date range', () => {
    expect(
      rangeText('2026-10-01T00:00:00.000Z', '2026-10-08T00:00:00.000Z')
    ).toBe('Oct 1, 2026 – Oct 8, 2026');
  });
  it('is empty before the data arrives', () => {
    expect(rangeText(undefined, undefined)).toBe('');
  });
});
