import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CommentIcon,
  GitPullRequestIcon,
  SearchIcon,
} from '@primer/octicons-react';
import { api, qk, type Pull, type RepoDetail } from '@/lib/uiApi';
import { timeAgo } from '@/lib/format';
import { laneChip, reviewersOf } from '@/lib/pullBoard';
import { blocking, reasonText } from '@/lib/pullState';
import {
  filterPulls,
  OPEN_FILTERS,
  paginate,
  pullsHref,
  type ListState,
  type PullsParams,
} from '@/lib/pullsView';
import { ChecksBadge, useCommitStatuses } from '@/components/Checks';
import { CoderChip } from '@/components/CoderChip';
import { AiResolutionBadge } from '@/components/PullBadges';
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

type Review = NonNullable<Pull['review']>;
const REVIEW: Record<
  Review['state'],
  {
    label: string;
    tone: 'good' | 'warn' | 'serious' | 'critical' | 'info' | 'off';
  }
> = {
  reviewing: { label: 'Reviewing…', tone: 'info' },
  review_required: { label: 'Review required', tone: 'warn' },
  approved: { label: 'Approved', tone: 'good' },
  failed: { label: 'Review failed', tone: 'critical' },
  changes_requested: { label: 'Changes requested', tone: 'serious' },
  needs_approval: { label: 'Needs approval', tone: 'warn' },
};

/** The head commit's review in a word: Reviewing…, Review required (with its flags), Approved, and so on. */
function ReviewChip({ review }: { review: Pull['review'] }) {
  if (!review) return null;
  const { label, tone } = REVIEW[review.state];
  const flags =
    review.state === 'review_required' && review.flags > 0
      ? ` · ${review.flags} flag${review.flags === 1 ? '' : 's'}`
      : '';
  return (
    <Chip tone={tone}>
      {label}
      {flags}
    </Chip>
  );
}

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
          <ReviewerAvatars reviewers={reviewersOf(pull.pullState)} size={24} />
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
  const query = useQuery({
    queryKey: qk.pulls(o, repo.name, state),
    queryFn: () => api.pulls(o, repo.name, state),
  });
  const go = (next: Partial<PullsParams>, replace = false) =>
    navigate(pullsHref(base, { ...params, view: 'list', ...next }), {
      replace,
    });

  // The box keeps what was typed (spaces included); the address keeps it trimmed.
  const [draft, setDraft] = useState(q);
  useEffect(() => {
    setDraft((d) => (d.trim() === q ? d : q));
  }, [q]);

  const all = query.data?.pulls ?? [];
  const shown = filterPulls(all, q);
  const paged = paginate(shown, page);
  // Checks for the rows on screen, in one request.
  const statuses = useCommitStatuses(
    repo,
    paged.items.map((p) => p.headSha)
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
  else if (!query.data) body = <RowsSkeleton />;
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
            onPrev={
              paged.page > 1 ? () => go({ page: paged.page - 1 }) : undefined
            }
            onNext={
              paged.page < paged.pages
                ? () => go({ page: paged.page + 1 })
                : undefined
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
              onChange={(e) => {
                setDraft(e.target.value);
                go({ q: e.target.value, page: 1 }, true);
              }}
            />
          </label>
        </div>
      </div>
      {body}
    </div>
  );
}
