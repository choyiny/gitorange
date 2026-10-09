/**
 * A sparkline: one series, an area fill, the last point emphasised, and a native tooltip per point. `trend`
 * colours it (better = green, worse = orange); `label` names it for assistive tech.
 */
export function Spark({
  values,
  width = 120,
  height = 32,
  label,
  labels,
  unit = '',
  trend,
}: {
  values: number[];
  width?: number;
  height?: number;
  label: string;
  /** One tooltip label per point (default "Week 1", "Week 2", …). */
  labels?: string[];
  unit?: string;
  trend?: 'better' | 'worse' | 'same';
}) {
  if (!values.length) return null;
  const pad = 3;
  const series = values.length === 1 ? [values[0], values[0]] : values;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const last = series.length - 1;
  const x = (i: number) => pad + (i * (width - pad * 2)) / last;
  const y = (v: number) =>
    height - pad - ((v - min) / span) * (height - pad * 2);
  const points = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = `M${x(0)},${height - pad} L${points.join(' L')} L${x(last)},${height - pad} Z`;
  const cls =
    trend === 'better' || trend === 'worse' ? `spark ${trend}` : 'spark';
  return (
    <svg
      className={cls}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={label}
    >
      <path className="area" d={area} />
      <polyline className="line" points={points.join(' ')} />
      {series.map((v, i) => (
        <circle
          key={i}
          cx={x(i).toFixed(1)}
          cy={y(v).toFixed(1)}
          r={i === last ? 3.2 : 6}
          className={i === last ? 'end' : 'hit'}
        >
          <title>{`${labels?.[Math.min(i, values.length - 1)] ?? `Week ${Math.min(i, values.length - 1) + 1}`}: ${v}${unit}`}</title>
        </circle>
      ))}
    </svg>
  );
}
