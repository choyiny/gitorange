import { Link } from 'react-router-dom';
import {
  coAuthors,
  type ParsedMessage,
  type Trailer,
} from '@/lib/commitMessage';

// A finding's id, as a `Dismissed-Finding` trailer carries it: safe to put in a path.
const FINDING_ID = /^[A-Za-z0-9_-]+$/;

function TrailerValue({ t }: { t: Trailer }) {
  if (t.key.toLowerCase() === 'dismissed-finding' && FINDING_ID.test(t.value))
    return (
      <Link to={`/approvals/${t.value}`} title="Open the finding">
        {t.value}
      </Link>
    );
  return <>{t.value}</>;
}

/**
 * A commit's trailers (`Dismissed-Finding: …`, `Co-Authored-By: …`) as a quiet block of their own: they describe
 * the commit, they are not part of what its author wrote.
 */
export function CommitTrailers({ trailers }: { trailers: Trailer[] }) {
  if (!trailers.length) return null;
  return (
    <dl className="trailers" aria-label="Trailers">
      {trailers.map((t, i) => (
        <div key={i}>
          <dt>{t.key}</dt>
          <dd>
            <TrailerValue t={t} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** "with Claude" after an author, from `Co-Authored-By` trailers; nothing without any. */
export function CoAuthored({ trailers }: { trailers: Trailer[] }) {
  const names = coAuthors(trailers).map((c) => c.name);
  if (!names.length) return null;
  return (
    <span className="color-fg-muted">
      {' '}
      with <span className="co-authors">{names.join(', ')}</span>
    </span>
  );
}

/** The rest of a commit message under its subject: the prose, then the trailers. */
export function CommitBody({ message }: { message: ParsedMessage }) {
  return (
    <>
      {message.body && <pre className="commit-body">{message.body}</pre>}
      <CommitTrailers trailers={message.trailers} />
    </>
  );
}
