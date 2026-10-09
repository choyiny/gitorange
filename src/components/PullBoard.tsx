import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CheckIcon,
  ClockIcon,
  CommentIcon,
  EyeIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  PauseIcon,
  PersonIcon,
  SyncIcon,
  type Icon,
} from '@primer/octicons-react';
import {
  api,
  qk,
  type CommitRuns,
  type Pull,
  type RepoDetail,
} from '@/lib/uiApi';
import { timeAgo } from '@/lib/format';
import { pullsHref } from '@/lib/pullsView';
import {
  boardLanes,
  laneLabel,
  LANE_ORDER,
  type BoardCard,
  type LaneId,
} from '@/lib/pullBoard';
import { ChecksBadge, useCommitStatuses } from '@/components/Checks';
import { CoderChip } from '@/components/CoderChip';
import { AiResolutionBadge } from '@/components/PullBadges';
import { ReviewChip } from '@/components/ReviewChip';
import { ReviewerAvatars } from '@/components/ReviewerAvatars';
import { QueryError } from '@/components/actions/states';
import { Banner } from '@/components/ui/Banner';
import { EmptyState } from '@/components/ui/EmptyState';

/** How many merges the "Merged recently" lane shows. */
const MERGED_LANE = 5;

const LANE_ICON: Record<LaneId, Icon> = {
  needs: PersonIcon,
  fixing: SyncIcon,
  checking: EyeIcon,
  queued: CheckIcon,
};

type Statuses = Record<string, CommitRuns> | undefined;

function Card({
  card,
  base,
  repo,
  checks,
}: {
  card: BoardCard;
  base: string;
  repo: RepoDetail;
  checks: Statuses;
}) {
  const { pull, blocker } = card;
  const more = blocker.more.length;
  return (
    <article className="prcard">
      <h4 className="prcard-title">
        <Link to={`${base}/pull/${pull.number}`} className="prcard-open">
          <span className="mono muted">#{pull.number}</span> {pull.title}
        </Link>
      </h4>
      <CoderChip
        createdVia={pull.createdVia}
        sessionLabel={pull.sessionLabel}
        sessionId={pull.sessionId}
        base={base}
        person={pull.author.name || pull.author.username}
      />
      <p className="prcard-reason">
        {blocker.text}
        {more > 0 && (
          <>
            {' '}
            <span className="muted" title={blocker.more.join('\n')}>
              +{more} more
            </span>
            <span className="sr">: {blocker.more.join('; ')}</span>
          </>
        )}
      </p>
      {(card.reviewers.length > 0 || pull.review) && (
        <div className="prcard-review">
          <ReviewerAvatars
            reviewers={card.reviewers}
            className="prcard-reviewers"
          />
          <ReviewChip review={pull.review} />
        </div>
      )}
      <div className="prcard-foot">
        {card.eta && (
          <span className="prcard-eta">
            <ClockIcon size={13} />
            {card.eta}
          </span>
        )}
        {card.notes.map((n) => (
          <span key={n}>{n}</span>
        ))}
        <ChecksBadge
          repo={repo}
          checks={pull.headSha ? checks?.[pull.headSha] : undefined}
        />
        <AiResolutionBadge state={pull.aiResolution} />
        <span className="prcard-age">opened {timeAgo(pull.createdAt)}</span>
        {pull.commentCount > 0 && (
          <span
            className="prcard-comments"
            title={`${pull.commentCount} comment${pull.commentCount === 1 ? '' : 's'}`}
          >
            <CommentIcon size={13} />
            {pull.commentCount}
          </span>
        )}
      </div>
    </article>
  );
}

function MergedCard({ pull, base }: { pull: Pull; base: string }) {
  const by = pull.mergedAutomatically
    ? 'automatically'
    : pull.mergedBy
      ? `by ${pull.mergedBy.name || pull.mergedBy.username}`
      : '';
  return (
    <article className="prcard merged">
      <h4 className="prcard-title">
        <Link to={`${base}/pull/${pull.number}`} className="prcard-open">
          <span className="mono muted">#{pull.number}</span> {pull.title}
        </Link>
      </h4>
      <CoderChip
        createdVia={pull.createdVia}
        sessionLabel={pull.sessionLabel}
        sessionId={pull.sessionId}
        base={base}
        person={pull.author.name || pull.author.username}
      />
      <div className="prcard-foot">
        <span className="prcard-eta">
          <GitMergeIcon size={13} />
          Merged {timeAgo(pull.mergedAt!)}
          {by && ` ${by}`}
        </span>
      </div>
    </article>
  );
}

/** Placeholder lanes for the board's first load. */
export function BoardSkeleton() {
  return (
    <div className="lanes" role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="lane">
          <div className="sk sk-line w50" />
          <div className="sk sk-card" />
          {i < 3 && <div className="sk sk-card" />}
        </div>
      ))}
    </div>
  );
}

/** The merged-recently lane: the newest merges as compact cards. */
function MergedLane({
  merged,
  total,
  base,
  query,
}: {
  merged: Pull[];
  /** Every merged pull request there is, for the link to them. */
  total: number;
  base: string;
  query: { isError: boolean; data: unknown; refetch(): unknown };
}) {
  return (
    <section className="lane lane-merged" aria-label="Merged recently">
      <h3>
        <GitMergeIcon size={14} />
        Merged recently
        {/* Not a count pill: it is the newest few, not how many have merged. */}
        {merged.length > 0 && (
          <span className="lane-note">Latest {merged.length}</span>
        )}
      </h3>
      {query.isError ? (
        <p className="muted small" role="status">
          Merged pull requests did not load.{' '}
          <button
            type="button"
            className="btn small quiet"
            onClick={() => void query.refetch()}
          >
            Retry
          </button>
        </p>
      ) : !query.data ? (
        <div className="sk sk-card" aria-busy="true" />
      ) : merged.length ? (
        <ul className="lane-cards">
          {merged.map((p) => (
            <li key={p.id}>
              <MergedCard pull={p} base={base} />
            </li>
          ))}
          {total > merged.length && (
            <li>
              <Link
                to={pullsHref(base, { view: 'list', state: 'closed' })}
                className="lane-all"
              >
                See all {total} merged
              </Link>
            </li>
          )}
        </ul>
      ) : (
        <p className="muted small">Nothing has merged yet.</p>
      )}
    </section>
  );
}

/** Open pull requests in lanes by whose move it is, then the ones that merged lately. */
export function PullBoard({ repo }: { repo: RepoDetail }) {
  const o = repo.owner.username;
  const base = `/${repo.fullName}`;
  const open = useQuery({
    queryKey: qk.pulls(o, repo.name, 'open'),
    queryFn: () => api.pulls(o, repo.name, 'open'),
  });
  // Blockers, landing order and estimates. The board still works from each pull request's own state without it.
  const queue = useQuery({
    queryKey: qk.queue(o, repo.name),
    queryFn: () => api.queue(o, repo.name),
  });
  // Only the newest few merges, newest first: the closed list is as long as the repository's history.
  const merged = useQuery({
    queryKey: qk.pulls(o, repo.name, 'merged', MERGED_LANE),
    queryFn: () => api.pulls(o, repo.name, 'merged', { limit: MERGED_LANE }),
  });
  const pulls = open.data?.pulls;
  const statuses = useCommitStatuses(
    repo,
    (pulls ?? []).map((p) => p.headSha)
  );

  if (open.isError && !pulls)
    return (
      <div className="panel">
        <QueryError
          error={open.error}
          onRetry={() => void open.refetch()}
          title="Pull requests did not load"
        />
      </div>
    );
  if (!pulls) return <BoardSkeleton />;

  const { lanes, paused } = boardLanes(pulls, queue.data ?? []);
  const pause = queue.data?.find((t) => t.paused)?.paused;
  const mergedLane = (
    <MergedLane
      merged={merged.data?.pulls ?? []}
      total={merged.data?.total ?? 0}
      base={base}
      query={merged}
    />
  );

  return (
    <>
      {paused && (
        <Banner
          icon={<PauseIcon size={16} />}
          action={
            <Link to={`${base}/branches`} className="btn small">
              Open Branches
            </Link>
          }
        >
          Merging is paused
          {pause
            ? ` by ${pause.by.name || pause.by.login}, ${timeAgo(new Date(pause.at))}`
            : ''}
          . Nothing lands until it is resumed.
        </Banner>
      )}
      {queue.isError && (
        <p className="prboard-note muted small" role="status">
          Blockers and estimates did not load, so cards say only what each pull
          request reports.{' '}
          <button
            type="button"
            className="btn small quiet"
            onClick={() => void queue.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {pulls.length === 0 ? (
        <>
          <div className="panel">
            <EmptyState
              picture={<GitPullRequestIcon size={24} />}
              title="No open pull requests"
              body="When a coding agent or a person opens one, it shows up here with who is reviewing it and when it should land."
              action={
                repo.permissions.write ? (
                  <Link to={`${base}/compare`} className="btn primary small">
                    New pull request
                  </Link>
                ) : undefined
              }
            />
          </div>
          <div className="lanes single">{mergedLane}</div>
        </>
      ) : (
        <div className="lanes">
          {LANE_ORDER.map((id) => {
            const Glyph = id === 'queued' && paused ? PauseIcon : LANE_ICON[id];
            const cards = lanes[id];
            const label = laneLabel(id, paused);
            return (
              <section
                key={id}
                className={`lane lane-${id}`}
                aria-label={label}
              >
                <h3>
                  <Glyph size={14} />
                  {label}
                  <span
                    className="count"
                    data-zero={cards.length ? undefined : ''}
                  >
                    {cards.length}
                  </span>
                </h3>
                {cards.length ? (
                  <ul className="lane-cards">
                    {cards.map((c) => (
                      <li key={c.pull.id}>
                        <Card
                          card={c}
                          base={base}
                          repo={repo}
                          checks={statuses.data}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted small">None</p>
                )}
              </section>
            );
          })}
          {mergedLane}
        </div>
      )}
    </>
  );
}
