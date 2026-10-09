/** Repository Insights: the period, how numbers read and how the reviewer bars are drawn. */
import { dayLabel, spanOf } from './format';
import { INSIGHT_PERIODS } from './uiApi';

export type Period = (typeof INSIGHT_PERIODS)[number];

const PERIOD_LABEL: Record<Period, string> = {
  7: '1 week',
  30: '1 month',
  90: '3 months',
  365: '1 year',
};

export const PERIOD_OPTIONS: { value: string; label: string }[] =
  INSIGHT_PERIODS.map((d) => ({ value: String(d), label: PERIOD_LABEL[d] }));

/** `?days=` as a period; anything else is the default, 30 days. */
export function parsePeriod(raw: string | null): Period {
  const asked = Number(raw);
  return (INSIGHT_PERIODS as readonly number[]).includes(asked)
    ? (asked as Period)
    : 30;
}

export const pct = (x: number | null): string =>
  x === null ? '—' : `${Math.round(x * 100)}%`;

export const span = (s: number | null): string =>
  s === null ? '—' : spanOf(s);

/** `a / b`, or null when `b` is zero. */
export const of = (a: number, b: number): number | null =>
  b > 0 ? a / b : null;

/**
 * Widths (percent of the track) of one reviewer's bar: raised against the busiest reviewer, and the approved part
 * against what that reviewer raised.
 */
export function barWidths(raised: number, approved: number, max: number) {
  if (raised <= 0 || max <= 0) return { raised: 0, approved: 0 };
  return {
    raised: Math.min(100, (raised / max) * 100),
    approved: Math.min(100, (approved / raised) * 100),
  };
}

/** `Oct 1, 2026 – Oct 8, 2026` from the response's ISO dates; empty before it arrives. */
export function rangeText(since?: string, until?: string): string {
  if (!since || !until) return '';
  return `${dayLabel(Date.parse(since) / 1000)} – ${dayLabel(Date.parse(until) / 1000)}`;
}
