import type { PullReason, PullStateName } from './uiApi';

export const STATE_LABEL: Record<PullStateName, string> = {
  agent_followup: 'Ready for agent followup',
  human_review: 'Requires human review',
  waiting: 'Waiting for checks',
  ready: 'Ready',
};

/** Primer Label modifiers per state. */
export const STATE_CLASS: Record<PullStateName, string> = {
  agent_followup: 'Label--attention',
  human_review: 'Label--severe',
  waiting: 'Label--secondary',
  ready: 'Label--success',
};

// must_account_for only informs until plan 2b can mark it accounted for.
const INFO = new Set(['stacked_on', 'waits_on', 'must_account_for']);
/** Whether a reason holds the PR in its state (others only inform). */
export const blocking = (r: PullReason) => !INFO.has(r.kind);

const n = (v: unknown) => Number(v);
const has = (v: unknown) => v != null && Number.isFinite(Number(v));
const prs = (v: unknown) =>
  ((v as number[]) ?? []).map((x) => `#${x}`).join(', ');
const s = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;

/** A reason in a few words, for labels, banners and the timeline. */
export function reasonText(r: PullReason): string {
  switch (r.kind) {
    case 'check_failed':
      return `${r.check ? `the "${r.check}" check` : 'a check'} failed${has(r.run_number) ? ` (run #${n(r.run_number)})` : ''}`;
    case 'changes_requested':
      return has(r.flags)
        ? `changes requested on ${s(n(r.flags), 'flag')}`
        : 'changes requested on review flags';
    case 'conflicts_unresolved':
      return "conflicts AI couldn't resolve";
    case 'review_policy_invalid':
      return r.where === 'pull_request'
        ? "this pull request's .gitorange/review.yml is invalid"
        : '.gitorange/review.yml on the target branch is invalid';
    case 'must_account_for':
      return `must account for #${n(r.pr)}`;
    case 'review_failed':
      return 'the auto-merge review failed';
    case 'flags_pending':
      return has(r.count)
        ? `${s(n(r.count), 'review flag')} await${n(r.count) === 1 ? 's' : ''} approval`
        : 'review flags await approval';
    case 'cycle':
      return `depends in a circle on ${prs(r.prs)}`;
    case 'checks_running':
      return r.check
        ? r.started
          ? `the "${r.check}" check is running`
          : `waiting for the "${r.check}" check`
        : r.started
          ? 'checks are running'
          : 'no checks have run yet';
    case 'review_running':
      return 'the auto-merge review is running';
    case 'resolution_running':
      return 'AI is resolving conflicts';
    case 'stack_checking':
      return (r.prs as number[] | undefined)?.length
        ? `checking against ${prs(r.prs)}`
        : 'checking how it relates to other open pull requests';
    case 'stacked_on':
      return `stacked on #${n(r.pr)}`;
    case 'waits_on':
      return `waits on #${n(r.pr)}`;
    default:
      return r.kind.replace(/_/g, ' ');
  }
}
