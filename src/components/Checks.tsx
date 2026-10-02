import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qk, type CommitRuns, type RepoDetail } from '@/lib/uiApi';
import { duration } from '@/lib/format';
import { RunStatusIcon } from './RunStatusIcon';

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

/** The ✓ / ✗ / spinner next to a commit, linking to its runs. */
export function CommitStatus({ repo, sha }: { repo: RepoDetail; sha: string }) {
  const q = useCommitRuns(repo, sha);
  const state = q.data?.state;
  if (!state) return null;
  const runs = q.data!.runs;
  const base = `/${repo.fullName}`;
  const to =
    runs.length === 1
      ? `${base}/actions/runs/${runs[0].runNumber}`
      : `${base}/actions`;
  return (
    <Link
      to={to}
      className="d-inline-flex flex-items-center"
      title={runs
        .map(
          (r) =>
            `${r.name}: ${r.status === 'completed' ? r.conclusion : r.status.replace('_', ' ')}`
        )
        .join('\n')}
    >
      <RunStatusIcon {...STATE_ICON[state]} size={14} />
    </Link>
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
  const base = `/${repo.fullName}`;
  const failed = data.runs.filter(
    (r) => r.conclusion === 'failure' || r.conclusion === 'cancelled'
  ).length;
  const pending = data.runs.filter((r) => r.status !== 'completed').length;
  const title =
    data.state === 'success'
      ? 'All checks have passed'
      : data.state === 'pending'
        ? "Some checks haven't completed yet"
        : 'Some checks were not successful';
  const detail = [
    failed && `${failed} failing`,
    pending && `${pending} in progress`,
    data.runs.length - failed - pending &&
      `${data.runs.length - failed - pending} successful`,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <div className="Box mb-3">
      <div className="Box-row d-flex flex-items-center" style={{ gap: 12 }}>
        <RunStatusIcon {...STATE_ICON[data.state]} size={20} />
        <div>
          <div className="text-bold">{title}</div>
          <div className="f6 color-fg-muted">
            {detail} check{data.runs.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>
      {data.runs.map((r) => (
        <div
          key={r.id}
          className="Box-row d-flex flex-items-center f6 py-2"
          style={{ gap: 8 }}
        >
          <RunStatusIcon status={r.status} conclusion={r.conclusion} />
          <span className="text-bold">{r.name}</span>
          <span className="color-fg-muted flex-1">
            ({r.event === 'pull_request' ? 'pull_request' : 'push'})
            {r.status === 'completed' && r.startedAt
              ? ` · ${r.conclusion === 'success' ? 'Successful' : r.conclusion === 'failure' ? 'Failing' : 'Cancelled'} in ${duration(r.startedAt, r.completedAt)}`
              : r.status === 'in_progress'
                ? ' · In progress'
                : ' · Queued'}
          </span>
          <Link to={`${base}/actions/runs/${r.runNumber}`}>Details</Link>
        </div>
      ))}
    </div>
  );
}
