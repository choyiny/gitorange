/**
 * The pull request page: which tab a URL shows, the merge box's "what happens next" sentence, the queue line and its
 * estimate, the owner question a reviewer is waiting on, Fixer's attempts and the participants. Pure, so the words
 * are tested here and the page only draws them.
 */
import type { Tone } from './agentLook';
import { blocking, reasonText, stateLabel } from './pullState';
import type {
  AgentRun,
  Pull,
  PullReview,
  PullState,
  PullStateName,
  QueueTarget,
  RebaseView,
  ReviewFlag,
  User,
} from './uiApi';

export type PullTab = 'conversation' | 'commits' | 'files' | 'checks';

/** The tab a `/pull/:number/:tab` URL shows; null for a tab that doesn't exist. */
export function pullTab(param: string | undefined): PullTab | null {
  if (!param) return 'conversation';
  return param === 'commits' || param === 'files' || param === 'checks'
    ? param
    : null;
}

/** A pull request state's chip tone: whose move it is, never colour alone (the chip carries the words). */
export const STATE_TONE: Record<PullStateName, Tone> = {
  agent_followup: 'serious',
  human_review: 'warn',
  waiting: 'info',
  ready: 'good',
};

/** The state chip: an open pull request's state, or Merged / Closed. `merged` is a chip class of its own. */
export function pullChip(
  state: Pull['state'],
  pullState: PullState | null
): { tone: Tone | 'merged'; label: string } {
  if (state === 'merged') return { tone: 'merged', label: 'Merged' };
  if (state === 'closed') return { tone: 'off', label: 'Closed' };
  if (!pullState) return { tone: 'info', label: 'Open' };
  return { tone: STATE_TONE[pullState.state], label: stateLabel(pullState) };
}

export type QueueEntry = QueueTarget['entries'][number];
export type QueueSpot = { target: string; entry: QueueEntry; total: number };

/** Where a pull request is in the merge queue: its target, its entry and how many land on that target. */
export function queueSpot(
  queue: QueueTarget[] | undefined,
  number: number
): QueueSpot | null {
  for (const t of queue ?? []) {
    const entry = t.entries.find((e) => e.number === number);
    if (entry) return { target: t.target, entry, total: t.entries.length };
  }
  return null;
}

const SUFFIX: Record<number, string> = { 1: 'st', 2: 'nd', 3: 'rd' };

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : (SUFFIX[n % 10] ?? 'th')}`;
}

/** Minutes until it is expected to land, in plain words; null without run or review history. */
export function etaText(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (minutes <= 0) return 'any minute now';
  if (minutes < 60) return `about ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `about ${h} h ${m} min` : `about ${h} h`;
}

export function queueLine(spot: QueueSpot): string {
  return spot.entry.position === 1
    ? `First in line to land on ${spot.target}.`
    : `${ordinal(spot.entry.position)} of ${spot.total} in line to land on ${spot.target}.`;
}

/**
 * The question a reviewer is waiting on a person to answer: the first finding for a person that carries a plain
 * question and nobody has answered (approved, or asked for changes instead).
 */
export function openQuestion<A>(
  reviewers: { agent: A; flags: ReviewFlag[] }[] | undefined
): { agent: A; flag: ReviewFlag } | null {
  for (const r of reviewers ?? [])
    for (const flag of r.flags)
      if (
        flag.kind === 'needs_person' &&
        flag.question &&
        !flag.approvedAt &&
        !flag.changesRequestedAt
      )
        return { agent: r.agent, flag };
  return null;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What holds it back, in plain words: the merge queue's (the server words them for owners), else the state's
 * blocking reasons.
 */
export function pullBlockers(
  pullState: PullState | null,
  queueBlockers: string[] | undefined
): string[] {
  if (queueBlockers) return queueBlockers;
  return (pullState?.reasons ?? [])
    .filter(blocking)
    .map((r) => capital(reasonText(r)));
}

/**
 * A blocker about the branch clashing or being combined: the queue's words (`blockerText` on the server) and the
 * state's own (`reasonText`), for `rebase_conflict` and `resolution_running`.
 */
const REBASE_BLOCKER =
  /^(Clashes with newer changes|GitOrange is fixing a clash|AI is resolving conflicts|Commit \w+ conflicts in|The rebase stopped)/i;

export interface NextStepInput {
  state: Pull['state'];
  headRef: string;
  baseRef: string;
  headBranchExists: boolean;
  pullState: PullState | null;
  rebase: RebaseView | null;
  /** The review's auto-merge state; null without a review. */
  autoMerge: PullReview['autoMerge']['state'] | null;
}

export interface NextStep {
  tone: Tone;
  /** One plain sentence: what happens next, or what it waits for. */
  headline: string;
  /** A second line when the headline needs one. */
  detail: string | null;
  /** The blockers still worth listing under it (the headline's own is not repeated). */
  listed: string[];
}

/**
 * The merge box's sentence. The most specific fact wins: a missing branch, a clash Fixer couldn't combine, Fixer at
 * work, then whose move it is. `coder` is who makes changes (the app that opened it, or its author).
 */
export function nextStep(
  d: NextStepInput,
  ctx: {
    blockers: string[];
    question: { agent: string; text: string; assignee: string | null } | null;
    coder: string;
  }
): NextStep {
  const { blockers } = ctx;
  const step = (
    tone: Tone,
    headline: string,
    detail: string | null = null,
    listed: string[] = blockers
  ): NextStep => ({ tone, headline, detail, listed });
  const rest = blockers.slice(1);
  if (d.state === 'merged')
    return step('good', `Merged into ${d.baseRef}.`, null, []);
  if (d.state === 'closed')
    return step('off', 'Closed without merging.', null, []);
  if (!d.headBranchExists)
    return step(
      'critical',
      `The ${d.headRef} branch is gone, so this can’t merge.`,
      'Push the branch again, or close this pull request.',
      []
    );
  const r = d.rebase;
  // A clash or Fixer at work is the headline, so its own blocker is not listed again.
  const others = blockers.filter((b) => !REBASE_BLOCKER.test(b));
  if (r?.status === 'conflict') {
    if (r.error?.startsWith('Not rebased:'))
      return step(
        'serious',
        `GitOrange doesn’t rebase this branch, and it is behind ${r.onto}.`,
        r.error,
        others
      );
    return step(
      'serious',
      `It clashes with newer changes on ${r.onto}, and Fixer couldn’t combine them.`,
      'Someone needs to update the branch, or try the rebase again.',
      others
    );
  }
  if (r?.status === 'resolving')
    return step(
      'info',
      `Fixer is combining it with newer changes on ${r.onto}.`,
      'It carries on by itself once the clash is resolved.',
      others
    );
  const ps = d.pullState;
  if (!ps) return step('info', 'Checking where it stands.');
  switch (ps.state) {
    case 'ready':
      return d.autoMerge === 'ready'
        ? step('good', 'Ready. GitOrange is merging it now.')
        : d.autoMerge === 'disabled'
          ? step(
              'good',
              'Ready to merge. Auto-merge is off, so it waits for someone to merge it.'
            )
          : step('good', 'Ready to merge.');
    case 'waiting': {
      const holding = ps.reasons.filter(blocking);
      if (holding.some((x) => x.kind === 'merging_paused'))
        return holding.length === 1
          ? step(
              'warn',
              'Ready, but merging is paused. It merges once someone resumes merging.',
              null,
              []
            )
          : step(
              'warn',
              'Merging is paused, and it is still waiting on other things.',
              null,
              blockers.filter((b) => !/^merging is paused$/i.test(b))
            );
      return blockers.length
        ? step('info', `Waiting. ${blockers[0]}.`, null, rest)
        : step('info', 'Waiting.');
    }
    case 'human_review': {
      const q = ctx.question;
      if (q)
        return step(
          'warn',
          `${q.agent} asks${q.assignee ? ` ${q.assignee}` : ''}: ${q.text}`,
          null,
          // The question already says what that agent waits on.
          blockers.filter((b) => !b.startsWith(`${q.agent} `))
        );
      return blockers.length
        ? step('warn', `${blockers[0]}.`, null, rest)
        : step('warn', 'Needs a person before it can merge.');
    }
    case 'agent_followup':
      return step(
        'serious',
        `Waiting for ${ctx.coder} to make changes.`,
        blockers.length ? `${blockers[0]}.` : null,
        rest
      );
  }
}

/** Fixer's attempts (rebase and conflict-resolution runs), newest first, each once, at most `max`. */
export function fixerAttempts(
  lists: (AgentRun[] | undefined)[],
  max = 5
): AgentRun[] {
  const seen = new Map<string, AgentRun>();
  for (const list of lists)
    for (const run of list ?? []) if (!seen.has(run.id)) seen.set(run.id, run);
  return [...seen.values()]
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, max);
}

/** Everyone in the conversation once: the author, the commenters, then whoever merged it. */
export function participants<U extends Pick<User, 'id'>>(
  pr: { author: U; mergedBy: U | null },
  comments: { author: U }[]
): U[] {
  const all = [pr.author, ...comments.map((c) => c.author)];
  if (pr.mergedBy) all.push(pr.mergedBy);
  return all.filter((u, i) => all.findIndex((x) => x.id === u.id) === i);
}
