import { and, eq, inArray, or } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  prEdges,
  pullRequests,
  type PrEdge,
  type Repository,
} from '../db/app.schema';
import { findRepoById, gitFor } from '../lib/repos';
import { landTargetIs } from '../lib/land-target';
import { pingingSteps } from '../live/publish';
import { ensureRebase } from '../merge/rebase';
import type { StepRunner } from '../merge/resolution';
import { MODEL_RETRIES } from '../review/detail';
import { reviewConfigured } from '../review/head';
import { d1Of, recordEvent } from '../pulls/events';
import { settleStates } from '../pulls/settle';
import { pullStates } from '../pulls/signals';
import { STATE_RANK } from '../pulls/state';
import { summariesFor } from './discover';
import { stackingTuning } from './defaults';
import { linearize, type OrderEdge } from './linearize';
import { readOrder, type PrSide, type StackModels } from './models';
import { chunks, stackTreeView } from './view';

export type ReconcileParams = { repositoryId: string; landTarget: string };

const STACKABLE = new Set(['builds_on', 'must_account_for']);
const MAX_DESCRIPTION = 4 * 1024;
const MAX_SUMMARIES = 4 * 1024;

/** FNV-1a: a stable hash, so which PR Clef sees as "a" is fixed per question but not always the lower number. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Brings one land target's stacks up to date: drops ordering edges whose PRs moved, closed or landed; linearizes
 * PRs with several prerequisites (Clef chooses an order when nothing else decides it); and retargets each open
 * PR's base_ref to its parent's head branch, or to the land target (compare-and-swap, one event per change).
 * Returns how many PRs were retargeted.
 */
export async function executeReconcile(
  deps: {
    env: CloudflareBindings;
    db: DrizzleDB;
    step: StepRunner;
    models: StackModels;
  },
  params: ReconcileParams,
  prefix = ''
): Promise<number> {
  const { env, db, models } = deps;
  const p = `${prefix}reconcile:`;
  const job = await deps.step.do(`${p}load`, async () => {
    const found = await findRepoById(db, params.repositoryId);
    if (!found) return null;
    const git = gitFor(env, found.repo);
    const tip = await git.resolve(params.landTarget);
    if (!tip) return null;
    const policy = stackingTuning();
    const open = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, params.repositoryId),
          eq(pullRequests.state, 'open'),
          landTargetIs(params.landTarget)
        )
      )
      .all();
    const refs = await git.refs();
    // Only what pruning and retargeting need: PR text is read per order question, so this result stays small
    // (Workflows caps a step's result at 1 MiB).
    const prs = open.map((pr) => ({
      id: pr.id,
      number: pr.number,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      head: refs.get(`refs/heads/${pr.headRef}`) ?? null,
    }));
    return { repo: found.repo, policy, prs };
  });
  if (!job) return 0;
  const step = pingingSteps(env, deps.step, params.repositoryId);
  const byNumber = new Map(job.prs.map((x) => [x.number, x]));
  const byId = new Map(job.prs.map((x) => [x.id, x]));

  // Keep ordering edges whose three PRs are still open at the heads they were decided at, and dismissed ones.
  const graph = await step.do(`${p}edges`, async () => {
    // Only edges touching an open PR (a target's history of landed pairs can be long); D1 binds at most 100
    // parameters per statement.
    const found = new Map<string, PrEdge>();
    for (const ids of chunks([...byId.keys()], 45))
      for (const e of await db
        .select()
        .from(prEdges)
        .where(
          and(
            eq(prEdges.repositoryId, params.repositoryId),
            eq(prEdges.landTarget, params.landTarget),
            or(inArray(prEdges.prAId, ids), inArray(prEdges.prBId, ids))
          )
        )
        .all())
        found.set(e.id, e);
    const rows = [...found.values()];
    const kept: OrderEdge[] = [];
    const refused: OrderEdge[] = [];
    const stale: string[] = [];
    const stackable = new Map<number, number[]>();
    const others: { pre: number; dep: number }[] = [];
    for (const e of rows) {
      if (e.slot === 'order') continue;
      const a = byId.get(e.prAId);
      const b = byId.get(e.prBId);
      if (!a || !b || e.dismissedAt || !e.kind || !e.prerequisite) continue;
      if (e.stage !== 'done' && e.stage !== 'recheck') continue;
      const [pre, dep] = e.prerequisite === 'a' ? [a, b] : [b, a];
      if (STACKABLE.has(e.kind))
        stackable.set(dep.number, [
          ...(stackable.get(dep.number) ?? []),
          pre.number,
        ]);
      else if (e.kind === 'conflicts')
        others.push({ pre: pre.number, dep: dep.number });
    }
    // An ordering edge lasts while its three PRs are open at the heads it was decided at, and both sides are
    // still undismissed stackable prerequisites of the PR it was added for.
    for (const e of rows) {
      if (e.slot !== 'order') continue;
      const a = byId.get(e.prAId);
      const b = byId.get(e.prBId);
      const f = e.forPrId ? byId.get(e.forPrId) : undefined;
      const pres = f ? (stackable.get(f.number) ?? []) : [];
      // A dismissed order is a maintainer's refusal: kept across head moves while its three PRs are open, so
      // reconcile never puts that pair back in one line.
      if (e.dismissedAt) {
        if (!a || !b || !f) stale.push(e.id);
        else {
          const [before, after] = e.prerequisite === 'a' ? [a, b] : [b, a];
          refused.push({
            before: before.number,
            after: after.number,
            forPr: f.number,
          });
        }
        continue;
      }
      if (
        !a ||
        !b ||
        !f ||
        a.head !== e.aHead ||
        b.head !== e.bHead ||
        f.head !== e.forHead ||
        !pres.includes(a.number) ||
        !pres.includes(b.number)
      ) {
        stale.push(e.id);
        continue;
      }
      const [before, after] = e.prerequisite === 'a' ? [a, b] : [b, a];
      kept.push({
        before: before.number,
        after: after.number,
        forPr: f.number,
      });
    }
    for (let i = 0; i < stale.length; i += 90)
      await db
        .delete(prEdges)
        .where(inArray(prEdges.id, stale.slice(i, i + 90)));
    return { kept, refused, stackable: [...stackable], others };
  });

  /** One side as Clef sees it, read inside the order step that asks (never carried in a step result). */
  const side = async (n: number): Promise<PrSide> => {
    const x = byNumber.get(n)!;
    const row = await db
      .select({ title: pullRequests.title, body: pullRequests.body })
      .from(pullRequests)
      .where(eq(pullRequests.id, x.id))
      .get();
    return {
      number: n,
      title: row?.title ?? '',
      description: (row?.body ?? '').slice(0, MAX_DESCRIPTION),
      summaries: x.head
        ? (await summariesFor(db, x.id, x.head, [])).slice(0, MAX_SUMMARIES)
        : '',
      landed: false,
    };
  };
  const policy = job.policy;
  const added = await linearize(
    {
      open: job.prs.filter((x) => x.head).map((x) => x.number),
      stackable: new Map(graph.stackable),
      others: graph.others,
      orders: graph.kept,
      refused: graph.refused,
    },
    async (x, y, forPr) => {
      const [lo, hi] = x < y ? [x, y] : [y, x];
      // Which side Clef sees as "a" comes from a stable hash of the question, so it never favors one side.
      const [a, b] = fnv1a(`${lo}:${hi}:${forPr}`) & 1 ? [lo, hi] : [hi, lo];
      try {
        const answer = readOrder(
          await step.do(
            `${p}order:${lo}:${hi}:${forPr}`,
            MODEL_RETRIES,
            async () =>
              models.order(policy.model, {
                a: await side(a),
                b: await side(b),
                dependent: await side(forPr),
              })
          )
        );
        if (answer.confidence >= policy.confident_above)
          return answer.first === 'a' ? a : b;
      } catch (e) {
        console.warn('[stack] order choice failed', lo, hi, forPr, e);
      }
      // Closer to Ready first (higher rank), then the lower number. States are computed only here, when needed.
      return step.do(`${p}ready:${lo}:${hi}`, async () => {
        const rows = await db
          .select()
          .from(pullRequests)
          .where(
            inArray(pullRequests.id, [
              byNumber.get(lo)!.id,
              byNumber.get(hi)!.id,
            ])
          )
          .all();
        const states = await pullStates(
          db,
          gitFor(env, job.repo as Repository),
          params.repositoryId,
          rows,
          { reviewConfigured: reviewConfigured(env) }
        );
        const rank = (n: number) =>
          STATE_RANK[states.get(byNumber.get(n)!.id)?.state ?? 'ready'];
        const [rl, rh] = [rank(lo), rank(hi)];
        return rl === rh ? lo : rl > rh ? lo : hi;
      });
    }
  );

  if (added.length)
    await step.do(`${p}save-orders`, async () => {
      const now = new Date();
      for (const o of added) {
        const [lo, hi] =
          o.before < o.after ? [o.before, o.after] : [o.after, o.before];
        const a = byNumber.get(lo)!;
        const b = byNumber.get(hi)!;
        const f = byNumber.get(o.forPr)!;
        const reason = `#${o.after} lands after #${o.before} so #${o.forPr} can build on both.`;
        const values = {
          repositoryId: params.repositoryId,
          landTarget: params.landTarget,
          prAId: a.id,
          prBId: b.id,
          slot: 'order' as const,
          aHead: a.head!,
          bHead: b.head!,
          forPrId: f.id,
          forHead: f.head,
          stage: 'done' as const,
          kind: 'ordered_after' as const,
          prerequisite: (o.before === lo ? 'a' : 'b') as 'a' | 'b',
          reason,
          updatedAt: now,
        };
        await db
          .insert(prEdges)
          .values({ id: crypto.randomUUID(), createdAt: now, ...values })
          .onConflictDoUpdate({
            target: [prEdges.prAId, prEdges.prBId, prEdges.slot],
            set: values,
          });
        await recordEvent(db, {
          // Deterministic: a retried step records it once.
          id: `ordered:${a.id}:${b.id}:${a.head}:${b.head}:${f.id}:${f.head}`,
          repositoryId: params.repositoryId,
          pullRequestId: byNumber.get(o.after)!.id,
          kind: 'ordered',
          data: { before: o.before, for_pr: o.forPr, reason },
        });
      }
      return true;
    });

  const changed = await step.do(`${p}retarget`, async () => {
    const git = gitFor(env, job.repo as Repository);
    const refs = await git.refs();
    const view = await stackTreeView(db, git, params.repositoryId, {
      branch: params.landTarget,
      authors: false,
    });
    const nodes =
      view.targets.find((t) => t.branch === params.landTarget)?.nodes ?? [];
    const branchOf = new Map(nodes.map((n) => [n.number, n.headRef]));
    const movedIds: string[] = [];
    for (const pr of job.prs) {
      const parent = nodes.find((n) => n.number === pr.number)?.parent ?? null;
      const branch = parent ? branchOf.get(parent.number) : undefined;
      // Never stack onto a branch that no longer exists.
      const want =
        parent && branch && refs.has(`refs/heads/${branch}`)
          ? branch
          : params.landTarget;
      // Decided from the base this run loaded: if it changed since, another run or a close moved it; skip.
      if (pr.baseRef === want) continue;
      const was = job.prs.find((x) => x.headRef === pr.baseRef);
      const event = {
        // Random, but recorded only in the transaction whose compare-and-swap moved the PR: a retried step's
        // swap fails (the base already moved), so it is never recorded twice.
        id: `retarget:${crypto.randomUUID()}`,
        ...(want !== params.landTarget && parent
          ? {
              kind: 'stacked' as const,
              data: {
                pr: parent.number,
                branch: want,
                kind: parent.kind,
                reason: parent.reason,
              },
            }
          : {
              kind: 'unstacked' as const,
              data: {
                pr: was?.number ?? null,
                why: 'It no longer builds on an open pull request.',
              },
            }),
      };
      if (
        await retargetAtomically(db, {
          repositoryId: params.repositoryId,
          pullRequestId: pr.id,
          from: pr.baseRef,
          to: want,
          landTarget: params.landTarget,
          event,
        })
      )
        movedIds.push(pr.id);
    }
    return movedIds;
  });
  if (changed.length) {
    await step.do(`${p}states`, async () => {
      // The old and the new base share this land target: one scoped settle covers both.
      await settleStates(env, db, params.repositoryId, {
        branch: params.landTarget,
      });
      return true;
    });
    await step.do(`${p}rebase`, async () => {
      // A retargeted pull request rebases onto its new base (a parent's branch, or the land target).
      const git = gitFor(env, job.repo as Repository);
      for (const id of changed) {
        const pr = await db
          .select()
          .from(pullRequests)
          .where(eq(pullRequests.id, id))
          .get();
        if (pr) await ensureRebase(env, db, git, pr);
      }
      return true;
    });
  }
  return changed.length;
}

/**
 * Compare-and-swap of an open PR's base_ref from `from` to `to`, and its timeline event, in one D1 batch (a
 * transaction): the event is inserted only when the update took effect. Returns whether it did.
 */
async function retargetAtomically(
  db: DrizzleDB,
  r: {
    repositoryId: string;
    pullRequestId: string;
    from: string;
    to: string;
    landTarget: string;
    event: {
      id: string;
      kind: 'stacked' | 'unstacked';
      data: Record<string, unknown>;
    };
  }
): Promise<boolean> {
  const d1 = d1Of(db);
  const now = Date.now();
  const [update] = await d1.batch([
    d1
      .prepare(
        `UPDATE pull_requests SET base_ref = ?, land_target = ?, updated_at = ?
          WHERE id = ? AND base_ref = ? AND state = 'open'`
      )
      .bind(
        r.to,
        r.landTarget,
        Math.floor(now / 1000),
        r.pullRequestId,
        r.from
      ),
    // changes(): rows the UPDATE above changed (same transaction, the statement just before).
    d1
      .prepare(
        `INSERT INTO pr_events (id, repository_id, pull_request_id, kind, state, data, actor_id, computed_at, created_at)
         SELECT ?, ?, ?, ?, NULL, ?, NULL, ?, ? WHERE changes() = 1
         ON CONFLICT (id) DO NOTHING`
      )
      .bind(
        r.event.id,
        r.repositoryId,
        r.pullRequestId,
        r.event.kind,
        JSON.stringify(r.event.data),
        now,
        now
      ),
  ]);
  return (update.meta?.changes ?? 0) > 0;
}
