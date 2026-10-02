import { describe, expect, it } from 'vitest';
import { handleGitRequest } from '../git-http';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  type TestEnv,
} from './helpers/app';

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

async function pat(t: TestEnv, cookie: string) {
  const res = await call(t, '/api/tokens', {
    cookie,
    json: { name: 'cli', expiresInDays: 30 },
  });
  return ((await res.json()) as { plaintext: string }).plaintext;
}

async function gitRefs(t: TestEnv, path: string, token: string) {
  const req = new Request(
    `http://test.local${path}/info/refs?service=git-upload-pack`,
    {
      headers: { Authorization: `Basic ${btoa(`u:${token}`)}` },
    }
  );
  return handleGitRequest(req, t.env, ctx);
}

type Repo = { fullName: string; visibility: string; ownerType: string };

async function setup() {
  const t = makeEnv();
  const admin = await bootstrapAdmin(t);
  const ada = await addMember(t, admin, 'ada');
  const bob = await addMember(t, admin, 'bob');
  return { t, admin, ada, bob };
}

describe('personal repositories', () => {
  it('are private by default and invisible to other members', async () => {
    const { t, ada, bob } = await setup();
    const res = await call(t, '/api/repos', {
      cookie: ada,
      json: { name: 'diary' },
    });
    expect(((await res.json()) as Repo).visibility).toBe('private');

    expect(
      (await call(t, '/api/repos/ada/diary', { cookie: bob })).status
    ).toBe(404);
    const list = (await (
      await call(t, '/api/repos', { cookie: bob })
    ).json()) as Repo[];
    expect(list.map((r) => r.fullName)).not.toContain('ada/diary');
    const profile = (await (
      await call(t, '/api/namespaces/ada', { cookie: bob })
    ).json()) as { repositories: Repo[] };
    expect(profile.repositories).toEqual([]);
    expect((await gitRefs(t, '/ada/diary.git', await pat(t, bob))).status).toBe(
      404
    );
  });

  it('are visible to collaborators and site admins', async () => {
    const { t, admin, ada, bob } = await setup();
    await call(t, '/api/repos', {
      cookie: ada,
      json: { name: 'diary', addReadme: true },
    });
    expect(
      (await call(t, '/api/repos/ada/diary', { cookie: admin })).status
    ).toBe(200);
    await call(t, '/api/repos/ada/diary/collaborators/bob', {
      cookie: ada,
      method: 'PUT',
    });
    const detail = (await (
      await call(t, '/api/repos/ada/diary', { cookie: bob })
    ).json()) as { permissions: unknown };
    expect(detail.permissions).toEqual({
      read: true,
      write: true,
      admin: false,
    });
    expect((await gitRefs(t, '/ada/diary.git', await pat(t, bob))).status).toBe(
      200
    );
  });

  it('can be made internal by the owner, after which every member can read them', async () => {
    const { t, ada, bob } = await setup();
    await call(t, '/api/repos', { cookie: ada, json: { name: 'notes' } });
    const res = await call(t, '/api/repos/ada/notes', {
      cookie: ada,
      method: 'PATCH',
      json: { visibility: 'internal' },
    });
    expect(((await res.json()) as Repo).visibility).toBe('internal');
    expect(
      (await call(t, '/api/repos/ada/notes', { cookie: bob })).status
    ).toBe(200);
  });
});

describe('the shared team', () => {
  it('is created by a site admin, not by members', async () => {
    const { t, admin, ada } = await setup();
    expect(await (await call(t, '/api/team', { cookie: ada })).json()).toEqual({
      team: null,
    });
    const asMember = await call(t, '/api/team', {
      cookie: ada,
      method: 'PUT',
      json: { name: 'XY Space', slug: 'xyspace' },
    });
    expect(asMember.status).toBe(403);
    const res = await call(t, '/api/team', {
      cookie: admin,
      method: 'PUT',
      json: { name: 'XY Space', slug: 'XYSpace' },
    });
    expect(((await res.json()) as { team: { slug: string } }).team.slug).toBe(
      'xyspace'
    );
  });

  it('cannot take a username, and users cannot take its slug', async () => {
    const { t, admin, ada } = await setup();
    const clash = await call(t, '/api/team', {
      cookie: admin,
      method: 'PUT',
      json: { name: 'Ada', slug: 'ada' },
    });
    expect(clash.status).toBe(409);
    await call(t, '/api/team', {
      cookie: admin,
      method: 'PUT',
      json: { name: 'XY Space', slug: 'xyspace' },
    });
    const rename = await call(t, '/api/auth/update-user', {
      cookie: ada,
      json: { username: 'xyspace' },
    });
    expect(rename.ok).toBe(false);
    const invite = await call(t, '/api/invites', {
      cookie: admin,
      json: { email: 'x@example.com' },
    });
    const token = (
      (await invite.json()) as { inviteUrl: string }
    ).inviteUrl.split('/invite/')[1];
    const accept = await call(t, '/api/invites/accept', {
      json: { token, name: 'X', username: 'XYSpace', password: 'password123' },
    });
    expect(accept.status).toBe(400);
  });

  it('owns team repositories that every member reads but only collaborators push to', async () => {
    const { t, admin, ada, bob } = await setup();
    const early = await call(t, '/api/repos', {
      cookie: ada,
      json: { name: 'site', owner: 'team' },
    });
    expect(early.status).toBe(400); // no team yet
    await call(t, '/api/team', {
      cookie: admin,
      method: 'PUT',
      json: { name: 'XY Space', slug: 'xyspace' },
    });

    const res = await call(t, '/api/repos', {
      cookie: ada,
      json: {
        name: 'site',
        owner: 'team',
        visibility: 'private',
        addReadme: true,
      },
    });
    expect((await res.json()) as Repo).toMatchObject({
      fullName: 'xyspace/site',
      ownerType: 'team',
      visibility: 'internal',
    });

    const asBob = (await (
      await call(t, '/api/repos/xyspace/site', { cookie: bob })
    ).json()) as {
      permissions: unknown;
      cloneUrl: string;
    };
    expect(asBob.permissions).toEqual({
      read: true,
      write: false,
      admin: false,
    });
    expect(asBob.cloneUrl).toBe('http://test.local/xyspace/site.git');
    expect(
      (await gitRefs(t, '/xyspace/site.git', await pat(t, bob))).status
    ).toBe(200);

    const asAda = (await (
      await call(t, '/api/repos/xyspace/site', { cookie: ada })
    ).json()) as { permissions: unknown };
    expect(asAda.permissions).toEqual({ read: true, write: true, admin: true }); // creator

    const page = (await (
      await call(t, '/api/namespaces/xyspace', { cookie: bob })
    ).json()) as {
      kind: string;
      repositories: Repo[];
    };
    expect(page.kind).toBe('team');
    expect(page.repositories.map((r) => r.fullName)).toEqual(['xyspace/site']);

    const flip = await call(t, '/api/repos/xyspace/site', {
      cookie: ada,
      method: 'PATCH',
      json: { visibility: 'private' },
    });
    expect(flip.status).toBe(400);
  });

  it('allows the same repository name in a personal and the team namespace', async () => {
    const { t, admin, ada } = await setup();
    await call(t, '/api/team', {
      cookie: admin,
      method: 'PUT',
      json: { name: 'XY Space', slug: 'xyspace' },
    });
    expect(
      (await call(t, '/api/repos', { cookie: ada, json: { name: 'site' } }))
        .status
    ).toBe(201);
    expect(
      (
        await call(t, '/api/repos', {
          cookie: ada,
          json: { name: 'site', owner: 'team' },
        })
      ).status
    ).toBe(201);
    expect(
      (
        await call(t, '/api/repos', {
          cookie: admin,
          json: { name: 'site', owner: 'team' },
        })
      ).status
    ).toBe(409);
  });
});
