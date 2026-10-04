import { presign } from '../lib/lfs';
import type { GitService } from '../git/service';
import { decoder, sha256Hex } from '../git/bytes';

/**
 * Actions cache: one zstd tarball per entry in R2 at
 * `actions-cache/<repository id>/<ref>/<key>.tar.zst`; R2's prefix listing is the only index.
 * Runners move bytes via pre-signed URLs (entries exceed Worker request limits).
 * Reads own ref then default branch; writes own ref only, so a PR can't poison main's cache.
 */

/** Node.js major in actions/runner/Dockerfile; part of keys. */
export const RUNNER_NODE_MAJOR = '24';

/** R2's single-request upload limit. */
export const MAX_CACHE_ENTRY_BYTES = 5 * 1024 ** 3;
/** Per-repository total; oldest entries are evicted past it. */
export const MAX_CACHE_BYTES_PER_REPO = 10 * 1024 ** 3;

export function cacheConfigured(env: CloudflareBindings): boolean {
  const e = env as Partial<CloudflareBindings>;
  return Boolean(
    e.ACTIONS_CACHE &&
    e.ACTIONS_CACHE_BUCKET_NAME &&
    e.R2_ACCESS_KEY_ID &&
    e.R2_SECRET_ACCESS_KEY &&
    e.R2_ACCOUNT_ID
  );
}

export const cachePrefix = (repositoryId: string) =>
  `actions-cache/${repositoryId}/`;

/**
 * Encodes a ref or key as one object-key segment: non-unreserved chars become `~xx` (UTF-8 hex).
 * Not `%`: pre-signed URLs decode percent-escapes. Per-character, so prefixes stay prefixes.
 */
export function keySegment(text: string): string {
  let out = '';
  for (const ch of text)
    out += /[A-Za-z0-9._-]/.test(ch)
      ? ch
      : [...new TextEncoder().encode(ch)]
          .map((b) => `~${b.toString(16).padStart(2, '0')}`)
          .join('');
  return out;
}

function fromKeySegment(segment: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < segment.length; i++)
    if (segment[i] === '~') {
      bytes.push(parseInt(segment.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(segment.charCodeAt(i));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const refDir = (repositoryId: string, ref: string) =>
  `${cachePrefix(repositoryId)}${keySegment(ref)}/`;

export const cacheObjectKey = (
  repositoryId: string,
  ref: string,
  key: string
) => `${refDir(repositoryId, ref)}${keySegment(key)}.tar.zst`;

export type CacheMatch = {
  objectKey: string;
  key: string;
  /** Matched the primary key, not a restore key. */
  exact: boolean;
  size: number;
};

/** Exact `key`, else the newest entry prefixed by a `restoreKeys` entry; each ref in order. */
export async function findCacheEntry(
  env: CloudflareBindings,
  repositoryId: string,
  refs: string[],
  key: string,
  restoreKeys: string[]
): Promise<CacheMatch | null> {
  const scopes = [...new Set(refs)];
  for (const ref of scopes) {
    const objectKey = cacheObjectKey(repositoryId, ref, key);
    const head = await env.ACTIONS_CACHE.head(objectKey);
    if (head) return { objectKey, key, exact: true, size: head.size };
  }
  for (const prefix of restoreKeys)
    for (const ref of scopes) {
      const dir = refDir(repositoryId, ref);
      const listed = await env.ACTIONS_CACHE.list({
        prefix: dir + keySegment(prefix),
        limit: 1000,
      });
      const newest = listed.objects.sort(
        (a, b) => b.uploaded.getTime() - a.uploaded.getTime()
      )[0];
      if (newest)
        return {
          objectKey: newest.key,
          key: fromKeySegment(
            newest.key.slice(dir.length).replace(/\.tar\.zst$/, '')
          ),
          exact: false,
          size: newest.size,
        };
    }
  return null;
}

export function cacheUrl(
  env: CloudflareBindings,
  objectKey: string,
  method: 'GET' | 'PUT'
) {
  return presign(env, objectKey, method, {
    bucket: env.ACTIONS_CACHE_BUCKET_NAME,
  });
}

/** Evicts oldest entries until the repository is within `maxBytes`. */
export async function enforceCacheLimit(
  env: CloudflareBindings,
  repositoryId: string,
  maxBytes = MAX_CACHE_BYTES_PER_REPO
) {
  const all: { key: string; size: number; uploaded: Date }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ACTIONS_CACHE.list({
      prefix: cachePrefix(repositoryId),
      cursor,
    });
    all.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  let total = all.reduce((n, o) => n + o.size, 0);
  const evict: string[] = [];
  for (const o of all.sort(
    (a, b) => a.uploaded.getTime() - b.uploaded.getTime()
  )) {
    if (total <= maxBytes) break;
    evict.push(o.key);
    total -= o.size;
  }
  if (evict.length) await env.ACTIONS_CACHE.delete(evict);
  return evict;
}

export async function deleteRepositoryCache(
  env: CloudflareBindings,
  repositoryId: string
) {
  if (!cacheConfigured(env)) return;
  let cursor: string | undefined;
  do {
    const page = await env.ACTIONS_CACHE.list({
      prefix: cachePrefix(repositoryId),
      cursor,
    });
    if (page.objects.length)
      await env.ACTIONS_CACHE.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

// ── setup-node ───────────────────────────────────────────────────────────────

const LOCKFILES: Record<string, string> = {
  yarn: 'yarn.lock',
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
};

export const PACKAGE_MANAGERS = Object.keys(LOCKFILES);

/**
 * Key for `setup-node`'s `cache:`, which caches `node_modules` (not the download cache) so a hit
 * skips the install. Covers platform, Node.js major, and the lockfile at `sha`.
 */
export async function nodeModulesKey(
  git: GitService,
  sha: string,
  manager: string,
  nodeMajor: string,
  dependencyPath?: string
): Promise<{ key: string; lockfile: string } | { error: string }> {
  const lockfile = dependencyPath?.trim() || LOCKFILES[manager];
  if (!lockfile)
    return {
      error: `cache: ${manager} isn't supported. Use yarn, npm, or pnpm.`,
    };
  const entry = await git.entryAt(sha, lockfile.replace(/^\.\//, ''));
  if (entry?.type !== 'blob')
    return { error: `No ${lockfile} at this commit, so nothing is cached.` };
  const bytes = await git.blob(entry.entry.hash);
  if (!bytes) return { error: `${lockfile} could not be read.` };
  const hash = (await sha256Hex(decoder.decode(bytes))).slice(0, 32);
  return {
    key: `node-modules-${manager}-linux-x64-node${nodeMajor}-${hash}`,
    lockfile,
  };
}

// ── runner scripts ───────────────────────────────────────────────────────────

/** Resolves `~` to /root and relative paths against `workspace`; drops `!` excludes. */
export function absolutePaths(paths: string[], workspace: string): string[] {
  return paths
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('!'))
    .map((p) =>
      p.startsWith('~/')
        ? `/root/${p.slice(2)}`
        : p === '~'
          ? '/root'
          : p.startsWith('/')
            ? p
            : `${workspace}/${p.replace(/^\.\//, '')}`
    );
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Downloads and unpacks `$CACHE_URL`; on failure removes partial output and continues. */
export function restoreScript(paths: string[], label: string): string {
  const list = paths.map(quote).join(' ');
  return [
    `echo ${quote(`Restoring cache: ${label}`)}`,
    'start=$(date +%s)',
    `if curl -fsSL --retry 3 "$CACHE_URL" | zstd -dc | tar -xPf -; then`,
    '  echo "Cache restored in $(( $(date +%s) - start ))s"',
    'else',
    `  rm -rf ${list}`,
    '  echo "Could not restore the cache; continuing without it."',
    '  exit 0',
    'fi',
  ].join('\n');
}

/** Packs `paths` and uploads to `$CACHE_URL` unless over the entry size limit. */
export function saveScript(paths: string[], key: string): string {
  const list = paths.map(quote).join(' ');
  return [
    `existing=$(for p in ${list}; do [ -e "$p" ] && printf '%s\\n' "$p"; done)`,
    'if [ -z "$existing" ]; then echo "Nothing to cache: none of the paths exist."; exit 0; fi',
    `echo ${quote(`Saving cache: ${key}`)}`,
    'start=$(date +%s)',
    'printf "%s\\n" "$existing" | tar -cPf - -T - | zstd -T0 -3 -q -o /tmp/gitorange-cache.tar.zst',
    'size=$(stat -c %s /tmp/gitorange-cache.tar.zst)',
    `if [ "$size" -gt ${MAX_CACHE_ENTRY_BYTES} ]; then echo "The cache is $size bytes, over the 5 GB limit; not saving it."; rm -f /tmp/gitorange-cache.tar.zst; exit 0; fi`,
    'curl -fsS --retry 3 -X PUT -H "Content-Type: application/zstd" -T /tmp/gitorange-cache.tar.zst "$CACHE_URL" -o /dev/null',
    'rm -f /tmp/gitorange-cache.tar.zst',
    'echo "Saved $(( size / 1048576 )) MB in $(( $(date +%s) - start ))s"',
  ].join('\n');
}
