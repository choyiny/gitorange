import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { RepoIcon } from '@primer/octicons-react';
import { api, qk } from '@/lib/uiApi';
import { ApiError } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Header } from '@/components/Header';
import { Avatar } from '@/components/Avatar';
import { Spinner } from '@/components/Spinner';
import { NotFound } from './NotFound';

export default function Profile() {
  const { owner = '' } = useParams();
  const q = useQuery({
    queryKey: qk.profile(owner),
    queryFn: () => api.profile(owner),
  });
  if (q.error instanceof ApiError && q.error.status === 404)
    return <NotFound />;
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
                  {q.data?.repositories.length ?? ''}
                </span>
              </span>
            </div>
          </nav>
        }
      />
      {!q.data ? (
        <Spinner />
      ) : (
        <div
          className="container-xl px-3 px-md-4 px-lg-5 py-4 d-flex flex-column flex-md-row"
          style={{ gap: 24 }}
        >
          <div className="col-md-3">
            <Avatar
              user={q.data.user}
              size={260}
              className="width-full height-auto"
            />
            <h1 className="mt-3 lh-condensed">
              <span className="d-block f3 text-bold">{q.data.user.name}</span>
              <span className="d-block f4 text-light color-fg-muted">
                {q.data.user.username}
              </span>
            </h1>
            <p className="f6 color-fg-muted mt-2">
              Joined {timeAgo(q.data.user.createdAt)}
            </p>
          </div>
          <div className="flex-1">
            {q.data.repositories.length === 0 ? (
              <div className="blankslate">
                <h3 className="blankslate-heading">
                  {q.data.user.username} doesn't have any repositories yet.
                </h3>
              </div>
            ) : (
              <ul className="list-style-none">
                {q.data.repositories.map((r) => (
                  <li key={r.id} className="py-4 border-bottom">
                    <h3 className="f3 text-normal mb-1">
                      <Link to={`/${r.fullName}`} className="text-bold">
                        {r.name}
                      </Link>
                      <span className="Label Label--secondary ml-2 v-align-middle">
                        Internal
                      </span>
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
