import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  analyticsTokenLink,
  checkAnalyticsToken,
  checkR2Keys,
  generateAuthSecret,
  generateSetupCode,
  r2TokenLink,
  setupCodeHash,
  withSecretsFile,
} from '../secrets.ts';

describe('setup code', () => {
  it('matches the Worker normalisation', () => {
    const hex = createHash('sha256')
      .update('ABCDEFGHJKMNPQRSTUVW')
      .digest('hex');
    expect(setupCodeHash('abcd-efgh-jkmn-pqrs-tuvw')).toBe(
      setupCodeHash('ABCDEFGHJKMNPQRSTUVW')
    );
    expect(setupCodeHash('ABCDEFGHJKMNPQRSTUVW')).toBe(hex);
  });
  it('has the documented format', () => {
    for (let i = 0; i < 50; i++)
      expect(generateSetupCode()).toMatch(
        /^([A-HJKMNP-Z2-9]{4}-){4}[A-HJKMNP-Z2-9]{4}$/
      );
  });
  it('auth secret is 64 hex chars and random', () => {
    expect(generateAuthSecret()).toMatch(/^[0-9a-f]{64}$/);
    expect(generateAuthSecret()).not.toBe(generateAuthSecret());
  });
});

describe('withSecretsFile', () => {
  it('writes a 0600 JSON file and removes it afterwards', async () => {
    let p = '';
    const out = await withSecretsFile({ A: 'x', B: 'y' }, async (path) => {
      p = path;
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        A: 'x',
        B: 'y',
      });
      return 7;
    });
    expect(out).toBe(7);
    expect(existsSync(p)).toBe(false);
  });
  it('removes it when fn throws', async () => {
    let p = '';
    await expect(
      withSecretsFile({ A: 'x' }, async (path) => {
        p = path;
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(existsSync(p)).toBe(false);
  });
});

describe('token links', () => {
  it('R2 link preselects object-write on the create page', () => {
    const u = new URL(r2TokenLink('acc123', ['b1', 'b2']));
    expect(u.searchParams.get('to')).toBe('/acc123/r2/api-tokens/create');
    expect(u.searchParams.get('permission')).toBe('object-write');
  });
  it('analytics link is account-owned with the read permission', () => {
    const u = new URL(analyticsTokenLink('acc123', 'gitorange'));
    expect(u.searchParams.get('to')).toBe('/acc123/api-tokens');
    expect(JSON.parse(u.searchParams.get('permissionGroupKeys')!)).toEqual([
      { key: 'account_analytics', type: 'read' },
    ]);
  });
});

describe('credential checks', () => {
  const keys = { id: 'AKID', secret: 'SECRETSECRET' };
  it('R2 403 gives the message, 200 gives null', async () => {
    const f = (s: number) =>
      (async () => new Response('', { status: s })) as unknown as typeof fetch;
    expect(await checkR2Keys('a', 'b', keys, f(403))).toBe(
      'R2 rejected these keys (HTTP 403).'
    );
    expect(await checkR2Keys('a', 'b', keys, f(200))).toBeNull();
  });
  it('R2 network error never throws or leaks the secret', async () => {
    const f = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const m = await checkR2Keys('a', 'b', keys, f);
    expect(m).toContain("Couldn't reach R2");
    expect(m).toContain('offline');
    expect(m).not.toContain(keys.secret);
  });
  it('analytics: errors give the message, account gives null', async () => {
    const f = (body: object) =>
      (async () => Response.json(body)) as unknown as typeof fetch;
    const msg = "This token can't read Account Analytics for this account.";
    expect(
      await checkAnalyticsToken('a', 'tok', f({ errors: [{ message: 'x' }] }))
    ).toBe(msg);
    expect(
      await checkAnalyticsToken(
        'a',
        'tok',
        f({ data: { viewer: { accounts: [] } } })
      )
    ).toBe(msg);
    expect(
      await checkAnalyticsToken(
        'a',
        'tok',
        f({ data: { viewer: { accounts: [{ accountTag: 'a' }] } } })
      )
    ).toBeNull();
  });
});
