import { env } from 'cloudflare:test';
import { app } from '../../index';
import { createFakeArtifacts } from './fake-artifacts';

/** Stand-ins for the Actions Workflow and JobRunner bindings: they record what was asked. */
function fakeActions() {
  const started: { id: string; params: unknown }[] = [];
  const terminated: string[] = [];
  const destroyed: string[] = [];
  const instanceStatus = new Map<string, string>();
  const live = new Map<string, string>();
  const ACTIONS_RUN = {
    create: async (opts: { id: string; params: unknown }) => {
      started.push(opts);
      return { id: opts.id };
    },
    get: async (id: string) => ({
      id,
      status: async () => ({ status: instanceStatus.get(id) ?? 'running' }),
      terminate: async () => void terminated.push(id),
    }),
  };
  // AI conflict resolution: single attempts and sweeps, recorded separately from Actions runs.
  const resolutions: { id: string; params: unknown }[] = [];
  const terminatedResolutions: string[] = [];
  const MERGE_RESOLUTION = {
    create: async (opts: { id: string; params: unknown }) => {
      resolutions.push(opts);
      return { id: opts.id };
    },
    get: async (id: string) => ({
      id,
      terminate: async () => void terminatedResolutions.push(id),
    }),
  };
  const JOB_RUNNER = {
    getByName: (jobId: string) => ({
      live: async (step: number) => live.get(`${jobId}:${step}`) ?? null,
      destroy: async () => void destroyed.push(jobId),
    }),
  };
  return {
    bindings: { ACTIONS_RUN, JOB_RUNNER, MERGE_RESOLUTION },
    started,
    terminated,
    destroyed,
    resolutions,
    terminatedResolutions,
    instanceStatus,
    live,
  };
}

export function makeEnv(opts: { actions?: boolean } = {}) {
  const fake = createFakeArtifacts();
  const actions = fakeActions();
  const sent: { to: unknown; subject: string; text?: string }[] = [];
  const testEnv = {
    ...env,
    ARTIFACTS: fake.binding,
    EMAIL: {
      send: async (m: { to: unknown; subject: string; text?: string }) =>
        void sent.push(m),
    },
    ...(opts.actions ? actions.bindings : {}),
  } as unknown as CloudflareBindings;
  // Background work (ctx.waitUntil) is collected so tests can await it with settle().
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void waits.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { env: testEnv, fake, sent, actions, ctx, waits };
}

export type TestEnv = ReturnType<typeof makeEnv>;

/** Waits for everything the app handed to ctx.waitUntil so far. */
export async function settle(t: TestEnv) {
  while (t.waits.length) await Promise.all(t.waits.splice(0));
}

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
  return app.fetch(req, t.env, t.ctx);
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
