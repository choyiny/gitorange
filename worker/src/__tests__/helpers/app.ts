import { env } from 'cloudflare:test';
import { app } from '../../index';
import { createFakeArtifacts } from './fake-artifacts';

export function makeEnv() {
  const fake = createFakeArtifacts();
  const sent: { to: unknown; subject: string; text?: string }[] = [];
  const testEnv = {
    ...env,
    ARTIFACTS: fake.binding,
    EMAIL: {
      send: async (m: { to: unknown; subject: string; text?: string }) =>
        void sent.push(m),
    },
  } as unknown as CloudflareBindings;
  return { env: testEnv, fake, sent };
}

export type TestEnv = ReturnType<typeof makeEnv>;

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

export async function call(
  t: TestEnv,
  path: string,
  opts: {
    method?: string;
    json?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  } = {}
) {
  const headers = new Headers(opts.headers);
  headers.set('Origin', 'http://test.local');
  if (opts.json !== undefined) headers.set('Content-Type', 'application/json');
  if (opts.cookie) headers.set('Cookie', opts.cookie);
  const req = new Request(`http://test.local${path}`, {
    method: opts.method ?? (opts.json !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  return app.fetch(req, t.env, ctx);
}

export async function signIn(
  t: TestEnv,
  username: string,
  password: string
): Promise<string> {
  const res = await call(t, '/api/auth/sign-in/username', {
    json: { username, password },
  });
  if (!res.ok)
    throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

/** Creates the first admin through the real setup route and returns a session cookie. */
export async function bootstrapAdmin(t: TestEnv, username = 'octocat') {
  const res = await call(t, '/api/setup', {
    json: {
      name: 'Admin',
      username,
      email: `${username}@example.com`,
      password: 'password123',
    },
  });
  if (!res.ok)
    throw new Error(`setup failed: ${res.status} ${await res.text()}`);
  return signIn(t, username, 'password123');
}

/** Invites and accepts a member through the real routes; returns their cookie. */
export async function addMember(
  t: TestEnv,
  adminCookie: string,
  username: string
) {
  const res = await call(t, '/api/invites', {
    cookie: adminCookie,
    json: { email: `${username}@example.com`, role: 'user' },
  });
  const { inviteUrl } = (await res.json()) as { inviteUrl: string };
  const token = inviteUrl.split('/invite/')[1];
  const acc = await call(t, '/api/invites/accept', {
    json: { token, name: username, username, password: 'password123' },
  });
  if (!acc.ok) throw new Error(`accept failed: ${await acc.text()}`);
  return signIn(t, username, 'password123');
}
