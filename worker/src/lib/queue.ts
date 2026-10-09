import { and, desc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import {
  agents,
  prClassifications,
  pullRequests,
  repositories,
  workflowRuns,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import type { GitService } from '../git/service';
import { mergingPause } from '../merge/land';
import { latestStates } from '../pulls/events';
import { pullStates } from '../pulls/signals';
import type { PullState, Reason } from '../pulls/state';
import { autoMergeRepository } from '../review/auto-merge';
import { reviewConfigured } from '../review/head';
import { stackTreeView, type StackTreeView } from '../stack/view';
import { recordAudit } from './audit';
import { landTargetOf } from './land-target';
import { GHOST, personRefs, type PersonRef } from './person-ref';

// The merge queue: per land target, the open pull requests in the order they are expected to land, what holds each
// back (from its computed state, never stored) and a rough estimate of when it lands. Pausing merging is per
// repository (repositories.merging_paused_at): landPull refuses while it is set, for the merge button, MCP and
// auto-merge alike, and every open pull request shows the `merging_paused` reason.

export type QueuePause = { at: number; by: PersonRef } | null;

export type QueueEntry = {
  /** 1 is next to land. */
  position: number;
  number: number;
  title: string;
  author: PersonRef;
  /** The app that opened it; null means by hand. */
  createdVia: string | null;
  /** The session label that app reported. */
  session: string | null;
  /** Its pull request state (`agent_followup`, `human_review`, `waiting`, `ready`). */
  state: string;
  /** What holds it back, in plain words, most urgent first; empty when it is ready. */
  blockers: string[];
  /** Minutes until it is expected to land; null without enough history to guess. */
  etaMinutes: number | null;
};

export type QueueTarget = {
  target: string;
  paused: QueuePause;
  entries: QueueEntry[];
};

/** How many recent runs and reviews the estimate takes the median of. */
const ETA_HISTORY = 10;

/**
 * Landing order: oldest first (by when opened, then number), except that a pull request's prerequisites (what it is
 * stacked on, or waits on) come right before it. A circle, which the stack tree never yields, still lists each once.
 */
export function queueOrder(
  prs: { number: number; createdAt: number }[],
  prerequisites: Map<number, number[]>
): number[] {
  const oldest = [...prs].sort(
    (a, b) => a.createdAt - b.createdAt || a.number - b.number
  );
  const rank = new Map(oldest.map((p, i) => [p.number, i]));
  const out: number[] = [];
  const placed = new Set<number>();
  const visiting = new Set<number>();
  const place = (n: number) => {
    if (placed.has(n) || visiting.has(n) || !rank.has(n)) return;
    visiting.add(n);
    for (const p of [...(prerequisites.get(n) ?? [])].sort(
      (a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)
    ))
      place(p);
    visiting.delete(n);
    placed.add(n);
    out.push(n);
  };
  for (const p of oldest) place(p.number);
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A reason as the queue says what holds a pull request back. `nameOf` turns an agent's handle into its name. */
export function blockerText(
  r: Reason,
  nameOf: (handle: string) => string = (h) => h
): string {
  switch (r.kind) {
    case 'check_failed':
      return r.check ? `The ${r.check} check failed` : 'Tests failed';
    case 'changes_requested':
      return `A person asked for changes on ${plural(r.flags, 'finding')}`;
    case 'rebase_conflict':
      return r.files.length
        ? `Clashes with newer changes in ${r.files.join(', ')}`
        : 'Clashes with newer changes';
    case 'must_account_for':
      return `Must account for #${r.pr} first`;
    case 'rebase_onto':
      return `Being updated to build on #${r.pr}`;
    case 'cycle':
      return `Depends in a circle on ${r.prs.map((n) => `#${n}`).join(', ')}`;
    case 'checks_running':
      if (!r.started) return 'Waiting for tests to start';
      return r.check ? `The ${r.check} check is running` : 'Tests are running';
    case 'resolution_running':
      return 'GitOrange is fixing a clash';
    case 'stack_checking':
      return 'Checking how it relates to other pull requests';
    case 'stacked_on':
      return `Lands after #${r.pr}`;
    case 'waits_on':
      return `Waits on #${r.pr}`;
    case 'agent_reviewing':
      return r.agent ? `${nameOf(r.agent)} is reviewing it` : 'Being reviewed';
    case 'agent_flagged':
      return `${nameOf(r.agent)} needs a person to decide ${plural(r.flags.length, 'finding')}`;
    case 'agent_changes_requested':
      return `${nameOf(r.agent)} asked for ${plural(r.changes.length, 'change')}`;
    case 'agent_review_failed':
      return r.agent
        ? `${nameOf(r.agent)}’s review failed`
        : 'The review failed';
    case 'needs_approval':
      return 'Needs a person to approve it';
    case 'merging_paused':
      return 'Merging is paused';
  }
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * How long one pull request takes from a new head to landing, in milliseconds: the median of the last 10 completed
 * pull request Actions runs (created to completed) plus the median of the last 10 review durations. Null when the
 * repository has neither.
 */
export async function etaStepMs(
  db: DrizzleDB,
  repositoryId: string
): Promise<number | null> {
  const [runs, reviews] = await Promise.all([
    db
      .select({
        createdAt: workflowRuns.createdAt,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.repositoryId, repositoryId),
          eq(workflowRuns.event, 'pull_request'),
          eq(workflowRuns.status, 'completed'),
          ne(workflowRuns.conclusion, 'skipped'),
          isNotNull(workflowRuns.completedAt)
        )
      )
      .orderBy(desc(workflowRuns.runNumber))
      .limit(ETA_HISTORY)
      .all(),
    db
      .select({ ms: prClassifications.durationMs })
      .from(prClassifications)
      .innerJoin(
        pullRequests,
        eq(pullRequests.id, prClassifications.pullRequestId)
      )
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          isNotNull(prClassifications.durationMs)
        )
      )
      .orderBy(desc(prClassifications.createdAt))
      .limit(ETA_HISTORY)
      .all(),
  ]);
  const run = median(
    runs.map((r) =>
      Math.max(0, r.completedAt!.getTime() - r.createdAt.getTime())
    )
  );
  const review = median(reviews.map((r) => r.ms!));
  if (run === null && review === null) return null;
  return (run ?? 0) + (review ?? 0);
}

/** Each agent handle's name, for blockers that name an agent. */
async function agentNames(
  db: DrizzleDB,
  handles: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(handles)];
  if (!unique.length) return new Map();
  const rows = await db
    .select({ handle: users.username, name: agents.name })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(inArray(users.username, unique.slice(0, 90)))
    .all();
  return new Map(rows.flatMap((r) => (r.handle ? [[r.handle, r.name]] : [])));
}

/** The repository's pause as the queue shows it. */
async function pauseOf(
  db: DrizzleDB,
  repo: Pick<Repository, 'mergingPausedAt' | 'mergingPausedById'>,
  people?: Map<string, PersonRef>
): Promise<QueuePause> {
  if (!repo.mergingPausedAt) return null;
  const by = repo.mergingPausedById;
  const refs = people ?? (await personRefs(db, [by]));
  return {
    at: repo.mergingPausedAt.getTime(),
    by: (by && refs.get(by)) || GHOST,
  };
}

export type MergeQueue = {
  targets: QueueTarget[];
  /** The computed state of each open pull request, by id (for callers that show them too, such as the Live floor). */
  states: Map<string, PullState>;
};

/**
 * The merge queue of every land target: the default branch first (even with nothing in it, so its pause shows), then
 * the other targets with open pull requests, by name. Reads the open pull requests once, the stack tree once and their
 * states batched (`pullStates`); when the states can't be computed, the ones last recorded are used.
 */
export async function mergeQueue(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  repo: Repository
): Promise<MergeQueue> {
  const open = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repo.id),
        eq(pullRequests.state, 'open')
      )
    )
    .all();

  let tree: StackTreeView | undefined;
  let states = new Map<string, PullState>();
  if (open.length) {
    tree = await stackTreeView(db, git, repo.id, { authors: false }).catch(
      (e) => {
        console.error('[queue] stack tree failed', repo.id, e);
        return undefined;
      }
    );
    try {
      states = await pullStates(db, git, repo.id, open, {
        tree,
        reviewConfigured: reviewConfigured(env),
        mergingPaused: !!repo.mergingPausedAt,
      });
    } catch (e) {
      console.error('[queue] could not compute states', repo.id, e);
      states = await latestStates(
        db,
        open.map((p) => p.id)
      ).catch(() => new Map<string, PullState>());
    }
  }

  const handles = [...states.values()].flatMap((s) =>
    s.reasons.flatMap((r) => ('agent' in r && r.agent ? [r.agent] : []))
  );
  const [step, people, names] = await Promise.all([
    etaStepMs(db, repo.id),
    personRefs(db, [...open.map((p) => p.authorId), repo.mergingPausedById]),
    agentNames(db, handles),
  ]);
  const nameOf = (h: string) => names.get(h) ?? h;
  const paused = await pauseOf(db, repo, people);
  // Only for a pull request with no state: say which branch is gone.
  let refs: Map<string, string> | null = null;
  const missing = async (pr: PullRequest) => {
    try {
      refs ??= await git.refs();
    } catch {
      return 'Its state can’t be read right now';
    }
    if (!refs.has(`refs/heads/${pr.headRef}`))
      return 'Its branch no longer exists';
    if (!refs.has(`refs/heads/${landTargetOf(pr)}`))
      return 'The branch it merges into no longer exists';
    return 'Its state can’t be read right now';
  };

  const byTarget = new Map<string, PullRequest[]>();
  for (const p of open)
    byTarget.set(landTargetOf(p), [
      ...(byTarget.get(landTargetOf(p)) ?? []),
      p,
    ]);
  const branches = [
    repo.defaultBranch,
    ...[...byTarget.keys()].filter((b) => b !== repo.defaultBranch).sort(),
  ];

  const targets: QueueTarget[] = [];
  for (const branch of branches) {
    const prs = byTarget.get(branch) ?? [];
    const nodes = new Map(
      (tree?.targets.find((t) => t.branch === branch)?.nodes ?? []).map((n) => [
        n.number,
        n,
      ])
    );
    const prerequisites = new Map(
      prs.map((p) => {
        const n = nodes.get(p.number);
        return [
          p.number,
          n
            ? [
                ...(n.parent ? [n.parent.number] : []),
                ...n.waitsOn.map((d) => d.number),
              ]
            : [],
        ];
      })
    );
    const byNumber = new Map(prs.map((p) => [p.number, p]));
    const order = queueOrder(
      prs.map((p) => ({ number: p.number, createdAt: p.createdAt.getTime() })),
      prerequisites
    );
    let eta = 0;
    const entries: QueueEntry[] = [];
    for (const [i, number] of order.entries()) {
      const pr = byNumber.get(number)!;
      const s = states.get(pr.id);
      // The first ready one lands now; each after it waits for those ahead, then for its own checks and review on
      // the moved target.
      if (step !== null) eta += i === 0 && s?.state === 'ready' ? 0 : step;
      entries.push({
        position: i + 1,
        number,
        title: pr.title,
        author: people.get(pr.authorId) ?? GHOST,
        createdVia: pr.createdVia || null,
        session: pr.sessionLabel || null,
        state: s?.state ?? 'waiting',
        blockers: s
          ? [...new Set(s.reasons.map((r) => blockerText(r, nameOf)))]
          : [await missing(pr)],
        etaMinutes: step === null ? null : Math.ceil(eta / 60_000),
      });
    }
    targets.push({ target: branch, paused, entries });
  }
  return { targets, states };
}

/**
 * Pauses (`paused`) or resumes merging on the repository, as `user` (the caller checks push access). Recorded in the
 * audit log only when it changes anything, with the reason given for a pause. Resuming tries auto-merge on every
 * open pull request (`after`), since what became ready while paused waits for no other trigger. Returns the pause
 * as it now is.
 */
export async function setMergingPaused(opts: {
  env: CloudflareBindings;
  db: DrizzleDB;
  repo: Repository;
  repoFullName: string;
  user: { id: string };
  paused: boolean;
  reason?: string | null;
  after: (work: Promise<unknown>) => void;
}): Promise<QueuePause> {
  const { env, db, repo, user } = opts;
  if (opts.paused) {
    const changed = await db
      .update(repositories)
      .set({ mergingPausedAt: new Date(), mergingPausedById: user.id })
      .where(
        and(eq(repositories.id, repo.id), isNull(repositories.mergingPausedAt))
      )
      .returning({ id: repositories.id });
    if (changed.length)
      await recordAudit(db, {
        repositoryId: repo.id,
        actorId: user.id,
        action: 'merging.paused',
        target: opts.repoFullName,
        data: opts.reason ? { reason: opts.reason } : {},
      });
  } else {
    const before = await mergingPause(db, repo.id);
    const changed = before
      ? await db
          .update(repositories)
          .set({ mergingPausedAt: null, mergingPausedById: null })
          .where(
            and(
              eq(repositories.id, repo.id),
              isNotNull(repositories.mergingPausedAt)
            )
          )
          .returning({ id: repositories.id })
      : [];
    if (changed.length) {
      await recordAudit(db, {
        repositoryId: repo.id,
        actorId: user.id,
        action: 'merging.resumed',
        target: opts.repoFullName,
        data: { pausedAt: before!.at.getTime() },
      });
      opts.after(
        autoMergeRepository(env, db, repo.id).catch((e) =>
          console.error('[queue] auto-merge after resuming failed', repo.id, e)
        )
      );
    }
  }
  const now = await mergingPause(db, repo.id);
  return pauseOf(db, {
    mergingPausedAt: now?.at ?? null,
    mergingPausedById: now?.byId ?? null,
  });
}
