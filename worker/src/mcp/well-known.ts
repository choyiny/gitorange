import { Hono } from 'hono';
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import { OAUTH_SCOPES, oauthIssuer } from '../auth';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { instanceName } from '../lib/settings';
import type { AppEnv } from '../variables';

/**
 * OAuth discovery at the origin root: RFC 9728 resource metadata (root and `/mcp`-suffixed) and
 * RFC 8414 server metadata (also at the path-inserted URL for issuer `<origin>/api/auth`).
 */
export const wellKnownRouter = new Hono<AppEnv>();

async function protectedResource(c: {
  req: { url: string };
  env: CloudflareBindings;
}) {
  const origin = new URL(c.req.url).origin;
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [oauthIssuer(origin)],
    bearer_methods_supported: ['header'],
    scopes_supported: OAUTH_SCOPES,
    resource_name: await instanceName(drizzle(c.env.DB, { schema }), c.env),
  };
}

wellKnownRouter.get('/.well-known/oauth-protected-resource', async (c) =>
  c.json(await protectedResource(c))
);
wellKnownRouter.get('/.well-known/oauth-protected-resource/mcp', async (c) =>
  c.json(await protectedResource(c))
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
