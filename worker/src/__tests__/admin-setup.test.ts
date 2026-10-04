import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  type TestEnv,
} from './helpers/app';
import { knownMigrations } from '../lib/setup-checks';

type Check = {
  id: string;
  category: string;
  title: string;
  status: 'ok' | 'warning' | 'error';
  detail: string;
  fix: { text: string; code?: string; link?: string }[];
};
type Body = {
  checks: Check[];
  counts: { error: number; warning: number; ok: number };
};

const SECRETS = {
  BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
  R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
};

/** R2's S3 endpoint, answering every signed read like a bucket without the probe key. */
function fakeR2Api(code = 'NoSuchKey', status = 404) {
  const prev = globalThis.fetch;
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      );
      if (url.hostname.endsWith('.r2.cloudflarestorage.com')) {
        seen.push(url.pathname);
        return new Response(
          `<?xml version="1.0"?><Error><Code>${code}</Code><Message>x</Message></Error>`,
          { status }
        );
      }
      return prev(input, init);
    }
  );
  return seen;
}

/** Every binding a full deployment has, with fakes where the test config has none. */
function fullEnv(overrides: Record<string, unknown> = {}): TestEnv {
  const t = makeEnv({ actions: true });
  t.env = {
    ...t.env,
    AI_GATEWAY: 'default',
    MERGE_RESOLVER: { getByName: () => ({}) },
    AI: {
      gateway: () => ({ getUrl: async () => 'https://gateway.example/' }),
      run: async () => ({ response: 'OK' }),
      aiGatewayLogId: 'log-1',
    },
    ...overrides,
  } as unknown as CloudflareBindings;
  return t;
}

/** Applies `drop` by deleting keys after the full env is built. */
function without(t: TestEnv, ...names: string[]) {
  const e = { ...(t.env as unknown as Record<string, unknown>) };
  for (const n of names) delete e[n];
  t.env = e as unknown as CloudflareBindings;
  return t;
}

async function checks(t: TestEnv, cookie: string) {
  const res = await call(t, '/api/admin/setup', { cookie });
  expect(res.status).toBe(200);
  const text = await res.text();
  return { body: JSON.parse(text) as Body, text };
}

const byId = (b: Body, id: string) => b.checks.find((c) => c.id === id)!;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Site admin → Setup', () => {
  it('is admin-only', async () => {
    const t = fullEnv();
    const admin = await bootstrapAdmin(t);
    const member = await addMember(t, admin, 'mona');
    expect((await call(t, '/api/admin/setup')).status).toBe(401);
    expect((await call(t, '/api/admin/setup', { cookie: member })).status).toBe(
      403
    );
    expect(
      (
        await call(t, '/api/admin/setup/ai-test', {
          method: 'POST',
          cookie: member,
        })
      ).status
    ).toBe(403);
  });

  it('reports everything OK for a complete deployment, and never leaks secrets', async () => {
    const t = fullEnv();
    const probed = fakeR2Api();
    const admin = await bootstrapAdmin(t);
    const { body, text } = await checks(t, admin);
    const notOk = body.checks.filter((c) => c.status !== 'ok');
    expect(notOk).toEqual([]);
    expect(body.counts.error).toBe(0);
    // Every binding, the live probes, and the gateway were looked at.
    for (const id of [
      'secret-better-auth',
      'secret-r2',
      'binding-DB',
      'binding-ARTIFACTS',
      'binding-AI',
      'binding-LIVE',
      'probe-d1',
      'probe-artifacts',
      'probe-r2-LFS',
      'probe-presign-lfs',
      'probe-presign-cache',
      'probe-email',
      'var-base-url',
      'ai-gateway',
    ])
      expect(byId(body, id)?.status, id).toBe('ok');
    expect(byId(body, 'probe-d1').detail).toMatch(/every migration/);
    // The signed probes read a key that doesn't exist, in both buckets.
    expect(probed).toEqual([
      '/gitorange-lfs-test/__gitorange-setup-probe',
      '/gitorange-actions-cache-test/__gitorange-setup-probe',
    ]);
    for (const v of Object.values(SECRETS)) expect(text).not.toContain(v);
  });

  it('flags missing secrets as errors, with the commands to set them', async () => {
    // Through the endpoint: the R2 secret is missing.
    const t = without(fullEnv(), 'R2_SECRET_ACCESS_KEY');
    const admin = await bootstrapAdmin(t);
    const { body } = await checks(t, admin);
    expect(byId(body, 'secret-r2').status).toBe('error');
    expect(body.checks[0].status).toBe('error');
    // Signing in needs BETTER_AUTH_SECRET, so its absence is checked on the library.
    const { runSetupChecks } = await import('../lib/setup-checks');
    const list = await runSetupChecks(
      without(fullEnv(), 'BETTER_AUTH_SECRET', 'R2_SECRET_ACCESS_KEY').env,
      'http://test.local'
    );
    const auth = list.find((c) => c.id === 'secret-better-auth')!;
    expect(auth.status).toBe('error');
    expect(auth.detail).toMatch(/Missing/);
    expect(auth.fix[0].code).toBe(
      'openssl rand -hex 32 | yarn wrangler secret put BETTER_AUTH_SECRET'
    );
    const r2 = list.find((c) => c.id === 'secret-r2')!;
    expect(r2.status).toBe('error');
    expect(r2.detail).toMatch(/R2_SECRET_ACCESS_KEY/);
    expect(r2.detail).toMatch(/Git LFS/);
    expect(r2.fix.map((s) => s.code)).toContain(
      'yarn wrangler secret put R2_SECRET_ACCESS_KEY'
    );
    expect(r2.fix[0].link).toContain('r2/api-tokens');
    // Errors come first.
    expect(list[0].status).toBe('error');
  });

  it('flags a short or placeholder auth secret without echoing it', async () => {
    const { runSetupChecks } = await import('../lib/setup-checks');
    for (const secret of [
      'short-secret',
      'change-me-to-a-long-random-string',
    ]) {
      const t = fullEnv({ BETTER_AUTH_SECRET: secret });
      fakeR2Api();
      const list = await runSetupChecks(t.env, 'http://test.local');
      const auth = list.find((c) => c.id === 'secret-better-auth')!;
      expect(auth.status).toBe('error');
      expect(JSON.stringify(list)).not.toContain(secret);
    }
  });

  it('flags missing bindings: required as errors, optional features as warnings', async () => {
    const t = without(fullEnv(), 'LFS', 'ACTIONS_RUN', 'AI', 'LIVE');
    fakeR2Api();
    const admin = await bootstrapAdmin(t);
    const { body } = await checks(t, admin);
    const lfs = byId(body, 'binding-LFS');
    expect(lfs.status).toBe('error');
    expect(lfs.fix[0].code).toContain('"binding": "LFS"');
    expect(lfs.fix.map((s) => s.code)).toContain('yarn deploy');
    expect(byId(body, 'binding-ACTIONS_RUN').status).toBe('warning');
    expect(byId(body, 'binding-ACTIONS_RUN').detail).toMatch(/Actions is off/);
    expect(byId(body, 'binding-AI').status).toBe('warning');
    expect(byId(body, 'binding-LIVE').status).toBe('warning');
    expect(byId(body, 'ai-gateway').status).toBe('warning');
    expect(body.counts.error).toBeGreaterThan(0);
    const firstWarning = body.checks.findIndex((c) => c.status === 'warning');
    const lastError = body.checks.map((c) => c.status).lastIndexOf('error');
    expect(lastError).toBeLessThan(firstWarning);
  });

  it('reports failing probes: Artifacts, R2 credentials, and pending migrations', async () => {
    const t = fullEnv();
    t.env = {
      ...t.env,
      ARTIFACTS: {
        list: async () => {
          throw new Error('namespace not found');
        },
      },
    } as unknown as CloudflareBindings;
    fakeR2Api('InvalidAccessKeyId', 403);
    const admin = await bootstrapAdmin(t);
    await env.DB.prepare('DELETE FROM d1_migrations WHERE name = ?')
      .bind(knownMigrations().at(-1))
      .run();
    try {
      const { body } = await checks(t, admin);
      expect(byId(body, 'probe-artifacts').status).toBe('error');
      expect(byId(body, 'probe-artifacts').detail).toMatch(
        /namespace not found/
      );
      const lfs = byId(body, 'probe-presign-lfs');
      expect(lfs.status).toBe('error');
      expect(lfs.detail).toMatch(/R2_ACCESS_KEY_ID/);
      expect(byId(body, 'probe-presign-cache').status).toBe('warning');
      const d1 = byId(body, 'probe-d1');
      expect(d1.status).toBe('error');
      expect(d1.detail).toContain(knownMigrations().at(-1));
      expect(d1.fix[0].code).toBe('yarn db:migrate:prod');
    } finally {
      await env.DB.prepare(
        "INSERT INTO d1_migrations (name, applied_at) VALUES (?, datetime('now'))"
      )
        .bind(knownMigrations().at(-1))
        .run();
    }
  });

  it('checks variables: BASE_URL vs this origin, models, bucket names, the gateway', async () => {
    const t = fullEnv({
      BASE_URL: 'https://git.example.com',
      AI_GATEWAY: 'off',
      SUMMARY_MODEL: 'gpt-4o',
      LFS_BUCKET_NAME: '',
      FROM_EMAIL: 'noreply@<your-email-sending-domain>',
    });
    fakeR2Api();
    const { runSetupChecks } = await import('../lib/setup-checks');
    const list = await runSetupChecks(t.env, 'https://git.other.com');
    const get = (id: string) => list.find((c) => c.id === id)!;
    expect(get('var-base-url').status).toBe('error');
    expect(get('var-base-url').detail).toContain('https://git.other.com');
    expect(get('var-base-url').fix[0].code).toBe(
      '"BASE_URL": "https://git.other.com"'
    );
    expect(get('var-summary-model').status).toBe('warning');
    expect(get('var-lfs-bucket-name').status).toBe('error');
    expect(get('probe-email').status).toBe('warning');
    const gw = get('ai-gateway');
    expect(gw.status).toBe('warning');
    expect(gw.detail).toMatch(/not logged/);
    expect(gw.fix.some((s) => s.link?.includes('ai/ai-gateway'))).toBe(true);
  });

  it('gives .dev.vars fixes under yarn dev', async () => {
    const t = without(
      fullEnv({ BASE_URL: 'http://localhost:8080' }),
      'R2_ACCESS_KEY_ID'
    );
    const { runSetupChecks } = await import('../lib/setup-checks');
    const list = await runSetupChecks(t.env, 'http://localhost:8080');
    const r2 = list.find((c) => c.id === 'secret-r2')!;
    expect(r2.fix[1].text).toMatch(/\.dev\.vars/);
    expect(list.find((c) => c.id === 'var-base-url')!.status).toBe('ok');
  });

  it('sends one capped AI request through the gateway on demand', async () => {
    const calls: unknown[][] = [];
    const t = fullEnv();
    (t.env as unknown as { AI: { run: unknown } }).AI.run = async (
      ...args: unknown[]
    ) => {
      calls.push(args);
      return { response: 'OK' };
    };
    const admin = await bootstrapAdmin(t);
    const res = await call(t, '/api/admin/setup/ai-test', {
      method: 'POST',
      cookie: admin,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      gateway: 'default',
      logged: true,
    });
    expect(calls).toHaveLength(1);
    const [model, input, opts] = calls[0] as [
      string,
      { max_tokens: number },
      { gateway: { id: string } },
    ];
    expect(model).toBe(env.SUMMARY_MODEL);
    expect(input.max_tokens).toBeLessThanOrEqual(4);
    expect(opts.gateway.id).toBe('default');
  });
});
