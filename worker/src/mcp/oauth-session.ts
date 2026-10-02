import { and, eq } from 'drizzle-orm';
import { verifyJwsAccessToken } from 'better-auth/oauth2';
import { mcpResource, oauthIssuer } from '../auth';
import { oauthConsents, users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import type { AppEnv, SessionUser } from '../variables';

export interface McpSession {
  user: SessionUser;
  clientId: string;
  scopes: string[];
}

/**
 * Bearer token → user. Access tokens are JWTs signed by this instance's better-auth (jwt plugin)
 * and bound to the `/mcp` resource, so they are verified locally against our own JWKS with no
 * network call: signature, issuer, audience, and expiry. On top of that, the user must still
 * exist and not be banned, and must not have revoked the app (its consent row), so
 * disconnecting an app in GitOrange takes effect immediately rather than at token expiry.
 */
export async function getMcpSession(
  auth: AppEnv['Variables']['auth'],
  db: DrizzleDB,
  baseURL: string,
  headers: Headers
): Promise<McpSession | null> {
  const header = headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  let payload: Record<string, unknown>;
  try {
    payload = await verifyJwsAccessToken(match[1], {
      jwksFetch: () => auth.api.getJwks(),
      verifyOptions: {
        // The plugin signs `iss` from the base URL as configured, but advertises it upgraded to
        // https on non-loopback hosts; on an https deployment the two are the same.
        issuer: [
          `${baseURL.replace(/\/$/, '')}/api/auth`,
          oauthIssuer(baseURL),
        ],
        audience: mcpResource(baseURL),
      },
    });
  } catch {
    return null;
  }
  const userId = typeof payload.sub === 'string' ? payload.sub : null;
  const clientId =
    typeof payload.azp === 'string'
      ? payload.azp
      : typeof payload.client_id === 'string'
        ? payload.client_id
        : null;
  if (!userId || !clientId) return null;

  const [user, consent] = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)).get(),
    db
      .select({ id: oauthConsents.id })
      .from(oauthConsents)
      .where(
        and(
          eq(oauthConsents.userId, userId),
          eq(oauthConsents.clientId, clientId)
        )
      )
      .get(),
  ]);
  if (!user || user.banned || !consent) return null;
  const scope = typeof payload.scope === 'string' ? payload.scope : '';
  return {
    user: user as SessionUser,
    clientId,
    scopes: scope.split(' ').filter(Boolean),
  };
}
