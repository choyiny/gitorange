import { useState } from 'react';
import { Identicon } from './Identicon';

export function Avatar({
  user,
  size = 20,
  className = '',
  square = false,
}: {
  user: { username: string; image?: string | null };
  size?: number;
  className?: string;
  /** Teams get GitHub's rounded-square organization avatar; people get a circle. */
  square?: boolean;
}) {
  // The URL that failed to load; a later, different URL (a new ?v=<sha>) shows again.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <span
      className={`avatar ${square ? '' : 'avatar-user'} ${className}`}
      style={{
        width: size,
        height: size,
        display: 'inline-block',
        overflow: 'hidden',
        verticalAlign: 'middle',
        flexShrink: 0,
      }}
      title={user.username}
    >
      {user.image && user.image !== failedSrc ? (
        <img
          src={user.image}
          width={size}
          height={size}
          alt={`@${user.username}`}
          onError={() => setFailedSrc(user.image ?? null)}
        />
      ) : (
        <Identicon login={user.username} size={size} />
      )}
    </span>
  );
}
