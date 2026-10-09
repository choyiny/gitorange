/**
 * The geometry of a sparkline (`components/ui/Spark.tsx`): where each point sits, and which points are joined by a
 * line. Pure, so the gaps (weeks that were not measured) are tested.
 *
 * Points are spread evenly across the width. Measured points are scaled between the lowest and highest measured
 * value; a missing point is not a measurement, so it takes no part in the scale and sits on the baseline, and the
 * line stops before it and starts again after it.
 */

export const SPARK_PAD = 3;

export interface SparkPoint {
  /** Position in the series. */
  i: number;
  x: number;
  y: number;
  /** Not measured: drawn as a marker on the baseline, never joined to its neighbours. */
  missing: boolean;
}

export interface SparkGeometry {
  /** Every point of the series, in order (a single value is drawn as two, as a flat line). */
  points: SparkPoint[];
  /** Consecutive measured points. A run of one is drawn as a dot, longer ones as a line with an area under it. */
  runs: SparkPoint[][];
  /** The index of the last point; it is the one drawn emphasised, unless it is missing. */
  last: number;
  /** y of the baseline, where missing points sit and areas close. */
  baseline: number;
}

export function sparkGeometry({
  values,
  missing,
  width,
  height,
  pad = SPARK_PAD,
}: {
  values: number[];
  /** One flag per value; true when that value was not measured. */
  missing?: boolean[];
  width: number;
  height: number;
  pad?: number;
}): SparkGeometry {
  const single = values.length === 1;
  const series = single ? [values[0], values[0]] : values;
  const gone = series.map((_, i) => !!missing?.[single ? 0 : i]);
  const measured = series.filter((_, i) => !gone[i]);
  const min = measured.length ? Math.min(...measured) : 0;
  const max = measured.length ? Math.max(...measured) : 0;
  const span = max - min || 1;
  const last = series.length - 1;
  const baseline = height - pad;
  const x = (i: number) => pad + (i * (width - pad * 2)) / last;
  const y = (v: number) => baseline - ((v - min) / span) * (height - pad * 2);

  const points = series.map((v, i): SparkPoint => ({
    i,
    x: x(i),
    y: gone[i] ? baseline : y(v),
    missing: gone[i],
  }));
  const runs: SparkPoint[][] = [];
  for (const p of points) {
    if (p.missing) continue;
    const run = runs[runs.length - 1];
    if (run && run[run.length - 1].i === p.i - 1) run.push(p);
    else runs.push([p]);
  }
  return { points, runs, last, baseline };
}
