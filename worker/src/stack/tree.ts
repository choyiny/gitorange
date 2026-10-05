import type { EdgeKind, EdgeStage } from '../db/app.schema';

export type EdgeInput = {
  a: number;
  b: number;
  stage: EdgeStage;
  kind: EdgeKind | null;
  prerequisite: 'a' | 'b' | null;
  reason: string | null;
  instructions: string | null;
  files: string[];
  /** pair (default): a discovery verdict; order: an ordering edge added for `forPr`. */
  slot?: 'pair' | 'order';
  forPr?: number | null;
  /** must_account_for: a re-check of the dependent's head found it accounted for. */
  accounted?: boolean;
  /** A maintainer dismissed it: it neither stacks nor blocks. */
  dismissed?: boolean;
  /** Set on a done must_account_for row when its re-check failed (it still blocks). */
  errorMessage?: string | null;
};

export type Dependency = {
  number: number;
  kind: EdgeKind;
  reason: string;
  instructions: string | null;
  landed: boolean;
  files: string[];
  accounted: boolean;
  /** ordered_after: the PR this order was added for. */
  forPr: number | null;
};

export type TreeNode = {
  number: number;
  /** The PR this one is stacked on. */
  parent: Dependency | null;
  children: number[];
  /** Other open PRs that must land first. */
  waitsOn: Dependency[];
  /** PRs (open or landed) this one must change for, with instructions. */
  mustAccountFor: Dependency[];
  /** PRs this one depends on in a circle; none of those edges count. */
  cycleWith: number[];
  /** PRs a check against failed. */
  unchecked: number[];
  /** PRs a check against is still running (pair row in triage or deep). */
  pending: number[];
  /** No stack run has started for this PR's current head yet (set by the view). */
  checking: boolean;
};

const BLOCKING: EdgeKind[] = [
  'builds_on',
  'must_account_for',
  'conflicts',
  'ordered_after',
];
const STACKABLE: EdgeKind[] = [
  'builds_on',
  'must_account_for',
  'ordered_after',
];
const strength = (k: EdgeKind) =>
  k === 'must_account_for' ? 2 : k === 'builds_on' ? 1 : 0;

/** Strongly connected components with more than one member (Tarjan). */
export function cycles(graph: Map<number, number[]>): Map<number, number[]> {
  let index = 0;
  const idx = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const out = new Map<number, number[]>();
  const visit = (v: number) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1)
        for (const n of comp)
          out.set(
            n,
            comp.filter((m) => m !== n).sort((x, y) => x - y)
          );
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return out;
}

/**
 * Parents, waits-on, must-account-for and cycles for the open PRs, from their pair verdicts and ordering
 * edges. A parent is the strongest stackable prerequisite whose chain holds every other one.
 */
export function buildTree(
  open: number[],
  edges: EdgeInput[]
): Map<number, TreeNode> {
  const isOpen = new Set(open);
  const nodes = new Map<number, TreeNode>(
    open.map((n) => [
      n,
      {
        number: n,
        parent: null,
        children: [],
        waitsOn: [],
        mustAccountFor: [],
        cycleWith: [],
        unchecked: [],
        pending: [],
        checking: false,
      },
    ])
  );
  // dependent -> its open prerequisites
  const deps = new Map<number, Dependency[]>();
  for (const e of edges) {
    // recheck: the verdict is known; only whether it is accounted for is being re-checked.
    if (e.stage !== 'done' && e.stage !== 'recheck') {
      // Unchecked and pending are about pair checks; an unfinished order row neither stacks nor reports.
      if (e.slot === 'order') continue;
      const list = e.stage === 'failed' ? 'unchecked' : 'pending';
      if (isOpen.has(e.a) && isOpen.has(e.b)) {
        nodes.get(e.a)![list].push(e.b);
        nodes.get(e.b)![list].push(e.a);
      } else if (isOpen.has(e.b)) nodes.get(e.b)![list].push(e.a);
      continue;
    }
    if (e.dismissed) continue;
    if (!e.kind || !BLOCKING.includes(e.kind)) continue;
    if (!e.prerequisite) continue;
    const pre = e.prerequisite === 'a' ? e.a : e.b;
    const dep = e.prerequisite === 'a' ? e.b : e.a;
    if (!isOpen.has(dep)) continue;
    const d: Dependency = {
      number: pre,
      kind: e.kind,
      reason: e.reason ?? '',
      instructions: e.instructions,
      landed: !isOpen.has(pre),
      files: e.files,
      accounted: !!e.accounted,
      forPr: e.forPr ?? null,
    };
    if (d.kind === 'must_account_for') {
      nodes.get(dep)!.mustAccountFor.push(d);
      // A failed re-check: the dependent can Retry it.
      if (e.slot !== 'order' && e.errorMessage && !d.accounted)
        nodes.get(dep)!.unchecked.push(pre);
    }
    if (d.landed) continue;
    deps.set(dep, [...(deps.get(dep) ?? []), d]);
  }
  const graph = new Map<number, number[]>(
    open.map((n) => [n, (deps.get(n) ?? []).map((d) => d.number)])
  );
  const inCycle = cycles(graph);
  for (const [n, others] of inCycle) nodes.get(n)!.cycleWith = others;
  // Ancestry along stackable edges only (the line a PR can stack on), ignoring edges inside cycles. A conflict
  // orders two PRs but stacks neither on the other, so it never makes a line.
  const acyclic = new Map<number, number[]>(
    open.map((n) => {
      const cyc = new Set(inCycle.get(n) ?? []);
      return [
        n,
        (deps.get(n) ?? [])
          .filter((d) => STACKABLE.includes(d.kind) && !cyc.has(d.number))
          .map((d) => d.number),
      ];
    })
  );
  const memo = new Map<number, Set<number>>();
  const ancestors = (n: number): Set<number> => {
    const hit = memo.get(n);
    if (hit) return hit;
    const seen = new Set<number>();
    const stack = [...(acyclic.get(n) ?? [])];
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p)) continue;
      seen.add(p);
      stack.push(...(acyclic.get(p) ?? []));
    }
    memo.set(n, seen);
    return seen;
  };
  for (const [n, list] of deps) {
    const cyc = new Set(inCycle.get(n) ?? []);
    const usable = list.filter((d) => !cyc.has(d.number));
    const stackable = usable.filter((d) => STACKABLE.includes(d.kind));
    // The parent's chain must already contain every other stackable prerequisite (one line, after linearizing).
    const covers = (d: Dependency) =>
      stackable.every(
        (o) => o.number === d.number || ancestors(d.number).has(o.number)
      );
    const parent =
      stackable
        .filter(covers)
        .sort(
          (x, y) => strength(y.kind) - strength(x.kind) || y.number - x.number
        )[0] ?? null;
    const node = nodes.get(n)!;
    node.parent = parent;
    const chain = parent ? ancestors(parent.number) : new Set<number>();
    // One entry per prerequisite (a pair verdict and an order edge can name the same one): the strongest.
    const seen = new Set<number>();
    node.waitsOn = usable
      .filter(
        (d) =>
          d !== parent && !chain.has(d.number) && d.number !== parent?.number
      )
      .sort(
        (x, y) => strength(y.kind) - strength(x.kind) || x.number - y.number
      )
      .filter((d) => !seen.has(d.number) && !!seen.add(d.number));
    if (parent) nodes.get(parent.number)!.children.push(n);
  }
  for (const node of nodes.values()) {
    node.children.sort((x, y) => x - y);
    node.unchecked = [...new Set(node.unchecked)].sort((x, y) => x - y);
    node.pending.sort((x, y) => x - y);
  }
  return nodes;
}
