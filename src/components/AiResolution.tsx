import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SparkleFillIcon,
} from '@primer/octicons-react';
import { api, qk, type PullDetail, type RepoDetail } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { DiffView } from './DiffView';
import { Spinner } from './Spinner';

/** The resolved files: the proposal's commit against the base tip, conflicted files only. */
function ResolvedFiles({
  repo,
  base,
  result,
  paths,
}: {
  repo: RepoDetail;
  base: string;
  result: string;
  paths: string[];
}) {
  const o = repo.owner.username;
  const q = useQuery({
    queryKey: qk.compare(o, repo.name, base, result),
    queryFn: () => api.compare(o, repo.name, base, result),
  });
  if (!q.data) return <Spinner />;
  const wanted = new Set(paths);
  return <DiffView files={q.data.files.filter((f) => wanted.has(f.path))} />;
}

/**
 * The AI conflict-resolution panel in the merge box. Resolutions start on their own; this shows
 * one running, the result (the model's explanation and the resolved files, which merging lands),
 * or a failure with a way to retry.
 */
export function AiResolution({
  repo,
  d,
  onChange,
}: {
  repo: RepoDetail;
  d: PullDetail;
  onChange: () => void;
}) {
  const r = d.resolution;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const o = repo.owner.username;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    act(() => api.startResolution(o, repo.name, d.pull.number));

  const current = r && !r.stale ? r : null;

  if (current?.status === 'queued')
    return (
      <div className="Box-row d-flex flex-items-center" style={{ gap: 12 }}>
        <Spinner size={16} />
        <div>
          <div className="text-bold">Waiting to resolve conflicts with AI…</div>
          <div className="f6 color-fg-muted">
            Other pull requests in this repository are being resolved first.
            This one starts as soon as one of them finishes.
          </div>
        </div>
      </div>
    );

  if (current?.status === 'running')
    return (
      <div className="Box-row d-flex flex-items-center" style={{ gap: 12 }}>
        <Spinner size={16} />
        <div>
          <div className="text-bold">Resolving conflicts with AI…</div>
          <div className="f6 color-fg-muted">
            An agent is combining both sides of{' '}
            {current.conflictedPaths.map((p) => (
              <code key={p} className="mr-1">
                {p}
              </code>
            ))}
            . This usually takes under a minute.
          </div>
        </div>
      </div>
    );

  if (current?.status === 'proposed' && current.resultSha)
    return (
      <>
        <div className="Box-row">
          <div className="d-flex flex-items-center mb-2" style={{ gap: 8 }}>
            <SparkleFillIcon className="color-fg-done" />
            <span className="text-bold">Conflicts resolved by AI</span>
            <span className="f6 color-fg-muted">
              <code>{current.model.replace(/^@cf\//, '')}</code>
              {current.durationMs === 0
                ? ' · reused: the base branch changed elsewhere'
                : current.durationMs
                  ? ` · ${Math.round(current.durationMs / 1000)}s`
                  : ''}
            </span>
          </div>
          {current.explanation && <p className="mb-2">{current.explanation}</p>}
          {current.touchedExtraPaths.length > 0 && (
            <div className="flash flash-warn mb-2 f6">
              <AlertIcon /> The agent also created or changed files outside the
              conflicts; they are not included:{' '}
              {current.touchedExtraPaths.map((p) => (
                <code key={p} className="mr-1">
                  {p}
                </code>
              ))}
            </div>
          )}
          {error && <div className="flash flash-error mb-2">{error}</div>}
          <div className="d-flex flex-wrap" style={{ gap: 8 }}>
            <button
              className="btn btn-sm btn-invisible"
              onClick={() => setShowFiles((v) => !v)}
            >
              {showFiles ? <ChevronDownIcon /> : <ChevronRightIcon />} Resolved
              files
            </button>
            <button
              className="btn btn-sm btn-invisible color-fg-muted"
              disabled={busy}
              onClick={() =>
                act(() =>
                  api.rejectResolution(o, repo.name, d.pull.number, current.id)
                )
              }
            >
              Discard
            </button>
          </div>
        </div>
        {showFiles && (
          <div className="Box-row">
            <ResolvedFiles
              repo={repo}
              base={current.baseSha}
              result={current.resultSha}
              paths={current.conflictedPaths}
            />
          </div>
        )}
      </>
    );

  // No attempt for these commits yet: one starts on its own (after a push, or when this page
  // is opened), so there is nothing to click.
  if (!current)
    return (
      <div className="Box-row d-flex flex-items-center" style={{ gap: 12 }}>
        <Spinner size={16} />
        <div className="f6 color-fg-muted">
          Starting AI conflict resolution…
        </div>
      </div>
    );

  // The attempt for these commits failed or was discarded: only now does a person decide.
  return (
    <div className="Box-row">
      {current.status === 'failed' && (
        <div className="flash flash-error mb-2 f6">
          AI couldn&apos;t resolve these conflicts:{' '}
          {current.errorMessage ?? 'unknown error'}
        </div>
      )}
      {current.status === 'rejected' && (
        <div className="f6 color-fg-muted mb-2">
          The AI resolution was discarded.
        </div>
      )}
      {error && <div className="flash flash-error mb-2">{error}</div>}
      <button className="btn" disabled={busy} onClick={start}>
        <SparkleFillIcon className="color-fg-done" />{' '}
        {busy ? 'Starting…' : 'Try again with AI'}
      </button>
      <span className="f6 color-fg-muted ml-2">
        Or resolve the conflicts locally and push.
      </span>
    </div>
  );
}
