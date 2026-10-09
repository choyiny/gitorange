import { Link } from 'react-router-dom';
import { GearIcon, PersonIcon, SparkleFillIcon } from '@primer/octicons-react';
import type { AuditEvent } from '@/lib/uiApi';
import {
  auditDetail,
  auditParts,
  type AuditOptions,
  type AuditPart,
} from '@/lib/auditText';
import { timeAgo } from '@/lib/format';
import { Avatar } from '@/components/Avatar';
import { AgentAvatar } from '@/components/AgentAvatar';

/** Who did it, drawn as the log draws them: an agent's robot, a person's identicon, an AI tile or a gear. */
export function AuditActor({
  actor,
  size = 32,
}: {
  actor: AuditEvent['actor'];
  size?: number;
}) {
  if (actor.kind === 'agent' && actor.login)
    return <AgentAvatar handle={actor.login} size={size} />;
  if (actor.kind === 'person' && actor.login)
    return <Avatar user={{ username: actor.login }} size={size} />;
  const icon = size * 0.5;
  return (
    <span
      className={`aud-tile ${actor.kind}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {actor.kind === 'ai' ? (
        <SparkleFillIcon size={icon} />
      ) : actor.kind === 'system' ? (
        <GearIcon size={icon} />
      ) : (
        <PersonIcon size={icon} />
      )}
    </span>
  );
}

function Part({ part }: { part: AuditPart }) {
  if (part.kind === 'who') return <b className="aud-who">{part.text}</b>;
  if (part.kind === 'text') return <>{part.text}</>;
  if (part.to) return <Link to={part.to}>{part.text}</Link>;
  return <span className="mono">{part.text}</span>;
}

/**
 * One event: the actor, one sentence (the repository and pull request linked), a second line for the reason or
 * what changed, and when. Used by Site admin → Audit log and, with `scope: 'repo'`, a repository's own log.
 */
export function AuditRow({
  event,
  options,
}: {
  event: AuditEvent;
  options?: AuditOptions;
}) {
  const detail = auditDetail(event);
  const at = new Date(event.at);
  return (
    <li className="aud-row">
      <AuditActor actor={event.actor} />
      <div className="aud-what">
        <p className="aud-line">
          {auditParts(event, options).map((p, i) => (
            <Part key={i} part={p} />
          ))}
        </p>
        {detail && <p className="aud-detail">{detail}</p>}
      </div>
      <time
        className="when"
        dateTime={at.toISOString()}
        title={at.toLocaleString()}
      >
        {timeAgo(at)}
      </time>
    </li>
  );
}

/** A list of events, newest first. */
export function AuditList({
  events,
  options,
}: {
  events: AuditEvent[];
  options?: AuditOptions;
}) {
  return (
    <ul className="aud-list">
      {events.map((e) => (
        <AuditRow key={e.id} event={e} options={options} />
      ))}
    </ul>
  );
}
