import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { call, makeEnv } from './helpers/app';

const WELL_KNOWN = '/.well-known/gitorange';

function withVars(vars: Record<string, string>) {
  const t = makeEnv();
  t.env = { ...t.env, ...vars } as unknown as CloudflareBindings;
  return t;
}

describe('GET /.well-known/gitorange', () => {
  it('reports nulls on an instance the installer never touched', async () => {
    const res = await call(makeEnv(), WELL_KNOWN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      installationId: null,
      version: null,
      schemaDigest: null,
    });
  });

  it('reports the installation from its var and row', async () => {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO install_state (installation_id, ownership_nonce, version, manifest_json, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(
        'gitorange-1a2b3c4d5e6f',
        'n',
        'abc1234',
        '{"schemaDigest":"d1g"}',
        Date.now()
      )
      .run();
    const t = withVars({
      GITORANGE_INSTALLATION:
        '{"installationId":"gitorange-1a2b3c4d5e6f","ownershipNonce":"n"}',
      GITORANGE_VERSION: 'abc1234',
    });
    const res = await call(t, WELL_KNOWN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      installationId: 'gitorange-1a2b3c4d5e6f',
      version: 'abc1234',
      schemaDigest: 'd1g',
    });
    expect(JSON.stringify(body)).not.toContain('ownershipNonce');
  });

  it('ignores a malformed GITORANGE_INSTALLATION', async () => {
    const res = await call(
      withVars({ GITORANGE_INSTALLATION: 'not json' }),
      WELL_KNOWN
    );
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { installationId: unknown }).installationId
    ).toBeNull();
  });
});
