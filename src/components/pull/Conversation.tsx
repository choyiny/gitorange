import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  SparkleFillIcon,
} from '@primer/octicons-react';
import {
  api,
  type Comment,
  type EarlierReview as EarlierReviewRow,
  type PullDetail,
  type PullEvent,
  type RepoDetail,
  type Reviewer,
} from '@/lib/uiApi';
import { useCurrentUser } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { fullDate, timeAgo } from '@/lib/format';
import type { ShownStatus, TimelineItem } from '@/lib/reviewTimeline';
import { Avatar } from '@/components/Avatar';
import { Markdown } from '@/components/Markdown';
import { MarkdownEditor } from '@/components/CommentForm';
import { AgentReview, EarlierReview } from '@/components/ReviewersBox';
import { EventRow, PullEventItem } from '@/components/PullEvents';
import { PanelError } from '@/components/approvals/Panels';
import { PendingButton } from '@/components/ui/PendingButton';

export type Slots = TimelineItem<
  PullEvent,
  Reviewer & { status: ShownStatus },
  EarlierReviewRow & { status: ShownStatus }
>[][];

/** A comment (the description is the first): avatar, who and when, Markdown; yours is tinted. */
function TimelineComment({
  c,
  me,
  label,
}: {
  c: Pick<Comment, 'author' | 'body' | 'createdAt'>;
  me: boolean;
  label?: string;
}) {
  return (
    <div className="pr-entry">
      <Link
        to={`/${c.author.username}`}
        className="pr-entry-ava"
        tabIndex={-1}
        aria-hidden="true"
      >
        <Avatar user={c.author} size={40} />
      </Link>
      <article className={`pr-card${me ? ' mine' : ''}`}>
        <header className="pr-card-head">
          <span className="pr-card-mini">
            <Avatar user={c.author} size={20} />
          </span>
          <Link to={`/${c.author.username}`} className="pr-who">
            {c.author.username}
          </Link>
          <span className="muted">
            commented{' '}
            <time dateTime={c.createdAt} title={fullDate(c.createdAt)}>
              {timeAgo(c.createdAt)}
            </time>
          </span>
          <span className="grow" />
          {label && <span className="chip off">{label}</span>}
        </header>
        <div className="pr-card-body">
          {c.body.trim() ? (
            <Markdown source={c.body} />
          ) : (
            <p className="muted">
              <i>No description provided.</i>
            </p>
          )}
        </div>
      </article>
    </div>
  );
}

/**
 * The conversation: the description, comments, GitOrange's events and each requested agent's review (the head
 * commit's, and earlier commits' greyed) where they happened, how it ended, then the comment box with Close or
 * Reopen.
 */
export function Conversation({
  repo,
  d,
  slots,
  anchored,
  refresh,
}: {
  repo: RepoDetail;
  d: PullDetail;
  slots: Slots;
  /** The head commit review "Review the flags" jumps to. */
  anchored: string | null;
  refresh: () => Promise<unknown>;
}) {
  const me = useCurrentUser()!;
  const pr = d.pull;
  const base = `/${repo.fullName}`;
  const [body, setBody] = useState('');
  const [sending, setSending] = useState<'comment' | 'open' | 'closed' | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const canEdit = d.canMerge || pr.author.id === me.id;
  const slot = (i: number) =>
    slots[i].map((x) =>
      x.kind === 'event' ? (
        <PullEventItem key={x.event.id} e={x.event} repoPath={base} />
      ) : x.kind === 'earlier' ? (
        <EarlierReview
          key={x.review.id}
          repo={repo}
          pull={pr.number}
          r={x.review}
        />
      ) : (
        <AgentReview
          key={x.review.id}
          repo={repo}
          d={d}
          r={x.review}
          anchor={anchored === x.review.id}
          onChange={refresh}
        />
      )
    );
  const send = async (andState?: 'open' | 'closed') => {
    setSending(andState ?? 'comment');
    setError(null);
    try {
      if (body.trim()) {
        await api.comment(repo.owner.username, repo.name, pr.number, body);
        // A failed Close or Reopen must not leave an already posted comment ready to send twice.
        setBody('');
      }
      if (andState)
        await api.updatePull(repo.owner.username, repo.name, pr.number, {
          state: andState,
        });
      setBody('');
      void refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(null);
    }
  };
  return (
    <section className="section" aria-labelledby="pr-conversation">
      <h2 id="pr-conversation">Conversation</h2>
      <div className="pr-timeline">
        <TimelineComment
          c={{ author: pr.author, body: pr.body, createdAt: pr.createdAt }}
          me={pr.author.id === me.id}
          label="Author"
        />
        {d.comments.map((c, i) => (
          <Fragment key={c.id}>
            {/* Events and agent reviews sit in the timeline where they happened. */}
            {slot(i)}
            <TimelineComment
              c={c}
              me={c.author.id === me.id}
              label={c.author.id === pr.author.id ? 'Author' : undefined}
            />
          </Fragment>
        ))}
        {slot(d.comments.length)}
        {pr.state === 'merged' && (
          <EventRow icon={<GitMergeIcon />} tone="merged">
            {pr.mergedBy ? (
              <>
                <Avatar user={pr.mergedBy} size={20} />{' '}
                <b>{pr.mergedBy.username}</b> merged commit{' '}
              </>
            ) : (
              <>
                <SparkleFillIcon /> <b>Auto-merge</b> merged commit{' '}
              </>
            )}
            {pr.mergeCommitSha && (
              <Link to={`${base}/commit/${pr.mergeCommitSha}`} className="mono">
                {pr.mergeCommitSha.slice(0, 7)}
              </Link>
            )}{' '}
            into <code>{pr.baseRef}</code>{' '}
            {pr.mergedAt && (
              <time
                className="muted"
                dateTime={pr.mergedAt}
                title={fullDate(pr.mergedAt)}
              >
                {timeAgo(pr.mergedAt)}
              </time>
            )}
          </EventRow>
        )}
        {pr.state === 'closed' && (
          <EventRow icon={<GitPullRequestClosedIcon />} tone="closed">
            This pull request was closed{' '}
            {pr.closedAt && (
              <time
                className="muted"
                dateTime={pr.closedAt}
                title={fullDate(pr.closedAt)}
              >
                {timeAgo(pr.closedAt)}
              </time>
            )}
          </EventRow>
        )}
      </div>
      <div className="pr-composer">
        <span className="pr-entry-ava" aria-hidden="true">
          <Avatar user={{ username: me.username ?? me.name }} size={40} />
        </span>
        <div className="pr-composer-main">
          <h3 className="pr-subhead">Add a comment</h3>
          <PanelError error={error} />
          <MarkdownEditor
            value={body}
            onChange={setBody}
            placeholder="Use Markdown to format your comment"
          />
          <div className="actions pr-composer-actions">
            {canEdit && pr.state === 'open' && (
              <PendingButton
                pending={sending === 'closed'}
                pendingLabel="Closing…"
                disabled={!!sending}
                onClick={() => send('closed')}
              >
                <GitPullRequestClosedIcon size={14} />
                {body.trim() ? 'Close with comment' : 'Close pull request'}
              </PendingButton>
            )}
            {canEdit && pr.state === 'closed' && d.headBranchExists && (
              <PendingButton
                pending={sending === 'open'}
                pendingLabel="Reopening…"
                disabled={!!sending}
                onClick={() => send('open')}
              >
                Reopen pull request
              </PendingButton>
            )}
            <PendingButton
              className="primary"
              pending={sending === 'comment'}
              pendingLabel="Commenting…"
              disabled={!!sending || !body.trim()}
              onClick={() => send()}
            >
              Comment
            </PendingButton>
          </div>
        </div>
      </div>
    </section>
  );
}
