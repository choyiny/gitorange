import { describe, expect, it } from 'vitest';
import { addMember, bootstrapAdmin, call, makeEnv } from './helpers/app';
import { newAgent } from './helpers/agents';
import {
  AGENT_MD,
  agentModels,
  appRepo,
  invitedAgent,
  openPull,
  runReviews,
  startReview,
} from './helpers/reviews';

type Profile = {
  kind: string;
  owner: { username: string; name: string; email: string | null };
  repositories: { fullName: string }[];
  agent: null | {
    bio: string;
    trigger: { ask: string; above: number };
    repository: string | null;
    deletedAt: string | null;
    invitedTo: { fullName: string }[];
    recentReviews: {
      repository: string;
      number: number;
      status: string;
      headSha: string;
    }[];
  };
};

describe('agent profiles', () => {
  it('marks the agent and shows what it reviews and where it is invited (as the viewer sees it)', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const bob = await addMember(t, admin, 'bob');
    const agent = await newAgent(t, admin);
    for (const [name, visibility] of [
      ['app', 'internal'],
      ['secret', 'private'],
    ])
      await call(t, '/api/repos', {
        cookie: admin,
        json: { name, visibility },
      });
    for (const repo of ['app', 'secret'])
      await call(t, `/api/repos/octocat/${repo}/agents/secagent`, {
        cookie: admin,
        method: 'PUT',
      });

    const view = async (cookie: string) =>
      (await (
        await call(t, '/api/namespaces/secagent', { cookie })
      ).json()) as Profile;
    const asBob = await view(bob);
    expect(asBob).toMatchObject({
      kind: 'user',
      owner: { username: 'secagent', name: 'Security Agent', email: null },
      repositories: [{ fullName: 'secagent/secagent' }],
      agent: {
        bio: agent.bio,
        trigger: agent.trigger,
        repository: 'secagent/secagent',
        deletedAt: null,
      },
    });
    expect(asBob.agent!.invitedTo.map((r) => r.fullName)).toEqual([
      'octocat/app',
    ]);
    expect((await view(admin)).agent!.invitedTo.map((r) => r.fullName)).toEqual(
      ['octocat/app', 'octocat/secret']
    );
  });

  it('says when the agent was deleted, and has no agent block for people', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await newAgent(t, admin);
    await call(t, '/api/admin/agents/secagent', {
      cookie: admin,
      method: 'DELETE',
    });
    const agent = (await (
      await call(t, '/api/namespaces/secagent', { cookie: admin })
    ).json()) as Profile;
    expect(agent.agent!.deletedAt).toEqual(expect.any(String));
    const person = (await (
      await call(t, '/api/namespaces/octocat', { cookie: admin })
    ).json()) as Profile;
    expect(person.agent).toBeNull();
    expect(person.owner.email).toBe('octocat@example.com');
  });

  it("lists the agent's recent reviews in repositories the viewer can see", async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    const { head } = await openPull(t, admin, repo, { 'src/b.ts': 'b\n' });
    await startReview(t);
    await runReviews(t, agentModels().models);
    const view = async (cookie: string) =>
      (await (
        await call(t, '/api/namespaces/secagent', { cookie })
      ).json()) as { agent: NonNullable<Profile['agent']> };
    expect((await view(admin)).agent.recentReviews).toMatchObject([
      {
        repository: 'octocat/app',
        number: 1,
        status: 'approved',
        headSha: head,
      },
    ]);
    // Once the repository is private, a member who can't see it sees none of its reviews.
    const bob = await addMember(t, admin, 'bob');
    expect((await view(bob)).agent.recentReviews).toHaveLength(1);
    await t.env.DB.prepare(
      `UPDATE repositories SET visibility = 'private'`
    ).run();
    expect((await view(bob)).agent.recentReviews).toEqual([]);
    expect((await view(admin)).agent.recentReviews).toHaveLength(1);
  });
});
