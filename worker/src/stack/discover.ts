import { and, desc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  prClassifications,
  prEdges,
  pullRequests,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import type { FileChange, GitService } from '../git/service';
import { pingingSteps } from '../live/publish';
import { recordEvent } from '../pulls/events';
import { findRepoById, gitFor } from '../lib/repos';
import { pullRef } from '../merge/land';
import type { StepRunner } from '../merge/resolution';
import { reviewConfigured } from '../review/head';
import { headReviewFor, hasInvitedAgents } from '../review/keys';
import { diffsFor, MODEL_RETRIES, summaryLines } from '../review/detail';
import { ignoreMatcher, readIgnore } from '../review/ignore';
import { STACKING_DEFAULTS, stackingTuning } from './defaults';
import {
  readDecision,
  routeDecision,
  type PrSide,
  type StackModels,
} from './models';
import { landTargetIs, landTargetOf } from '../lib/land-target';
import { maybeAutoMerge } from '../review/auto-merge';
import { executeReconcile } from './reconcile';

export type StackParams = { pullRequestId: string };

/** Each side's diff budget for the deep dive. */
const MAX_SIDE_DIFF = 60 * 1024;
/** Landed PRs considered: merged into the target within this window. */
const LANDED_WINDOW_MS = 30 * 24 * 3600 * 1000;
const MAX_LANDED = 20;
/** A pair still in triage, deep or recheck this long after its claim belongs to a run that died: re-arm it. */
export const PENDING_STALE_MS = 30 * 60 * 1000;
/** Per-side caps that keep the `load` step's result well under Workflows' 1 MiB limit. */
const MAX_DESCRIPTION = 4 * 1024;
const MAX_SUMMARIES = 16 * 1024;
const MAX_SHARED = 300;

/** `text` cut to whole lines within `max` characters, saying how many lines were left out. */
function capLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const lines = text.split('\n');
  let kept = 0;
  let size = 0;
  while (kept < lines.length && size + lines[kept].length + 1 <= max)
    size += lines[kept++].length + 1;
  return `${lines.slice(0, kept).join('\n')}\n…and ${lines.length - kept} more files`;
}

/**
 * Starts a stack run for the PR's current head and base. Where agents review, waits until the head's review has
 * finished (the run reads its one-liners). Returns whether one was started.
 */
export async function ensureStacking(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest,
  shas: { base: string; head: string }
): Promise<boolean> {
  if (!reviewConfigured(env) || pr.state !== 'open') return false;
  if (await hasInvitedAgents(db, pr.repositoryId)) {
    const review = await headReviewFor(db, pr.id, shas.head);
    if (!review || (review.status !== 'done' && review.status !== 'failed'))
      return false;
  }
  const id = `stack-${pr.id}-${shas.head.slice(0, 12)}-${shas.base.slice(0, 12)}`;
  try {
    await env.MERGE_RESOLUTION.create({
      id,
      params: { stack: { pullRequestId: pr.id } },
    });
    return true;
  } catch (e) {
    // Already started for these commits (instance ids are unique), or Workflows is unavailable.
    console.warn('[stack] not started', id, e);
    return false;
  }
}

/** What a PR changes relative to `targetSha`, from their merge base. */
export async function changesFor(
  git: GitService,
  targetSha: string,
  headSha: string
): Promise<FileChange[]> {
  const mb = await git.mergeBase(targetSha, headSha);
  const [from, to] = await Promise.all([
    mb ? git.commit(mb) : null,
    git.commit(headSha),
  ]);
  if (!to) return [];
  return git.diffTrees(from?.treeHash ?? null, to.treeHash);
}

/** One-liners from the PR's latest review at `head`; plain paths when it has none. */
export async function summariesFor(
  db: DrizzleDB,
  pullRequestId: string,
  head: string,
  changes: FileChange[]
): Promise<string> {
  const review = await db
    .select({ files: prClassifications.files })
    .from(prClassifications)
    .where(
      and(
        eq(prClassifications.pullRequestId, pullRequestId),
        eq(prClassifications.headSha, head)
      )
    )
    .orderBy(desc(prClassifications.createdAt))
    .get();
  if (review?.files?.length) return summaryLines(review.files);
  return changes.map((c) => `- ${c.path}`).join('\n');
}

type Side = PrSide & {
  id: string;
  head: string;
  headRef: string;
  /** The commit its changes are measured from: the target tip, or a landed PR's merge parent. */
  target: string;
};
/** A candidate also carries the files it shares with the PR being stacked (capped). */
type Candidate = Side & { shared: string[] };

/** Runs discovery for one PR against every candidate (MERGE_RESOLUTION Workflow). */
export async function executeStacking(
  deps: {
    env: CloudflareBindings;
    db: DrizzleDB;
    step: StepRunner;
    models: StackModels;
    /** Tests only: overrides the built-in tuning. */
    tuning?: Partial<typeof STACKING_DEFAULTS>;
  },
  params: StackParams
): Promise<void> {
  const { env, db, models } = deps;
  const job = await deps.step.do('load', async () => {
    const pr = await db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.id, params.pullRequestId))
      .get();
    if (!pr || pr.state !== 'open') return null;
    const found = await findRepoById(db, pr.repositoryId);
    if (!found) return null;
    const git = gitFor(env, found.repo);
    const [target, head] = await Promise.all([
      git.resolve(landTargetOf(pr)),
      git.resolve(pr.headRef),
    ]);
    if (!target || !head) return null;
    const policy = stackingTuning(deps.tuning);
    const side = async (
      p: PullRequest,
      h: string,
      base: string,
      landed: boolean
    ): Promise<Side & { paths: string[] }> => {
      const changes = await changesFor(git, base, h);
      return {
        id: p.id,
        number: p.number,
        title: p.title,
        description: p.body.slice(0, MAX_DESCRIPTION),
        summaries: capLines(
          await summariesFor(db, p.id, h, changes),
          MAX_SUMMARIES
        ),
        landed,
        head: h,
        headRef: p.headRef,
        target: base,
        paths: changes.map((c) => c.path),
      };
    };
    const { paths: myPaths, ...me } = await side(pr, head, target, false);
    const mine = new Set(myPaths);
    // Full path lists stay in this step; only the shared ones go into its result.
    const candidate = ({
      paths,
      ...s
    }: Side & { paths: string[] }): Candidate => ({
      ...s,
      shared: paths.filter((p) => mine.has(p)).slice(0, MAX_SHARED),
    });

    // Open PRs into the same target, newest first; beyond max_open only those sharing a file.
    const others = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, pr.repositoryId),
          eq(pullRequests.state, 'open'),
          landTargetIs(landTargetOf(pr))
        )
      )
      .orderBy(desc(pullRequests.number))
      .all();
    const refs = await git.refs();
    const candidates: Candidate[] = [];
    let triaged = 0;
    // Every push to the target re-runs every open PR's stack run, so a push costs O(N²) diffTrees across
    // the runs. Fine at max_open 20; revisit before raising the cap.
    for (const o of others) {
      if (o.id === pr.id) continue;
      const h = refs.get(`refs/heads/${o.headRef}`);
      if (!h) continue;
      const s = candidate(await side(o, h, target, false));
      const shares = s.shared.length > 0;
      if (triaged < policy.max_open - 1 || shares) candidates.push(s);
      triaged++;
    }

    // PRs landed into the target recently that this PR's head doesn't contain.
    const landed = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, pr.repositoryId),
          eq(pullRequests.state, 'merged'),
          landTargetIs(landTargetOf(pr))
        )
      )
      .orderBy(desc(pullRequests.mergedAt))
      .limit(MAX_LANDED)
      .all();
    const addLanded = async (l: PullRequest) => {
      if (!l.mergeCommitSha) return;
      const merge = await git.commit(l.mergeCommitSha);
      const h = refs.get(pullRef(l.number));
      if (!merge || !h) return;
      candidates.push(candidate(await side(l, h, merge.parents[0], true)));
    };
    for (const l of landed) {
      if (!l.mergeCommitSha || !l.mergedAt) continue;
      if (Date.now() - l.mergedAt.getTime() > LANDED_WINDOW_MS) continue;
      if ((await git.mergeBase(l.mergeCommitSha, head)) === l.mergeCommitSha)
        continue; // already in this PR's history
      await addLanded(l);
    }
    // Landed prerequisites this PR still has to account for are re-checked whatever their age, and even once
    // its head contains them (the dependent rebased onto them): otherwise it would stay blocked for good.
    const owed = await db
      .select({ a: prEdges.prAId, b: prEdges.prBId })
      .from(prEdges)
      .where(
        and(
          eq(prEdges.slot, 'pair'),
          eq(prEdges.kind, 'must_account_for'),
          isNull(prEdges.dismissedAt),
          isNull(prEdges.accountedForAt),
          or(
            and(eq(prEdges.prBId, pr.id), eq(prEdges.prerequisite, 'a')),
            and(eq(prEdges.prAId, pr.id), eq(prEdges.prerequisite, 'b'))
          )
        )
      )
      .all();
    const have = new Set(candidates.map((c) => c.id));
    for (const e of owed) {
      const id = e.a === pr.id ? e.b : e.a;
      if (have.has(id)) continue;
      const l = await db
        .select()
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.id, id),
            eq(pullRequests.state, 'merged'),
            landTargetIs(landTargetOf(pr))
          )
        )
        .get();
      if (l) {
        have.add(id);
        await addLanded(l);
      }
    }
    const ignoreText = await readIgnore(git, target);
    return {
      repo: found.repo,
      landTarget: landTargetOf(pr),
      policy,
      me,
      candidates,
      ignoreText,
    };
  });
  if (!job) return;
  const step = pingingSteps(env, deps.step, job.repo.id);
  const git = gitFor(env, job.repo as Repository);
  const ignored = ignoreMatcher(job.ignoreText);

  type Claim =
    | { mode: 'skip' }
    | { mode: 'fresh'; wasAccounted: boolean; dismissed: boolean }
    | {
        mode: 'recheck';
        prerequisite: 'a' | 'b';
        reason: string;
        instructions: string | null;
      };
  // The reasoning model reads the diffs: `focus` files first, then the rest within budget.
  const diffsOf = async (s: Side, focus: string[]) => {
    const changes = await changesFor(git, s.target, s.head);
    const text = await diffsFor(git, changes, focus, ignored, false);
    return text.slice(0, MAX_SIDE_DIFF);
  };
  // Open PRs whose pair this run checked: discovery may have been all that held their auto-merge.
  const touched = new Set<string>();
  // Whether this run claimed any pair: a run that claimed nothing found nothing new to restack.
  let claimed = false;
  for (const other of job.candidates) {
    // a: the landed one, else the lower number.
    const [a, b] =
      other.landed || other.number < job.me.number
        ? [other, job.me]
        : [job.me, other];
    const pairOf = (x: string, y: string) =>
      and(eq(prEdges.prAId, x), eq(prEdges.prBId, y), eq(prEdges.slot, 'pair'));
    const claim = await step.do(
      `claim:${other.id}`,
      async (): Promise<Claim> => {
        // One pair row per unordered pair. A reverse-oriented row exists only because the other side landed
        // (landed PRs are always a): drop it only when this run is the landed orientation; otherwise this run
        // loaded before that landing and its view is stale.
        const reverse = await db
          .select({ id: prEdges.id })
          .from(prEdges)
          .where(pairOf(b.id, a.id))
          .get();
        if (reverse) {
          if (!a.landed) return { mode: 'skip' };
          await db.delete(prEdges).where(eq(prEdges.id, reverse.id));
        }
        const row = await db
          .select()
          .from(prEdges)
          .where(pairOf(a.id, b.id))
          .get();
        // In progress elsewhere, unless that run died (still pending long after its claim).
        const dead =
          row &&
          (row.stage === 'triage' ||
            row.stage === 'deep' ||
            row.stage === 'recheck') &&
          Date.now() - row.updatedAt.getTime() > PENDING_STALE_MS;
        if (
          row &&
          row.aHead === a.head &&
          row.bHead === b.head &&
          row.stage !== 'failed' &&
          !dead
        )
          return { mode: 'skip' };
        // Only the dependent moved since it was told to account for the prerequisite: re-check, don't re-decide.
        if (
          row &&
          // recheck: a re-check whose run died, re-armed by Retry.
          (row.stage === 'done' || row.stage === 'recheck') &&
          row.kind === 'must_account_for' &&
          row.prerequisite &&
          (row.prerequisite === 'a'
            ? row.aHead === a.head
            : row.bHead === b.head)
        ) {
          // Dismissed: it neither blocks nor needs re-checking.
          if (row.dismissedAt) return { mode: 'skip' };
          await db
            .update(prEdges)
            .set({
              aHead: a.head,
              bHead: b.head,
              stage: 'recheck',
              accountedForAt: null,
              accountedHead: null,
              errorMessage: null,
              updatedAt: new Date(),
            })
            .where(eq(prEdges.id, row.id));
          return {
            mode: 'recheck',
            prerequisite: row.prerequisite,
            reason: row.reason ?? '',
            instructions: row.instructions,
          };
        }
        const now = new Date();
        // dismissed_at is left alone: a maintainer's dismissal survives new heads.
        const values = {
          repositoryId: job.repo.id,
          landTarget: job.landTarget,
          prAId: a.id,
          prBId: b.id,
          slot: 'pair' as const,
          aHead: a.head,
          bHead: b.head,
          stage: 'triage' as const,
          kind: null,
          prerequisite: null,
          files: null,
          conflictFiles: null,
          reason: null,
          instructions: null,
          accountedForAt: null,
          accountedHead: null,
          errorMessage: null,
          updatedAt: now,
        };
        await db
          .insert(prEdges)
          .values({ id: crypto.randomUUID(), createdAt: now, ...values })
          .onConflictDoUpdate({
            target: [prEdges.prAId, prEdges.prBId, prEdges.slot],
            set: values,
          });
        return {
          mode: 'fresh',
          wasAccounted:
            !!row?.accountedForAt && row.kind === 'must_account_for',
          dismissed: !!row?.dismissedAt,
        };
      }
    );
    if (claim.mode === 'skip') continue;
    claimed = true;
    if (!other.landed) touched.add(other.id);

    // Compare-and-swap on the claimed heads: a newer run that re-claimed the pair at other heads keeps its row.
    // Returns whether this run still owns the row and should announce it: saved, and not dismissed.
    const save = async (set: Partial<typeof prEdges.$inferInsert>) => {
      const rows = await db
        .update(prEdges)
        .set({ ...set, updatedAt: new Date() })
        .where(
          and(
            eq(prEdges.prAId, a.id),
            eq(prEdges.prBId, b.id),
            eq(prEdges.slot, 'pair'),
            eq(prEdges.aHead, a.head),
            eq(prEdges.bHead, b.head)
          )
        )
        .returning({ id: prEdges.id, dismissedAt: prEdges.dismissedAt });
      return rows.length > 0 && !rows[0].dismissedAt;
    };
    // One event per pair, heads and kind: a retried step records it once.
    const eventId = (kind: string) =>
      `pair:${a.id}:${b.id}:${a.head}:${b.head}:${kind}`;
    const announceMust = (
      pre: Side,
      dep: Side,
      reason: string,
      instructions: string | null
    ) =>
      recordEvent(db, {
        id: eventId('must_account_for'),
        repositoryId: job.repo.id,
        pullRequestId: dep.id,
        kind: 'must_account_for',
        data: {
          pr: pre.number,
          reason,
          instructions,
          rebase_first: pre.landed ? null : pre.headRef,
        },
      });
    const sides = (pre: 'a' | 'b') =>
      pre === 'a' ? { pre: a, dep: b } : { pre: b, dep: a };
    // Did the dependent's head account for the prerequisite? A failure keeps blocking (stage done, error set);
    // `announceOnFail`: the dependent hasn't been told yet at these heads, so a failure posts the instructions.
    const recheck = async (
      pre: Side,
      dep: Side,
      reason: string,
      instructions: string | null,
      announceOnFail = false
    ) => {
      try {
        const result = await step.do(
          `recheck:${other.id}`,
          MODEL_RETRIES,
          async () =>
            models.recheck({
              prerequisite: {
                ...pre,
                diffs: await diffsOf(pre, other.shared),
              },
              dependent: { ...dep, diffs: await diffsOf(dep, other.shared) },
              reason,
              instructions,
            })
        );
        await step.do(`rechecked:${other.id}`, async () => {
          const still = result.instructions ?? instructions;
          const owned = await save({
            stage: 'done',
            accountedForAt: result.accounted ? new Date() : null,
            accountedHead: result.accounted ? dep.head : null,
            instructions: result.accounted ? instructions : still,
            errorMessage: null,
          });
          if (!owned) return true;
          if (result.accounted)
            await recordEvent(db, {
              id: eventId('accounted_for'),
              repositoryId: job.repo.id,
              pullRequestId: dep.id,
              kind: 'accounted_for',
              data: { pr: pre.number, reason: result.reason },
            });
          else await announceMust(pre, dep, result.reason, still);
          return true;
        });
      } catch (e) {
        console.error('[stack] re-check failed', a.number, b.number, e);
        await step.do(`recheck-failed:${other.id}`, async () => {
          const owned = await save({
            stage: 'done',
            errorMessage: `Re-check failed: ${e instanceof Error ? e.message : String(e)}`,
          });
          if (owned && announceOnFail)
            await announceMust(pre, dep, reason, instructions);
          return true;
        });
      }
    };
    if (claim.mode === 'recheck') {
      const { pre, dep } = sides(claim.prerequisite);
      await recheck(pre, dep, claim.reason, claim.instructions);
      continue;
    }

    try {
      // Textual check: only possible between two open heads that share a file.
      const shared = other.shared;
      const conflicts = await step.do(`conflicts:${other.id}`, async () => {
        if (a.landed || !shared.length) return [] as string[];
        const plan = await git.planMerge(a.head, b.head);
        return plan.upToDate ? [] : plan.conflicts;
      });
      // Clef decides, over the one-liners: related? which kind? which side first?
      const answers = await step.do(`decide:${other.id}`, MODEL_RETRIES, () =>
        models.decide(job.policy.model, {
          a,
          b,
          sharedFiles: shared,
          conflicts,
        })
      );
      const route = routeDecision(readDecision(answers), {
        relatedAbove: job.policy.related_above,
        confidentAbove: job.policy.confident_above,
        conflicts: conflicts.length > 0,
        aLanded: a.landed,
      });
      if (route.action === 'independent') {
        await step.do(`independent:${other.id}`, async () => {
          await save({
            stage: 'done',
            kind: 'independent',
            files: shared,
            reason: 'Unrelated.',
          });
          return true;
        });
        continue;
      }
      await step.do(`deep:${other.id}`, async () => {
        await save({ stage: 'deep', conflictFiles: conflicts });
        return true;
      });
      // Shared and conflicting files first.
      const focus = [...new Set([...conflicts, ...shared])];
      const decided =
        route.action === 'explain'
          ? { kind: route.kind, prerequisite: route.prerequisite }
          : null;
      const relation = await step.do(
        `explain:${other.id}`,
        MODEL_RETRIES,
        async () =>
          models.explain({
            a: { ...a, diffs: await diffsOf(a, focus) },
            b: { ...b, diffs: await diffsOf(b, focus) },
            conflicts,
            decided,
          })
      );
      // Clef's confident decision stands whatever the explanation says; a conflict always counts.
      let kind = decided?.kind ?? relation.kind;
      let prerequisite = decided?.prerequisite ?? relation.prerequisite;
      if (kind === 'independent' && conflicts.length) kind = 'conflicts';
      if (kind === 'conflicts' && !prerequisite) prerequisite = 'a';
      await step.do(`save:${other.id}`, async () => {
        const owned = await save({
          stage: 'done',
          kind,
          prerequisite: kind === 'independent' ? null : prerequisite,
          files: focus,
          reason: relation.reason,
          instructions:
            kind === 'must_account_for' ? relation.instructions : null,
        });
        // Accounted for before: the re-check below announces its outcome instead.
        if (
          owned &&
          kind === 'must_account_for' &&
          prerequisite &&
          !claim.wasAccounted
        ) {
          const { pre, dep } = sides(prerequisite);
          await announceMust(pre, dep, relation.reason, relation.instructions);
        }
        return true;
      });
      // Accounted for before both heads moved, and still must account for: re-check now rather than wait.
      if (
        kind === 'must_account_for' &&
        prerequisite &&
        claim.wasAccounted &&
        !claim.dismissed
      ) {
        const { pre, dep } = sides(prerequisite);
        await recheck(pre, dep, relation.reason, relation.instructions, true);
      }
    } catch (e) {
      console.error('[stack] pair failed', a.number, b.number, e);
      await step.do(`fail:${other.id}`, async () => {
        await save({
          stage: 'failed',
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        return true;
      });
    }
  }
  // Restack the land target with what this run found. A failing reconcile never stops auto-merge below.
  if (claimed)
    try {
      await executeReconcile(
        { env, db, step: deps.step, models },
        { repositoryId: job.repo.id, landTarget: job.landTarget },
        'stack-'
      );
    } catch (e) {
      console.error('[stack] reconcile failed', job.repo.id, job.landTarget, e);
    }
  // Discovery held auto-merge for these heads; now that it has checked them, try again. Never fails the run.
  await step.do('auto-merge', async () => {
    for (const id of [params.pullRequestId, ...touched])
      try {
        await maybeAutoMerge(env, db, id);
      } catch (e) {
        console.error('[stack] auto-merge failed', id, e);
      }
    return true;
  });
}

/**
 * Forgets the PR's failed pairs so a new run checks them again, and starts that run. Changes nothing when
 * AI isn't configured (`off`); `unavailable` when the run could not be started.
 */
export async function retryFailedPairs(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest,
  shas: { base: string; head: string }
): Promise<'started' | 'off' | 'unavailable'> {
  if (!reviewConfigured(env)) return 'off';
  // A retried run needs a new instance id: suffix with the time.
  const id = `stack-${pr.id}-${shas.head.slice(0, 12)}-retry-${Date.now()}`;
  // Failed pairs, and pairs stuck mid-check by a run that died, are checked again from scratch.
  await db
    .delete(prEdges)
    .where(
      and(
        eq(prEdges.slot, 'pair'),
        or(
          eq(prEdges.stage, 'failed'),
          and(
            inArray(prEdges.stage, ['triage', 'deep']),
            lt(prEdges.updatedAt, new Date(Date.now() - PENDING_STALE_MS))
          )
        ),
        or(eq(prEdges.prAId, pr.id), eq(prEdges.prBId, pr.id))
      )
    );
  // A failed re-check still blocks; forgetting the dependent's head makes the next run re-check it.
  // A re-check stuck at stage 'recheck' (its run died) is re-armed too.
  const failedRecheck = and(
    eq(prEdges.slot, 'pair'),
    eq(prEdges.kind, 'must_account_for'),
    isNull(prEdges.accountedForAt),
    isNull(prEdges.dismissedAt),
    or(isNotNull(prEdges.errorMessage), eq(prEdges.stage, 'recheck'))
  );
  await db
    .update(prEdges)
    .set({ bHead: '' })
    .where(
      and(
        failedRecheck,
        eq(prEdges.prerequisite, 'a'),
        eq(prEdges.prBId, pr.id)
      )
    );
  await db
    .update(prEdges)
    .set({ aHead: '' })
    .where(
      and(
        failedRecheck,
        eq(prEdges.prerequisite, 'b'),
        eq(prEdges.prAId, pr.id)
      )
    );
  try {
    await env.MERGE_RESOLUTION.create({
      id,
      params: { stack: { pullRequestId: pr.id } },
    });
    return 'started';
  } catch (e) {
    console.error('[stack] retry not started', id, e);
    return 'unavailable';
  }
}
