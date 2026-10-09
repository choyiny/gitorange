import { useQuery } from '@tanstack/react-query';
import {
  useNavigate,
  useOutletContext,
  useSearchParams,
} from 'react-router-dom';
import { GitCommitIcon } from '@primer/octicons-react';
import { useRepoAgent, useRepoSubPath } from '@/components/RepoLayout';
import { api, qk, type RepoDetail } from '@/lib/uiApi';
import { BranchSelect } from '@/components/BranchSelect';
import { CommitList } from '@/components/CommitList';
import { LoadError } from '@/components/code/LoadError';
import { useEnter } from '@/components/code/useEnter';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';

/** A page of this branch's commits, newest first, grouped by day. The page number is in the URL (`?page=2`). */
export default function RepoCommits() {
  const repo = useOutletContext<RepoDetail>();
  const o = repo.owner.username;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const ref = useRepoSubPath('commits') || repo.defaultBranch;
  const agent = useRepoAgent(o, repo.name);
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '', 10) || 1);
  const q = useQuery({
    queryKey: qk.commits(o, repo.name, ref, page),
    queryFn: () => api.commits(o, repo.name, ref, page),
    // Paging keeps the current list on screen until the next page arrives; another branch never borrows it.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[4] === ref ? previous : undefined,
  });
  const goTo = (n: number) =>
    setParams(n > 1 ? { page: String(n) } : {}, { replace: false });
  const entering = useEnter(!!q.data);

  const commits = q.data?.commits ?? [];
  return (
    <div className={`code-page ${entering}`}>
      <PageHead
        icon="commit"
        crumbs={[{ label: 'Commits' }]}
        title="Commits"
        lede={
          agent ? (
            'Every change to how this agent reviews.'
          ) : (
            <>
              Every change on <b>{ref}</b>.
            </>
          )
        }
      />
      <div className="codebar">
        <BranchSelect
          triggerClassName="btn small"
          branches={repo.branches}
          current={ref}
          defaultBranch={repo.defaultBranch}
          onSelect={(b) => navigate(`/${repo.fullName}/commits/${b}`)}
        />
        {page > 1 && <span className="small muted">Page {page}</span>}
      </div>
      {q.isError && !q.data ? (
        <LoadError
          what="the commits"
          error={q.error}
          onRetry={() => void q.refetch()}
          retrying={q.isFetching}
        />
      ) : !q.data ? (
        <div
          className="sk-rows"
          role="status"
          aria-busy="true"
          aria-label="Loading commits"
        >
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="sk sk-row" />
          ))}
        </div>
      ) : commits.length === 0 ? (
        <div className="panel">
          <EmptyState
            picture={<GitCommitIcon size={20} />}
            title={
              page > 1 ? 'There is nothing on this page' : 'No commits yet'
            }
            body={
              page > 1
                ? 'You have gone past the oldest commit.'
                : `There are no commits on ${ref}.`
            }
            action={
              page > 1 ? (
                <button
                  type="button"
                  className="btn small"
                  onClick={() => goTo(1)}
                >
                  Back to the newest
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <CommitList commits={commits} base={`/${repo.fullName}`} repo={repo} />
      )}
      {(page > 1 || q.data?.hasMore) && (
        <nav className="pager" aria-label="Pages of commits">
          <button
            type="button"
            className="btn small"
            disabled={page === 1}
            onClick={() => goTo(page - 1)}
          >
            Newer
          </button>
          <button
            type="button"
            className="btn small"
            disabled={!q.data?.hasMore}
            onClick={() => goTo(page + 1)}
          >
            Older
          </button>
        </nav>
      )}
    </div>
  );
}
