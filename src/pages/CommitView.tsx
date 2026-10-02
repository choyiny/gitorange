import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qk, type RepoDetail } from '@/lib/uiApi';
import { firstLine, restOfMessage, shortSha, timeAgo } from '@/lib/format';
import { ApiError } from '@/lib/api';
import { Avatar } from '@/components/Avatar';
import { DiffTotals, DiffView } from '@/components/DiffView';
import { Spinner } from '@/components/Spinner';
import { NotFound } from './NotFound';

export default function CommitView() {
  const repo = useOutletContext<RepoDetail>();
  const { sha = '' } = useParams();
  const q = useQuery({
    queryKey: qk.commit(repo.owner.username, repo.name, sha),
    queryFn: () => api.commit(repo.owner.username, repo.name, sha),
  });
  if (q.error instanceof ApiError) return <NotFound inline />;
  if (!q.data) return <Spinner />;
  const { commit, files } = q.data;
  const base = `/${repo.fullName}`;
  const rest = restOfMessage(commit.message);
  return (
    <div className="container-xl px-3 px-md-4 px-lg-5 pb-6">
      <div className="Box mb-4">
        <div className="Box-header">
          <div className="d-flex flex-justify-between flex-items-start">
            <h2 className="f3 text-normal">{firstLine(commit.message)}</h2>
            <Link to={`${base}/tree/${commit.hash}`} className="btn btn-sm">
              Browse files
            </Link>
          </div>
          {rest && (
            <pre className="mt-2 f6" style={{ whiteSpace: 'pre-wrap' }}>
              {rest}
            </pre>
          )}
        </div>
        <div
          className="Box-body d-flex flex-items-center flex-wrap f6"
          style={{ gap: 6 }}
        >
          <Avatar user={{ username: commit.author.name }} size={20} />
          <span className="text-bold">{commit.author.name}</span>
          <span className="color-fg-muted">
            committed {timeAgo(commit.committedAt)}
          </span>
          <span className="flex-1" />
          <span className="color-fg-muted">
            {commit.parents.length} parent
            {commit.parents.length === 1 ? '' : 's'}{' '}
            {commit.parents.map((p) => (
              <Link
                key={p}
                to={`${base}/commit/${p}`}
                className="text-mono-sm mr-1"
              >
                {shortSha(p)}
              </Link>
            ))}
          </span>
          <span className="color-fg-muted">
            commit{' '}
            <span className="text-mono-sm color-fg-default">{commit.hash}</span>
          </span>
        </div>
      </div>
      <div className="d-flex flex-items-center mb-3 f6" style={{ gap: 8 }}>
        <span>
          Showing{' '}
          <strong>
            {files.length} changed file{files.length === 1 ? '' : 's'}
          </strong>
        </span>
        <DiffTotals files={files} />
      </div>
      <DiffView files={files} />
    </div>
  );
}
