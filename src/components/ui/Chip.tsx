import type { ReactNode } from 'react';
import {
  AlertIcon,
  BookIcon,
  CheckIcon,
  DotFillIcon,
  EyeIcon,
  MoonIcon,
  SparkleFillIcon,
  SyncIcon,
  XCircleIcon,
  type Icon,
} from '@primer/octicons-react';
import {
  agentState,
  STATE_LOOK,
  type AgentState,
  type AgentStatus,
  type Tone,
} from '@/lib/agentLook';

/** The icon each crew state carries next to its words. */
export const STATE_ICON: Record<AgentState, Icon> = {
  clear: CheckIcon,
  needs: AlertIcon,
  asked: SyncIcon,
  reviewing: EyeIcon,
  running: SparkleFillIcon,
  learned: BookIcon,
  skipped: MoonIcon,
  off: MoonIcon,
  failed: XCircleIcon,
  idle: DotFillIcon,
};

/**
 * A status pill: tinted ground, an icon and words. Give it a `tone` and text, or an agent `status` (its label,
 * tone and icon come from the status; `children` replaces the label).
 */
export function Chip({
  tone,
  status,
  icon,
  children,
  title,
}: {
  tone?: Tone;
  status?: AgentStatus;
  icon?: ReactNode;
  children?: ReactNode;
  title?: string;
}) {
  const state = status ? agentState(status) : null;
  const look = state ? STATE_LOOK[state] : null;
  const StateIcon = state ? STATE_ICON[state] : null;
  const shownTone = tone ?? look?.tone;
  return (
    <span className={shownTone ? `chip ${shownTone}` : 'chip'} title={title}>
      {icon ?? (StateIcon ? <StateIcon size={12} /> : null)}
      {children ?? look?.label}
    </span>
  );
}
