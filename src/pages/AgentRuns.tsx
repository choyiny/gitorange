import { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  CalendarIcon,
  CpuIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  HubotIcon,
  LightBulbIcon,
  SparkleFillIcon,
  StopwatchIcon,
  SyncIcon,
} from '@primer/octicons-react';
import {
  api,
  qk,
  type AgentRun,
  type AgentRunKind,
  type AgentRunStatus,
  type AgentStep,
  type RepoDetail,
} from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { duration, timeAgo } from '@/lib/format';
import { Spinner } from '@/components/Spinner';
import { RunStatusIcon, runStatusLabel } from '@/components/RunStatusIcon';

export const AGENT_KINDS: {
  kind: AgentRunKind;
  label: string;
  icon: typeof HubotIcon;
}[] = [
  { kind: 'review', label: 'Review', icon: SparkleFillIcon },
  { kind: 'rebase', label: 'Rebase', icon: GitBranchIcon },
  {
    kind: 'conflict_resolution',
    label: 'Conflict resolution (squash-era)',
    icon: GitMergeIcon,
  },
  {
    kind: 'stack_discovery',
    label: 'Stack discovery',
    icon: GitPullRequestIcon,
  },
  { kind: 'sweep', label: 'Sweep', icon: SyncIcon },
  { kind: 'learning', label: 'Learning', icon: LightBulbIcon },
];

export const agentKindLabel = (k: AgentRunKind) =>
  AGENT_KINDS.find((x) => x.kind === k)?.label ?? k;

export const isAgentKind = (k: string | null): k is AgentRunKind =>
  AGENT_KINDS.some((x) => x.kind === k);

/** An agent run's status as the CI glyph's status and conclusion. */
function glyph(status: AgentRunStatus) {
  return status === 'running'
    ? ({ status: 'in_progress', conclusion: null } as const)
    : ({
        status: 'completed',
        conclusion: status === 'succeeded' ? 'success' : 'failure',
      } as const);
}

export function AgentStatusIcon({
  status,
  size,
}: {
  status: AgentRunStatus;
  size?: number;
}) {
  return <RunStatusIcon {...glyph(status)} size={size} />;
}

/** Dollars, with enough places to show fractions of a cent. */
export function formatCost(c: number | null): string {
  if (c === null) return '';
  if (c === 0) return '$0';
  if (c < 0.0001) return '<$0.0001';
  return `$${c.toFixed(c < 0.01 ? 4 : c < 1 ? 3 : 2)}`;
}

const formatTokens = (n: number) => n.toLocaleString('en-US');

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

/** One kind's runs, newest first, a page at a time. */
export function AgentRunList({
  repo,
  kind,
}: {
  repo: RepoDetail;
  kind: AgentRunKind;
}) {
  const o = repo.owner.username;
  const base = `/${repo.fullName}`;
  // Cursors of the pages before this one, for "Newer".
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors[cursors.length - 1] ?? '';
  useEffect(() => setCursors([]), [kind]);
  const q = useQuery({
    queryKey: qk.agentRuns(o, repo.name, kind, cursor),
    queryFn: () =>
      api.agentRuns(o, repo.name, {
        kind,
        cursor: cursor || undefined,
        limit: 25,
      }),
    // Live updates refetch on changes; poll as well while a run is going.
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => r.status === 'running') ? 5000 : false,
  });
  const now = useNow(!!q.data?.runs.some((r) => r.status === 'running'));
  const label = agentKindLabel(kind);

  return (
    <>
      <div className="d-flex flex-items-baseline mb-3" style={{ gap: 8 }}>
        <h2 className="f3 text-normal">{label}</h2>
        <span className="f6 color-fg-muted">Agent runs</span>
      </div>
      {q.error ? (
        <div className="flash flash-error">{errorMessage(q.error)}</div>
      ) : !q.data ? (
        <Spinner />
      ) : !q.data.runs.length && !cursor ? (
        <div className="blankslate Box">
          <HubotIcon size={24} className="color-fg-muted mb-2" />
          <h3 className="blankslate-heading">
            No {label.toLowerCase()} runs yet
          </h3>
          <p>
            Each time GitOrange's AI works on this repository, the run shows
            here with its steps, models, tokens, and decisions.
          </p>
        </div>
      ) : (
        <>
          <div className="Box">
            <div className="Box-header py-2">
              <span className="text-bold f6">{label} runs</span>
            </div>
            {q.data.runs.map((run) => (
              <AgentRunRow key={run.id} repo={repo} run={run} now={now} />
            ))}
          </div>
          {(cursors.length > 0 || q.data.nextCursor) && (
            <nav className="paginate-container" aria-label="Pagination">
              <div className="pagination">
                {cursors.length > 0 ? (
                  <button
                    className="previous_page btn-link"
                    onClick={() => setCursors((c) => c.slice(0, -1))}
                  >
                    Newer
                  </button>
                ) : (
                  <span className="previous_page" aria-disabled="true">
                    Newer
                  </span>
                )}
                {q.data.nextCursor ? (
                  <button
                    className="next_page btn-link"
                    onClick={() =>
                      setCursors((c) => [...c, q.data!.nextCursor!])
                    }
                  >
                    Older
                  </button>
                ) : (
                  <span className="next_page" aria-disabled="true">
                    Older
                  </span>
                )}
              </div>
            </nav>
          )}
        </>
      )}
      <p className="f6 color-fg-muted mt-3">
        Costs are estimates at Cloudflare list prices. Prompts, diffs, and model
        output are not kept; only metadata and short decisions.{' '}
        <Link to={`${base}/actions`}>Back to workflows</Link>
      </p>
    </>
  );
}

function AgentRunRow({
  repo,
  run,
  now,
}: {
  repo: RepoDetail;
  run: AgentRun;
  now: number;
}) {
  const base = `/${repo.fullName}`;
  return (
    <div
      className="Box-row Box-row--hover-gray d-flex flex-items-start"
      style={{ gap: 12 }}
    >
      <span className="pt-1">
        <AgentStatusIcon status={run.status} />
      </span>
      <div className="flex-1" style={{ minWidth: 0 }}>
        <Link
          to={`${base}/actions/agent/${encodeURIComponent(run.id)}`}
          className="Link--primary text-bold f5 color-fg-default"
        >
          {run.title}
        </Link>
        <div className="f6 color-fg-muted mt-1">
          <span className="text-bold">{agentKindLabel(run.kind)}</span>
          {run.pullRequest && <>: {run.pullRequest.title}</>}
          {run.error && <span className="color-fg-danger"> · {run.error}</span>}
        </div>
      </div>
      <div className="d-none d-md-block" style={{ width: 80 }}>
        {run.pullRequest && (
          <Link
            to={`${base}/pull/${run.pullRequest.number}`}
            className="Label Label--accent text-mono"
          >
            #{run.pullRequest.number}
          </Link>
        )}
      </div>
      <div
        className="f6 color-fg-muted d-flex flex-column"
        style={{ gap: 4, width: 120 }}
      >
        <span className="d-inline-flex flex-items-center" style={{ gap: 4 }}>
          <CalendarIcon size={14} /> {timeAgo(run.startedAt)}
        </span>
        <span className="d-inline-flex flex-items-center" style={{ gap: 4 }}>
          <StopwatchIcon size={14} />{' '}
          {duration(run.startedAt, run.finishedAt, now)}
        </span>
      </div>
    </div>
  );
}

function StepRow({ step, now }: { step: AgentStep; now: number }) {
  const tokens =
    step.tokensIn !== null || step.tokensOut !== null
      ? `${formatTokens(step.tokensIn ?? 0)} in · ${formatTokens(step.tokensOut ?? 0)} out`
      : null;
  return (
    <div className="Box-row">
      <div className="d-flex flex-items-center" style={{ gap: 8 }}>
        <AgentStatusIcon status={step.status} />
        <span className="flex-1 text-bold f6" title={step.name}>
          {step.displayName}
        </span>
        {step.attempts > 1 && (
          <span className="Label Label--attention">
            {step.attempts} attempts
          </span>
        )}
        <span className="f6 color-fg-muted">
          {duration(step.startedAt, step.finishedAt, now)}
        </span>
      </div>
      {(step.model || step.decision || step.error) && (
        <div className="f6 mt-1" style={{ paddingLeft: 24 }}>
          {step.model && (
            <div
              className="color-fg-muted d-flex flex-items-center flex-wrap"
              style={{ columnGap: 12, rowGap: 2 }}
            >
              <span
                className="d-inline-flex flex-items-center"
                style={{ gap: 4 }}
              >
                <CpuIcon size={14} />
                <code>{step.model.replace(/@cf\//g, '')}</code>
              </span>
              {tokens && <span>{tokens}</span>}
              {step.costEstimate !== null && (
                <span title="Estimate at Cloudflare list prices">
                  {formatCost(step.costEstimate)}
                </span>
              )}
            </div>
          )}
          {step.decision && (
            <div className="mt-1" style={{ whiteSpace: 'pre-wrap' }}>
              {step.decision}
            </div>
          )}
          {step.error && (
            <div className="mt-1 color-fg-danger">{step.error}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** One agent run: summary and steps, in the CI run page's layout. */
export default function AgentRunView() {
  const repo = useOutletContext<RepoDetail>();
  const { id = '' } = useParams();
  const o = repo.owner.username;
  const base = `/${repo.fullName}`;
  const q = useQuery({
    queryKey: qk.agentRun(o, repo.name, id),
    queryFn: () => api.agentRun(o, repo.name, id),
    refetchInterval: (query) =>
      query.state.data?.run.status === 'running' ? 3000 : false,
  });
  const running = q.data?.run.status === 'running';
  const now = useNow(running);

  if (q.error)
    return (
      <div className="container-xl px-3 px-md-4 px-lg-5">
        <div className="flash flash-error">{errorMessage(q.error)}</div>
      </div>
    );
  if (!q.data) return <Spinner />;
  const { run, steps } = q.data;
  const listUrl = `${base}/actions?agent=${run.kind}`;
  const models = [
    ...new Set(steps.flatMap((s) => (s.model ? s.model.split(', ') : []))),
  ];

  return (
    <div className="container-xl px-3 px-md-4 px-lg-5 pb-6">
      <Link
        to={listUrl}
        className="f6 color-fg-muted d-inline-flex flex-items-center mb-2"
        style={{ gap: 4 }}
      >
        <ArrowLeftIcon size={14} /> {agentKindLabel(run.kind)}
      </Link>
      <div
        className="d-flex flex-items-center flex-wrap mb-3 pb-3 border-bottom"
        style={{ gap: 8 }}
      >
        <AgentStatusIcon status={run.status} size={24} />
        <h1 className="f2 text-normal flex-1" style={{ minWidth: 0 }}>
          {run.title}
        </h1>
      </div>

      <div className="d-flex flex-column flex-md-row" style={{ gap: 24 }}>
        <nav className="col-md-3" style={{ minWidth: 220 }}>
          <div className="f6 color-fg-muted text-bold px-2 mb-1">Agent</div>
          {AGENT_KINDS.map(({ kind, label, icon: Icon }) => (
            <Link
              key={kind}
              to={`${base}/actions?agent=${kind}`}
              className={`d-flex flex-items-center rounded-2 px-2 py-1 color-fg-default ${kind === run.kind ? 'color-bg-subtle text-bold' : ''}`}
              style={{ gap: 8 }}
            >
              <Icon className="color-fg-muted" /> {label}
            </Link>
          ))}
        </nav>

        <div className="flex-1" style={{ minWidth: 0 }}>
          <div className="Box mb-3">
            <div className="Box-body d-flex flex-wrap" style={{ gap: 32 }}>
              <div>
                <div className="f6 color-fg-muted">
                  Started {timeAgo(run.startedAt)}
                </div>
                <div className="f5 mt-1">
                  {run.pullRequest ? (
                    <Link to={`${base}/pull/${run.pullRequest.number}`}>
                      #{run.pullRequest.number} {run.pullRequest.title}
                    </Link>
                  ) : (
                    agentKindLabel(run.kind)
                  )}
                </div>
              </div>
              <div>
                <div className="f6 color-fg-muted">Status</div>
                <div className="f5 mt-1 text-bold">
                  {runStatusLabel(
                    glyph(run.status).status,
                    glyph(run.status).conclusion
                  )}
                </div>
              </div>
              <div>
                <div className="f6 color-fg-muted">Total duration</div>
                <div className="f5 mt-1 text-bold">
                  {duration(run.startedAt, run.finishedAt, now)}
                </div>
              </div>
              <div>
                <div className="f6 color-fg-muted">Tokens</div>
                <div className="f5 mt-1 text-bold">
                  {formatTokens(run.tokensIn)} in ·{' '}
                  {formatTokens(run.tokensOut)} out
                </div>
              </div>
              <div>
                <div className="f6 color-fg-muted">Estimated cost</div>
                <div className="f5 mt-1 text-bold">
                  {run.costEstimate === null
                    ? '–'
                    : formatCost(run.costEstimate)}
                </div>
              </div>
            </div>
            {models.length > 0 && (
              <div className="Box-footer f6 color-fg-muted">
                Models:{' '}
                {models.map((m, i) => (
                  <span key={m}>
                    {i > 0 && ', '}
                    <code>{m.replace(/^@cf\//, '')}</code>
                  </span>
                ))}
              </div>
            )}
          </div>
          {run.error && (
            <div className="flash flash-error mb-3">{run.error}</div>
          )}
          <div className="Box">
            <div className="Box-header py-2">
              <span className="text-bold">Steps</span>
              <div className="f6 color-fg-muted">
                Workflow instance <code>{run.id}</code>
              </div>
            </div>
            {steps.length ? (
              steps.map((s) => <StepRow key={s.id} step={s} now={now} />)
            ) : (
              <div className="Box-row color-fg-muted f6">
                {running ? 'Starting…' : 'No steps were recorded.'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
