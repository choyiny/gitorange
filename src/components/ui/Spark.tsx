import { sparkGeometry } from '@/lib/spark';

/**
 * A sparkline: one series, an area fill, the last point emphasised, and a native tooltip per point. `trend`
 * colours it (better = green, worse = orange); `label` names it for assistive tech. `missing` marks values that
 * were not measured (a week with no test runs): they are drawn as hollow markers on the baseline, the line is broken
 * there, and their tooltip says `missingText` instead of the value.
 */
export function Spark({
  values,
  width = 120,
  height = 32,
  label,
  labels,
  unit = '',
  trend,
  missing,
  missingText = 'no data',
}: {
  values: number[];
  width?: number;
  height?: number;
  label: string;
  /** One tooltip label per point (default "Week 1", "Week 2", …). */
  labels?: string[];
  unit?: string;
  trend?: 'better' | 'worse' | 'same';
  /** One flag per value; true where it was not measured. */
  missing?: boolean[];
  missingText?: string;
}) {
  if (!values.length) return null;
  const { points, runs, last, baseline } = sparkGeometry({
    values,
    missing,
    width,
    height,
  });
  const fmt = (p: { x: number; y: number }) =>
    `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  const cls =
    trend === 'better' || trend === 'worse' ? `spark ${trend}` : 'spark';
  const shown = (i: number) => Math.min(i, values.length - 1);
  const title = (i: number, text: string) =>
    `${labels?.[shown(i)] ?? `Week ${shown(i) + 1}`}: ${text}`;
  const lines = runs.filter((r) => r.length > 1);
  return (
    <svg
      className={cls}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={label}
    >
      {lines.map((run) => (
        <path
          key={`a${run[0].i}`}
          className="area"
          d={`M${run[0].x},${baseline} L${run.map(fmt).join(' L')} L${run[run.length - 1].x},${baseline} Z`}
        />
      ))}
      {lines.map((run) => (
        <polyline
          key={`l${run[0].i}`}
          className="line"
          points={run.map(fmt).join(' ')}
        />
      ))}
      {points.map((p) => {
        const text = p.missing ? missingText : `${values[shown(p.i)]}${unit}`;
        const cx = p.x.toFixed(1);
        const cy = p.y.toFixed(1);
        const alone =
          !p.missing && runs.some((r) => r.length === 1 && r[0].i === p.i);
        return (
          <circle
            key={p.i}
            cx={cx}
            cy={cy}
            r={p.missing ? 2.4 : p.i === last ? 3.2 : alone ? 2.4 : 6}
            className={
              p.missing ? 'gap' : p.i === last ? 'end' : alone ? 'solo' : 'hit'
            }
          >
            <title>{title(p.i, text)}</title>
          </circle>
        );
      })}
    </svg>
  );
}
