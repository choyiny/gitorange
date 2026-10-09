import { useEffect, useState } from 'react';
import {
  Link,
  useNavigate,
  useOutletContext,
  useParams,
} from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
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
import {
  confirmingCancel,
  focusStep,
  isErrorLine,
  runLabel,
  stepLabel,
} from '@/lib/runs';
import { useNow } from '@/lib/useNow';
import { Identicon } from '@/components/Identicon';
import { RunStatusIcon } from '@/components/RunStatusIcon';
import { PendingButton } from '@/components/ui/PendingButton';
import { Section } from '@/components/ui/Section';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePageHead } from '@/components/ui/PageHead';
import { RunHeader } from '@/components/actions/parts';
import { RunChip } from '@/components/actions/RunChip';
import { QueryError } from '@/components/actions/states';

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
  if (q.isLoading) return <div className="act-log-note">Loading log…</div>;
  if (!q.data)
    return (
      <div className="act-log-note">
        {step.status === 'queued' ? 'Waiting to start…' : 'No output'}
      </div>
    );
  const lines = q.data.replace(/\n$/, '').split('\n');
  return (
    <div className="act-log-lines">
      {lines.map((l, i) => (
        <div key={i} className={isErrorLine(l) ? 'act-line err' : 'act-line'}>
          <span className="act-ln">{i + 1}</span>
          <span>{l}</span>
        </div>
      ))}
    </div>
  );
}

/** A job's state in words: how it ended, where it waits, or when it started. */
function jobState(job: WorkflowJob): string {
  if (job.status === 'completed')
    return `${runLabel(job.status, job.conclusion)}${job.completedAt ? ` ${timeAgo(job.completedAt)}` : ''}${job.startedAt ? ` in ${duration(job.startedAt, job.completedAt)}` : ''}`;
  if (job.queuedAhead !== null) return `Queued (${job.queuedAhead} ahead)`;
  if (job.status === 'in_progress')
    return `Started ${job.startedAt ? timeAgo(job.startedAt) : ''}`;
  return 'Waiting for a runner';
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
  const focus = focusStep(job.steps);
  const [open, setOpen] = useState<Set<number>>(
    () => new Set(focus !== null ? [focus] : [])
  );
  useEffect(() => {
    if (focus !== null) setOpen((prev) => new Set(prev).add(focus));
  }, [focus]);
  const toggle = (n: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  return (
    <section className="act-logbox panel" aria-label={`Log of ${job.name}`}>
      <div className="act-log-head">
        <div>
          <b>{job.name}</b>
          <p className="small muted">{jobState(job)}</p>
        </div>
        <span className="mono small muted" title="Runner">
          {job.runsOn}
        </span>
      </div>
      <div className="act-log">
        {job.steps.length === 0 && (
          <div className="act-log-note">No steps yet</div>
        )}
        {job.steps.map((s) => {
          const isOpen = open.has(s.number);
          return (
            <div key={s.number} className="act-logstep">
              <button
                type="button"
                className="act-logstep-btn"
                aria-expanded={isOpen}
                onClick={() => toggle(s.number)}
              >
                <span className="act-chev">
                  {isOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
                </span>
                <RunStatusIcon status={s.status} conclusion={s.conclusion} />
                <span className="act-logstep-name">{s.name}</span>
                <span className="act-logstep-time">
                  <span className="sr">
                    {stepLabel(s.status, s.conclusion)}.{' '}
                  </span>
                  {s.status !== 'queued' && s.conclusion !== 'skipped'
                    ? duration(s.startedAt, s.completedAt, now)
                    : ''}
                </span>
              </button>
              {isOpen && <StepLog repo={repo} run={run} job={job} step={s} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Summary({
  run,
  jobs,
  base,
  now,
}: {
  run: WorkflowRun;
  jobs: WorkflowJob[];
  base: string;
  now: number;
}) {
  return (
    <>
      <section className="panel pad act-summary">
        <dl className="act-facts act-facts-row">
          <div>
            <dt>
              Triggered via{' '}
              {run.event === 'pull_request' ? 'pull request' : 'push'}{' '}
              {timeAgo(run.createdAt)}
            </dt>
            <dd className="act-actor">
              <Identicon login={run.actor?.username ?? 'someone'} size={18} />
              <b>{run.actor?.username ?? 'someone'}</b>
              {run.event === 'pull_request' ? (
                <>
                  updated{' '}
                  <Link to={`${base}/pull/${run.pullRequestNumber}`}>
                    #{run.pullRequestNumber}
                  </Link>
                </>
              ) : (
                'pushed'
              )}
              <Link to={`${base}/commit/${run.headSha}`} className="mono">
                {shortSha(run.headSha)}
              </Link>
              {run.event === 'push' && (
                <span className="mono act-branch">{run.refName}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <RunChip status={run.status} conclusion={run.conclusion} />
            </dd>
          </div>
          <div>
            <dt>Total duration</dt>
            <dd>
              {run.startedAt
                ? duration(run.startedAt, run.completedAt, now)
                : '–'}
            </dd>
          </div>
        </dl>
      </section>
      {run.errorMessage && (
        <div className="act-error" role="alert">
          <pre>{run.errorMessage}</pre>
        </div>
      )}
      {jobs.length > 0 && (
        <Section
          title={run.workflowPath.split('/').pop()}
          actions={<span className="muted small mono">on: {run.event}</span>}
        >
          <div className="act-jobcards">
            {jobs.map((j) => (
              <Link
                key={j.id}
                to={`${base}/actions/runs/${run.runNumber}/job/${j.id}`}
                className="act-jobcard panel"
              >
                <RunStatusIcon status={j.status} conclusion={j.conclusion} />
                <span className="act-jobcard-name">{j.name}</span>
                <span className="muted small">
                  {j.queuedAhead !== null
                    ? `Queued (${j.queuedAhead} ahead)`
                    : j.startedAt && j.conclusion !== 'skipped'
                      ? duration(j.startedAt, j.completedAt, now)
                      : ''}
                </span>
              </Link>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

/**
 * A run. Keyed by run number: re-running navigates to the next number with the same route, and the "Confirm
 * cancel" step (and any action error) of the run you left must not carry over to the new one.
 */
export default function RunView() {
  const { number = '' } = useParams();
  return <RunPage key={number} />;
}

function RunPage() {
  const repo = useOutletContext<RepoDetail>();
  const { number = '', jobId } = useParams();
  const num = Number(number);
  const o = repo.owner.username;
  const base = `/${repo.fullName}`;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);
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
    onSuccess: () => {
      setConfirmCancel(false);
      return qc.invalidateQueries({ queryKey: qk.run(o, repo.name, num) });
    },
  });
  const rerun = useMutation({
    mutationFn: () => api.rerun(o, repo.name, num),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['repo', o, repo.name, 'runs'] });
      navigate(`${base}/actions/runs/${r.runNumber}`);
    },
  });

  const run = q.data?.run;
  const job = q.data?.jobs.find((j) => j.id === jobId);
  usePageHead({
    icon: 'play',
    crumbs: [
      { label: 'Actions', to: `${base}/actions` },
      ...(job
        ? [
            { label: `Run #${num}`, to: `${base}/actions/runs/${num}` },
            { label: job.name },
          ]
        : [{ label: `Run #${num}` }]),
    ],
    title: job ? job.name : `Run #${num}`,
    tab: 'actions',
    documentTitle: `Run #${num}`,
  });

  if (q.isError && !q.data)
    return (
      <QueryError
        error={q.error}
        onRetry={() => void q.refetch()}
        title="This run did not load"
      />
    );
  if (!q.data || !run) return <Skeleton kind="detail" />;
  const { jobs } = q.data;
  const actionError = rerun.error ?? cancel.error;
  // Only a run that is still going can be cancelled, so the confirm step ends when it does.
  const confirming = confirmingCancel(confirmCancel, run.status);

  return (
    <>
      <RunHeader
        lead={
          <RunStatusIcon
            status={run.status}
            conclusion={run.conclusion}
            size={24}
          />
        }
        title={
          <>
            {run.displayTitle} <span className="muted">#{run.runNumber}</span>
          </>
        }
        lede={
          <>
            {run.name} ·{' '}
            {run.event === 'pull_request' ? (
              <>pull request #{run.pullRequestNumber}</>
            ) : (
              <>
                pushed to <span className="mono">{run.refName}</span>
              </>
            )}{' '}
            · {runLabel(run.status, run.conclusion).toLowerCase()}
            {run.startedAt && (
              <> · {duration(run.startedAt, run.completedAt, now)}</>
            )}
          </>
        }
        actions={
          repo.permissions.write &&
          (run.status === 'completed' ? (
            <PendingButton
              className="small"
              pending={rerun.isPending}
              pendingLabel="Re-running…"
              onClick={() => rerun.mutate()}
            >
              <SyncIcon size={14} /> Re-run all jobs
            </PendingButton>
          ) : confirming ? (
            <>
              <PendingButton
                className="small danger"
                pending={cancel.isPending}
                pendingLabel="Cancelling…"
                onClick={() => cancel.mutate()}
              >
                <XIcon size={14} /> Confirm cancel
              </PendingButton>
              <button
                type="button"
                className="btn small quiet"
                disabled={cancel.isPending}
                onClick={() => setConfirmCancel(false)}
              >
                Keep running
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn small danger"
              onClick={() => setConfirmCancel(true)}
            >
              <XIcon size={14} /> Cancel workflow
            </button>
          ))
        }
      />
      {actionError && (
        <div className="act-error" role="alert">
          {errorMessage(actionError)}
        </div>
      )}
      <div className="act-runlayout">
        <nav className="act-joblist panel" aria-label="Jobs">
          <Link
            to={`${base}/actions/runs/${run.runNumber}`}
            aria-current={!job ? 'page' : undefined}
          >
            <HomeIcon size={16} />
            <span>Summary</span>
          </Link>
          {jobs.length > 0 && <p className="act-joblist-h">Jobs</p>}
          {jobs.map((j) => (
            <Link
              key={j.id}
              to={`${base}/actions/runs/${run.runNumber}/job/${j.id}`}
              aria-current={job?.id === j.id ? 'page' : undefined}
            >
              <RunStatusIcon status={j.status} conclusion={j.conclusion} />
              <span className="act-joblist-name">{j.name}</span>
              <span className="muted small">
                {j.queuedAhead !== null
                  ? `${j.queuedAhead} ahead`
                  : j.startedAt && j.conclusion !== 'skipped'
                    ? duration(j.startedAt, j.completedAt, now)
                    : ''}
              </span>
            </Link>
          ))}
        </nav>
        <div className="act-runmain">
          {job ? (
            <JobLog key={job.id} repo={repo} run={run} job={job} now={now} />
          ) : jobId ? (
            <div className="act-error" role="alert">
              This run has no job with that id.{' '}
              <Link to={`${base}/actions/runs/${run.runNumber}`}>
                Back to the summary
              </Link>
            </div>
          ) : (
            <Summary run={run} jobs={jobs} base={base} now={now} />
          )}
        </div>
      </div>
    </>
  );
}
