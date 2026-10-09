import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AgentAvatar } from '@/components/AgentAvatar';
import type { AgentStatus } from '@/lib/agentLook';

/**
 * An agent's profile card: a band in its colour, its 72px robot, name, handle, what it does, a few numbers and a
 * footer. With `to` the whole card is the link to its page; without it the card is a plain box, which can hold
 * buttons (`children`, under the footer).
 */
export function AgentCard({
  to,
  handle,
  color,
  name,
  subtitle,
  bio,
  status,
  stats,
  foot,
  children,
}: {
  to?: string;
  handle: string;
  color: string;
  name: string;
  /** Under the name: `@handle` for an account, "Built in" for Clef and Fixer. */
  subtitle: ReactNode;
  bio: ReactNode;
  status: AgentStatus;
  stats?: { value: string; label: string }[];
  foot?: ReactNode;
  children?: ReactNode;
}) {
  const inner = (
    <>
      <div className="acard-band" />
      <div className="acard-ava">
        <AgentAvatar handle={handle} color={color} status={status} size={72} />
      </div>
      <div className="acard-body">
        <span className="acard-name">{name}</span>
        <span className="mono muted small acard-handle">{subtitle}</span>
        <span className="acard-bio">{bio}</span>
        {stats && stats.length > 0 && (
          <span className="acard-stats">
            {stats.map((s) => (
              <span key={s.label}>
                <b>{s.value}</b> {s.label}
              </span>
            ))}
          </span>
        )}
        {foot && <span className="acard-foot">{foot}</span>}
        {children}
      </div>
    </>
  );
  const style = { '--agent': color } as CSSProperties;
  return to ? (
    <Link className="acard" to={to} style={style}>
      {inner}
    </Link>
  ) : (
    <div className="acard" style={style}>
      {inner}
    </div>
  );
}
