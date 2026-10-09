// The New repository form's rules, the same ones the server enforces (worker/src/lib/repos.ts and repo-create.ts),
// so a bad name is explained as it is typed rather than after pressing Create.

export const REPO_NAME_MAX = 100;
export const DESCRIPTION_MAX = 350;

/** What the server will name the repository: trimmed, with anything but letters, digits, `.`, `_` and `-` as `-`. */
export function normalizeRepoName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, '-');
}

/**
 * Why this name cannot be used, in words, or null when it can (or when there is nothing to judge yet: an empty name
 * only keeps the button disabled).
 */
export function repoNameProblem(name: string): string | null {
  if (!name.trim()) return null;
  if (name.length > REPO_NAME_MAX)
    return `A name can be at most ${REPO_NAME_MAX} characters.`;
  const normalized = normalizeRepoName(name);
  if (normalized === '.' || normalized === '..')
    return 'A name can’t be only dots.';
  if (normalized.endsWith('.git')) return 'A name can’t end in .git.';
  return null;
}

/** What to tell the person after the repository was created but some reviewers could not be added. */
export function inviteFailureMessage(
  failed: { name: string; reason: string }[]
) {
  if (!failed.length) return null;
  const names = failed.map((f) => f.name);
  const who =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const as = names.length === 1 ? 'a reviewer' : 'reviewers';
  const reason = failed[0].reason.trim();
  return `The repository was created, but ${who} could not be added as ${as}. ${/[.!?]$/.test(reason) ? reason : `${reason}.`} You can add reviewers in the repository's settings.`;
}
