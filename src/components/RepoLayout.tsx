import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useParams,
} from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CodeIcon,
  GitPullRequestIcon,
  GearIcon,
  PlayIcon,
  RepoIcon,
} from '@primer/octicons-react';
import { api, qk, type RepoDetail } from '@/lib/uiApi';
import { ApiError } from '@/lib/api';
import { Header } from './Header';
import { Spinner } from './Spinner';
import { VisibilityLabel } from './VisibilityLabel';
import { NotFound } from '@/pages/NotFound';

export function useRepoParams() {
  const { owner = '', repo = '' } = useParams();
  return { owner, repo };
}

/**
 * The part of the URL after `/:owner/:repo/<section>/`. Read from the location because the
 * outer catch-all route also defines a `*` param, so useParams()['*'] is ambiguous here.
 */
export function useRepoSubPath(section: string) {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean);
  if (parts[2] !== section) return '';
  return decodeURIComponent(parts.slice(3).join('/'));
}

export function useRepo() {
  const { owner, repo } = useRepoParams();
  return useQuery({
    queryKey: qk.repo(owner, repo),
    queryFn: () => api.repo(owner, repo),
  });
}

function Tab({
  to,
  icon,
  label,
  count,
  end,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  count?: number;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `UnderlineNav-item${isActive ? ' selected' : ''}`
      }
      aria-current={undefined}
    >
      {({ isActive }) => (
        <>
          <span className="UnderlineNav-octicon">{icon}</span>
          <span data-content={label} className={isActive ? 'text-bold' : ''}>
            {label}
          </span>
          {count !== undefined && count > 0 && (
            <span className="Counter repo-tab-count">{count}</span>
          )}
        </>
      )}
    </NavLink>
  );
}

export function RepoLayout() {
  const { owner, repo } = useRepoParams();
  const q = useRepo();
  const { pathname } = useLocation();
  if (q.error instanceof ApiError && q.error.status === 404)
    return <NotFound />;
  const data = q.data;
  const base = `/${owner}/${repo}`;
  const codeActive =
    !/^\/[^/]+\/[^/]+\/(pulls?|compare|settings|actions)(\/|$)/.test(pathname);
  return (
    <>
      <Header
        context={
          <>
            <Link to={`/${owner}`}>{owner}</Link>
            <span className="sep">/</span>
            <Link to={base}>{repo}</Link>
          </>
        }
        nav={
          <nav className="UnderlineNav" aria-label="Repository">
            <div className="UnderlineNav-body">
              <NavLink
                to={base}
                end
                className={() =>
                  `UnderlineNav-item${codeActive ? ' selected' : ''}`
                }
              >
                <span className="UnderlineNav-octicon">
                  <CodeIcon />
                </span>
                <span className={codeActive ? 'text-bold' : ''}>Code</span>
              </NavLink>
              <Tab
                to={`${base}/pulls`}
                icon={<GitPullRequestIcon />}
                label="Pull requests"
                count={data?.openPullCount}
              />
              <Tab to={`${base}/actions`} icon={<PlayIcon />} label="Actions" />
              {data?.permissions.admin && (
                <Tab
                  to={`${base}/settings`}
                  icon={<GearIcon />}
                  label="Settings"
                />
              )}
            </div>
          </nav>
        }
      />
      <main>
        {!data ? (
          <Spinner />
        ) : (
          <>
            <div className="container-xl px-3 px-md-4 px-lg-5 pt-4">
              <div className="d-flex flex-items-center mb-3" style={{ gap: 8 }}>
                <RepoIcon className="color-fg-muted" />
                <strong className="f3 text-normal">
                  <Link to={`/${owner}`} className="color-fg-default">
                    {owner}
                  </Link>
                  <span className="mx-1 color-fg-muted">/</span>
                  <Link to={base} className="text-bold color-fg-default">
                    {repo}
                  </Link>
                </strong>
                <VisibilityLabel visibility={data.visibility} />
              </div>
            </div>
            <Outlet context={data satisfies RepoDetail} />
          </>
        )}
      </main>
    </>
  );
}
