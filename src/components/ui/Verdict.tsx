import type { CSSProperties } from 'react';
import {
  agentColor,
  agentState,
  STATE_LOOK,
  type AgentStatus,
} from '@/lib/agentLook';
import { STATE_ICON } from './Chip';

/** An agent's verdict in dense developer views: coloured dot (identity), name, then the state in words. */
export function Verdict({
  handle,
  name,
  color,
  status,
  title,
}: {
  handle: string;
  name: string;
  color?: string | null;
  status: AgentStatus;
  /** Extra detail for the tooltip, e.g. how likely Clef thought the change concerned it. */
  title?: string;
}) {
  const state = agentState(status);
  const { label, tone } = STATE_LOOK[state];
  const StateIcon = STATE_ICON[state];
  return (
    <span
      className={`verdict ${tone}`}
      style={{ '--agent': agentColor(handle, color) } as CSSProperties}
      title={title ? `${name}: ${label}. ${title}` : `${name}: ${label}`}
    >
      <i aria-hidden="true" />
      {name}
      <span className="v-state">
        <StateIcon size={12} />
        {label}
      </span>
    </span>
  );
}
