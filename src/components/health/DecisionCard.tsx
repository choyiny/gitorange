import { Link } from 'react-router-dom';
import { ClockIcon, PersonIcon } from '@primer/octicons-react';
import { useApprovalPages } from '@/lib/approvals';
import { decisionCopy, pickDecision } from '@/lib/health';
import { timeAgo } from '@/lib/format';
import { AgentAvatar } from '@/components/AgentAvatar';
import { useAgentDirectory } from '@/components/actions/RunActor';

/** What waits on the owner when there is no finding to show: some pull request needs a person. */
function WaitingCard({ count }: { count: number }) {
  return (
    <div className="hl-ask">
      <span className="hl-ask-icon" aria-hidden="true">
        <PersonIcon size={24} />
      </span>
      <div className="hl-ask-body">
        <span className="hl-ask-from">Waiting for a person</span>
        <strong>
          {count === 1 ? '1 decision needs you' : `${count} decisions need you`}
        </strong>
        <p>Pull requests here are waiting for someone to approve or answer.</p>
      </div>
      <Link className="btn primary" to="/approvals">
        Open approvals
      </Link>
    </div>
  );
}

/**
 * The decision waiting on the owner, first on the page: the reviewer that asked, its question, the pull request it
 * is on and a button to answer. `waiting` is the report's count; a finding for this repository comes from the
 * Approvals inbox. While that loads there is a placeholder; if it fails, or the waiting item is not a finding, the
 * card says how many wait and links to Approvals. Mounted only when something waits.
 */
export function DecisionSlot({
  fullName,
  waiting,
}: {
  fullName: string;
  waiting: number;
}) {
  const q = useApprovalPages();
  const lookup = useAgentDirectory();
  if (q.isPending)
    return (
      <div
        className="sk sk-block short"
        role="status"
        aria-busy="true"
        aria-label="Loading the decision"
      />
    );
  const row = q.data
    ? pickDecision(
        q.data.pages.flatMap((p) => p.items),
        fullName
      )
    : null;
  if (!row) return <WaitingCard count={waiting} />;

  const copy = decisionCopy(row);
  const agent = lookup(row.agent.username);
  const more = waiting - 1;
  const assignee = row.flag.assignee;
  return (
    <div className="hl-ask-wrap">
      <div className="hl-ask">
        <AgentAvatar
          handle={row.agent.username}
          color={agent.color}
          status="needs"
          size={56}
          label={`${agent.name}, waiting for you`}
        />
        <div className="hl-ask-body">
          <span className="hl-ask-from">{copy.from}</span>
          <strong>{copy.title}</strong>
          {copy.body && <p>{copy.body}</p>}
          <span className="hl-ask-meta">
            <ClockIcon size={14} />
            <span>
              On{' '}
              <Link to={row.prUrl}>
                #{row.pull.number} {row.pull.title}
              </Link>
              , updated {timeAgo(row.pull.updatedAt)}
              {assignee && ` · Assigned to ${assignee.name ?? assignee.login}`}
            </span>
          </span>
        </div>
        <Link className="btn primary" to={`/approvals/${row.flag.id}`}>
          {row.flag.question ? 'Answer' : 'Decide'}
        </Link>
      </div>
      {more > 0 && (
        <p className="hl-more small">
          <Link to="/approvals">
            {more === 1
              ? '1 more decision is waiting for you'
              : `${more} more decisions are waiting for you`}
          </Link>
        </p>
      )}
    </div>
  );
}
