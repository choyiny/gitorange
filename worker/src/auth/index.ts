import { betterAuth } from 'better-auth';
import { admin, jwt, openAPI, username } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { oauthResources } from '../db/auth.schema';
import { schema } from '../db/schema';
import { isValidUsername } from '../lib/usernames';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { namespaceTaken } from '../lib/namespaces';
import { isAgentUser } from '../agents/identity';

/** The /mcp URL: the OAuth protected resource and token audience (RFC 8707). */
export const mcpResource = (baseURL: string) =>
  `${baseURL.replace(/\/$/, '')}/mcp`;

/**
 * Marks clients with only loopback or app-scheme redirect URIs and no `application_type` as
 * native; the "web" default forbids http://localhost redirects.
 */
function nativeClientRegistration(body: unknown) {
  const b = body as
    { application_type?: string; redirect_uris?: unknown } | undefined;
  if (!b || b.application_type !== undefined) return;
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
  const native = (u: unknown) => {
    try {
      const url = new URL(String(u));
      if (url.protocol === 'http:')
        return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      return url.protocol !== 'https:';
    } catch {
      return false;
    }
  };
  if (uris.length && uris.every(native))
    return { ...b, application_type: 'native' };
}

/**
 * Seeds the `/mcp` protected resource. Not the plugin's `resources` option: that seeds on every
 * auth instance, i.e. every request.
 */
async function ensureMcpResource(
  db: DrizzleD1Database<typeof schema>,
  baseURL: string
) {
  const now = new Date();
  await db
    .insert(oauthResources)
    .values({
      id: crypto.randomUUID(),
      identifier: mcpResource(baseURL),
      name: 'GitOrange MCP server',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: oauthResources.identifier });
}

/** `<origin>/api/auth`, https except on loopback: matches the `iss` oauth-provider signs. */
export function oauthIssuer(baseURL: string) {
  const url = new URL(`${baseURL.replace(/\/$/, '')}/api/auth`);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) url.protocol = 'https:';
  return url.toString().replace(/\/$/, '');
}

/** OAuth scopes MCP clients may request. */
export const OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access'];

function createAuth(env?: CloudflareBindings) {
  // No env during CLI schema generation.
  const db = env ? drizzle(env.DB, { schema }) : ({} as any);
  const baseURL = env?.BASE_URL || 'http://localhost:8080';

  return betterAuth({
    secret: env?.BETTER_AUTH_SECRET,
    baseURL,
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      usePlural: true,
      // Explicit so the schema check passes for the CLI instance, which has no database.
      schema,
    }),
    emailAndPassword: {
      enabled: true,
      // Users come from setup or invitations only.
      disableSignUp: true,
      minPasswordLength: 8,
    },
    // jwt() only signs OAuth access tokens; its session-JWT endpoint is off.
    disabledPaths: ['/token'],
    plugins: [
      openAPI(),
      admin(),
      username({
        minUsernameLength: 1,
        maxUsernameLength: 39,
        // Also covers better-auth's update-user endpoint.
        usernameValidator: isValidUsername,
      }),
      jwt(),
      // OAuth 2.1 server for MCP clients: dynamic registration (RFC 7591), PKCE, JWTs for /mcp.
      oauthProvider({
        loginPage: '/login',
        consentPage: '/oauth/consent',
        scopes: OAUTH_SCOPES,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // /mcp is the only resource; any client may request it.
        enforcePerClientResources: false,
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!env || !ctx.path.startsWith('/oauth2/')) return;
        await ensureMcpResource(db, baseURL);
        if (ctx.path === '/oauth2/register') {
          const body = nativeClientRegistration(ctx.body);
          if (body) return { context: { body } };
        }
      }),
    },
    // In-memory limits would be per isolate.
    rateLimit: { enabled: true, storage: 'database' },
    databaseHooks: {
      session: {
        create: {
          // Agents are accounts without sign-in: no session by any route (password, impersonation), and so
          // no personal access tokens or OAuth consents either.
          before: async (session) => {
            if (env && (await isAgentUser(db, session.userId)))
              throw new APIError('FORBIDDEN', {
                message: 'Agents can’t sign in.',
              });
            return { data: session };
          },
        },
      },
      account: {
        create: {
          // Nor credentials: covers admin set-user-password, create-user with a password, any linkAccount.
          before: async (account) => {
            if (env && (await isAgentUser(db, account.userId)))
              throw new APIError('FORBIDDEN', {
                message: 'Agents can’t have a password.',
              });
            return { data: account };
          },
        },
      },
      user: {
        update: {
          // Usernames share the URL namespace with the team slug.
          before: async (data, ctx) => {
            // An agent stays a plain user (no site admin) under the handle and `.invalid` email it was
            // created with. The hook gets no `where`; the admin endpoints (set-role, update-user) name
            // their target as `body.userId`, and agents have no session to update themselves with.
            const target = (ctx?.body as { userId?: unknown } | undefined)
              ?.userId;
            const fields = data as Record<string, unknown>;
            const touches = (keys: string[]) =>
              keys.some((k) => fields[k] !== undefined);
            if (
              env &&
              typeof target === 'string' &&
              touches(['role', 'username', 'displayUsername', 'email']) &&
              (await isAgentUser(db, target))
            ) {
              if (touches(['role']))
                throw new APIError('FORBIDDEN', {
                  message: 'An agent’s role can’t be changed.',
                });
              throw new APIError('FORBIDDEN', {
                message: 'An agent’s username and email can’t be changed.',
              });
            }
            const username = (data as { username?: string }).username;
            const userId = ctx?.context.session?.user.id;
            if (
              username &&
              env &&
              (await namespaceTaken(db, username, { userId }))
            ) {
              throw new APIError('BAD_REQUEST', {
                message: 'Username is not available.',
              });
            }
            return { data };
          },
        },
        delete: {
          // Deleting an agent keeps its user (history, attribution); admin remove-user would cascade it away.
          before: async (user) => {
            if (env && (await isAgentUser(db, user.id)))
              throw new APIError('FORBIDDEN', {
                message: 'Delete agents from Site admin → Agents.',
              });
          },
        },
      },
    },
    advanced: {
      cookiePrefix: 'gitorange',
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      defaultCookieAttributes: {
        sameSite: 'Lax',
        secure: baseURL.startsWith('https://'),
      },
    },
    trustedOrigins: [baseURL],
  });
}

// For `yarn auth:generate`.
export const auth = createAuth();

export { createAuth };
