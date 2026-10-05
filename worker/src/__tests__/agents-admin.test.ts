import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { createAgent } from '../agents/accounts';
import { schema } from '../db/schema';
import { GitService } from '../git/service';
import type { SessionUser } from '../variables';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  type TestEnv,
} from './helpers/app';
import {
  agentRepo,
  agentRow,
  newAgent,
  type AgentJson,
} from './helpers/agents';

const PNG = [137, 80, 78, 71, 13, 10, 26, 10];

describe('creating an agent', () => {
  it('creates the account, a seeded internal repository and the cached fields', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin, 'SecAgent', 'Security Agent');
    const repo = await agentRepo(t);
    const head = repo.refs.get('refs/heads/main')!;

    expect(agent).toMatchObject({
      username: 'secagent',
      name: 'Security Agent',
      engine: 'pass',
      trigger: { above: 0.5 },
      repository: 'secagent/secagent',
      configSha: head,
      configError: null,
      deletedAt: null,
      image: `/api/agents/secagent/avatar?v=${head}`,
    });
    const row = await agentRow(t);
    expect(row!.user_email).toBe(`${agent.id}@agents.invalid`);
    expect(row!.trigger_ask).toBe(agent.trigger.ask);

    // Seeded by the creator, internal, the creator a collaborator.
    expect(repo.parseCommit(head)).toMatchObject({
      message: 'Create agent @secagent',
      author: { name: 'Admin', email: 'octocat@example.com' },
    });
    const detail = await call(t, '/api/repos/secagent/secagent', {
      cookie: admin,
    });
    expect(await detail.json()).toMatchObject({ visibility: 'internal' });
    const collaborators = (await (
      await call(t, '/api/repos/secagent/secagent/collaborators', {
        cookie: admin,
      })
    ).json()) as { username: string }[];
    expect(collaborators.map((c) => c.username)).toEqual(['octocat']);
    const raw = (path: string) =>
      call(t, `/api/repos/secagent/secagent/raw?ref=main&path=${path}`, {
        cookie: admin,
      });
    expect(await (await raw('AGENT.md')).text()).toContain(
      'name: "Security Agent"'
    );
    expect(await (await raw('knowledge/README.md')).text()).toContain(
      '# Knowledge'
    );
    const avatar = new Uint8Array(
      await (await raw('avatar.png')).arrayBuffer()
    );
    expect([...avatar.subarray(0, 8)]).toEqual(PNG);
  });

  it('refuses handles that are invalid, reserved or taken (any case, by a person or the team)', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/team', {
      cookie: admin,
      method: 'PUT',
      json: { name: 'XY Space', slug: 'xyspace' },
    });
    await newAgent(t, admin, 'secagent');
    const users = async () =>
      (await t.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{
        n: number;
      }>())!.n;
    const before = await users();
    for (const [handle, status] of [
      ['bad_name', 400],
      ['-agent', 400],
      ['admin', 400],
      ['OctoCat', 409],
      ['xyspace', 409],
      ['SECAGENT', 409],
    ] as const) {
      const res = await call(t, '/api/admin/agents', {
        cookie: admin,
        json: { handle, name: 'Agent' },
      });
      expect(res.status, handle).toBe(status);
    }
    expect(await users()).toBe(before);
    expect(t.fake.repos.size).toBe(1);
    // And the team can't take an agent's handle.
    const team = await call(t, '/api/team', {
      cookie: admin,
      method: 'PUT',
      json: { name: 'XY Space', slug: 'secagent' },
    });
    expect(team.status).toBe(409);
  });

  it('refuses display names that are blank, too long, or break the AGENT.md heading', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    for (const name of [
      '   ',
      'x'.repeat(101),
      'Security\nAgent',
      'Security\r\n---',
      'Tab\tAgent',
      'Bell\u0007Agent',
      'Line Break',
    ]) {
      const res = await call(t, '/api/admin/agents', {
        cookie: admin,
        json: { handle: 'secagent', name },
      });
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(
        ((await res.json()) as { error: string }).error,
        JSON.stringify(name)
      ).toMatch(/name/i);
    }
    expect(t.fake.repos.size).toBe(0);
    // Surrounding whitespace is trimmed, not refused.
    expect(
      (await newAgent(t, admin, 'secagent', '  Security Agent  ')).name
    ).toBe('Security Agent');
  });

  it('is for site admins only; every member can list agents', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const bob = await addMember(t, admin, 'bob');
    const res = await call(t, '/api/admin/agents', {
      cookie: bob,
      json: { handle: 'secagent', name: 'Security Agent' },
    });
    expect(res.status).toBe(403);
    await newAgent(t, admin, 'secagent');
    await newAgent(t, admin, 'docsagent', 'Docs Agent');
    const list = (await (
      await call(t, '/api/agents', { cookie: bob })
    ).json()) as AgentJson[];
    expect(list.map((a) => a.username)).toEqual(['docsagent', 'secagent']);
  });
});

describe('deleting an agent', () => {
  it('keeps the user and repository, uninvites it everywhere, and drops it from the list', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    const repoId = (await agentRow(t))!.repository_id!;
    await t.env.DB.prepare(
      'INSERT INTO repository_agents (repository_id, agent_id, created_at) VALUES (?, ?, 0)'
    )
      .bind(repoId, agent.id)
      .run();

    const res = await call(t, '/api/admin/agents/secagent', {
      cookie: admin,
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const row = await agentRow(t);
    expect(row!.deleted_at).not.toBeNull();
    expect(row!.user_name).toBe('Security Agent');
    expect(
      (await t.env.DB.prepare(
        'SELECT COUNT(*) AS n FROM repository_agents'
      ).first<{ n: number }>())!.n
    ).toBe(0);
    expect(
      (await call(t, '/api/repos/secagent/secagent', { cookie: admin })).status
    ).toBe(200);
    expect(
      await (await call(t, '/api/agents', { cookie: admin })).json()
    ).toEqual([]);
    // Gone already; and the handle stays taken.
    expect(
      (
        await call(t, '/api/admin/agents/secagent', {
          cookie: admin,
          method: 'DELETE',
        })
      ).status
    ).toBe(404);
    expect(
      (
        await call(t, '/api/admin/agents', {
          cookie: admin,
          json: { handle: 'secagent', name: 'Again' },
        })
      ).status
    ).toBe(409);
  });
});

describe('agent avatars', () => {
  it('serves avatar.png from the agent repository as a sandboxed PNG', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    const res = await call(t, agent.image!, { cookie: admin });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toContain('immutable');
    expect([...new Uint8Array(await res.arrayBuffer()).subarray(0, 8)]).toEqual(
      PNG
    );
    expect(
      (await call(t, '/api/agents/nobody/avatar', { cookie: admin })).status
    ).toBe(404);
  });

  it('answers 404 for a version that isn’t a commit', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await newAgent(t, admin);
    const repo = await agentRepo(t);
    const head = repo.refs.get('refs/heads/main')!;
    const tree = repo.parseCommit(head)!.treeHash;
    const blob = repo.parseTree(tree)!.find((e) => e.name === 'avatar.png')!;
    for (const v of [blob.hash, tree, 'a'.repeat(40)]) {
      const res = await call(t, `/api/agents/secagent/avatar?v=${v}`, {
        cookie: admin,
      });
      expect(res.status, v).toBe(404);
    }
  });

  it('keeps the agent when its repository is deleted', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const agent = await newAgent(t, admin);
    const del = await call(t, '/api/repos/secagent/secagent', {
      cookie: admin,
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    const list = (await (
      await call(t, '/api/agents', { cookie: admin })
    ).json()) as AgentJson[];
    expect(list).toMatchObject([{ username: 'secagent', repository: null }]);
    expect((await call(t, agent.image!, { cookie: admin })).status).toBe(404);
  });
});

describe('the agent account while it is being created', () => {
  /** Runs `during` when the agent's repository is created in Artifacts. */
  function onArtifactsCreate(t: TestEnv, during: () => Promise<void>) {
    const binding = t.env.ARTIFACTS as unknown as {
      create: (...a: unknown[]) => Promise<unknown>;
    };
    const create = binding.create.bind(binding);
    binding.create = async (...a) => {
      await during();
      return create(...a);
    };
  }

  it('is an agent from the moment its user row exists', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    let seen: { username: string; agent: string | null } | null = null;
    onArtifactsCreate(t, async () => {
      seen = await t.env.DB.prepare(
        `SELECT u.username, a.user_id AS agent FROM users u
         LEFT JOIN agents a ON a.user_id = u.id WHERE u.username = 'secagent'`
      ).first();
    });
    await newAgent(t, admin);
    expect(seen).toMatchObject({ username: 'secagent' });
    expect(seen!.agent).not.toBeNull();
  });

  it('leaves nothing behind when creation fails', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    onArtifactsCreate(t, async () => {
      throw new Error('Artifacts is down');
    });
    const res = await call(t, '/api/admin/agents', {
      cookie: admin,
      json: { handle: 'secagent', name: 'Security Agent' },
    });
    expect(res.ok).toBe(false);
    const left = await t.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users WHERE username = 'secagent') AS users,
              (SELECT COUNT(*) FROM agents) AS agents,
              (SELECT COUNT(*) FROM repositories) AS repos`
    ).first();
    expect(left).toEqual({ users: 0, agents: 0, repos: 0 });
  });

  /** createAgent called directly, as the site admin, against `db`. */
  async function create(t: TestEnv, db = drizzle(t.env.DB, { schema })) {
    const creator = (await t.env.DB.prepare(
      "SELECT id, name, email, username, role FROM users WHERE username = 'octocat'"
    ).first<SessionUser>())!;
    return createAgent(t.env, db, creator, {
      handle: 'secagent',
      name: 'Security Agent',
    });
  }

  async function leftovers(t: TestEnv) {
    return t.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users WHERE username = 'secagent') AS users,
              (SELECT COUNT(*) FROM agents) AS agents,
              (SELECT COUNT(*) FROM repositories) AS repos`
    ).first();
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes the rows and the Artifacts repository when the first commit fails', async () => {
    const t = makeEnv();
    await bootstrapAdmin(t);
    vi.spyOn(GitService.prototype, 'initialCommit').mockRejectedValueOnce(
      new Error('pack rejected')
    );
    await expect(create(t)).rejects.toThrow('pack rejected');
    expect(await leftovers(t)).toEqual({ users: 0, agents: 0, repos: 0 });
    expect(t.fake.repos.size).toBe(0);
  });

  it('surfaces the original error even when the cleanup fails', async () => {
    const t = makeEnv();
    await bootstrapAdmin(t);
    vi.spyOn(GitService.prototype, 'initialCommit').mockRejectedValueOnce(
      new Error('pack rejected')
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = drizzle(t.env.DB, { schema });
    const failingCleanup = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'delete')
          return () => {
            throw new Error('D1 is down');
          };
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(create(t, failingCleanup)).rejects.toThrow('pack rejected');
    expect(t.fake.repos.size).toBe(0);
  });

  it('answers 409 only when it loses the race for the username', async () => {
    const t = makeEnv();
    await bootstrapAdmin(t);
    const db = drizzle(t.env.DB, { schema });
    // Someone takes the handle between the namespace check and the insert.
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'batch') return Reflect.get(target, prop, receiver);
        return async (stmts: Parameters<typeof db.batch>[0]) => {
          await t.env.DB.prepare(
            "INSERT INTO users (id, name, email, email_verified, username, display_username, role, created_at, updated_at) VALUES ('racer', 'Racer', 'racer@example.com', 0, 'secagent', 'secagent', 'user', 0, 0)"
          ).run();
          return target.batch(stmts);
        };
      },
    });
    expect(await create(t, racing)).toMatchObject({ ok: false, status: 409 });
  });

  it('rethrows other failures of the first insert instead of calling them a conflict', async () => {
    const t = makeEnv();
    await bootstrapAdmin(t);
    const db = drizzle(t.env.DB, { schema });
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'batch') return Reflect.get(target, prop, receiver);
        return async () => {
          throw new Error('D1_ERROR: database is locked');
        };
      },
    });
    await expect(create(t, failing)).rejects.toThrow('database is locked');
  });
});
