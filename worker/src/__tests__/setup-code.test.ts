import { describe, expect, it } from 'vitest';
import { setupCodeHash } from '../lib/setup-code';
import { countUsers } from '../routers/setup-router';
import { drizzle } from 'drizzle-orm/d1';
import { call, makeEnv, type TestEnv } from './helpers/app';

const CODE = 'ABCD-EFGH-JKMN-PQRS-TUVW';
const admin = {
  name: 'Octo',
  username: 'octocat',
  email: 'octo@example.com',
  password: 'password123',
};

async function withHash(hash: string | undefined) {
  const t = makeEnv();
  (t.env as unknown as Record<string, unknown>).SETUP_CODE_HASH = hash;
  return t;
}
const users = (t: TestEnv) => countUsers(drizzle(t.env.DB) as never);
const post = (t: TestEnv, code?: string) =>
  call(t, '/api/setup', {
    json: code === undefined ? admin : { ...admin, code },
  });

describe('setup code', () => {
  it('hashes case- and dash-insensitively to lowercase hex SHA-256', async () => {
    const a = await setupCodeHash(CODE);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await setupCodeHash('abcdefghjkmnpqrstuvw')).toBe(a);
  });

  it('status says a code is required while SETUP_CODE_HASH is set and nobody exists', async () => {
    const t = await withHash(await setupCodeHash(CODE));
    expect(await (await call(t, '/api/setup/status')).json()).toEqual({
      setupRequired: true,
      codeRequired: true,
      appName: 'GitOrange',
    });
  });

  it('rejects setup without the code', async () => {
    const t = await withHash(await setupCodeHash(CODE));
    expect((await post(t)).status).toBe(403);
    expect(await users(t)).toBe(0);
  });

  it('rejects a wrong code', async () => {
    const t = await withHash(await setupCodeHash(CODE));
    expect((await post(t, 'ABCD-EFGH-JKMN-PQRS-TUVX')).status).toBe(403);
    expect(await users(t)).toBe(0);
  });

  it('accepts the code in any case and with or without dashes', async () => {
    const t = await withHash(await setupCodeHash(CODE));
    expect((await post(t, 'abcdefghjkmnpqrstuvw')).status).toBe(200);
    expect(await users(t)).toBe(1);
  });

  it('accepts a pasted code with surrounding and inner whitespace', async () => {
    const t = await withHash(await setupCodeHash(CODE));
    expect(await setupCodeHash(' abcd-efgh jkmn-pqrs-tuvw \n')).toBe(
      await setupCodeHash(CODE)
    );
    expect((await post(t, ' abcd-efgh-jkmn-pqrs-tuvw \n')).status).toBe(200);
    expect(await users(t)).toBe(1);
  });

  it('Site admin → Setup reports a whitespace-only SETUP_CODE_HASH as not set', async () => {
    const { runSetupChecks } = await import('../lib/setup-checks');
    const set = await withHash(await setupCodeHash(CODE));
    const blank = await withHash('  \n');
    const detail = async (t: TestEnv) =>
      (await runSetupChecks(t.env, 'http://test.local')).find(
        (c) => c.id === 'secret-setup-code'
      )!.detail;
    expect(await detail(set)).toMatch(/^Set:/);
    expect(await detail(blank)).toMatch(/^Not set:/);
  });

  it('an empty SETUP_CODE_HASH counts as unset', async () => {
    const t = await withHash('');
    expect(
      (
        (await (await call(t, '/api/setup/status')).json()) as {
          codeRequired: boolean;
        }
      ).codeRequired
    ).toBe(false);
    expect((await post(t)).status).toBe(200);
  });

  it('codeRequired is false once an admin exists, and setup stays closed', async () => {
    const t = await withHash(await setupCodeHash(CODE));
    expect((await post(t, CODE)).status).toBe(200);
    const s = (await (await call(t, '/api/setup/status')).json()) as {
      setupRequired: boolean;
      codeRequired: boolean;
    };
    expect(s.setupRequired).toBe(false);
    expect(s.codeRequired).toBe(false);
    expect((await post(t, CODE)).status).toBe(403);
  });
});
