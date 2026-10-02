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

async function git(t: TestEnv, path: string, token?: string, method = 'GET') {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Basic ${btoa(`user:${token}`)}`);
  return handleGitRequest(
    new Request(`http://test.local${path}`, {
      method,
      headers,
      body: method === 'POST' ? '0000' : undefined,
    }),
    t.env,
    ctx
  );
}

async function pat(t: TestEnv, cookie: string) {
  const res = await call(t, '/api/tokens', {
    cookie,
    json: { name: 'cli', expiresInDays: 30 },
  });
  return ((await res.json()) as { plaintext: string }).plaintext;
}

async function setup() {
  const t = makeEnv();
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', addReadme: true, visibility: 'internal' },
  });
  return { t, admin };
}

describe('git smart-HTTP proxy', () => {
  it('challenges for credentials when none are sent', async () => {
    const { t } = await setup();
    const res = await git(
      t,
      '/octocat/app.git/info/refs?service=git-upload-pack'
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
  });

  it('rejects an unknown token', async () => {
    const { t } = await setup();
    const res = await git(
      t,
      '/octocat/app.git/info/refs?service=git-upload-pack',
      'gop_nope'
    );
    expect(res.status).toBe(401);
  });

  it('serves the ref advertisement to any member with a valid token', async () => {
    const { t, admin } = await setup();
    const bob = await addMember(t, admin, 'bob');
    const res = await git(
      t,
      '/octocat/app.git/info/refs?service=git-upload-pack',
      await pat(t, bob)
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('refs/heads/main');
  });

  it('returns 404 for a repo that does not exist', async () => {
    const { t, admin } = await setup();
    const res = await git(
      t,
      '/octocat/missing.git/info/refs?service=git-upload-pack',
      await pat(t, admin)
    );
    expect(res.status).toBe(404);
  });

  it('denies push to members who are not collaborators', async () => {
    const { t, admin } = await setup();
    const bob = await addMember(t, admin, 'bob');
    const token = await pat(t, bob);
    expect(
      (
        await git(
          t,
          '/octocat/app.git/info/refs?service=git-receive-pack',
          token
        )
      ).status
    ).toBe(403);
    expect(
      (await git(t, '/octocat/app.git/git-receive-pack', token, 'POST')).status
    ).toBe(403);

    await call(t, '/api/repos/octocat/app/collaborators/bob', {
      cookie: admin,
      method: 'PUT',
    });
    expect(
      (
        await git(
          t,
          '/octocat/app.git/info/refs?service=git-receive-pack',
          token
        )
      ).status
    ).toBe(200);
  });

  it('rejects expired tokens', async () => {
    const { t, admin } = await setup();
    const token = await pat(t, admin);
    await t.env.DB.prepare(
      'UPDATE personal_access_tokens SET expires_at = 1'
    ).run();
    expect(
      (
        await git(
          t,
          '/octocat/app.git/info/refs?service=git-upload-pack',
          token
        )
      ).status
    ).toBe(401);
  });

  it('only allows GET for the ref advertisement and POST for pack exchanges', async () => {
    const { t, admin } = await setup();
    const token = await pat(t, admin);
    expect(
      (
        await git(
          t,
          '/octocat/app.git/info/refs?service=git-upload-pack',
          token,
          'POST'
        )
      ).status
    ).toBe(405);
    expect(
      (await git(t, '/octocat/app.git/git-upload-pack', token, 'GET')).status
    ).toBe(405);
  });
});
