import { useState, type CSSProperties } from 'react';
import { withVia } from '@/lib/via';
import { Link } from 'react-router-dom';
import {
  AlertIcon,
  CheckCircleIcon,
  FileDiffIcon,
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
import { AgentAvatar } from './AgentAvatar';
import { AgentRunLink } from './AgentRunLink';
import { Chip } from './ui/Chip';
import { PendingButton } from './ui/PendingButton';
import { PanelError } from './approvals/Panels';
import { useAgentDirectory } from './actions/RunActor';
import {
  Flag,
  REVIEW_ANCHOR,
  serverChangesRequester,
  useAction,
  type FlagDecision,
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
      return <span className="spinner" aria-hidden="true" />;
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

/** An agent's name and colour (AGENT.md's, else its preset's or a stable one), by its handle. */
function useAgentLook() {
  const lookup = useAgentDirectory();
  return (agent: { username: string; name: string }) => {
    const known = lookup(agent.username);
    return {
      handle: agent.username,
      // The directory's name, else the account's; the handle when neither says more.
      name: known.name !== agent.username ? known.name : agent.name,
      color: known.color,
    };
  };
}

/** The agent's avatar and name as a conversation entry's header shows them. */
function EntryHeader({
  handle,
  name,
  color,
  status,
  children,
}: {
  handle: string;
  name: string;
  color: string;
  status: ReviewerStatus;
  children: React.ReactNode;
}) {
  return (
    <header className="pr-card-head">
      <span className="pr-card-mini">
        <AgentAvatar handle={handle} color={color} status={status} size={20} />
      </span>
      <Link to={`/${handle}`} className="pr-who" title={`@${handle}`}>
        {name}
      </Link>
      {children}
    </header>
  );
}

/**
 * One requested agent's review of the head commit, as a conversation entry: the agent (its robot in the state its
 * review is in) as author, what it did, its summary, its findings with their controls, and the agent commit it
 * reviewed at.
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
  const look = useAgentLook()(r.agent);
  const { busy, error, run } = useAction(onChange);
  // Decisions confirmed by the server but not yet in the reloaded page.
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [approving, setApproving] = useState<string | null>(null);
  const [requested, setRequested] = useState<Map<string, string>>(new Map());
  const [requesting, setRequesting] = useState<string | null>(null);
  // The finding the last decision was about: its error shows there, the review's own above.
  const [acted, setActed] = useState<string | null>(null);
  const o = repo.owner.username;
  const n = d.pull.number;
  const at = reviewTime(r);
  const filesHref = `/${repo.fullName}/pull/${n}/files`;
  return (
    <div
      className="pr-entry"
      id={reviewEntryId(r)}
      style={{ '--agent': look.color } as CSSProperties}
    >
      <Link
        to={`/${look.handle}`}
        className="pr-entry-ava"
        tabIndex={-1}
        aria-hidden="true"
      >
        <AgentAvatar
          handle={look.handle}
          color={look.color}
          status={r.status}
          size={40}
        />
      </Link>
      <article
        className="pr-card agent"
        id={anchor ? REVIEW_ANCHOR : undefined}
        aria-label={`${look.name}'s review`}
      >
        <EntryHeader {...look} status={r.status}>
          <span className="pr-verb">
            <StatusIcon status={r.status} />
            {reviewVerb(r)}
          </span>
          <time dateTime={at} title={fullDate(at)} className="muted">
            {timeAgo(at)}
          </time>
          <span className="grow" />
          {!r.invited && (
            <span
              className="chip off"
              title="Removed from this repository: its review no longer counts"
            >
              removed
            </span>
          )}
          <span className="chip off">Agent</span>
        </EntryHeader>
        <div className="pr-card-body">
          {r.summary && <p>{r.summary}</p>}
          {r.status === 'failed' && (
            <div className="pr-failed" role="alert">
              <span>{r.error ?? 'The review failed.'}</span>
              {canAct && r.invited && (
                <PendingButton
                  className="small"
                  pending={busy && acted === null}
                  pendingLabel="Starting…"
                  aria-label={`Retry ${look.name}'s review`}
                  onClick={() => {
                    setActed(null);
                    void run(() => api.retryReviewer(o, repo.name, n, r.id));
                  }}
                >
                  Retry
                </PendingButton>
              )}
            </div>
          )}
          {acted === null && <PanelError error={error} />}
          {r.flags.length > 0 && (
            <div className="pr-flags">
              {r.flags.map((f) => {
                const localNote = requested.get(f.id);
                return (
                  <Flag
                    key={f.id}
                    f={f}
                    pull={n}
                    agentName={look.name}
                    filesHref={filesHref}
                    approver={
                      f.approvedAt
                        ? {
                            label: withVia(
                              f.approvedBy?.username ?? 'a former user',
                              f.approvedVia ?? f.decidedVia
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
                    error={acted === f.id ? error : null}
                    onApprove={async (decision: FlagDecision) => {
                      setActed(f.id);
                      setApproving(f.id);
                      const ok = await run(async () => {
                        await api.approveFlag(o, repo.name, n, f.id, decision);
                        setApproved((x) => new Set(x).add(f.id));
                      });
                      setApproving(null);
                      return ok;
                    }}
                    onRequestChanges={async (note, teach) => {
                      setActed(f.id);
                      setRequesting(f.id);
                      const ok = await run(
                        async () => {
                          await api.requestFlagChanges(
                            o,
                            repo.name,
                            n,
                            f.id,
                            note,
                            teach
                          );
                          setRequested((m) =>
                            new Map(m).set(f.id, note.trim())
                          );
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
          )}
          <footer className="pr-card-foot">
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
                  title="The agent's commit this review used"
                >
                  AGENT.md @{' '}
                  <span className="mono">{r.agentSha.slice(0, 7)}</span>
                </Link>
              ) : (
                <span title="The agent's commit this review used">
                  AGENT.md @ <code>{r.agentSha.slice(0, 7)}</code>
                </span>
              ))}
            <AgentRunLink repo={repo} number={n} kind="review" />
          </footer>
        </div>
      </article>
    </div>
  );
}

/** A finding as history: who decided it, if anyone, and no controls. */
function ReadOnlyFlag({
  f,
  pull,
  agentName,
}: {
  f: ReviewFlag;
  pull: number;
  agentName: string;
}) {
  return (
    <Flag
      f={f}
      pull={pull}
      agentName={agentName}
      approver={
        f.approvedAt
          ? {
              label: withVia(
                f.approvedBy?.username ?? 'a former user',
                f.approvedVia ?? f.decidedVia
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
  pull,
  r,
}: {
  repo: RepoDetail;
  pull: number;
  r: EarlierReviewRow & { status: ShownStatus };
}) {
  const look = useAgentLook()(r.agent);
  const at = reviewTime(r);
  const n = r.flags.length;
  return (
    <div
      className="pr-entry"
      style={{ '--agent': look.color } as CSSProperties}
    >
      <Link
        to={`/${look.handle}`}
        className="pr-entry-ava"
        tabIndex={-1}
        aria-hidden="true"
      >
        <AgentAvatar
          handle={look.handle}
          color={look.color}
          status={r.status}
          size={40}
        />
      </Link>
      <article
        className="pr-card agent earlier"
        aria-label={`${look.name}'s review of an earlier commit`}
      >
        <EntryHeader {...look} status={r.status}>
          <span className="pr-verb">
            <StatusIcon status={r.status} />
            {earlierVerb(r)} on{' '}
            <Link to={`/${repo.fullName}/commit/${r.headSha}`} className="mono">
              {r.headSha.slice(0, 7)}
            </Link>
            , an earlier commit
          </span>
          <time dateTime={at} title={fullDate(at)} className="muted">
            {timeAgo(at)}
          </time>
          <span className="grow" />
          <span className="chip off">Agent</span>
        </EntryHeader>
        <div className="pr-card-body">
          {r.summary && <p className="muted">{r.summary}</p>}
          {r.status === 'failed' && (
            <div className="pr-failed">
              <span>{r.error ?? 'The review failed.'}</span>
            </div>
          )}
          {n > 0 && (
            <details className="pr-earlier">
              <summary>
                {n} finding{n === 1 ? '' : 's'} on this earlier commit
              </summary>
              <div className="pr-flags">
                {r.flags.map((f) => (
                  <ReadOnlyFlag
                    key={f.id}
                    f={f}
                    pull={pull}
                    agentName={look.name}
                  />
                ))}
              </div>
            </details>
          )}
        </div>
      </article>
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
    <div className="pr-row">
      <span className="pr-row-icon">
        <ShieldCheckIcon className={d.approvals.length ? 'pr-ok' : 'muted'} />
      </span>
      <div className="pr-row-main">
        {d.approvals.length ? (
          <p className="pr-people">
            {d.approvals.map((a) => (
              <span key={a.user.id} title={fullDate(a.createdAt)}>
                <Avatar user={a.user} size={16} />
                {withVia(a.user.username, a.via)}
              </span>
            ))}
            <span className="pr-ok">approved this commit</span>
          </p>
        ) : (
          <p className="muted">No person has approved this commit.</p>
        )}
        {canAct && !mine && changeRequested && (
          <p className="pr-warn small">
            Approving does not override an agent&apos;s change request: dismiss
            it, or push a fix.
          </p>
        )}
        <PanelError error={error} />
      </div>
      {canAct &&
        (mine ? (
          <PendingButton
            className="small"
            pending={busy}
            pendingLabel="Withdrawing…"
            onClick={() =>
              run(() => api.withdrawApproval(o, repo.name, d.pull.number))
            }
          >
            Withdraw approval
          </PendingButton>
        ) : (
          <PendingButton
            className="small"
            pending={busy}
            pendingLabel="Approving…"
            disabled={!d.headSha}
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
            <ShieldCheckIcon size={14} />
            Approve
          </PendingButton>
        ))}
    </div>
  );
}

/**
 * The side panel's Reviews: where the review of the head commit stands, each requested agent with its robot in
 * the state its review is in (its review is in the conversation), the agents it didn't need, and the people who
 * approved.
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
  const lookOf = useAgentLook();
  const { busy, error, run } = useAction(onChange);
  const requested: Reviewer[] = reviewEntries(review.reviewers);
  const others = review.reviewers.filter((r) => !requested.includes(r));
  const progress =
    review.status === 'summarizing'
      ? 'Summarizing each changed file…'
      : review.status === 'triggering'
        ? 'Asking which agents this concerns…'
        : null;
  return (
    <section
      className="panel pad pr-reviews"
      id={anchor ? REVIEW_ANCHOR : undefined}
      aria-labelledby="pr-reviews-title"
    >
      <div className="pr-panel-head">
        <h2 id="pr-reviews-title">Reviews</h2>
        <span className="muted small">
          of <code>{review.headSha.slice(0, 7)}</code>
        </span>
        <span className="grow" />
        <AgentRunLink
          repo={repo}
          number={d.pull.number}
          kind="review"
          className="small"
        />
      </div>
      <PanelError error={error} />
      {progress && (
        <p className="pr-progress">
          <span className="spinner" aria-hidden="true" /> {progress}
        </p>
      )}
      {review.status === 'failed' && (
        <div className="pr-failed" role="alert">
          <span>
            The review failed: {review.errorMessage ?? 'unknown error'}
          </span>
          {canAct && (
            <PendingButton
              className="small"
              pending={busy}
              pendingLabel="Starting…"
              onClick={() =>
                run(() =>
                  api.retryReview(repo.owner.username, repo.name, d.pull.number)
                )
              }
            >
              Try the review again
            </PendingButton>
          )}
        </div>
      )}
      {!review.agentsInvited && !review.reviewers.length && (
        <p className="muted small">
          No agent reviews this repository, so a person approves each commit.{' '}
          {d.canMerge && (
            <Link to={`/${repo.fullName}/settings`}>Invite agents</Link>
          )}
        </p>
      )}
      {review.agentsInvited &&
        review.status === 'done' &&
        !requested.length && (
          <p className="muted small">
            No invited agent was needed for this commit, so a person approves
            it.
          </p>
        )}
      {requested.length > 0 && (
        <ul className="pr-reviewers">
          {requested.map((r) => {
            const look = lookOf(r.agent);
            return (
              <li key={r.id}>
                <AgentAvatar
                  handle={look.handle}
                  color={look.color}
                  status={r.status}
                  size={32}
                />
                <span className="pr-rv-main">
                  <span className="pr-rv-name">
                    <Link to={`/${look.handle}`} title={`@${look.handle}`}>
                      {look.name}
                    </Link>
                    {!r.invited && (
                      <span
                        className="chip off"
                        title="Removed from this repository: its review no longer counts"
                      >
                        removed
                      </span>
                    )}
                  </span>
                  {r.probability !== null && (
                    <span
                      className="muted small"
                      title="Clef's probability that this change concerns the agent"
                    >
                      Requested at Clef {pct(r.probability)}
                    </span>
                  )}
                </span>
                <a
                  href={`#${reviewEntryId(r)}`}
                  className="pr-rv-state"
                  title={`Go to ${look.name}'s review${
                    r.probability !== null
                      ? ` (requested at Clef ${pct(r.probability)})`
                      : ''
                  }`}
                >
                  <Chip status={r.status} />
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {others.length > 0 && (
        <details className="pr-notneeded">
          <summary>Not needed ({others.length})</summary>
          <ul>
            {others.map((r) => {
              const look = lookOf(r.agent);
              return (
                <li key={r.id}>
                  <AgentAvatar
                    handle={look.handle}
                    color={look.color}
                    status="not_needed"
                    size={20}
                  />
                  <Link to={`/${look.handle}`} title={`@${look.handle}`}>
                    {look.name}
                  </Link>
                  <span className="grow" />
                  <span
                    className="muted small"
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
              );
            })}
          </ul>
        </details>
      )}
      {d.approvals.length > 0 && (
        <div className="pr-approved">
          <h3 className="pr-subhead">Approved by</h3>
          <ul>
            {d.approvals.map((a) => (
              <li key={a.user.id} title={fullDate(a.createdAt)}>
                <Avatar user={a.user} size={20} />
                <Link to={`/${a.user.username}`}>{a.user.username}</Link>
                {a.via && <span className="muted small">via {a.via}</span>}
                <span className="grow" />
                <CheckCircleIcon size={14} className="pr-ok" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
