/**
 * The version bump a pull request asks for, in words. A pull request that lands without one counts as a patch, so
 * lists of unreleased changes say "patch (default)" rather than nothing.
 */
import type { VersionBump } from './uiApi';

export const BUMPS: readonly VersionBump[] = ['major', 'minor', 'patch'];

/** The bump as a list shows it: "minor", or "patch (default)" when it asked for none. */
export function bumpLabel(bump: VersionBump | null): string {
  return bump ?? 'patch (default)';
}

/** A `<select>` value back to a bump: '' is none. */
export function parseBump(value: string): VersionBump | null {
  return (BUMPS as readonly string[]).includes(value)
    ? (value as VersionBump)
    : null;
}

/**
 * A plain `vX.Y.Z` (no pre-release or build metadata, no leading zeros, at most 8 digits a part), the only version a
 * release takes. The same spellings as the server's `parseVersion` (worker/src/lib/semver.ts).
 */
export function isVersion(value: string): boolean {
  return /^v(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(
    value.trim()
  );
}
