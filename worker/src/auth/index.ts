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

/** The MCP endpoint is an OAuth protected resource; its URL is the token audience (RFC 8707). */
export const mcpResource = (baseURL: string) =>
  `${baseURL.replace(/\/$/, '')}/mcp`;

/**
 * MCP desktop clients (Claude Code, Cursor, …) register with a loopback or app-scheme redirect
 * URI but omit `application_type`, which OpenID registration then defaults to "web" — and web
 * clients may not redirect to http://localhost. Such a client is a native app, so say so.
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
 * Makes sure the `/mcp` protected resource exists before an OAuth endpoint needs it. Done here,
 * not with the plugin's `resources` option, because that seeds on every auth instance — and on
 * Workers there is one per request. INSERT … ON CONFLICT is safe under concurrent first requests.
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

/**
 * The OAuth issuer: better-auth's base URL (`<origin>/api/auth`), upgraded to https except on
 * loopback hosts — the same rule the oauth-provider plugin applies to the `iss` it signs.
 */
export function oauthIssuer(baseURL: string) {
  const url = new URL(`${baseURL.replace(/\/$/, '')}/api/auth`);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) url.protocol = 'https:';
  return url.toString().replace(/\/$/, '');
}

/** OAuth scopes MCP clients may request. `offline_access` lets them refresh without re-consent. */
export const OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access'];

function createAuth(env?: CloudflareBindings) {
  // Real DB at runtime; empty object during CLI schema generation (env is undefined).
  const db = env ? drizzle(env.DB, { schema }) : ({} as any);
  const baseURL = env?.BASE_URL || 'http://localhost:8080';

  return betterAuth({
    secret: env?.BETTER_AUTH_SECRET,
    baseURL,
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      usePlural: true,
      // Explicit so better-auth's startup schema check sees the tables even for the CLI-only
      // instance below, which has no database to read them from.
      schema,
    }),
    emailAndPassword: {
      enabled: true,
      // Users arrive via first-run setup or an admin invitation — never self-signup.
      disableSignUp: true,
      minPasswordLength: 8,
    },
    // The jwt plugin's session-JWT endpoint isn't used; it only signs OAuth access tokens here.
    disabledPaths: ['/token'],
    plugins: [
      openAPI(),
      admin(),
      username({
        minUsernameLength: 1,
        maxUsernameLength: 39,
        // Also guards better-auth's own endpoints (update-user), not just our routes.
        usernameValidator: isValidUsername,
      }),
      // Signing keys (JWKS) for OAuth access tokens.
      jwt(),
      // OAuth 2.1 authorization server for MCP clients (Claude, Cursor, …): they register
      // themselves (RFC 7591), sign in through our login page with PKCE, approve on the consent
      // page, and receive JWT access tokens bound to the /mcp resource.
      oauthProvider({
        loginPage: '/login',
        consentPage: '/oauth/consent',
        scopes: OAUTH_SCOPES,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // The one protected resource is /mcp (see ensureMcpResource); any client may request it.
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
    // Database-backed so limits hold across isolates (in-memory state is per-isolate on Workers).
    rateLimit: { enabled: true, storage: 'database' },
    databaseHooks: {
      user: {
        update: {
          // Usernames share the URL namespace with the team slug; better-auth only checks users.
          before: async (data, ctx) => {
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
      },
    },
    advanced: {
      cookiePrefix: 'gitorange',
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      // Same-origin SPA: Lax is enough and keeps the cookie off cross-site requests.
      defaultCookieAttributes: {
        sameSite: 'Lax',
        secure: baseURL.startsWith('https://'),
      },
    },
    // Only the instance's own origin; localhost is trusted only when the instance itself is local.
    trustedOrigins: [baseURL],
  });
}

// Static export: consumed by `yarn auth:generate` (no env → empty db is fine).
export const auth = createAuth();

// Runtime export: called per request with c.env.
export { createAuth };
