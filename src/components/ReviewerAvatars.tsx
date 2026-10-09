import { agentState, STATE_LOOK } from '@/lib/agentLook';
import type { BoardReviewer } from '@/lib/pullBoard';
import { AgentAvatar } from '@/components/AgentAvatar';
import { useAgentDirectory } from '@/components/actions/RunActor';

/**
 * The reviewer agents on a pull request, each as its avatar in its state. The name and state are the tooltip and
 * the avatar's accessible name; the row or card says the rest in words.
 */
export function ReviewerAvatars({
  reviewers,
  size = 28,
  className = 'reviewer-avatars',
}: {
  reviewers: BoardReviewer[];
  size?: number;
  className?: string;
}) {
  const lookup = useAgentDirectory();
  if (!reviewers.length) return null;
  return (
    <ul className={className} aria-label="Reviewers">
      {reviewers.map((r) => {
        const who = lookup(r.handle);
        const label = `${who.name}: ${STATE_LOOK[agentState(r.status)].label}`;
        return (
          <li key={r.handle} title={label}>
            <AgentAvatar
              handle={r.handle}
              color={who.color}
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
