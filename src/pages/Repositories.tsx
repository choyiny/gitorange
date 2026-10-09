import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PlusIcon, RepoIcon } from '@primer/octicons-react';
import { useApprovalCount } from '@/lib/approvals';
import {
  BOARD_FILTERS,
  BOARD_SORTS,
  boardRows,
  boardTotals,
  crewActivity,
  filterBoard,
  filterCounts,
  parseBoardParams,
  type BoardFilter,
  type BoardSort,
  type BoardView,
} from '@/lib/board';
import { useAgentList, useRepoStats } from '@/lib/boardQueries';
import { PageHead } from '@/components/ui/PageHead';
import { Section } from '@/components/ui/Section';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadError, Notice } from '@/components/Notice';
import { AgentRow, CodeRow } from '@/components/RepoBoard';

/**
 * Repositories: a status board of everything you can see. Each code repository says what needs a person, what is in
 * flight and what merged, and who reviews it; each reviewer agent's instruction repository says how its reviews are
 * going. The search, filter and sort live in the address, so a refresh or the back button keeps them.
 */
export default function Repositories() {
  const [params, setParams] = useSearchParams();
  const view = parseBoardParams(params);
  // The search box keeps its own text, so typing never waits on the router.
  const [query, setQuery] = useState(view.query);

  const stats = useRepoStats();
  const agents = useAgentList();
  const needYou = useApprovalCount();

  const rows = useMemo(
    () => boardRows(stats.data ?? [], agents.data ?? []),
    [stats.data, agents.data]
  );
  const crew = useMemo(() => crewActivity(rows), [rows]);
  const { filter, sort } = view;
  const shown = useMemo(
    () => filterBoard(rows, { query, filter, sort }),
    [rows, query, filter, sort]
  );
  const counts = useMemo(() => filterCounts(rows, query), [rows, query]);
  const totals = useMemo(() => boardTotals(rows), [rows]);

  const change = (patch: Partial<BoardView>) => {
    const next = { ...view, query, ...patch };
    const sp = new URLSearchParams();
    if (next.query.trim()) sp.set('q', next.query);
    if (next.filter !== 'all') sp.set('filter', next.filter);
    if (next.sort !== 'updated') sp.set('sort', next.sort);
    setParams(sp, { replace: true });
  };

  const code = shown.filter((r) => r.agent === null);
  const agentRows = shown.filter((r) => r.agent !== null);
  const reviews = (handle: string) =>
    rows
      .filter((r) => r.repo.stats.agents.some((a) => a.handle === handle))
      .map((r) => r.repo.fullName);

  const lede =
    'Everything you can see on this instance: your code, and the repositories where each reviewer agent keeps its instructions.';

  return (
    <>
      <PageHead
        icon="repo"
        crumbs={[{ label: 'Repositories' }]}
        title="Repositories"
        lede={lede}
        actions={
          <Link className="btn primary" to="/new">
            <PlusIcon size={14} />
            New repository
          </Link>
        }
      />

      {!stats.data && !stats.isError ? (
        <div
          className="sk-rows"
          role="status"
          aria-busy="true"
          aria-label="Loading repositories"
        >
          <div className="sk sk-row" />
          <div className="sk sk-row tall" />
          <div className="sk sk-row tall" />
        </div>
      ) : !stats.data ? (
        <LoadError
          what="the repositories"
          error={stats.error}
          onRetry={() => stats.refetch()}
        />
      ) : rows.length === 0 ? (
        <section className="panel">
          <EmptyState
            picture={<RepoIcon size={24} />}
            title="No repositories yet"
            body="Repositories created by anyone on this instance, and shared with you, show up here."
            action={
              <Link className="btn primary" to="/new">
                Create repository
              </Link>
            }
          />
        </section>
      ) : (
        <>
          {stats.isError && (
            <Notice
              tone="warn"
              action={
                <button
                  type="button"
                  className="btn small"
                  onClick={() => stats.refetch()}
                >
                  Retry
                </button>
              }
            >
              Could not refresh the numbers. These are from earlier.
            </Notice>
          )}
          <div className="stats board-stats">
            <Link className="stat link" to="/approvals">
              <b>{needYou.data ?? '…'}</b>
              <span>{needYou.data === 1 ? 'needs you' : 'need you'}</span>
            </Link>
            <div className="stat">
              <b>{totals.open}</b>
              <span>open pull requests</span>
            </div>
            <div className="stat">
              <b>{totals.merged7d}</b>
              <span>merged in 7 days</span>
            </div>
            <div className="stat">
              <b>
                {totals.automaticPct === null ? '–' : `${totals.automaticPct}%`}
              </b>
              <span>merged with no merge click</span>
            </div>
            <div className="stat">
              <b>{totals.repositories}</b>
              <span>
                {totals.repositories === 1 ? 'repository' : 'repositories'}
              </span>
            </div>
          </div>

          <div className="board-toolbar">
            <input
              id="repo-q"
              type="search"
              aria-label="Find a repository"
              placeholder="Find a repository…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                change({ query: e.target.value });
              }}
            />
            <span className="board-pills" role="group" aria-label="Filter">
              {BOARD_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="pill"
                  aria-pressed={filter === f.id}
                  onClick={() => change({ filter: f.id as BoardFilter })}
                >
                  {f.label} <span className="count">{counts[f.id]}</span>
                </button>
              ))}
            </span>
            <select
              id="repo-sort"
              aria-label="Sort"
              value={sort}
              onChange={(e) => change({ sort: e.target.value as BoardSort })}
            >
              {BOARD_SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {code.length > 0 && (
            <Section title="Code">
              <ul className="board-list panel">
                {code.map((r) => (
                  <CodeRow key={r.repo.id} row={r} />
                ))}
              </ul>
            </Section>
          )}
          {agentRows.length > 0 && (
            <Section
              title="Reviewer instructions"
              actions={
                <span className="muted small">
                  Each reviewer agent reads its instructions from its own
                  repository. Dismissing one of its requests adds a rule here.
                </span>
              }
            >
              <ul className="board-list panel">
                {agentRows.map((r) => (
                  <AgentRow
                    key={r.repo.id}
                    row={r}
                    status={
                      crew.find((c) => c.handle === r.repo.name)?.status ??
                      'idle'
                    }
                    repos={reviews(r.repo.name)}
                  />
                ))}
              </ul>
            </Section>
          )}
          {code.length === 0 && agentRows.length === 0 && (
            <section className="panel">
              <EmptyState
                title="No repositories match."
                body="Try a different search or filter."
                action={
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      setQuery('');
                      setParams(new URLSearchParams(), { replace: true });
                    }}
                  >
                    Clear search and filters
                  </button>
                }
              />
            </section>
          )}
        </>
      )}
    </>
  );
}
