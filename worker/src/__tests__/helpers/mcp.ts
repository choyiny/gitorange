/** OAuth 2.1 + MCP helpers: register a client, authorize it for a signed-in user, call /mcp. */
import { expect } from 'vitest';
import { app } from '../../index';
import { call, type TestEnv } from './app';

export const ORIGIN = 'http://test.local';
export const REDIRECT = 'http://127.0.0.1:33418/callback';

export function b64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

/** A raw request through the app, without the JSON/Origin defaults of `call`. */
export function raw(t: TestEnv, path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`${ORIGIN}${path}`, init), t.env, t.ctx);
}

export async function rpc(
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
export async function register(t: TestEnv, name = 'Claude Code') {
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
export async function authorize(t: TestEnv, cookie: string, clientId: string) {
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

  // As the consent page does: post the decision with its signed query.
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

export async function connect(
  t: TestEnv,
  cookie: string,
  name = 'Claude Code'
) {
  const clientId = await register(t, name);
  const tokens = await authorize(t, cookie, clientId);
  return { clientId, ...tokens };
}

export type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
};
export async function tool(
  t: TestEnv,
  token: string,
  name: string,
  args: Record<string, unknown> = {}
) {
  const res = await rpc(t, token, 'tools/call', { name, arguments: args });
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: ToolResult }).result;
}
