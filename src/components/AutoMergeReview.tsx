import { useState } from 'react';
import {
  AlertIcon,
  CheckCircleFillIcon,
  ClockIcon,
  FileDiffIcon,
  ShieldCheckIcon,
  StopIcon,
} from '@primer/octicons-react';
import {
  api,
  type PullDetail,
  type RepoDetail,
  type ReviewFlag,
} from '@/lib/uiApi';
import { ApiError, errorMessage } from '@/lib/api';
import { Avatar } from './Avatar';
import { Markdown } from './Markdown';
import { Spinner } from './Spinner';

/** The timeline comment's anchor, linked from the merge box. */
export const REVIEW_ANCHOR = 'auto-merge-review';

/** Runs an action, then waits for the page to reload before reporting it done. */
export function useAction(onChange: () => Promise<unknown> | void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    fn: () => Promise<unknown>,
    opts?: { sendingNote?: boolean }
  ) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChange();
      return true;
    } catch (e) {
      const moved = e instanceof ApiError && e.status === 409;
      setError(
        errorMessage(e) +
          (moved && opts?.sendingNote ? ' Your note was not sent.' : '')
      );
      // A 409 means the pull request moved: show what changed. A failed reload doesn't hide the error.
      if (moved) await Promise.resolve(onChange()).catch(() => {});
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

// ── merge box ────────────────────────────────────────────────────────────────

/** One line in the merge box: whether the pull request will merge on its own, and why not yet. */
export function AutoMergeStatus({
  repo,
  d,
  onChange,
}: {
  repo: RepoDetail;
  d: PullDetail;
  onChange: () => Promise<unknown> | void;
}) {
  const review = d.review!;
  const { state, reasons } = review.autoMerge;
  const { busy, error, run } = useAction(onChange);
  const enabled = state !== 'disabled';
  const pendingFlags = review.reviewers.some((r) =>
    r.flags.some((f) => !f.approvedAt)
  );
  let line: React.ReactNode;
  if (state === 'ready')
    line = (
      <>
        <Spinner size={16} />
        <span className="text-bold">Merging automatically…</span>
      </>
    );
  else if (state === 'disabled')
    line = (
      <>
        <StopIcon className="color-fg-muted mt-1" />
        <span className="text-bold">
          Auto-merge is off for this pull request
        </span>
      </>
    );
  else if (state === 'blocked')
    line = (
      <>
        <AlertIcon className="color-fg-danger mt-1" />
        <span>
          <span className="text-bold">Won&apos;t merge automatically:</span>{' '}
          {reasons.join('; ')}
        </span>
      </>
    );
  else
    line = (
      <>
        <ClockIcon className="color-fg-muted mt-1" />
        <span>
          <span className="text-bold">Merges automatically once ready.</span>{' '}
          <span className="color-fg-muted">
            Waiting on: {reasons.join('; ')}
          </span>
          {pendingFlags && (
            <>
              {' '}
              <a href={`#${REVIEW_ANCHOR}`}>Review the flags</a>
            </>
          )}
        </span>
      </>
    );
  return (
    <div className="Box-row">
      <div className="d-flex flex-items-start" style={{ gap: 8 }}>
        <div className="flex-1 d-flex flex-items-start" style={{ gap: 8 }}>
          {line}
        </div>
        {d.canMerge && (
          <button
            className="btn btn-sm btn-invisible flex-shrink-0"
            disabled={busy}
            onClick={() =>
              run(() =>
                api.setAutoMerge(
                  repo.owner.username,
                  repo.name,
                  d.pull.number,
                  !enabled
                )
              )
            }
          >
            {enabled ? 'Turn off auto-merge' : 'Turn on auto-merge'}
          </button>
        )}
      </div>
      {error && <div className="flash flash-error mt-2">{error}</div>}
    </div>
  );
}

// ── timeline comment ─────────────────────────────────────────────────────────

/** Longest note when requesting changes on a flag (the server's limit). */
const CHANGES_NOTE_MAX = 1000;

/** Who requested changes on a flag, and their note. */
export type ChangesRequester = {
  label: string;
  user: ReviewFlag['changesRequestedBy'];
  note: string | null;
};

/** The flag's current request for changes, from the server; null once approved. */
export function serverChangesRequester(f: ReviewFlag): ChangesRequester | null {
  return f.changesRequestedAt && !f.approvedAt
    ? {
        label: f.changesRequestedBy?.username ?? 'a former user',
        user: f.changesRequestedBy,
        note: f.changesRequestedNote,
      }
    : null;
}

export function Flag({
  f,
  approver,
  changesRequester,
  canApprove,
  approving,
  requestingChanges,
  investigating,
  onApprove,
  onRequestChanges,
}: {
  f: ReviewFlag;
  /** Who approved it: from the server, or "you" right after approving. */
  approver: { label: string; user: ReviewFlag['approvedBy'] } | null;
  /** Who asked for changes instead (only while unapproved), with their note. */
  changesRequester: ChangesRequester | null;
  canApprove: boolean;
  approving: boolean;
  requestingChanges: boolean;
  /** The agent is still reviewing, so a finding may not have its detail yet. */
  investigating: boolean;
  onApprove: () => void;
  /** Resolves to whether it worked, so the note box closes only then. */
  onRequestChanges: (note: string) => Promise<boolean>;
}) {
  const change = f.kind === 'change_requested';
  const [composing, setComposing] = useState(false);
  const [note, setNote] = useState('');
  const changes = approver ? null : changesRequester;
  const busy = approving || requestingChanges;
  const submit = async () => {
    if (await onRequestChanges(note)) {
      setComposing(false);
      setNote('');
    }
  };
  return (
    <div
      className={`border rounded-2 p-2 p-sm-3 mb-2${changes ? ' color-border-danger' : ''}`}
    >
      <div className="d-flex flex-items-start" style={{ gap: 8 }}>
        {approver ? (
          <CheckCircleFillIcon className="color-fg-success mt-1 flex-shrink-0" />
        ) : changes ? (
          <FileDiffIcon className="color-fg-danger mt-1 flex-shrink-0" />
        ) : (
          <AlertIcon className="color-fg-attention mt-1 flex-shrink-0" />
        )}
        <div className="flex-1" style={{ minWidth: 0 }}>
          <div
            className="d-flex flex-items-center flex-wrap"
            style={{ gap: 8 }}
          >
            <span className="text-bold">{f.title}</span>
            {change && (
              <span className="Label Label--danger">Change requested</span>
            )}
          </div>
          {f.paths.length > 0 && (
            <div className="f6 mt-1 d-flex flex-wrap" style={{ gap: 4 }}>
              {f.paths.map((p) => (
                <code key={p} style={{ overflowWrap: 'anywhere' }}>
                  {p}
                </code>
              ))}
            </div>
          )}
          {f.detail ? (
            <div className="mt-2 review-flag-detail">
              <Markdown source={f.detail} />
            </div>
          ) : (
            f.source !== 'limit' &&
            (investigating ? (
              <div
                className="f6 color-fg-muted mt-1 d-flex flex-items-center"
                style={{ gap: 6 }}
              >
                <Spinner size={12} /> Looking into this…
              </div>
            ) : (
              <div className="f6 color-fg-muted mt-1">
                No further detail: the review model didn&apos;t answer.
              </div>
            ))
          )}
          {changes && (
            <div className="flash flash-error mt-2 f6">
              <div
                className="d-flex flex-items-center text-bold"
                style={{ gap: 4 }}
              >
                {changes.user && <Avatar user={changes.user} size={16} />}
                Changes requested by {changes.label}
              </div>
              {changes.note && (
                <div
                  className="mt-1 color-fg-default"
                  style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >
                  {changes.note}
                </div>
              )}
            </div>
          )}
          {composing && !approver && (
            <div className="mt-2">
              <textarea
                className="form-control width-full"
                style={{ minHeight: 64, resize: 'vertical' }}
                placeholder="What needs to change? (optional)"
                aria-label="Note for requesting changes"
                maxLength={CHANGES_NOTE_MAX}
                value={note}
                autoFocus
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="d-flex flex-justify-end mt-2" style={{ gap: 8 }}>
                <button
                  className="btn btn-sm"
                  disabled={requestingChanges}
                  onClick={() => setComposing(false)}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  disabled={busy}
                  onClick={submit}
                >
                  {requestingChanges ? (
                    <>
                      <Spinner size={12} /> Requesting…
                    </>
                  ) : (
                    'Request changes'
                  )}
                </button>
              </div>
            </div>
          )}
          <div
            className="d-flex flex-items-center flex-justify-end mt-2"
            style={{ gap: 8 }}
          >
            {approver ? (
              <span
                className="f6 color-fg-success d-flex flex-items-center"
                style={{ gap: 4 }}
              >
                {approver.user && <Avatar user={approver.user} size={16} />}
                {change ? 'Dismissed' : 'Approved'} by {approver.label}
              </span>
            ) : canApprove ? (
              <>
                {!composing && !change && (
                  <button
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => setComposing(true)}
                  >
                    <FileDiffIcon /> Request changes
                  </button>
                )}
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={onApprove}
                >
                  {approving ? (
                    <>
                      <Spinner size={12} />{' '}
                      {change ? 'Dismissing…' : 'Approving…'}
                    </>
                  ) : change ? (
                    'Dismiss'
                  ) : (
                    <>
                      <ShieldCheckIcon /> Approve
                    </>
                  )}
                </button>
              </>
            ) : (
              !changes && (
                <span className="f6 color-fg-muted">Not approved</span>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
