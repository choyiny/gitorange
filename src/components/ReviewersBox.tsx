import { useState } from 'react';
import { withVia } from '@/lib/via';
import { Link } from 'react-router-dom';
import {
  AlertIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileDiffIcon,
  HistoryIcon,
  ShieldCheckIcon,
  SkipIcon,
  XCircleIcon,
} from '@primer/octicons-react';
import {
  api,
  type PullDetail,
  type EarlierReview as EarlierReviewRow,
  type RepoDetail,
  type Reviewer,
  type ReviewFlag,
  type ReviewerStatus,
} from '@/lib/uiApi';
import { useCurrentUser } from '@/lib/auth';
import { fullDate, timeAgo } from '@/lib/format';
import {
  earlierVerb,
  reviewEntries,
  reviewTime,
  reviewVerb,
  type ShownStatus,
} from '@/lib/reviewTimeline';
import { Avatar } from './Avatar';
import { Spinner } from './Spinner';
import { AgentRunLink } from './AgentRunLink';
import {
  Flag,
  REVIEW_ANCHOR,
  serverChangesRequester,
  useAction,
} from './AutoMergeReview';

export const REVIEWER_STATUS: Record<
  ReviewerStatus,
  { label: string; className: string }
> = {
  not_needed: { label: 'Not needed', className: 'color-fg-muted' },
  reviewing: { label: 'Reviewing…', className: 'color-fg-muted' },
  approved: { label: 'Approved', className: 'color-fg-success' },
  flagged: { label: 'Needs a person', className: 'color-fg-attention' },
  changes_requested: {
    label: 'Changes requested',
    className: 'color-fg-danger',
  },
  failed: { label: 'Review failed', className: 'color-fg-danger' },
};

/** A reviewer's status as a small icon, coloured like its label. */
function StatusIcon({ status }: { status: ReviewerStatus }) {
  const className = REVIEWER_STATUS[status].className;
  switch (status) {
    case 'reviewing':
      return <Spinner size={14} />;
    case 'approved':
      return <CheckCircleIcon size={14} className={className} />;
    case 'flagged':
      return <AlertIcon size={14} className={className} />;
    case 'changes_requested':
      return <FileDiffIcon size={14} className={className} />;
    case 'failed':
      return <XCircleIcon size={14} className={className} />;
    case 'not_needed':
      return <SkipIcon size={14} className={className} />;
  }
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** The anchor of one agent's review entry, for the sidebar's links. */
export const reviewEntryId = (r: Reviewer) => `agent-review-${r.id}`;

/** Who can act on the head commit's review: maintainers, while the pull request is open. */
function useCanAct(d: PullDetail) {
  const me = useCurrentUser();
  return d.pull.state === 'open' && d.canMerge && !!me;
}

/**
 * One requested agent's review of the head commit, as a conversation entry: the agent as author, what it
 * did, its summary, its findings with their controls, and the agent commit it reviewed at.
 */
export function AgentReview({
  repo,
  d,
  r,
  anchor,
  onChange,
}: {
  repo: RepoDetail;
  d: PullDetail;
  r: Reviewer & { status: ShownStatus };
  /** "Review the flags" jumps here. */
  anchor: boolean;
  onChange: () => Promise<unknown> | void;
}) {
  const canAct = useCanAct(d);
  const { busy, error, run } = useAction(onChange);
  // Decisions confirmed by the server but not yet in the reloaded page.
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [approving, setApproving] = useState<string | null>(null);
  const [requested, setRequested] = useState<Map<string, string>>(new Map());
  const [requesting, setRequesting] = useState<string | null>(null);
  const o = repo.owner.username;
  const n = d.pull.number;
  const at = reviewTime(r);
  return (
    <div className="d-flex mb-3" style={{ gap: 16 }} id={reviewEntryId(r)}>
      <Link to={`/${r.agent.username}`} className="d-none d-md-block">
        <Avatar user={r.agent} size={40} />
      </Link>
      <div
        className="timeline-comment comment-arrow flex-1"
        style={{ minWidth: 0 }}
        id={anchor ? REVIEW_ANCHOR : undefined}
      >
        <div className="timeline-comment-header flex-wrap">
          <Avatar user={r.agent} size={20} className="d-md-none" />
          <Link
            to={`/${r.agent.username}`}
            className="text-bold color-fg-default"
          >
            @{r.agent.username}
          </Link>
          <span className="d-inline-flex flex-items-center" style={{ gap: 4 }}>
            <StatusIcon status={r.status} />
            {reviewVerb(r)}
          </span>
          <span title={fullDate(at)}>{timeAgo(at)}</span>
          <span className="flex-1" />
          {!r.invited && (
            <span
              className="Label"
              title="Removed from this repository: its review no longer counts"
            >
              removed
            </span>
          )}
          <span className="Label">Agent</span>
        </div>
        <div className="p-2 p-sm-3">
          {r.summary && <p className="mb-0">{r.summary}</p>}
          {r.status === 'failed' && (
            <div
              className="flash flash-error mt-2 f6 d-flex flex-items-center"
              style={{ gap: 8 }}
            >
              <span className="flex-1">{r.error ?? 'The review failed.'}</span>
              {canAct && r.invited && (
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  aria-label={`Retry @${r.agent.username}'s review`}
                  onClick={() =>
                    run(() => api.retryReviewer(o, repo.name, n, r.id))
                  }
                >
                  {busy ? 'Starting…' : 'Retry'}
                </button>
              )}
            </div>
          )}
          {error && <div className="flash flash-error mt-2 f6">{error}</div>}
          {r.flags.length > 0 && <div className="mt-2" />}
          {r.flags.map((f) => {
            const localNote = requested.get(f.id);
            return (
              <Flag
                key={f.id}
                f={f}
                approver={
                  f.approvedAt
                    ? {
                        label: withVia(
                          f.approvedBy?.username ?? 'a former user',
                          f.approvedVia
                        ),
                        user: f.approvedBy,
                      }
                    : approved.has(f.id)
                      ? { label: 'you', user: null }
                      : null
                }
                changesRequester={
                  localNote !== undefined
                    ? { label: 'you', user: null, note: localNote || null }
                    : serverChangesRequester(f)
                }
                canApprove={canAct}
                approving={approving === f.id}
                requestingChanges={requesting === f.id}
                investigating={r.status === 'reviewing'}
                onApprove={async () => {
                  setApproving(f.id);
                  await run(async () => {
                    await api.approveFlag(o, repo.name, n, f.id);
                    setApproved((x) => new Set(x).add(f.id));
                  });
                  setApproving(null);
                }}
                onRequestChanges={async (note) => {
                  setRequesting(f.id);
                  const ok = await run(
                    async () => {
                      await api.requestFlagChanges(o, repo.name, n, f.id, note);
                      setRequested((m) => new Map(m).set(f.id, note.trim()));
                    },
                    { sendingNote: true }
                  );
                  setRequesting(null);
                  return ok;
                }}
              />
            );
          })}
          <div
            className="d-flex flex-items-center flex-wrap f6 color-fg-muted mt-2"
            style={{ gap: 12 }}
          >
            <span>
              of <code>{d.review!.headSha.slice(0, 7)}</code>
            </span>
            {r.probability !== null && (
              <span title="Clef's probability that this change concerns the agent">
                requested at Clef {pct(r.probability)}
              </span>
            )}
            {r.agentSha &&
              (r.agentRepository ? (
                <Link
                  to={`/${r.agentRepository}/commit/${r.agentSha}`}
                  className="Link--muted"
                  title="The agent's commit this review used"
                >
                  AGENT.md @{' '}
                  <span className="text-mono">{r.agentSha.slice(0, 7)}</span>
                </Link>
              ) : (
                <span title="The agent's commit this review used">
                  AGENT.md @ <code>{r.agentSha.slice(0, 7)}</code>
                </span>
              ))}
            <AgentRunLink repo={repo} number={n} kind="review" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Findings from the retired `.gitorange/review.yml` review, read-only, where they happened. */
export function LegacyReview({ d }: { d: PullDetail }) {
  const legacy = d.review!.legacy!;
  return (
    <div className="d-flex mb-3" style={{ gap: 16 }}>
      <div
        className="d-none d-md-flex flex-items-center flex-justify-center circle color-bg-done-emphasis color-fg-on-emphasis flex-shrink-0"
        style={{ width: 40, height: 40 }}
      >
        <HistoryIcon size={20} />
      </div>
      <div
        className="timeline-comment comment-arrow flex-1"
        style={{ minWidth: 0 }}
      >
        <div className="timeline-comment-header flex-wrap">
          <span>
            Reviewed by <code>.gitorange/review.yml</code> (retired)
          </span>
          <span title={fullDate(legacy.createdAt)}>
            {timeAgo(legacy.createdAt)}
          </span>
        </div>
        <div className="p-2 p-sm-3">
          {legacy.flags.map((f) => (
            <ReadOnlyFlag key={f.id} f={f} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** A finding as history: who decided it, if anyone, and no controls. */
function ReadOnlyFlag({ f }: { f: ReviewFlag }) {
  return (
    <Flag
      f={f}
      approver={
        f.approvedAt
          ? {
              label: withVia(
                f.approvedBy?.username ?? 'a former user',
                f.approvedVia
              ),
              user: f.approvedBy,
            }
          : null
      }
      changesRequester={serverChangesRequester(f)}
      canApprove={false}
      approving={false}
      requestingChanges={false}
      investigating={false}
      onApprove={() => {}}
      onRequestChanges={async () => false}
    />
  );
}

/** An agent's review of an earlier head commit, read-only where it happened: its findings no longer count. */
export function EarlierReview({
  repo,
  r,
}: {
  repo: RepoDetail;
  r: EarlierReviewRow & { status: ShownStatus };
}) {
  const at = reviewTime(r);
  const n = r.flags.length;
  return (
    <div className="d-flex mb-3" style={{ gap: 16 }}>
      <Link to={`/${r.agent.username}`} className="d-none d-md-block">
        <Avatar user={r.agent} size={40} />
      </Link>
      <div
        className="timeline-comment comment-arrow flex-1 color-bg-subtle"
        style={{ minWidth: 0 }}
      >
        <div className="timeline-comment-header flex-wrap">
          <Avatar user={r.agent} size={20} className="d-md-none" />
          <Link
            to={`/${r.agent.username}`}
            className="text-bold color-fg-default"
          >
            @{r.agent.username}
          </Link>
          <span className="d-inline-flex flex-items-center" style={{ gap: 4 }}>
            <StatusIcon status={r.status} />
            {earlierVerb(r)} on{' '}
            <Link
              to={`/${repo.fullName}/commit/${r.headSha}`}
              className="Link--secondary text-mono"
            >
              {r.headSha.slice(0, 7)}
            </Link>
            , an earlier commit
          </span>
          <span title={fullDate(at)}>{timeAgo(at)}</span>
          <span className="flex-1" />
          <span className="Label">Agent</span>
        </div>
        <div className="p-2 p-sm-3">
          {r.summary && <p className="mb-0 color-fg-muted">{r.summary}</p>}
          {r.status === 'failed' && (
            <div className="flash flash-error mt-2 f6">
              {r.error ?? 'The review failed.'}
            </div>
          )}
          {n > 0 && (
            <details className="mt-2">
              <summary className="f6 color-fg-muted">
                {n} finding{n === 1 ? '' : 's'} on this earlier commit
              </summary>
              <div className="mt-2">
                {r.flags.map((f) => (
                  <ReadOnlyFlag key={f.id} f={f} />
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

/** People who approved the head commit, and the Approve button; sits in the merge box. */
export function PersonApprovals({
  repo,
  d,
  onChange,
}: {
  repo: RepoDetail;
  d: PullDetail;
  onChange: () => Promise<unknown> | void;
}) {
  const me = useCurrentUser();
  const canAct = useCanAct(d);
  const { busy, error, run } = useAction(onChange);
  const mine = !!me && d.approvals.some((a) => a.user.id === me.id);
  const outstanding = d.review?.verdict?.reasons.some((r) =>
    [
      'agent_flagged',
      'agent_changes_requested',
      'agent_reviewing',
      'agent_review_failed',
    ].includes(r.kind)
  );
  const changeRequested = !!d.review?.verdict?.reasons.some(
    (r) => r.kind === 'agent_changes_requested'
  );
  const o = repo.owner.username;
  return (
    <div className="Box-row">
      <div className="d-flex flex-items-center flex-wrap" style={{ gap: 8 }}>
        {d.approvals.length ? (
          <>
            {d.approvals.map((a) => (
              <span
                key={a.user.id}
                className="d-inline-flex flex-items-center f6"
                style={{ gap: 4 }}
                title={fullDate(a.createdAt)}
              >
                <Avatar user={a.user} size={16} />{' '}
                {withVia(a.user.username, a.via)}
              </span>
            ))}
            <span className="f6 color-fg-success">approved this commit</span>
          </>
        ) : (
          <span className="f6 color-fg-muted">
            No person has approved this commit.
          </span>
        )}
        <span className="flex-1" />
        {canAct && !mine && changeRequested && (
          <span className="f6 color-fg-attention">
            Approving does not override an agent&apos;s change request: dismiss
            it, or push a fix.
          </span>
        )}
        {canAct &&
          (mine ? (
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                run(() => api.withdrawApproval(o, repo.name, d.pull.number))
              }
            >
              Withdraw approval
            </button>
          ) : (
            <button
              className="btn btn-sm btn-primary"
              disabled={busy || !d.headSha}
              aria-label="Approve this commit"
              title={
                outstanding
                  ? 'Approving lets this commit land past findings for a person and failed or unfinished agent reviews. It does not override an agent’s change request: that needs a new commit or a Dismiss.'
                  : 'Approve this commit. Approval does not override an agent’s change request: dismiss it, or push a fix.'
              }
              onClick={() =>
                run(() =>
                  api.approvePull(o, repo.name, d.pull.number, d.headSha!)
                )
              }
            >
              <ShieldCheckIcon /> Approve
            </button>
          ))}
      </div>
      {error && <div className="flash flash-error mt-2 f6">{error}</div>}
    </div>
  );
}

/**
 * The sidebar's Reviewers: where the review of the head commit stands, each requested agent's status
 * (its review is in the conversation), the agents it didn't need, and the people who approved.
 */
export function ReviewersSidebar({
  repo,
  d,
  anchor,
  onChange,
}: {
  repo: RepoDetail;
  d: PullDetail;
  /** "Review the flags" jumps here when no review entry holds a finding for a person. */
  anchor: boolean;
  onChange: () => Promise<unknown> | void;
}) {
  const review = d.review!;
  const canAct = useCanAct(d);
  const { busy, error, run } = useAction(onChange);
  const [showOthers, setShowOthers] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const requested: Reviewer[] = reviewEntries(review.reviewers);
  const others = review.reviewers.filter((r) => !requested.includes(r));
  const progress =
    review.status === 'summarizing'
      ? 'Summarizing each changed file…'
      : review.status === 'triggering'
        ? 'Asking which agents this concerns…'
        : null;
  return (
    <div
      className="border-bottom pb-3 mb-3"
      id={anchor ? REVIEW_ANCHOR : undefined}
    >
      <div className="d-flex flex-items-center mb-2" style={{ gap: 4 }}>
        <span className="text-bold color-fg-muted">Reviewers</span>
        <span className="color-fg-muted">
          of <code>{review.headSha.slice(0, 7)}</code>
        </span>
        <span className="flex-1" />
        <AgentRunLink repo={repo} number={d.pull.number} kind="review" />
      </div>
      {error && <div className="flash flash-error mb-2">{error}</div>}
      {progress && (
        <div
          className="d-flex flex-items-center color-fg-muted mb-2"
          style={{ gap: 8 }}
        >
          <Spinner size={14} /> {progress}
        </div>
      )}
      {review.status === 'failed' && (
        <div className="flash flash-error mb-2">
          <div>The review failed: {review.errorMessage ?? 'unknown error'}</div>
          {canAct && (
            <button
              className="btn btn-sm mt-2"
              disabled={busy}
              onClick={() =>
                run(() =>
                  api.retryReview(repo.owner.username, repo.name, d.pull.number)
                )
              }
            >
              Try the review again
            </button>
          )}
        </div>
      )}
      {!review.agentsInvited && !review.reviewers.length && (
        <p className="color-fg-muted mb-2">
          No agent reviews this repository, so a person approves each commit.{' '}
          {d.canMerge && (
            <Link to={`/${repo.fullName}/settings`}>Invite agents</Link>
          )}
        </p>
      )}
      {review.agentsInvited &&
        review.status === 'done' &&
        !requested.length && (
          <p className="color-fg-muted mb-2">
            No invited agent was needed for this commit, so a person approves
            it.
          </p>
        )}
      {requested.length > 0 && (
        <ul className="list-style-none">
          {requested.map((r) => {
            const s = REVIEWER_STATUS[r.status];
            return (
              <li
                key={r.id}
                className="d-flex flex-items-center mb-2"
                style={{ gap: 6 }}
              >
                <Avatar user={r.agent} size={20} />
                <Link
                  to={`/${r.agent.username}`}
                  className="color-fg-default text-bold Truncate"
                  style={{ minWidth: 0 }}
                >
                  <span className="Truncate-text">@{r.agent.username}</span>
                </Link>
                {!r.invited && (
                  <span
                    className="Label"
                    title="Removed from this repository: its review no longer counts"
                  >
                    removed
                  </span>
                )}
                <span className="flex-1" />
                <a
                  href={`#${reviewEntryId(r)}`}
                  className={`d-inline-flex flex-items-center flex-shrink-0 ${s.className}`}
                  style={{ gap: 4 }}
                  title={`Go to @${r.agent.username}'s review${
                    r.probability !== null
                      ? ` (requested at Clef ${pct(r.probability)})`
                      : ''
                  }`}
                >
                  <StatusIcon status={r.status} />
                  {s.label}
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {others.length > 0 && (
        <div>
          <button
            className="btn-link color-fg-muted"
            onClick={() => setShowOthers((v) => !v)}
          >
            {showOthers ? <ChevronDownIcon /> : <ChevronRightIcon />} Not needed
            ({others.length})
          </button>
          {showOthers && (
            <ul className="list-style-none mt-1">
              {others.map((r) => (
                <li
                  key={r.id}
                  className="d-flex flex-items-center mb-1"
                  style={{ gap: 6 }}
                >
                  <Avatar user={r.agent} size={16} />
                  <Link
                    to={`/${r.agent.username}`}
                    className="Truncate"
                    style={{ minWidth: 0 }}
                  >
                    <span className="Truncate-text">@{r.agent.username}</span>
                  </Link>
                  <span className="flex-1" />
                  <span
                    className="color-fg-muted flex-shrink-0"
                    title={
                      r.probability !== null
                        ? "Clef's probability that this change concerns the agent"
                        : undefined
                    }
                  >
                    {r.probability !== null
                      ? `Clef: ${pct(r.probability)}`
                      : (r.summary ?? '')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {d.approvals.length > 0 && (
        <div className="mt-2">
          <div className="color-fg-muted mb-1">Approved by</div>
          <ul className="list-style-none">
            {d.approvals.map((a) => (
              <li
                key={a.user.id}
                className="d-flex flex-items-center mb-1"
                style={{ gap: 6 }}
                title={fullDate(a.createdAt)}
              >
                <Avatar user={a.user} size={20} />
                <Link to={`/${a.user.username}`} className="color-fg-default">
                  {a.user.username}
                </Link>
                {a.via && (
                  <span className="f6 color-fg-muted">via {a.via}</span>
                )}
                <span className="flex-1" />
                <CheckCircleIcon size={14} className="color-fg-success" />
              </li>
            ))}
          </ul>
        </div>
      )}
      {review.files.length > 0 && (
        <div className="mt-2">
          <button
            className="btn-link color-fg-muted"
            onClick={() => setShowFiles((v) => !v)}
          >
            {showFiles ? <ChevronDownIcon /> : <ChevronRightIcon />} What the
            agents read
          </button>
          {showFiles && (
            <ul className="ml-3 mt-1" style={{ wordBreak: 'break-word' }}>
              {review.files.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code>{' '}
                  <span className="color-fg-success">+{f.additions}</span>{' '}
                  <span className="color-fg-danger">−{f.deletions}</span>{' '}
                  {f.summary}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
