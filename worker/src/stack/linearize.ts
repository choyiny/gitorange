import { cycles } from './tree';

/** `after` lands after `before` (and stacks on it) so `forPr` can build on both. */
export type OrderEdge = { before: number; after: number; forPr: number };
export type LinearizeInput = {
  open: number[];
  /** Dependent → its open stackable prerequisites (builds_on, must_account_for; undismissed). */
  stackable: Map<number, number[]>;
  /** Other ordering facts among open PRs (conflicts): `dep` lands after `pre`. */
  others: { pre: number; dep: number }[];
  /** Ordering edges kept from before. */
  orders: OrderEdge[];
  /**
   * Orders a maintainer dismissed (Unstack or Dismiss on an ordering edge). A dismissal covers the pair, as it
   * does for pair rows: those two are never put in one line again, so a PR needing both waits on both.
   */
  refused?: OrderEdge[];
};
/** Which of x and y lands first so `forPr` is easiest to build on both. */
export type Choose = (x: number, y: number, forPr: number) => Promise<number>;

/**
 * Ordering edges that put each PR's stackable prerequisites on one line, in topological order. An existing
 * relationship decides a pair before `choose` is asked; an order that would make a cycle is never added (the PR
 * then waits on its prerequisites instead).
 */
export async function linearize(
  input: LinearizeInput,
  choose: Choose
): Promise<OrderEdge[]> {
  const open = new Set(input.open);
  const pairKey = (x: number, y: number) => (x < y ? `${x}:${y}` : `${y}:${x}`);
  const refused = new Set(
    (input.refused ?? []).map((o) => pairKey(o.before, o.after))
  );
  // graph: every ordering fact (lands after); line: only the stackable ones (stacks on), which make one line.
  const graph = new Map<number, Set<number>>(
    input.open.map((n) => [n, new Set<number>()])
  );
  const line = new Map<number, Set<number>>(
    input.open.map((n) => [n, new Set<number>()])
  );
  const link = (dep: number, pre: number, stacks: boolean) => {
    if (!open.has(dep) || !open.has(pre) || dep === pre) return;
    graph.get(dep)!.add(pre);
    if (stacks) line.get(dep)!.add(pre);
  };
  for (const [dep, pres] of input.stackable)
    for (const p of pres) link(dep, p, true);
  for (const r of input.others) link(r.dep, r.pre, false);
  for (const o of input.orders) link(o.after, o.before, true);
  const inCycle = cycles(new Map([...graph].map(([k, v]) => [k, [...v]])));
  /** Is `to` an ancestor of `from` in `g` (does `from` already land after `to`)? */
  const walk = (g: Map<number, Set<number>>, from: number, to: number) => {
    const seen = new Set<number>();
    const stack = [...(g.get(from) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(g.get(n) ?? []));
    }
    return false;
  };
  const reaches = (from: number, to: number) => walk(graph, from, to);
  /** Is `to` already on `from`'s line (stacked below it)? */
  const inLine = (from: number, to: number) => walk(line, from, to);
  const first = async (s: number, c: number, forPr: number) => {
    if (reaches(c, s)) return true;
    if (reaches(s, c)) return false;
    return (await choose(s, c, forPr)) === s;
  };

  // Topological order (prerequisites first), lower numbers first among equals; PRs in cycles are left out.
  const nodes = input.open.filter((n) => !inCycle.has(n)).sort((x, y) => x - y);
  const done = new Set<number>();
  const order: number[] = [];
  while (order.length < nodes.length) {
    const next = nodes.find(
      (n) =>
        !done.has(n) &&
        [...graph.get(n)!].every((p) => done.has(p) || inCycle.has(p))
    );
    if (next === undefined) break;
    done.add(next);
    order.push(next);
  }

  const added: OrderEdge[] = [];
  for (const p of order) {
    const pres = [...new Set(input.stackable.get(p) ?? [])]
      .filter((n) => open.has(n) && !inCycle.has(n))
      .sort((x, y) => x - y);
    if (pres.length < 2) continue;
    if (pres.some((m) => pres.every((o) => o === m || inLine(m, o)))) continue;
    // A maintainer refused putting two of them in one line: the PR waits on its prerequisites instead.
    if (pres.some((x) => pres.some((y) => x < y && refused.has(pairKey(x, y)))))
      continue;
    const chain: number[] = [];
    for (const s of pres) {
      let i = 0;
      while (i < chain.length && !(await first(s, chain[i], p))) i++;
      chain.splice(i, 0, s);
    }
    const mine: OrderEdge[] = [];
    let ok = true;
    for (let i = 0; i + 1 < chain.length; i++) {
      const [x, y] = [chain[i], chain[i + 1]];
      if (inLine(y, x)) continue; // already on one line in that order
      if (reaches(x, y)) {
        ok = false; // the other way round already: adding it would make a cycle
        break;
      }
      // A conflict may already set this direction; the order edge still puts the pair on one line.
      graph.get(y)!.add(x);
      line.get(y)!.add(x);
      mine.push({ before: x, after: y, forPr: p });
    }
    if (!ok) {
      for (const e of mine) {
        graph.get(e.after)!.delete(e.before);
        line.get(e.after)!.delete(e.before);
      }
      continue;
    }
    added.push(...mine);
  }
  return added;
}
