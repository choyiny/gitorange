import { describe, expect, it } from 'vitest';
import { app } from '../index';
import { mcpServerName } from '../lib/app-name';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import type { StepRunner } from '../merge/resolution';
import { executeClassification } from '../review/classify';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
  type TestEnv,
} from './helpers/app';
import { commitPaths } from './helpers/seed';

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
      ['gitorange_list_pull_requests', true],
      ['gitorange_get_pull_request', true],
      ['gitorange_create_pull_request', false],
      ['gitorange_comment_pull_request', false],
      ['gitorange_merge_pull_request', false],
      ['gitorange_get_run_logs', true],
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
    expect(body.tools).toHaveLength(9);
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

describe('MCP pull request tools', () => {
  /** A repository with main (optionally holding review.yml) and a pushed feature branch. */
  async function repoWithBranch(policy?: string) {
    const t = makeEnv({ actions: true });
    const admin = await bootstrapAdmin(t);
    const { access_token } = await connect(t, admin);
    await tool(t, access_token, 'gitorange_create_repository', {
      name: 'app',
      visibility: 'internal',
    });
    const repo = [...t.fake.repos.values()][0];
    const base = {
      'README.md': '# app\n',
      ...(policy ? { '.gitorange/review.yml': policy } : {}),
    };
    const main = await commitPaths(repo, 'main', base, 'Initial commit');
    repo.refs.set('refs/heads/feature', main);
    await commitPaths(
      repo,
      'feature',
      { ...base, 'src/a.ts': 'export const a = 1;\n' },
      'Add a'
    );
    return { t, admin, token: access_token, repo };
  }

  it('opens, inspects, comments on, and merges a pull request', async () => {
    const { t, token, repo } = await repoWithBranch();
    const opened = await tool(t, token, 'gitorange_create_pull_request', {
      repository: 'octocat/app',
      head: 'feature',
      title: 'Add a',
      body: 'Adds `a`.',
    });
    expect(opened.isError).toBeUndefined();
    expect(JSON.parse(opened.content[0].text)).toEqual({
      number: 1,
      title: 'Add a',
      base: 'main', // the default branch when base is omitted
      head: 'feature',
      url: `${ORIGIN}/octocat/app/pull/1`,
    });
    await settle(t);

    const again = await tool(t, token, 'gitorange_create_pull_request', {
      repository: 'octocat/app',
      head: 'feature',
      title: 'Again',
    });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toMatch(/already exists .*#1/);

    const listed = JSON.parse(
      (
        await tool(t, token, 'gitorange_list_pull_requests', {
          repository: 'octocat/app',
        })
      ).content[0].text
    );
    expect(listed).toMatchObject([
      { number: 1, state: 'open', author: 'octocat' },
    ]);

    const commented = await tool(t, token, 'gitorange_comment_pull_request', {
      repository: 'octocat/app',
      number: 1,
      body: 'Looks good.',
    });
    expect(commented.isError).toBeUndefined();

    const got = JSON.parse(
      (
        await tool(t, token, 'gitorange_get_pull_request', {
          repository: 'octocat/app',
          number: 1,
        })
      ).content[0].text
    );
    expect(got).toMatchObject({
      number: 1,
      description: 'Adds `a`.',
      state: 'open',
      commits: [{ message: 'Add a' }],
      merge: {
        nothing_to_merge: false,
        conflicts: [],
        ai_conflict_resolution: null,
      },
      auto_merge: null, // no .gitorange/review.yml
      recent_comments: [{ author: 'octocat', body: 'Looks good.' }],
      can_merge: true,
    });

    const merged = await tool(t, token, 'gitorange_merge_pull_request', {
      repository: 'octocat/app',
      number: 1,
    });
    expect(merged.isError).toBeUndefined();
    expect(merged.content[0].text).toMatch(
      /^Merged #1 into main as [0-9a-f]{7}/
    );
    const tip = repo.parseCommit(repo.refs.get('refs/heads/main')!)!;
    expect(tip.message).toBe('Add a (#1)');
    const after = JSON.parse(
      (
        await tool(t, token, 'gitorange_get_pull_request', {
          repository: 'octocat/app',
          number: 1,
        })
      ).content[0].text
    );
    expect(after).toMatchObject({
      state: 'merged',
      merged: { by: 'octocat', automatically: false },
    });
  });

  it('refuses to merge past review flags a person has not approved', async () => {
    const { t, token } = await repoWithBranch(
      'checks:\n  require: none\nhuman_review:\n  questions:\n    data_model:\n      ask: Does this change stored data?\n      above: 0.3\n'
    );
    await tool(t, token, 'gitorange_create_pull_request', {
      repository: 'octocat/app',
      head: 'feature',
      title: 'Add a',
    });
    await settle(t);
    const started = t.actions.resolutions.find(
      (r) => (r.params as { classificationId?: string }).classificationId
    )!;
    // Keep it open: an approval would otherwise let it merge on its own.
    await t.env.DB.prepare(
      'UPDATE pull_requests SET auto_merge_disabled_at = 1'
    ).run();
    await executeClassification(
      {
        env: t.env,
        db: drizzle(t.env.DB, { schema }),
        step: {
          do: async (_n: string, a: unknown, b?: unknown) =>
            ((b ?? a) as () => Promise<unknown>)(),
        } as unknown as StepRunner,
        models: {
          summarize: async (f) => `Changes ${f.path}.`,
          classify: async () => ({ data_model: { type: 'noul', value: 0.9 } }),
          investigate: async () => ({
            detail: 'Stores a new field.',
            diagram: null,
            snippets: [],
            paths: [],
          }),
        },
      },
      (started.params as { classificationId: string }).classificationId
    );

    const got = JSON.parse(
      (
        await tool(t, token, 'gitorange_get_pull_request', {
          repository: 'octocat/app',
          number: 1,
        })
      ).content[0].text
    );
    expect(got.auto_merge).toMatchObject({
      state: 'disabled',
      flags: [
        {
          title: 'Does this change stored data?',
          finding: 'Stores a new field.',
          approved_by: null,
        },
      ],
    });
    const refused = await tool(t, token, 'gitorange_merge_pull_request', {
      repository: 'octocat/app',
      number: 1,
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(
      /1 review flag waiting for a person's approval/
    );
  });

  it('needs push access to open or merge, and hides repositories you cannot read', async () => {
    const { t, admin } = await repoWithBranch();
    const reader = await addMember(t, admin, 'grace');
    const { access_token } = await connect(t, reader);
    const open = await tool(t, access_token, 'gitorange_create_pull_request', {
      repository: 'octocat/app',
      head: 'feature',
      title: 'Nope',
    });
    expect(open.isError).toBe(true);
    expect(open.content[0].text).toMatch(/push access/);
    const missing = await tool(t, access_token, 'gitorange_get_pull_request', {
      repository: 'octocat/nope',
      number: 1,
    });
    expect(missing.content[0].text).toMatch(
      /No repository named octocat\/nope/
    );
  });
});

describe('MCP run logs', () => {
  it('returns the logs of failed steps, or one chosen step, for a run', async () => {
    const t = makeEnv({ actions: true });
    const admin = await bootstrapAdmin(t);
    const { access_token } = await connect(t, admin);
    await tool(t, access_token, 'gitorange_create_repository', {
      name: 'app',
      visibility: 'internal',
    });
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{
      id: string;
    }>())!.id;
    const log = (n: number) => `actions/${repoId}/run1/job1/${n}.log`;
    await t.env.DB.batch([
      t.env.DB.prepare(
        `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title, status, conclusion, created_at)
         VALUES ('run1', ?, 7, '.github/workflows/ci.yml', 'CI', 'pull_request', 'refs/pull/1/head', 'abc', 'x', 'completed', 'failure', 0)`
      ).bind(repoId),
      t.env.DB.prepare(
        `INSERT INTO workflow_jobs (id, run_id, job_key, name, runs_on, needs, status, conclusion)
         VALUES ('job1', 'run1', 'test', 'test', 'ubuntu-latest', '[]', 'completed', 'failure')`
      ),
      ...[
        [1, 'Set up job', 'success'],
        [2, 'Install', 'success'],
        [3, 'Build', 'failure'],
        [4, 'Test', 'skipped'],
      ].map(([n, name, conclusion]) =>
        t.env.DB.prepare(
          `INSERT INTO workflow_steps (id, job_id, number, name, status, conclusion, log_r2_key)
           VALUES (?, 'job1', ?, ?, 'completed', ?, ?)`
        ).bind(
          `s${n}`,
          n,
          name,
          conclusion,
          conclusion === 'skipped' ? null : log(n as number)
        )
      ),
    ]);
    await t.env.ACTIONS_LOGS.put(log(2), 'yarn install\nDone in 3s.\n');
    await t.env.ACTIONS_LOGS.put(
      log(3),
      Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n') +
        '\nError: Failed to load native binding\n'
    );

    const failed = JSON.parse(
      (
        await tool(t, access_token, 'gitorange_get_run_logs', {
          repository: 'octocat/app',
          run_number: 7,
        })
      ).content[0].text
    );
    expect(failed).toMatchObject({ workflow: 'CI', conclusion: 'failure' });
    const job = failed.jobs[0];
    expect(job.steps.map((s: { name: string }) => s.name)).toEqual([
      'Set up job',
      'Install',
      'Build',
      'Test',
    ]);
    // Only the failed step's log, and only its end.
    expect(job.logs).toHaveLength(1);
    expect(job.logs[0]).toMatchObject({ step: 3, name: 'Build' });
    expect(job.logs[0].log).toContain('Error: Failed to load native binding');
    expect(job.logs[0].log).toContain('showing the last 300 of 501 lines');
    expect(job.logs[0].log).not.toContain('line 1\n');

    const chosen = JSON.parse(
      (
        await tool(t, access_token, 'gitorange_get_run_logs', {
          repository: 'octocat/app',
          run_number: 7,
          job: 'test',
          step: 2,
        })
      ).content[0].text
    );
    expect(chosen.jobs[0].logs).toEqual([
      { step: 2, name: 'Install', log: 'yarn install\nDone in 3s.' },
    ]);

    const missing = await tool(t, access_token, 'gitorange_get_run_logs', {
      repository: 'octocat/app',
      run_number: 99,
    });
    expect(missing.isError).toBe(true);
  });
});
