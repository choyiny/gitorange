import type { MergeRefusal, RebaseView } from './uiApi';

const sha7 = (s: unknown) => (typeof s === 'string' ? s.slice(0, 7) : '');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The merge box's line about the branch against its base. */
export function rebaseHeadline(
  r: RebaseView,
  headRef: string
): { title: string; detail: string } {
  switch (r.status) {
    case 'nothing_to_merge':
      return {
        title: 'This branch is up to date',
        detail: 'There is nothing to merge.',
      };
    case 'up_to_date':
      return {
        title: `Up to date with ${r.onto}`,
        detail:
          'Merging moves the target branch to this branch’s head: its commits land as they are.',
      };
    case 'behind':
      return {
        title: `Behind ${r.onto}`,
        detail:
          'GitOrange rebases it onto the latest commits; merging rebases it first if it still needs to.',
      };
    case 'resolving':
      return {
        title: r.commit
          ? `Resolving commit ${sha7(r.commit)}’s conflict with AI`
          : 'Resolving a conflict with AI',
        detail: `The rebase onto ${r.onto} stopped there; an agent is resolving it and the rebase goes on.`,
      };
    case 'conflict':
      return {
        title: r.commit
          ? `Commit ${sha7(r.commit)} conflicts with ${r.onto}`
          : `This branch can’t be rebased onto ${r.onto}`,
        detail:
          r.error ?? `Rebase ${headRef} onto ${r.onto} locally, then push.`,
      };
  }
}

/**
 * Whether a person may try the rebase again: it stopped (a conflict), and not on a branch GitOrange never rebases
 * ("Not rebased: …", which only bringing the branch up to date clears).
 */
export function canRetryRebase(r: RebaseView | null): boolean {
  return r?.status === 'conflict' && !r.error?.startsWith('Not rebased:');
}

/** The `rebased` timeline entry as text. */
export function rebasedText(d: Record<string, unknown>): string {
  const skipped = Number(d.skipped) || 0;
  const resolved = Number(d.resolved) || 0;
  const onto = String(d.onto ?? 'its base');
  return (
    `GitOrange rebased this branch onto ${onto} (${sha7(d.from)} → ${sha7(d.to)})` +
    (skipped
      ? `, skipping ${plural(skipped, 'commit')} ${onto} already has`
      : '') +
    (resolved
      ? `; AI resolved the conflicts of ${plural(resolved, 'commit')}`
      : '')
  );
}

/**
 * A merge refusal that is a normal outcome, not an error: landing rebased the branch first and now waits for the
 * new head's checks or review (it lands once they pass). `status` and `body` are the ApiError's.
 */
export function rebasedFirst(status: number, body: unknown): boolean {
  if (status !== 409 || !body || typeof body !== 'object') return false;
  const b = body as MergeRefusal;
  return (
    typeof b.rebased === 'string' &&
    !!b.rebased &&
    (b.reason === 'checks' || b.reason === 'review')
  );
}
