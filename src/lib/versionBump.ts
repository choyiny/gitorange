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

/** A plain `vX.Y.Z` (no pre-release or build metadata), the only version a release takes. */
export function isVersion(value: string): boolean {
  return /^v\d+\.\d+\.\d+$/.test(value.trim());
}
