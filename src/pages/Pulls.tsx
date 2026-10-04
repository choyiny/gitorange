import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CheckIcon,
  CommentIcon,
  GitPullRequestIcon,
} from '@primer/octicons-react';
import { api, qk, type RepoDetail } from '@/lib/uiApi';
import { timeAgo } from '@/lib/format';
import { Spinner } from '@/components/Spinner';
import { ChecksBadge, useCommitStatuses } from '@/components/Checks';
import { PrStateIcon } from './PrIcons';

export default function Pulls() {
  const repo = useOutletContext<RepoDetail>();
  const [params, setParams] = useSearchParams();
  const state = params.get('state') === 'closed' ? 'closed' : 'open';
  const q = useQuery({
    queryKey: qk.pulls(repo.owner.username, repo.name, state),
    queryFn: () => api.pulls(repo.owner.username, repo.name, state),
  });
  // Checks for every listed pull request's head commit, in one request.
  const statuses = useCommitStatuses(
    repo,
    (q.data?.pulls ?? []).map((p) => p.headSha)
  );
  const base = `/${repo.fullName}`;
  return (
    <div className="container-xl px-3 px-md-4 px-lg-5 pb-6">
      <div className="d-flex flex-items-center mb-3" style={{ gap: 8 }}>
        <input
          className="form-control flex-1"
          readOnly
          value={`is:pr is:${state}`}
          aria-label="Search all pull requests"
        />
        {repo.permissions.write && (
          <Link to={`${base}/compare`} className="btn btn-primary">
            New pull request
          </Link>
        )}
      </div>
      <div className="Box">
        <div
          className="Box-header d-flex flex-items-center"
          style={{ gap: 16 }}
        >
          <button
            className={`btn-link d-inline-flex flex-items-center f5 ${state === 'open' ? 'text-bold color-fg-default' : 'color-fg-muted'}`}
            style={{ gap: 4, textDecoration: 'none' }}
            onClick={() => setParams({})}
          >
            <GitPullRequestIcon /> {q.data?.openCount ?? ''} Open
          </button>
          <button
            className={`btn-link d-inline-flex flex-items-center f5 ${state === 'closed' ? 'text-bold color-fg-default' : 'color-fg-muted'}`}
            style={{ gap: 4, textDecoration: 'none' }}
            onClick={() => setParams({ state: 'closed' })}
          >
            <CheckIcon /> {q.data?.closedCount ?? ''} Closed
          </button>
        </div>
        {!q.data ? (
          <Spinner />
        ) : q.data.pulls.length === 0 ? (
          <div className="blankslate">
            <GitPullRequestIcon size={24} className="color-fg-muted mb-2" />
            <h3 className="blankslate-heading">
              There aren't any {state} pull requests.
            </h3>
            {state === 'open' && repo.permissions.write && (
              <p>
                Pull requests help you collaborate on code with other people.{' '}
                <Link to={`${base}/compare`}>Create a pull request</Link>.
              </p>
            )}
          </div>
        ) : (
          q.data.pulls.map((p) => (
            <div
              key={p.id}
              className="Box-row Box-row--hover-gray d-flex flex-items-start"
              style={{ gap: 8 }}
            >
              <span className="pt-1">
                <PrStateIcon state={p.state} />
              </span>
              <div className="flex-1" style={{ minWidth: 0 }}>
                <Link
                  to={`${base}/pull/${p.number}`}
                  className="Link--primary text-bold f4 color-fg-default"
                >
                  {p.title}
                </Link>{' '}
                <ChecksBadge
                  repo={repo}
                  checks={p.headSha ? statuses.data?.[p.headSha] : undefined}
                />
                <div className="f6 color-fg-muted mt-1">
                  #{p.number}{' '}
                  {p.state === 'open' && (
                    <>
                      opened {timeAgo(p.createdAt)} by{' '}
                      <Link
                        to={`/${p.author.username}`}
                        className="color-fg-muted"
                      >
                        {p.author.username}
                      </Link>
                    </>
                  )}
                  {p.state === 'merged' && (
                    <>
                      by{' '}
                      <Link
                        to={`/${p.author.username}`}
                        className="color-fg-muted"
                      >
                        {p.author.username}
                      </Link>{' '}
                      was merged {timeAgo(p.mergedAt!)}
                    </>
                  )}
                  {p.state === 'closed' && (
                    <>
                      by{' '}
                      <Link
                        to={`/${p.author.username}`}
                        className="color-fg-muted"
                      >
                        {p.author.username}
                      </Link>{' '}
                      was closed {timeAgo(p.closedAt!)}
                    </>
                  )}
                </div>
              </div>
              {p.commentCount > 0 && (
                <Link
                  to={`${base}/pull/${p.number}`}
                  className="color-fg-muted f6 d-inline-flex flex-items-center"
                  style={{ gap: 4 }}
                >
                  <CommentIcon /> {p.commentCount}
                </Link>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
