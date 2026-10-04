/** GitHub's rules: alphanumerics and single hyphens, no leading or trailing hyphen, ≤39 chars. */
export const USERNAME_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

/** First path segments the SPA and worker already own; a user with one of these names would be unreachable. */
export const RESERVED_USERNAMES = new Set([
  'admin',
  'api',
  'approvals',
  'invite',
  'login',
  'logout',
  'new',
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

/**
 * The single check every path that sets a username goes through: our setup and invite routes
 * and better-auth's own endpoints (e.g. update-user), via the username plugin's validator.
 */
export function isValidUsername(name: string): boolean {
  return USERNAME_RE.test(name) && !isReservedUsername(name);
}
