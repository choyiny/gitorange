import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BookIcon, ClockIcon, GitBranchIcon } from '@primer/octicons-react';
import { timeAgo } from '@/lib/format';
import { encodeRepoPath } from '@/lib/codeView';
import { api, qk, type Agent, type RepoDetail } from '@/lib/uiApi';
import { AgentAvatar } from '@/components/AgentAvatar';

// Sent since crew redesign B1; typed in uiApi by C0.
const colorOf = (a: Agent) => (a as { color?: string | null }).color ?? null;

/** The repository's own facts, beside its files: what is in it to read, how many branches, when it began. */
export function AboutCard({
  repo,
  readmePath,
  refName,
}: {
  repo: RepoDetail;
  readmePath: string | null;
  refName: string;
}) {
  const base = `/${repo.fullName}`;
  const count = repo.branches.length;
  return (
    <section className="panel pad about">
      <h2>About</h2>
      <ul className="ticks small">
        {readmePath && (
          <li>
            <BookIcon />
            <Link to={`${base}/blob/${refName}/${encodeRepoPath(readmePath)}`}>
              Readme
            </Link>
          </li>
        )}
        <li>
          <GitBranchIcon />
          <span>
            {count} {count === 1 ? 'branch' : 'branches'}, default{' '}
            <span className="mono">{repo.defaultBranch}</span>
          </span>
        </li>
        <li>
          <ClockIcon />
          <span>Created {timeAgo(repo.createdAt)}</span>
        </li>
      </ul>
    </section>
  );
}

/**
 * An agent's repository: who these files instruct, and what changing them does. Its Code tab is the agent's
 * AGENT.md and knowledge files, not a project's code.
 */
export function AgentAboutCard({ agent }: { agent: Agent }) {
  return (
    <section className="panel pad about">
      <h2>About</h2>
      <Link to={`/${agent.username}`} className="about-agent">
        <AgentAvatar
          handle={agent.username}
          color={colorOf(agent)}
          size={40}
          label={`${agent.name}, a reviewer agent`}
        />
        <span>
          <b>{agent.name}</b>
          <span className="muted small">Reviewer agent</span>
        </span>
      </Link>
      <p className="small muted">
        Changes to these files change how {agent.name} reviews. They go through
        pull requests like any other change, and dismissals add rules here
        automatically.
      </p>
    </section>
  );
}

/** The reviewer agents invited to this repository, each with its robot; a way to change them for admins. */
export function ReviewersCard({ repo }: { repo: RepoDetail }) {
  const o = repo.owner.username;
  const agents = useQuery({
    queryKey: qk.repoAgents(o, repo.name),
    queryFn: () => api.repoAgents(o, repo.name),
  });
  // A side card is never worth an error of its own.
  if (agents.isError) return null;
  const list = (agents.data ?? []).filter((a) => !a.deletedAt);
  return (
    <section className="panel pad reviewers" aria-label="Reviewer agents">
      <h2>Reviewer agents</h2>
      {agents.isPending ? (
        <div className="sk sk-row" aria-hidden="true" />
      ) : list.length ? (
        <ul className="agentstack">
          {list.map((a) => (
            <li key={a.id}>
              <Link
                to={`/${a.username}`}
                title={a.name}
                aria-label={`${a.name}, reviewer agent`}
              >
                <AgentAvatar handle={a.username} color={colorOf(a)} size={44} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">
          No reviewer agents yet, so pull requests wait for a person.
        </p>
      )}
      {repo.permissions.admin && (
        <Link className="small" to={`/${repo.fullName}/settings`}>
          {list.length ? 'Manage' : 'Invite a reviewer'}
        </Link>
      )}
    </section>
  );
}
