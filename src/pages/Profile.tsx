import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ClockIcon,
  MailIcon,
  OrganizationIcon,
  RepoIcon,
} from '@primer/octicons-react';
import { api, qk, type Namespace } from '@/lib/uiApi';
import { ApiError } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import { fullDate, timeAgo } from '@/lib/format';
import { Avatar } from '@/components/Avatar';
import { VisibilityLabel } from '@/components/VisibilityLabel';
import { useEnter } from '@/components/code/useEnter';
import { LoadError } from '@/components/Notice';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Section } from '@/components/ui/Section';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePageHead } from '@/components/ui/PageHead';
import AgentProfile from './AgentProfile';
import { NOT_FOUND_HEAD, NotFound } from './NotFound';

/**
 * Whoever lives at `/<name>`: a person, the team or a reviewer agent. A person and the team get their repositories;
 * an agent gets its own profile (`AgentProfile`).
 */
export default function Profile() {
  const { owner = '' } = useParams();
  const q = useQuery({
    queryKey: qk.namespace(owner),
    queryFn: () => api.namespace(owner),
  });
  const missing = q.error instanceof ApiError && q.error.status === 404;
  const data = q.data;
  usePageHead(
    missing
      ? NOT_FOUND_HEAD
      : data?.agent
        ? {
            icon: 'crew',
            crumbs: [
              { label: 'Agents', to: '/agents' },
              { label: data.agent.name },
            ],
            title: data.agent.name,
          }
        : {
            icon: 'person',
            crumbs: [{ label: owner }],
            title: data?.owner.name || owner,
          }
  );
  const entering = useEnter(!!data);
  if (missing) return <NotFound />;
  if (q.isError && !data)
    return (
      <LoadError
        what={`@${owner}`}
        error={q.error}
        onRetry={() => void q.refetch()}
      />
    );
  if (!data) return <Skeleton kind="detail" />;
  return (
    <div className={entering}>
      {data.agent ? (
        <AgentProfile
          key={data.agent.username}
          agent={data.agent}
          repositories={data.repositories}
        />
      ) : (
        <PersonProfile key={data.owner.id} data={data} />
      )}
    </div>
  );
}

/** A person's page or the team's: who they are, and the repositories you can see that they own. */
function PersonProfile({ data }: { data: Namespace }) {
  const me = useCurrentUser();
  const isTeam = data.kind === 'team';
  const isMe = data.kind === 'user' && data.owner.id === me?.id;
  const members = useQuery({
    queryKey: qk.members,
    queryFn: api.members,
    enabled: !isTeam,
  });
  const role = members.data?.find((m) => m.id === data.owner.id)?.role;
  const name = data.owner.name || data.owner.username;
  const canCreate = isTeam || isMe;
  const newRepo = (
    <Link
      to={isTeam ? '/new?owner=team' : '/new'}
      className="btn small primary"
    >
      <RepoIcon />
      New repository
    </Link>
  );
  return (
    <div className="profile">
      <aside className="pf-side" aria-label={`About ${name}`}>
        <div className="pf-photo">
          <Avatar user={data.owner} size={168} square={isTeam} />
        </div>
        <h2 className="pf-name">{name}</h2>
        <p className="pf-handle mono">@{data.owner.username}</p>
        <p className="pf-badges">
          {isTeam ? (
            <Chip tone="info" icon={<OrganizationIcon size={12} />}>
              Team
            </Chip>
          ) : role ? (
            <Chip tone={role === 'admin' ? 'info' : 'off'}>
              {role === 'admin' ? 'Site admin' : 'Member'}
            </Chip>
          ) : null}
        </p>
        {isTeam ? (
          <p className="pf-bio small muted">
            Every member can see these repositories.
          </p>
        ) : (
          <ul className="pf-meta">
            {data.owner.email && (
              <li>
                <MailIcon />
                <a href={`mailto:${data.owner.email}`} title={data.owner.email}>
                  {data.owner.email}
                </a>
              </li>
            )}
            <li>
              <ClockIcon />
              <span title={fullDate(data.owner.createdAt)}>
                Joined {timeAgo(data.owner.createdAt)}
              </span>
            </li>
          </ul>
        )}
      </aside>
      <div className="pf-main">
        <Section
          title={
            <>
              Repositories{' '}
              <span className="num">{data.repositories.length}</span>
            </>
          }
          actions={canCreate ? newRepo : undefined}
        >
          {data.repositories.length === 0 ? (
            <div className="panel">
              <EmptyState
                picture={<RepoIcon size={20} />}
                title={
                  isTeam
                    ? `${name} doesn’t have any repositories yet.`
                    : `@${data.owner.username} doesn’t have any repositories you can see yet.`
                }
                body={
                  canCreate
                    ? 'Create one and it shows up here.'
                    : 'Private repositories only show to their owner, collaborators and site admins.'
                }
              />
            </div>
          ) : (
            <ul className="panel pf-repos">
              {data.repositories.map((r) => (
                <li key={r.id}>
                  <div className="pf-repo-name">
                    <RepoIcon />
                    <Link to={`/${r.fullName}`}>{r.name}</Link>
                    <VisibilityLabel visibility={r.visibility} />
                  </div>
                  {r.description && <p className="muted">{r.description}</p>}
                  <span className="muted small" title={fullDate(r.updatedAt)}>
                    Updated {timeAgo(r.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
