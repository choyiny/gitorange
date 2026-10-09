import { Link } from 'react-router-dom';
import { PersonIcon } from '@primer/octicons-react';
import { coderOf } from '@/lib/coder';

/**
 * Who opened a pull request: a coding session as a monogram tile and "Claude·s4", or a person's name and "by
 * hand". Both link to their session's page (a pull request opened by hand is its author's session). Never a robot:
 * the robots are the reviewers. Do not put it inside another link; pass `link={false}` there.
 */
export function CoderChip({
  createdVia,
  sessionLabel,
  sessionId,
  base,
  person,
  link = true,
}: {
  createdVia: string | null | undefined;
  sessionLabel: string | null | undefined;
  /** The session's id (`SessionSummary.id`); the chip links to `<base>/session/<id>`. */
  sessionId?: string | null;
  /** The repository's path, `/<owner>/<repo>`. */
  base: string;
  /** The author's name, shown for a pull request opened by hand. */
  person?: string;
  link?: boolean;
}) {
  const coder = coderOf(createdVia, sessionLabel);
  const tile =
    coder.kind === 'person' ? (
      <span className="mono-tile person" aria-hidden="true">
        <PersonIcon size={13} />
      </span>
    ) : (
      <span
        className={`mono-tile${coder.kind === 'claude' ? '' : ' codex'}`}
        aria-hidden="true"
      >
        {coder.mono}
      </span>
    );
  const text =
    coder.kind === 'person' ? (
      <span>
        {person ? `${person} ` : ''}
        <span className="muted">by hand</span>
      </span>
    ) : (
      <span>{coder.label}</span>
    );
  const body = (
    <>
      {tile}
      {text}
    </>
  );
  if (link && sessionId)
    return (
      <Link
        to={`${base}/session/${sessionId}`}
        className="coder coder-link"
        title={coder.title}
      >
        {body}
      </Link>
    );
  return (
    <span className="coder" title={coder.title}>
      {body}
    </span>
  );
}
