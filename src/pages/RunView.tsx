import { useEffect, useState } from 'react';
import {
  Link,
  useNavigate,
  useOutletContext,
  useParams,
} from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  HomeIcon,
  SyncIcon,
  XIcon,
} from '@primer/octicons-react';
import {
  api,
  qk,
  type RepoDetail,
  type WorkflowJob,
  type WorkflowRun,
  type WorkflowStep,
} from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { duration, shortSha, timeAgo } from '@/lib/format';
import { Spinner } from '@/components/Spinner';
import { RunStatusIcon, runStatusLabel } from '@/components/RunStatusIcon';

/** Re-renders every second while `active`, so running durations tick. */
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function StepLog({
  repo,
  run,
  job,
  step,
}: {
  repo: RepoDetail;
  run: WorkflowRun;
  job: WorkflowJob;
  step: WorkflowStep;
}) {
  const o = repo.owner.username;
  const running = step.status === 'in_progress';
  const q = useQuery({
    queryKey: qk.stepLog(o, repo.name, run.runNumber, job.id, step.number),
    queryFn: () =>
      api.stepLog(o, repo.name, run.runNumber, job.id, step.number),
    refetchInterval: running ? 2000 : false,
    staleTime: step.status === 'completed' ? Infinity : 0,
  });
  if (q.isLoading)
    return <div className="job-log-lines px-4 py-2">Loading log…</div>;
  const lines = (q.data ?? '').replace(/\n$/, '').split('\n');
  if (!q.data)
    return (
      <div className="job-log-lines px-4 py-2" style={{ color: '#8b949e' }}>
        {step.status === 'queued' ? 'Waiting to start…' : 'No output'}
      </div>
    );
  return (
    <div className="job-log-lines py-2 pr-3">
      {lines.map((l, i) => (
        <div
          key={i}
          style={
            /^(Error|##\[error\])/.test(l) ? { color: '#f85149' } : undefined
          }
        >
          <span className="ln">{i + 1}</span>
          {l}
        </div>
      ))}
    </div>
  );
}

function JobLog({
  repo,
  run,
  job,
  now,
}: {
  repo: RepoDetail;
  run: WorkflowRun;
  job: WorkflowJob;
  now: number;
}) {
  // Open the step that is running or failed, like GitHub.
  const focus =
    job.steps.find((s) => s.status === 'in_progress') ??
    job.steps.find((s) => s.conclusion === 'failure');
  const [open, setOpen] = useState<Set<number>>(
    () => new Set(focus ? [focus.number] : [])
  );
  useEffect(() => {
    if (focus) setOpen((prev) => new Set(prev).add(focus.number));
  }, [focus?.number]);
  const toggle = (n: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  return (
    <div className="job-log">
      <div
        className="px-4 py-3 d-flex flex-items-center"
        style={{ gap: 8, borderBottom: '1px solid #30363d' }}
      >
        <div className="flex-1">
          <div className="text-bold f4" style={{ color: '#e6edf3' }}>
            {job.name}
          </div>
          <div className="f6" style={{ color: '#8b949e' }}>
            {job.status === 'completed'
              ? `${runStatusLabel(job.status, job.conclusion).toLowerCase()} ${job.completedAt ? timeAgo(job.completedAt) : ''} in ${duration(job.startedAt, job.completedAt)}`
              : job.status === 'in_progress'
                ? `started ${job.startedAt ? timeAgo(job.startedAt) : ''}`
                : 'Waiting for a runner'}
          </div>
        </div>
      </div>
      <div className="py-2">
        {job.steps.map((s) => (
          <details
            key={s.number}
            className="job-log-step"
            open={open.has(s.number)}
          >
            <summary
              className="px-3 py-1 d-flex flex-items-center f6"
              style={{ gap: 8 }}
              onClick={(e) => {
                e.preventDefault();
                toggle(s.number);
              }}
            >
              <span style={{ color: '#8b949e' }}>
                {open.has(s.number) ? (
                  <ChevronDownIcon />
                ) : (
                  <ChevronRightIcon />
                )}
              </span>
              <RunStatusIcon status={s.status} conclusion={s.conclusion} />
              <span className="flex-1">{s.name}</span>
              <span style={{ color: '#8b949e' }}>
                {s.status !== 'queued' && s.conclusion !== 'skipped'
                  ? duration(s.startedAt, s.completedAt, now)
                  : ''}
              </span>
            </summary>
            {open.has(s.number) && (
              <StepLog repo={repo} run={run} job={job} step={s} />
            )}
          </details>
        ))}
      </div>
    </div>
  );
}

export default function RunView() {
  const repo = useOutletContext<RepoDetail>();
  const { number = '', jobId } = useParams();
  const num = Number(number);
  const o = repo.owner.username;
  const base = `/${repo.fullName}`;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: qk.run(o, repo.name, num),
    queryFn: () => api.run(o, repo.name, num),
    refetchInterval: (query) =>
      query.state.data?.run.status === 'completed' ? false : 2000,
  });
  const running = q.data ? q.data.run.status !== 'completed' : false;
  const now = useNow(running);

  const cancel = useMutation({
    mutationFn: () => api.cancelRun(o, repo.name, num),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.run(o, repo.name, num) }),
    onError: (e) => setError(errorMessage(e)),
  });
  const rerun = useMutation({
    mutationFn: () => api.rerun(o, repo.name, num),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['repo', o, repo.name, 'runs'] });
      navigate(`${base}/actions/runs/${r.runNumber}`);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (q.error)
    return (
      <div className="container-xl px-3 px-md-4 px-lg-5">
        <div className="flash flash-error">{errorMessage(q.error)}</div>
      </div>
    );
  if (!q.data) return <Spinner />;
  const { run, jobs } = q.data;
  const job = jobs.find((j) => j.id === jobId);

  return (
    <div className="container-xl px-3 px-md-4 px-lg-5 pb-6">
      <Link
        to={`${base}/actions`}
        className="f6 color-fg-muted d-inline-flex flex-items-center mb-2"
        style={{ gap: 4 }}
      >
        <ArrowLeftIcon size={14} /> {run.name}
      </Link>
      <div
        className="d-flex flex-items-center flex-wrap mb-3 pb-3 border-bottom"
        style={{ gap: 8 }}
      >
        <RunStatusIcon
          status={run.status}
          conclusion={run.conclusion}
          size={24}
        />
        <h1 className="f2 text-normal flex-1" style={{ minWidth: 0 }}>
          {run.displayTitle}{' '}
          <span className="color-fg-muted">#{run.runNumber}</span>
        </h1>
        {repo.permissions.write &&
          (run.status === 'completed' ? (
            <button
              className="btn btn-sm"
              disabled={rerun.isPending}
              onClick={() => rerun.mutate()}
            >
              <SyncIcon /> Re-run all jobs
            </button>
          ) : (
            <button
              className="btn btn-sm btn-danger"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              <XIcon /> Cancel workflow
            </button>
          ))}
      </div>
      {error && <div className="flash flash-error mb-3">{error}</div>}

      <div className="d-flex flex-column flex-md-row" style={{ gap: 24 }}>
        <nav className="col-md-3" style={{ minWidth: 220 }}>
          <Link
            to={`${base}/actions/runs/${run.runNumber}`}
            className={`d-flex flex-items-center rounded-2 px-2 py-1 color-fg-default ${!job ? 'color-bg-subtle text-bold' : ''}`}
            style={{ gap: 8 }}
          >
            <HomeIcon /> Summary
          </Link>
          {jobs.length > 0 && (
            <div className="f6 color-fg-muted text-bold px-2 mt-3 mb-1">
              Jobs
            </div>
          )}
          {jobs.map((j) => (
            <Link
              key={j.id}
              to={`${base}/actions/runs/${run.runNumber}/job/${j.id}`}
              className={`d-flex flex-items-center rounded-2 px-2 py-1 color-fg-default ${job?.id === j.id ? 'color-bg-subtle text-bold' : ''}`}
              style={{ gap: 8 }}
            >
              <RunStatusIcon status={j.status} conclusion={j.conclusion} />
              <span className="css-truncate css-truncate-target">{j.name}</span>
            </Link>
          ))}
        </nav>

        <div className="flex-1" style={{ minWidth: 0 }}>
          {job ? (
            <JobLog key={job.id} repo={repo} run={run} job={job} now={now} />
          ) : (
            <>
              <div className="Box mb-3">
                <div className="Box-body d-flex flex-wrap" style={{ gap: 32 }}>
                  <div>
                    <div className="f6 color-fg-muted">
                      Triggered via{' '}
                      {run.event === 'pull_request' ? 'pull request' : 'push'}{' '}
                      {timeAgo(run.createdAt)}
                    </div>
                    <div className="f5 mt-1">
                      <span className="text-bold">
                        {run.actor?.username ?? 'someone'}
                      </span>{' '}
                      {run.event === 'pull_request' ? (
                        <>
                          updated{' '}
                          <Link to={`${base}/pull/${run.pullRequestNumber}`}>
                            #{run.pullRequestNumber}
                          </Link>
                        </>
                      ) : (
                        'pushed'
                      )}{' '}
                      <Link
                        to={`${base}/commit/${run.headSha}`}
                        className="text-mono"
                      >
                        {shortSha(run.headSha)}
                      </Link>
                      {run.event === 'push' && (
                        <>
                          {' '}
                          <span className="Label Label--accent text-mono">
                            {run.refName}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="f6 color-fg-muted">Status</div>
                    <div className="f5 mt-1 text-bold">
                      {runStatusLabel(run.status, run.conclusion)}
                    </div>
                  </div>
                  <div>
                    <div className="f6 color-fg-muted">Total duration</div>
                    <div className="f5 mt-1 text-bold">
                      {run.startedAt
                        ? duration(run.startedAt, run.completedAt, now)
                        : '–'}
                    </div>
                  </div>
                </div>
              </div>
              {run.errorMessage && (
                <div className="flash flash-error mb-3">
                  <pre
                    className="m-0"
                    style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}
                  >
                    {run.errorMessage}
                  </pre>
                </div>
              )}
              {jobs.length > 0 && (
                <div className="Box">
                  <div className="Box-header py-2">
                    <span className="text-bold">
                      {run.workflowPath.split('/').pop()}
                    </span>
                    <div className="f6 color-fg-muted">on: {run.event}</div>
                  </div>
                  <div
                    className="Box-body d-flex flex-wrap"
                    style={{ gap: 12 }}
                  >
                    {jobs.map((j) => (
                      <Link
                        key={j.id}
                        to={`${base}/actions/runs/${run.runNumber}/job/${j.id}`}
                        className="Box d-flex flex-items-center px-3 py-2 color-fg-default"
                        style={{ gap: 8, minWidth: 220 }}
                      >
                        <RunStatusIcon
                          status={j.status}
                          conclusion={j.conclusion}
                        />
                        <span className="flex-1 text-bold f6">{j.name}</span>
                        <span className="f6 color-fg-muted">
                          {j.startedAt && j.conclusion !== 'skipped'
                            ? duration(j.startedAt, j.completedAt, now)
                            : ''}
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
