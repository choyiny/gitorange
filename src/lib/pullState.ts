import type { PullReason, PullState, PullStateName } from './uiApi';

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

const INFO = new Set(['stacked_on', 'waits_on']);
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
    case 'rebase_conflict':
      return r.commit
        ? `commit ${String(r.commit).slice(0, 7)} conflicts in ${((r.files as string[]) ?? []).join(', ')}`
        : String(r.error ?? 'the rebase stopped');
    case 'must_account_for':
      return `must account for #${n(r.pr)}${r.branch ? `, after rebasing onto ${String(r.branch)}` : ''}`;
    case 'rebase_onto':
      return `GitOrange is rebasing it onto #${n(r.pr)} (${String(r.branch)})`;
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
    case 'agent_reviewing':
      return r.agent
        ? `@${String(r.agent)} is reviewing`
        : 'agents are reviewing';
    case 'agent_flagged':
      return `@${String(r.agent)} flagged ${s(((r.flags as unknown[]) ?? []).length, 'finding')} for a person`;
    case 'agent_changes_requested':
      return `@${String(r.agent)} requested ${s(((r.changes as unknown[]) ?? []).length, 'change')}`;
    case 'agent_review_failed':
      return r.agent
        ? `@${String(r.agent)}'s review failed`
        : 'the review failed';
    case 'needs_approval':
      return 'no agent reviewed it: a person approves it';
    case 'merging_paused':
      return 'Merging is paused';
    default:
      return r.kind.replace(/_/g, ' ');
  }
}

/** The state as the list's label reads it ("Ready, stacked on #3"), and the first reason it shows beside it. */
export function stateText(state: PullState): {
  label: string;
  reason: string | null;
} {
  const stacked = state.reasons.find((r) => r.kind === 'stacked_on');
  const first = state.reasons.find(blocking) ?? state.reasons[0];
  return {
    label:
      STATE_LABEL[state.state] +
      (state.state === 'ready' && stacked
        ? `, stacked on #${Number(stacked.pr)}`
        : ''),
    // A ready PR's label already says what it's stacked on.
    reason:
      first && !(state.state === 'ready' && first === stacked)
        ? reasonText(first)
        : null,
  };
}
