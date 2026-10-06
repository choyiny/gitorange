import { useState } from 'react';
import { withVia } from '@/lib/via';
import { Link } from 'react-router-dom';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PeopleIcon,
  ShieldCheckIcon,
} from '@primer/octicons-react';
import {
  api,
  type PullDetail,
  type RepoDetail,
  type Reviewer,
  type ReviewerStatus,
} from '@/lib/uiApi';
import { useCurrentUser } from '@/lib/auth';
import { fullDate, timeAgo } from '@/lib/format';
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

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** One requested agent: status, avatar, the agent commit it reviewed at, its summary, and its findings. */
function ReviewerRow({
  repo,
  d,
  r,
  canAct,
  onChange,
}: {
  repo: RepoDetail;
  d: PullDetail;
  r: Reviewer;
  canAct: boolean;
  onChange: () => Promise<unknown> | void;
}) {
  const { busy, error, run } = useAction(onChange);
  // Decisions confirmed by the server but not yet in the reloaded page.
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [approving, setApproving] = useState<string | null>(null);
  const [requested, setRequested] = useState<Map<string, string>>(new Map());
  const [requesting, setRequesting] = useState<string | null>(null);
  const o = repo.owner.username;
  const n = d.pull.number;
  const s = REVIEWER_STATUS[r.status];
  return (
    <div className="border rounded-2 p-2 p-sm-3 mb-2">
      <div className="d-flex flex-items-center flex-wrap" style={{ gap: 8 }}>
        <Avatar user={r.agent} size={20} />
        <Link
          to={`/${r.agent.username}`}
          className="text-bold color-fg-default"
        >
          @{r.agent.username}
        </Link>
        <span
          className={`f6 d-inline-flex flex-items-center ${s.className}`}
          style={{ gap: 4 }}
        >
          {r.status === 'reviewing' && <Spinner size={12} />}
          {s.label}
        </span>
        {!r.invited && (
          <span
            className="Label"
            title="Removed from this repository: its review no longer counts"
          >
            removed
          </span>
        )}
        <span className="flex-1" />
        {r.probability !== null && (
          <span
            className="f6 color-fg-muted"
            title="Clef's probability that this change concerns the agent"
          >
            {pct(r.probability)}
          </span>
        )}
        {r.agentSha &&
          (r.agentRepository ? (
            <Link
              to={`/${r.agentRepository}/commit/${r.agentSha}`}
              className="f6 text-mono"
              title="The agent's commit this review used"
            >
              {r.agentSha.slice(0, 7)}
            </Link>
          ) : (
            <code className="f6">{r.agentSha.slice(0, 7)}</code>
          ))}
      </div>
      {r.summary && <p className="f6 mt-1 mb-0">{r.summary}</p>}
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
    </div>
  );
}

/** People who approved the head commit, and the Approve button. */
function PersonApprovals({
  repo,
  d,
  canAct,
  onChange,
}: {
  repo: RepoDetail;
  d: PullDetail;
  canAct: boolean;
  onChange: () => Promise<unknown> | void;
}) {
  const me = useCurrentUser();
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
    <div className="mt-3 pt-2 border-top">
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

/** The timeline's review of the head commit: its agents (requested first), their findings, and people. */
export function ReviewersBox({
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
  const open = d.pull.state === 'open';
  const canAct = open && d.canMerge && !!me;
  const { busy, error, run } = useAction(onChange);
  const [showOthers, setShowOthers] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const requested = review.reviewers.filter(
    (r) => r.requested && r.status !== 'not_needed'
  );
  const others = review.reviewers.filter((r) => !requested.includes(r));
  const progress =
    review.status === 'summarizing'
      ? 'Summarizing each changed file…'
      : review.status === 'triggering'
        ? 'Asking which agents this concerns…'
        : null;
  return (
    <div className="d-flex mb-3" style={{ gap: 16 }} id={REVIEW_ANCHOR}>
      <div
        className="d-none d-md-flex flex-items-center flex-justify-center circle color-bg-done-emphasis color-fg-on-emphasis flex-shrink-0"
        style={{ width: 40, height: 40 }}
      >
        <PeopleIcon size={20} />
      </div>
      <div
        className="timeline-comment comment-arrow flex-1"
        style={{ minWidth: 0 }}
      >
        <div className="timeline-comment-header">
          <span className="text-bold color-fg-default">Reviewers</span>
          <span>
            of <code>{review.headSha.slice(0, 7)}</code>
            {review.createdAt && (
              <span title={fullDate(review.createdAt)}>
                {' '}
                · {timeAgo(review.createdAt)}
              </span>
            )}
          </span>
          <span className="flex-1" />
          <AgentRunLink
            repo={repo}
            number={d.pull.number}
            kind="review"
            className="f6 mr-2"
          />
        </div>
        <div className="p-2 p-sm-3">
          {error && <div className="flash flash-error mb-2">{error}</div>}
          {progress && (
            <div
              className="d-flex flex-items-center color-fg-muted mb-2"
              style={{ gap: 8 }}
            >
              <Spinner size={16} /> {progress}
            </div>
          )}
          {review.status === 'failed' && (
            <div
              className="flash flash-error mb-2 d-flex flex-items-center"
              style={{ gap: 8 }}
            >
              <span className="flex-1">
                The review failed: {review.errorMessage ?? 'unknown error'}
              </span>
              {canAct && (
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      api.retryReview(
                        repo.owner.username,
                        repo.name,
                        d.pull.number
                      )
                    )
                  }
                >
                  Try the review again
                </button>
              )}
            </div>
          )}
          {!review.agentsInvited && !review.reviewers.length && (
            <p className="f6 color-fg-muted mb-2">
              No agent reviews this repository, so a person approves each
              commit.{' '}
              {d.canMerge && (
                <Link to={`/${repo.fullName}/settings`}>Invite agents</Link>
              )}
            </p>
          )}
          {review.agentsInvited &&
            review.status === 'done' &&
            !requested.length && (
              <p className="f6 color-fg-muted mb-2">
                No invited agent was needed for this commit, so a person
                approves it.
              </p>
            )}
          {requested.map((r) => (
            <ReviewerRow
              key={r.id}
              repo={repo}
              d={d}
              r={r}
              canAct={canAct}
              onChange={onChange}
            />
          ))}
          {others.length > 0 && (
            <div className="f6 mt-1">
              <button
                className="btn-link color-fg-muted"
                onClick={() => setShowOthers((v) => !v)}
              >
                {showOthers ? <ChevronDownIcon /> : <ChevronRightIcon />} Not
                needed ({others.length})
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
                      <Link to={`/${r.agent.username}`}>
                        @{r.agent.username}
                      </Link>
                      <span className="color-fg-muted">
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
          {review.legacy && review.legacy.flags.length > 0 && (
            <div className="mt-2">
              <div className="f6 color-fg-muted mb-1">
                Reviewed by <code>.gitorange/review.yml</code> (retired){' '}
                {timeAgo(review.legacy.createdAt)}:
              </div>
              {review.legacy.flags.map((f) => (
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
              ))}
            </div>
          )}
          {review.files.length > 0 && (
            <div className="mt-2 f6">
              <button
                className="btn-link color-fg-muted"
                onClick={() => setShowFiles((v) => !v)}
              >
                {showFiles ? <ChevronDownIcon /> : <ChevronRightIcon />} What
                the agents read
              </button>
              {showFiles && (
                <ul className="ml-3 mt-1">
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
          {open && (
            <PersonApprovals
              repo={repo}
              d={d}
              canAct={canAct}
              onChange={onChange}
            />
          )}
        </div>
      </div>
    </div>
  );
}
