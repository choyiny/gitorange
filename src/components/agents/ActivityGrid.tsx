import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import {
  activityGrid,
  activitySummary,
  activityTitle,
} from '@/lib/activityGrid';

/**
 * An agent's reviews per day over the last 26 weeks: a square a day, a column a week, darker when busier. It starts
 * scrolled to today, so on a phone the newest weeks are the ones you see. The squares carry their numbers in
 * tooltips; the grid as a whole is one labelled image, with the total in words.
 */
export function ActivityGrid({
  byDay,
  color,
}: {
  byDay: { date: string; reviews: number }[];
  color: string;
}) {
  const grid = useMemo(() => activityGrid(byDay), [byDay]);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [grid]);
  const summary = activitySummary(byDay.length, grid.total);
  return (
    <div style={{ '--agent': color } as CSSProperties}>
      <div className="ac-wrap" ref={scroller}>
        <div className="actgrid" role="img" aria-label={summary}>
          <div className="actmonths" aria-hidden="true">
            {grid.months.map((m) => (
              <span key={m.column} style={{ gridColumn: m.column + 1 }}>
                {m.label}
              </span>
            ))}
          </div>
          <div className="actcols">
            {grid.columns.map((column, i) => (
              <span className="actcol" key={i}>
                {column.map((cell, j) =>
                  cell ? (
                    <i
                      key={j}
                      className={`ac l${cell.level}`}
                      title={activityTitle(cell)}
                    />
                  ) : (
                    <i key={j} className="ac none" />
                  )
                )}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="actlegend small muted" aria-hidden="true">
        <span>{summary}</span>
        <span className="grow" />
        Less
        <i className="ac" />
        <i className="ac l1" />
        <i className="ac l2" />
        <i className="ac l3" />
        <i className="ac l4" />
        More
      </div>
    </div>
  );
}
