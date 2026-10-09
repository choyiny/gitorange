import { describe, expect, it } from 'vitest';
import { agentForEmail, groupByDay } from './commits';

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

describe('agentForEmail', () => {
  const agents = [
    { id: 'u1', username: 'dataagent', name: 'Data' },
    { id: 'u2', username: 'securityagent', name: 'Security' },
  ];
  it('finds the agent whose account id is in the address', () => {
    expect(agentForEmail('u2@agents.invalid', agents)?.username).toBe(
      'securityagent'
    );
  });
  it('is null for people and for unknown agents', () => {
    expect(agentForEmail('u2@example.com', agents)).toBeNull();
    expect(agentForEmail('u9@agents.invalid', agents)).toBeNull();
    expect(agentForEmail('u2@agents.invalid', undefined)).toBeNull();
  });
});
