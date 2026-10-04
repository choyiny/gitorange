import { decoder } from '../git/bytes';
import type { GitService } from '../git/service';

/**
 * `.orangeignore`: files the auto-merge review leaves out, in `.gitignore` syntax (generated code,
 * vendored files, snapshots). Read from the target branch, like review.yml, so a pull request
 * can't hide its own files. An ignored file still counts as changed and is listed with a fixed
 * one-liner; it just isn't summarized by a model, read by the investigator, or quoted.
 */
export const IGNORE_PATH = '.orangeignore';

/** Lockfiles are always ignored: their diffs say nothing a reviewer can check. */
const LOCKFILE =
  /(^|\/)(yarn\.lock|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|uv\.lock|Gemfile\.lock|composer\.lock)$/;

export const isLockfile = (path: string) => LOCKFILE.test(path);

/** The `.orangeignore` text on a commit, or null when there is none. */
export async function readIgnore(
  git: GitService,
  sha: string
): Promise<string | null> {
  const entry = await git.entryAt(sha, IGNORE_PATH);
  if (entry?.type !== 'blob') return null;
  const bytes = await git.blob(entry.entry.hash);
  return bytes ? decoder.decode(bytes) : null;
}

type Rule = { negate: boolean; re: RegExp };

/** One `.gitignore` pattern as a regular expression over repository paths. */
function patternRegex(raw: string): RegExp {
  let p = raw;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  // A slash anywhere but the end anchors the pattern at the repository root.
  const anchored = p.includes('/');
  p = p.replace(/^\//, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const prefix = anchored ? '^' : '^(?:.*/)?';
  // A directory pattern matches everything under it; a file pattern also matches a directory.
  const suffix = dirOnly ? '/.*$' : '(?:/.*)?$';
  return new RegExp(prefix + re + suffix);
}

export function parseIgnore(text: string | null): Rule[] {
  if (!text) return [];
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const negate = l.startsWith('!');
      return { negate, re: patternRegex(negate ? l.slice(1) : l) };
    });
}

/** Whether the review leaves a path out: a lockfile, or matched by `.orangeignore` (last rule wins). */
export function ignoreMatcher(text: string | null): (path: string) => boolean {
  const rules = parseIgnore(text);
  return (path) => {
    let ignored = isLockfile(path);
    for (const r of rules) if (r.re.test(path)) ignored = !r.negate;
    return ignored;
  };
}
