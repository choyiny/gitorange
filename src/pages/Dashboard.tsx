import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { RepoIcon, PersonAddIcon } from '@primer/octicons-react';
import { api, qk } from '@/lib/uiApi';
import { useCurrentUser } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { Header } from '@/components/Header';
import { Avatar } from '@/components/Avatar';
import { Spinner } from '@/components/Spinner';
import { VisibilityLabel } from '@/components/VisibilityLabel';

export default function Dashboard() {
  const user = useCurrentUser()!;
  const repos = useQuery({ queryKey: qk.repos, queryFn: api.repos });
  const [filter, setFilter] = useState('');
  const mine = (repos.data ?? []).filter(
    (r) => r.owner.id === user.id || r.ownerType === 'team'
  );
  const shownMine = mine.filter((r) =>
    r.fullName.toLowerCase().includes(filter.toLowerCase())
  );
  return (
    <>
      <Header />
      <div className="d-flex flex-column flex-md-row">
        <aside
          className="col-md-4 col-lg-3 p-4 border-right color-bg-subtle"
          style={{ minHeight: 'calc(100vh - 65px)' }}
        >
          <div className="d-flex flex-items-center mb-2" style={{ gap: 8 }}>
            <Avatar user={{ username: user.username ?? user.name }} size={20} />
            <span className="text-bold f5">{user.username}</span>
          </div>
          <div className="d-flex flex-items-center flex-justify-between mt-4 mb-2">
            <h2 className="f5 text-bold">Top repositories</h2>
            <Link
              to="/new"
              className="btn btn-sm btn-primary d-inline-flex flex-items-center"
              style={{ gap: 4 }}
            >
              <RepoIcon /> New
            </Link>
          </div>
          <input
            className="form-control input-sm width-full mb-3"
            placeholder="Find a repository…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <ul className="list-style-none">
            {shownMine.map((r) => (
              <li
                key={r.id}
                className="d-flex flex-items-center py-1"
                style={{ gap: 8 }}
              >
                <Avatar
                  user={r.owner}
                  size={16}
                  square={r.ownerType === 'team'}
                />
                <Link
                  to={`/${r.fullName}`}
                  className="color-fg-default f5 text-truncate"
                >
                  {r.fullName}
                </Link>
              </li>
            ))}
            {repos.data && mine.length === 0 && (
              <li className="f6 color-fg-muted">
                You don't have any repositories yet.
              </li>
            )}
          </ul>
        </aside>
        <main className="flex-1 p-4" style={{ maxWidth: 960 }}>
          <h2 className="f3 text-normal mb-3">Home</h2>
          {user.role === 'admin' && (
            <div
              className="Box p-3 mb-4 d-flex flex-items-center"
              style={{ gap: 12 }}
            >
              <PersonAddIcon size={24} className="color-fg-accent" />
              <div className="flex-1">
                <div className="text-bold">Bring your team</div>
                <div className="f6 color-fg-muted">
                  Invite members to collaborate on repositories in this
                  instance.
                </div>
              </div>
              <Link to="/admin?invite=1" className="btn btn-sm">
                Invite member
              </Link>
            </div>
          )}
          <h3 className="f5 mb-2">Recently updated across this instance</h3>
          {repos.isPending ? (
            <Spinner />
          ) : repos.data!.length === 0 ? (
            <div className="blankslate Box">
              <RepoIcon size={24} className="color-fg-muted mb-2" />
              <h3 className="blankslate-heading">No repositories yet</h3>
              <p>
                Repositories created by anyone on this instance will show up
                here.
              </p>
              <div className="blankslate-action">
                <Link to="/new" className="btn btn-primary">
                  Create repository
                </Link>
              </div>
            </div>
          ) : (
            <div className="Box">
              {repos.data!.map((r) => (
                <div
                  key={r.id}
                  className="Box-row d-flex flex-items-start"
                  style={{ gap: 12 }}
                >
                  <Avatar
                    user={r.owner}
                    size={32}
                    square={r.ownerType === 'team'}
                  />
                  <div className="flex-1" style={{ minWidth: 0 }}>
                    <Link to={`/${r.fullName}`} className="text-bold f5">
                      {r.fullName}
                    </Link>
                    <VisibilityLabel
                      visibility={r.visibility}
                      className="ml-2 v-align-middle"
                    />
                    {r.description && (
                      <p className="color-fg-muted f6 mb-0 mt-1">
                        {r.description}
                      </p>
                    )}
                  </div>
                  <span className="f6 color-fg-muted no-wrap">
                    Updated {timeAgo(r.updatedAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    </>
  );
}
