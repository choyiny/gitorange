import { betterAuth } from 'better-auth';
import { admin, openAPI, username } from 'better-auth/plugins';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { isValidUsername } from '../lib/usernames';

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
    }),
    emailAndPassword: {
      enabled: true,
      // Users arrive via first-run setup or an admin invitation — never self-signup.
      disableSignUp: true,
      minPasswordLength: 8,
    },
    plugins: [
      openAPI(),
      admin(),
      username({
        minUsernameLength: 1,
        maxUsernameLength: 39,
        // Also guards better-auth's own endpoints (update-user), not just our routes.
        usernameValidator: isValidUsername,
      }),
    ],
    // Database-backed so limits hold across isolates (in-memory state is per-isolate on Workers).
    rateLimit: { enabled: true, storage: 'database' },
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
