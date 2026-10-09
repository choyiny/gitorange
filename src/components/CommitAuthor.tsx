import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  qk,
  type Agent,
  type Commit,
  type CommitIdentity,
  type Repo,
} from '@/lib/uiApi';
import { agentOfRepo, trustedAgent } from '@/lib/commits';
import { AgentAvatar } from './AgentAvatar';
import { Avatar } from './Avatar';

/**
 * The agent this repository belongs to, if it is an agent's own (`<handle>/<handle>`). Only there is an agent's
 * account email evidence of who wrote a commit; the list of agents loads only for such a repository.
 */
function useRepoAgent(repo: Pick<Repo, 'owner' | 'name'> | undefined) {
  const candidate =
    !!repo && repo.owner.username.toLowerCase() === repo.name.toLowerCase();
  const agents = useQuery({
    queryKey: qk.agents,
    queryFn: api.agents,
    enabled: candidate,
  });
  return repo && candidate
    ? agentOfRepo(repo.owner.username, repo.name, agents.data)
    : null;
}

// Sent since crew redesign B1; typed in uiApi by C0.
const colorOf = (a: Agent) => (a as { color?: string | null }).color ?? null;

/**
 * A commit's author like GitHub shows it: a member (matched by their account email or a verified
 * alternate) gets their avatar and username, linked to their profile; anyone else is the plain git
 * name. A different committer is credited too ("X authored and Y committed").
 *
 * Pass `repo` and, inside a reviewer agent's own repository, commits the server wrote as that agent show its robot
 * and link to its profile. Anywhere else an agent's address means nothing: anyone who can push can write it into a
 * commit, so it is shown as the plain git name.
 */
export function CommitAuthor({
  commit,
  repo,
  size = 20,
  className = 'text-bold',
  showCommitter = true,
}: {
  commit: Pick<Commit, 'author' | 'committer'>;
  repo?: Pick<Repo, 'owner' | 'name'>;
  size?: number;
  className?: string;
  /** Off where no "committed …" text follows, e.g. the latest-commit bar. */
  showCommitter?: boolean;
}) {
  const { author, committer } = commit;
  const repoAgent = useRepoAgent(repo);
  const sameCommitter = author.user
    ? committer.user?.id === author.user.id
    : committer.email.toLowerCase() === author.email.toLowerCase();
  return (
    <>
      <IdentityAvatar who={author} agent={repoAgent} size={size} />
      <Identity who={author} agent={repoAgent} className={className} />
      {showCommitter && !sameCommitter && (
        <span className="color-fg-muted no-wrap">
          authored and{' '}
          <Identity who={committer} agent={repoAgent} className={className} />
        </span>
      )}
    </>
  );
}

function IdentityAvatar({
  who,
  agent,
  size,
}: {
  who: CommitIdentity;
  agent: Agent | null;
  size: number;
}) {
  const is = trustedAgent(who.email, agent);
  if (is)
    return (
      <AgentAvatar
        handle={is.username}
        color={colorOf(is)}
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
  agent,
  className,
}: {
  who: CommitIdentity;
  agent: Agent | null;
  className: string;
}) {
  const is = trustedAgent(who.email, agent);
  if (is)
    return (
      <Link
        to={`/${is.username}`}
        className={`${className} color-fg-default no-wrap`}
        title={`${is.name}, a reviewer agent`}
      >
        {is.name}
      </Link>
    );
  if (!who.user)
    return (
      <span
        className={`${className} color-fg-default no-wrap`}
        title={who.email}
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
