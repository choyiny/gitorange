/**
 * The Pull requests board: open pull requests in lanes by whose move it is, each card with who is reviewing it,
 * what holds it back and when it should land. Built from the pull request list (`pullState`) and the merge queue
 * (blockers, order, estimate), with no request per pull request.
 */
import type { Tone } from './agentLook';
import { blocking, reasonText } from './pullState';
import type { Pull, PullState, QueueTarget, ReviewerStatus } from './uiApi';

export type LaneId = 'needs' | 'fixing' | 'checking' | 'queued';

export const LANE_ORDER: readonly LaneId[] = [
  'needs',
  'fixing',
  'checking',
  'queued',
];

const LANE_LABEL: Record<LaneId, string> = {
  needs: 'Needs you',
  fixing: 'Being fixed',
  checking: 'Checking',
  queued: 'Queued',
};

const paused = (s: PullState | null | undefined) =>
  !!s?.reasons.some((r) => r.kind === 'merging_paused');

/**
 * Where an open pull request goes. A person's or an agent's move keeps its own lane even while merging is paused;
 * anything else that is paused waits in the queue lane, which then reads "Paused". A state that could not be
 * worked out counts as checking.
 */
export function laneOf(state: PullState | null | undefined): LaneId {
  if (!state) return 'checking';
  switch (state.state) {
    case 'human_review':
      return 'needs';
    case 'agent_followup':
      return 'fixing';
    case 'ready':
      return 'queued';
    case 'waiting':
      return paused(state) ? 'queued' : 'checking';
  }
}

export function laneLabel(lane: LaneId, mergingPaused: boolean): string {
  return lane === 'queued' && mergingPaused ? 'Paused' : LANE_LABEL[lane];
}

const LANE_TONE: Record<LaneId, Tone> = {
  needs: 'warn',
  fixing: 'serious',
  checking: 'info',
  queued: 'good',
};

/** What a list row's status pill says for an open pull request: the lane's word and tone ("Paused" when paused). */
export function laneChip(state: PullState | null | undefined): {
  lane: LaneId;
  label: string;
  tone: Tone;
} {
  const lane = laneOf(state);
  const isPaused = lane === 'queued' && paused(state);
  return {
    lane,
    label: laneLabel(lane, isPaused),
    tone: isPaused ? 'off' : LANE_TONE[lane],
  };
}

export interface BoardReviewer {
  handle: string;
  status: ReviewerStatus;
}

/** Most urgent first: a failed review, a person's decision, a change request, then one still running. */
const REVIEW_RANK: Record<string, number> = {
  failed: 0,
  flagged: 1,
  changes_requested: 2,
  reviewing: 3,
};

/**
 * The reviewer agents a pull request's reasons name, each in its state. The list carries only the agents that still
 * hold the pull request (reviewing, flagged, asked for changes, failed); one that approved is not named.
 */
export function reviewersOf(
  state: PullState | null | undefined
): BoardReviewer[] {
  const found = new Map<string, ReviewerStatus>();
  const see = (handle: unknown, status: ReviewerStatus) => {
    if (typeof handle !== 'string' || !handle) return;
    const had = found.get(handle);
    if (!had || REVIEW_RANK[status] < REVIEW_RANK[had])
      found.set(handle, status);
  };
  for (const r of state?.reasons ?? []) {
    if (r.kind === 'agent_reviewing') see(r.agent, 'reviewing');
    else if (r.kind === 'agent_flagged') see(r.agent, 'flagged');
    else if (r.kind === 'agent_changes_requested')
      see(r.agent, 'changes_requested');
    else if (r.kind === 'agent_review_failed') see(r.agent, 'failed');
  }
  return [...found].map(([handle, status]) => ({ handle, status }));
}

/** An estimate in minutes as words ("about 4 min"); null without one. */
export function etaText(minutes: number | null | undefined): string | null {
  if (minutes == null || !Number.isFinite(minutes)) return null;
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return 'under a minute';
  if (m < 60) return `about ${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `about ${h} h ${m % 60} min` : `about ${h} h`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The card's estimate line. The queue's estimate assumes nothing stops the pull request, so one that is waiting on
 * a person or on its author says so. While merging is paused nothing lands and there is no estimate.
 */
export function etaLine(
  lane: LaneId,
  minutes: number | null | undefined,
  mergingPaused: boolean
): string | null {
  if (mergingPaused) return null;
  const text = etaText(minutes);
  if (!text) return null;
  return lane === 'needs' || lane === 'fixing'
    ? `${capital(text)} once it is unblocked`
    : `Lands in ${text}`;
}

export interface BoardCard {
  pull: Pull;
  lane: LaneId;
  /** Landing order (1 is next); null when the queue does not list it. */
  position: number | null;
  /** What holds it back, in a sentence, and any further blockers. */
  blocker: { text: string; more: string[] };
  reviewers: BoardReviewer[];
  /** What it is stacked on or waits on, unless the blocker already says. */
  notes: string[];
  eta: string | null;
}

const mentions = (text: string, n: number) =>
  new RegExp(`#${n}(?!\\d)`).test(text);

type Entry = QueueTarget['entries'][number];

function blockerOf(
  entry: Entry | undefined,
  state: PullState | null | undefined,
  lane: LaneId
): { text: string; more: string[] } {
  if (entry?.blockers.length)
    return { text: entry.blockers[0], more: entry.blockers.slice(1) };
  if (entry)
    return {
      text:
        lane === 'queued' && entry.position === 1
          ? 'Nothing is holding it back. It lands next.'
          : 'Nothing is holding it back.',
      more: [],
    };
  // No queue entry (the queue did not load): say what the pull request's own reasons say.
  const reasons = (state?.reasons ?? []).filter(blocking);
  if (reasons.length)
    return {
      text: capital(reasonText(reasons[0])),
      more: reasons.slice(1).map((r) => capital(reasonText(r))),
    };
  return {
    text:
      lane === 'queued'
        ? 'Nothing is holding it back.'
        : 'Its state can’t be read right now.',
    more: [],
  };
}

/** What a pull request is stacked on or waits on, as short notes. */
function notesOf(state: PullState | null | undefined, shown: string): string[] {
  const notes: string[] = [];
  for (const r of state?.reasons ?? []) {
    const n = Number(r.pr);
    if (!Number.isFinite(n) || mentions(shown, n)) continue;
    if (r.kind === 'stacked_on') notes.push(`Stacked on #${n}`);
    else if (r.kind === 'waits_on') notes.push(`Waits on #${n}`);
  }
  return notes;
}

/**
 * Sorts open pull requests into lanes. Within a lane they keep landing order (the queue's), with any the queue does
 * not list after them, oldest first. `paused` is true when the queue or any pull request says merging is paused.
 */
export function boardLanes(
  open: Pull[],
  queue: QueueTarget[]
): { lanes: Record<LaneId, BoardCard[]>; paused: boolean } {
  const entries = new Map<number, Entry>();
  for (const t of queue)
    for (const e of t.entries)
      if (!entries.has(e.number)) entries.set(e.number, e);
  const mergingPaused =
    queue.some((t) => !!t.paused) || open.some((p) => paused(p.pullState));
  const lanes: Record<LaneId, BoardCard[]> = {
    needs: [],
    fixing: [],
    checking: [],
    queued: [],
  };
  const sorted = [...open].sort((a, b) => {
    const pa = entries.get(a.number)?.position ?? Infinity;
    const pb = entries.get(b.number)?.position ?? Infinity;
    if (pa !== pb) return pa < pb ? -1 : 1;
    return (
      Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number
    );
  });
  for (const pull of sorted) {
    const lane = laneOf(pull.pullState);
    const entry = entries.get(pull.number);
    const blocker = blockerOf(entry, pull.pullState, lane);
    const notes = notesOf(pull.pullState, blocker.text);
    const covered = (text: string) =>
      notes.some((note) => mentions(text, Number(note.split('#')[1])));
    lanes[lane].push({
      pull,
      lane,
      position: entry?.position ?? null,
      blocker: {
        text: blocker.text,
        more: blocker.more.filter((t) => !covered(t)),
      },
      reviewers: reviewersOf(pull.pullState),
      notes,
      eta: etaLine(lane, entry?.etaMinutes, mergingPaused),
    });
  }
  return { lanes, paused: mergingPaused };
}

/** The newest merged pull requests, newest first; closed ones are left out. */
export function recentlyMerged(pulls: Pull[], limit = 5): Pull[] {
  return pulls
    .filter((p) => p.state === 'merged' && p.mergedAt)
    .sort((a, b) => Date.parse(b.mergedAt!) - Date.parse(a.mergedAt!))
    .slice(0, limit);
}
