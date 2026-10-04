import { Link } from 'react-router-dom';
import type { Commit, CommitIdentity } from '@/lib/uiApi';
import { Avatar } from './Avatar';

/**
 * A commit's author like GitHub shows it: a member (matched by their account email or a verified
 * alternate) gets their avatar and username, linked to their profile; anyone else is the plain git
 * name. A different committer is credited too ("X authored and Y committed").
 */
export function CommitAuthor({
  commit,
  size = 20,
  className = 'text-bold',
  showCommitter = true,
}: {
  commit: Pick<Commit, 'author' | 'committer'>;
  size?: number;
  className?: string;
  /** Off where no "committed …" text follows, e.g. the latest-commit bar. */
  showCommitter?: boolean;
}) {
  const { author, committer } = commit;
  const sameCommitter = author.user
    ? committer.user?.id === author.user.id
    : committer.email.toLowerCase() === author.email.toLowerCase();
  return (
    <>
      <Avatar
        user={author.user ?? { username: author.name }}
        size={size}
        className="flex-shrink-0"
      />
      <Identity who={author} className={className} />
      {showCommitter && !sameCommitter && (
        <span className="color-fg-muted no-wrap">
          authored and <Identity who={committer} className={className} />
        </span>
      )}
    </>
  );
}

function Identity({
  who,
  className,
}: {
  who: CommitIdentity;
  className: string;
}) {
  if (!who.user)
    return (
      <span
        className={`${className} color-fg-default no-wrap`}
        title={who.email}
      >
        {who.name}
      </span>
    );
  return (
    <Link
      to={`/${who.user.username}`}
      className={`${className} color-fg-default no-wrap`}
      title={`${who.name} <${who.email}>`}
    >
      {who.user.username}
    </Link>
  );
}
