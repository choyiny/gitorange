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
import { Avatar } from './Avatar';
import { Markdown } from './Markdown';
import { Spinner } from './Spinner';

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

function Flag({
  f,
  canApprove,
  onApprove,
  busy,
}: {
  f: ReviewFlag;
  canApprove: boolean;
  onApprove: () => void;
  busy: boolean;
}) {
  const value = flagValue(f);
  return (
    <div className="Box-row">
      <div className="d-flex flex-items-start" style={{ gap: 8 }}>
        {f.approvedAt ? (
          <CheckCircleFillIcon className="color-fg-success mt-1" />
        ) : (
          <AlertIcon className="color-fg-attention mt-1" />
        )}
        <div className="flex-1 min-width-0">
          <div
            className="d-flex flex-items-center flex-wrap"
            style={{ gap: 8 }}
          >
            <span className="text-bold">{f.title}</span>
            {value && <span className="Label Label--attention">{value}</span>}
            {f.source === 'path' && <span className="Label">path rule</span>}
          </div>
          {f.paths.length > 0 && (
            <div className="f6 mt-1">
              {f.paths.map((p) => (
                <code key={p} className="mr-1">
                  {p}
                </code>
              ))}
            </div>
          )}
          {f.detail ? (
            <div className="mt-2 f6">
              <Markdown source={f.detail} />
              {f.detailModel && (
                <div className="color-fg-muted">
                  <SparkleFillIcon className="color-fg-done" />{' '}
                  {model(f.detailModel)}
                </div>
              )}
            </div>
          ) : (
            f.source !== 'limit' && (
              <div className="f6 color-fg-muted mt-1">
                No further detail: the review model didn&apos;t answer.
              </div>
            )
          )}
        </div>
        <div className="flex-shrink-0">
          {f.approvedAt ? (
            <span
              className="f6 color-fg-muted d-flex flex-items-center"
              style={{ gap: 4 }}
            >
              {f.approvedBy && <Avatar user={f.approvedBy} size={16} />}
              Approved{f.approvedBy ? ` by ${f.approvedBy.username}` : ''}
            </span>
          ) : (
            canApprove && (
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={onApprove}
              >
                <ShieldCheckIcon /> Approve
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function StatusLine({ review }: { review: PullReview }) {
  const { state, reasons } = review.autoMerge;
  if (state === 'ready')
    return (
      <>
        <Spinner size={16} />{' '}
        <span className="text-bold">Merging automatically…</span>
      </>
    );
  if (state === 'disabled')
    return (
      <>
        <StopIcon className="color-fg-muted" />{' '}
        <span className="text-bold">
          Auto-merge is off for this pull request
        </span>
      </>
    );
  if (state === 'blocked')
    return (
      <>
        <AlertIcon className="color-fg-danger" />{' '}
        <span>
          <span className="text-bold">Won&apos;t merge automatically:</span>{' '}
          {reasons.join('; ')}
        </span>
      </>
    );
  return (
    <>
      <ClockIcon className="color-fg-muted" />{' '}
      <span>
        <span className="text-bold">Merges automatically once ready.</span>{' '}
        <span className="color-fg-muted">Waiting on: {reasons.join('; ')}</span>
      </span>
    </>
  );
}

/**
 * Auto-merge in the merge box: the review of the head commit (a one-liner per file, the
 * classifier's answers to review.yml's questions, flags investigated by a model with an Approve
 * button each) and whether the pull request will merge on its own.
 */
export function AutoMergeReview({
  repo,
  d,
  onChange,
}: {
  repo: RepoDetail;
  d: PullDetail;
  onChange: () => void;
}) {
  const review = d.review!;
  const c = review.classification;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const o = repo.owner.username;
  const n = d.pull.number;
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
  const enabled = review.autoMerge.state !== 'disabled';

  return (
    <>
      <div className="Box-row d-flex flex-items-start" style={{ gap: 8 }}>
        <div className="flex-1 d-flex flex-items-start" style={{ gap: 8 }}>
          <StatusLine review={review} />
        </div>
        {d.canMerge && (
          <button
            className="btn btn-sm btn-invisible flex-shrink-0"
            disabled={busy}
            onClick={() =>
              act(() => api.setAutoMerge(o, repo.name, n, !enabled))
            }
          >
            {enabled ? 'Turn off auto-merge' : 'Turn on auto-merge'}
          </button>
        )}
      </div>

      {error && (
        <div className="Box-row">
          <div className="flash flash-error">{error}</div>
        </div>
      )}

      {!c || PROGRESS[c.status] ? (
        <div
          className="Box-row d-flex flex-items-center f6 color-fg-muted"
          style={{ gap: 8 }}
        >
          <Spinner size={16} />
          {c ? PROGRESS[c.status] : 'Starting the review…'}
        </div>
      ) : c.status === 'failed' ? (
        <div className="Box-row">
          <div className="flash flash-error f6 mb-2">
            Review failed: {c.errorMessage ?? 'unknown error'}
          </div>
          {d.canMerge && (
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() => act(() => api.retryReview(o, repo.name, n))}
            >
              Try the review again
            </button>
          )}
        </div>
      ) : c.verdict === 'auto' ? (
        <div className="Box-row d-flex flex-items-center f6" style={{ gap: 8 }}>
          <CheckCircleFillIcon className="color-fg-success" />
          Nothing in this change needs a person under{' '}
          <code>.gitorange/review.yml</code>.
        </div>
      ) : null}

      {review.flags.map((f) => (
        <Flag
          key={f.id}
          f={f}
          canApprove={d.canMerge}
          busy={busy}
          onApprove={() => act(() => api.approveFlag(o, repo.name, n, f.id))}
        />
      ))}

      {c && (c.files.length > 0 || review.questions.some((q) => q.answer)) && (
        <div className="Box-row">
          <button
            className="btn-link f6 color-fg-muted"
            onClick={() => setShowDetails((v) => !v)}
          >
            {showDetails ? <ChevronDownIcon /> : <ChevronRightIcon />} How this
            was reviewed
          </button>
          {showDetails && (
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
                    Questions from <code>.gitorange/review.yml</code>, answered
                    by <code>{model(c.classifierModel)}</code> from those
                    summaries:
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
      )}
    </>
  );
}
