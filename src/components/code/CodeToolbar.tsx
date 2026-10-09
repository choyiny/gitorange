import { Link, useNavigate } from 'react-router-dom';
import { GitBranchIcon, SearchIcon } from '@primer/octicons-react';
import { encodeRepoPath, pathCrumbs } from '@/lib/codeView';
import type { Contents, RepoDetail } from '@/lib/uiApi';
import { BranchSelect } from '@/components/BranchSelect';
import { CloneButton } from '@/components/CloneButton';

/** Search is global (top band, `/`); inside a repository it is scoped to it, files included. */
const focusSearch = () => document.getElementById('gsearch')?.focus();

/** The path to the current directory or file, each part a link. */
function PathBar({
  repo,
  refName,
  path,
  isBlob,
}: {
  repo: RepoDetail;
  refName: string;
  path: string;
  isBlob: boolean;
}) {
  const base = `/${repo.fullName}`;
  return (
    <nav className="pathbar" aria-label="Path">
      <Link to={`${base}/tree/${refName}`}>
        <b>{repo.name}</b>
      </Link>
      {pathCrumbs(base, refName, path).map((c) => (
        <span key={c.label + (c.to ?? '')} className="pathbar-part">
          <span className="sep">/</span>
          {c.to ? <Link to={c.to}>{c.label}</Link> : <b>{c.label}</b>}
        </span>
      ))}
      {!isBlob && <span className="sep">/</span>}
    </nav>
  );
}

/**
 * Above the files: the branch, how many there are and a way to the branch map (not on an agent's repository, which
 * has no Branches tab), "Go to file", and the clone menu; below it, the path when inside a directory or a file.
 */
export function CodeToolbar({
  repo,
  data,
  isBlob,
  agentRepo,
}: {
  repo: RepoDetail;
  data: Contents;
  isBlob: boolean;
  agentRepo: boolean;
}) {
  const navigate = useNavigate();
  const atRoot = !data.path;
  const base = `/${repo.fullName}`;
  const count = repo.branches.length;
  return (
    <>
      <div className="codebar">
        <BranchSelect
          triggerClassName="btn small"
          branches={repo.branches}
          current={data.ref}
          defaultBranch={repo.defaultBranch}
          onSelect={(b) =>
            navigate(
              `${base}/${isBlob ? 'blob' : 'tree'}/${b}${data.path ? '/' + encodeRepoPath(data.path) : ''}`
            )
          }
        />
        {atRoot &&
          (agentRepo ? (
            <span className="branch-count small muted">
              <GitBranchIcon />
              <span>
                <b>{count}</b> {count === 1 ? 'branch' : 'branches'}
              </span>
            </span>
          ) : (
            <Link className="btn small quiet" to={`${base}/branches`}>
              <GitBranchIcon />
              <span>
                <b>{count}</b> {count === 1 ? 'branch' : 'branches'}
              </span>
            </Link>
          ))}
        {!agentRepo && (
          <Link className="btn small" to={`${base}/branches`}>
            <GitBranchIcon />
            Open the branch map
          </Link>
        )}
        <span className="grow" />
        <button
          type="button"
          className="btn small"
          onClick={focusSearch}
          title="Search this repository (press /)"
        >
          <SearchIcon />
          Go to file
        </button>
        {!isBlob && <CloneButton repo={repo} />}
      </div>
      {!atRoot && (
        <PathBar
          repo={repo}
          refName={data.ref}
          path={data.path}
          isBlob={isBlob}
        />
      )}
    </>
  );
}
