import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CommentIcon, SparkleFillIcon } from '@primer/octicons-react';
import {
  api,
  qk,
  type AgentRunKind,
  type PullDetail,
  type QueueTarget,
  type RepoDetail,
} from '@/lib/uiApi';
import { fullDate, timeAgo } from '@/lib/format';
import { fixerAttempts, queueLine, type QueueSpot } from '@/lib/pullPage';
import { runAvatarStatus, runStatusLook } from '@/lib/agentRuns';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AgentRunLink } from '@/components/AgentRunLink';
import { StackSidebar } from '@/components/StackSidebar';
import { QueryError } from '@/components/actions/states';
import { Chip } from '@/components/ui/Chip';
import { Section } from '@/components/ui/Section';

/** Why the change exists: what the person asked for, and the coding session that wrote it. */
export function WhySection({ repo, d }: { repo: RepoDetail; d: PullDetail }) {
  const pr = d.pull;
  const session = `/${repo.fullName}/session/${encodeURIComponent(pr.sessionId)}`;
  const author = pr.author.name || pr.author.username;
  return (
    <Section title="Why this change">
      {pr.request ? (
        <p className="why">
          <SparkleFillIcon />
          <span>
            <b>{author} asked:</b> {pr.request}
          </span>
        </p>
      ) : (
        <p className="why muted">
          <CommentIcon />
          <span>
            {pr.createdVia
              ? `${pr.createdVia} didn’t send the request that started this change. The description below says what it does.`
              : 'Opened by hand, so no coding session sent a request with it. The description below says why.'}
          </span>
        </p>
      )}
      <p className="muted small">
        {pr.createdVia ? (
          <>
            {pr.createdVia}
            {pr.sessionLabel && <> · session {pr.sessionLabel}</>} ·{' '}
            <Link to={session}>Everything in this session</Link>
          </>
        ) : (
          <>
            Written by hand by {author} ·{' '}
            <Link to={session}>Their pull requests opened by hand</Link>
          </>
        )}{' '}
        · opened{' '}
        <time dateTime={pr.createdAt} title={fullDate(pr.createdAt)}>
          {timeAgo(pr.createdAt)}
        </time>
      </p>
    </Section>
  );
}

/**
 * The order it lands in: its place in the merge queue (the pull requests ahead of it on the same target) and how
 * it stacks with other open pull requests.
 */
export function OrderSection({
  repo,
  d,
  spot,
  target,
}: {
  repo: RepoDetail;
  d: PullDetail;
  spot: QueueSpot | null;
  target: QueueTarget | null;
}) {
  const ahead =
    spot && target
      ? target.entries.filter((e) => e.position < spot.entry.position)
      : [];
  const base = `/${repo.fullName}`;
  return (
    <Section title="Order">
      {spot ? (
        <p>{queueLine(spot)}</p>
      ) : (
        <p className="muted">It isn&apos;t in the merge queue yet.</p>
      )}
      {ahead.length > 0 && (
        <ol className="pr-ahead" aria-label="Ahead of it in line">
          {ahead.slice(0, 5).map((e) => (
            <li key={e.number}>
              <span className="mono muted">{e.position}</span>
              <Link to={`${base}/pull/${e.number}`}>
                <span className="mono muted">#{e.number}</span> {e.title}
              </Link>
              <span className="muted small">
                {e.blockers[0] ?? 'Ready to merge'}
              </span>
            </li>
          ))}
          {ahead.length > 5 && (
            <li className="muted small">
              and {ahead.length - 5} more ahead of it
            </li>
          )}
        </ol>
      )}
      {d.stack && (
        <StackSidebar repo={repo} number={d.pull.number} stack={d.stack} />
      )}
    </Section>
  );
}

const SHOWN_FILES = 8;

/**
 * Clef's one-line summary of each changed file (`pr_classifications.files`): what the reviewers were asked from,
 * each path linking to its diff.
 */
export function ClefRead({ repo, d }: { repo: RepoDetail; d: PullDetail }) {
  const [all, setAll] = useState(false);
  const review = d.review;
  if (!review) return null;
  const files = review.files;
  const summarizing = review.status === 'summarizing';
  if (!files.length && !summarizing) return null;
  const shown = all ? files : files.slice(0, SHOWN_FILES);
  const filesHref = `/${repo.fullName}/pull/${d.pull.number}/files`;
  return (
    <Section
      title={
        <>
          <AgentAvatar
            handle="clef"
            status={summarizing ? 'running' : 'idle'}
            size={24}
          />
          What Clef read
        </>
      }
      actions={
        <AgentRunLink
          repo={repo}
          number={d.pull.number}
          kind="review"
          className="small"
        />
      }
    >
      <p className="muted small">
        A one-line summary of each changed file. Clef decides from these which
        reviewers to ask
        {review.summaryModel ? `; ${review.summaryModel} wrote them` : ''}
        {review.durationMs !== null
          ? `, and the review took ${Math.max(1, Math.round(review.durationMs / 1000))} s`
          : ''}
        .
      </p>
      {summarizing && !files.length ? (
        <p className="pr-progress">
          <span className="spinner" aria-hidden="true" /> Summarizing each
          changed file…
        </p>
      ) : (
        <ul className="pr-summaries">
          {shown.map((f) => (
            <li key={f.path}>
              <span className="pr-sum-file">
                <Link
                  className="mono"
                  to={`${filesHref}#diff-${encodeURIComponent(f.path)}`}
                >
                  {f.path}
                </Link>
                <span className="diffstat">
                  <span className="ds-add">+{f.additions}</span>
                  <span className="ds-del">−{f.deletions}</span>
                </span>
              </span>
              <span>{f.summary}</span>
            </li>
          ))}
        </ul>
      )}
      {files.length > SHOWN_FILES && (
        <button
          type="button"
          className="btn quiet small pr-more"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? 'Show fewer' : `Show all ${files.length} files`}
        </button>
      )}
    </Section>
  );
}

/** A pull request's agent runs of one kind, newest first; followed while one runs. */
function usePullRuns(repo: RepoDetail, number: number, kind: AgentRunKind) {
  const o = repo.owner.username;
  return useQuery({
    queryKey: [...qk.pullAgentRun(o, repo.name, number, kind), 'attempts'],
    queryFn: () =>
      api.agentRuns(o, repo.name, { pull: number, kind, limit: 5 }),
    refetchInterval: (q) =>
      q.state.data?.runs.some((r) => r.status === 'running') ? 5000 : false,
  });
}

/**
 * Fixer's attempts: each rebase run (and conflict resolution, from before rebase merging) on this pull request,
 * with how it went and a link to the run. Shown once Fixer has worked on it, or while a rebase is stopped.
 */
export function FixerSection({ repo, d }: { repo: RepoDetail; d: PullDetail }) {
  const num = d.pull.number;
  const rebases = usePullRuns(repo, num, 'rebase');
  const older = usePullRuns(repo, num, 'conflict_resolution');
  const runs = fixerAttempts([rebases.data?.runs, older.data?.runs]);
  const stopped =
    d.rebase?.status === 'conflict' || d.rebase?.status === 'resolving';
  const failed =
    (rebases.isError && !rebases.data) || (older.isError && !older.data);
  if (!runs.length && !stopped && !failed) return null;
  const base = `/${repo.fullName}`;
  const status =
    d.rebase?.status === 'resolving'
      ? 'running'
      : runs[0]
        ? runAvatarStatus(runs[0].status)
        : 'idle';
  return (
    <Section
      title={
        <>
          <AgentAvatar handle="fixer" status={status} size={24} />
          Fixer
        </>
      }
    >
      <p className="muted small">
        Fixer rebases this branch onto {d.rebase?.onto ?? d.pull.baseRef} when
        it falls behind, and combines clashing changes with AI, one commit at a
        time.
      </p>
      {failed && (
        <div className="panel">
          <QueryError
            error={rebases.error ?? older.error}
            title="Fixer’s attempts did not load"
            onRetry={() => {
              void rebases.refetch();
              void older.refetch();
            }}
          />
        </div>
      )}
      {runs.length > 0 ? (
        <ul className="list pr-runs">
          {runs.map((run) => {
            const look = runStatusLook(run.status);
            return (
              <li key={run.id}>
                <Chip
                  tone={look.tone}
                  icon={
                    run.status === 'running' ? (
                      <span className="spinner" aria-hidden="true" />
                    ) : undefined
                  }
                >
                  {look.label}
                </Chip>
                <span className="pr-run-main">
                  <Link
                    to={`${base}/actions/agent/${encodeURIComponent(run.id)}`}
                  >
                    {run.title}
                  </Link>
                  {run.error && (
                    <span className="pr-bad small">{run.error}</span>
                  )}
                </span>
                <time
                  className="when"
                  dateTime={run.startedAt}
                  title={fullDate(run.startedAt)}
                >
                  {timeAgo(run.startedAt)}
                </time>
              </li>
            );
          })}
        </ul>
      ) : (
        stopped &&
        !failed && (
          <p className="muted">
            {d.rebase?.status === 'resolving'
              ? 'Fixer is working on it now.'
              : 'Fixer has no recorded attempt on this pull request.'}
          </p>
        )
      )}
    </Section>
  );
}
