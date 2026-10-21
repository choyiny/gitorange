import type { Runner } from './runner.ts';

export const NPM_REGISTRY = 'https://registry.npmjs.org/gitorange';

/** The version of a plain `vX.Y.Z` tag; anything else is a usage error. */
export function checkTag(tag: string): string {
  const m = /^v(\d+\.\d+\.\d+)$/.exec(tag ?? '');
  if (!m) throw new Error('Usage: yarn release:publish vX.Y.Z');
  return m[1];
}

/**
 * Refuses, in order: a tag missing on `origin`, a tag whose commit is not on origin's main, a
 * version already on npm. Git runs with `-C <repo>` only and fetches into `refs/release-publish/`,
 * so the working copy and the operator's branches are never touched.
 */
export async function preflight(o: {
  tag: string;
  repo: string;
  fetchImpl: typeof fetch;
  runner: Runner;
}): Promise<{ commit: string }> {
  const version = checkTag(o.tag);
  const git = (...args: string[]) =>
    o.runner.run('git', ['-C', o.repo, ...args]);
  const ls = await git('ls-remote', '--tags', 'origin', `refs/tags/${o.tag}`);
  if (ls.code !== 0 || !ls.stdout.trim()) {
    throw new Error(
      `Tag ${o.tag} is missing on origin. Push it first (git push origin ${o.tag}).`
    );
  }
  const fetched = await git(
    'fetch',
    '--quiet',
    'origin',
    '+refs/heads/main:refs/release-publish/main',
    `+refs/tags/${o.tag}:refs/release-publish/tag`
  );
  if (fetched.code !== 0) {
    throw new Error(`Could not fetch main and ${o.tag} from origin.`);
  }
  const ancestor = await git(
    'merge-base',
    '--is-ancestor',
    'refs/release-publish/tag',
    'refs/release-publish/main'
  );
  if (ancestor.code !== 0) {
    throw new Error(
      `Tag ${o.tag} is not on main; publish only releases cut in GitOrange.`
    );
  }
  const npm = await o.fetchImpl(`${NPM_REGISTRY}/${version}`);
  if (npm.status === 200) {
    throw new Error(`gitorange@${version} is already on npm.`);
  }
  const rev = await git('rev-parse', 'refs/release-publish/tag^{commit}');
  return { commit: rev.stdout.trim() };
}
