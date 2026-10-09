import { agentIdOfEmail } from './commitMessage';
import { dayLabel } from './format';

/** Commits grouped by the day they were committed, neighbours only, in input order. */
export function groupByDay<C extends { committedAt: number }>(
  commits: C[],
  dayOf: (committedAt: number) => string = dayLabel
): { day: string; commits: C[] }[] {
  const groups: { day: string; commits: C[] }[] = [];
  for (const c of commits) {
    const day = dayOf(c.committedAt);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.commits.push(c);
    else groups.push({ day, commits: [c] });
  }
  return groups;
}

/**
 * The agent whose own repository this is: `<handle>/<handle>`, where the server itself commits as the agent (its
 * AGENT.md, learned rules). Null for every other repository.
 */
export function agentOfRepo<A extends { username: string }>(
  owner: string,
  repo: string,
  agents: A[] | undefined
): A | null {
  if (owner.toLowerCase() !== repo.toLowerCase()) return null;
  return (
    agents?.find((a) => a.username.toLowerCase() === owner.toLowerCase()) ??
    null
  );
}

/**
 * Whether a commit identity really is `repoAgent`. An agent's account email (`<id>@agents.invalid`) is only
 * evidence inside that agent's own repository: the server never matches it to a member, because anyone who can push
 * can write it into a commit and agent ids are public. Anywhere else the identity is the plain git name.
 */
export function trustedAgent<A extends { id: string }>(
  email: string,
  repoAgent: A | null | undefined
): A | null {
  if (!repoAgent) return null;
  const id = agentIdOfEmail(email);
  return id && id.toLowerCase() === repoAgent.id.toLowerCase()
    ? repoAgent
    : null;
}
