import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertIcon,
  CheckCircleFillIcon,
  ClockIcon,
  FileDiffIcon,
  LinkExternalIcon,
  PersonIcon,
  ShieldIcon,
  StopIcon,
  SyncIcon,
  XIcon,
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
import { PendingButton } from './ui/PendingButton';
import {
  ApproveReasonPanel,
  ChangesPanel,
  DismissPanel,
  PanelError,
} from './approvals/Panels';

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
  let icon: React.ReactNode;
  let line: React.ReactNode;
  if (state === 'ready') {
    icon = <span className="spinner" aria-hidden="true" />;
    line = <b>Merging automatically…</b>;
  } else if (state === 'disabled') {
    icon = <StopIcon className="muted" />;
    line = <b>Auto-merge is off for this pull request</b>;
  } else if (state === 'blocked') {
    icon = <AlertIcon className="pr-bad" />;
    line = (
      <>
        <b>Won&apos;t merge automatically:</b> {reasons.join('; ')}
      </>
    );
  } else {
    icon = <ClockIcon className="muted" />;
    line = (
      <>
        <b>Merges automatically once ready.</b>{' '}
        <span className="muted">Waiting on: {reasons.join('; ')}</span>
        {pendingFlags && (
          <>
            {' '}
            <a href={`#${REVIEW_ANCHOR}`}>Review the flags</a>
          </>
        )}
      </>
    );
  }
  return (
    <div className="pr-row">
      <span className="pr-row-icon">{icon}</span>
      <div className="pr-row-main">
        <p>{line}</p>
        {error && <PanelError error={error} />}
      </div>
      {d.canMerge && (
        <PendingButton
          className="small"
          pending={busy}
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
        </PendingButton>
      )}
    </div>
  );
}

// ── findings ─────────────────────────────────────────────────────────────────

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

/** A decision as the buttons send it: a guarded agent's approval or dismissal always carries a reason. */
export type FlagDecision = { reason?: string; teach?: string | null };

type Panel = 'approve' | 'dismiss' | 'changes' | null;

/**
 * One finding inside an agent's review: what the agent found, where, and the decision. A person with merge rights
 * approves it (an agent's change request: dismisses it) or requests changes. A guarded agent's finding (Security,
 * Data, or any agent marked guarded) is never approved with one click: Approve and Dismiss open a panel that needs a
 * reason, which goes in the audit log. Every finding links to its own page for the full decision.
 */
export function Flag({
  f,
  pull,
  agentName,
  approver,
  changesRequester,
  canApprove,
  approving,
  requestingChanges,
  investigating,
  error,
  filesHref,
  onApprove,
  onRequestChanges,
}: {
  f: ReviewFlag;
  /** The pull request's number (a rule taught with a decision is learned when it closes). */
  pull: number;
  /** The agent's name, for the question and the panels ("Data asks: …"). */
  agentName: string;
  /** Who approved it: from the server, or "you" right after approving. */
  approver: { label: string; user: ReviewFlag['approvedBy'] } | null;
  /** Who asked for changes instead (only while unapproved), with their note. */
  changesRequester: ChangesRequester | null;
  canApprove: boolean;
  approving: boolean;
  requestingChanges: boolean;
  /** The agent is still reviewing, so a finding may not have its detail yet. */
  investigating: boolean;
  /** The last decision on this finding failed, in words. */
  error?: string | null;
  /** The pull request's Files tab, so each path jumps to its diff. */
  filesHref?: string;
  /** Resolves to whether it worked, so an open panel closes only then. */
  onApprove: (decision: FlagDecision) => Promise<boolean> | void;
  onRequestChanges: (note: string, teach: string | null) => Promise<boolean>;
}) {
  const change = f.kind === 'change_requested';
  const [panel, setPanel] = useState<Panel>(null);
  const changes = approver ? null : changesRequester;
  const busy = approving || requestingChanges;
  const decided = !!approver;
  const panelId = `finding-${f.id}-panel`;
  const decide = async (decision: FlagDecision) => {
    if ((await onApprove(decision)) !== false) setPanel(null);
  };
  const tone = decided ? 'done' : changes || change ? 'asked' : 'needs';
  return (
    <div className={`pr-flag ${tone}`} id={`finding-${f.id}`}>
      <div className="pr-flag-head">
        <span className="pr-flag-icon" aria-hidden="true">
          {decided ? (
            <CheckCircleFillIcon />
          ) : changes || change ? (
            <FileDiffIcon />
          ) : (
            <AlertIcon />
          )}
        </span>
        <div className="pr-flag-title">
          <b>{f.title}</b>
          <span className="pr-flag-chips">
            {change && <span className="chip serious">Change requested</span>}
            {f.guarded && !decided && (
              <span
                className="chip warn"
                title={`${agentName} is guarded: its findings are never approved in bulk, by one key or by AI, and approving one needs a reason.`}
              >
                <ShieldIcon size={12} />
                Needs a reason
              </span>
            )}
            {f.assignee && !decided && (
              <span className="chip info">
                <PersonIcon size={12} />
                Asked {f.assignee.name || f.assignee.login}
              </span>
            )}
          </span>
        </div>
        <Link
          to={`/approvals/${encodeURIComponent(f.id)}`}
          className="pr-flag-open small"
          title="Open this finding on its own page"
        >
          Open
          <LinkExternalIcon size={12} />
        </Link>
      </div>
      {f.question && (
        <p className="pr-flag-q">
          <b>{agentName} asks:</b> {f.question}
        </p>
      )}
      {f.paths.length > 0 && (
        <ul className="pr-flag-paths" aria-label="Files">
          {f.paths.map((p) => (
            <li key={p}>
              {filesHref ? (
                <Link
                  className="mono"
                  to={`${filesHref}#diff-${encodeURIComponent(p)}`}
                >
                  {p}
                </Link>
              ) : (
                <span className="mono">{p}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {f.detail ? (
        <div className="pr-flag-detail review-flag-detail">
          <Markdown source={f.detail} />
        </div>
      ) : investigating ? (
        <p className="pr-flag-note">
          <span className="spinner" aria-hidden="true" /> Looking into this…
        </p>
      ) : (
        <p className="pr-flag-note">
          No further detail: the review model didn&apos;t answer.
        </p>
      )}
      {changes && (
        <div className="pr-flag-asked">
          <p>
            {changes.user && <Avatar user={changes.user} size={16} />}
            <b>Changes requested by {changes.label}</b>
          </p>
          {changes.note && <p className="pr-flag-text">{changes.note}</p>}
        </div>
      )}
      {panel === 'approve' && (
        <ApproveReasonPanel
          id={panelId}
          agentName={agentName}
          pull={pull}
          pending={approving}
          error={error}
          onSubmit={(reason, teach) => decide({ reason, teach })}
          onCancel={() => setPanel(null)}
        />
      )}
      {panel === 'dismiss' && (
        <DismissPanel
          id={panelId}
          agentName={agentName}
          pull={pull}
          guarded={f.guarded}
          pending={approving}
          error={error}
          onSubmit={(reason, teach) =>
            decide({ reason: reason.trim() || undefined, teach })
          }
          onCancel={() => setPanel(null)}
        />
      )}
      {panel === 'changes' && (
        <ChangesPanel
          id={panelId}
          agentName={agentName}
          pull={pull}
          pending={requestingChanges}
          error={error}
          onSubmit={async (note, teach) => {
            if (await onRequestChanges(note, teach)) setPanel(null);
          }}
          onCancel={() => setPanel(null)}
        />
      )}
      <div className="pr-flag-foot">
        {approver ? (
          <div className="pr-flag-decided">
            <p className="pr-ok">
              {approver.user && <Avatar user={approver.user} size={16} />}
              {change ? 'Dismissed' : 'Approved'} by {approver.label}
            </p>
            {f.reason && (
              <p className="pr-flag-text">
                <span className="muted">Reason:</span> {f.reason}
              </p>
            )}
            {f.teach && (
              <p className="pr-flag-text">
                <span className="muted">Rule for {agentName}:</span> {f.teach}
              </p>
            )}
          </div>
        ) : canApprove ? (
          panel === null && (
            <div className="actions">
              {!change && (
                <button
                  type="button"
                  className="btn small"
                  disabled={busy}
                  onClick={() => setPanel('changes')}
                >
                  <SyncIcon size={14} />
                  Request changes
                </button>
              )}
              {f.guarded ? (
                <button
                  type="button"
                  className="btn small"
                  disabled={busy}
                  onClick={() => setPanel(change ? 'dismiss' : 'approve')}
                >
                  <ShieldIcon size={14} />
                  {change ? 'Dismiss with a reason…' : 'Approve with a reason…'}
                </button>
              ) : change ? (
                <PendingButton
                  className="small"
                  pending={approving}
                  pendingLabel="Dismissing…"
                  disabled={busy}
                  onClick={() => void decide({})}
                >
                  <XIcon size={14} />
                  Dismiss
                </PendingButton>
              ) : (
                <PendingButton
                  className="small"
                  pending={approving}
                  pendingLabel="Approving…"
                  disabled={busy}
                  onClick={() => void decide({})}
                >
                  <CheckCircleFillIcon size={14} />
                  Approve
                </PendingButton>
              )}
            </div>
          )
        ) : (
          !changes && <p className="muted small">Not approved</p>
        )}
        {panel === null && <PanelError error={error} />}
      </div>
    </div>
  );
}
