import { useMemo } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CodeIcon } from '@primer/octicons-react';
import { api, qk, type FileDiff, type RepoDetail } from '@/lib/uiApi';
import { ApiError } from '@/lib/api';
import { shortSha, timeAgo } from '@/lib/format';
import { parseCommitMessage } from '@/lib/commitMessage';
import { CommitAuthor } from '@/components/CommitAuthor';
import { CoAuthored, CommitBody } from '@/components/CommitBody';
import { CopyButton } from '@/components/CopyButton';
import { DiffTotals, DiffView } from '@/components/DiffView';
import { LoadError } from '@/components/code/LoadError';
import { useEnter } from '@/components/code/useEnter';
import { Section } from '@/components/ui/Section';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePageHead } from '@/components/ui/PageHead';
import { NotFound } from './NotFound';

/** The changed files as a list that jumps to each one's diff (every diff has an `id`). */
function FileSummary({ files }: { files: FileDiff[] }) {
  return (
    <div className="table-wrap file-summary">
      <table className="table">
        <caption className="sr">Changed files</caption>
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Added</th>
            <th scope="col">Removed</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.path}>
              <td className="mono small">
                <a href={`#diff-${encodeURIComponent(f.path)}`}>{f.path}</a>
              </td>
              <td className="mono fs-add">
                {f.binary ? '' : `+${f.additions}`}
              </td>
              <td className="mono fs-del">
                {f.binary ? '' : `−${f.deletions}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One commit: its message (trailers apart), who made it, the files it changed and their diffs. */
export default function CommitView() {
  const repo = useOutletContext<RepoDetail>();
  const o = repo.owner.username;
  const { sha = '' } = useParams();
  const base = `/${repo.fullName}`;
  const q = useQuery({
    queryKey: qk.commit(o, repo.name, sha),
    queryFn: () => api.commit(o, repo.name, sha),
  });
  const commit = q.data?.commit;
  const message = useMemo(
    () => (commit ? parseCommitMessage(commit.message) : null),
    [commit]
  );
  const entering = useEnter(!!q.data);

  const short = shortSha(commit?.hash ?? sha);
  usePageHead({
    icon: 'commit',
    crumbs: [
      { label: 'Commits', to: `${base}/commits/${repo.defaultBranch}` },
      { label: short },
    ],
    title: short,
    documentTitle: message ? `${message.subject} · ${short}` : short,
  });

  // Anything the server refuses (an unknown or unreadable commit) is a missing page; a failed request is not.
  if (q.error instanceof ApiError && q.error.status < 500) return <NotFound />;
  if (q.isError && !q.data)
    return (
      <LoadError
        what="this commit"
        error={q.error}
        onRetry={() => void q.refetch()}
        retrying={q.isFetching}
      />
    );
  if (!q.data || !commit || !message) return <Skeleton kind="graph" />;
  const { files } = q.data;
  const hasMessage = !!message.body || message.trailers.length > 0;
  return (
    <div className={`code-page commit-view ${entering}`}>
      <header className="phead">
        <div className="phead-row">
          <div className="phead-main">
            <h2 className="ph-title">{message.subject}</h2>
          </div>
          <div className="phead-actions">
            <Link to={`${base}/tree/${commit.hash}`} className="btn small">
              <CodeIcon />
              Browse files
            </Link>
          </div>
        </div>
      </header>
      <section className="panel commitbox" aria-label="Commit">
        {hasMessage && (
          <div className="cb-message">
            <CommitBody message={message} />
          </div>
        )}
        <div className="cb-foot">
          <span className="cb-who">
            <CommitAuthor commit={commit} repo={repo} size={22} />
            <CoAuthored trailers={message.trailers} />
            <span className="muted">
              committed {timeAgo(commit.committedAt)}
            </span>
          </span>
          <span className="grow" />
          <span className="muted small cb-parents">
            {commit.parents.length} parent
            {commit.parents.length === 1 ? '' : 's'}{' '}
            {commit.parents.map((p) => (
              <Link key={p} to={`${base}/commit/${p}`} className="mono shabtn">
                {shortSha(p)}
              </Link>
            ))}
          </span>
          <span className="cb-sha small">
            <span className="muted">commit</span>{' '}
            <span className="mono">{commit.hash}</span>
            <CopyButton
              text={commit.hash}
              className="btn small quiet"
              label="Copy full SHA"
            />
          </span>
        </div>
      </section>
      <Section
        title={`${files.length} ${files.length === 1 ? 'file' : 'files'} changed`}
        actions={<DiffTotals files={files} />}
      >
        {files.length > 1 && <FileSummary files={files} />}
        <DiffView files={files} />
      </Section>
    </div>
  );
}
