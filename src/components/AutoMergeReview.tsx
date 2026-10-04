import { useState } from 'react';
import {
  AlertIcon,
  CheckCircleFillIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  ShieldCheckIcon,
  SparkleFillIcon,
  StopIcon,
} from '@primer/octicons-react';
import {
  api,
  type ClassifierAnswer,
  type PullDetail,
  type PullReview,
  type RepoDetail,
  type ReviewFlag,
} from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import { fullDate, timeAgo } from '@/lib/format';
import { Avatar } from './Avatar';
import { Markdown } from './Markdown';
import { Spinner } from './Spinner';

/** The timeline comment's anchor, linked from the merge box. */
export const REVIEW_ANCHOR = 'auto-merge-review';

const model = (m: string) => m.replace(/^@cf\/[^/]+\//, '');

function answerText(a: ClassifierAnswer | null): string {
  if (!a) return '—';
  if (a.type === 'noul') return `yes ${Math.round(a.value * 100)}%`;
  if (a.type === 'choice')
    return `${a.value} (${Math.round(a.confidence * 100)}%)`;
  return Number(a.value).toFixed(1);
}

/** What the flag's number is: a probability, a choice, or a score. */
function flagValue(f: ReviewFlag): string | null {
  const v = f.value as ClassifierAnswer | null;
  if (f.source !== 'question' || !v) return null;
  return answerText(v);
}

const PROGRESS: Record<string, string> = {
  summarizing: 'Summarizing each changed file…',
  classifying: 'Classifying the changes…',
  investigating: 'Looking into what needs a person…',
};

/** Runs an action, then waits for the page to reload before reporting it done. */
function useAction(onChange: () => Promise<unknown> | void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChange();
      return true;
    } catch (e) {
      setError(errorMessage(e));
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
  const pendingFlags = review.flags.some((f) => !f.approvedAt);
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

export function Flag({
  f,
  approver,
  canApprove,
  approving,
  investigating,
  onApprove,
}: {
  f: ReviewFlag;
  /** Who approved it: from the server, or "you" right after approving. */
  approver: { label: string; user: ReviewFlag['approvedBy'] } | null;
  canApprove: boolean;
  approving: boolean;
  /** The review model is still looking into flags. */
  investigating: boolean;
  onApprove: () => void;
}) {
  const value = flagValue(f);
  return (
    <div className="border rounded-2 p-2 p-sm-3 mb-2">
      <div className="d-flex flex-items-start" style={{ gap: 8 }}>
        {approver ? (
          <CheckCircleFillIcon className="color-fg-success mt-1 flex-shrink-0" />
        ) : (
          <AlertIcon className="color-fg-attention mt-1 flex-shrink-0" />
        )}
        <div className="flex-1" style={{ minWidth: 0 }}>
          <div
            className="d-flex flex-items-center flex-wrap"
            style={{ gap: 8 }}
          >
            <span className="text-bold">{f.title}</span>
            {value && <span className="Label Label--attention">{value}</span>}
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
                Approved by {approver.label}
              </span>
            ) : canApprove ? (
              <button
                className="btn btn-sm"
                disabled={approving}
                onClick={onApprove}
              >
                {approving ? (
                  <>
                    <Spinner size={12} /> Approving…
                  </>
                ) : (
                  <>
                    <ShieldCheckIcon /> Approve
                  </>
                )}
              </button>
            ) : (
              <span className="f6 color-fg-muted">Not approved</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function HowReviewed({ review }: { review: PullReview }) {
  const c = review.classification!;
  const [open, setOpen] = useState(false);
  if (!c.files.length && !review.questions.some((q) => q.answer)) return null;
  return (
    <div className="mt-2">
      <button
        className="btn-link f6 color-fg-muted"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />} How this was
        reviewed
      </button>
      {open && (
        <div className="mt-2 f6">
          {c.files.length > 0 && (
            <>
              <div className="color-fg-muted mb-1">
                Each changed file, summarized by{' '}
                <code>{model(c.summaryModel)}</code>:
              </div>
              <ul className="ml-3 mb-2">
                {c.files.map((f) => (
                  <li key={f.path}>
                    <code>{f.path}</code>{' '}
                    <span className="color-fg-success">+{f.additions}</span>{' '}
                    <span className="color-fg-danger">−{f.deletions}</span>{' '}
                    {f.summary}
                  </li>
                ))}
              </ul>
            </>
          )}
          {review.questions.some((q) => q.answer) && (
            <>
              <div className="color-fg-muted mb-1">
                Questions from <code>.gitorange/review.yml</code>, answered by{' '}
                <code>{model(c.classifierModel)}</code> from those summaries:
              </div>
              <table className="width-full">
                <tbody>
                  {review.questions.map((q) => (
                    <tr key={q.id}>
                      <td className="pr-2 py-1">
                        {q.flagged ? (
                          <AlertIcon className="color-fg-attention" />
                        ) : (
                          <CheckCircleFillIcon className="color-fg-success" />
                        )}
                      </td>
                      <td className="pr-2 py-1">{q.ask}</td>
                      <td className="pr-2 py-1 text-mono">
                        {answerText(q.answer)}
                      </td>
                      <td className="py-1 color-fg-muted">{q.threshold}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The auto-merge review as a timeline comment: what was flagged, why, and an Approve button per
 * flag while the pull request is open. It stays on the pull request after it merges or closes,
 * showing who approved what.
 */
export function ReviewComment({
  repo,
  d,
  onChange,
}: {
  repo: RepoDetail;
  d: PullDetail;
  onChange: () => Promise<unknown> | void;
}) {
  const me = useCurrentUser();
  const review = d.review!;
  const c = review.classification;
  const open = d.pull.state === 'open';
  const { busy, error, run } = useAction(onChange);
  // Approvals confirmed by the server but not yet in the reloaded page.
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [approving, setApproving] = useState<string | null>(null);
  const o = repo.owner.username;
  const n = d.pull.number;

  const approve = async (id: string) => {
    setApproving(id);
    await run(async () => {
      await api.approveFlag(o, repo.name, n, id);
      setApproved((s) => new Set(s).add(id));
    });
    setApproving(null);
  };

  const pending = review.flags.filter(
    (f) => !f.approvedAt && !approved.has(f.id)
  ).length;
  let summary: React.ReactNode;
  if (!c || (PROGRESS[c.status] && !review.flags.length))
    summary = (
      <div
        className="d-flex flex-items-center color-fg-muted"
        style={{ gap: 8 }}
      >
        <Spinner size={16} />
        {c ? PROGRESS[c.status] : 'Starting the review…'}
      </div>
    );
  else if (c.status === 'failed')
    summary = (
      <>
        <div className="flash flash-error mb-2">
          The review failed: {c.errorMessage ?? 'unknown error'}
        </div>
        {open && d.canMerge && (
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() => run(() => api.retryReview(o, repo.name, n))}
          >
            Try the review again
          </button>
        )}
      </>
    );
  else if (!review.flags.length)
    summary = (
      <p className="mb-0">
        <CheckCircleFillIcon className="color-fg-success" /> Nothing in this
        change needs a person under <code>.gitorange/review.yml</code>.
      </p>
    );
  else
    summary = (
      <p className="mb-2">
        {pending
          ? `${pending === 1 ? 'This needs' : `These ${pending} need`} a person before the pull request can merge on its own${
              review.flags.length > pending
                ? ` (${review.flags.length - pending} approved)`
                : ''
            }:`
          : review.flags.length === 1
            ? 'The flagged item was approved.'
            : review.flags.length === 2
              ? 'Both flagged items were approved.'
              : `All ${review.flags.length} flagged items were approved.`}
      </p>
    );

  return (
    <div className="d-flex mb-3" style={{ gap: 16 }} id={REVIEW_ANCHOR}>
      <div
        className="d-none d-md-flex flex-items-center flex-justify-center circle color-bg-done-emphasis color-fg-on-emphasis flex-shrink-0"
        style={{ width: 40, height: 40 }}
      >
        <SparkleFillIcon size={20} />
      </div>
      <div
        className="timeline-comment comment-arrow flex-1"
        style={{ minWidth: 0 }}
      >
        <div className="timeline-comment-header">
          <span className="text-bold color-fg-default">Auto-merge</span>
          {c ? (
            <span title={fullDate(c.createdAt)}>
              reviewed <code>{c.headSha.slice(0, 7)}</code>{' '}
              {timeAgo(c.createdAt)}
            </span>
          ) : (
            <span>is reviewing this pull request</span>
          )}
          <span className="flex-1" />
          <span className="Label">bot</span>
        </div>
        <div className="p-2 p-sm-3">
          {error && <div className="flash flash-error mb-2">{error}</div>}
          {summary}
          {review.flags.map((f) => {
            const serverApprover = f.approvedAt
              ? {
                  label: f.approvedBy?.username ?? 'a former user',
                  user: f.approvedBy,
                }
              : null;
            const localApprover =
              !serverApprover && approved.has(f.id)
                ? { label: 'you', user: null }
                : null;
            return (
              <Flag
                key={f.id}
                f={f}
                approver={serverApprover ?? localApprover}
                canApprove={open && d.canMerge && !!me}
                approving={approving === f.id}
                investigating={c?.status === 'investigating'}
                onApprove={() => approve(f.id)}
              />
            );
          })}
          {c && c.status === 'done' && <HowReviewed review={review} />}
        </div>
      </div>
    </div>
  );
}
