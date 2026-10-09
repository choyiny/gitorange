import type { ReactNode } from 'react';
import { AlertIcon } from '@primer/octicons-react';

/**
 * A banner across the top of the panel for something that changes how a whole repository behaves (merging
 * paused, an agent's reviews turned off). `warn` is amber, `serious` red; `action` is usually a small button.
 */
export function Banner({
  tone = 'warn',
  icon,
  action,
  children,
}: {
  tone?: 'warn' | 'serious';
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`gbanner ${tone}`} role="alert">
      {icon ?? <AlertIcon size={16} />}
      <span>{children}</span>
      {action}
    </div>
  );
}
