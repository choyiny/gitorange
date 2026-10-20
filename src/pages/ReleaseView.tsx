import { useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitMergeIcon, TagIcon } from '@primer/octicons-react';
import { api, qk, type Release, type RepoDetail } from '@/lib/uiApi';
import { ApiError, errorMessage } from '@/lib/api';
import { fullDate, shortSha, timeAgo } from '@/lib/format';
import { bumpLabel } from '@/lib/versionBump';
import { Markdown } from '@/components/Markdown';
import { MarkdownEditor } from '@/components/CommentForm';
import { LoadError } from '@/components/code/LoadError';
import { Chip } from '@/components/ui/Chip';
import { usePageHead } from '@/components/ui/PageHead';
import { PendingButton } from '@/components/ui/PendingButton';
import { Section } from '@/components/ui/Section';
import { Skeleton } from '@/components/ui/Skeleton';
import { NOT_FOUND_HEAD, NotFound } from './NotFound';

/**
 * One release (`/:owner/:repo/releases/:tag`): its notes, the commit it tags, the pull requests it shipped and, with
 * push access, "Edit" for its title and notes (nothing else about a release changes).
 */
export default function ReleaseView() {
  const repo = useOutletContext<RepoDetail>();
  const { tag = '' } = useParams();
  const o = repo.owner.username;
  const q = useQuery({
    queryKey: qk.release(o, repo.name, tag),
    queryFn: () => api.release(o, repo.name, tag),
    enabled: !!tag,
  });
  const missing = q.error instanceof ApiError && q.error.status === 404;
  usePageHead(
    missing
      ? NOT_FOUND_HEAD
      : {
          icon: 'tag',
          crumbs: [
            { label: 'Releases', to: `/${repo.fullName}/releases` },
            { label: tag },
          ],
          title: tag,
          tab: 'releases',
          documentTitle:
            q.data && q.data.title !== tag ? `${q.data.title} · ${tag}` : tag,
        }
  );
  if (missing || !tag) return <NotFound />;
  if (q.isError && !q.data)
    return (
      <LoadError
        what="this release"
        error={q.error}
        onRetry={() => void q.refetch()}
        retrying={q.isFetching}
      />
    );
  if (!q.data) return <Skeleton kind="detail" />;
  return <ReleaseBody repo={repo} release={q.data} />;
}

function ReleaseBody({
  repo,
  release: r,
}: {
  repo: RepoDetail;
  release: Release;
}) {
  const base = `/${repo.fullName}`;
  const [editing, setEditing] = useState(false);
  return (
    <>
      <header className="phead">
        <div className="phead-row">
          <div className="phead-main">
            <h2 className="ph-title">{r.title}</h2>
            <p className="lede rel-entry-meta">
              <span className="chip info">
                <TagIcon size={13} />
                {r.tag}
              </span>
              <span>
                Cut{' '}
                <time
                  dateTime={new Date(r.createdAt).toISOString()}
                  title={fullDate(r.createdAt)}
                >
                  {timeAgo(r.createdAt)}
                </time>
                {r.createdBy && (
                  <>
                    {' '}
                    by <Link to={`/${r.createdBy}`}>{r.createdBy}</Link>
                  </>
                )}{' '}
                at{' '}
                <Link to={`${base}/commit/${r.commitSha}`} className="mono">
                  {shortSha(r.commitSha)}
                </Link>
              </span>
            </p>
          </div>
          {repo.permissions.write && !editing && (
            <div className="phead-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
            </div>
          )}
        </div>
      </header>
      {editing ? (
        <EditRelease repo={repo} release={r} onDone={() => setEditing(false)} />
      ) : (
        <Section title="Notes">
          <div className="panel rel-entry">
            {r.notes.trim() ? (
              <Markdown source={r.notes} className="rel-notes" />
            ) : (
              <p className="muted small">No notes.</p>
            )}
          </div>
        </Section>
      )}
      {r.pulls.length > 0 && (
        <Section title="Pull requests">
          <ul className="panel rel-pulls">
            {r.pulls.map((p) => (
              <li key={p.number}>
                <GitMergeIcon size={16} className="rel-merged" />
                <span className="rel-pull-main">
                  <Link to={`${base}/pull/${p.number}`}>{p.title}</Link>{' '}
                  <span className="muted small">#{p.number}</span>
                </span>
                <Chip tone={p.bump ? 'info' : 'off'}>{bumpLabel(p.bump)}</Chip>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <p className="small muted">
        <Link to={`${base}/releases`}>Back to releases</Link>
      </p>
    </>
  );
}

/** The title and notes, edited in place; the tag, commit and pull requests stay as they were cut. */
function EditRelease({
  repo,
  release: r,
  onDone,
}: {
  repo: RepoDetail;
  release: Release;
  onDone: () => void;
}) {
  const o = repo.owner.username;
  const qc = useQueryClient();
  const [title, setTitle] = useState(r.title);
  const [notes, setNotes] = useState(r.notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updateRelease(o, repo.name, r.tag, {
        title: title.trim(),
        notes,
      });
      await qc.invalidateQueries({ queryKey: qk.repo(o, repo.name) });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="panel rel-form rel-edit"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && title.trim()) void save();
      }}
    >
      {error && (
        <p className="rel-error" role="alert">
          {error}
        </p>
      )}
      <div className="fld">
        <label htmlFor="rel-title">Title</label>
        <input
          id="rel-title"
          className="form-control"
          value={title}
          maxLength={256}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="fld">
        <span className="lbl">Notes</span>
        <MarkdownEditor
          value={notes}
          onChange={setNotes}
          placeholder="What this release changes"
          minHeight={200}
        />
      </div>
      <div className="rel-form-actions">
        <button
          type="button"
          className="btn quiet"
          onClick={onDone}
          disabled={busy}
        >
          Cancel
        </button>
        <PendingButton
          type="submit"
          className="primary"
          pending={busy}
          pendingLabel="Saving…"
          disabled={!title.trim()}
        >
          Save
        </PendingButton>
      </div>
    </form>
  );
}
