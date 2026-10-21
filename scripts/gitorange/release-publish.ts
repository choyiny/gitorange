import type { Runner } from './runner.ts';

export const RELEASES_API =
  'https://git.xyspace.dev/api/repos/choyiny/gitorange/releases';
export const NPM_REGISTRY = 'https://registry.npmjs.org/gitorange';

/** The version of a plain `vX.Y.Z` tag; anything else is a usage error. */
export function checkTag(tag: string): string {
  const m = /^v(\d+\.\d+\.\d+)$/.exec(tag ?? '');
  if (!m) throw new Error('Usage: yarn release:publish vX.Y.Z');
  return m[1];
}

/**
 * Refuses, in order: a tag missing on `origin`, a tag that is not a GitOrange release, a version
 * already on npm. Git runs with `-C <repo>` only; the working copy is never read or changed.
 * `token` is the operator's personal access token, read from their environment by the caller.
 */
export async function preflight(o: {
  tag: string;
  repo: string;
  token?: string;
  fetchImpl: typeof fetch;
  runner: Runner;
}): Promise<{ commit: string }> {
  const version = checkTag(o.tag);
  const ls = await o.runner.run('git', [
    '-C',
    o.repo,
    'ls-remote',
    '--tags',
    'origin',
    `refs/tags/${o.tag}`,
    `refs/tags/${o.tag}^{}`,
  ]);
  const refs = new Map<string, string>();
  for (const line of ls.stdout.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref) refs.set(ref, sha);
  }
  const commit =
    refs.get(`refs/tags/${o.tag}^{}`) ?? refs.get(`refs/tags/${o.tag}`);
  if (ls.code !== 0 || !commit) {
    throw new Error(
      `Tag ${o.tag} is missing on origin. Push it first (git push origin ${o.tag}).`
    );
  }
  if (!o.token) {
    throw new Error(
      'GITORANGE_TOKEN is not set. Export a personal access token (Settings → Tokens) so the release can be checked: export GITORANGE_TOKEN=...'
    );
  }
  const release = await o.fetchImpl(`${RELEASES_API}/${o.tag}`, {
    headers: { Authorization: `Bearer ${o.token}` },
  });
  if (release.status !== 200) {
    throw new Error(
      `${o.tag} is not a GitOrange release (HTTP ${release.status}). Cut the release first.`
    );
  }
  const npm = await o.fetchImpl(`${NPM_REGISTRY}/${version}`);
  if (npm.status === 200) {
    throw new Error(`gitorange@${version} is already on npm.`);
  }
  return { commit };
}
