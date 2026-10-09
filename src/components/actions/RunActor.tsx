import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qk, type AgentRun } from '@/lib/uiApi';
import { agentColor } from '@/lib/agentLook';
import { runActor } from '@/lib/agentRuns';

/** An agent as an agent run shows it. */
export interface ActorLook {
  handle: string;
  name: string;
  color: string;
  builtin: boolean;
  /** Where its profile or the crew page is. */
  href: string;
}

const BUILTIN_NAME: Record<string, string> = { clef: 'Clef', fixer: 'Fixer' };

/**
 * Names and colours of the reviewer agents (`/api/agents`), so a run can show the agent in its own colour. The
 * directory loads once and is shared with the rest of the app; unknown handles (a deleted agent) fall back to their
 * handle and a stable colour.
 */
export function useAgentDirectory() {
  const q = useQuery({
    queryKey: qk.agents,
    queryFn: api.agents,
    staleTime: 60_000,
  });
  const agents = q.data;
  return useCallback(
    (handle: string): { name: string; color: string } => {
      const found = agents?.find(
        (a) => a.username.toLowerCase() === handle.toLowerCase()
      );
      return {
        name: found?.name ?? handle,
        // Sent since crew redesign B1; typed in uiApi by C0.
        color: agentColor(
          handle,
          (found as { color?: string | null } | undefined)?.color
        ),
      };
    },
    [agents]
  );
}

export type AgentDirectory = ReturnType<typeof useAgentDirectory>;

/** The agent that did a run's work, with its name and colour; null when the run names none. */
export function resolveActor(
  run: Pick<AgentRun, 'kind' | 'title'>,
  lookup: AgentDirectory
): ActorLook | null {
  const actor = runActor(run);
  if (!actor) return null;
  if (actor.builtin)
    return {
      handle: actor.handle,
      name: BUILTIN_NAME[actor.id],
      color: agentColor(actor.handle),
      builtin: true,
      href: '/agents',
    };
  const known = lookup(actor.handle);
  return {
    handle: actor.handle,
    name: known.name,
    color: known.color,
    builtin: false,
    href: `/${actor.handle}`,
  };
}
