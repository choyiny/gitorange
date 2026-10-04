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
};

export type Dependency = {
  number: number;
  kind: EdgeKind;
  reason: string;
  instructions: string | null;
  landed: boolean;
  files: string[];
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

const BLOCKING: EdgeKind[] = ['builds_on', 'must_account_for', 'conflicts'];
const STACKABLE: EdgeKind[] = ['builds_on', 'must_account_for'];
const strength = (k: EdgeKind) => (k === 'must_account_for' ? 2 : 1);

/** Strongly connected components with more than one member (Tarjan). */
function cycles(graph: Map<number, number[]>): Map<number, number[]> {
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

/** Parents, waits-on, must-account-for and cycles for the open PRs, from their pair edges. */
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
    if (e.stage !== 'done') {
      const list = e.stage === 'failed' ? 'unchecked' : 'pending';
      if (isOpen.has(e.a) && isOpen.has(e.b)) {
        nodes.get(e.a)![list].push(e.b);
        nodes.get(e.b)![list].push(e.a);
      } else if (isOpen.has(e.b)) nodes.get(e.b)![list].push(e.a);
      continue;
    }
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
    };
    if (d.kind === 'must_account_for') nodes.get(dep)!.mustAccountFor.push(d);
    if (d.landed) continue;
    deps.set(dep, [...(deps.get(dep) ?? []), d]);
  }
  const graph = new Map<number, number[]>(
    open.map((n) => [n, (deps.get(n) ?? []).map((d) => d.number)])
  );
  const inCycle = cycles(graph);
  for (const [n, others] of inCycle) nodes.get(n)!.cycleWith = others;
  for (const [n, list] of deps) {
    const cyc = new Set(inCycle.get(n) ?? []);
    const usable = list.filter((d) => !cyc.has(d.number));
    const parent =
      usable
        .filter((d) => STACKABLE.includes(d.kind))
        .sort(
          (x, y) => strength(y.kind) - strength(x.kind) || y.number - x.number
        )[0] ?? null;
    const node = nodes.get(n)!;
    node.parent = parent;
    node.waitsOn = usable.filter((d) => d !== parent);
    if (parent) nodes.get(parent.number)!.children.push(n);
  }
  for (const node of nodes.values()) {
    node.children.sort((x, y) => x - y);
    node.unchecked.sort((x, y) => x - y);
    node.pending.sort((x, y) => x - y);
  }
  return nodes;
}
