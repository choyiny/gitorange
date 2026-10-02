import { useState } from 'react';
import { Link, NavLink, useOutletContext, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckIcon,
  CommentDiscussionIcon,
  FileDiffIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  AlertIcon,
  TriangleDownIcon,
  GitBranchIcon,
} from '@primer/octicons-react';
import {
  api,
  qk,
  type Comment,
  type PullDetail,
  type RepoDetail,
} from '@/lib/uiApi';
import { useCurrentUser } from '@/lib/auth';
import { ApiError, errorMessage } from '@/lib/api';
import { fullDate, timeAgo } from '@/lib/format';
import { Avatar } from '@/components/Avatar';
import { CommitList } from '@/components/CommitList';
import { DiffTotals, DiffView } from '@/components/DiffView';
import { MarkdownEditor } from '@/components/CommentForm';
import { Markdown } from '@/components/Markdown';
import { Dropdown } from '@/components/Dropdown';
import { Spinner } from '@/components/Spinner';
import { NotFound } from './NotFound';
import { PrStateBadge } from './PrIcons';

function TimelineComment({
  c,
  me,
  label,
}: {
  c: Pick<Comment, 'author' | 'body' | 'createdAt'>;
  me: boolean;
  label?: string;
}) {
  return (
    <div className="d-flex mb-3" style={{ gap: 16 }}>
      <Link to={`/${c.author.username}`} className="d-none d-md-block">
        <Avatar user={c.author} size={40} />
      </Link>
      <div
        className={`timeline-comment comment-arrow flex-1 ${me ? 'current-user' : ''}`}
        style={{ minWidth: 0 }}
      >
        <div className="timeline-comment-header">
          <Link
            to={`/${c.author.username}`}
            className="text-bold color-fg-default"
          >
            {c.author.username}
          </Link>
          <span title={fullDate(c.createdAt)}>
            commented {timeAgo(c.createdAt)}
          </span>
          <span className="flex-1" />
          {label && <span className="Label">{label}</span>}
        </div>
        <div className="p-3">
          {c.body.trim() ? (
            <Markdown source={c.body} />
          ) : (
            <p className="color-fg-muted fst-italic mb-0">
              No description provided.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function TimelineEvent({
  icon,
  bg,
  children,
}: {
  icon: React.ReactNode;
  bg?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="TimelineItem ml-md-4 pl-md-3" style={{ marginLeft: 0 }}>
      <div
        className="TimelineItem-badge"
        style={
          bg
            ? { background: bg, color: 'var(--fgColor-onEmphasis)' }
            : undefined
        }
      >
        {icon}
      </div>
      <div
        className="TimelineItem-body f6 d-flex flex-items-center flex-wrap"
        style={{ gap: 4 }}
      >
        {children}
      </div>
    </div>
  );
}

function MergeBox({
  repo,
  d,
  onDone,
}: {
  repo: RepoDetail;
  d: PullDetail;
  onDone: () => void;
}) {
  const pr = d.pull;
  const [method, setMethod] = useState<'merge' | 'squash'>('merge');
  const [confirming, setConfirming] = useState(false);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = () => {
    setTitle(
      method === 'squash'
        ? `${pr.title} (#${pr.number})`
        : `Merge pull request #${pr.number} from ${repo.owner.username}/${pr.headRef}`
    );
    setMessage(method === 'squash' ? '' : pr.title);
    setConfirming(true);
  };
  const merge = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.mergePull(repo.owner.username, repo.name, pr.number, {
        method,
        title,
        message,
      });
      setConfirming(false);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const conflict = d.mergeable === false && d.conflicts.length > 0;
  const nothing = d.mergeable === false && !conflict;
  const label = method === 'squash' ? 'Squash and merge' : 'Merge pull request';
  return (
    <div className="d-flex mb-3" style={{ gap: 16 }}>
      <div
        className={`merge-box-icon d-none d-md-flex ${conflict ? 'color-bg-neutral-emphasis' : 'color-bg-success-emphasis'}`}
      >
        <GitMergeIcon size={24} />
      </div>
      <div
        className="Box flex-1"
        style={{
          borderColor: conflict
            ? undefined
            : 'var(--borderColor-success-emphasis)',
        }}
      >
        <div className="Box-row d-flex flex-items-start" style={{ gap: 12 }}>
          {d.mergeable === null ? (
            <Spinner size={16} />
          ) : conflict ? (
            <AlertIcon size={24} className="color-fg-attention" />
          ) : (
            <CheckIcon size={24} className="color-fg-success" />
          )}
          <div>
            <h3 className="f5">
              {conflict
                ? 'This branch has conflicts that must be resolved'
                : nothing
                  ? 'This branch is up to date'
                  : 'No conflicts with base branch'}
            </h3>
            <p className="f6 color-fg-muted mb-0">
              {conflict ? (
                <>
                  Resolve conflicts locally, then push to{' '}
                  <code>{pr.headRef}</code>. Conflicting files:{' '}
                  {d.conflicts.map((c) => (
                    <code key={c} className="mr-1">
                      {c}
                    </code>
                  ))}
                </>
              ) : nothing ? (
                'There is nothing to merge.'
              ) : (
                'Merging can be performed automatically.'
              )}
            </p>
          </div>
        </div>
        {d.canMerge && d.mergeable && (
          <div className="Box-row">
            {error && <div className="flash flash-error mb-2">{error}</div>}
            {confirming ? (
              <div>
                <input
                  className="form-control width-full mb-2 text-bold"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <textarea
                  className="form-control width-full mb-2"
                  rows={3}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
                <div className="d-flex" style={{ gap: 8 }}>
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={merge}
                  >
                    {busy
                      ? 'Merging…'
                      : method === 'squash'
                        ? 'Confirm squash and merge'
                        : 'Confirm merge'}
                  </button>
                  <button className="btn" onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="BtnGroup d-inline-flex">
                <button
                  className="btn btn-primary BtnGroup-item"
                  onClick={open}
                >
                  {label}
                </button>
                <Dropdown
                  width={340}
                  trigger={(_, toggle) => (
                    <button
                      className="btn btn-primary BtnGroup-item"
                      aria-label="Select merge method"
                      onClick={toggle}
                    >
                      <TriangleDownIcon />
                    </button>
                  )}
                >
                  {(close) => (
                    <div className="py-1">
                      {(
                        [
                          [
                            'merge',
                            'Create a merge commit',
                            'All commits from this branch will be added to the base branch via a merge commit.',
                          ],
                          [
                            'squash',
                            'Squash and merge',
                            'The 1 or more commits from this branch will be combined into one commit in the base branch.',
                          ],
                        ] as const
                      ).map(([m, t, desc]) => (
                        <button
                          key={m}
                          className="select-panel-item flex-items-start"
                          onClick={() => {
                            setMethod(m);
                            close();
                          }}
                        >
                          <span style={{ width: 16 }}>
                            {method === m && <CheckIcon />}
                          </span>
                          <span>
                            <span className="d-block text-bold">{t}</span>
                            <span className="d-block f6 color-fg-muted">
                              {desc}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </Dropdown>
              </div>
            )}
          </div>
        )}
        {!d.canMerge && (
          <div className="Box-row f6 color-fg-muted">
            Only those with write access to this repository can merge pull
            requests.
          </div>
        )}
      </div>
    </div>
  );
}

function Conversation({
  repo,
  d,
  refresh,
}: {
  repo: RepoDetail;
  d: PullDetail;
  refresh: () => void;
}) {
  const me = useCurrentUser()!;
  const pr = d.pull;
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchDeleted, setBranchDeleted] = useState(false);
  const canEdit = d.canMerge || pr.author.id === me.id;
  const send = async (andState?: 'open' | 'closed') => {
    setBusy(true);
    setError(null);
    try {
      if (body.trim())
        await api.comment(repo.owner.username, repo.name, pr.number, body);
      if (andState)
        await api.updatePull(repo.owner.username, repo.name, pr.number, {
          state: andState,
        });
      setBody('');
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const deleteBranch = async () => {
    await api.deleteBranch(repo.owner.username, repo.name, pr.headRef);
    setBranchDeleted(true);
    refresh();
  };
  return (
    <div className="d-flex flex-column flex-md-row" style={{ gap: 24 }}>
      <div className="flex-1" style={{ minWidth: 0 }}>
        <TimelineComment
          c={{ author: pr.author, body: pr.body, createdAt: pr.createdAt }}
          me={pr.author.id === me.id}
          label="Author"
        />
        {d.comments.map((c) => (
          <TimelineComment
            key={c.id}
            c={c}
            me={c.author.id === me.id}
            label={c.author.id === pr.author.id ? 'Author' : undefined}
          />
        ))}
        {pr.state === 'merged' && (
          <>
            <TimelineEvent
              icon={<GitMergeIcon />}
              bg="var(--bgColor-done-emphasis)"
            >
              <Avatar user={pr.mergedBy!} size={20} />
              <strong>{pr.mergedBy!.username}</strong> merged commit{' '}
              <Link
                to={`/${repo.fullName}/commit/${pr.mergeCommitSha}`}
                className="text-mono-sm text-bold"
              >
                {pr.mergeCommitSha!.slice(0, 7)}
              </Link>{' '}
              into <code>{pr.baseRef}</code> {timeAgo(pr.mergedAt!)}
            </TimelineEvent>
            <div className="d-flex mb-3 mt-2" style={{ gap: 16 }}>
              <div className="merge-box-icon d-none d-md-flex color-bg-done-emphasis">
                <GitMergeIcon size={24} />
              </div>
              <div
                className="Box flex-1 p-3 d-flex flex-items-center"
                style={{ gap: 12 }}
              >
                <div className="flex-1">
                  <h3 className="f5">
                    Pull request successfully merged and closed
                  </h3>
                  <p className="f6 color-fg-muted mb-0">
                    {d.headBranchExists && !branchDeleted ? (
                      <>
                        You’re all set — the <code>{pr.headRef}</code> branch
                        can be safely deleted.
                      </>
                    ) : (
                      <>
                        The <code>{pr.headRef}</code> branch has been deleted.
                      </>
                    )}
                  </p>
                </div>
                {d.canMerge &&
                  d.headBranchExists &&
                  !branchDeleted &&
                  pr.headRef !== repo.defaultBranch && (
                    <button className="btn" onClick={deleteBranch}>
                      Delete branch
                    </button>
                  )}
              </div>
            </div>
          </>
        )}
        {pr.state === 'closed' && (
          <TimelineEvent
            icon={<GitPullRequestClosedIcon />}
            bg="var(--bgColor-closed-emphasis)"
          >
            This pull request was closed {timeAgo(pr.closedAt!)}
          </TimelineEvent>
        )}
        {pr.state === 'open' && <MergeBox repo={repo} d={d} onDone={refresh} />}
        <div className="border-top pt-3 mt-3 d-flex" style={{ gap: 16 }}>
          <Avatar
            user={{ username: me.username ?? me.name }}
            size={40}
            className="d-none d-md-block"
          />
          <div className="flex-1">
            <h3 className="f4 mb-2">Add a comment</h3>
            {error && <div className="flash flash-error mb-2">{error}</div>}
            <MarkdownEditor
              value={body}
              onChange={setBody}
              placeholder="Use Markdown to format your comment"
            />
            <div className="d-flex flex-justify-end mt-2" style={{ gap: 8 }}>
              {canEdit && pr.state === 'open' && (
                <button
                  className="btn d-inline-flex flex-items-center"
                  style={{ gap: 4 }}
                  disabled={busy}
                  onClick={() => send('closed')}
                >
                  <GitPullRequestClosedIcon className="color-fg-closed" />{' '}
                  {body.trim() ? 'Close with comment' : 'Close pull request'}
                </button>
              )}
              {canEdit && pr.state === 'closed' && d.headBranchExists && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => send('open')}
                >
                  Reopen pull request
                </button>
              )}
              <button
                className="btn btn-primary"
                disabled={busy || !body.trim()}
                onClick={() => send()}
              >
                Comment
              </button>
            </div>
          </div>
        </div>
      </div>
      <aside className="col-md-3 f6">
        <div className="border-bottom pb-3 mb-3">
          <div className="text-bold color-fg-muted mb-2">Participants</div>
          <div className="d-flex flex-wrap" style={{ gap: 4 }}>
            {[
              pr.author,
              ...d.comments.map((c) => c.author),
              ...(pr.mergedBy ? [pr.mergedBy] : []),
            ]
              .filter((u, i, all) => all.findIndex((x) => x.id === u.id) === i)
              .map((u) => (
                <Link key={u.id} to={`/${u.username}`}>
                  <Avatar user={u} size={26} />
                </Link>
              ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

export default function PullView() {
  const repo = useOutletContext<RepoDetail>();
  const me = useCurrentUser()!;
  const qc = useQueryClient();
  const { number = '0', tab = '' } = useParams();
  const num = Number(number);
  const o = repo.owner.username;
  const q = useQuery({
    queryKey: qk.pull(o, repo.name, num),
    queryFn: () => api.pull(o, repo.name, num),
  });
  const commits = useQuery({
    queryKey: qk.pullCommits(o, repo.name, num),
    queryFn: () => api.pullCommits(o, repo.name, num),
    enabled: tab === 'commits',
  });
  const files = useQuery({
    queryKey: qk.pullFiles(o, repo.name, num),
    queryFn: () => api.pullFiles(o, repo.name, num),
    enabled: tab === 'files',
  });
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  if (q.error instanceof ApiError && q.error.status === 404)
    return <NotFound inline />;
  if (!q.data) return <Spinner />;
  const d = q.data;
  const pr = d.pull;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.pull(o, repo.name, num) });
    qc.invalidateQueries({ queryKey: qk.repo(o, repo.name) });
    qc.invalidateQueries({ queryKey: ['repo', o, repo.name, 'pulls'] });
  };
  const base = `/${repo.fullName}/pull/${num}`;
  const canEdit = d.canMerge || pr.author.id === me.id;
  return (
    <div className="container-xl px-3 px-md-4 px-lg-5 pb-6">
      <div className="mb-3">
        {editing ? (
          <div className="d-flex" style={{ gap: 8 }}>
            <input
              className="form-control input-lg flex-1"
              value={title}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
            />
            <button
              className="btn"
              onClick={async () => {
                await api.updatePull(o, repo.name, num, { title });
                setEditing(false);
                refresh();
              }}
            >
              Save
            </button>
            <button className="btn-link" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="d-flex flex-items-start" style={{ gap: 8 }}>
            <h1
              className="f1 text-normal flex-1"
              style={{ wordBreak: 'break-word' }}
            >
              {pr.title}{' '}
              <span className="color-fg-muted f1-light">#{pr.number}</span>
            </h1>
            {canEdit && (
              <button
                className="btn btn-sm mt-2"
                onClick={() => {
                  setTitle(pr.title);
                  setEditing(true);
                }}
              >
                Edit
              </button>
            )}
          </div>
        )}
        <div
          className="d-flex flex-items-center flex-wrap mt-2 pb-3 border-bottom f5"
          style={{ gap: 8 }}
        >
          <PrStateBadge state={pr.state} />
          <span className="color-fg-muted">
            <Link
              to={`/${pr.author.username}`}
              className="text-bold color-fg-muted"
            >
              {pr.author.username}
            </Link>{' '}
            {pr.state === 'merged' ? (
              <>
                merged {d.commitCount} commit{d.commitCount === 1 ? '' : 's'}{' '}
                into{' '}
              </>
            ) : (
              <>
                wants to merge {d.commitCount} commit
                {d.commitCount === 1 ? '' : 's'} into{' '}
              </>
            )}
            <span className="branch-name">{pr.baseRef}</span> from{' '}
            <Link
              to={`/${repo.fullName}/tree/${pr.headRef}`}
              className="branch-name"
            >
              <GitBranchIcon size={12} /> {pr.headRef}
            </Link>
          </span>
        </div>
      </div>
      <nav className="tabnav">
        <div className="tabnav-tabs">
          <NavLink
            end
            to={base}
            className={({ isActive }) =>
              `tabnav-tab d-inline-flex flex-items-center${isActive ? ' selected' : ''}`
            }
            style={{ gap: 6 }}
          >
            <CommentDiscussionIcon /> Conversation{' '}
            <span className="Counter">{d.comments.length}</span>
          </NavLink>
          <NavLink
            to={`${base}/commits`}
            className={({ isActive }) =>
              `tabnav-tab d-inline-flex flex-items-center${isActive ? ' selected' : ''}`
            }
            style={{ gap: 6 }}
          >
            <GitCommitIcon /> Commits{' '}
            <span className="Counter">{d.commitCount}</span>
          </NavLink>
          <NavLink
            to={`${base}/files`}
            className={({ isActive }) =>
              `tabnav-tab d-inline-flex flex-items-center${isActive ? ' selected' : ''}`
            }
            style={{ gap: 6 }}
          >
            <FileDiffIcon /> Files changed{' '}
            {files.data && <span className="Counter">{files.data.length}</span>}
          </NavLink>
        </div>
      </nav>
      {tab === 'files' && files.data && (
        <div className="d-flex flex-justify-end f6 mb-2">
          <DiffTotals files={files.data} />
        </div>
      )}
      {tab === '' && <Conversation repo={repo} d={d} refresh={refresh} />}
      {tab === 'commits' &&
        (commits.data ? (
          <CommitList
            commits={[...commits.data].reverse()}
            base={`/${repo.fullName}`}
          />
        ) : (
          <Spinner />
        ))}
      {tab === 'files' &&
        (files.data ? <DiffView files={files.data} /> : <Spinner />)}
    </div>
  );
}
