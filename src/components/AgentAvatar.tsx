import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AgentRobotAvatar } from 'agent-robot-avatar';
import {
  agentColor,
  agentRoundness,
  avatarIsLive,
  avatarScript,
  avatarState,
  type AgentStatus,
} from '@/lib/agentLook';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.(REDUCED_MOTION).matches ?? false
  );
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED_MOTION);
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Runs `fn` on the upgraded element once `agent-robot-avatar` is defined. The avatar is decoration only. */
function whenReady(
  el: HTMLElement | null,
  fn: (avatar: AgentRobotAvatar) => void | Promise<void>
) {
  if (!el || !window.customElements) return;
  customElements
    .whenDefined('agent-robot-avatar')
    .then(() => fn(el as AgentRobotAvatar))
    .catch(() => {});
}

/**
 * A reviewer agent's robot in its colour, showing what it is doing. Sizes: 24 rail, 32–40 lists, 56 decision,
 * 72 cards, 168 profile. From 28px it gets a halo; checking, waiting on a person and working add a moving ring;
 * from 40px it follows the pointer. Reduced motion turns off the ring and pointer-follow. The expression changes
 * only when the status changes. Without `label` it is hidden from assistive tech: say the agent's name and status
 * in text next to it.
 */
export function AgentAvatar({
  handle,
  color,
  status = 'idle',
  size = 40,
  label,
}: {
  handle: string;
  /** The colour the agent declares (AGENT.md); otherwise its preset's or a stable palette colour. */
  color?: string | null;
  status?: AgentStatus;
  size?: number;
  label?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const tint = agentColor(handle, color);
  const state = avatarState(status);
  const reduced = useReducedMotion();
  const halo = size >= 28;

  useEffect(() => {
    whenReady(ref.current, (avatar) => {
      avatar.setHeadRoundness(agentRoundness(handle));
      avatar.setPointerFollow(size >= 40 && !reduced);
    });
  }, [handle, size, reduced]);

  useEffect(() => {
    let current = true;
    whenReady(ref.current, async (avatar) => {
      if (!current) return;
      const script = avatarScript(state);
      try {
        avatar.input(false);
        avatar.stopWaiting();
        if (!script.sleep) await avatar.wake();
        if (!current) return;
        if (script.sleep) await avatar.sleep();
        else if (script.hold === 'input') await avatar.input(true);
        else if (script.hold === 'waiting') await avatar.startWaiting();
        else if (script.play) {
          for (const action of script.play) {
            if (!current) return;
            await avatar.play(action);
          }
        } else avatar.reset();
      } catch {
        // Decoration only: a failed animation never affects the page.
      }
    });
    return () => {
      current = false;
    };
  }, [state]);

  const live = halo && avatarIsLive(state);
  return (
    <span
      className={`ava st-${state}${halo ? ' halo' : ''}${live ? ' live' : ''}`}
      style={{ '--agent': tint } as CSSProperties}
      {...(label ? { role: 'img', 'aria-label': label } : {})}
    >
      <agent-robot-avatar
        ref={ref}
        size={size}
        color={tint}
        auto-sleep="0"
        wake-on="manual"
        motion="auto"
        press-squeeze="false"
        antenna-drag="false"
        aria-hidden="true"
        style={{ '--s': `${size}px`, '--c': tint } as CSSProperties}
      />
    </span>
  );
}
