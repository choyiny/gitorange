import { describe, expect, it } from 'vitest';
import { mcpServerName } from '../lib/app-name';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
  type TestEnv,
} from './helpers/app';
import { commitPaths } from './helpers/seed';
import { moved, runRebases } from './helpers/rebase';
import {
  AGENT_MD,
  agentModels,
  invitedAgent,
  runReviews,
  startReview,
} from './helpers/reviews';
import {
  ORIGIN,
  REDIRECT,
  authorize,
  connect,
  pkce,
  raw,
  register,
  rpc,
  tool,
} from './helpers/mcp';

// The provider upgrades a non-loopback http issuer to https.
const ISSUER = 'https://test.local/api/auth';

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

    // Sign-in sends the signed query (oauthProviderClient); the response says where to continue.
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
      ['gitorange_get_repository_insights', true],
      ['gitorange_create_repository', false],
      ['gitorange_get_usage', true],
      ['gitorange_list_pull_requests', true],
      ['gitorange_get_pull_request', true],
      ['gitorange_get_pull_tree', true],
      ['gitorange_create_pull_request', false],
      ['gitorange_comment_pull_request', false],
      ['gitorange_merge_pull_request', false],
      ['gitorange_retry_rebase', false],
      ['gitorange_request_changes_on_review_flag', false],
      ['gitorange_get_run_logs', true],
      ['gitorange_list_agents', true],
      ['gitorange_list_repository_agents', true],
      ['gitorange_invite_agent', false],
      ['gitorange_remove_agent', false],
      ['gitorange_create_agent', false],
    ]);
    const unknown = (await (
      await rpc(t, access_token, 'resources/list')
    ).json()) as {
      error: { code: number };
    };
    expect(unknown.error.code).toBe(-32601);
  });

  it('reports usage and cost to site admins only', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const { access_token } = await connect(t, admin);
    const ok = await tool(t, access_token, 'gitorange_get_usage', {
      month: '2026-09',
    });
    expect(ok.isError).toBeUndefined();
    const body = JSON.parse(ok.content[0].text);
    expect(body).toMatchObject({
      month: '2026-09',
      cloudflare_analytics_configured: false,
      plan_fee_usd_account_wide: 5,
      web_url: `${ORIGIN}/admin/usage?month=2026-09`,
    });
    expect(body.lines.length).toBeGreaterThan(5);
    const bad = await tool(t, access_token, 'gitorange_get_usage', {
      month: 'September',
    });
    expect(bad.isError).toBe(true);

    const bob = await addMember(t, admin, 'bob');
    const { access_token: bobToken } = await connect(t, bob);
    const denied = await tool(t, bobToken, 'gitorange_get_usage');
    expect(denied).toMatchObject({ isError: true });
    expect(denied.content[0].text).toContain('site admins');
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
      protected_branches: [],
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

  it('refuses tokens whose user is an agent', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const bob = await addMember(t, admin, 'bob');
    const { access_token } = await connect(t, bob);
    expect((await rpc(t, access_token, 'ping')).status).toBe(200);
    // An agent can't get here (no sessions, so no consent); mark bob as one to pin the check itself.
    await t.env.DB.prepare(
      "INSERT INTO agents (user_id, name, bio, trigger_ask, trigger_above, engine, created_at) SELECT id, 'Bob', '', 'Q?', 0.5, 'pass', 0 FROM users WHERE username = 'bob'"
    ).run();
    expect((await rpc(t, access_token, 'ping')).status).toBe(401);
  });

  it('describes the server and its tools to signed-in members', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const res = await call(t, '/api/mcp', { cookie: admin });
    const body = (await res.json()) as { serverUrl: string; tools: unknown[] };
    expect(body.serverUrl).toBe(`${ORIGIN}/mcp`);
    expect(body.tools).toHaveLength(19);
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
    // Flag tools act as the user: only on their explicit request.
    expect(init.result.instructions).toMatch(
      /act as the signed-in user, so only use them when the user explicitly asks/
    );
    expect(init.result.instructions).not.toMatch(/web UI/);
    expect(init.result.instructions).not.toContain('reset --hard');
    expect(init.result.instructions).toContain(
      'rebase your local commits onto origin/<branch> (`git fetch && git rebase --onto origin/<branch> <old head>`) before you push again'
    );
  });
});

describe('MCP pull request tools', () => {
  /** A repository with main and a pushed feature branch. */
  async function repoWithBranch() {
    const t = makeEnv({ actions: true });
    const admin = await bootstrapAdmin(t);
    const { access_token } = await connect(t, admin);
    await tool(t, access_token, 'gitorange_create_repository', {
      name: 'app',
      visibility: 'internal',
    });
    const repo = [...t.fake.repos.values()][0];
    const base = { 'README.md': '# app\n' };
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

  it('tells the agent to rebase its local commits onto the branch GitOrange rebased', async () => {
    const { t, token, repo } = await repoWithBranch();
    await tool(t, token, 'gitorange_create_pull_request', {
      repository: 'octocat/app',
      head: 'feature',
      title: 'Add a',
    });
    const old = repo.refs.get('refs/heads/feature')!;
    const main = repo.refs.get('refs/heads/main')!;
    await commitPaths(
      repo,
      'main',
      { 'README.md': '# app\n', 'z.txt': 'z\n' },
      'Main moves'
    );
    await moved(t, 'main', main);
    await runRebases(t);
    const now = repo.refs.get('refs/heads/feature')!;
    const get = async () =>
      JSON.parse(
        (
          await tool(t, token, 'gitorange_get_pull_request', {
            repository: 'octocat/app',
            number: 1,
          })
        ).content[0].text
      );
    expect((await get()).rebased).toEqual({
      from: old,
      to: now,
      note: `GitOrange rebased this branch (${old.slice(0, 7)} → ${now.slice(0, 7)}); run \`git fetch && git rebase --onto origin/feature ${old}\` before you push again (it keeps your unpushed commits).`,
    });
    // Once the agent pushes on top, the note goes.
    await commitPaths(
      repo,
      'feature',
      {
        'README.md': '# app\n',
        'z.txt': 'z\n',
        'src/a.ts': 'export const a = 2;\n',
      },
      'More'
    );
    expect((await get()).rebased).toBeNull();
  });

  it('a merge that rebased first tells the agent how to keep its unpushed commits', async () => {
    const { t, admin, token, repo } = await repoWithBranch();
    await tool(t, token, 'gitorange_create_pull_request', {
      repository: 'octocat/app',
      head: 'feature',
      title: 'Add a',
    });
    await call(t, '/api/repos/octocat/app/pulls/1/approval', {
      cookie: admin,
      method: 'POST',
    });
    await settle(t);
    const old = repo.refs.get('refs/heads/feature')!;
    // Main gains a pull_request workflow: the rebased head has checks to wait for, so landing stops after rebasing.
    await commitPaths(
      repo,
      'main',
      {
        'README.md': '# app\n',
        '.github/workflows/ci.yml':
          'on:\n  pull_request:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
      },
      'Main moves'
    );
    const refused = await tool(t, token, 'gitorange_merge_pull_request', {
      repository: 'octocat/app',
      number: 1,
    });
    const now = repo.refs.get('refs/heads/feature')!;
    expect(now).not.toBe(old);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain(
      `run \`git fetch && git rebase --onto origin/feature ${old}\` before you push again`
    );
    expect(refused.content[0].text).not.toContain('reset --hard');
  });

  it('says whose move it is, and lists what needs the agent', async () => {
    const { t, admin, token, repo } = await repoWithBranch();
    await tool(t, token, 'gitorange_create_pull_request', {
      repository: 'octocat/app',
      head: 'feature',
      title: 'Add a',
    });
    await call(t, '/api/repos/octocat/app/pulls/1/approval', {
      cookie: admin,
      method: 'POST',
    });
    const head = repo.refs.get('refs/heads/feature')!;
    await t.env.DB.prepare(
      `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title, status, conclusion, created_at)
       SELECT 'r1', id, 9, 'ci.yml', 'CI', 'pull_request', 'x', ?, 'x', 'completed', 'failure', 0 FROM repositories`
    )
      .bind(head)
      .run();
    const got = JSON.parse(
      (
        await tool(t, token, 'gitorange_get_pull_request', {
          repository: 'octocat/app',
          number: 1,
        })
      ).content[0].text
    );
    expect(got).toMatchObject({
      state: 'open',
      pull_state: 'agent_followup',
      reasons: [{ kind: 'check_failed', run_number: 9 }],
    });
    const mine = JSON.parse(
      (
        await tool(t, token, 'gitorange_list_pull_requests', {
          repository: 'octocat/app',
          state: 'agent_followup',
        })
      ).content[0].text
    );
    expect(mine).toMatchObject([
      { number: 1, state: 'open', pull_state: 'agent_followup' },
    ]);
    const ready = JSON.parse(
      (
        await tool(t, token, 'gitorange_list_pull_requests', {
          repository: 'octocat/app',
          state: 'ready',
        })
      ).content[0].text
    );
    expect(ready).toEqual([]);
    const bad = await tool(t, token, 'gitorange_list_pull_requests', {
      repository: 'octocat/app',
      state: 'sleepy',
    });
    expect(bad.isError).toBe(true);
  });

  it('still lists closed, merged, and all pull requests by their state', async () => {
    const { t, admin, token, repo } = await repoWithBranch();
    for (const head of ['feature', 'two', 'three']) {
      if (head !== 'feature') {
        repo.refs.set(`refs/heads/${head}`, repo.refs.get('refs/heads/main')!);
        await commitPaths(repo, head, { [`${head}.txt`]: `${head}\n` }, head);
      }
      await tool(t, token, 'gitorange_create_pull_request', {
        repository: 'octocat/app',
        head,
        title: head,
      });
    }
    await settle(t);
    await call(t, '/api/repos/octocat/app/pulls/1/approval', {
      cookie: admin,
      method: 'POST',
    });
    await call(t, '/api/repos/octocat/app/pulls/2', {
      cookie: admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    await t.env.DB.prepare(
      "UPDATE pull_requests SET state = 'merged', merged_at = 0 WHERE number = 3"
    ).run();
    const list = async (state?: string) =>
      (
        JSON.parse(
          (
            await tool(t, token, 'gitorange_list_pull_requests', {
              repository: 'octocat/app',
              ...(state ? { state } : {}),
            })
          ).content[0].text
        ) as { number: number; state: string; pull_state: string | null }[]
      )
        .map((p) => [p.number, p.state, p.pull_state])
        .sort((a, b) => Number(a[0]) - Number(b[0]));
    expect(await list('closed')).toEqual([[2, 'closed', null]]);
    expect(await list('merged')).toEqual([[3, 'merged', null]]);
    expect(await list()).toEqual([[1, 'open', 'ready']]);
    expect(await list('all')).toEqual([
      [1, 'open', 'ready'],
      [2, 'closed', null],
      [3, 'merged', null],
    ]);
  });

  it('opens, inspects, comments on, and merges a pull request', async () => {
    const { t, admin, token, repo } = await repoWithBranch();
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
        behind: false,
        rebase_onto: 'main',
        ai_resolving: null,
        rebase_conflict: null,
      },
      auto_merge: null, // no agent is invited
      reviewers: [],
      follow_ups: [],
      recent_comments: [{ author: 'octocat', body: 'Looks good.' }],
      can_merge: true,
    });

    // No agent reviews this repository: a person approves (in the web UI) before an agent may merge.
    await call(t, '/api/repos/octocat/app/pulls/1/approval', {
      cookie: admin,
      method: 'POST',
    });
    const merged = await tool(t, token, 'gitorange_merge_pull_request', {
      repository: 'octocat/app',
      number: 1,
    });
    expect(merged.isError).toBeUndefined();
    expect(merged.content[0].text).toMatch(
      /^Merged #1 into main: it is now at [0-9a-f]{7}/
    );
    const tip = repo.refs.get('refs/heads/main')!;
    expect(tip).toBe(repo.refs.get('refs/heads/feature')); // a fast-forward: the branch's own commit
    expect(repo.parseCommit(tip)!.message).toBe('Add a');
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
      merged: { by: 'octocat', automatically: false, commit: tip },
    });
  });

  /** An open pull request #1 that @secagent reviewed: one finding for a person, one change request. */
  async function reviewedPull() {
    const { t, admin, token } = await repoWithBranch();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    await tool(t, token, 'gitorange_create_pull_request', {
      repository: 'octocat/app',
      head: 'feature',
      title: 'Add a',
    });
    await startReview(t);
    await runReviews(
      t,
      agentModels({
        review: () => ({
          verdict: 'findings',
          summary: 'Two concerns.',
          findings: [
            {
              kind: 'needs_person',
              title: 'New export',
              detail: 'Exports a new constant.',
              changes: [],
              diagram: null,
              snippets: [],
              paths: ['src/a.ts'],
            },
            {
              kind: 'change_requested',
              title: 'Name it',
              detail: 'Rename a to answer.',
              changes: [],
              diagram: null,
              snippets: [],
              paths: ['src/a.ts'],
            },
          ],
        }),
      }).models
    );
    return { t, admin, token };
  }

  it('reports reviewers, findings by kind, and change requests as follow-ups; merging waits for a person', async () => {
    const { t, admin, token } = await reviewedPull();
    const got = JSON.parse(
      (
        await tool(t, token, 'gitorange_get_pull_request', {
          repository: 'octocat/app',
          number: 1,
        })
      ).content[0].text
    );
    expect(got.reviewers).toMatchObject([
      {
        agent: 'secagent',
        status: 'changes_requested',
        requested: true,
        probability: 0.9,
        findings: [
          { kind: 'needs_person', title: 'New export', state: 'open' },
          { kind: 'change_requested', title: 'Name it', state: 'open' },
        ],
      },
    ]);
    expect(got.follow_ups).toMatchObject([
      {
        agent: 'secagent',
        title: 'Name it',
        instructions: expect.stringContaining('Rename a to answer.'),
      },
    ]);
    expect(got.approved_by).toEqual([]);
    expect(got.reasons.map((r: { kind: string }) => r.kind)).toContain(
      'agent_changes_requested'
    );
    const refused = await tool(t, token, 'gitorange_merge_pull_request', {
      repository: 'octocat/app',
      number: 1,
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(
      /People approve in GitOrange's web UI, or through a moderator app/
    );
    // A person approves the commit in the web UI; the agent's change request still holds it.
    await call(t, '/api/repos/octocat/app/pulls/1/approval', {
      cookie: admin,
      method: 'POST',
    });
    await settle(t); // the approval's auto-merge attempt finishes (held) before the agent tries
    const held = await tool(t, token, 'gitorange_merge_pull_request', {
      repository: 'octocat/app',
      number: 1,
    });
    expect(held.isError).toBe(true);
    expect(held.content[0].text).toMatch(/@secagent requested 1 change/);
    // Once a person dismisses it, the approval counts: auto-merge lands it (agents review this repository).
    await call(
      t,
      `/api/repos/octocat/app/pulls/1/review/flags/${got.reviewers[0].findings[1].id}/approve`,
      { cookie: admin, method: 'POST' }
    );
    await settle(t);
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
      merged: { automatically: true },
    });
  });

  it('cannot approve over MCP, and requests changes only on findings for a person', async () => {
    const { t, token } = await reviewedPull();
    const got = JSON.parse(
      (
        await tool(t, token, 'gitorange_get_pull_request', {
          repository: 'octocat/app',
          number: 1,
        })
      ).content[0].text
    );
    const [person, change] = got.reviewers[0].findings;
    const approve = await tool(t, token, 'gitorange_approve_review_flag', {
      repository: 'octocat/app',
      number: 1,
      flag_id: person.id,
    });
    expect(approve.isError).toBe(true);
    expect(approve.content[0].text).toBe(
      'Unknown tool: gitorange_approve_review_flag'
    );
    const ok = await tool(
      t,
      token,
      'gitorange_request_changes_on_review_flag',
      {
        repository: 'octocat/app',
        number: 1,
        flag_id: person.id,
        note: 'Not yet.',
      }
    );
    expect(ok.isError).toBeFalsy();
    const no = await tool(
      t,
      token,
      'gitorange_request_changes_on_review_flag',
      {
        repository: 'octocat/app',
        number: 1,
        flag_id: change.id,
      }
    );
    expect(no.isError).toBe(true);
  });

  it('refuses to request changes for a member who can only read', async () => {
    const { t, admin } = await reviewedPull();
    const db = t.env.DB;
    const flagId = (await db
      .prepare(`SELECT id FROM pr_review_flags WHERE kind = 'needs_person'`)
      .first<{ id: string }>())!.id;
    const reader = await addMember(t, admin, 'grace');
    const { access_token } = await connect(t, reader);
    const denied = await tool(
      t,
      access_token,
      'gitorange_request_changes_on_review_flag',
      { repository: 'octocat/app', number: 1, flag_id: flagId, note: 'no' }
    );
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/permission/);
    expect(
      await db
        .prepare(
          'SELECT changes_requested_at AS at FROM pr_review_flags WHERE id = ?'
        )
        .bind(flagId)
        .first()
    ).toEqual({ at: null });
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

describe('stacking tools', () => {
  it('reports the tree and a PR’s stack, and hides private repos', async () => {
    const t = makeEnv({ actions: true });
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'private' },
    });
    const repo = [...t.fake.repos.values()][0];
    const main = await commitPaths(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    repo.refs.set('refs/heads/one', main);
    await commitPaths(repo, 'one', { 'a.txt': 'A\n' }, 'One');
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'One', body: '', base: 'main', head: 'one' },
    });
    await settle(t);
    const { access_token } = await connect(t, admin);
    const tree = await tool(t, access_token, 'gitorange_get_pull_tree', {
      repository: 'octocat/app',
    });
    const view = JSON.parse(tree.content[0].text);
    expect(view.stacking).toBeUndefined();
    expect(view).toMatchObject({
      targets: [{ branch: 'main', pulls: [{ number: 1, parent: null }] }],
    });
    const pr = await tool(t, access_token, 'gitorange_get_pull_request', {
      repository: 'octocat/app',
      number: 1,
    });
    expect(JSON.parse(pr.content[0].text)).toMatchObject({
      base: 'main',
      land_target: 'main',
    });
    expect(JSON.parse(pr.content[0].text).stack).toMatchObject({
      parent: null,
      waits_on: [],
      pending: [],
      checking: false,
    });
    const bob = await addMember(t, admin, 'bob');
    const bobs = await connect(t, bob);
    const hidden = await tool(t, bobs.access_token, 'gitorange_get_pull_tree', {
      repository: 'octocat/app',
    });
    expect(hidden.isError).toBe(true);
  });
  it('reports accounting, ordering and the branch to rebase onto', async () => {
    const t = makeEnv({ actions: true });
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'private' },
    });
    const repo = [...t.fake.repos.values()][0];
    const files = { 'a.txt': 'a\n' };
    const main = await commitPaths(repo, 'main', files, 'base');
    for (const [branch, title] of [
      ['one', 'One'],
      ['two', 'Two'],
      ['three', 'Three'],
    ]) {
      repo.refs.set(`refs/heads/${branch}`, main);
      await commitPaths(
        repo,
        branch,
        { ...files, [`${branch}.txt`]: `${branch}\n` },
        title
      );
      await call(t, '/api/repos/octocat/app/pulls', {
        cookie: admin,
        json: { title, body: '', base: 'main', head: branch },
      });
    }
    await settle(t);
    const id = (n: number) =>
      `(SELECT id FROM pull_requests WHERE number = ${n})`;
    const edge = (
      a: number,
      b: number,
      slot: string,
      kind: string,
      forPr: number | null,
      accounted: boolean
    ) =>
      t.env.DB.prepare(
        `INSERT INTO pr_edges (id, repository_id, land_target, pr_a_id, pr_b_id, slot, for_pr_id, a_head, b_head,
                               stage, kind, prerequisite, reason, instructions, accounted_for_at, created_at, updated_at)
         SELECT 'e${a}${b}${slot}', repository_id, 'main', ${id(a)}, ${id(b)}, '${slot}',
                ${forPr ? id(forPr) : 'NULL'}, 'x', 'x', 'done', '${kind}', 'a', 'Because.', 'Do it.',
                ${accounted ? 1 : 'NULL'}, 0, 0
           FROM pull_requests WHERE number = 1`
      ).run();
    await edge(1, 2, 'pair', 'must_account_for', null, false);
    await edge(1, 3, 'pair', 'must_account_for', null, true);
    await edge(2, 3, 'order', 'ordered_after', 3, false);
    const { access_token } = await connect(t, admin);
    const pr = JSON.parse(
      (
        await tool(t, access_token, 'gitorange_get_pull_request', {
          repository: 'octocat/app',
          number: 3,
        })
      ).content[0].text
    );
    expect(pr.stack.parent).toMatchObject({
      number: 2,
      kind: 'ordered_after',
      for_pr: 3,
      accounted: false,
    });
    expect(pr.stack.must_account_for).toMatchObject([
      { number: 1, accounted: true, rebase_first: 'one' },
    ]);
    const tree = JSON.parse(
      (
        await tool(t, access_token, 'gitorange_get_pull_tree', {
          repository: 'octocat/app',
        })
      ).content[0].text
    );
    const two = tree.targets[0].pulls.find(
      (p: { number: number }) => p.number === 2
    );
    expect(two.must_account_for).toMatchObject([
      { number: 1, accounted: false, rebase_first: 'one' },
    ]);
    expect(two.parent).toMatchObject({ number: 1, accounted: false });
    expect(two.parent).not.toHaveProperty('for_pr');
  });
});
