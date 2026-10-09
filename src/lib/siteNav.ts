// The side navs of Settings and Site admin: which entry is current for a location, and whether an entry is an
// in-page jump (a section of /admin) rather than a page of its own.

export type SettingsSection = 'tokens' | 'mcp' | 'emails';

/** Which Settings page a path belongs to (`/settings/emails/verify` is part of Emails). */
export function settingsSection(pathname: string): SettingsSection | null {
  if (pathname === '/settings/tokens') return 'tokens';
  if (pathname === '/settings/mcp') return 'mcp';
  if (
    pathname === '/settings/emails' ||
    pathname.startsWith('/settings/emails/')
  )
    return 'emails';
  return null;
}

export type AdminSection =
  'people' | 'setup' | 'settings' | 'usage' | 'audit' | 'agents';

/**
 * Which Site admin entry is current. `/admin` holds three sections (people and team, setup checks, instance
 * settings); `#setup` and `#settings` pick the second and third, anything else is the first.
 */
export function adminSection(
  pathname: string,
  hash: string
): AdminSection | null {
  if (pathname === '/admin')
    return hash === '#setup'
      ? 'setup'
      : hash === '#settings'
        ? 'settings'
        : 'people';
  if (pathname === '/admin/usage') return 'usage';
  if (pathname === '/admin/audit') return 'audit';
  if (pathname === '/admin/agents' || pathname === '/agents') return 'agents';
  return null;
}
