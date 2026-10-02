import { useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  CheckIcon,
  XIcon,
  GitCommitIcon,
  FileDiffIcon,
} from '@primer/octicons-react';
import { useRepoSubPath } from '@/components/RepoLayout';
import { api, qk, type RepoDetail } from '@/lib/uiApi';
import { useCurrentUser } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { firstLine } from '@/lib/format';
import { Avatar } from '@/components/Avatar';
import { BranchSelect } from '@/components/BranchSelect';
import { CommitList } from '@/components/CommitList';
import { DiffTotals, DiffView } from '@/components/DiffView';
import { MarkdownEditor } from '@/components/CommentForm';
import { Spinner } from '@/components/Spinner';

export default function PullNew() {
  const repo = useOutletContext<RepoDetail>();
  const user = useCurrentUser()!;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const range = useRepoSubPath('compare') ?? '';
  const [baseParam, headParam] = range.includes('...')
    ? range.split('...')
    : [repo.defaultBranch, range];
  const base = baseParam || repo.defaultBranch;
  const head = headParam || '';
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cmp = useQuery({
    queryKey: qk.compare(repo.owner.username, repo.name, base, head),
    queryFn: () => api.compare(repo.owner.username, repo.name, base, head),
    enabled: !!head && head !== base,
  });
  const go = (b: string, h: string) =>
    navigate(`/${repo.fullName}/compare/${b}...${h}`);
  const ready =
    cmp.data && cmp.data.commits.length > 0 && cmp.data.status !== 'behind';

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const pr = await api.createPull(repo.owner.username, repo.name, {
        title,
        body,
        base,
        head,
      });
      await qc.invalidateQueries({
        queryKey: qk.repo(repo.owner.username, repo.name),
      });
      navigate(`/${repo.fullName}/pull/${pr.number}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="container-xl px-3 px-md-4 px-lg-5 pb-6">
      <div className="Subhead">
        <h2 className="Subhead-heading">
          {showForm ? 'Open a pull request' : 'Comparing changes'}
        </h2>
        <div className="Subhead-description">
          {showForm
            ? 'Create a new pull request by comparing changes across two branches.'
            : 'Choose two branches to see what’s changed or to start a new pull request.'}
        </div>
      </div>
      <div
        className="Box p-2 mb-3 color-bg-subtle d-flex flex-items-center flex-wrap"
        style={{ gap: 8 }}
      >
        <BranchSelect
          branches={repo.branches}
          current={base}
          label="base:"
          onSelect={(b) => go(b, head)}
        />
        <ArrowLeftIcon className="color-fg-muted" />
        <BranchSelect
          branches={repo.branches}
          current={head || 'choose…'}
          label="compare:"
          onSelect={(h) => go(base, h)}
        />
        {cmp.data && head !== base && (
          <span
            className="f6 d-inline-flex flex-items-center ml-2"
            style={{ gap: 4 }}
          >
            {cmp.data.mergeable || cmp.data.status === 'ahead' ? (
              <>
                <CheckIcon className="color-fg-success" />
                <strong className="color-fg-success">Able to merge.</strong>
                <span className="color-fg-muted">
                  These branches can be automatically merged.
                </span>
              </>
            ) : cmp.data.conflicts.length ? (
              <>
                <XIcon className="color-fg-danger" />
                <strong className="color-fg-danger">
                  Can’t automatically merge.
                </strong>
                <span className="color-fg-muted">
                  Don’t worry, you can still create the pull request.
                </span>
              </>
            ) : null}
          </span>
        )}
      </div>

      {!head || head === base ? (
        <div className="blankslate Box">
          <h3 className="blankslate-heading">Compare changes</h3>
          <p>
            Compare changes across branches. Pick a branch to compare against{' '}
            <strong>{base}</strong>.
          </p>
          <div
            className="d-flex flex-wrap flex-justify-center mt-3"
            style={{ gap: 8 }}
          >
            {repo.branches
              .filter((b) => b.name !== base)
              .map((b) => (
                <button
                  key={b.name}
                  className="btn btn-sm"
                  onClick={() => go(base, b.name)}
                >
                  {b.name}
                </button>
              ))}
          </div>
        </div>
      ) : cmp.isPending ? (
        <Spinner />
      ) : cmp.error ? (
        <div className="flash flash-error">{errorMessage(cmp.error)}</div>
      ) : !ready ? (
        <div className="blankslate Box">
          <h3 className="blankslate-heading">
            There isn’t anything to compare.
          </h3>
          <p>
            <strong>{base}</strong> is up to date with all commits from{' '}
            <strong>{head}</strong>.
          </p>
        </div>
      ) : (
        <>
          {!showForm ? (
            <div
              className="flash flash-full mb-3 d-flex flex-items-center rounded-2 border"
              style={{ gap: 12 }}
            >
              <span className="flex-1">
                Discuss and review the changes in this comparison with others.
              </span>
              {repo.permissions.write && (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setShowForm(true);
                    if (!title)
                      setTitle(
                        cmp.data!.commits.length === 1
                          ? firstLine(cmp.data!.commits[0].message)
                          : head
                              .replace(/[-_/]/g, ' ')
                              .replace(/^./, (c) => c.toUpperCase())
                      );
                  }}
                >
                  Create pull request
                </button>
              )}
            </div>
          ) : (
            <div className="d-flex mb-4" style={{ gap: 16 }}>
              <Avatar
                user={{ username: user.username ?? user.name }}
                size={40}
                className="d-none d-md-block"
              />
              <div
                className="timeline-comment comment-arrow flex-1 p-2"
                style={{ borderColor: 'var(--borderColor-default)' }}
              >
                {error && <div className="flash flash-error mb-2">{error}</div>}
                <label className="d-block f5 text-bold mb-1">Add a title</label>
                <input
                  className="form-control input-lg width-full mb-3"
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Title"
                />
                <label className="d-block f5 text-bold mb-1">
                  Add a description
                </label>
                <MarkdownEditor
                  value={body}
                  onChange={setBody}
                  placeholder="Add your description here..."
                  minHeight={200}
                />
                <div className="d-flex flex-justify-end mt-2">
                  <button
                    className="btn btn-primary"
                    disabled={busy || !title.trim()}
                    onClick={create}
                  >
                    {busy ? 'Creating…' : 'Create pull request'}
                  </button>
                </div>
              </div>
            </div>
          )}
          <div className="Box mb-4 d-flex flex-justify-around py-2 f5">
            <span
              className="d-inline-flex flex-items-center"
              style={{ gap: 4 }}
            >
              <GitCommitIcon /> <strong>{cmp.data!.commits.length}</strong>{' '}
              commit{cmp.data!.commits.length === 1 ? '' : 's'}
            </span>
            <span
              className="d-inline-flex flex-items-center"
              style={{ gap: 4 }}
            >
              <FileDiffIcon /> <strong>{cmp.data!.files.length}</strong> file
              {cmp.data!.files.length === 1 ? '' : 's'} changed
            </span>
            <DiffTotals files={cmp.data!.files} />
          </div>
          <CommitList
            commits={[...cmp.data!.commits].reverse()}
            base={`/${repo.fullName}`}
          />
          <DiffView files={cmp.data!.files} />
        </>
      )}
      <p className="f6 color-fg-muted mt-4">
        <Link to={`/${repo.fullName}/pulls`}>Back to pull requests</Link>
      </p>
    </div>
  );
}
