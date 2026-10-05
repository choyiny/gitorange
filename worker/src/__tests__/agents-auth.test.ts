import { describe, expect, it } from 'vitest';
import { createAuth } from '../auth';
import { handleGitRequest } from '../git-http';
import { handleLfsRequest } from '../lfs-http';
import { hashToken } from '../lib/tokens';
import { bootstrapAdmin, call, makeEnv, type TestEnv } from './helpers/app';
import { agentRepo, newAgent } from './helpers/agents';
import { commitFiles } from './helpers/seed';

async function sessionsOf(t: TestEnv, userId: string) {
  return (await t.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?'
  )
    .bind(userId)
    .first<{ n: number }>())!.n;
}

/** Gives the agent a password behind better-auth's back, so only the session hook stands in the way. */
async function givePassword(t: TestEnv, userId: string) {
  const ctx = await createAuth(t.env).$context;
  await t.env.DB.prepare(
    "INSERT INTO accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?, ?, 'credential', ?, ?, 0, 0)"
  )
    .bind(
      crypto.randomUUID(),
      userId,
      userId,
      await ctx.password.hash('password123')
    )
    .run();
}

async function accountsOf(t: TestEnv, userId: string) {
  return (await t.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?'
  )
    .bind(userId)
    .first<{ n: number }>())!.n;
}

/** Stores a personal access token for the agent, as if one had slipped in. */
async function strayToken(t: TestEnv, userId: string) {
  const token = 'gop_agent_token_that_should_never_exist';
  await t.env.DB.prepare(
    'INSERT INTO personal_access_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, 0)'
  )
    .bind('pat-agent', userId, 'stray', await hashToken(token))
    .run();
  return token;
}

function gitInfoRefs(t: TestEnv, token: string) {
  return handleGitRequest(
    new Request(
      'http://test.local/secagent/secagent.git/info/refs?service=git-upload-pack',
      { headers: { Authorization: `Basic ${btoa(`x:${token}`)}` } }
    ),
    t.env,
    t.ctx
  );
}

describe('agents and the auth layer', () => {
  it('refuses to sign an agent in, even when it has a password', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    // However a credential got there, it must not become a session.
    await givePassword(t, agent.id);
    const res = await call(t, '/api/auth/sign-in/username', {
      json: { username: 'secagent', password: 'password123' },
    });
    expect(res.status).toBe(403);
    expect(await sessionsOf(t, agent.id)).toBe(0);
  });

  it('refuses the email sign-in route too', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    await givePassword(t, agent.id);
    const email = (await t.env.DB.prepare(
      'SELECT email FROM users WHERE id = ?'
    )
      .bind(agent.id)
      .first<{ email: string }>())!.email;
    const res = await call(t, '/api/auth/sign-in/email', {
      json: { email, password: 'password123' },
    });
    expect(res.status).toBe(403);
    expect(await sessionsOf(t, agent.id)).toBe(0);
  });

  it('refuses a deleted agent the same way', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    expect(
      (
        await call(t, '/api/admin/agents/secagent', {
          cookie: admin,
          method: 'DELETE',
        })
      ).status
    ).toBe(200);
    await givePassword(t, agent.id);
    const res = await call(t, '/api/auth/sign-in/username', {
      json: { username: 'secagent', password: 'password123' },
    });
    expect(res.status).toBe(403);
    expect(await sessionsOf(t, agent.id)).toBe(0);
    expect((await gitInfoRefs(t, await strayToken(t, agent.id))).status).toBe(
      401
    );
  });

  it('refuses every session better-auth would create for an agent', async () => {
    // All routes (sign-in, impersonation, email verification, magic links…) create sessions here.
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    const ctx = await createAuth(t.env).$context;
    await expect(ctx.internalAdapter.createSession(agent.id)).rejects.toThrow(
      'Agents can’t sign in.'
    );
    expect(await sessionsOf(t, agent.id)).toBe(0);
  });

  it('refuses to let a site admin impersonate an agent', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    const res = await call(t, '/api/auth/admin/impersonate-user', {
      cookie: admin,
      json: { userId: agent.id },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe(
      'Agents can’t sign in.'
    );
    expect(await sessionsOf(t, agent.id)).toBe(0);
  });

  it('refuses a password a site admin sets for an agent', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    const set = await call(t, '/api/auth/admin/set-user-password', {
      cookie: admin,
      json: { userId: agent.id, newPassword: 'password123' },
    });
    expect(set.status).toBe(403);
    expect(((await set.json()) as { message: string }).message).toBe(
      'Agents can’t have a password.'
    );
    expect(await accountsOf(t, agent.id)).toBe(0);
    const res = await call(t, '/api/auth/sign-in/username', {
      json: { username: 'secagent', password: 'password123' },
    });
    expect(res.ok).toBe(false);
    expect(await sessionsOf(t, agent.id)).toBe(0);
  });

  it('refuses any account better-auth would link to an agent', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    const ctx = await createAuth(t.env).$context;
    await expect(
      ctx.internalAdapter.linkAccount({
        userId: agent.id,
        providerId: 'credential',
        accountId: agent.id,
        password: await ctx.password.hash('password123'),
      })
    ).rejects.toThrow('Agents can’t have a password.');
    expect(await accountsOf(t, agent.id)).toBe(0);
  });

  it('won’t make an agent a site admin', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    const res = await call(t, '/api/auth/admin/set-role', {
      cookie: admin,
      json: { userId: agent.id, role: 'admin' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe(
      'An agent’s role can’t be changed.'
    );
    const viaUpdate = await call(t, '/api/auth/admin/update-user', {
      cookie: admin,
      json: { userId: agent.id, data: { role: 'admin' } },
    });
    expect(viaUpdate.status).toBe(403);
    const row = await t.env.DB.prepare('SELECT role FROM users WHERE id = ?')
      .bind(agent.id)
      .first<{ role: string }>();
    expect(row!.role).toBe('user');
  });

  it('won’t change an agent’s username or email', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    for (const data of [
      { username: 'renamed' },
      { email: 'agent@example.com' },
      { displayUsername: 'Renamed' },
    ]) {
      const res = await call(t, '/api/auth/admin/update-user', {
        cookie: admin,
        json: { userId: agent.id, data },
      });
      expect(res.status, JSON.stringify(data)).toBe(403);
      expect(((await res.json()) as { message: string }).message).toBe(
        'An agent’s username and email can’t be changed.'
      );
    }
    const row = await t.env.DB.prepare(
      'SELECT username, display_username, email FROM users WHERE id = ?'
    )
      .bind(agent.id)
      .first();
    expect(row).toEqual({
      username: 'secagent',
      display_username: 'secagent',
      email: `${agent.id}@agents.invalid`,
    });
  });

  it('won’t remove an agent’s user through better-auth', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    const res = await call(t, '/api/auth/admin/remove-user', {
      cookie: admin,
      json: { userId: agent.id },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe(
      'Delete agents from Site admin → Agents.'
    );
    const left = await t.env.DB.prepare(
      'SELECT (SELECT COUNT(*) FROM users WHERE id = ?1) AS users, (SELECT COUNT(*) FROM agents WHERE user_id = ?1) AS agents'
    )
      .bind(agent.id)
      .first();
    expect(left).toEqual({ users: 1, agents: 1 });
  });

  it('never attributes a commit to an agent by its email', async () => {
    // Anyone with push access could write an agent's `.invalid` address into a commit.
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    const repo = await agentRepo(t);
    const email = `${agent.id}@agents.invalid`;
    await commitFiles(
      repo,
      'main',
      { 'NOTES.md': 'hi' },
      'Impersonate',
      [repo.refs.get('refs/heads/main')!],
      { name: 'Security Agent', email: email.toUpperCase() }
    );
    const res = await call(t, '/api/repos/secagent/secagent/commits?ref=main', {
      cookie: admin,
    });
    const { commits } = (await res.json()) as {
      commits: { author: { email: string; user: unknown } }[];
    };
    expect(commits[0].author).toMatchObject({
      email: email.toUpperCase(),
      user: null,
    });
  });

  it('offers no password reset, magic link or email code', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    const email = `${agent.id}@agents.invalid`;
    const reset = await call(t, '/api/auth/request-password-reset', {
      json: { email, redirectTo: '/reset' },
    });
    expect(reset.ok).toBe(false);
    for (const path of [
      '/api/auth/sign-in/magic-link',
      '/api/auth/email-otp/send-verification-otp',
      '/api/auth/send-verification-email',
    ]) {
      const res = await call(t, path, { json: { email, type: 'sign-in' } });
      expect(res.ok, path).toBe(false);
    }
    const tokens = (await t.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM verifications'
    ).first<{ n: number }>())!.n;
    expect(tokens).toBe(0);
    expect(t.sent).toEqual([]);
  });

  it('won’t invite an agent’s email address', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    const res = await call(t, '/api/invites', {
      cookie: admin,
      json: { email: `${agent.id}@agents.invalid`, role: 'user' },
    });
    expect(res.status).toBe(409);
  });

  it('treats an agent’s personal access token as unknown on the git endpoint', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    const res = await gitInfoRefs(t, await strayToken(t, agent.id));
    expect(res.status).toBe(401);
  });

  it('and on the LFS endpoint', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    const token = await strayToken(t, agent.id);
    const res = await handleLfsRequest(
      new Request(
        'http://test.local/secagent/secagent.git/info/lfs/objects/batch',
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${btoa(`x:${token}`)}`,
            Accept: 'application/vnd.git-lfs+json',
            'Content-Type': 'application/vnd.git-lfs+json',
          },
          body: JSON.stringify({ operation: 'download', objects: [] }),
        }
      ),
      t.env,
      t.ctx
    );
    expect(res.status).toBe(401);
  });

  it('leaves agents out of the member list and refuses them as collaborators', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await newAgent(t, admin);
    const members = (await (
      await call(t, '/api/users', { cookie: admin })
    ).json()) as { username: string }[];
    expect(members.map((m) => m.username)).toEqual(['octocat']);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'internal' },
    });
    const res = await call(t, '/api/repos/octocat/app/collaborators/secagent', {
      cookie: admin,
      method: 'PUT',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        'Agents can’t be collaborators. Invite it under Settings → Agents.',
    });
  });
});
