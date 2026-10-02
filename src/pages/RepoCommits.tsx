import { useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useRepoSubPath } from '@/components/RepoLayout';
import { api, qk, type RepoDetail } from '@/lib/uiApi';
import { BranchSelect } from '@/components/BranchSelect';
import { CommitList } from '@/components/CommitList';
import { Spinner } from '@/components/Spinner';

export default function RepoCommits() {
  const repo = useOutletContext<RepoDetail>();
  const navigate = useNavigate();
  const ref = useRepoSubPath('commits') || repo.defaultBranch;
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: qk.commits(repo.owner.username, repo.name, ref, page),
    queryFn: () => api.commits(repo.owner.username, repo.name, ref, page),
  });
  return (
    <div className="container-xl px-3 px-md-4 px-lg-5 pb-6">
      <h1 className="f3 text-normal mb-3">Commits</h1>
      <div className="mb-3">
        <BranchSelect
          branches={repo.branches}
          current={ref}
          defaultBranch={repo.defaultBranch}
          onSelect={(b) => {
            setPage(1);
            navigate(`/${repo.fullName}/commits/${b}`);
          }}
        />
      </div>
      {!q.data ? (
        <Spinner />
      ) : (
        <CommitList commits={q.data.commits} base={`/${repo.fullName}`} />
      )}
      <div className="d-flex flex-justify-center">
        <div className="BtnGroup">
          <button
            className="btn btn-sm BtnGroup-item"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            Newer
          </button>
          <button
            className="btn btn-sm BtnGroup-item"
            disabled={!q.data?.hasMore}
            onClick={() => setPage(page + 1)}
          >
            Older
          </button>
        </div>
      </div>
    </div>
  );
}
