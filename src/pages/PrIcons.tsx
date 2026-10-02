import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
} from '@primer/octicons-react';
import type { Pull } from '@/lib/uiApi';

export function PrStateIcon({
  state,
  size = 16,
}: {
  state: Pull['state'];
  size?: number;
}) {
  if (state === 'merged')
    return <GitMergeIcon size={size} className="color-fg-done" />;
  if (state === 'closed')
    return <GitPullRequestClosedIcon size={size} className="color-fg-closed" />;
  return <GitPullRequestIcon size={size} className="color-fg-open" />;
}

export function PrStateBadge({ state }: { state: Pull['state'] }) {
  const cls =
    state === 'merged'
      ? 'State State--merged'
      : state === 'closed'
        ? 'State State--closed'
        : 'State State--open';
  const Icon =
    state === 'merged'
      ? GitMergeIcon
      : state === 'closed'
        ? GitPullRequestClosedIcon
        : GitPullRequestIcon;
  return (
    <span
      className={`${cls} d-inline-flex flex-items-center`}
      style={{ gap: 4 }}
    >
      <Icon /> {state[0].toUpperCase() + state.slice(1)}
    </span>
  );
}
