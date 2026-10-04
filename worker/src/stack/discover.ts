import { and, desc, eq, or } from 'drizzle-orm';
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
import { findRepoById, gitFor } from '../lib/repos';
import { pullRef } from '../merge/land';
import type { StepRunner } from '../merge/resolution';
import {
  classificationFor,
  diffsFor,
  MODEL_RETRIES,
  reviewConfigured,
} from '../review/classify';
import { ignoreMatcher, readIgnore } from '../review/ignore';
import { parsePolicy, readPolicy } from '../review/policy';
import {
  readDecision,
  routeDecision,
  type PrSide,
  type StackModels,
} from './models';

export type StackParams = { pullRequestId: string };

/** Each side's diff budget for the deep dive. */
const MAX_SIDE_DIFF = 60 * 1024;
/** Landed PRs considered: merged into the target within this window. */
const LANDED_WINDOW_MS = 30 * 24 * 3600 * 1000;
const MAX_LANDED = 20;
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

/** The stacking section of the target branch's review.yml; null when off or invalid. */
async function stackingPolicy(git: GitService, baseSha: string) {
  const file = await readPolicy(git, baseSha);
  if (!file) return null;
  try {
    const p = parsePolicy(file.text);
    return p.stacking.enabled
      ? { ...p.stacking, model: p.model, policySha: file.sha }
      : null;
  } catch {
    return null;
  }
}

/**
 * Starts a stack run for the PR's current head and base, once its auto-merge review has finished
 * (the run reads its summaries). Returns whether one was started.
 */
export async function ensureStacking(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest,
  shas: { base: string; head: string }
): Promise<boolean> {
  if (!reviewConfigured(env) || pr.state !== 'open') return false;
  const policy = await stackingPolicy(git, shas.base);
  if (!policy) return false;
  const review = await classificationFor(
    db,
    pr.id,
    shas.head,
    policy.policySha
  );
  if (!review || (review.status !== 'done' && review.status !== 'failed'))
    return false;
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
async function changesFor(
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
async function summariesFor(
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
  if (review?.files?.length)
    return review.files
      .map((f) => `- ${f.path} (${f.status}): ${f.summary}`)
      .join('\n');
  return changes.map((c) => `- ${c.path}`).join('\n');
}

type Side = PrSide & {
  id: string;
  head: string;
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
      git.resolve(pr.baseRef),
      git.resolve(pr.headRef),
    ]);
    if (!target || !head) return null;
    const policy = await stackingPolicy(git, target);
    if (!policy) return null;
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
          eq(pullRequests.baseRef, pr.baseRef)
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
          eq(pullRequests.baseRef, pr.baseRef)
        )
      )
      .orderBy(desc(pullRequests.mergedAt))
      .limit(MAX_LANDED)
      .all();
    for (const l of landed) {
      if (!l.mergeCommitSha || !l.mergedAt) continue;
      if (Date.now() - l.mergedAt.getTime() > LANDED_WINDOW_MS) continue;
      if ((await git.mergeBase(l.mergeCommitSha, head)) === l.mergeCommitSha)
        continue; // already in this PR's history
      const merge = await git.commit(l.mergeCommitSha);
      const h = refs.get(pullRef(l.number));
      if (!merge || !h) continue;
      candidates.push(candidate(await side(l, h, merge.parents[0], true)));
    }
    const ignoreText = await readIgnore(git, target);
    return {
      repo: found.repo,
      landTarget: pr.baseRef,
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

  for (const other of job.candidates) {
    // a: the landed one, else the lower number.
    const [a, b] =
      other.landed || other.number < job.me.number
        ? [other, job.me]
        : [job.me, other];
    const fresh = await step.do(`claim:${other.id}`, async () => {
      // One row per unordered pair: once the higher-numbered PR lands it becomes a, so drop the old orientation.
      await db
        .delete(prEdges)
        .where(and(eq(prEdges.prAId, b.id), eq(prEdges.prBId, a.id)));
      const row = await db
        .select()
        .from(prEdges)
        .where(and(eq(prEdges.prAId, a.id), eq(prEdges.prBId, b.id)))
        .get();
      if (
        row &&
        row.aHead === a.head &&
        row.bHead === b.head &&
        row.stage !== 'failed'
      )
        return false;
      const now = new Date();
      const values = {
        repositoryId: job.repo.id,
        landTarget: job.landTarget,
        prAId: a.id,
        prBId: b.id,
        aHead: a.head,
        bHead: b.head,
        stage: 'triage' as const,
        kind: null,
        prerequisite: null,
        files: null,
        conflictFiles: null,
        reason: null,
        instructions: null,
        errorMessage: null,
        updatedAt: now,
      };
      await db
        .insert(prEdges)
        .values({ id: crypto.randomUUID(), createdAt: now, ...values })
        .onConflictDoUpdate({
          target: [prEdges.prAId, prEdges.prBId],
          set: values,
        });
      return true;
    });
    if (!fresh) continue;

    // Compare-and-swap on the claimed heads: a newer run that re-claimed the pair at other heads keeps its row.
    const save = (set: Partial<typeof prEdges.$inferInsert>) =>
      db
        .update(prEdges)
        .set({ ...set, updatedAt: new Date() })
        .where(
          and(
            eq(prEdges.prAId, a.id),
            eq(prEdges.prBId, b.id),
            eq(prEdges.aHead, a.head),
            eq(prEdges.bHead, b.head)
          )
        );

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
      // The reasoning model reads the diffs: shared and conflicting files first, then the rest within budget.
      const focus = [...new Set([...conflicts, ...shared])];
      const diffs = async (s: Side) => {
        const changes = await changesFor(git, s.target, s.head);
        const text = await diffsFor(git, changes, focus, ignored, false);
        return text.slice(0, MAX_SIDE_DIFF);
      };
      const decided =
        route.action === 'explain'
          ? { kind: route.kind, prerequisite: route.prerequisite }
          : null;
      const relation = await step.do(
        `explain:${other.id}`,
        MODEL_RETRIES,
        async () =>
          models.explain({
            a: { ...a, diffs: await diffs(a) },
            b: { ...b, diffs: await diffs(b) },
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
        await save({
          stage: 'done',
          kind,
          prerequisite: kind === 'independent' ? null : prerequisite,
          files: focus,
          reason: relation.reason,
          instructions:
            kind === 'must_account_for' ? relation.instructions : null,
        });
        return true;
      });
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
}

/**
 * Forgets the PR's failed pairs so a new run checks them again, and starts that run. Changes nothing when
 * stacking is off for the PR's target (`off`); `unavailable` when the run could not be started.
 */
export async function retryFailedPairs(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest,
  shas: { base: string; head: string }
): Promise<'started' | 'off' | 'unavailable'> {
  if (!reviewConfigured(env) || !(await stackingPolicy(git, shas.base)))
    return 'off';
  // A retried run needs a new instance id: suffix with the time.
  const id = `stack-${pr.id}-${shas.head.slice(0, 12)}-retry-${Date.now()}`;
  await db
    .delete(prEdges)
    .where(
      and(
        eq(prEdges.stage, 'failed'),
        or(eq(prEdges.prAId, pr.id), eq(prEdges.prBId, pr.id))
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
