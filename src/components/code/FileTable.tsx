import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileDirectoryFillIcon, FileIcon } from '@primer/octicons-react';
import { api, qk, type Contents, type RepoDetail } from '@/lib/uiApi';
import { firstLine, timeAgo } from '@/lib/format';
import { encodeRepoPath, parentPath } from '@/lib/codeView';
import { LatestCommit } from './LatestCommit';

/**
 * A directory: the latest-commit bar, then one row per entry with the commit that last touched it (one request
 * for the whole directory, cached for good: a commit's content never changes).
 */
export function FileTable({
  repo,
  data,
}: {
  repo: RepoDetail;
  data: Contents;
}) {
  const base = `/${repo.fullName}`;
  const o = repo.owner.username;
  const lastCommits = useQuery({
    queryKey: qk.treeCommits(o, repo.name, data.commitSha!, data.path),
    queryFn: () => api.treeCommits(o, repo.name, data.commitSha!, data.path),
    staleTime: Infinity,
  });
  const parent = parentPath(data.path);
  const entries = data.entries ?? [];
  return (
    <div className="filetable panel">
      <LatestCommit repo={repo} data={data} />
      <table className="ft">
        <colgroup>
          <col className="ft-col-name" />
          <col className="ft-col-msg" />
          <col className="ft-col-date" />
        </colgroup>
        <tbody>
          {data.path && (
            <tr>
              <td colSpan={3}>
                <Link
                  to={`${base}/tree/${data.ref}${parent ? '/' + encodeRepoPath(parent) : ''}`}
                  className="ft-name"
                  aria-label="Up to the parent directory"
                >
                  ..
                </Link>
              </td>
            </tr>
          )}
          {entries.length === 0 && (
            <tr>
              <td colSpan={3} className="ft-empty">
                This directory is empty.
              </td>
            </tr>
          )}
          {entries.map((e) => {
            const c = lastCommits.data?.[e.name];
            const isDir = e.type === 'tree';
            return (
              <tr key={e.name}>
                <td className="ft-namecell">
                  <Link
                    to={`${base}/${isDir ? 'tree' : 'blob'}/${data.ref}/${encodeRepoPath(e.path)}`}
                    className="ft-name"
                  >
                    {isDir ? (
                      <FileDirectoryFillIcon className="icon dir" />
                    ) : (
                      <FileIcon className="icon file" />
                    )}
                    {e.name}
                  </Link>
                </td>
                <td className="ft-subj">
                  {c ? (
                    <Link to={`${base}/commit/${c.hash}`}>
                      {firstLine(c.message)}
                    </Link>
                  ) : lastCommits.isPending ? (
                    <span className="sk sk-line w50" aria-hidden="true" />
                  ) : null}
                </td>
                <td className="ft-date">{c ? timeAgo(c.committedAt) : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
