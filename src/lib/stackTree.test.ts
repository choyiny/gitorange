import { describe, expect, it } from 'vitest';
import { treeRows } from './stackTree';

const n = (number: number, parent: number | null, children: number[] = []) => ({
  number,
  parent: parent === null ? null : { number: parent },
  children,
});

describe('treeRows', () => {
  it('orders roots then children depth-first, with guide lines', () => {
    const rows = treeRows([
      n(1, null, [2, 4]),
      n(2, 1, [3]),
      n(3, 2),
      n(4, 1),
      n(5, null),
    ]);
    expect(rows.map((r) => [r.node.number, r.depth, r.last])).toEqual([
      [1, 0, false],
      [2, 1, false],
      [3, 2, true],
      [4, 1, true],
      [5, 0, true],
    ]);
    // #3 sits under #2, which has a later sibling (#4): a guide line continues past #3.
    expect(rows[1].guides).toEqual([]);
    expect(rows[2].guides).toEqual([true]);
  });

  it('shows a node whose parent is missing as a root', () => {
    expect(treeRows([n(2, 1)]).map((r) => r.depth)).toEqual([0]);
  });
});
