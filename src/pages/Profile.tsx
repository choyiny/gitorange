import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { OrganizationIcon, RepoIcon } from '@primer/octicons-react';
import { api, qk } from '@/lib/uiApi';
import { ApiError } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { Header } from '@/components/Header';
import { Avatar } from '@/components/Avatar';
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
            {isTeam ? (
              <p
                className="f6 color-fg-muted mt-2 d-flex flex-items-center"
                style={{ gap: 4 }}
              >
                <OrganizationIcon /> Team · every member can see these
                repositories
              </p>
            ) : (
              <p className="f6 color-fg-muted mt-2">
                Joined {timeAgo(data.owner.createdAt)}
              </p>
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
