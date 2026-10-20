// Release versions: `vX.Y.Z` tags, nothing else. No pre-release or build suffixes, and no leading zeros, so a tag
// has exactly one spelling and one parse. Pure: the tag cutter and the release pages both read it.

export type Bump = 'major' | 'minor' | 'patch';

/** Smallest to largest, so `largestBump` can take the maximum by index. */
export const BUMPS: readonly Bump[] = ['patch', 'minor', 'major'];

export type Version = { major: number; minor: number; patch: number };

const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The version a `vX.Y.Z` tag names, or null for anything else. */
export function parseVersion(tag: string): Version | null {
  const m = VERSION.exec(tag);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** `vX.Y.Z`, the tag spelling of a version. */
export function formatVersion(v: Version): string {
  return `v${v.major}.${v.minor}.${v.patch}`;
}

/** Negative, zero or positive as `a` is older, equal or newer than `b`. */
export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** The next version after `v` for a bump; lower parts reset to zero. */
export function bumpVersion(v: Version, b: Bump): Version {
  switch (b) {
    case 'major':
      return { major: v.major + 1, minor: 0, patch: 0 };
    case 'minor':
      return { major: v.major, minor: v.minor + 1, patch: 0 };
    case 'patch':
      return { major: v.major, minor: v.minor, patch: v.patch + 1 };
  }
}

/** The biggest of the bumps. A null (no bump requested) counts as patch, and an empty list is patch too. */
export function largestBump(bumps: (Bump | null)[]): Bump {
  let largest = 0;
  for (const b of bumps)
    largest = Math.max(largest, b === null ? 0 : BUMPS.indexOf(b));
  return BUMPS[largest];
}
