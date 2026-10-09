import type { HTMLAttributes, ReactNode } from 'react';

/**
 * What a list says when it has nothing: a picture (an icon or an agent's avatar), a short heading, a line of
 * explanation and an optional action. Pass `id` and `tabIndex={-1}` to move focus here after the last item goes.
 */
export function EmptyState({
  title,
  body,
  picture,
  action,
  className,
  ...rest
}: {
  title: ReactNode;
  body?: ReactNode;
  picture?: ReactNode;
  action?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div className={className ? `empty ${className}` : 'empty'} {...rest}>
      {picture}
      <div className="empty-text">
        <p className="empty-h">{title}</p>
        {body && <p className="empty-body">{body}</p>}
      </div>
      {action}
    </div>
  );
}
