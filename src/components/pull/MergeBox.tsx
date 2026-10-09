import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertIcon,
  CheckIcon,
  GitMergeIcon,
  HistoryIcon,
  LockIcon,
  PlayIcon,
  SyncIcon,
  TrashIcon,
} from '@primer/octicons-react';
import {
  api,
  qk,
  type MergingPaused,
  type PullDetail,
  type RepoDetail,
} from '@/lib/uiApi';
import { ApiError, errorMessage } from '@/lib/api';
import { blocking, reasonText } from '@/lib/pullState';
import {
  canRetryRebase,
  rebasedFirst,
  rebaseHeadline,
} from '@/lib/rebaseStatus';
import {
  canDeleteMergedBranch,
  etaText,
  nextStep,
  openQuestion,
  pullBlockers,
  queueLine,
  type QueueSpot,
} from '@/lib/pullPage';
import { fullDate, timeAgo } from '@/lib/format';
import { FileList } from '@/components/FileList';
import { AutoMergeStatus, useAction } from '@/components/AutoMergeReview';
import { PersonApprovals } from '@/components/ReviewersBox';
import { useAgentDirectory } from '@/components/actions/RunActor';
import { PanelError } from '@/components/approvals/Panels';
import { Banner } from '@/components/ui/Banner';
import { PendingButton } from '@/components/ui/PendingButton';
import { useToast } from '@/components/ui/Toast';

type Done = () => Promise<unknown>;

/** Across the top of every tab while merging is paused on the repository; push rights resume it. */
export function PausedBanner({
  repo,
  paused,
  onDone,
}: {
  repo: RepoDetail;
  paused: NonNullable<MergingPaused>;
  onDone: Done;
}) {
  const { busy, error, run } = useAction(onDone);
  const by = paused.by.name || paused.by.login;
  return (
    <Banner
      action={
        repo.permissions.write ? (
          <PendingButton
            className="small"
            pending={busy}
            pendingLabel="Resuming…"
            error={error}
            onClick={() =>
              run(() => api.resumeMerging(repo.owner.username, repo.name))
            }
          >
            <PlayIcon size={14} />
            Resume merging
          </PendingButton>
        ) : undefined
      }
    >
      <b>Merging is paused</b> on this repository. {by} paused it{' '}
      <time title={fullDate(paused.at / 1000)}>
        {timeAgo(paused.at / 1000)}
      </time>
      . Nothing merges, by the button or automatically, until someone resumes
      it.
    </Banner>
  );
}

/** Where the branch stands against its base: up to date, behind, Fixer resolving, or stopped on a conflict. */
function RebaseRow({
  repo,
  d,
  onDone,
}: {
  repo: RepoDetail;
  d: PullDetail;
  onDone: Done;
}) {
  const pr = d.pull;
  const rebase = d.rebase;
  const conflict = rebase?.status === 'conflict';
  const resolving = rebase?.status === 'resolving';
  const headline = rebase ? rebaseHeadline(rebase, pr.headRef) : null;
  // A stopped rebase (AI failed on a commit, and the like): a person with merge permission may try it again.
  const retry = useAction(onDone);
  return (
    <div className="pr-row">
      <span className="pr-row-icon">
        {(!rebase && d.headBranchExists) || resolving ? (
          <span className="spinner" aria-hidden="true" />
        ) : conflict || !rebase ? (
          <AlertIcon className="pr-warn" />
        ) : (
          <CheckIcon className="pr-ok" />
        )}
      </span>
      <div className="pr-row-main">
        <p>
          <b>
            {headline?.title ??
              (d.headBranchExists
                ? 'Checking the branch…'
                : `The ${pr.headRef} branch is gone`)}
          </b>
        </p>
        {headline && <p className="muted small">{headline.detail}</p>}
        {(conflict || resolving) && rebase.files.length > 0 && (
          <FileList paths={rebase.files} />
        )}
        <PanelError error={retry.error} />
      </div>
      {d.canMerge && canRetryRebase(rebase) && (
        <PendingButton
          className="small"
          pending={retry.busy}
          pendingLabel="Starting the rebase…"
          onClick={() =>
            retry.run(() =>
              api.retryRebase(repo.owner.username, repo.name, pr.number)
            )
          }
        >
          <SyncIcon size={14} />
          Try the rebase again
        </PendingButton>
      )}
    </div>
  );
}

/**
 * "What happens next" for an open pull request: one plain sentence (what it waits on, or that it is merging), its
 * place in the merge queue and the estimate, the owner's question when a reviewer asks one, then the developer
 * detail: the branch against its base, auto-merge, people's approvals and the merge button with its confirm step.
 */
export function OpenBox({
  repo,
  d,
  spot,
  onFilesTab,
  onDone,
}: {
  repo: RepoDetail;
  d: PullDetail;
  spot: QueueSpot | null;
  onFilesTab: boolean;
  onDone: Done;
}) {
  const pr = d.pull;
  const base = `/${repo.fullName}`;
  const lookup = useAgentDirectory();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Not an error: landing rebased the branch first and now waits for its checks (or review) on the new head.
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const question = openQuestion(
    d.review?.reviewers.filter((r) => r.requested && r.invited)
  );
  const askedBy = question ? lookup(question.agent.username).name : null;
  const blockers = pullBlockers(d.pullState, spot?.entry.blockers);
  const step = nextStep(
    {
      state: pr.state,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      headBranchExists: d.headBranchExists,
      pullState: d.pullState,
      rebase: d.rebase,
      autoMerge: d.review?.autoMerge.state ?? null,
    },
    {
      blockers,
      question:
        question && askedBy
          ? {
              agent: askedBy,
              text: question.flag.question!,
              assignee: question.flag.assignee
                ? question.flag.assignee.name || question.flag.assignee.login
                : null,
            }
          : null,
      coder: pr.createdVia ?? pr.author.username,
    }
  );
  const paused = !!d.pullState?.reasons.some(
    (r) => r.kind === 'merging_paused'
  );
  const eta = paused ? null : etaText(spot?.entry.etaMinutes ?? null);
  // Review isn't satisfied yet: merging records this person's approval of the commit shown here.
  const needsApproval = !!d.review?.verdict && !d.review.verdict.satisfied;
  const changesRequested = !!d.review?.verdict?.reasons.some(
    (r) => r.kind === 'agent_changes_requested'
  );
  const behind = d.rebase?.status === 'behind';
  const open = () => {
    setError(null);
    setNotice(null);
    setConfirming(true);
  };
  const merge = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.mergePull(repo.owner.username, repo.name, pr.number, {
        // The commit this page shows: a push since loading is refused (409), never merged or approved unseen.
        ...(d.headSha ? { headSha: d.headSha } : {}),
        ...(needsApproval ? { approve: true } : {}),
      });
      setConfirming(false);
      void onDone();
    } catch (e) {
      const msg = errorMessage(e);
      // landPull rebased and pushed the branch, then stopped: it lands once the new head's checks pass.
      if (e instanceof ApiError && rebasedFirst(e.status, e.body))
        setNotice(msg);
      else setError(msg);
      if (e instanceof ApiError && e.status === 409) {
        // The branch moved: reload so the page shows the new commits, and close the confirm so the next
        // click can't approve or merge a commit nobody looked at. The error stays visible below.
        setConfirming(false);
        void Promise.resolve(onDone()).catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  };
  const canMergeNow = d.canMerge && !!d.mergeable;
  return (
    <section
      className={`panel pr-next tone-${step.tone}`}
      aria-labelledby="pr-next-title"
    >
      <div className="pr-next-top">
        <div className="pr-next-main">
          <span className="eyebrow" id="pr-next-title">
            What happens next
          </span>
          <p className="pr-next-line">
            <b>{step.headline}</b>
          </p>
          {step.detail && <p className="muted">{step.detail}</p>}
          {step.listed.length > 0 && (
            <ul className="pr-blockers" aria-label="What it waits on">
              {step.listed.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {(spot || eta) && (
            <p className="muted small">
              {eta && <>Estimate: {eta}. </>}
              {spot && queueLine(spot)}
            </p>
          )}
        </div>
        <div className="actions pr-next-actions">
          {question && askedBy && (
            <Link
              className="btn primary"
              to={`/approvals/${encodeURIComponent(question.flag.id)}`}
            >
              Answer {askedBy}&rsquo;s question
            </Link>
          )}
          {canMergeNow && !confirming && (
            <button
              type="button"
              className={`btn${question ? '' : ' primary'}`}
              // Paused merging stops the button too; the banner says who paused it and offers Resume.
              disabled={paused}
              title={
                paused ? 'Merging is paused on this repository' : undefined
              }
              onClick={open}
            >
              <GitMergeIcon size={14} />
              {needsApproval ? 'Approve and merge' : 'Rebase and merge'}
            </button>
          )}
          {!onFilesTab && (
            <Link className="btn quiet" to={`${base}/pull/${pr.number}/files`}>
              View diff
            </Link>
          )}
        </div>
      </div>
      {(error || notice) && (
        <div className="pr-next-msg">
          {error && <PanelError error={error} />}
          {notice && (
            <p className="pr-notice" role="status">
              {notice}
            </p>
          )}
        </div>
      )}
      {confirming && canMergeNow && !paused && (
        <div className="pr-confirm" role="group" aria-label="Confirm merge">
          {needsApproval && (
            <p>
              Review isn&apos;t satisfied (
              {d.pullState?.reasons
                .filter(blocking)
                .map(reasonText)
                .join('; ') || 'not approved'}
              ). Merging records your approval of this commit.
              {changesRequested &&
                ' Approval does not override an agent’s change request: dismiss it first, or the merge is refused.'}
            </p>
          )}
          <p className="muted small">
            {behind ? (
              <>
                GitOrange rebases this branch onto <code>{d.rebase!.onto}</code>{' '}
                first. If the rebased commits need checks, it lands once they
                pass.
              </>
            ) : (
              <>
                <code>{pr.baseRef}</code> moves to this branch&apos;s head: its
                commits land as they are, keeping history linear.
              </>
            )}
          </p>
          <div className="actions">
            <PendingButton
              className="primary small"
              pending={busy}
              pendingLabel={behind ? 'Rebasing and merging…' : 'Merging…'}
              onClick={merge}
            >
              {needsApproval
                ? 'Confirm approve and merge'
                : 'Confirm rebase and merge'}
            </PendingButton>
            <button
              type="button"
              className="btn quiet small"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="pr-rows">
        <RebaseRow repo={repo} d={d} onDone={onDone} />
        {d.review && d.review.autoMerge.state !== 'off' && (
          <AutoMergeStatus repo={repo} d={d} onChange={onDone} />
        )}
        {d.review && <PersonApprovals repo={repo} d={d} onChange={onDone} />}
        {!d.canMerge && (
          <div className="pr-row">
            <span className="pr-row-icon">
              <LockIcon className="muted" />
            </span>
            <p className="pr-row-main muted">
              Only those with write access to this repository can merge pull
              requests.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * A merged pull request: where and when it landed, what happened to its branch (delete it here), and Revert, which
 * opens a new pull request that undoes it (reviewed like any other change).
 */
export function MergedBox({
  repo,
  d,
  onDone,
}: {
  repo: RepoDetail;
  d: PullDetail;
  onDone: Done;
}) {
  const pr = d.pull;
  const base = `/${repo.fullName}`;
  const navigate = useNavigate();
  const toast = useToast();
  const [branchDeleted, setBranchDeleted] = useState(false);
  const del = useAction(onDone);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const branchThere = d.headBranchExists && !branchDeleted;
  const branches = useQuery({
    queryKey: qk.branches(repo.owner.username, repo.name),
    queryFn: () => api.branches(repo.owner.username, repo.name),
    enabled: d.canMerge && branchThere,
  });
  const canDelete =
    d.canMerge &&
    branchThere &&
    canDeleteMergedBranch(
      pr.headRef,
      branches.data?.find((branch) => branch.name === pr.headRef)
    );
  const canRevert = repo.permissions.write;
  const revert = async () => {
    setReverting(true);
    setRevertError(null);
    try {
      const made = await api.revertPull(
        repo.owner.username,
        repo.name,
        pr.number
      );
      void onDone();
      toast(`Opened #${made.number} to revert #${pr.number}`);
      navigate(`${base}/pull/${made.number}`);
    } catch (e) {
      // 409: not merged, or it doesn't revert cleanly; the server says which.
      setRevertError(errorMessage(e));
    } finally {
      setReverting(false);
    }
  };
  return (
    <section
      className="panel pr-next tone-merged"
      aria-labelledby="pr-next-title"
    >
      <div className="pr-next-top">
        <div className="pr-next-main">
          <span className="eyebrow" id="pr-next-title">
            Merged
          </span>
          <p className="pr-next-line">
            <b>
              Merged into {pr.baseRef}{' '}
              {pr.mergedAt && (
                <time title={fullDate(pr.mergedAt)}>
                  {timeAgo(pr.mergedAt)}
                </time>
              )}
            </b>{' '}
            {pr.mergedBy ? (
              <>
                by{' '}
                <Link to={`/${pr.mergedBy.username}`}>
                  {pr.mergedBy.username}
                </Link>
              </>
            ) : pr.mergedAutomatically ? (
              'automatically, by GitOrange'
            ) : null}
            {pr.mergeCommitSha && (
              <>
                {' '}
                at{' '}
                <Link
                  to={`${base}/commit/${pr.mergeCommitSha}`}
                  className="mono"
                >
                  {pr.mergeCommitSha.slice(0, 7)}
                </Link>
              </>
            )}
            .
          </p>
          <p className="muted">
            {branchThere ? (
              <>
                The <code>{pr.headRef}</code> branch is still there.
                {canDelete &&
                  ' It has no newer work or open pull requests that need it, so it can be deleted.'}
              </>
            ) : (
              <>
                The <code>{pr.headRef}</code> branch has been deleted.
              </>
            )}
          </p>
        </div>
        <div className="actions pr-next-actions">
          {canDelete && (
            <PendingButton
              className="small"
              pending={del.busy}
              pendingLabel="Deleting…"
              onClick={async () => {
                if (
                  await del.run(() =>
                    api.deleteBranch(repo.owner.username, repo.name, pr.headRef)
                  )
                )
                  setBranchDeleted(true);
              }}
            >
              <TrashIcon size={14} />
              Delete branch
            </PendingButton>
          )}
          {canRevert && !confirmRevert && (
            <button
              type="button"
              className="btn small"
              onClick={() => {
                setRevertError(null);
                setConfirmRevert(true);
              }}
            >
              <HistoryIcon size={14} />
              Revert
            </button>
          )}
        </div>
      </div>
      {del.error && (
        <div className="pr-next-msg">
          <PanelError error={del.error} />
        </div>
      )}
      {confirmRevert && (
        <div className="pr-confirm" role="group" aria-label="Confirm revert">
          <p>
            Revert opens a new pull request, “Revert #{pr.number}: {pr.title}”,
            that undoes these changes on top of <code>{pr.baseRef}</code> as it
            is now. Nothing changes until it is reviewed and merged like any
            other change.
          </p>
          <div className="actions">
            <PendingButton
              className="primary small"
              pending={reverting}
              pendingLabel="Opening…"
              onClick={revert}
            >
              <HistoryIcon size={14} />
              Open the revert pull request
            </PendingButton>
            <button
              type="button"
              className="btn quiet small"
              onClick={() => setConfirmRevert(false)}
            >
              Cancel
            </button>
          </div>
          <PanelError error={revertError} />
        </div>
      )}
    </section>
  );
}

/** A closed pull request: when, and Reopen while its branch is still there. */
export function ClosedBox({
  repo,
  d,
  canEdit,
  onDone,
}: {
  repo: RepoDetail;
  d: PullDetail;
  canEdit: boolean;
  onDone: Done;
}) {
  const pr = d.pull;
  const reopen = useAction(onDone);
  return (
    <section className="panel pr-next tone-off" aria-labelledby="pr-next-title">
      <div className="pr-next-top">
        <div className="pr-next-main">
          <span className="eyebrow" id="pr-next-title">
            Closed
          </span>
          <p className="pr-next-line">
            <b>
              Closed without merging{' '}
              {pr.closedAt && (
                <time title={fullDate(pr.closedAt)}>
                  {timeAgo(pr.closedAt)}
                </time>
              )}
              .
            </b>
          </p>
          <p className="muted">
            {d.headBranchExists ? (
              <>
                Its branch <code>{pr.headRef}</code> is still there, so it can
                be reopened.
              </>
            ) : (
              <>
                The <code>{pr.headRef}</code> branch is gone, so it can&apos;t
                be reopened.
              </>
            )}
          </p>
          <PanelError error={reopen.error} />
        </div>
        {canEdit && d.headBranchExists && (
          <div className="actions pr-next-actions">
            <PendingButton
              className="small"
              pending={reopen.busy}
              pendingLabel="Reopening…"
              onClick={() =>
                reopen.run(() =>
                  api.updatePull(repo.owner.username, repo.name, pr.number, {
                    state: 'open',
                  })
                )
              }
            >
              Reopen pull request
            </PendingButton>
          </div>
        )}
      </div>
    </section>
  );
}
