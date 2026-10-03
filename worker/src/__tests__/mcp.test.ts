import { describe, expect, it } from 'vitest';
import { app } from '../index';
import { mcpServerName } from '../lib/app-name';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  type TestEnv,
} from './helpers/app';

const ORIGIN = 'http://test.local';
const REDIRECT = 'http://127.0.0.1:33418/callback';
// The provider upgrades a non-loopback http issuer to https (production is https anyway).
const ISSUER = 'https://test.local/api/auth';

function b64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

/** A raw request through the app, without the JSON/Origin defaults of `call`. */
function raw(t: TestEnv, path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`${ORIGIN}${path}`, init), t.env, t.ctx);
}

async function rpc(
  t: TestEnv,
  token: string | null,
  method: string,
  params?: unknown,
  id: number | undefined = 1
) {
  return raw(t, '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

/** Registers a public client the way MCP clients do (RFC 7591, no credentials). */
async function register(t: TestEnv, name = 'Claude Code') {
  const meta = (await (
    await raw(t, '/.well-known/oauth-authorization-server/api/auth')
  ).json()) as { registration_endpoint: string };
  const res = await raw(t, new URL(meta.registration_endpoint).pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Runs authorize → consent → token for a signed-in user. Returns the token response. */
async function authorize(t: TestEnv, cookie: string, clientId: string) {
  const { verifier, challenge } = await pkce();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'openid profile email offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: `${ORIGIN}/mcp`,
  });
  const auth = await raw(t, `/api/auth/oauth2/authorize?${params}`, {
    headers: { Cookie: cookie },
    redirect: 'manual',
  });
  expect(auth.status).toBe(302);
  const consentUrl = new URL(auth.headers.get('Location')!, ORIGIN);
  expect(consentUrl.pathname).toBe('/oauth/consent');

  // What the consent page does: post the decision with the signed query it was opened with.
  const consent = await call(t, '/api/auth/oauth2/consent', {
    cookie,
    json: { accept: true, oauth_query: consentUrl.search.slice(1) },
  });
  expect(consent.status).toBe(200);
  const { url } = (await consent.json()) as { url: string };
  const callback = new URL(url);
  expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT);
  expect(callback.searchParams.get('state')).toBe('xyz');

  const token = await raw(t, '/api/auth/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code')!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp`,
    }),
  });
  expect(token.status).toBe(200);
  return (await token.json()) as {
    access_token: string;
    refresh_token?: string;
    token_type: string;
  };
}

async function connect(t: TestEnv, cookie: string) {
  const clientId = await register(t);
  const tokens = await authorize(t, cookie, clientId);
  return { clientId, ...tokens };
}

type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
};
async function tool(
  t: TestEnv,
  token: string,
  name: string,
  args: Record<string, unknown> = {}
) {
  const res = await rpc(t, token, 'tools/call', { name, arguments: args });
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: ToolResult }).result;
}

describe('OAuth discovery', () => {
  it('points the MCP resource at this instance as its authorization server', async () => {
    const t = makeEnv();
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await raw(t, path);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        resource: `${ORIGIN}/mcp`,
        authorization_servers: [ISSUER],
      });
    }
  });

  it('serves authorization-server metadata with PKCE and dynamic registration', async () => {
    const t = makeEnv();
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/api/auth',
    ]) {
      const meta = (await (await raw(t, path)).json()) as Record<
        string,
        unknown
      >;
      expect(meta).toMatchObject({
        issuer: ISSUER,
        authorization_endpoint: `${ORIGIN}/api/auth/oauth2/authorize`,
        token_endpoint: `${ORIGIN}/api/auth/oauth2/token`,
        registration_endpoint: `${ORIGIN}/api/auth/oauth2/register`,
      });
      expect(meta.code_challenge_methods_supported).toContain('S256');
    }
  });

  it('challenges /mcp without a token so clients can discover how to sign in', async () => {
    const t = makeEnv();
    const res = await rpc(t, null, 'initialize');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`
    );
    expect((await rpc(t, 'not-a-jwt', 'tools/list')).status).toBe(401);
  });
});

describe('OAuth 2.1 flow', () => {
  it('sends a signed-out user to the login page, then on to consent after sign-in', async () => {
    const t = makeEnv();
    await bootstrapAdmin(t);
    const clientId = await register(t);
    const { challenge } = await pkce();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: 'openid offline_access',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
      resource: `${ORIGIN}/mcp`,
    });
    const res = await raw(t, `/api/auth/oauth2/authorize?${params}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const login = new URL(res.headers.get('Location')!, ORIGIN);
    expect(login.pathname).toBe('/login');

    // The SPA's sign-in sends the signed query along (oauthProviderClient), and the
    // response says where to continue.
    const signIn = await call(t, '/api/auth/sign-in/username', {
      json: {
        username: 'octocat',
        password: 'password123',
        oauth_query: login.search.slice(1),
      },
    });
    expect(signIn.status).toBe(200);
    const body = (await signIn.json()) as { url?: string };
    expect(new URL(body.url!, ORIGIN).pathname).toBe('/oauth/consent');
  });

  it('issues a JWT access token bound to /mcp, plus a refresh token', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const tokens = await connect(t, admin);
    expect(tokens.token_type.toLowerCase()).toBe('bearer');
    expect(tokens.access_token.split('.')).toHaveLength(3);
    const payload = JSON.parse(
      atob(
        tokens.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
      )
    );
    expect(payload.aud).toContain(`${ORIGIN}/mcp`);
    expect(tokens.refresh_token).toBeTruthy();
  });

  it('refuses a denied consent', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const clientId = await register(t);
    const { challenge } = await pkce();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: 'openid',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${ORIGIN}/mcp`,
    });
    const auth = await raw(t, `/api/auth/oauth2/authorize?${params}`, {
      headers: { Cookie: admin },
      redirect: 'manual',
    });
    const consentUrl = new URL(auth.headers.get('Location')!, ORIGIN);
    const res = await call(t, '/api/auth/oauth2/consent', {
      cookie: admin,
      json: { accept: false, oauth_query: consentUrl.search.slice(1) },
    });
    const { url } = (await res.json()) as { url: string };
    expect(new URL(url).searchParams.get('error')).toBe('access_denied');
  });
});

describe('MCP server', () => {
  it('initializes and lists its tools', async () => {
    const t = makeEnv();
    const { access_token } = await connect(t, await bootstrapAdmin(t));
    const init = (await (
      await rpc(t, access_token, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      })
    ).json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.serverInfo.name).toBe('gitorange');
    const notified = await rpc(
      t,
      access_token,
      'notifications/initialized',
      undefined,
      undefined
    );
    expect(notified.status).toBe(202);
    const list = (await (await rpc(t, access_token, 'tools/list')).json()) as {
      result: {
        tools: { name: string; annotations: { readOnlyHint: boolean } }[];
      };
    };
    expect(
      list.result.tools.map((x) => [x.name, x.annotations.readOnlyHint])
    ).toEqual([
      ['gitorange_list_repositories', true],
      ['gitorange_get_repository', true],
      ['gitorange_create_repository', false],
    ]);
    const unknown = (await (
      await rpc(t, access_token, 'resources/list')
    ).json()) as {
      error: { code: number };
    };
    expect(unknown.error.code).toBe(-32601);
  });

  it('creates a repository as the signed-in user and finds it again', async () => {
    const t = makeEnv();
    const { access_token } = await connect(t, await bootstrapAdmin(t));
    const created = await tool(t, access_token, 'gitorange_create_repository', {
      name: 'from-claude',
      description: 'Made over MCP',
      add_readme: true,
    });
    expect(created.isError).toBeUndefined();
    expect(JSON.parse(created.content[0].text)).toMatchObject({
      full_name: 'octocat/from-claude',
      visibility: 'private',
      clone_url: `${ORIGIN}/octocat/from-claude.git`,
    });

    const list = await tool(t, access_token, 'gitorange_list_repositories', {
      query: 'claude',
    });
    expect(JSON.parse(list.content[0].text)).toMatchObject([
      { full_name: 'octocat/from-claude', can_push: true },
    ]);
    const got = await tool(t, access_token, 'gitorange_get_repository', {
      repository: 'octocat/from-claude',
    });
    expect(JSON.parse(got.content[0].text)).toMatchObject({
      full_name: 'octocat/from-claude',
      empty: false,
      branches: ['main'],
      latest_commit: { message: 'Initial commit' },
    });
  });

  it('reports bad input and conflicts as tool errors, and hides private repositories', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const bob = await addMember(t, admin, 'bob');
    await call(t, '/api/repos', { cookie: admin, json: { name: 'secret' } });
    const { access_token } = await connect(t, bob);

    const missing = await tool(
      t,
      access_token,
      'gitorange_create_repository',
      {}
    );
    expect(missing).toMatchObject({ isError: true });
    expect(missing.content[0].text).toContain('name is required');
    await tool(t, access_token, 'gitorange_create_repository', { name: 'dup' });
    const dup = await tool(t, access_token, 'gitorange_create_repository', {
      name: 'dup',
    });
    expect(dup.content[0].text).toContain(
      'already have a repository named dup'
    );

    const hidden = await tool(t, access_token, 'gitorange_get_repository', {
      repository: 'octocat/secret',
    });
    const absent = await tool(t, access_token, 'gitorange_get_repository', {
      repository: 'octocat/nope',
    });
    expect(hidden.isError).toBe(true);
    expect(hidden.content[0].text.replace('secret', 'X')).toBe(
      absent.content[0].text.replace('nope', 'X')
    );
    const unknownTool = await tool(
      t,
      access_token,
      'gitorange_delete_everything'
    );
    expect(unknownTool.isError).toBe(true);
  });

  it('stops accepting tokens once the user disconnects the app', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const { access_token, clientId } = await connect(t, admin);
    const apps = (await (
      await call(t, '/api/mcp/connections', { cookie: admin })
    ).json()) as { clientId: string; name: string }[];
    expect(apps).toMatchObject([{ clientId, name: 'Claude Code' }]);

    const res = await call(t, `/api/mcp/connections/${clientId}`, {
      cookie: admin,
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect((await rpc(t, access_token, 'tools/list')).status).toBe(401);
  });

  it('stops accepting tokens for a banned user', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const bob = await addMember(t, admin, 'bob');
    const { access_token } = await connect(t, bob);
    expect((await rpc(t, access_token, 'ping')).status).toBe(200);
    await t.env.DB.prepare(
      "UPDATE users SET banned = 1 WHERE username = 'bob'"
    ).run();
    expect((await rpc(t, access_token, 'ping')).status).toBe(401);
  });

  it('describes the server and its tools to signed-in members', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const res = await call(t, '/api/mcp', { cookie: admin });
    const body = (await res.json()) as { serverUrl: string; tools: unknown[] };
    expect(body.serverUrl).toBe(`${ORIGIN}/mcp`);
    expect(body.tools).toHaveLength(3);
    expect((await call(t, '/api/mcp')).status).toBe(401);
  });
});

describe('instance name', () => {
  it('turns APP_NAME into an MCP server id', () => {
    expect(mcpServerName('GitOrange')).toBe('gitorange');
    expect(mcpServerName('XY Space Git')).toBe('xy-space-git');
    expect(mcpServerName('  Café — Code! ')).toBe('cafe-code');
    expect(mcpServerName('!!!')).toBe('gitorange');
  });

  it('names the MCP server, discovery, and the web app after APP_NAME', async () => {
    const t = makeEnv();
    (t.env as { APP_NAME: string }).APP_NAME = 'XY Space Git';
    const admin = await bootstrapAdmin(t);
    expect(await (await call(t, '/api/setup/status')).json()).toMatchObject({
      appName: 'XY Space Git',
    });
    const resource = (await (
      await raw(t, '/.well-known/oauth-protected-resource/mcp')
    ).json()) as { resource_name: string };
    expect(resource.resource_name).toBe('XY Space Git');
    const page = (await (
      await call(t, '/api/mcp', { cookie: admin })
    ).json()) as {
      serverName: string;
    };
    expect(page.serverName).toBe('xy-space-git');

    const { access_token } = await connect(t, admin);
    const init = (await (await rpc(t, access_token, 'initialize')).json()) as {
      result: {
        serverInfo: { name: string; title: string };
        instructions: string;
      };
    };
    expect(init.result.serverInfo).toMatchObject({
      name: 'xy-space-git',
      title: 'XY Space Git',
    });
    expect(init.result.instructions).toMatch(/^XY Space Git is/);
  });
});
