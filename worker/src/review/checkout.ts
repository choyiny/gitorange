import { decoder } from '../git/bytes';
import type { GitService } from '../git/service';
import { REPO_ROOT } from './pi-contract';

export type CheckoutLimits = {
  /** Files written. */
  files: number;
  /** Bytes written in all. */
  bytes: number;
  /** One file's size. */
  fileBytes: number;
  /** Tree entries (files, directories, odd names) the walk visits before it stops. */
  walk: number;
  /** Distinct trees read (changed-file lookups and the walk together) before it stops. */
  trees: number;
  /** Directory depth the walk descends to. */
  depth: number;
  /** Blobs read (one Artifacts call each), whether or not they are written; the rest are over budget. */
  reads: number;
};

export const CHECKOUT_LIMITS: CheckoutLimits = {
  files: 3000,
  bytes: 24 * 1024 * 1024,
  fileBytes: 512 * 1024,
  walk: 20_000,
  // Tree reads and blob reads are one Artifacts call each: together at most 3,000 in one start.
  trees: 1000,
  depth: 64,
  reads: 2000,
};

/** Lines of not-checked-out.txt; the rest are counted. */
export const MAX_SKIPPED_LISTED = 500;

export type SkipReason =
  | 'ignored'
  | 'binary'
  | 'too large'
  | 'over budget'
  | 'submodule'
  | 'symlink'
  | 'unreadable'
  | 'bad name';

export type Checkout = {
  files: number;
  bytes: number;
  skipped: { path: string; reason: SkipReason }[];
  /** The walk hit a bound (entries, tree reads or depth): some files weren't even listed. */
  truncated: boolean;
};

const safeName = (name: string) =>
  name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
const isGit = (name: string) => name === '.git';
const isTree = (mode: string) => mode === '40000' || mode === '040000';
/** Like git: a NUL byte this early means binary. */
const NUL_SCAN = 8000;

/**
 * Writes the head commit's text files through `write` (repository-relative paths): the files in `first` (the
 * changed ones) first, in that order, then the rest in path order. Leaves out:
 * - submodules and symlinks, never materialised (a link could point out of /repo);
 * - `.git` entries and names that could leave /repo ('bad name');
 * - ignored files (lockfiles and `.orangeignore`), binary files, files over `fileBytes`, and everything past
 *   `files`, `reads` or `bytes`.
 * The changed files are looked up directly (only their ancestor trees are read, each counted once), so a
 * bounded walk of a huge tree still checks them out; one the tree budget can't reach is listed as over budget.
 * The walk then spends what is left of the budget. Throws when the commit can't be read.
 */
export async function checkoutHead(
  git: GitService,
  headSha: string,
  opts: {
    first: string[];
    ignored: (path: string) => boolean;
    limits?: Partial<CheckoutLimits>;
  },
  write: (path: string, text: string) => Promise<void>
): Promise<Checkout> {
  const limits = { ...CHECKOUT_LIMITS, ...opts.limits };
  const commit = await git.commit(headSha);
  if (!commit)
    throw new Error(`The commit ${headSha.slice(0, 7)} could not be read.`);
  type Item = { path: string; mode: string; hash: string };
  const badNames: string[] = [];
  const gitDirs: string[] = [];
  let truncated = false;
  let visited = 0;
  /** Trees already read: reading one again is free (GitService caches it), so it isn't counted. */
  const read = new Set<string>();
  /** Reads a tree against the budget; null when the budget is spent. */
  const readTree = async (hash: string) => {
    if (!read.has(hash)) {
      if (read.size >= limits.trees) return null;
      read.add(hash);
    }
    return git.tree(hash);
  };

  // The changed files, found directly; one whose trees the budget can't reach is listed as over budget.
  const firstItems: Item[] = [];
  const firstPaths = new Set<string>();
  const unreached: string[] = [];
  for (const path of new Set(opts.first)) {
    const parts = path.split('/');
    if (!parts.every((p) => safeName(p) && !isGit(p))) continue;
    let hash = commit.treeHash;
    let found: Item | null = null;
    for (let i = 0; i < parts.length; i++) {
      const entries = await readTree(hash);
      if (!entries) {
        unreached.push(path);
        break;
      }
      const e = entries.find((x) => x.name === parts[i]);
      if (!e) break;
      if (isTree(e.mode)) hash = e.hash;
      else {
        if (i === parts.length - 1)
          found = { path, mode: e.mode, hash: e.hash };
        break;
      }
    }
    if (found) {
      firstItems.push(found);
      firstPaths.add(path);
    }
  }
  if (unreached.length) truncated = true;

  // Everything else, bounded in entries, tree reads and depth.
  const rest: Item[] = [];
  const stack: { hash: string; prefix: string; depth: number }[] = [
    { hash: commit.treeHash, prefix: '', depth: 0 },
  ];
  const unreachedSet = new Set(unreached);
  let walking = true;
  while (stack.length && walking) {
    const dir = stack.pop()!;
    const entries = await readTree(dir.hash);
    if (!entries) {
      truncated = true;
      break;
    }
    for (const e of entries) {
      if (visited >= limits.walk) {
        truncated = true;
        walking = false;
        break;
      }
      visited += 1;
      const path = dir.prefix ? `${dir.prefix}/${e.name}` : e.name;
      // Names come from the tree: one that could leave /repo (or isn't a name) is never written.
      if (!safeName(e.name)) badNames.push(path);
      else if (isGit(e.name)) gitDirs.push(path);
      else if (isTree(e.mode)) {
        if (dir.depth + 1 >= limits.depth) truncated = true;
        else stack.push({ hash: e.hash, prefix: path, depth: dir.depth + 1 });
      } else if (!firstPaths.has(path) && !unreachedSet.has(path))
        rest.push({ path, mode: e.mode, hash: e.hash });
    }
  }
  rest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const entries = [...firstItems, ...rest];
  const repo = await git.client.repo();
  const out: Checkout = {
    files: 0,
    bytes: 0,
    skipped: [],
    truncated,
  };
  let reads = 0;
  for (const e of entries) {
    const skip = (reason: SkipReason) =>
      void out.skipped.push({ path: e.path, reason });
    if (e.mode === '160000') skip('submodule');
    else if (e.mode === '120000') skip('symlink');
    else if (opts.ignored(e.path)) skip('ignored');
    else if (out.files >= limits.files || reads >= limits.reads)
      skip('over budget');
    else {
      reads += 1;
      // The size comes with the Blob: a file over a budget is skipped before its bytes are copied out.
      const blob = await repo.readBlob(e.hash);
      if (!blob) skip('unreadable');
      else if (blob.size > limits.fileBytes) skip('too large');
      else if (out.bytes + blob.size > limits.bytes) skip('over budget');
      else {
        const data = new Uint8Array(await blob.arrayBuffer());
        if (data.subarray(0, NUL_SCAN).includes(0)) skip('binary');
        else {
          await write(e.path, decoder.decode(data));
          out.files += 1;
          out.bytes += data.length;
        }
      }
    }
  }
  for (const path of unreached)
    out.skipped.push({ path, reason: 'over budget' });
  for (const path of gitDirs) out.skipped.push({ path, reason: 'ignored' });
  for (const path of badNames) out.skipped.push({ path, reason: 'bad name' });
  return out;
}

/** The workspace's not-checked-out.txt: what was left out of REPO_ROOT, and why. */
export function notCheckedOutText(c: Checkout): string {
  if (!c.skipped.length && !c.truncated)
    return `Every file of the head commit is checked out under ${REPO_ROOT}.\n`;
  const listed = c.skipped
    .slice(0, MAX_SKIPPED_LISTED)
    .map((s) => `${s.path}: ${s.reason}`);
  const more = c.skipped.length - listed.length;
  return `${[
    `Not checked out under ${REPO_ROOT} (${c.skipped.length} files):`,
    ...listed,
    ...(more > 0 ? [`…and ${more} more`] : []),
    ...(c.truncated
      ? [
          `…and more: the tree has more than ${c.files + c.skipped.length} files`,
        ]
      : []),
  ].join('\n')}\n`;
}
