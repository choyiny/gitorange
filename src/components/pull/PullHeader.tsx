import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { GitBranchIcon, PencilIcon } from '@primer/octicons-react';
import { api, type PullDetail, type RepoDetail } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { CoderChip } from '@/components/CoderChip';
import { PendingButton } from '@/components/ui/PendingButton';
import { PullChip } from './PullChip';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The pull request's statement under the top band: its title and number (editable by its author and anyone who
 * can merge), its state, the coding session that opened it, and what merges into what.
 */
export function PullHeader({
  repo,
  d,
  canEdit,
  onSaved,
}: {
  repo: RepoDetail;
  d: PullDetail;
  canEdit: boolean;
  onSaved: () => Promise<unknown>;
}) {
  const pr = d.pull;
  const base = `/${repo.fullName}`;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.updatePull(repo.owner.username, repo.name, pr.number, {
        title: title.trim(),
      });
      await onSaved();
      setEditing(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const commits = plural(d.commitCount, 'commit');
  return (
    <header className="phead pr-head">
      <div className="phead-row">
        <div className="phead-main">
          {editing ? (
            <form className="pr-title-edit" onSubmit={save}>
              <label className="sr" htmlFor="pr-title-input">
                Title
              </label>
              <input
                id="pr-title-input"
                className="ap-input"
                value={title}
                maxLength={256}
                autoFocus
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditing(false);
                }}
              />
              <div className="actions">
                <PendingButton
                  type="submit"
                  className="primary small"
                  pending={saving}
                  pendingLabel="Saving…"
                  disabled={!title.trim()}
                >
                  Save
                </PendingButton>
                <button
                  type="button"
                  className="btn quiet small"
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </button>
              </div>
              {error && (
                <p className="ap-error" role="alert">
                  {error}
                </p>
              )}
            </form>
          ) : (
            <h2 className="ph-title pr-title">
              {pr.title} <span className="num">#{pr.number}</span>
            </h2>
          )}
          <p className="lede pr-meta">
            <PullChip state={pr.state} pullState={d.pullState} />
            <CoderChip
              createdVia={pr.createdVia}
              sessionLabel={pr.sessionLabel}
              sessionId={pr.sessionId}
              base={base}
              person={pr.author.username}
            />
            {pr.createdVia && (
              <span className="muted">
                for{' '}
                <Link to={`/${pr.author.username}`}>{pr.author.username}</Link>
              </span>
            )}
            <span className="muted pr-merge-line">
              {/* Like GitHub: a merged pull request credits whoever merged it. */}
              {pr.state === 'merged' ? (
                <>
                  {pr.mergedBy ? (
                    <Link to={`/${pr.mergedBy.username}`}>
                      {pr.mergedBy.username}
                    </Link>
                  ) : (
                    'GitOrange'
                  )}{' '}
                  merged {commits} into{' '}
                </>
              ) : (
                <>wants to merge {commits} into </>
              )}
              <code className="pr-branch">{pr.baseRef}</code> from{' '}
              {d.headBranchExists ? (
                <Link to={`${base}/tree/${pr.headRef}`} className="pr-branch">
                  <GitBranchIcon size={12} />
                  {pr.headRef}
                </Link>
              ) : (
                <code className="pr-branch">{pr.headRef}</code>
              )}
            </span>
          </p>
        </div>
        {canEdit && !editing && (
          <div className="phead-actions">
            <button
              type="button"
              className="btn small"
              onClick={() => {
                setTitle(pr.title);
                setError(null);
                setEditing(true);
              }}
            >
              <PencilIcon size={14} />
              Edit title
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
