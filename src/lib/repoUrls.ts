/**
 * Where a repository Markdown file lives, so relative links and images in it can be resolved
 * like GitHub does: against the file's directory, at the ref being viewed.
 */
export interface RepoMarkdownContext {
  owner: string;
  repo: string;
  ref: string;
  /** Directory of the Markdown file, relative to the repository root ('' for the root). */
  dir: string;
}

/** The directory part of a repository path: `docs/a/README.md` → `docs/a`. */
export const dirOf = (path: string) => path.split('/').slice(0, -1).join('/');

// A scheme (`https:`, `mailto:`, `data:` …) or protocol-relative `//host`: not a repo path.
const ABSOLUTE_RE = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const encodePath = (path: string) =>
  path.split('/').map(encodeURIComponent).join('/');

/**
 * Resolves a relative URL from a Markdown file to a repository path, or null when the URL isn't
 * relative (absolute URLs, `#anchors`, empty). `/x` is relative to the repository root.
 */
export function resolveRepoPath(
  dir: string,
  url: string
): { path: string; isDir: boolean; fragment: string } | null {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('#') || ABSOLUTE_RE.test(trimmed))
    return null;
  const hashAt = trimmed.indexOf('#');
  const fragment = hashAt >= 0 ? trimmed.slice(hashAt) : '';
  const beforeHash = hashAt >= 0 ? trimmed.slice(0, hashAt) : trimmed;
  const pathPart = beforeHash.split('?')[0];
  if (!pathPart) return null;
  const segments = pathPart.startsWith('/')
    ? []
    : dir.split('/').filter(Boolean);
  for (const seg of pathPart.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') segments.pop();
    else segments.push(decode(seg));
  }
  return {
    path: segments.join('/'),
    isDir: /\/\.{0,2}$/.test(pathPart) || /^\.{1,2}$/.test(pathPart),
    fragment,
  };
}

/** In-app URL for a relative link in repository Markdown, or null to leave it alone. */
export function repoLinkHref(
  ctx: RepoMarkdownContext,
  href: string
): string | null {
  const r = resolveRepoPath(ctx.dir, href);
  if (!r) return null;
  const base = `/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}`;
  const view = r.isDir || !r.path ? 'tree' : 'blob';
  const tail = r.path ? `/${encodePath(r.path)}` : '';
  return `${base}/${view}/${encodePath(ctx.ref)}${tail}${r.fragment}`;
}

/**
 * Raw-file URL for a relative image in repository Markdown, or null to leave it alone. The raw
 * endpoint follows Git LFS pointers, so LFS-stored images work too.
 */
export function repoImageSrc(
  ctx: RepoMarkdownContext,
  src: string
): string | null {
  const r = resolveRepoPath(ctx.dir, src);
  if (!r || !r.path || r.isDir) return null;
  const query = new URLSearchParams({ ref: ctx.ref, path: r.path });
  return `/api/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}/raw?${query}`;
}
