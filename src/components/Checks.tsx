import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qk, type CommitRuns, type RepoDetail } from '@/lib/uiApi';
import { duration } from '@/lib/format';
import { RunStatusIcon } from './RunStatusIcon';
import { Dropdown } from './Dropdown';

function useCommitRuns(repo: RepoDetail, sha: string | null | undefined) {
  const o = repo.owner.username;
  return useQuery({
    queryKey: qk.commitRuns(o, repo.name, sha ?? ''),
    queryFn: () => api.commitRuns(o, repo.name, sha!),
    enabled: Boolean(sha),
    refetchInterval: (q) => (q.state.data?.state === 'pending' ? 4000 : false),
  });
}

const STATE_ICON: Record<
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

/**
 * Checks for many commits in one request (commit lists, pull request lists), keyed by SHA.
 * Refreshes while any of them is still running; live updates refresh it on changes too.
 */
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

/**
 * A commit's combined check state as a ✓ / ✗ / spinner. Clicking it opens a summary like
 * GitHub's: what passed or failed, how long each took, and a link to each run. Nothing renders
 * when no checks ran.
 */
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
      {() => <ChecksSummary repo={repo} data={checks} compact />}
    </Dropdown>
  );
}

const STATE_LABEL: Record<NonNullable<CommitRuns['state']>, string> = {
  success: 'All checks have passed',
  failure: 'Some checks were not successful',
  pending: "Some checks haven't completed yet",
};

/** The summary of a commit's checks: the overall result, then one row per workflow run. */
function ChecksSummary({
  repo,
  data,
  compact = false,
}: {
  repo: RepoDetail;
  data: CommitRuns;
  compact?: boolean;
}) {
  const base = `/${repo.fullName}`;
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
  return (
    <>
      <div
        className={`${compact ? 'px-3 py-2 border-bottom' : 'Box-row'} d-flex flex-items-center`}
        style={{ gap: 12 }}
      >
        <RunStatusIcon {...STATE_ICON[data.state!]} size={compact ? 16 : 20} />
        <div>
          <div className="text-bold">{STATE_LABEL[data.state!]}</div>
          <div className="f6 color-fg-muted">
            {detail} check{data.runs.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>
      {data.runs.map((r) => (
        <div
          key={r.id}
          className={`${compact ? 'px-3 py-2 border-bottom' : 'Box-row py-2'} d-flex flex-items-center f6`}
          style={{ gap: 8 }}
        >
          <RunStatusIcon status={r.status} conclusion={r.conclusion} />
          <span className="flex-1" style={{ minWidth: 0 }}>
            <span className="text-bold">{r.name}</span>{' '}
            <span className="color-fg-muted">
              ({r.event === 'pull_request' ? 'pull_request' : 'push'})
              {r.status === 'completed' && r.startedAt
                ? ` · ${r.conclusion === 'success' ? 'Successful' : r.conclusion === 'failure' ? 'Failing' : r.conclusion === 'skipped' ? 'Skipped' : 'Cancelled'} in ${duration(r.startedAt, r.completedAt)}`
                : r.status === 'in_progress'
                  ? ' · In progress'
                  : ' · Queued'}
            </span>
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

/** The checks box on a pull request: one row per workflow run for its head commit. */
export function ChecksBox({
  repo,
  sha,
}: {
  repo: RepoDetail;
  sha: string | null;
}) {
  const q = useCommitRuns(repo, sha);
  const data = q.data;
  if (!data?.state) return null;
  return (
    <div className="Box mb-3">
      <ChecksSummary repo={repo} data={data} />
    </div>
  );
}
