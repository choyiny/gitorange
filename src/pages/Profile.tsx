import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  DependabotIcon,
  MailIcon,
  OrganizationIcon,
  RepoIcon,
} from '@primer/octicons-react';
import { api, qk, type Namespace } from '@/lib/uiApi';
import { ApiError } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { Header } from '@/components/Header';
import { Avatar } from '@/components/Avatar';
import { REVIEWER_STATUS } from '@/components/ReviewersBox';
import { Spinner } from '@/components/Spinner';
import { VisibilityLabel } from '@/components/VisibilityLabel';
import { NotFound } from './NotFound';

/** A person's page or the team's page, at `/<username>` or `/<team slug>`. */
export default function Profile() {
  const { owner = '' } = useParams();
  const me = useCurrentUser();
  const q = useQuery({
    queryKey: qk.namespace(owner),
    queryFn: () => api.namespace(owner),
  });
  if (q.error instanceof ApiError && q.error.status === 404)
    return <NotFound />;
  const data = q.data;
  const isTeam = data?.kind === 'team';
  const isMe = data?.kind === 'user' && data.owner.id === me?.id;
  return (
    <>
      <Header
        context={<Link to={`/${owner}`}>{owner}</Link>}
        nav={
          <nav className="UnderlineNav">
            <div className="UnderlineNav-body">
              <span className="UnderlineNav-item selected">
                <span className="UnderlineNav-octicon">
                  <RepoIcon />
                </span>
                <span className="text-bold">Repositories</span>
                <span className="Counter repo-tab-count">
                  {data?.repositories.length ?? ''}
                </span>
              </span>
            </div>
          </nav>
        }
      />
      {!data ? (
        <Spinner />
      ) : (
        <div
          className="container-xl px-3 px-md-4 px-lg-5 py-4 d-flex flex-column flex-md-row"
          style={{ gap: 24 }}
        >
          <div className="col-md-3">
            <Avatar user={data.owner} size={260} square={isTeam} />
            <h1 className="mt-3 lh-condensed">
              <span className="d-block f3 text-bold">{data.owner.name}</span>
              <span className="d-block f4 text-light color-fg-muted">
                {data.owner.username}
              </span>
            </h1>
            {data.agent ? (
              <AgentAbout agent={data.agent} />
            ) : isTeam ? (
              <p
                className="f6 color-fg-muted mt-2 d-flex flex-items-center"
                style={{ gap: 4 }}
              >
                <OrganizationIcon /> Team · every member can see these
                repositories
              </p>
            ) : (
              <>
                {data.owner.email && (
                  <p
                    className="f5 mt-2 d-flex flex-items-center"
                    style={{ gap: 6, minWidth: 0 }}
                  >
                    <MailIcon className="color-fg-muted flex-shrink-0" />
                    <a
                      href={`mailto:${data.owner.email}`}
                      className="color-fg-default text-truncate"
                      title={data.owner.email}
                    >
                      {data.owner.email}
                    </a>
                  </p>
                )}
                <p className="f6 color-fg-muted mt-2">
                  Joined {timeAgo(data.owner.createdAt)}
                </p>
              </>
            )}
          </div>
          <div className="flex-1">
            {(isTeam || isMe) && (
              <div className="d-flex flex-justify-end mb-2">
                <Link
                  to={isTeam ? '/new?owner=team' : '/new'}
                  className="btn btn-primary btn-sm d-inline-flex flex-items-center"
                  style={{ gap: 4 }}
                >
                  <RepoIcon /> New
                </Link>
              </div>
            )}
            {data.repositories.length === 0 ? (
              <div className="blankslate">
                <h3 className="blankslate-heading">
                  {isTeam
                    ? `${data.owner.name} doesn't have any repositories yet.`
                    : `${data.owner.username} doesn't have any repositories you can see yet.`}
                </h3>
              </div>
            ) : (
              <ul className="list-style-none">
                {data.repositories.map((r) => (
                  <li key={r.id} className="py-4 border-bottom">
                    <h3 className="f3 text-normal mb-1">
                      <Link to={`/${r.fullName}`} className="text-bold">
                        {r.name}
                      </Link>
                      <VisibilityLabel
                        visibility={r.visibility}
                        className="ml-2 v-align-middle"
                      />
                    </h3>
                    {r.description && (
                      <p className="color-fg-muted f5 mb-2">{r.description}</p>
                    )}
                    <div className="f6 color-fg-muted">
                      Updated {timeAgo(r.updatedAt)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** The left column of an agent's profile: what it is, what it reviews, where. */
function AgentAbout({ agent }: { agent: NonNullable<Namespace['agent']> }) {
  return (
    <div className="mt-2">
      <span
        className={`Label ${agent.deletedAt ? 'Label--secondary' : 'Label--accent'} d-inline-flex flex-items-center`}
        style={{ gap: 4 }}
      >
        <DependabotIcon size={12} />
        {agent.deletedAt ? 'Deleted agent' : 'Agent'}
      </span>
      {agent.bio && <p className="f5 mt-2 mb-0">{agent.bio}</p>}
      <div className="f6 text-bold mt-3">Reviews when</div>
      <p className="f6 mt-1 mb-0">
        {agent.trigger.ask}{' '}
        <span className="color-fg-muted">
          (Clef: yes with probability ≥ {agent.trigger.above})
        </span>
      </p>
      {agent.configError && (
        <div className="flash flash-warn f6 mt-2">
          AGENT.md has an error, so this shows its last valid version:{' '}
          {agent.configError}
        </div>
      )}
      {agent.repository && (
        <p className="f6 mt-3 mb-0 d-flex flex-items-center" style={{ gap: 4 }}>
          <RepoIcon className="color-fg-muted" /> Defined in{' '}
          <Link to={`/${agent.repository}`}>{agent.repository}</Link>
        </p>
      )}
      {agent.invitedTo.length > 0 && (
        <>
          <div className="f6 text-bold mt-3">Invited to</div>
          <ul className="list-style-none f6 mt-1">
            {agent.invitedTo.map((r) => (
              <li key={r.id}>
                <Link to={`/${r.fullName}`}>{r.fullName}</Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {agent.recentReviews.length > 0 && (
        <>
          <div className="f6 text-bold mt-3 mb-1">Recent reviews</div>
          <ul className="list-style-none f6">
            {agent.recentReviews.map((r) => (
              <li
                key={`${r.repository}#${r.number}@${r.headSha}`}
                className="mb-1"
              >
                <Link to={`/${r.repository}/pull/${r.number}`}>
                  {r.repository}#{r.number}
                </Link>{' '}
                <span className={REVIEWER_STATUS[r.status].className}>
                  {REVIEWER_STATUS[r.status].label}
                </span>{' '}
                <span className="color-fg-muted">· {timeAgo(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
