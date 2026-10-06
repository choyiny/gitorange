import type { ReviewerStatus } from './uiApi';

/** The parts of a reviewer row the timeline reads. */
type ReviewerLike = {
  id: string;
  status: ReviewerStatus;
  requested: boolean;
  createdAt: string;
  finishedAt: string | null;
  flags: { approvedAt: string | null }[];
};

/** What an agent did, said after its handle the way GitHub says a person's review. */
/** A review shown in the conversation; cancelled (`not_needed`) agents never are (see `reviewEntries`). */
export type ShownStatus = Exclude<ReviewerStatus, 'not_needed'>;

export function reviewVerb(r: {
  status: ShownStatus;
  flags: { approvedAt: string | null }[];
}): string {
  switch (r.status) {
    case 'approved':
      return 'approved these changes';
    case 'changes_requested':
      return 'requested changes';
    case 'flagged': {
      // Only findings still waiting on a person; approved ones are done.
      const open = r.flags.filter((f) => f.approvedAt === null).length;
      const n = open || r.flags.length;
      const findings = `${n} finding${n === 1 ? '' : 's'}`;
      return open
        ? `flagged ${findings} for a person`
        : `flagged ${findings}, ${n === 1 ? 'approved' : 'all approved'}`;
    }
    case 'reviewing':
      return 'is reviewing…';
    case 'failed':
      return 'couldn’t finish its review';
  }
}

/** An earlier commit's review: every finding is counted, since none of them is waiting on anyone any more. */
export function earlierVerb(r: {
  status: ShownStatus;
  flags: { approvedAt: string | null }[];
}): string {
  if (r.status !== 'flagged') return reviewVerb(r);
  const n = r.flags.length;
  return `flagged ${n} finding${n === 1 ? '' : 's'}`;
}

/** Where a review sits in the timeline: when it finished, or when it started while it runs. */
export function reviewTime(r: {
  status: ReviewerStatus;
  createdAt: string;
  finishedAt: string | null;
}): string {
  return (r.status !== 'reviewing' && r.finishedAt) || r.createdAt;
}

/** The agents whose reviews are conversation entries: requested, and not cancelled. */
export function reviewEntries<R extends ReviewerLike>(
  reviewers: R[]
): (R & { status: ShownStatus })[] {
  return reviewers.filter(
    (r): r is R & { status: ShownStatus } =>
      r.requested && r.status !== 'not_needed'
  );
}

/** Earlier commits' reviews shown in the conversation: cancelled (`not_needed`) ones never are. */
export function earlierEntries<R extends { status: ReviewerStatus }>(
  earlier: R[]
): (R & { status: ShownStatus })[] {
  return earlier.filter(
    (r): r is R & { status: ShownStatus } => r.status !== 'not_needed'
  );
}

/** The slot something at `at` falls in: before the first comment made after it (comments.length: after them all). */
export function slotOf(comments: { createdAt: string }[], at: string): number {
  const i = comments.findIndex((c) => c.createdAt > at);
  return i < 0 ? comments.length : i;
}

/** The parts of an earlier commit's review the timeline reads. */
type EarlierLike = {
  status: ReviewerStatus;
  createdAt: string;
  finishedAt: string | null;
};

export type TimelineItem<E, R, P = never> =
  | { kind: 'event'; at: string; event: E }
  | { kind: 'review'; at: string; review: R }
  | { kind: 'earlier'; at: string; review: P };

/**
 * Events and agent reviews (the head commit's, and `earlier` commits') between the comments they happened
 * between: slot i comes before comment i, and the last slot after every comment. Within a slot, time order; an
 * event comes first at the same instant (a push precedes the reviews of its commit).
 */
export function timelineSlots<
  E extends { createdAt: string },
  R extends ReviewerLike,
  P extends EarlierLike = never,
>(
  comments: { createdAt: string }[],
  events: E[],
  reviews: R[],
  earlier: P[] = []
): TimelineItem<E, R, P>[][] {
  const slots: TimelineItem<E, R, P>[][] = Array.from(
    { length: comments.length + 1 },
    () => []
  );
  const items: TimelineItem<E, R, P>[] = [
    ...events.map((event) => ({
      kind: 'event' as const,
      at: event.createdAt,
      event,
    })),
    ...reviews.map((review) => ({
      kind: 'review' as const,
      at: reviewTime(review),
      review,
    })),
    ...earlier.map((review) => ({
      kind: 'earlier' as const,
      at: reviewTime(review),
      review,
    })),
  ];
  // Stable: events (listed first) keep their order, and win ties.
  items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const item of items) slots[slotOf(comments, item.at)].push(item);
  return slots;
}

/**
 * The review "Review the flags" jumps to: the first head commit review in the timeline with a finding still
 * waiting on a person (earlier commits' findings no longer count).
 */
export function anchoredReviewer<R extends ReviewerLike>(
  slots: TimelineItem<unknown, R, unknown>[][]
): string | null {
  for (const slot of slots)
    for (const item of slot)
      if (
        item.kind === 'review' &&
        item.review.flags.some((f) => !f.approvedAt)
      )
        return item.review.id;
  return null;
}
