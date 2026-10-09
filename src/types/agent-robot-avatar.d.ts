// JSX typing for the `agent-robot-avatar` custom element (registered by `import 'agent-robot-avatar'` in
// src/main.tsx). Attribute values are strings, as on any custom element.
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

type AgentRobotAvatarAttributes = DetailedHTMLProps<
  HTMLAttributes<HTMLElement>,
  HTMLElement
> & {
  size?: number | string;
  color?: string;
  'auto-sleep'?: number | string;
  'wake-on'?: 'activity' | 'interaction' | 'manual';
  motion?: 'auto' | 'reduce' | 'full';
  'press-squeeze'?: 'true' | 'false';
  'antenna-drag'?: 'true' | 'false';
};

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'agent-robot-avatar': AgentRobotAvatarAttributes;
    }
  }
}
