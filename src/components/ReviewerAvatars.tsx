import { agentState, STATE_LOOK } from '@/lib/agentLook';
import type { PullReviewer } from '@/lib/uiApi';
import { AgentAvatar } from '@/components/AgentAvatar';

/**
 * The reviewer agents on a pull request, each as its avatar in its state (approved, needs a person, asked for
 * changes, reviewing, failed). The name and state are the tooltip and the avatar's accessible name; the card or
 * row says the rest in words.
 */
export function ReviewerAvatars({
  reviewers,
  size = 28,
  className = 'reviewer-avatars',
}: {
  reviewers: PullReviewer[];
  size?: number;
  className?: string;
}) {
  if (!reviewers.length) return null;
  return (
    <ul className={className} aria-label="Reviewers">
      {reviewers.map((r) => {
        const label = `${r.name}: ${STATE_LOOK[agentState(r.status)].label}`;
        return (
          <li key={r.handle} title={label}>
            <AgentAvatar
              handle={r.handle}
              color={r.color}
              status={r.status}
              size={size}
              label={label}
            />
          </li>
        );
      })}
    </ul>
  );
}
