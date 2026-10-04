import { Hono, type Context } from 'hono';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
} from '../db/auth.schema';
import { appName, mcpServerName } from '../lib/app-name';
import type { AppEnv } from '../variables';
import { McpToolError } from './errors';
import { getMcpSession } from './oauth-session';
import { TOOL_DEFINITIONS, TOOL_HANDLERS, type ToolContext } from './tools';

/**
 * GitOrange's MCP server: JSON-RPC 2.0 over Streamable HTTP at `POST /mcp`, stateless, tools only.
 * Authenticated with OAuth 2.1 access tokens issued by this instance's better-auth.
 */
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

// No server-initiated stream: a tools-only server never pushes.
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
      return c.json(
        rpcResult(id, {
          protocolVersion:
            typeof requested === 'string' &&
            SUPPORTED_VERSIONS.includes(requested)
              ? requested
              : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: mcpServerName(appName(c.env)),
            title: appName(c.env),
            version: '1.0.0',
          },
          instructions:
            `${appName(c.env)} is a self-hosted, GitHub-style git server. Use these tools to find and create ` +
            'repositories and to work with pull requests: push a branch with git, open a pull request, then ' +
            'follow its checks and auto-merge review with gitorange_get_pull_request. Merging is always rebase ' +
            'and merge. Review flags need a person to approve them in the web UI; never try to work around ' +
            'them. Never ask the user to paste a personal access token into the conversation; have them run ' +
            'git commands that need one themselves.',
        })
      );
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return c.body(null, 202);
    case 'ping':
      return c.json(rpcResult(id, {}));
    case 'tools/list':
      return c.json(rpcResult(id, { tools: TOOL_DEFINITIONS }));
    case 'tools/call': {
      const name = typeof params?.name === 'string' ? params.name : '';
      const args =
        params?.arguments && typeof params.arguments === 'object'
          ? (params.arguments as Record<string, unknown>)
          : {};
      return c.json(
        rpcResult(
          id,
          await callTool(name, args, {
            db,
            env: c.env,
            user: session.user,
            baseURL,
            after: (work) => c.executionCtx.waitUntil(work),
          })
        )
      );
    }
    default:
      if (id === undefined) return c.body(null, 202); // an unknown notification
      return c.json(rpcError(id, -32601, `Method not found: ${method}`));
  }
});

// ── session API for the MCP settings page ────────────────────────────────────

export const mcpApiRouter = new Hono<AppEnv>();

/** The server URL and tool list, so the page always matches what /mcp serves. */
mcpApiRouter.get('/', (c) =>
  c.json({
    serverUrl: `${baseURLOf(c)}/mcp`,
    serverName: mcpServerName(appName(c.env)),
    tools: TOOL_DEFINITIONS,
  })
);

/** Apps the user has approved, newest first. */
mcpApiRouter.get('/connections', async (c) => {
  const db = c.get('db');
  const rows = await db
    .select({
      clientId: oauthConsents.clientId,
      scopes: oauthConsents.scopes,
      createdAt: oauthConsents.createdAt,
      updatedAt: oauthConsents.updatedAt,
      name: oauthClients.name,
      uri: oauthClients.uri,
    })
    .from(oauthConsents)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthConsents.clientId))
    .where(eq(oauthConsents.userId, c.get('user')!.id))
    .orderBy(desc(oauthConsents.updatedAt))
    .all();
  return c.json(
    rows.map((r) => ({
      clientId: r.clientId,
      name: r.name || 'Unnamed app',
      uri: r.uri,
      scopes: Array.isArray(r.scopes) ? r.scopes : [],
      connectedAt: (r.createdAt ?? r.updatedAt)?.toISOString() ?? null,
    }))
  );
});

/**
 * Disconnects an app: deletes the user's consent and every token issued to that app for them.
 * Outstanding JWT access tokens stop working at once because /mcp requires the consent row.
 */
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
