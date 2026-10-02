import { Hono } from 'hono';
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import { OAUTH_SCOPES, oauthIssuer } from '../auth';
import type { AppEnv } from '../variables';

/**
 * OAuth discovery at the origin root, where MCP clients look for it.
 *
 * - RFC 9728 protected-resource metadata for `/mcp`, at both the root and the path-suffixed URL
 *   (`/.well-known/oauth-protected-resource/mcp`) that RFC 9728 derives from the resource URL.
 * - RFC 8414 authorization-server metadata. The issuer is `<origin>/api/auth` (better-auth's base
 *   path), so it is also served at the path-inserted URL clients derive from that issuer.
 */
export const wellKnownRouter = new Hono<AppEnv>();

function protectedResource(c: { req: { url: string } }) {
  const origin = new URL(c.req.url).origin;
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [oauthIssuer(origin)],
    bearer_methods_supported: ['header'],
    scopes_supported: OAUTH_SCOPES,
    resource_name: 'GitOrange',
  };
}

wellKnownRouter.get('/.well-known/oauth-protected-resource', (c) =>
  c.json(protectedResource(c))
);
wellKnownRouter.get('/.well-known/oauth-protected-resource/mcp', (c) =>
  c.json(protectedResource(c))
);

const authServerMetadata = (c: {
  get: (k: 'auth') => AppEnv['Variables']['auth'];
  req: { raw: Request };
}) => oauthProviderAuthServerMetadata(c.get('auth'))(c.req.raw);

wellKnownRouter.get(
  '/.well-known/oauth-authorization-server',
  authServerMetadata
);
wellKnownRouter.get(
  '/.well-known/oauth-authorization-server/api/auth',
  authServerMetadata
);
// OpenID clients probe this too; better-auth serves it under its base path.
wellKnownRouter.get('/.well-known/openid-configuration', (c) =>
  c
    .get('auth')
    .handler(
      new Request(
        `${new URL(c.req.url).origin}/api/auth/.well-known/openid-configuration`,
        c.req.raw
      )
    )
);
