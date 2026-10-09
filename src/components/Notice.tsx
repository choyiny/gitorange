import type { ReactNode } from 'react';
import {
  AlertIcon,
  CheckCircleIcon,
  InfoIcon,
  XCircleIcon,
} from '@primer/octicons-react';
import { errorMessage } from '@/lib/api';

export type NoticeTone = 'info' | 'ok' | 'warn' | 'bad';

const ICON = {
  info: InfoIcon,
  ok: CheckCircleIcon,
  warn: AlertIcon,
  bad: XCircleIcon,
};

/**
 * A message inside a page: what just happened (`ok`), what to know (`info`), what to fix (`warn`) or what failed
 * (`bad`, announced at once). For something that changes how a whole repository behaves use `Banner`.
 */
export function Notice({
  tone = 'info',
  icon,
  action,
  children,
  className,
}: {
  tone?: NoticeTone;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const Icon = ICON[tone];
  return (
    <div
      className={`notice ${tone}${className ? ` ${className}` : ''}`}
      role={tone === 'bad' ? 'alert' : 'status'}
    >
      {icon ?? <Icon size={16} />}
      <div className="grow">{children}</div>
      {action}
    </div>
  );
}

/** A query that failed: what could not be loaded, why, and a way to try again. */
export function LoadError({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <Notice
      tone="bad"
      action={
        <button type="button" className="btn small" onClick={onRetry}>
          Retry
        </button>
      }
    >
      Could not load {what}. {errorMessage(error)}
    </Notice>
  );
}
