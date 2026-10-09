import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
} from '@primer/octicons-react';
import { pullChip } from '@/lib/pullPage';
import { reasonText } from '@/lib/pullState';
import type { Pull, PullState } from '@/lib/uiApi';

/** A pull request's state as a chip: whose move it is while open (the reasons in its title), else Merged or Closed. */
export function PullChip({
  state,
  pullState,
}: {
  state: Pull['state'];
  pullState: PullState | null;
}) {
  const chip = pullChip(state, pullState);
  const Icon =
    state === 'merged'
      ? GitMergeIcon
      : state === 'closed'
        ? GitPullRequestClosedIcon
        : GitPullRequestIcon;
  const why =
    state === 'open'
      ? pullState?.reasons.map(reasonText).join('; ')
      : undefined;
  return (
    <span className={`chip ${chip.tone}`} title={why || undefined}>
      <Icon size={12} />
      {chip.label}
      {why && <span className="sr">: {why}</span>}
    </span>
  );
}
