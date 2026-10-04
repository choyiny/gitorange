export type TreeLike = {
  number: number;
  parent: { number: number } | null;
  children: number[];
};

/**
 * One display row. `guides[i]` draws a vertical line in the i-th indent column (an ancestor below the roots
 * still has later siblings); the row's own elbow is drawn after them when depth > 0.
 */
export type Row<N> = {
  node: N;
  depth: number;
  guides: boolean[];
  last: boolean;
};

/** Rows for an indented tree: roots by number, each followed by its children depth-first. */
export function treeRows<N extends TreeLike>(nodes: N[]): Row<N>[] {
  const byNumber = new Map(nodes.map((x) => [x.number, x]));
  const roots = nodes
    .filter((x) => !x.parent || !byNumber.has(x.parent.number))
    .sort((a, b) => a.number - b.number);
  const rows: Row<N>[] = [];
  const seen = new Set<number>();
  const walk = (node: N, depth: number, guides: boolean[], last: boolean) => {
    if (seen.has(node.number)) return;
    seen.add(node.number);
    rows.push({ node, depth, guides, last });
    const kids = node.children
      .map((c) => byNumber.get(c))
      .filter((c): c is N => !!c);
    // A root's children get no guide columns; deeper ones continue this row's line if it has later siblings.
    const childGuides = depth === 0 ? [] : [...guides, !last];
    kids.forEach((k, i) =>
      walk(k, depth + 1, childGuides, i === kids.length - 1)
    );
  };
  roots.forEach((r, i) => walk(r, 0, [], i === roots.length - 1));
  return rows;
}
