/** GitHub's rules: alphanumerics and inner single hyphens, ≤39 chars. */
export const USERNAME_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

/** First path segments owned by the SPA (src/App.tsx) and worker (/api, /mcp). */
export const RESERVED_USERNAMES = new Set([
  'admin',
  'agents',
  'api',
  'approvals',
  'invite',
  'login',
  'logout',
  'mcp',
  'new',
  'oauth',
  'repos',
  'settings',
  'setup',
  'assets',
  'favicon.svg',
  'favicon.png',
  'apple-touch-icon.png',
  'logo.png',
  'gitorange-logo.png',
  'gitorange-logo.svg',
]);

export function isReservedUsername(name: string): boolean {
  return RESERVED_USERNAMES.has(name.toLowerCase());
}

/** The one username check: setup/invite routes and better-auth's username plugin validator. */
export function isValidUsername(name: string): boolean {
  return USERNAME_RE.test(name) && !isReservedUsername(name);
}
