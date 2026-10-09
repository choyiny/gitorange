import { describe, expect, it } from 'vitest';
import { agentOfRepo, groupByDay, trustedAgent } from './commits';

const c = (hash: string, committedAt: number) => ({ hash, committedAt });

describe('groupByDay', () => {
  it('groups neighbours that share a day, in input order', () => {
    const day = (t: number) => (t < 100 ? 'one' : 'two');
    expect(
      groupByDay([c('a', 1), c('b', 2), c('c', 200), c('d', 3)], day)
    ).toEqual([
      { day: 'one', commits: [c('a', 1), c('b', 2)] },
      { day: 'two', commits: [c('c', 200)] },
      { day: 'one', commits: [c('d', 3)] },
    ]);
  });
  it('is empty for no commits', () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe('agentOfRepo', () => {
  const agents = [
    { id: 'u1', username: 'dataagent', name: 'Data' },
    { id: 'u2', username: 'securityagent', name: 'Security' },
  ];
  it('is the agent whose repository this is (<handle>/<handle>)', () => {
    expect(agentOfRepo('dataagent', 'dataagent', agents)?.id).toBe('u1');
    expect(agentOfRepo('DataAgent', 'dataagent', agents)?.id).toBe('u1');
  });
  it('is null for every other repository', () => {
    expect(agentOfRepo('mahmoud', 'dataagent', agents)).toBeNull();
    expect(agentOfRepo('dataagent', 'notes', agents)).toBeNull();
    expect(agentOfRepo('mahmoud', 'mahmoud', agents)).toBeNull();
    expect(agentOfRepo('dataagent', 'dataagent', undefined)).toBeNull();
  });
});

describe('trustedAgent', () => {
  const data = { id: 'u1', username: 'dataagent', name: 'Data' };
  it('trusts an agent address only as that agent, in its own repository', () => {
    expect(trustedAgent('u1@agents.invalid', data)).toBe(data);
    expect(trustedAgent(' U1@Agents.Invalid ', data)).toBe(data);
  });
  it("does not trust another agent's address there", () => {
    expect(trustedAgent('u2@agents.invalid', data)).toBeNull();
  });
  it("does not trust any agent address in a repository that is not an agent's", () => {
    // Anyone who can push can write an agent's address into a commit, and agent ids are public.
    expect(trustedAgent('u1@agents.invalid', null)).toBeNull();
    expect(trustedAgent('u1@agents.invalid', undefined)).toBeNull();
  });
  it('is null for people', () => {
    expect(trustedAgent('u1@example.com', data)).toBeNull();
  });
});
