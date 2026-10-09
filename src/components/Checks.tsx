import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircleIcon } from '@primer/octicons-react';
import {
  api,
  qk,
  type CommitRuns,
  type RepoDetail,
  type WorkflowRun,
} from '@/lib/uiApi';
import { duration } from '@/lib/format';
import { RunStatusIcon } from './RunStatusIcon';
import { Dropdown } from './Dropdown';
import { RunChip } from './actions/RunChip';
import { QueryError, RowsSkeleton } from './actions/states';
import { EmptyState } from './ui/EmptyState';

/** A commit's workflow runs (its checks); polls while any is pending. */
export function useCommitRuns(
  repo: RepoDetail,
  sha: string | null | undefined
) {
  const o = repo.owner.username;
  return useQuery({
    queryKey: qk.commitRuns(o, repo.name, sha ?? ''),
    queryFn: () => api.commitRuns(o, repo.name, sha!),
    enabled: Boolean(sha),
    refetchInterval: (q) => (q.state.data?.state === 'pending' ? 4000 : false),
  });
}

/** The status glyph for a commit's combined check state. */
export const STATE_ICON: Record<
  NonNullable<CommitRuns['state']>,
  Parameters<typeof RunStatusIcon>[0]
> = {
  success: { status: 'completed', conclusion: 'success' },
  failure: { status: 'completed', conclusion: 'failure' },
  pending: { status: 'in_progress', conclusion: null },
};

/** The ✓ / ✗ / spinner next to the latest commit; click it for a summary of its checks. */
export function CommitStatus({ repo, sha }: { repo: RepoDetail; sha: string }) {
  const q = useCommitRuns(repo, sha);
  return <ChecksBadge repo={repo} checks={q.data} align="right" />;
}

/** Checks for many commits in one request, keyed by SHA; polls while any is running. */
export function useCommitStatuses(
  repo: RepoDetail | undefined,
  shas: (string | null | undefined)[]
) {
  const o = repo?.owner.username ?? '';
  const name = repo?.name ?? '';
  const list = [...new Set(shas.filter((s): s is string => !!s))].slice(0, 100);
  return useQuery({
    queryKey: qk.commitStatuses(o, name, list.join(',')),
    queryFn: () => api.commitStatuses(o, name, list),
    enabled: Boolean(repo) && list.length > 0,
    refetchInterval: (q) =>
      Object.values(q.state.data ?? {}).some((c) => c.state === 'pending')
        ? 5000
        : false,
  });
}

/** A commit's combined check state (✓ / ✗ / spinner); opens a summary; empty with no checks. */
export function ChecksBadge({
  repo,
  checks,
  align = 'left',
}: {
  repo: RepoDetail;
  checks: CommitRuns | undefined;
  align?: 'left' | 'right';
}) {
  if (!checks?.state) return null;
  const state = checks.state;
  return (
    <Dropdown
      align={align}
      width={380}
      className="checks-popover"
      trigger={(open, toggle) => (
        <button
          type="button"
          className="btn-octicon p-0 m-0 d-inline-flex flex-items-center"
          style={{ background: 'none', border: 0, cursor: 'pointer' }}
          aria-expanded={open}
          aria-label={STATE_LABEL[state]}
          title={STATE_LABEL[state]}
          onClick={(e) => {
            // Rows are often links; the badge opens its summary instead of following them.
            e.preventDefault();
            e.stopPropagation();
            toggle();
          }}
        >
          <RunStatusIcon {...STATE_ICON[state]} size={14} />
        </button>
      )}
    >
      {() => <ChecksSummary repo={repo} data={checks} />}
    </Dropdown>
  );
}

export const STATE_LABEL: Record<NonNullable<CommitRuns['state']>, string> = {
  success: 'All checks have passed',
  failure: 'Some checks were not successful',
  pending: "Some checks haven't completed yet",
};

/** "(pull_request) · Successful in 1m 2s": what started a run, and how it went. */
function runLine(r: WorkflowRun): string {
  return `(${r.event === 'pull_request' ? 'pull_request' : 'push'})${
    r.status === 'completed' && r.startedAt
      ? ` · ${r.conclusion === 'success' ? 'Successful' : r.conclusion === 'failure' ? 'Failing' : r.conclusion === 'skipped' ? 'Skipped' : 'Cancelled'} in ${duration(r.startedAt, r.completedAt)}`
      : r.status === 'in_progress'
        ? ' · In progress'
        : ' · Queued'
  }`;
}

/** "1 failing, 2 successful checks". */
export function checksDetail(data: CommitRuns): string {
  const failed = data.runs.filter(
    (r) => r.conclusion === 'failure' || r.conclusion === 'cancelled'
  ).length;
  const pending = data.runs.filter((r) => r.status !== 'completed').length;
  const detail = [
    failed && `${failed} failing`,
    pending && `${pending} in progress`,
    data.runs.length - failed - pending &&
      `${data.runs.length - failed - pending} successful`,
  ]
    .filter(Boolean)
    .join(', ');
  return `${detail} check${data.runs.length === 1 ? '' : 's'}`;
}

/** The summary of a commit's checks (the badge's popover): the overall result, then one row per workflow run. */
function ChecksSummary({ repo, data }: { repo: RepoDetail; data: CommitRuns }) {
  const base = `/${repo.fullName}`;
  return (
    <>
      <div
        className="px-3 py-2 border-bottom d-flex flex-items-center"
        style={{ gap: 12 }}
      >
        <RunStatusIcon {...STATE_ICON[data.state!]} size={16} />
        <div>
          <div className="text-bold">{STATE_LABEL[data.state!]}</div>
          <div className="f6 color-fg-muted">{checksDetail(data)}</div>
        </div>
      </div>
      {data.runs.map((r) => (
        <div
          key={r.id}
          className="px-3 py-2 border-bottom d-flex flex-items-center f6"
          style={{ gap: 8 }}
        >
          <RunStatusIcon status={r.status} conclusion={r.conclusion} />
          <span className="flex-1" style={{ minWidth: 0 }}>
            <span className="text-bold">{r.name}</span>{' '}
            <span className="color-fg-muted">{runLine(r)}</span>
          </span>
          <Link
            to={`${base}/actions/runs/${r.runNumber}`}
            className="flex-shrink-0"
          >
            Details
          </Link>
        </div>
      ))}
    </>
  );
}

/**
 * A pull request's checks: the head commit's workflow runs, the overall result first, then one row per run with
 * its "Details" link. Says so when nothing ran, and offers a retry when the list didn't load.
 */
export function ChecksBox({
  repo,
  sha,
}: {
  repo: RepoDetail;
  sha: string | null;
}) {
  const q = useCommitRuns(repo, sha);
  const data = q.data;
  const base = `/${repo.fullName}`;
  if (!sha)
    return (
      <div className="panel">
        <EmptyState
          picture={<CheckCircleIcon size={20} />}
          title="No commit to check"
          body="The branch is gone, so there are no checks to show."
        />
      </div>
    );
  if (q.isError && !data)
    return (
      <div className="panel">
        <QueryError
          error={q.error}
          title="The checks did not load"
          onRetry={() => void q.refetch()}
        />
      </div>
    );
  if (!data) return <RowsSkeleton rows={2} />;
  if (!data.state || !data.runs.length)
    return (
      <div className="panel">
        <EmptyState
          picture={<CheckCircleIcon size={20} />}
          title="No checks ran on this commit"
          body="Workflows in .github/workflows run on every push and show up here."
        />
      </div>
    );
  return (
    <section className="panel checks-box" aria-label="Checks">
      <div className="checks-head">
        <RunStatusIcon {...STATE_ICON[data.state]} size={20} />
        <div>
          <p className="checks-title">{STATE_LABEL[data.state]}</p>
          <p className="muted small">{checksDetail(data)}</p>
        </div>
      </div>
      <ul className="checks-list">
        {data.runs.map((r) => (
          <li key={r.id}>
            <RunChip status={r.status} conclusion={r.conclusion} />
            <span className="checks-name">
              <b>{r.name}</b> <span className="muted small">{runLine(r)}</span>
            </span>
            <Link to={`${base}/actions/runs/${r.runNumber}`} className="small">
              Details
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
