import { useId, type ReactNode } from 'react';

/** A titled part of a page: an `<h2>` with optional actions on the right, then the content. */
export function Section({
  title,
  actions,
  className,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      className={className ? `section ${className}` : 'section'}
      aria-labelledby={title ? headingId : undefined}
    >
      {(title || actions) && (
        <div className="section-head">
          {title && <h2 id={headingId}>{title}</h2>}
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
