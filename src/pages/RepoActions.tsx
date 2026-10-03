import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarIcon,
  PlayIcon,
  StopwatchIcon,
  WorkflowIcon,
} from '@primer/octicons-react';
import { api, qk, type RepoDetail, type WorkflowRun } from '@/lib/uiApi';
import { duration, shortSha, timeAgo } from '@/lib/format';
import { Spinner } from '@/components/Spinner';
import { CopyButton } from '@/components/CopyButton';
import { RunStatusIcon } from '@/components/RunStatusIcon';

const STARTER = `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npm test
`;

function trigger(run: WorkflowRun) {
  const who = run.actor?.username ?? 'someone';
  if (run.event === 'pull_request')
    return (
      <>
        Pull request #{run.pullRequestNumber} by{' '}
        <span className="text-bold">{who}</span>
      </>
    );
  return (
    <>
      Commit <span className="text-mono">{shortSha(run.headSha)}</span> pushed
      by <span className="text-bold">{who}</span>
    </>
  );
}

export default function RepoActions() {
  const repo = useOutletContext<RepoDetail>();
  const [params, setParams] = useSearchParams();
  const workflow = params.get('workflow') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const o = repo.owner.username;
  const q = useQuery({
    queryKey: qk.runs(o, repo.name, page, workflow),
    queryFn: () => api.runs(o, repo.name, page, workflow || undefined),
    // Poll while anything on the page is still running.
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => r.status !== 'completed')
        ? 3000
        : false,
  });
  const base = `/${repo.fullName}`;
  const data = q.data;
  const current = data?.workflows.find((w) => w.path === workflow);
  const pages = data ? Math.ceil(data.totalCount / 25) : 1;

  return (
    <div
      className="container-xl px-3 px-md-4 px-lg-5 pb-6 d-flex flex-column flex-md-row"
      style={{ gap: 24 }}
    >
      <nav className="col-md-3" style={{ minWidth: 220 }}>
        <h2 className="f4 mb-2">Actions</h2>
        <div className="ActionList">
          <button
            className={`ActionListItem width-full text-left border-0 rounded-2 px-2 py-1 d-flex flex-items-center ${!workflow ? 'color-bg-subtle text-bold' : 'color-bg-default'}`}
            style={{ gap: 8 }}
            onClick={() => setParams({})}
          >
            <WorkflowIcon /> All workflows
          </button>
          {data?.workflows.length ? (
            <div className="f6 color-fg-muted text-bold px-2 mt-3 mb-1">
              Workflows
            </div>
          ) : null}
          {data?.workflows.map((w) => (
            <button
              key={w.path}
              className={`ActionListItem width-full text-left border-0 rounded-2 px-2 py-1 d-flex flex-items-center ${workflow === w.path ? 'color-bg-subtle text-bold' : 'color-bg-default'}`}
              style={{ gap: 8 }}
              onClick={() => setParams({ workflow: w.path })}
              title={w.path}
            >
              <WorkflowIcon className="color-fg-muted" />
              <span className="css-truncate css-truncate-target">{w.name}</span>
            </button>
          ))}
        </div>
      </nav>

      <div className="flex-1" style={{ minWidth: 0 }}>
        <div className="d-flex flex-items-baseline mb-3" style={{ gap: 8 }}>
          <h2 className="f3 text-normal">{current?.name ?? 'All workflows'}</h2>
          {current && (
            <span className="f6 color-fg-muted text-mono">{current.path}</span>
          )}
        </div>
        {!data ? (
          <Spinner />
        ) : !data.configured && data.totalCount === 0 ? (
          <div className="blankslate Box">
            <PlayIcon size={24} className="color-fg-muted mb-2" />
            <h3 className="blankslate-heading">
              Actions isn't set up on this server
            </h3>
            <p>
              A site admin can enable Actions by adding the Actions bindings to
              the deployment. See docs/configuration.md.
            </p>
          </div>
        ) : data.totalCount === 0 ? (
          <div className="Box">
            <div className="Box-body">
              <h3 className="f4 mb-1">Get started with Actions</h3>
              <p className="color-fg-muted mb-3">
                Build and test every push and pull request. Add a workflow file
                like this one at{' '}
                <span className="text-mono">.github/workflows/ci.yml</span>; it
                uses the same syntax as GitHub Actions. Jobs run on Linux with
                Node.js, git, and common build tools preinstalled.
              </p>
              <div className="Box">
                <div className="Box-header d-flex flex-items-center flex-justify-between py-1 px-2">
                  <span className="f6 color-fg-muted text-mono">
                    .github/workflows/ci.yml
                  </span>
                  <CopyButton
                    text={STARTER}
                    label="Copy workflow"
                    className="btn btn-sm btn-invisible"
                  />
                </div>
                <pre className="p-3 f6 text-mono m-0">{STARTER}</pre>
              </div>
              <p className="f6 color-fg-muted mt-3 mb-0">
                Supported today: <span className="text-mono">run</span> steps,{' '}
                <span className="text-mono">actions/checkout</span>,{' '}
                <span className="text-mono">actions/setup-node</span>,{' '}
                <span className="text-mono">needs</span>,{' '}
                <span className="text-mono">if</span>, matrix builds,
                expressions, and step outputs. Use{' '}
                <span className="text-mono">runs-on: gitorange-standard-2</span>{' '}
                (up to <span className="text-mono">standard-4</span>) for a
                bigger machine.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="Box">
              <div className="Box-header py-2">
                <span className="text-bold f6">
                  {data.totalCount} workflow run
                  {data.totalCount === 1 ? '' : 's'}
                </span>
              </div>
              {data.runs.map((run) => (
                <div
                  key={run.id}
                  className="Box-row Box-row--hover-gray d-flex flex-items-start"
                  style={{ gap: 12 }}
                >
                  <span className="pt-1">
                    <RunStatusIcon
                      status={run.status}
                      conclusion={run.conclusion}
                    />
                  </span>
                  <div className="flex-1" style={{ minWidth: 0 }}>
                    <Link
                      to={`${base}/actions/runs/${run.runNumber}`}
                      className="Link--primary text-bold f5 color-fg-default"
                    >
                      {run.displayTitle}
                    </Link>
                    <div className="f6 color-fg-muted mt-1">
                      <span className="text-bold">{run.name}</span> #
                      {run.runNumber}: {trigger(run)}
                    </div>
                  </div>
                  <div className="d-none d-md-block" style={{ width: 160 }}>
                    {run.pullRequestNumber ? (
                      <Link
                        to={`${base}/pull/${run.pullRequestNumber}`}
                        className="Label Label--accent text-mono"
                      >
                        #{run.pullRequestNumber}
                      </Link>
                    ) : (
                      <span className="Label Label--accent text-mono css-truncate css-truncate-target">
                        {run.refName}
                      </span>
                    )}
                  </div>
                  <div
                    className="f6 color-fg-muted d-flex flex-column"
                    style={{ gap: 4, width: 120 }}
                  >
                    <span
                      className="d-inline-flex flex-items-center"
                      style={{ gap: 4 }}
                    >
                      <CalendarIcon size={14} /> {timeAgo(run.createdAt)}
                    </span>
                    {run.startedAt && (
                      <span
                        className="d-inline-flex flex-items-center"
                        style={{ gap: 4 }}
                      >
                        <StopwatchIcon size={14} />{' '}
                        {duration(run.startedAt, run.completedAt)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {pages > 1 && (
              <nav className="paginate-container" aria-label="Pagination">
                <div className="pagination">
                  {page > 1 ? (
                    <button
                      className="previous_page btn-link"
                      onClick={() =>
                        setParams({
                          ...(workflow ? { workflow } : {}),
                          page: String(page - 1),
                        })
                      }
                    >
                      Previous
                    </button>
                  ) : (
                    <span className="previous_page" aria-disabled="true">
                      Previous
                    </span>
                  )}
                  {page < pages ? (
                    <button
                      className="next_page btn-link"
                      onClick={() =>
                        setParams({
                          ...(workflow ? { workflow } : {}),
                          page: String(page + 1),
                        })
                      }
                    >
                      Next
                    </button>
                  ) : (
                    <span className="next_page" aria-disabled="true">
                      Next
                    </span>
                  )}
                </div>
              </nav>
            )}
          </>
        )}
      </div>
    </div>
  );
}
