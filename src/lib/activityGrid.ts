/**
 * An agent's activity as a contribution grid: one square per UTC day, a column per week (Sunday to Saturday), the
 * shade of a square its reviews that day against the busiest day. Pure layout; `ActivityGrid` draws it.
 */

export type ActivityLevel = 0 | 1 | 2 | 3 | 4;

export interface ActivityCell {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  reviews: number;
  level: ActivityLevel;
}

/** Seven rows, Sunday first. `null` is outside the range: before its first day or after its last. */
export type ActivityColumn = (ActivityCell | null)[];

export interface ActivityGrid {
  columns: ActivityColumn[];
  /** Where each month starts along the top: the column whose first day opens a month the column before did not. */
  months: { column: number; label: string }[];
  /** Reviews on the busiest day. */
  max: number;
  /** Reviews in the whole range. */
  total: number;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
/** A month name is about two columns wide: a label closer than this to the next one is left out. */
const MIN_LABEL_GAP = 3;

/** 0 for a day without reviews; otherwise 1 to 4 against the busiest day, so any review shows. */
export function levelOf(reviews: number, max: number): ActivityLevel {
  if (reviews <= 0 || max <= 0) return 0;
  return Math.min(
    4,
    Math.max(1, Math.ceil((reviews / max) * 4))
  ) as ActivityLevel;
}

/** Sunday is 0. */
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Lays the days (oldest first, consecutive, as `GET /api/agents/{handle}/stats` sends them) out in weeks. */
export function activityGrid(
  byDay: readonly { date: string; reviews: number }[]
): ActivityGrid {
  if (byDay.length === 0) return { columns: [], months: [], max: 0, total: 0 };
  const max = byDay.reduce((m, d) => Math.max(m, d.reviews), 0);
  const total = byDay.reduce((sum, d) => sum + d.reviews, 0);

  const cells: ActivityColumn = Array.from(
    { length: weekdayOf(byDay[0].date) },
    () => null
  );
  for (const d of byDay)
    cells.push({
      date: d.date,
      reviews: d.reviews,
      level: levelOf(d.reviews, max),
    });
  while (cells.length % 7 !== 0) cells.push(null);

  const columns: ActivityColumn[] = [];
  for (let i = 0; i < cells.length; i += 7) columns.push(cells.slice(i, i + 7));

  const months: ActivityGrid['months'] = [];
  let previous = -1;
  columns.forEach((column, i) => {
    const first = column.find((c) => c !== null);
    if (!first) return;
    const month = Number(first.date.slice(5, 7)) - 1;
    if (month !== previous) months.push({ column: i, label: MONTHS[month] });
    previous = month;
  });
  if (months.length > 1 && months[1].column - months[0].column < MIN_LABEL_GAP)
    months.shift();

  return { columns, months, max, total };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Oct 8: 3 reviews" (the square's tooltip). */
export function activityTitle(cell: ActivityCell): string {
  const month = MONTHS[Number(cell.date.slice(5, 7)) - 1];
  const day = Number(cell.date.slice(8, 10));
  return `${month} ${day}: ${cell.reviews === 0 ? 'no reviews' : plural(cell.reviews, 'review')}`;
}

/** "41 reviews in the last 26 weeks": what the grid says, for a screen reader. */
export function activitySummary(days: number, total: number): string {
  const span = days % 7 === 0 ? plural(days / 7, 'week') : plural(days, 'day');
  const what = total === 0 ? 'No reviews' : plural(total, 'review');
  return `${what} in the last ${span}`;
}
