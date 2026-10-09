import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  CommentIcon,
  GitPullRequestIcon,
  SearchIcon,
} from '@primer/octicons-react';
import { api, qk, type Pull, type RepoDetail } from '@/lib/uiApi';
import { timeAgo } from '@/lib/format';
import { laneChip, sortReviewers } from '@/lib/pullBoard';
import { blocking, reasonText } from '@/lib/pullState';
import {
  filterPulls,
  OPEN_FILTERS,
  paginate,
  PULLS_PAGE_SIZE,
  pullsHref,
  type ListState,
  type PullsParams,
} from '@/lib/pullsView';
import { ChecksBadge, useCommitStatuses } from '@/components/Checks';
import { CoderChip } from '@/components/CoderChip';
import { AiResolutionBadge } from '@/components/PullBadges';
import { ReviewChip } from '@/components/ReviewChip';
import { ReviewerAvatars } from '@/components/ReviewerAvatars';
import { Pager } from '@/components/actions/parts';
import { QueryError, RowsSkeleton } from '@/components/actions/states';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { PrStateIcon } from '@/pages/PrIcons';

/** The filter menu's words; they match the board's lanes. */
const FILTER_LABEL: Record<ListState, string> = {
  open: 'All open',
  closed: 'Closed',
  human_review: 'Needs you',
  agent_followup: 'Being fixed',
  waiting: 'Checking or paused',
  ready: 'Queued',
};

/** What the list says when a state has no pull requests. */
const EMPTY_TEXT: Record<ListState, string> = {
  open: "There aren't any open pull requests.",
  closed: "There aren't any closed pull requests.",
  human_review: 'No pull requests need a person right now.',
  agent_followup: 'No pull requests are being fixed right now.',
  waiting: 'No pull requests are being checked or paused right now.',
  ready: 'No pull requests are queued to merge right now.',
};

function Row({
  pull,
  base,
  repo,
  checks,
}: {
  pull: Pull;
  base: string;
  repo: RepoDetail;
  checks: Parameters<typeof ChecksBadge>[0]['checks'];
}) {
  const open = pull.state === 'open';
  const author = (
    <Link to={`/${pull.author.username}`} className="prow-author">
      {pull.author.username}
    </Link>
  );
  const chip = open ? laneChip(pull.pullState) : null;
  // The first thing holding it, beside the pill. "Paused" already says that merging is.
  const kept = (pull.pullState?.reasons ?? []).filter(
    (r) => !(chip?.label === 'Paused' && r.kind === 'merging_paused')
  );
  const first = kept.find(blocking) ?? kept[0];
  const why = first ? reasonText(first) : null;
  const reasons = pull.pullState?.reasons.map(reasonText).join('; ');
  return (
    <li className="prow">
      <span className="prow-icon">
        <PrStateIcon state={pull.state} />
      </span>
      <div className="prow-main">
        <div className="prow-title">
          <Link to={`${base}/pull/${pull.number}`} className="prow-open">
            {pull.title}
          </Link>
          <ChecksBadge repo={repo} checks={checks} />
          <AiResolutionBadge state={pull.aiResolution} />
        </div>
        <div className="prow-meta">
          <span className="mono">#{pull.number}</span>
          {open && (
            <>
              <span>
                opened {timeAgo(pull.createdAt)} by {author}
              </span>
              {pull.createdVia && (
                <CoderChip
                  createdVia={pull.createdVia}
                  sessionLabel={pull.sessionLabel}
                  sessionId={pull.sessionId}
                  base={base}
                />
              )}
            </>
          )}
          {pull.state === 'merged' && (
            <span>
              by {author} was merged {timeAgo(pull.mergedAt!)}
              {pull.mergedAutomatically ? ' automatically' : ''}
            </span>
          )}
          {pull.state === 'closed' && (
            <span>
              by {author} was closed {timeAgo(pull.closedAt!)}
            </span>
          )}
        </div>
      </div>
      <div className="prow-side">
        {open && (
          <ReviewerAvatars
            reviewers={sortReviewers(pull.reviewers ?? [])}
            size={24}
          />
        )}
        {chip && (
          <span className="prow-state">
            <Chip tone={chip.tone} title={reasons || undefined}>
              {chip.label}
              {reasons && <span className="sr">: {reasons}</span>}
            </Chip>
            {why && <span className="prow-why small muted">{why}</span>}
          </span>
        )}
        {open && <ReviewChip review={pull.review} />}
        {pull.commentCount > 0 && (
          <Link
            to={`${base}/pull/${pull.number}`}
            className="prow-comments muted"
            aria-label={`${pull.commentCount} comment${pull.commentCount === 1 ? '' : 's'}`}
          >
            <CommentIcon size={14} />
            {pull.commentCount}
          </Link>
        )}
      </div>
    </li>
  );
}

/** The list view: open or closed pull requests with counts, a state filter, search and pages. */
export function PullList({
  repo,
  params,
}: {
  repo: RepoDetail;
  params: PullsParams;
}) {
  const o = repo.owner.username;
  const base = `/${repo.fullName}`;
  const navigate = useNavigate();
  const { state, q, page } = params;
  // The closed list can be long, so the server pages it (and searches it); an open list is short and arrives whole.
  const serverPaged = state === 'closed';
  const query = useQuery({
    queryKey: serverPaged
      ? qk.pulls(o, repo.name, state, PULLS_PAGE_SIZE, page, q)
      : qk.pulls(o, repo.name, state),
    queryFn: () =>
      api.pulls(
        o,
        repo.name,
        state,
        serverPaged ? { limit: PULLS_PAGE_SIZE, page, q } : {}
      ),
    // Turning a page or typing keeps the rows on screen until the next ones arrive.
    placeholderData: (previous, previousQuery) =>
      serverPaged && previousQuery?.queryKey[4] === 'closed'
        ? previous
        : undefined,
  });
  const go = (next: Partial<PullsParams>, replace = false) =>
    navigate(pullsHref(base, { ...params, view: 'list', ...next }), {
      replace,
    });
  /** Another page, from the top of it: the panel is the scroller, and it keeps its place across a page. */
  const turn = (to: number) => {
    go({ page: to });
    document.getElementById('main')?.scrollTo({ top: 0 });
  };

  // The box keeps what was typed (spaces included); the address keeps it trimmed. The server's list is searched
  // once typing pauses; the open list is filtered where it is, on every key.
  const [draft, setDraft] = useState(q);
  useEffect(() => {
    setDraft((d) => (d.trim() === q ? d : q));
  }, [q]);
  const typing = useRef<number>();
  useEffect(() => () => window.clearTimeout(typing.current), []);
  const search = (text: string) => {
    setDraft(text);
    window.clearTimeout(typing.current);
    if (serverPaged)
      typing.current = window.setTimeout(
        () => go({ q: text, page: 1 }, true),
        250
      );
    else go({ q: text, page: 1 }, true);
  };

  const all = query.data?.pulls ?? [];
  const paged = serverPaged
    ? {
        items: all,
        page,
        pages: Math.max(
          1,
          Math.ceil((query.data?.total ?? 0) / PULLS_PAGE_SIZE)
        ),
        total: query.data?.total ?? 0,
      }
    : paginate(filterPulls(all, q), page);
  const shown = paged.items;
  // A page past the last one (a stale link, or matches that shrank) goes to the last.
  useEffect(() => {
    if (
      serverPaged &&
      !query.isPlaceholderData &&
      query.data &&
      page > paged.pages
    )
      go({ page: paged.pages }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the numbers change
  }, [serverPaged, query.data, query.isPlaceholderData, page, paged.pages]);
  // Checks for the rows on screen, in one request.
  const statuses = useCommitStatuses(
    repo,
    shown.map((p) => p.headSha)
  );
  const openish = state !== 'closed';
  const filtered = state !== 'open' && state !== 'closed';

  const tab = (to: Partial<PullsParams>, label: string, n?: number) => {
    const current = (to.state ?? 'open') === (openish ? 'open' : 'closed');
    return (
      <Link
        to={pullsHref(base, { view: 'list', ...to })}
        className="pl-tab"
        aria-current={current ? 'page' : undefined}
      >
        {label}
        {n !== undefined && <span className="count">{n}</span>}
      </Link>
    );
  };

  let body;
  if (query.isError && !query.data)
    body = (
      <div className="panel">
        <QueryError
          error={query.error}
          onRetry={() => void query.refetch()}
          title="Pull requests did not load"
        />
      </div>
    );
  else if (!query.data || (serverPaged && page > paged.pages))
    body = <RowsSkeleton />;
  else if (shown.length === 0)
    body = (
      <div className="panel">
        <EmptyState
          picture={<GitPullRequestIcon size={24} />}
          title={q ? `No pull requests match “${q}”` : EMPTY_TEXT[state]}
          body={
            q ? (
              'Try a number, a title, a branch, a person or a session such as Claude·s4.'
            ) : state === 'open' && repo.permissions.write ? (
              <>
                Coding agents and people open pull requests here.{' '}
                <Link to={`${base}/compare`}>Create a pull request</Link> to
                start one by hand.
              </>
            ) : undefined
          }
        />
      </div>
    );
  else
    body = (
      <>
        <ul className="prows panel">
          {paged.items.map((p) => (
            <Row
              key={p.id}
              pull={p}
              base={base}
              repo={repo}
              checks={p.headSha ? statuses.data?.[p.headSha] : undefined}
            />
          ))}
        </ul>
        {paged.pages > 1 && (
          <Pager
            prevLabel="Previous"
            nextLabel="Next"
            onPrev={paged.page > 1 ? () => turn(paged.page - 1) : undefined}
            onNext={
              paged.page < paged.pages ? () => turn(paged.page + 1) : undefined
            }
            note={`Page ${paged.page} of ${paged.pages} · ${paged.total} pull requests`}
          />
        )}
      </>
    );

  return (
    <div className="plist">
      <div className="pl-bar">
        <nav className="pl-tabs" aria-label="Pull request state">
          {tab({}, 'Open', query.data?.openCount)}
          {tab({ state: 'closed' }, 'Closed', query.data?.closedCount)}
        </nav>
        <div className="pl-tools">
          {openish && (
            <select
              className="pl-select"
              aria-label="Filter by state"
              value={filtered ? state : 'open'}
              onChange={(e) =>
                go({ state: e.target.value as ListState, page: 1 })
              }
            >
              <option value="open">{FILTER_LABEL.open}</option>
              {OPEN_FILTERS.map((f) => (
                <option key={f} value={f}>
                  {FILTER_LABEL[f]}
                </option>
              ))}
            </select>
          )}
          <label className="pl-search">
            <SearchIcon size={14} />
            <input
              type="search"
              value={draft}
              placeholder="Search pull requests"
              aria-label="Search pull requests"
              onChange={(e) => search(e.target.value)}
            />
          </label>
        </div>
      </div>
      {body}
    </div>
  );
}
