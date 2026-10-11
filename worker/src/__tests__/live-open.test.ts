import { describe, expect, it } from 'vitest';
import { settle } from './helpers/app';
import { connect, crewRepo } from './helpers/crew';

describe('opening a pull request over MCP', () => {
  it('pings the repository and approvals channels', async () => {
    const s = await crewRepo();
    const { access_token } = await connect(s.t, s.admin);
    await s.branch('feature');
    const pings: string[] = [];
    (s.t.env as unknown as { LIVE: unknown }).LIVE = {
      getByName: () => ({
        publish: async (channel: string) => void pings.push(channel),
      }),
    };
    await s.mcp(access_token, 'feature');
    await settle(s.t);
    expect(pings).toContain(`repo:${s.repoId}`);
    expect(pings).toContain('approvals');
  });
});
