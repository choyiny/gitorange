import { describe, expect, it } from 'vitest';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  type TestEnv,
} from './helpers/app';
import { newAgent } from './helpers/agents';

async function setup() {
  const t = makeEnv();
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'internal' },
  });
  await newAgent(t, admin, 'secagent', 'Security Agent');
  return { t, admin };
}

const invite = (
  t: TestEnv,
  cookie: string,
  handle: string,
  repo = 'octocat/app'
) => call(t, `/api/repos/${repo}/agents/${handle}`, { cookie, method: 'PUT' });
const list = async (t: TestEnv, cookie: string, repo = 'octocat/app') =>
  (await (await call(t, `/api/repos/${repo}/agents`, { cookie })).json()) as {
    username: string;
    name: string;
    invitedAt: string;
  }[];

describe('repository agents', () => {
  it('lets a repository admin invite an agent, once', async () => {
    const { t, admin } = await setup();
    expect((await invite(t, admin, 'secagent')).status).toBe(200);
    expect((await invite(t, admin, 'SecAgent')).status).toBe(200);
    const agents = await list(t, admin);
    expect(agents).toMatchObject([
      { username: 'secagent', name: 'Security Agent' },
    ]);
    expect(agents[0].invitedAt).toEqual(expect.any(String));
  });

  it('lets only repository admins invite or remove; readers can see the list', async () => {
    const { t, admin } = await setup();
    const bob = await addMember(t, admin, 'bob');
    const carol = await addMember(t, admin, 'carol');
    await call(t, '/api/repos/octocat/app/collaborators/bob', {
      cookie: admin,
      method: 'PUT',
    });
    expect((await invite(t, bob, 'secagent')).status).toBe(403);
    expect((await invite(t, carol, 'secagent')).status).toBe(403);
    await invite(t, admin, 'secagent');
    expect(
      (
        await call(t, '/api/repos/octocat/app/agents/secagent', {
          cookie: bob,
          method: 'DELETE',
        })
      ).status
    ).toBe(403);
    expect(await list(t, carol)).toMatchObject([{ username: 'secagent' }]);
  });

  it('hides a private repository’s agents from non-collaborators', async () => {
    const { t, admin } = await setup();
    const bob = await addMember(t, admin, 'bob');
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'secret', visibility: 'private' },
    });
    expect(
      (await call(t, '/api/repos/octocat/secret/agents', { cookie: bob }))
        .status
    ).toBe(404);
  });

  it('hides a private agent repository’s name and config state from those who can’t read it', async () => {
    const { t, admin } = await setup();
    const bob = await addMember(t, admin, 'bob');
    await invite(t, admin, 'secagent');
    const patch = await call(t, '/api/repos/secagent/secagent', {
      cookie: admin,
      method: 'PATCH',
      json: { visibility: 'private' },
    });
    expect(patch.status).toBe(200);
    await t.env.DB.prepare(
      "UPDATE agents SET config_error = 'AGENT.md is missing.'"
    ).run();
    const hidden = { repository: null, configSha: null, configError: null };
    const everyone = async (cookie: string) =>
      (await (await call(t, '/api/agents', { cookie })).json()) as Record<
        string,
        unknown
      >[];
    expect(await everyone(bob)).toMatchObject([
      { username: 'secagent', ...hidden },
    ]);
    expect(await list(t, bob)).toMatchObject([
      { username: 'secagent', ...hidden },
    ]);
    // Site admins (and the agent repository’s collaborators) still see them.
    expect(await everyone(admin)).toMatchObject([
      {
        repository: 'secagent/secagent',
        configSha: expect.any(String),
        configError: 'AGENT.md is missing.',
      },
    ]);
    expect(await list(t, admin)).toMatchObject([
      { repository: 'secagent/secagent', configSha: expect.any(String) },
    ]);
  });

  it('refuses unknown and deleted agents, and people', async () => {
    const { t, admin } = await setup();
    await addMember(t, admin, 'bob');
    expect((await invite(t, admin, 'nobody')).status).toBe(404);
    expect((await invite(t, admin, 'bob')).status).toBe(404);
    await call(t, '/api/admin/agents/secagent', {
      cookie: admin,
      method: 'DELETE',
    });
    expect((await invite(t, admin, 'secagent')).status).toBe(404);
  });

  it('removes an agent from a repository', async () => {
    const { t, admin } = await setup();
    await invite(t, admin, 'secagent');
    const res = await call(t, '/api/repos/octocat/app/agents/secagent', {
      cookie: admin,
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(await list(t, admin)).toEqual([]);
  });

  it('lets the agent’s own repository invite agents, including itself', async () => {
    const { t, admin } = await setup();
    expect(
      (await invite(t, admin, 'secagent', 'secagent/secagent')).status
    ).toBe(200);
    expect(await list(t, admin, 'secagent/secagent')).toMatchObject([
      { username: 'secagent', repository: 'secagent/secagent' },
    ]);
  });

  it('drops invitations with the repository and with the agent', async () => {
    const { t, admin } = await setup();
    await newAgent(t, admin, 'docsagent', 'Docs Agent');
    await invite(t, admin, 'secagent');
    await invite(t, admin, 'docsagent');
    await call(t, '/api/admin/agents/docsagent', {
      cookie: admin,
      method: 'DELETE',
    });
    expect(await list(t, admin)).toMatchObject([{ username: 'secagent' }]);
    await call(t, '/api/repos/octocat/app', {
      cookie: admin,
      method: 'DELETE',
    });
    const n = await t.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM repository_agents'
    ).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});
