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

/** The agent behind a commit identity's email (`<account id>@agents.invalid`), if the agent list has it. */
export function agentForEmail<A extends { id: string }>(
  email: string,
  agents: A[] | undefined
): A | null {
  const id = agentIdOfEmail(email)?.toLowerCase();
  if (!id || !agents) return null;
  return agents.find((a) => a.id.toLowerCase() === id) ?? null;
}
