import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CommentIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  SparkleFillIcon,
} from '@primer/octicons-react';
import { api, qk, type RepoDetail, type SessionSummary } from '@/lib/uiApi';
import { ApiError } from '@/lib/api';
import { coderOf } from '@/lib/coder';
import { fullDate, timeAgo } from '@/lib/format';
import {
  sessionLede,
  sessionName,
  sessionTimeline,
  type SessionEvent,
} from '@/lib/sessionPage';
import { Avatar } from '@/components/Avatar';
import { LoadError } from '@/components/code/LoadError';
import { useEnter } from '@/components/code/useEnter';
import { QueryError, RowsSkeleton } from '@/components/actions/states';
import { EmptyState } from '@/components/ui/EmptyState';
import { Section } from '@/components/ui/Section';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePageHead } from '@/components/ui/PageHead';
import { PullChip } from '@/components/pull/PullChip';

/** The session's monogram tile (a coding agent is never drawn as a reviewer robot), or a person's icon. */
function SessionTile({ s }: { s: SessionSummary }) {
  const coder = coderOf(s.client, s.label);
  if (coder.kind === 'person')
    return <Avatar user={{ username: s.author.login }} size={28} />;
  return (
    <span
      className={`mono-tile ses-tile${coder.kind === 'claude' ? '' : ' codex'}`}
      aria-hidden="true"
    >
      {coder.mono}
    </span>
  );
}

const when = (at: number) =>
  new Date(at).toLocaleString('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

const EVENT_ICON = {
  opened: GitPullRequestIcon,
  merged: GitMergeIcon,
  closed: GitPullRequestClosedIcon,
} as const;

function TimelineRow({ e, base }: { e: SessionEvent; base: string }) {
  const Icon = EVENT_ICON[e.kind];
  const pr = (
    <Link to={`${base}/pull/${e.number}`}>
      <span className="mono muted">#{e.number}</span> {e.title}
    </Link>
  );
  return (
    <li className={`k-${e.kind}`}>
      <time
        className="mono muted small"
        dateTime={new Date(e.at).toISOString()}
        title={fullDate(e.at / 1000)}
      >
        {when(e.at)}
      </time>
      <span className="ses-step-icon" aria-hidden="true">
        <Icon size={13} />
      </span>
      <span className="ses-step">
        {e.kind === 'opened' ? (
          <span>Opened {pr}</span>
        ) : e.kind === 'merged' ? (
          <span>
            Merged {pr}
            {e.automatic
              ? ' automatically, by GitOrange'
              : e.actor
                ? ` (by ${e.actor})`
                : ''}
          </span>
        ) : (
          <span>Closed {pr} without merging</span>
        )}
      </span>
    </li>
  );
}

/** The session's pull requests opening, merging and closing, from the pull request lists. */
function SessionTimeline({ repo, s }: { repo: RepoDetail; s: SessionSummary }) {
  const o = repo.owner.username;
  const open = useQuery({
    queryKey: qk.pulls(o, repo.name, 'open'),
    queryFn: () => api.pulls(o, repo.name, 'open'),
  });
  const closed = useQuery({
    queryKey: qk.pulls(o, repo.name, 'closed'),
    queryFn: () => api.pulls(o, repo.name, 'closed'),
  });
  const failed =
    (open.isError && !open.data) || (closed.isError && !closed.data);
  return (
    <Section title="Timeline">
      {failed ? (
        <div className="panel">
          <QueryError
            error={open.error ?? closed.error}
            title="The timeline did not load"
            onRetry={() => {
              void open.refetch();
              void closed.refetch();
            }}
          />
        </div>
      ) : !open.data || !closed.data ? (
        <RowsSkeleton rows={3} />
      ) : (
        (() => {
          const events = sessionTimeline(
            [...open.data.pulls, ...closed.data.pulls],
            s.id
          );
          return events.length ? (
            <ol className="ses-steps">
              {events.map((e) => (
                <TimelineRow
                  key={`${e.kind}-${e.number}`}
                  e={e}
                  base={`/${repo.fullName}`}
                />
              ))}
            </ol>
          ) : (
            <div className="panel">
              <EmptyState title="Nothing has happened in this session yet" />
            </div>
          );
        })()
      )}
    </Section>
  );
}

/**
 * A coding session (`/:owner/:repo/session/:id`): who it worked for and with which app, what the person asked for,
 * its pull requests and where each stands, and when each opened, merged or closed. Pull requests opened on the web or
 * by `git push` are their author's "by hand" session.
 */
export default function Session() {
  const repo = useOutletContext<RepoDetail>();
  const { id = '' } = useParams();
  const o = repo.owner.username;
  const base = `/${repo.fullName}`;
  const q = useQuery({
    queryKey: qk.session(o, repo.name, id),
    queryFn: () => api.session(o, repo.name, id),
  });
  const s = q.data;
  const missing = q.error instanceof ApiError && q.error.status === 404;
  const name = s ? sessionName(s) : missing ? 'Session not found' : 'Session';
  const entering = useEnter(!!s);
  usePageHead({
    icon: 'pull',
    crumbs: [{ label: 'Pull requests', to: `${base}/pulls` }, { label: name }],
    title: name,
    tab: 'pulls',
  });
  if (missing)
    return (
      <div className="ses-page">
        <div className="panel">
          <EmptyState
            picture={<GitPullRequestIcon size={20} />}
            title="Session not found"
            body="No pull requests in this repository belong to it. It may have been from another repository."
            action={
              <Link to={`${base}/pulls`} className="btn small">
                Back to pull requests
              </Link>
            }
          />
        </div>
      </div>
    );
  if (q.isError && !s)
    return (
      <LoadError
        what="this session"
        error={q.error}
        onRetry={() => void q.refetch()}
        retrying={q.isFetching}
      />
    );
  if (!s) return <Skeleton kind="detail" />;
  const author = s.author.name || s.author.login;
  return (
    <div className={`ses-page ${entering}`}>
      <header className="phead">
        <div className="phead-row">
          <div className="phead-main">
            <h2 className="ph-title ses-title">
              <SessionTile s={s} />
              {name}
            </h2>
            <p className="lede">
              {sessionLede(s)} · last active{' '}
              <time title={fullDate(s.lastActivity / 1000)}>
                {timeAgo(s.lastActivity / 1000)}
              </time>
            </p>
          </div>
        </div>
      </header>
      <div className="cols">
        <div className="col">
          <Section title="Requests">
            {s.requests.length ? (
              <ul className="plain ses-requests">
                {s.requests.map((r) => (
                  <li key={r.number}>
                    <p className="why">
                      <SparkleFillIcon />
                      <span>
                        <b>{author} asked:</b> {r.text}{' '}
                        <Link
                          to={`${base}/pull/${r.number}`}
                          className="mono small"
                        >
                          #{r.number}
                        </Link>
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="why muted">
                <CommentIcon />
                <span>
                  {s.client
                    ? `${s.client} didn’t send the requests that started these pull requests. Their descriptions say what they do.`
                    : 'Pull requests opened by hand carry no request from a coding session. Their descriptions say why.'}
                </span>
              </p>
            )}
          </Section>
          <SessionTimeline repo={repo} s={s} />
        </div>
        <aside className="col side ses-side" aria-label="About this session">
          <section className="panel pad" aria-labelledby="ses-pulls-title">
            <h2 id="ses-pulls-title">Pull requests</h2>
            <ul className="plain ses-pulls">
              {s.pulls.map((p) => (
                <li key={p.number}>
                  <Link to={`${base}/pull/${p.number}`}>
                    <span className="mono muted">#{p.number}</span> {p.title}
                  </Link>
                  <span>
                    <PullChip state={p.state} pullState={p.pullState} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel pad" aria-labelledby="ses-who-title">
            <h2 id="ses-who-title">Who</h2>
            <p className="ses-who">
              <Avatar user={{ username: s.author.login }} size={24} />
              <Link to={`/${s.author.login}`}>{author}</Link>
              {s.author.name && (
                <span className="muted small">@{s.author.login}</span>
              )}
            </p>
            <p className="small">
              {s.client ? (
                <>
                  Opened with <b>{s.client}</b>
                  {s.label && (
                    <>
                      , which named the session <b>{s.label}</b>
                    </>
                  )}
                  .
                </>
              ) : (
                'Opened by hand, on the web or with git push.'
              )}
            </p>
          </section>
          <section className="panel pad">
            <h2>About sessions</h2>
            <p className="small muted">
              A session is the pull requests one app opened for one person, as
              the app reported them over MCP, with what the person asked for.
              Each pull request shows its request under “Why this change”.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
