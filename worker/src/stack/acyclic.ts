import { and, eq, inArray, or } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import { prEdges, pullRequests, type EdgeKind } from '../db/app.schema';
import { landTargetIs } from '../lib/land-target';
import { chunks } from './view';

const BLOCKING = new Set<EdgeKind>([
  'builds_on',
  'must_account_for',
  'conflicts',
  'ordered_after',
]);
/** Fixes tried before giving up on keeping a verdict (each flips or drops one edge). */
const MAX_FIXES = 32;

export type Verdict = {
  kind: EdgeKind;
  prerequisite: 'a' | 'b' | null;
  /** Said on the row when the verdict was changed to keep the graph acyclic. */
  note: string | null;
};

type Edge = {
  id: string;
  slot: 'pair' | 'order';
  pre: string;
  dep: string;
  kind: EdgeKind;
  git: boolean;
  reason: string | null;
  /** pair rows: which side pre is, as stored. */
  aIsPre: boolean;
};

/**
 * The verdict for pair (a, b) such that, with every other recorded edge among the land target's open pull requests,
 * nothing depends on itself. A new edge that would close a cycle is changed, cheapest first: a conflict (which only
 * needs some order) is turned around; else a model's conflict on the cycle is turned around; else, for a git verdict
 * (ground truth), the models' edges on the cycle give way (a conflict turns, others are left independent with a
 * note, an ordering edge is dropped for reconcile to redo); else the new verdict is left independent with a note.
 * Writes the changes to other rows; returns the verdict to save. Call it inside the step that saves.
 */
export async function acyclicVerdict(
  db: DrizzleDB,
  p: {
    repositoryId: string;
    landTarget: string;
    a: { id: string; number: number };
    b: { id: string; number: number };
    kind: EdgeKind;
    prerequisite: 'a' | 'b' | null;
    git: boolean;
  }
): Promise<Verdict> {
  const asIs: Verdict = {
    kind: p.kind,
    prerequisite: p.prerequisite,
    note: null,
  };
  if (!p.prerequisite || !BLOCKING.has(p.kind)) return asIs;
  const open = await db
    .select({ id: pullRequests.id, number: pullRequests.number })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, p.repositoryId),
        eq(pullRequests.state, 'open'),
        landTargetIs(p.landTarget)
      )
    )
    .all();
  const numberOf = new Map(open.map((o) => [o.id, o.number]));
  // A landed side never sits in a cycle among open pull requests.
  if (!numberOf.has(p.a.id) || !numberOf.has(p.b.id)) return asIs;
  const ids = [...numberOf.keys()];
  const rows = new Map<string, typeof prEdges.$inferSelect>();
  for (const part of chunks(ids, 45))
    for (const e of await db
      .select()
      .from(prEdges)
      .where(
        and(
          eq(prEdges.repositoryId, p.repositoryId),
          eq(prEdges.landTarget, p.landTarget),
          or(inArray(prEdges.prAId, part), inArray(prEdges.prBId, part))
        )
      )
      .all())
      rows.set(e.id, e);
  const edges: Edge[] = [];
  for (const e of rows.values()) {
    if (e.slot === 'pair' && e.prAId === p.a.id && e.prBId === p.b.id) continue; // the row being decided
    if (!numberOf.has(e.prAId) || !numberOf.has(e.prBId)) continue;
    if (e.stage !== 'done' && e.stage !== 'recheck') continue;
    if (e.dismissedAt || !e.kind || !e.prerequisite) continue;
    if (!BLOCKING.has(e.kind)) continue;
    const aIsPre = e.prerequisite === 'a';
    edges.push({
      id: e.id,
      slot: e.slot,
      pre: aIsPre ? e.prAId : e.prBId,
      dep: aIsPre ? e.prBId : e.prAId,
      kind: e.kind,
      git: e.decidedBy === 'git',
      reason: e.reason,
      aIsPre,
    });
  }

  /** A path from `from` to `to` following "depends on" (dep → pre), as edges; null when there is none. */
  const path = (
    from: string,
    to: string,
    o: { extra?: Edge; skip?: Edge } = {}
  ): Edge[] | null => {
    const all = [...edges, ...(o.extra ? [o.extra] : [])].filter(
      (e) => e !== o.skip
    );
    const out = new Map<string, Edge[]>();
    for (const e of all) out.set(e.dep, [...(out.get(e.dep) ?? []), e]);
    const via = new Map<string, Edge>();
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length) {
      const n = queue.shift()!;
      if (n === to) {
        const list: Edge[] = [];
        for (let c = to; c !== from; c = via.get(c)!.dep)
          list.unshift(via.get(c)!);
        return list;
      }
      for (const e of out.get(n) ?? [])
        if (!seen.has(e.pre)) {
          seen.add(e.pre);
          via.set(e.pre, e);
          queue.push(e.pre);
        }
    }
    return null;
  };
  const num = (id: string) => `#${numberOf.get(id)}`;

  let pre = p.prerequisite === 'a' ? p.a.id : p.b.id;
  let dep = pre === p.a.id ? p.b.id : p.a.id;
  let turned = false;
  const flipped = new Set<string>();
  const dropped: Edge[] = [];
  for (let i = 0; i < MAX_FIXES; i++) {
    // The new edge dep → pre closes a cycle iff pre already depends on dep.
    const cycle = path(pre, dep);
    if (!cycle) break;
    if (p.kind === 'conflicts' && !turned) {
      [pre, dep] = [dep, pre];
      turned = true;
      continue;
    }
    const mine: Edge = {
      id: '',
      slot: 'pair',
      pre,
      dep,
      kind: p.kind,
      git: p.git,
      reason: null,
      aIsPre: false,
    };
    // A model's conflict on the cycle turned around, if that closes no other cycle.
    const turn = cycle.find(
      (e) =>
        e.kind === 'conflicts' &&
        !e.git &&
        !flipped.has(e.id) &&
        !path(e.dep, e.pre, { extra: mine, skip: e })
    );
    if (turn) {
      flipped.add(turn.id);
      [turn.pre, turn.dep] = [turn.dep, turn.pre];
      turn.aIsPre = !turn.aIsPre;
      continue;
    }
    const yields = p.git ? cycle.find((e) => !e.git) : undefined;
    if (yields) {
      edges.splice(edges.indexOf(yields), 1);
      dropped.push(yields);
      continue;
    }
    const around = [num(dep), num(pre), ...cycle.map((e) => num(e.pre))];
    return {
      kind: 'independent',
      prerequisite: null,
      note: `Left independent: ${num(dep)} depending on ${num(pre)} would close a cycle (${around.join(' → ')}).`,
    };
  }
  if (path(pre, dep)) {
    return {
      kind: 'independent',
      prerequisite: null,
      note: `Left independent: ${num(dep)} depending on ${num(pre)} would close a cycle.`,
    };
  }

  const now = new Date();
  for (const e of edges)
    if (flipped.has(e.id))
      await db
        .update(prEdges)
        .set({ prerequisite: e.aIsPre ? 'a' : 'b', updatedAt: now })
        .where(eq(prEdges.id, e.id));
  for (const e of dropped) {
    if (e.slot === 'order') {
      await db.delete(prEdges).where(eq(prEdges.id, e.id));
      continue;
    }
    await db
      .update(prEdges)
      .set({
        kind: 'independent',
        prerequisite: null,
        instructions: null,
        reason:
          `Left independent: git shows ${num(dep)} builds on ${num(pre)}, so ${num(e.dep)} depending on ${num(e.pre)} would close a cycle.${e.reason ? ` Was: ${e.reason}` : ''}`.slice(
            0,
            1000
          ),
        updatedAt: now,
      })
      .where(eq(prEdges.id, e.id));
  }
  const prerequisite = pre === p.a.id ? 'a' : 'b';
  return {
    kind: p.kind,
    prerequisite,
    note:
      turned && prerequisite !== p.prerequisite
        ? `Lands ${num(pre)} first: the other order would close a cycle.`
        : null,
  };
}
