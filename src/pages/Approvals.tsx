import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertIcon,
  CheckCircleIcon,
  GitPullRequestIcon,
} from '@primer/octicons-react';
import { api, qk, type ApprovalItem } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Header } from '@/components/Header';
import { Spinner } from '@/components/Spinner';
import { Flag } from '@/components/AutoMergeReview';
import { approvalCount, useApprovals } from '@/lib/approvals';

function Item({ item }: { item: ApprovalItem }) {
  const qc = useQueryClient();
  const [owner, name] = item.repo.fullName.split('/');
  const n = item.pull.number;
  const prUrl = `/${item.repo.fullName}/pull/${n}`;
  // Approved here, waiting for the list to reload.
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: qk.approvals });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="Box mb-3">
      <div className="Box-header d-flex flex-items-center" style={{ gap: 8 }}>
        <GitPullRequestIcon className="color-fg-open" />
        <div className="flex-1" style={{ minWidth: 0 }}>
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
        {item.flags.map((f) => (
          <Flag
            key={f.id}
            f={f}
            approver={approved.has(f.id) ? { label: 'you', user: null } : null}
            canApprove
            approving={busy === f.id}
            investigating={false}
            onApprove={() =>
              act(f.id, async () => {
                await api.approveFlag(owner, name, n, f.id);
                setApproved((s) => new Set(s).add(f.id));
              })
            }
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Every open pull request waiting on a person, across the repositories the user can merge in:
 * flags to approve, failed reviews to retry, conflict resolutions to decide on. It updates live.
 */
export default function Approvals() {
  const q = useApprovals();
  const count = approvalCount(q.data);
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
        ) : !q.data.length ? (
          <div className="blankslate border rounded-2">
            <CheckCircleIcon size={24} className="color-fg-success mb-2" />
            <h3 className="blankslate-heading">Nothing is waiting on you</h3>
            <p>
              Flags from auto-merge reviews, failed reviews, and conflicts AI
              couldn&apos;t resolve show up here.
            </p>
          </div>
        ) : (
          q.data.map((item) => (
            <Item
              key={`${item.repo.fullName}#${item.pull.number}`}
              item={item}
            />
          ))
        )}
      </div>
    </>
  );
}
