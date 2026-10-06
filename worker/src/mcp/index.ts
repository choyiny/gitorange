import { Hono, type Context } from 'hono';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
} from '../db/auth.schema';
import { mcpModerators } from '../db/app.schema';
import { mcpServerName } from '../lib/app-name';
import { instanceName } from '../lib/settings';
import type { AppEnv } from '../variables';
import { McpToolError } from './errors';
import {
  moderatorClientIds,
  moderatorFor,
  NOT_MODERATOR,
  setModerator,
} from './moderators';
import { getMcpSession } from './oauth-session';
import {
  MODERATOR_TOOL_DEFINITIONS,
  MODERATOR_TOOL_NAMES,
  TOOL_DEFINITIONS,
  TOOL_HANDLERS,
  type ToolContext,
} from './tools';

/** MCP server: stateless JSON-RPC 2.0 over Streamable HTTP at `POST /mcp`, tools only. */
const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const mcpRouter = new Hono<AppEnv>();

const baseURLOf = (c: Context<AppEnv>) =>
  (c.env.BASE_URL || new URL(c.req.url).origin).replace(/\/$/, '');

function unauthorized(c: Context<AppEnv>) {
  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    },
    401,
    {
      'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    }
  );
}
const rpcResult = (id: unknown, result: unknown) => ({
  jsonrpc: '2.0' as const,
  id: id ?? null,
  result,
});
const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  id: id ?? null,
  error: { code, message },
});

async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
) {
  const mod = TOOL_HANDLERS.get(name);
  if (!mod)
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    };
  try {
    return await mod.handler(args, ctx);
  } catch (e) {
    if (e instanceof McpToolError)
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    console.error('[mcp] tool error', name, e);
    return {
      isError: true,
      content: [{ type: 'text', text: 'Internal error' }],
    };
  }
}

// Tools-only: no server-initiated stream.
mcpRouter.get('/', (c) => c.text('Method Not Allowed', 405, { Allow: 'POST' }));
mcpRouter.delete('/', (c) => c.body(null, 405, { Allow: 'POST' }));

mcpRouter.post('/', async (c) => {
  const db = c.get('db');
  const baseURL = baseURLOf(c);
  const session = await getMcpSession(
    c.get('auth'),
    db,
    baseURL,
    c.req.raw.headers
  );
  if (!session) return unauthorized(c);
  // Whether this connection is a moderator: read on every call that needs it, so turning it off is immediate.
  const moderator = () => moderatorFor(db, session.user.id, session.clientId);

  const body = await c.req.json().catch(() => null);
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string')
    return c.json(rpcError(body?.id ?? null, -32600, 'Invalid Request'), 200);
  const { id, method, params } = body as {
    id?: unknown;
    method: string;
    params?: {
      name?: unknown;
      arguments?: unknown;
      protocolVersion?: unknown;
    };
  };

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const name = await instanceName(db, c.env);
      const isModerator = Boolean(await moderator());
      const asModerator = isModerator
        ? ' This connection is a moderator: with gitorange_approve_review_finding, ' +
          'gitorange_dismiss_change_request and gitorange_approve_pull_request it may approve findings for a ' +
          "person, dismiss agents' change requests and approve pull requests as the signed-in user. Read the " +
          'pull request with gitorange_get_pull_request first and pass the head_sha you reviewed.'
        : '';
      return c.json(
        rpcResult(id, {
          protocolVersion:
            typeof requested === 'string' &&
            SUPPORTED_VERSIONS.includes(requested)
              ? requested
              : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: mcpServerName(name),
            title: name,
            version: '1.0.0',
          },
          instructions:
            `${name} is a self-hosted, GitHub-style git server. Use these tools to find and create ` +
            'repositories and to work with pull requests: push a branch with git, open a pull request, then ' +
            'follow its checks and agent reviews with gitorange_get_pull_request. Merging is always rebase ' +
            'and merge. ' +
            (isModerator
              ? ''
              : 'Only a person can approve a review finding. ') +
            'Fix the change requests agents raise (follow_ups) by pushing. Requesting changes on a finding and similar tools act as the signed-in ' +
            'user, so only use them when the user explicitly asks, and never to work around a finding. ' +
            'Never ask the user to paste a personal access token into the conversation; have them run ' +
            'git commands that need one themselves.' +
            asModerator,
        })
      );
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return c.body(null, 202);
    case 'ping':
      return c.json(rpcResult(id, {}));
    case 'tools/list':
      return c.json(
        rpcResult(id, {
          tools: (await moderator())
            ? [...TOOL_DEFINITIONS, ...MODERATOR_TOOL_DEFINITIONS]
            : TOOL_DEFINITIONS,
        })
      );
    case 'tools/call': {
      const name = typeof params?.name === 'string' ? params.name : '';
      const args =
        params?.arguments && typeof params.arguments === 'object'
          ? (params.arguments as Record<string, unknown>)
          : {};
      // A moderator tool runs only for a moderator connection, checked now — before the handler, every call.
      const mod = MODERATOR_TOOL_NAMES.has(name) ? await moderator() : null;
      if (MODERATOR_TOOL_NAMES.has(name) && !mod)
        return c.json(
          rpcResult(id, {
            isError: true,
            content: [{ type: 'text', text: NOT_MODERATOR }],
          })
        );
      return c.json(
        rpcResult(
          id,
          await callTool(name, args, {
            db,
            env: c.env,
            user: session.user,
            baseURL,
            after: (work) => c.executionCtx.waitUntil(work),
            moderator: mod,
          })
        )
      );
    }
    default:
      if (id === undefined) return c.body(null, 202); // unknown notification
      return c.json(rpcError(id, -32601, `Method not found: ${method}`));
  }
});

// ── session API for the MCP settings page ────────────────────────────────────

export const mcpApiRouter = new Hono<AppEnv>();

/** The server URL and tool list, so the page always matches what /mcp serves. */
mcpApiRouter.get('/', async (c) =>
  c.json({
    serverUrl: `${baseURLOf(c)}/mcp`,
    serverName: mcpServerName(await instanceName(c.get('db'), c.env)),
    tools: TOOL_DEFINITIONS,
    moderatorTools: MODERATOR_TOOL_DEFINITIONS,
  })
);

/**
 * Where an app's sign-in returns to, to tell apart apps that registered the same name: the host of its first
 * http(s) redirect URI, or the scheme of an app-scheme one (`cursor://`).
 */
function redirectHost(uris: unknown): string | null {
  // better-auth's adapter stores the array already JSON-encoded, so drizzle's json mode hands back a string.
  let list = uris;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      list = [list];
    }
  }
  for (const u of Array.isArray(list) ? list : []) {
    try {
      const url = new URL(String(u));
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? url.hostname
        : `${url.protocol}//`;
    } catch {
      continue;
    }
  }
  return null;
}

/** Apps the user has approved, newest first. */
mcpApiRouter.get('/connections', async (c) => {
  const db = c.get('db');
  const userId = c.get('user')!.id;
  const [rows, moderators] = await Promise.all([
    db
      .select({
        clientId: oauthConsents.clientId,
        scopes: oauthConsents.scopes,
        createdAt: oauthConsents.createdAt,
        updatedAt: oauthConsents.updatedAt,
        name: oauthClients.name,
        uri: oauthClients.uri,
        redirectUris: oauthClients.redirectUris,
      })
      .from(oauthConsents)
      .innerJoin(
        oauthClients,
        eq(oauthClients.clientId, oauthConsents.clientId)
      )
      .where(eq(oauthConsents.userId, userId))
      .orderBy(desc(oauthConsents.updatedAt))
      .all(),
    moderatorClientIds(db, userId),
  ]);
  return c.json(
    rows.map((r) => ({
      clientId: r.clientId,
      name: r.name || 'Unnamed app',
      uri: r.uri,
      redirectHost: redirectHost(r.redirectUris),
      scopes: Array.isArray(r.scopes) ? r.scopes : [],
      connectedAt: (r.createdAt ?? r.updatedAt)?.toISOString() ?? null,
      moderator: moderators.has(r.clientId),
    }))
  );
});

/** Deletes the user's consent and tokens for an app; /mcp then rejects its JWTs at once. */
mcpApiRouter.delete('/connections/:clientId', async (c) => {
  const db = c.get('db');
  const userId = c.get('user')!.id;
  const clientId = c.req.param('clientId');
  const tokenRows = await db
    .select({ id: oauthRefreshTokens.id })
    .from(oauthRefreshTokens)
    .where(
      and(
        eq(oauthRefreshTokens.userId, userId),
        eq(oauthRefreshTokens.clientId, clientId)
      )
    )
    .all();
  await db.batch([
    db
      .delete(oauthAccessTokens)
      .where(
        and(
          eq(oauthAccessTokens.userId, userId),
          eq(oauthAccessTokens.clientId, clientId)
        )
      ),
    ...(tokenRows.length
      ? [
          db.delete(oauthRefreshTokens).where(
            inArray(
              oauthRefreshTokens.id,
              tokenRows.map((t) => t.id)
            )
          ),
        ]
      : []),
    db
      .delete(mcpModerators)
      .where(
        and(
          eq(mcpModerators.userId, userId),
          eq(mcpModerators.clientId, clientId)
        )
      ),
    db
      .delete(oauthConsents)
      .where(
        and(
          eq(oauthConsents.userId, userId),
          eq(oauthConsents.clientId, clientId)
        )
      ),
  ]);
  return c.json({ ok: true });
});

/**
 * Marks one of the user's connected apps as a moderator (or not). Session only: `/api/mcp` sits behind
 * requireAuth, whose user comes from the session cookie, so an MCP access token can't reach it.
 */
for (const [method, on] of [
  ['put', true],
  ['delete', false],
] as const)
  mcpApiRouter[method]('/connections/:clientId/moderator', async (c) => {
    const ok = await setModerator(
      c.get('db'),
      c.get('user')!.id,
      c.req.param('clientId'),
      on
    );
    if (!ok) return c.json({ error: 'Not Found' }, 404);
    return c.json({ ok: true as const, moderator: on });
  });
