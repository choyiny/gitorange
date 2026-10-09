import { Link } from 'react-router-dom';
import { CodeIcon, GitCommitIcon } from '@primer/octicons-react';
import { useMemo, useState } from 'react';
import type { Commit, CommitRuns, RepoDetail } from '@/lib/uiApi';
import { shortSha, timeAgo } from '@/lib/format';
import { parseCommitMessage } from '@/lib/commitMessage';
import { groupByDay } from '@/lib/commits';
import { CommitAuthor } from './CommitAuthor';
import { CoAuthored, CommitBody } from './CommitBody';
import { CopyButton } from './CopyButton';
import { ChecksBadge, useCommitStatuses } from './Checks';

function CommitRow({
  c,
  base,
  repo,
  checks,
}: {
  c: Commit;
  base: string;
  repo?: RepoDetail;
  checks?: CommitRuns;
}) {
  const [expanded, setExpanded] = useState(false);
  const message = useMemo(() => parseCommitMessage(c.message), [c.message]);
  const more = !!message.body || message.trailers.length > 0;
  return (
    <li>
      <div className="cl-main">
        <div className="cl-top">
          <Link to={`${base}/commit/${c.hash}`} className="cl-subj">
            {message.subject}
          </Link>
          {repo && <ChecksBadge repo={repo} checks={checks} />}
          {more && (
            <button
              type="button"
              className="ellipsis-expander"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
              aria-label={
                expanded
                  ? 'Hide the rest of the message'
                  : 'Show the rest of the message'
              }
            >
              …
            </button>
          )}
        </div>
        {expanded && <CommitBody message={message} />}
        <p className="cl-by small muted">
          <CommitAuthor commit={c} size={16} />
          <CoAuthored trailers={message.trailers} />
          <span className="no-wrap">committed {timeAgo(c.committedAt)}</span>
        </p>
      </div>
      <div className="cl-side">
        <Link
          to={`${base}/commit/${c.hash}`}
          className="shabtn mono"
          title="Open this commit"
        >
          {shortSha(c.hash)}
        </Link>
        <CopyButton
          text={c.hash}
          className="btn small quiet"
          label="Copy full SHA"
        />
        <Link
          to={`${base}/tree/${c.hash}`}
          className="btn small quiet"
          aria-label={`Browse the code at ${shortSha(c.hash)}`}
          title="Browse the code at this commit"
        >
          <CodeIcon />
        </Link>
      </div>
    </li>
  );
}

/** Commits grouped by day, preserving input order. */
export function CommitList({
  commits,
  base,
  repo,
}: {
  commits: Commit[];
  base: string;
  /** Shows each commit's checks (one request for the list). */
  repo?: RepoDetail;
}) {
  const statuses = useCommitStatuses(
    repo,
    commits.map((c) => c.hash)
  );
  return (
    <div className="commit-days">
      {groupByDay(commits).map((g) => (
        <section key={g.day} className="section">
          <h3 className="daylabel">
            <GitCommitIcon /> Commits on {g.day}
          </h3>
          <ul className="commitlist panel">
            {g.commits.map((c) => (
              <CommitRow
                key={c.hash}
                c={c}
                base={base}
                repo={repo}
                checks={statuses.data?.[c.hash]}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
