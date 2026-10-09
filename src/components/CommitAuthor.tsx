import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qk, type Commit, type CommitIdentity } from '@/lib/uiApi';
import { isAgentEmail } from '@/lib/commitMessage';
import { agentForEmail } from '@/lib/commits';
import { AgentAvatar } from './AgentAvatar';
import { Avatar } from './Avatar';

/**
 * Whether a commit identity is a reviewer agent's (its account email is `<id>@agents.invalid`, which the server
 * never matches to a member), and which agent. The agent list loads only when a commit by an agent is on the
 * page, and every identity shares the one request.
 */
function useAgentIdentity(email: string) {
  const isAgent = isAgentEmail(email);
  const agents = useQuery({
    queryKey: qk.agents,
    queryFn: api.agents,
    enabled: isAgent,
  });
  if (!isAgent) return null;
  const agent = agentForEmail(email, agents.data);
  return {
    agent,
    // Sent since crew redesign B1; typed in uiApi by C0.
    color: (agent as { color?: string | null } | null)?.color ?? null,
  };
}

/**
 * A commit's author like GitHub shows it: a member (matched by their account email or a verified
 * alternate) gets their avatar and username, linked to their profile; anyone else is the plain git
 * name. A reviewer agent gets its robot and links to its profile. A different committer is credited
 * too ("X authored and Y committed").
 */
export function CommitAuthor({
  commit,
  size = 20,
  className = 'text-bold',
  showCommitter = true,
}: {
  commit: Pick<Commit, 'author' | 'committer'>;
  size?: number;
  className?: string;
  /** Off where no "committed …" text follows, e.g. the latest-commit bar. */
  showCommitter?: boolean;
}) {
  const { author, committer } = commit;
  const sameCommitter = author.user
    ? committer.user?.id === author.user.id
    : committer.email.toLowerCase() === author.email.toLowerCase();
  return (
    <>
      <IdentityAvatar who={author} size={size} />
      <Identity who={author} className={className} />
      {showCommitter && !sameCommitter && (
        <span className="color-fg-muted no-wrap">
          authored and <Identity who={committer} className={className} />
        </span>
      )}
    </>
  );
}

function IdentityAvatar({ who, size }: { who: CommitIdentity; size: number }) {
  const agent = useAgentIdentity(who.email);
  if (agent)
    return (
      <AgentAvatar
        handle={agent.agent?.username ?? who.name}
        color={agent.color}
        size={Math.max(size, 20)}
      />
    );
  return (
    <Avatar
      user={who.user ?? { username: who.name }}
      size={size}
      className="flex-shrink-0"
    />
  );
}

function Identity({
  who,
  className,
}: {
  who: CommitIdentity;
  className: string;
}) {
  const agent = useAgentIdentity(who.email);
  if (agent?.agent)
    return (
      <Link
        to={`/${agent.agent.username}`}
        className={`${className} color-fg-default no-wrap`}
        title={`${agent.agent.name}, a reviewer agent`}
      >
        {agent.agent.name}
      </Link>
    );
  if (!who.user)
    return (
      <span
        className={`${className} color-fg-default no-wrap`}
        title={agent ? `${who.name}, a reviewer agent` : who.email}
      >
        {who.name}
      </span>
    );
  return (
    <Link
      to={`/${who.user.username}`}
      className={`${className} color-fg-default no-wrap`}
      title={`${who.name} <${who.email}>`}
    >
      {who.user.username}
    </Link>
  );
}
