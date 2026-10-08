import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import { prEdges, pullRequests, type PullRequest } from '../db/app.schema';
import { landTargetIs, landTargetOf } from '../lib/land-target';
import { ensureRebase } from '../merge/rebase';
import { resolutionConfigured } from '../merge/resolution';
import { findRepoById, gitFor } from '../lib/repos';
import { d1Of, recordEvent } from '../pulls/events';
import { settleStates } from '../pulls/settle';

/** Starts a reconcile run for a land target (no-op without the Workflow binding). Never throws. */
export async function startReconcile(
  env: CloudflareBindings,
  repositoryId: string,
  landTarget: string
): Promise<void> {
  if (!resolutionConfigured(env)) return;
  try {
    await env.MERGE_RESOLUTION.create({
      id: `reconcile-${crypto.randomUUID()}`,
      params: { reconcile: { repositoryId, landTarget } },
    });
  } catch (e) {
    console.error('[stack] could not start reconcile', repositoryId, e);
  }
}

/**
 * A PR closed or landed: the PRs stacked on its branch go back to its land target now (metadata only), the
 * ordering edges that involved it are dropped, a landing ends dismissals of its pairs, and a reconcile run
 * restacks what's left. Its pair rows are kept
 * (ignored while it's closed), so a reopen restores them. Never throws.
 */
export async function onPullClosed(
  env: CloudflareBindings,
  db: DrizzleDB,
  pr: PullRequest,
  how: 'closed' | 'landed'
): Promise<void> {
  try {
    const target = landTargetOf(pr);
    const children = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, pr.repositoryId),
          eq(pullRequests.state, 'open'),
          eq(pullRequests.baseRef, pr.headRef),
          landTargetIs(target)
        )
      )
      .all();
    let moved = 0;
    const movedChildren: PullRequest[] = [];
    for (const c of children) {
      // Compare-and-swap: a racing reconcile or close moves it once.
      const res = await db
        .update(pullRequests)
        .set({ baseRef: target, landTarget: target, updatedAt: new Date() })
        .where(
          and(
            eq(pullRequests.id, c.id),
            eq(pullRequests.baseRef, pr.headRef),
            eq(pullRequests.state, 'open')
          )
        )
        .returning({ id: pullRequests.id });
      if (!res.length) continue;
      moved++;
      movedChildren.push({ ...c, baseRef: target, landTarget: target });
      await recordEvent(db, {
        // One per version of the child's row: deterministic, so a repeat records it once.
        id: `unstacked:${c.id}:${pr.id}:${c.updatedAt.getTime()}`,
        repositoryId: pr.repositoryId,
        pullRequestId: c.id,
        kind: 'unstacked',
        data: {
          pr: pr.number,
          why:
            how === 'landed'
              ? `#${pr.number} landed.`
              : `#${pr.number} was closed without landing.`,
        },
      });
    }
    // A dismissal lasts until either side lands: the landed PR's pairs count again. A must-account-for it is the
    // prerequisite of also forgets the dependent's head (as Retry does), so the next run re-checks that head
    // rather than skipping a pair it already saw.
    if (how === 'landed') {
      const dismissedMust = and(
        eq(prEdges.slot, 'pair'),
        eq(prEdges.kind, 'must_account_for'),
        isNotNull(prEdges.dismissedAt),
        isNull(prEdges.accountedForAt)
      );
      await db
        .update(prEdges)
        .set({ dismissedAt: null, dismissedById: null, bHead: '' })
        .where(
          and(
            dismissedMust,
            eq(prEdges.prerequisite, 'a'),
            eq(prEdges.prAId, pr.id)
          )
        );
      await db
        .update(prEdges)
        .set({ dismissedAt: null, dismissedById: null, aHead: '' })
        .where(
          and(
            dismissedMust,
            eq(prEdges.prerequisite, 'b'),
            eq(prEdges.prBId, pr.id)
          )
        );
      await db
        .update(prEdges)
        .set({ dismissedAt: null, dismissedById: null })
        .where(
          and(
            eq(prEdges.slot, 'pair'),
            isNotNull(prEdges.dismissedAt),
            or(eq(prEdges.prAId, pr.id), eq(prEdges.prBId, pr.id))
          )
        );
    }
    await db
      .delete(prEdges)
      .where(
        and(
          eq(prEdges.slot, 'order'),
          or(
            eq(prEdges.prAId, pr.id),
            eq(prEdges.prBId, pr.id),
            eq(prEdges.forPrId, pr.id)
          )
        )
      );
    // Old and new base share the land target: one scoped settle covers both.
    if (moved) await settleStates(env, db, pr.repositoryId, { branch: target });
    // Children now on the land target rebase onto it; so may an open PR sharing its head into another base (it
    // wasn't rebased while this one was open: rebaseBlocked).
    const sharing = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, pr.repositoryId),
          eq(pullRequests.state, 'open'),
          eq(pullRequests.headRef, pr.headRef)
        )
      )
      .all();
    const toRebase = [
      ...movedChildren,
      ...sharing.filter((p) => p.id !== pr.id),
    ];
    if (toRebase.length) {
      const found = await findRepoById(db, pr.repositoryId);
      if (found)
        for (const c of toRebase)
          await ensureRebase(env, db, gitFor(env, found.repo), c);
    }
    await startReconcile(env, pr.repositoryId, target);
  } catch (e) {
    console.error('[stack] unwinding failed', pr.id, e);
  }
}

/** Dismisses every edge between `pr` and #`other` (a maintainer's decision; survives new heads). */
export async function dismissEdge(
  env: CloudflareBindings,
  db: DrizzleDB,
  pr: PullRequest,
  other: number,
  actorId: string
): Promise<'dismissed' | 'not_found'> {
  const o = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, pr.repositoryId),
        eq(pullRequests.number, other)
      )
    )
    .get();
  if (!o) return 'not_found';
  const between = or(
    and(eq(prEdges.prAId, pr.id), eq(prEdges.prBId, o.id)),
    and(eq(prEdges.prAId, o.id), eq(prEdges.prBId, pr.id))
  );
  const now = Date.now();
  const d1 = d1Of(db);
  const eventId = `dismissed:${pr.id}:${o.id}:${now}`;
  // One transaction: the edges and their timeline entry are dismissed together, so a crash can't lose the event.
  const [update] = await d1.batch([
    d1
      .prepare(
        `UPDATE pr_edges SET dismissed_at = ?, dismissed_by_id = ?, updated_at = ?
          WHERE ((pr_a_id = ? AND pr_b_id = ?) OR (pr_a_id = ? AND pr_b_id = ?)) AND dismissed_at IS NULL`
      )
      .bind(
        Math.floor(now / 1000),
        actorId,
        Math.floor(now / 1000),
        pr.id,
        o.id,
        o.id,
        pr.id
      ),
    // changes(): rows the UPDATE above changed (same transaction, the statement just before).
    d1
      .prepare(
        `INSERT INTO pr_events (id, repository_id, pull_request_id, kind, state, data, actor_id, computed_at, created_at)
         SELECT ?, ?, ?, 'dismissed', NULL, ?, ?, ?, ? WHERE changes() > 0
         ON CONFLICT (id) DO NOTHING`
      )
      .bind(
        eventId,
        pr.repositoryId,
        pr.id,
        JSON.stringify({ pr: other }),
        actorId,
        now,
        now
      ),
  ]);
  let did = (update.meta?.changes ?? 0) > 0;
  const target = landTargetOf(pr);
  if (pr.baseRef === o.headRef && pr.baseRef !== target) {
    // Compare-and-swap, like a reconcile's retarget: a racing reconcile moves it once.
    const moved = await db
      .update(pullRequests)
      .set({ baseRef: target, landTarget: target, updatedAt: new Date() })
      .where(
        and(
          eq(pullRequests.id, pr.id),
          eq(pullRequests.baseRef, o.headRef),
          eq(pullRequests.state, 'open')
        )
      )
      .returning({ id: pullRequests.id });
    if (moved.length) {
      did = true;
      await recordEvent(db, {
        id: `unstacked:${pr.id}:${o.id}:${now}`,
        repositoryId: pr.repositoryId,
        pullRequestId: pr.id,
        kind: 'unstacked',
        data: { pr: other, why: 'A maintainer unstacked it.' },
        actorId,
      });
      await settleStates(env, db, pr.repositoryId, { branch: target });
      // Now on the land target: it rebases onto it.
      const found = await findRepoById(db, pr.repositoryId);
      if (found)
        await ensureRebase(env, db, gitFor(env, found.repo), {
          ...pr,
          baseRef: target,
          landTarget: target,
        });
    }
  }
  if (!did) return 'not_found';
  await startReconcile(env, pr.repositoryId, target);
  return 'dismissed';
}
