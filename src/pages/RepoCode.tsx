import {
  Link,
  useLocation,
  useNavigate,
  useOutletContext,
} from 'react-router-dom';
import { useRepoSubPath } from '@/components/RepoLayout';
import { useQuery } from '@tanstack/react-query';
import {
  FileDirectoryFillIcon,
  FileIcon,
  HistoryIcon,
  BookIcon,
  GitBranchIcon,
} from '@primer/octicons-react';
import { api, qk, type Contents, type RepoDetail } from '@/lib/uiApi';
import { firstLine, formatBytes, shortSha, timeAgo } from '@/lib/format';
import { ApiError } from '@/lib/api';
import { Avatar } from '@/components/Avatar';
import { BranchSelect } from '@/components/BranchSelect';
import { CloneButton } from '@/components/CloneButton';
import { CopyButton } from '@/components/CopyButton';
import { Markdown } from '@/components/Markdown';
import { Spinner } from '@/components/Spinner';
import { NotFound } from './NotFound';

function QuickSetup({ repo }: { repo: RepoDetail }) {
  const url = repo.cloneUrl;
  const block = (lines: string[]) => (
    <div className="position-relative">
      <pre
        className="p-3 color-bg-subtle rounded-2 f6 text-mono"
        style={{ overflowX: 'auto' }}
      >
        {lines.join('\n')}
      </pre>
      <div className="position-absolute" style={{ top: 8, right: 8 }}>
        <CopyButton text={lines.join('\n')} />
      </div>
    </div>
  );
  return (
    <div className="container-xl px-3 px-md-4 px-lg-5 pb-6">
      <div className="Box mb-4">
        <div className="Box-row color-bg-accent">
          <h3 className="f4 mb-2">
            Quick setup — if you've done this kind of thing before
          </h3>
          <div className="input-group">
            <span className="input-group-button">
              <span className="btn btn-sm disabled">HTTPS</span>
            </span>
            <input
              className="form-control input-monospace input-sm"
              readOnly
              value={url}
              onFocus={(e) => e.target.select()}
            />
            <span className="input-group-button">
              <CopyButton text={url} />
            </span>
          </div>
          <p className="f6 color-fg-muted mt-2 mb-0">
            Authenticate with your username and a{' '}
            <Link to="/settings/tokens">personal access token</Link> as the
            password. Get started by creating a new file or pushing an existing
            repository.
          </p>
        </div>
        <div className="Box-row">
          <h3 className="f4 text-normal mb-2">
            …or create a new repository on the command line
          </h3>
          {block([
            `echo "# ${repo.name}" >> README.md`,
            'git init',
            'git add README.md',
            'git commit -m "first commit"',
            'git branch -M main',
            `git remote add origin ${url}`,
            'git push -u origin main',
          ])}
        </div>
        <div className="Box-row">
          <h3 className="f4 text-normal mb-2">
            …or push an existing repository from the command line
          </h3>
          {block([
            `git remote add origin ${url}`,
            'git branch -M main',
            'git push -u origin main',
          ])}
        </div>
      </div>
    </div>
  );
}

function Breadcrumb({
  repo,
  refName,
  path,
}: {
  repo: RepoDetail;
  refName: string;
  path: string;
}) {
  const parts = path.split('/').filter(Boolean);
  const base = `/${repo.fullName}`;
  return (
    <div className="f4 d-flex flex-items-center flex-wrap" style={{ gap: 2 }}>
      <Link to={`${base}/tree/${refName}`} className="text-bold">
        {repo.name}
      </Link>
      {parts.map((p, i) => (
        <span key={i} className="d-inline-flex" style={{ gap: 2 }}>
          <span className="color-fg-muted mx-1">/</span>
          {i === parts.length - 1 ? (
            <strong>{p}</strong>
          ) : (
            <Link
              to={`${base}/tree/${refName}/${parts.slice(0, i + 1).join('/')}`}
            >
              {p}
            </Link>
          )}
        </span>
      ))}
    </div>
  );
}

function LatestCommitBar({ repo, data }: { repo: RepoDetail; data: Contents }) {
  const c = data.latestCommit;
  if (!c) return null;
  const base = `/${repo.fullName}`;
  return (
    <div className="latest-commit">
      <Avatar user={{ username: c.author.name }} size={20} />
      <span className="text-bold">{c.author.name}</span>
      <Link
        to={`${base}/commit/${c.hash}`}
        className="color-fg-muted text-truncate flex-1"
      >
        {firstLine(c.message)}
      </Link>
      <Link
        to={`${base}/commit/${c.hash}`}
        className="color-fg-muted text-mono-sm"
      >
        {shortSha(c.hash)}
      </Link>
      <span className="color-fg-muted f6">· {timeAgo(c.committedAt)}</span>
      <Link
        to={`${base}/commits/${data.ref}`}
        className="btn-invisible btn btn-sm d-inline-flex flex-items-center ml-2"
        style={{ gap: 4 }}
      >
        <HistoryIcon /> History
      </Link>
    </div>
  );
}

function TreeView({ repo, data }: { repo: RepoDetail; data: Contents }) {
  const base = `/${repo.fullName}`;
  const lastCommits = useQuery({
    queryKey: qk.treeCommits(
      repo.owner.username,
      repo.name,
      data.commitSha!,
      data.path
    ),
    queryFn: () =>
      api.treeCommits(
        repo.owner.username,
        repo.name,
        data.commitSha!,
        data.path
      ),
    staleTime: Infinity,
  });
  const parent = data.path.split('/').slice(0, -1).join('/');
  return (
    <>
      <div className="Box mb-4">
        <LatestCommitBar repo={repo} data={data} />
        <table className="file-table">
          <colgroup>
            <col style={{ width: '35%' }} />
            <col />
            <col style={{ width: 150 }} />
          </colgroup>
          <tbody>
            {data.path && (
              <tr>
                <td colSpan={3}>
                  <Link
                    to={`${base}/tree/${data.ref}${parent ? '/' + parent : ''}`}
                    className="color-fg-default"
                  >
                    ..
                  </Link>
                </td>
              </tr>
            )}
            {data.entries!.map((e) => {
              const c = lastCommits.data?.[e.name];
              const isDir = e.type === 'tree';
              return (
                <tr key={e.name}>
                  <td>
                    <span
                      className="d-inline-flex flex-items-center"
                      style={{ gap: 8 }}
                    >
                      {isDir ? (
                        <FileDirectoryFillIcon
                          className="color-fg-muted"
                          fill="var(--treeViewItem-leadingVisual-iconColor-rest, #54aeff)"
                        />
                      ) : (
                        <FileIcon className="color-fg-muted" />
                      )}
                      <Link
                        to={`${base}/${isDir ? 'tree' : 'blob'}/${data.ref}/${e.path}`}
                        className="color-fg-default"
                      >
                        {e.name}
                      </Link>
                    </span>
                  </td>
                  <td className="col-msg">
                    {c ? (
                      <Link to={`${base}/commit/${c.hash}`}>
                        {firstLine(c.message)}
                      </Link>
                    ) : (
                      <span className="color-fg-muted">&nbsp;</span>
                    )}
                  </td>
                  <td className="col-age">{c ? timeAgo(c.committedAt) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.readme && (
        <div className="Box mb-4">
          <div
            className="Box-header d-flex flex-items-center py-2"
            style={{ gap: 8 }}
          >
            <BookIcon />
            <span className="text-bold f6">
              {data.readme.path.split('/').pop()}
            </span>
          </div>
          <div className="Box-body p-4">
            {/\.(md|markdown)$/i.test(data.readme.path) ? (
              <Markdown source={data.readme.text} />
            ) : (
              <pre style={{ whiteSpace: 'pre-wrap' }}>{data.readme.text}</pre>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function BlobView({ repo, data }: { repo: RepoDetail; data: Contents }) {
  const f = data.file!;
  const lines = f.text?.split('\n') ?? [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const raw = api.rawUrl(repo.owner.username, repo.name, data.ref, data.path);
  const isMarkdown = /\.(md|markdown)$/i.test(f.path) && f.text !== null;
  return (
    <div className="Box mb-4">
      <LatestCommitBar repo={repo} data={data} />
      <div className="Box-header d-flex flex-items-center flex-justify-between py-2">
        <span className="f6 color-fg-muted text-mono">
          {f.text !== null && `${lines.length} lines · `}
          {formatBytes(f.size)}
        </span>
        <div className="d-flex" style={{ gap: 8 }}>
          <a href={raw} className="btn btn-sm" target="_blank" rel="noreferrer">
            Raw
          </a>
          {f.text !== null && (
            <CopyButton text={f.text} label="Copy raw content" />
          )}
        </div>
      </div>
      {isMarkdown ? (
        <div className="p-4">
          <Markdown source={f.text!} />
        </div>
      ) : f.text === null ? (
        <div className="p-6 text-center color-fg-muted">
          {f.binary ? (
            /\.(png|jpe?g|gif|webp)$/i.test(f.path) ? (
              <img src={raw} alt={f.path} style={{ maxWidth: '100%' }} />
            ) : (
              <>
                Binary file not shown. <a href={raw}>View raw</a>
              </>
            )
          ) : (
            <>
              (Sorry about that, but we can't show files that are this big right
              now.) <a href={raw}>View raw</a>
            </>
          )}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }} className="py-2">
          <table className="blob-table">
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} id={`L${i + 1}`}>
                  <td className="blob-num">{i + 1}</td>
                  <td className="blob-code">{l}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function RepoCode() {
  const repo = useOutletContext<RepoDetail>();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const isBlob = pathname.split('/')[3] === 'blob';
  const treePath = useRepoSubPath('tree');
  const blobPath = useRepoSubPath('blob');
  const refPath = isBlob ? blobPath : treePath;
  const q = useQuery({
    queryKey: qk.contents(repo.owner.username, repo.name, refPath),
    queryFn: () => api.contents(repo.owner.username, repo.name, refPath),
    enabled: !repo.empty,
  });
  if (repo.empty) return <QuickSetup repo={repo} />;
  if (q.error instanceof ApiError && q.error.status === 404)
    return <NotFound inline />;
  if (!q.data) return <Spinner />;
  const data = q.data;
  const atRoot = !data.path;
  return (
    <div className="container-xl px-3 px-md-4 px-lg-5 pb-6">
      <div
        className="d-flex flex-items-center flex-wrap mb-3"
        style={{ gap: 8 }}
      >
        <BranchSelect
          branches={repo.branches}
          current={data.ref}
          defaultBranch={repo.defaultBranch}
          onSelect={(b) =>
            navigate(
              `/${repo.fullName}/${isBlob ? 'blob' : 'tree'}/${b}${data.path ? '/' + data.path : ''}`
            )
          }
        />
        {atRoot ? (
          <span
            className="f6 d-inline-flex flex-items-center color-fg-muted"
            style={{ gap: 4 }}
          >
            <GitBranchIcon />{' '}
            <strong className="color-fg-default">{repo.branches.length}</strong>{' '}
            {repo.branches.length === 1 ? 'Branch' : 'Branches'}
          </span>
        ) : (
          <Breadcrumb repo={repo} refName={data.ref} path={data.path} />
        )}
        <div className="flex-1" />
        {atRoot && <CloneButton url={repo.cloneUrl} />}
      </div>
      <div
        className={atRoot ? 'd-flex flex-column flex-lg-row' : ''}
        style={{ gap: 24 }}
      >
        <div className="flex-1" style={{ minWidth: 0 }}>
          {data.kind === 'tree' ? (
            <TreeView repo={repo} data={data} />
          ) : (
            <BlobView repo={repo} data={data} />
          )}
        </div>
        {atRoot && (
          <aside className="col-lg-3">
            <h2 className="f4 mb-3">About</h2>
            <p className="f5 mb-3">
              {repo.description || (
                <span className="color-fg-muted fst-italic">
                  No description provided.
                </span>
              )}
            </p>
            <div className="f6 color-fg-muted">
              Created {timeAgo(repo.createdAt)}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
