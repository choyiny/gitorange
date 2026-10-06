import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertIcon,
  CheckCircleIcon,
  GitPullRequestIcon,
} from '@primer/octicons-react';
import { api, qk, type ApprovalItem } from '@/lib/uiApi';
import { ApiError, errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Header } from '@/components/Header';
import { PullStateLabel, PullStateReasons } from '@/components/PullStateLabel';
import { Spinner } from '@/components/Spinner';
import { Avatar } from '@/components/Avatar';
import { Flag, serverChangesRequester } from '@/components/AutoMergeReview';
import { useApprovalPages } from '@/lib/approvals';

function Item({ item }: { item: ApprovalItem }) {
  const qc = useQueryClient();
  const [owner, name] = item.repo.fullName.split('/');
  const n = item.pull.number;
  const prUrl = `/${item.repo.fullName}/pull/${n}`;
  // Approved here, waiting for the list to reload.
  const [approved, setApproved] = useState<Set<string>>(new Set());
  // Changes requested here (flag id → note), waiting for the list to reload.
  const [requested, setRequested] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (
    key: string,
    fn: () => Promise<unknown>,
    opts?: { sendingNote?: boolean }
  ) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(
        errorMessage(e) +
          (e instanceof ApiError && e.status === 409 && opts?.sendingNote
            ? ' Your note was not sent.'
            : '')
      );
      return false;
    } finally {
      // Also after a refusal (409: the branch moved): the list and the pull request show the new state.
      void qc.invalidateQueries({ queryKey: ['repo', owner, name] });
      await qc.invalidateQueries({ queryKey: qk.approvals });
      setBusy(null);
    }
  };

  const changeRequested =
    !!item.pullState?.reasons.some(
      (r) => r.kind === 'agent_changes_requested'
    ) ||
    item.agents.some(
      (g) =>
        g.status === 'changes_requested' ||
        g.flags.some((f) => f.kind === 'change_requested' && !f.approvedAt)
    );
  return (
    <div className="Box mb-3">
      <div
        className="Box-header d-flex flex-items-center flex-wrap"
        style={{ gap: 8 }}
      >
        <GitPullRequestIcon className="color-fg-open" />
        <div className="flex-1" style={{ minWidth: 200 }}>
          <div className="f6 color-fg-muted">{item.repo.fullName}</div>
          <Link to={prUrl} className="text-bold color-fg-default f4">
            {item.pull.title}
          </Link>{' '}
          <span className="color-fg-muted">#{n}</span>
        </div>
        <span className="f6 color-fg-muted flex-shrink-0">
          {item.pull.author ? `by ${item.pull.author.username} · ` : ''}
          updated {timeAgo(item.pull.updatedAt)}
        </span>
      </div>
      <div className="Box-body">
        {error && <div className="flash flash-error mb-2">{error}</div>}
        {item.pullState?.state === 'human_review' &&
          !item.agents.length &&
          !item.needsApproval &&
          !item.reviewFailed &&
          !item.resolutionFailed &&
          !item.stackStale.length &&
          !item.stackUnchecked.length && (
            <div className="flash flash-warn mb-2">
              <PullStateLabel state={item.pullState} />
              <PullStateReasons state={item.pullState} />
              <Link to={prUrl} className="btn btn-sm mt-2">
                Decide on the pull request
              </Link>
            </div>
          )}
        {item.reviewFailed && (
          <div
            className="flash flash-error mb-2 d-flex flex-items-center"
            style={{ gap: 8 }}
          >
            <AlertIcon />
            <span className="flex-1">
              The review failed: {item.reviewFailed}
            </span>
            <button
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() =>
                act('retry', () => api.retryReview(owner, name, n))
              }
            >
              {busy === 'retry' ? 'Starting…' : 'Try the review again'}
            </button>
          </div>
        )}
        {item.resolutionFailed && (
          <div
            className="flash flash-warn mb-2 d-flex flex-items-center"
            style={{ gap: 8 }}
          >
            <AlertIcon />
            <span className="flex-1">{item.resolutionFailed}</span>
            <Link to={prUrl} className="btn btn-sm">
              Decide on the pull request
            </Link>
          </div>
        )}
        {item.stackStale.map((s) => (
          <div
            key={`stale${s.pr}`}
            className="flash flash-warn mb-2 d-flex flex-items-center flex-wrap"
            style={{ gap: 8 }}
          >
            <AlertIcon />
            <span className="flex-1" style={{ minWidth: 200 }}>
              Still must account for #{s.pr} (nothing new since{' '}
              {timeAgo(s.since)})
            </span>
            <Link
              to={`/${item.repo.fullName}/pull/${s.pr}`}
              className="btn btn-sm"
            >
              View #{s.pr}
            </Link>
          </div>
        ))}
        {item.stackUnchecked.length > 0 && (
          <div
            className="flash flash-warn mb-2 d-flex flex-items-center flex-wrap"
            style={{ gap: 8 }}
          >
            <AlertIcon />
            <span className="flex-1" style={{ minWidth: 200 }}>
              Couldn&apos;t check against{' '}
              {item.stackUnchecked.map((u) => `#${u}`).join(', ')}
            </span>
            <button
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => act('stack', () => api.retryStack(owner, name, n))}
            >
              {busy === 'stack' ? 'Starting…' : 'Check again'}
            </button>
          </div>
        )}
        {item.needsApproval && (
          <div
            className="flash flash-warn mb-2 d-flex flex-items-center flex-wrap"
            style={{ gap: 8 }}
          >
            <AlertIcon />
            <span className="flex-1" style={{ minWidth: 200 }}>
              No agent reviewed this commit: a person approves it.
              {changeRequested && (
                <span className="color-fg-attention">
                  {' '}
                  Approving does not override an agent&apos;s change request:
                  dismiss it, or wait for a fix.
                </span>
              )}
            </span>
            <Link to={prUrl} className="btn btn-sm">
              Review the changes
            </Link>
            <button
              className="btn btn-sm btn-primary"
              disabled={busy !== null || !item.pull.headSha}
              aria-label="Approve this commit"
              onClick={() =>
                act('approve', () =>
                  api.approvePull(owner, name, n, item.pull.headSha!)
                )
              }
            >
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </button>
          </div>
        )}
        {item.agents.map((g) => (
          <div key={g.reviewerId} className="mb-2">
            <div
              className="d-flex flex-items-center flex-wrap mb-1"
              style={{ gap: 6 }}
            >
              <Avatar user={g.agent} size={16} />
              <Link to={`/${g.agent.username}`} className="text-bold f6">
                @{g.agent.username}
              </Link>
              {g.status === 'failed' && (
                <>
                  <span className="f6 color-fg-danger flex-1">
                    Review failed: {g.error ?? 'unknown error'}
                  </span>
                  <button
                    className="btn btn-sm"
                    disabled={busy !== null}
                    aria-label={`Retry @${g.agent.username}'s review`}
                    onClick={() =>
                      act(`retry:${g.reviewerId}`, () =>
                        api.retryReviewer(owner, name, n, g.reviewerId)
                      )
                    }
                  >
                    {busy === `retry:${g.reviewerId}` ? 'Starting…' : 'Retry'}
                  </button>
                </>
              )}
            </div>
            {g.flags.map((f) => {
              const localNote = requested.get(f.id);
              return (
                <Flag
                  key={f.id}
                  f={f}
                  approver={
                    approved.has(f.id) ? { label: 'you', user: null } : null
                  }
                  changesRequester={
                    localNote !== undefined
                      ? { label: 'you', user: null, note: localNote || null }
                      : serverChangesRequester(f)
                  }
                  canApprove
                  approving={busy === f.id}
                  requestingChanges={busy === `changes:${f.id}`}
                  investigating={false}
                  onApprove={() =>
                    act(f.id, async () => {
                      await api.approveFlag(owner, name, n, f.id);
                      setApproved((s) => new Set(s).add(f.id));
                    })
                  }
                  onRequestChanges={(note) =>
                    act(
                      `changes:${f.id}`,
                      async () => {
                        await api.requestFlagChanges(
                          owner,
                          name,
                          n,
                          f.id,
                          note
                        );
                        setRequested((m) => new Map(m).set(f.id, note.trim()));
                      },
                      { sendingNote: true }
                    )
                  }
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Open pull requests waiting on the user: agents' findings, failed reviews, approvals, failed conflict resolutions. */
export default function Approvals() {
  const q = useApprovalPages();
  const count = q.data?.pages[0]?.count ?? 0;
  // A pull request updated between pages can come back on a later one: show it once.
  const items = [
    ...new Map(
      (q.data?.pages.flatMap((p) => p.items) ?? []).map((i) => [
        `${i.repo.fullName}#${i.pull.number}`,
        i,
      ])
    ).values(),
  ];
  return (
    <>
      <Header />
      <div className="container-lg px-3 py-4">
        <h1 className="f2 text-normal mb-1">Approvals</h1>
        <p className="color-fg-muted mb-4">
          Pull requests waiting on you before they can merge on their own,
          across every repository you can merge in.
          {count > 0 && (
            <>
              {' '}
              <strong className="color-fg-default">
                {count} {count === 1 ? 'item' : 'items'}
              </strong>{' '}
              to go.
            </>
          )}
        </p>
        {q.isPending ? (
          <Spinner />
        ) : q.error ? (
          <div className="flash flash-error">{errorMessage(q.error)}</div>
        ) : !items.length ? (
          <div className="blankslate border rounded-2">
            <CheckCircleIcon size={24} className="color-fg-success mb-2" />
            <h3 className="blankslate-heading">Nothing is waiting on you</h3>
            <p>
              Findings agents raised for a person, failed agent reviews, pull
              requests no agent reviewed, conflicts AI couldn&apos;t resolve,
              and pull requests that need a person&apos;s decision show up here.
            </p>
          </div>
        ) : (
          <>
            {items.map((item) => (
              <Item
                key={`${item.repo.fullName}#${item.pull.number}`}
                item={item}
              />
            ))}
            {q.hasNextPage && (
              <div className="text-center">
                <button
                  className="btn"
                  disabled={q.isFetchingNextPage}
                  onClick={() => void q.fetchNextPage()}
                >
                  {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
