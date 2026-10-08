/**
 * Protected branches: per-repository branch name patterns (repositories.protected_branches) that GitOrange never
 * rebases (merge/rebase.ts rebaseBlocked). The default branch is always protected, whatever the patterns say.
 *
 * A pattern is an exact branch name, or a glob: `*` matches within one path segment (`release/*` matches
 * `release/1.2`, not `release/1/hotfix`), `**` across segments (`hotfix/**` matches `hotfix/a/b`; `**\/x` matches `x`
 * at any depth, including the top). Nothing else is special.
 */

/** At most this many patterns per repository. */
export const MAX_PROTECTED_PATTERNS = 50;
/** At most this many characters per pattern. */
export const MAX_PROTECTED_PATTERN_LENGTH = 100;

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** The pattern as an anchored regular expression. */
export function patternRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length;) {
    if (pattern.startsWith('**', i)) {
      const atStart = i === 0 || pattern[i - 1] === '/';
      const slashAfter = pattern[i + 2] === '/';
      if (atStart && slashAfter) {
        // `**/` as a whole segment: zero or more leading segments.
        out += '(?:.*/)?';
        i += 3;
      } else {
        out += '.*';
        i += 2;
      }
    } else if (pattern[i] === '*') {
      out += '[^/]*';
      i++;
    } else {
      out += escape(pattern[i]);
      i++;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Whether `branch` matches `pattern`. */
export function branchMatches(pattern: string, branch: string): boolean {
  if (!pattern.includes('*')) return pattern === branch;
  return patternRegExp(pattern).test(branch);
}

/** The first of `patterns` that `branch` matches, or null. */
export function protectedBy(
  patterns: readonly string[] | null | undefined,
  branch: string
): string | null {
  return patterns?.find((p) => branchMatches(p, branch)) ?? null;
}

/** Why a list of patterns can't be saved, or null: too many, or one empty, too long, or with whitespace. */
export function invalidProtectedPatterns(
  patterns: readonly string[]
): string | null {
  if (patterns.length > MAX_PROTECTED_PATTERNS)
    return `At most ${MAX_PROTECTED_PATTERNS} protected branch patterns`;
  for (const p of patterns) {
    if (!p) return 'A protected branch pattern is empty';
    if (p.length > MAX_PROTECTED_PATTERN_LENGTH)
      return `Protected branch patterns are at most ${MAX_PROTECTED_PATTERN_LENGTH} characters`;
    if (/\s/.test(p))
      return `Protected branch pattern "${p}" contains whitespace`;
  }
  return null;
}

/** The patterns to store: duplicates dropped, order kept; none ⇒ null. */
export function normalizeProtectedPatterns(
  patterns: readonly string[]
): string[] | null {
  const out = [...new Set(patterns)];
  return out.length ? out : null;
}
