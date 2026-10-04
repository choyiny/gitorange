import { Link } from 'react-router-dom';
import { GitCommitIcon } from '@primer/octicons-react';
import { useState } from 'react';
import type { Commit, CommitRuns, RepoDetail } from '@/lib/uiApi';
import {
  dayLabel,
  firstLine,
  restOfMessage,
  shortSha,
  timeAgo,
} from '@/lib/format';
import { Avatar } from './Avatar';
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
  const rest = restOfMessage(c.message);
  return (
    <li className="Box-row d-flex flex-items-start" style={{ gap: 12 }}>
      <div className="flex-1" style={{ minWidth: 0 }}>
        <div className="d-flex flex-items-center" style={{ gap: 6 }}>
          <Link
            to={`${base}/commit/${c.hash}`}
            className="text-bold color-fg-default f5 text-truncate"
          >
            {firstLine(c.message)}
          </Link>
          {repo && <ChecksBadge repo={repo} checks={checks} />}
          {rest && (
            <button
              className="ellipsis-expander"
              onClick={() => setExpanded(!expanded)}
              aria-label="Show description"
            >
              …
            </button>
          )}
        </div>
        {expanded && (
          <pre
            className="f6 color-fg-muted mt-2"
            style={{ whiteSpace: 'pre-wrap' }}
          >
            {rest}
          </pre>
        )}
        <div
          className="f6 color-fg-muted mt-1 d-flex flex-items-center flex-wrap"
          style={{ columnGap: 6, rowGap: 2 }}
        >
          <Avatar user={{ username: c.author.name }} size={16} />
          <span className="text-bold color-fg-default no-wrap">
            {c.author.name}
          </span>
          <span className="no-wrap">committed {timeAgo(c.committedAt)}</span>
        </div>
      </div>
      <div className="BtnGroup d-flex">
        <Link
          to={`${base}/commit/${c.hash}`}
          className="btn btn-sm BtnGroup-item text-mono-sm"
        >
          {shortSha(c.hash)}
        </Link>
        <CopyButton
          text={c.hash}
          className="btn btn-sm BtnGroup-item"
          label="Copy full SHA"
        />
      </div>
    </li>
  );
}

/** Commits grouped by day, newest-first input is preserved within each group. */
export function CommitList({
  commits,
  base,
  repo,
}: {
  commits: Commit[];
  base: string;
  /** Pass it to show each commit's checks (one request for the whole list). */
  repo?: RepoDetail;
}) {
  const statuses = useCommitStatuses(
    repo,
    commits.map((c) => c.hash)
  );
  const groups: { day: string; commits: Commit[] }[] = [];
  for (const c of commits) {
    const day = dayLabel(c.committedAt);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.commits.push(c);
    else groups.push({ day, commits: [c] });
  }
  return (
    <div>
      {groups.map((g) => (
        <div key={g.day} className="mb-4">
          <h3
            className="f5 text-normal color-fg-muted d-flex flex-items-center mb-2"
            style={{ gap: 8 }}
          >
            <GitCommitIcon /> Commits on {g.day}
          </h3>
          <ul className="Box">
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
        </div>
      ))}
    </div>
  );
}
