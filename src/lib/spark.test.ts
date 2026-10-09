import { describe, expect, it } from 'vitest';
import { SPARK_PAD, sparkGeometry } from './spark';

/** How the sparkline placed its points before it could have gaps. */
function original(values: number[], width: number, height: number) {
  const pad = 3;
  const series = values.length === 1 ? [values[0], values[0]] : values;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const last = series.length - 1;
  const x = (i: number) => pad + (i * (width - pad * 2)) / last;
  const y = (v: number) =>
    height - pad - ((v - min) / span) * (height - pad * 2);
  return series.map((v, i) => ({ x: x(i), y: y(v) }));
}

describe('sparkGeometry without gaps', () => {
  it.each([
    [[1, 2, 3, 2, 5, 4, 6, 3]],
    [[0, 0, 0, 0]],
    [[5]],
    [[2, 9]],
    [[262, 250, 255, 240, 236, 230, 210, 180]],
  ])('places the points as it always did: %j', (values) => {
    const g = sparkGeometry({ values, width: 104, height: 28 });
    expect(g.points.map(({ x, y }) => ({ x, y }))).toEqual(
      original(values, 104, 28)
    );
    // One run joining every point, nothing missing.
    expect(g.runs).toHaveLength(1);
    expect(g.runs[0]).toEqual(g.points);
    expect(g.points.some((p) => p.missing)).toBe(false);
    expect(g.last).toBe(g.points.length - 1);
    expect(g.baseline).toBe(28 - SPARK_PAD);
  });

  it('treats an absent or all-false missing list the same', () => {
    const values = [3, 1, 2];
    const a = sparkGeometry({ values, width: 100, height: 30 });
    const b = sparkGeometry({
      values,
      missing: [false, false, false],
      width: 100,
      height: 30,
    });
    expect(b).toEqual(a);
  });
});

describe('sparkGeometry with unmeasured values', () => {
  const values = [0, 0, 40, 0, 20, 0, 0, 10];
  const missing = [true, true, false, true, false, true, true, false];

  it('breaks the line at every gap: runs hold only consecutive measured points', () => {
    const g = sparkGeometry({ values, missing, width: 104, height: 28 });
    expect(g.runs.map((r) => r.map((p) => p.i))).toEqual([[2], [4], [7]]);
    const joined = sparkGeometry({
      values: [1, 2, 3, 4, 5],
      missing: [false, false, true, false, false],
      width: 100,
      height: 30,
    });
    expect(joined.runs.map((r) => r.map((p) => p.i))).toEqual([
      [0, 1],
      [3, 4],
    ]);
  });

  it('puts missing points on the baseline and marks them', () => {
    const g = sparkGeometry({ values, missing, width: 104, height: 28 });
    for (const p of g.points)
      if (missing[p.i]) {
        expect(p.missing).toBe(true);
        expect(p.y).toBe(g.baseline);
      } else expect(p.missing).toBe(false);
  });

  it('scales the measured points only: the 0 of a missing week is not the minimum', () => {
    const g = sparkGeometry({ values, missing, width: 104, height: 28 });
    const byI = new Map(g.points.map((p) => [p.i, p]));
    // 10 is the lowest measured value, 40 the highest: they take the bottom and the top of the plot.
    expect(byI.get(7)!.y).toBe(g.baseline);
    expect(byI.get(2)!.y).toBe(SPARK_PAD);
    expect(byI.get(4)!.y).toBeGreaterThan(SPARK_PAD);
    expect(byI.get(4)!.y).toBeLessThan(g.baseline);
  });

  it('spreads the points evenly whatever is missing', () => {
    const g = sparkGeometry({ values, missing, width: 104, height: 28 });
    expect(g.points.map((p) => p.x)).toEqual(
      original(values, 104, 28).map((p) => p.x)
    );
  });

  it('has no runs when nothing was measured, and does not divide by zero', () => {
    const g = sparkGeometry({
      values: [0, 0, 0],
      missing: [true, true, true],
      width: 100,
      height: 30,
    });
    expect(g.runs).toEqual([]);
    expect(g.points.every((p) => Number.isFinite(p.y) && p.missing)).toBe(true);
  });

  it('knows when the last point (this week) is the one missing', () => {
    const g = sparkGeometry({
      values: [5, 6, 0],
      missing: [false, false, true],
      width: 100,
      height: 30,
    });
    expect(g.points[g.last].missing).toBe(true);
    expect(g.runs.map((r) => r.map((p) => p.i))).toEqual([[0, 1]]);
  });
});
