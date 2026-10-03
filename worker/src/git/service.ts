import { structuredPatch } from 'diff';
import { mergeDiff3 } from 'node-diff3';
import { decoder } from './bytes';
import {
  makeBlob,
  makeCommit,
  makeTree,
  type GitObject,
  type Signature,
  type TreeEntry,
} from './objects';
import { ArtifactsRepoClient, ZERO_SHA } from './remote';

export type Commit = ArtifactsCommitMetadata;
export type Entry = ArtifactsTreeEntry;

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_WALK = 2000;
const MAX_DIFF_FILES = 300;
const MAX_DIFF_BYTES = 512 * 1024;

export class MergeConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(`Merge conflict in ${paths.join(', ')}`);
  }
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldHash: string | null;
  newHash: string | null;
  mode: string;
}

export interface FileDiff extends FileChange {
  additions: number;
  deletions: number;
  binary: boolean;
  tooLarge: boolean;
  hunks: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }[];
}

const isTree = (e: { mode: string }) =>
  e.mode === '40000' || e.mode === '040000';
const isRegularFile = (mode: string) => mode === '100644' || mode === '100755';

/** Text merge limits: larger or binary files are left as conflicts for a human. */
const MAX_MERGE_BYTES = 1024 * 1024;
function isBinaryOrHuge(bytes: Uint8Array) {
  return bytes.length > MAX_MERGE_BYTES || bytes.subarray(0, 8000).includes(0);
}

/** A file whose edits overlap: the three versions, and diff3 output with conflict markers. */
export interface ConflictFile {
  path: string;
  base: string | null;
  ours: string;
  theirs: string;
  withMarkers: string;
}

interface MergeState {
  created: GitObject[];
  conflicts: string[];
  /** Collects details of text conflicts when set. */
  conflictFiles?: ConflictFile[];
  /** Final contents for conflicted paths; `null` resolves a path as deleted. */
  resolutions?: Map<string, string | null>;
  /** Conflict marker labels: ours, base, theirs. */
  labels?: { a: string; o: string; b: string };
}

/** Read-and-write operations for one repo, built on the Artifacts binding plus smart HTTP. */
export class GitService {
  private commits = new Map<string, Commit>();
  private trees = new Map<string, Entry[]>();
  private refsCache?: Promise<Map<string, string>>;
  private headCache?: string | null;

  constructor(readonly client: ArtifactsRepoClient) {}

  // ── refs ───────────────────────────────────────────────────────────────────

  refs(): Promise<Map<string, string>> {
    this.refsCache ??= this.client.listRefs().then((ad) => {
      this.headCache = ad.head;
      return ad.refs;
    });
    return this.refsCache;
  }

  async branches(): Promise<{ name: string; sha: string }[]> {
    const refs = await this.refs();
    return [...refs]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), sha }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolve(ref: string): Promise<string | null> {
    if (SHA_RE.test(ref)) return ref;
    const refs = await this.refs();
    return (
      refs.get(`refs/heads/${ref}`) ??
      refs.get(`refs/tags/${ref}`) ??
      refs.get(ref) ??
      null
    );
  }

  // ── objects ────────────────────────────────────────────────────────────────

  async commit(sha: string): Promise<Commit | null> {
    const hit = this.commits.get(sha);
    if (hit) return hit;
    const c = await (await this.client.repo()).readCommit(sha);
    if (c) this.commits.set(sha, c);
    return c;
  }

  async tree(sha: string): Promise<Entry[]> {
    const hit = this.trees.get(sha);
    if (hit) return hit;
    const t = (await (await this.client.repo()).readTree(sha)) ?? [];
    this.trees.set(sha, t);
    return t;
  }

  async blob(sha: string): Promise<Uint8Array | null> {
    const b = await (await this.client.repo()).readBlob(sha);
    return b ? new Uint8Array(await b.arrayBuffer()) : null;
  }

  async log(ref: string, limit = 30, offset = 0): Promise<Commit[]> {
    const list = await (await this.client.repo()).log({ ref, limit, offset });
    for (const c of list) this.commits.set(c.hash, c);
    return list;
  }

  /** Resolves `path` inside a commit to a tree listing or a blob entry. */
  async entryAt(
    commitSha: string,
    path: string
  ): Promise<
    | { type: 'tree'; hash: string; entries: Entry[] }
    | { type: 'blob'; entry: Entry }
    | null
  > {
    const commit = await this.commit(commitSha);
    if (!commit) return null;
    let treeHash = commit.treeHash;
    const parts = path.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const entry = (await this.tree(treeHash)).find(
        (e) => e.name === parts[i]
      );
      if (!entry) return null;
      if (isTree(entry)) {
        treeHash = entry.hash;
        continue;
      }
      return i === parts.length - 1 ? { type: 'blob', entry } : null;
    }
    return { type: 'tree', hash: treeHash, entries: await this.tree(treeHash) };
  }

  /**
   * For each entry of the tree at `path`, the most recent commit (first-parent walk,
   * up to `depth` commits) that changed it.
   */
  async lastCommitsForTree(headSha: string, path: string, depth = 60) {
    const history = await this.log(headSha, depth);
    const result: Record<string, Commit> = {};
    const hashAt = async (c: Commit) => {
      const at = await this.entryAt(c.hash, path);
      return at?.type === 'tree'
        ? new Map(at.entries.map((e) => [e.name, e.hash]))
        : new Map();
    };
    let current = history.length
      ? await hashAt(history[0])
      : new Map<string, string>();
    const pending = new Set(current.keys());
    for (let i = 0; i < history.length && pending.size; i++) {
      const parent = history[i + 1];
      const prev = parent ? await hashAt(parent) : new Map<string, string>();
      for (const name of [...pending]) {
        if (prev.get(name) !== current.get(name)) {
          result[name] = history[i];
          pending.delete(name);
        }
      }
      current = prev;
    }
    return result;
  }

  // ── ancestry ───────────────────────────────────────────────────────────────

  /** First-parent chain of `sha` (up to 1000 commits), seeded into the commit cache. */
  private async firstParentChain(sha: string): Promise<Set<string>> {
    return new Set((await this.log(sha, 1000)).map((c) => c.hash));
  }

  /** Best common ancestor: BFS from `head` until it meets `base`'s history. */
  async mergeBase(base: string, head: string): Promise<string | null> {
    if (base === head) return base;
    const baseChain = await this.firstParentChain(base);
    await this.log(head, 1000);
    const seen = new Set<string>();
    const queue = [head];
    while (queue.length && seen.size < MAX_WALK) {
      const sha = queue.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (baseChain.has(sha)) return sha;
      const c = await this.commit(sha);
      if (c) queue.push(...c.parents);
    }
    return null;
  }

  /** Commits reachable from `head` but not from `base`, oldest first (reverse BFS order, so parents precede children). */
  async commitsBetween(base: string, head: string): Promise<Commit[]> {
    const baseChain = await this.firstParentChain(base);
    await this.log(head, 1000);
    const out: Commit[] = [];
    const seen = new Set<string>();
    const queue = [head];
    while (queue.length && seen.size < MAX_WALK) {
      const sha = queue.shift()!;
      if (seen.has(sha) || baseChain.has(sha)) continue;
      seen.add(sha);
      const c = await this.commit(sha);
      if (!c) continue;
      out.push(c);
      queue.push(...c.parents);
    }
    return out.reverse();
  }

  // ── diffs ──────────────────────────────────────────────────────────────────

  async diffTrees(
    a: string | null,
    b: string | null,
    prefix = ''
  ): Promise<FileChange[]> {
    if (a === b) return [];
    const left = a ? await this.tree(a) : [];
    const right = b ? await this.tree(b) : [];
    const lmap = new Map(left.map((e) => [e.name, e]));
    const rmap = new Map(right.map((e) => [e.name, e]));
    const names = [...new Set([...lmap.keys(), ...rmap.keys()])].sort();
    const out: FileChange[] = [];
    for (const name of names) {
      const l = lmap.get(name);
      const r = rmap.get(name);
      const path = prefix + name;
      if (l && r && l.hash === r.hash && l.mode === r.mode) continue;
      const lt = l && isTree(l);
      const rt = r && isTree(r);
      if (lt || rt) {
        out.push(
          ...(await this.diffTrees(
            lt ? l!.hash : null,
            rt ? r!.hash : null,
            path + '/'
          ))
        );
      }
      const lf = l && !lt ? l : null;
      const rf = r && !rt ? r : null;
      if (lf && rf) {
        out.push({
          path,
          status: 'modified',
          oldHash: lf.hash,
          newHash: rf.hash,
          mode: rf.mode,
        });
      } else if (lf) {
        out.push({
          path,
          status: 'removed',
          oldHash: lf.hash,
          newHash: null,
          mode: lf.mode,
        });
      } else if (rf) {
        out.push({
          path,
          status: 'added',
          oldHash: null,
          newHash: rf.hash,
          mode: rf.mode,
        });
      }
    }
    return out;
  }

  async fileDiffs(changes: FileChange[]): Promise<FileDiff[]> {
    const out: FileDiff[] = [];
    for (const [i, ch] of changes.entries()) {
      const base: FileDiff = {
        ...ch,
        additions: 0,
        deletions: 0,
        binary: false,
        tooLarge: false,
        hunks: [],
      };
      if (i >= MAX_DIFF_FILES || ch.mode === '160000') {
        out.push({ ...base, tooLarge: true });
        continue;
      }
      const [oldBytes, newBytes] = await Promise.all([
        ch.oldHash ? this.blob(ch.oldHash) : null,
        ch.newHash ? this.blob(ch.newHash) : null,
      ]);
      const size = (oldBytes?.length ?? 0) + (newBytes?.length ?? 0);
      if (size > MAX_DIFF_BYTES) {
        out.push({ ...base, tooLarge: true });
        continue;
      }
      if (isBinary(oldBytes) || isBinary(newBytes)) {
        out.push({ ...base, binary: true });
        continue;
      }
      const patch = structuredPatch(
        ch.path,
        ch.path,
        oldBytes ? decoder.decode(oldBytes) : '',
        newBytes ? decoder.decode(newBytes) : '',
        '',
        '',
        { context: 3 }
      );
      for (const h of patch.hunks) {
        for (const l of h.lines) {
          if (l[0] === '+') base.additions++;
          else if (l[0] === '-') base.deletions++;
        }
      }
      out.push({ ...base, hunks: patch.hunks });
    }
    return out;
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /**
   * Three-way merge of trees. Takes whole-file versions when only one side changed;
   * a file changed differently on both sides is a conflict (resolve locally).
   */
  /**
   * Three-way merges trees. Files changed on both sides are merged line by line (diff3); only
   * truly overlapping edits, or changes that can't be merged as text (binary files, a delete
   * against an edit, a file against a directory), become conflicts. `resolutions` supplies the
   * final contents of conflicted paths, e.g. from AI conflict resolution.
   */
  async mergeTrees(
    base: string | null,
    ours: string | null,
    theirs: string | null,
    state: MergeState,
    prefix = ''
  ): Promise<string | null> {
    if (ours === theirs) return ours;
    if (base === ours) return theirs;
    if (base === theirs) return ours;
    const [b, o, t] = await Promise.all([
      base ? this.tree(base) : [],
      ours ? this.tree(ours) : [],
      theirs ? this.tree(theirs) : [],
    ]);
    const bm = new Map(b.map((e) => [e.name, e]));
    const om = new Map(o.map((e) => [e.name, e]));
    const tm = new Map(t.map((e) => [e.name, e]));
    const result: TreeEntry[] = [];
    for (const name of new Set([...bm.keys(), ...om.keys(), ...tm.keys()])) {
      const be = bm.get(name);
      const oe = om.get(name);
      const te = tm.get(name);
      const path = prefix + name;
      const same = (x?: Entry, y?: Entry) =>
        (!x && !y) || (!!x && !!y && x.hash === y.hash && x.mode === y.mode);
      let pick: Entry | undefined;
      if (same(oe, te)) pick = oe;
      else if (same(be, oe)) pick = te;
      else if (same(be, te)) pick = oe;
      else if ((!oe || isTree(oe)) && (!te || isTree(te)) && (oe || te)) {
        const hash = await this.mergeTrees(
          be && isTree(be) ? be.hash : null,
          oe?.hash ?? null,
          te?.hash ?? null,
          state,
          path + '/'
        );
        if (hash) result.push({ name, mode: '40000', hash });
        continue;
      } else {
        const merged = await this.mergeFile(path, be, oe, te, state);
        if (merged) result.push({ name, mode: merged.mode, hash: merged.hash });
        continue;
      }
      if (pick)
        result.push({ name: pick.name, mode: pick.mode, hash: pick.hash });
    }
    if (!result.length) return null;
    const tree = await makeTree(result);
    state.created.push(tree);
    return tree.sha;
  }

  /** A file both sides changed: a supplied resolution, a clean line merge, or a conflict. */
  private async mergeFile(
    path: string,
    be: Entry | undefined,
    oe: Entry | undefined,
    te: Entry | undefined,
    state: MergeState
  ): Promise<{ mode: string; hash: string } | null> {
    const resolved = state.resolutions?.get(path);
    if (resolved !== undefined) {
      if (resolved === null) return null; // resolved as deleted
      const blob = await makeBlob(resolved);
      state.created.push(blob);
      return { mode: (oe ?? te)?.mode ?? '100644', hash: blob.sha };
    }
    const isFile = (e?: Entry) => !!e && isRegularFile(e.mode);
    // Text merge needs both sides present as regular files (a base is optional: add/add).
    if (!isFile(oe) || !isFile(te) || (be && !isFile(be))) {
      state.conflicts.push(path);
      return null;
    }
    const [bb, ob, tb] = await Promise.all([
      be ? this.blob(be.hash) : Promise.resolve(new Uint8Array()),
      this.blob(oe!.hash),
      this.blob(te!.hash),
    ]);
    if (!bb || !ob || !tb || [bb, ob, tb].some(isBinaryOrHuge)) {
      state.conflicts.push(path);
      return null;
    }
    const text = [bb, ob, tb].map((x) => decoder.decode(x));
    const merged = mergeDiff3(
      text[1].split('\n'),
      text[0].split('\n'),
      text[2].split('\n'),
      { label: state.labels ?? { a: 'ours', o: 'base', b: 'theirs' } }
    );
    // Mode: take a side's mode change (e.g. +x) when only one side made it.
    const mode = be && oe!.mode === be.mode ? te!.mode : oe!.mode;
    if (merged.conflict) {
      state.conflicts.push(path);
      state.conflictFiles?.push({
        path,
        base: be ? text[0] : null,
        ours: text[1],
        theirs: text[2],
        withMarkers: merged.result.join('\n'),
      });
      return null;
    }
    const blob = await makeBlob(merged.result.join('\n'));
    state.created.push(blob);
    return { mode, hash: blob.sha };
  }

  /** Computes the merged tree of `head` into `base` without writing anything. */
  async planMerge(
    baseSha: string,
    headSha: string,
    options: Pick<MergeState, 'resolutions' | 'labels'> & {
      collectConflictFiles?: boolean;
    } = {}
  ) {
    const mb = await this.mergeBase(baseSha, headSha);
    if (mb === headSha) return { upToDate: true as const };
    const [baseCommit, headCommit] = await Promise.all([
      this.commit(baseSha),
      this.commit(headSha),
    ]);
    if (!baseCommit || !headCommit) throw new Error('Missing commit');
    if (mb === baseSha) {
      return {
        upToDate: false as const,
        mergeBase: mb,
        tree: headCommit.treeHash,
        objects: [] as GitObject[],
        conflicts: [] as string[],
        conflictFiles: [] as ConflictFile[],
      };
    }
    const mbCommit = mb ? await this.commit(mb) : null;
    const state: MergeState = {
      created: [],
      conflicts: [],
      conflictFiles: options.collectConflictFiles ? [] : undefined,
      resolutions: options.resolutions,
      labels: options.labels,
    };
    const tree = await this.mergeTrees(
      mbCommit?.treeHash ?? null,
      baseCommit.treeHash,
      headCommit.treeHash,
      state
    );
    const emptyTree = tree ?? (await makeTree([])).sha;
    return {
      upToDate: false as const,
      mergeBase: mb,
      tree: emptyTree,
      objects: state.created,
      conflicts: state.conflicts,
      conflictFiles: state.conflictFiles ?? [],
    };
  }

  async merge(opts: {
    base: string;
    head: string;
    method: 'merge' | 'squash';
    message: string;
    author: Signature;
    extraRefs?: { ref: string; sha: string }[];
  }): Promise<{ sha: string; headSha: string }> {
    const baseSha = await this.resolve(opts.base);
    const headSha = await this.resolve(opts.head);
    if (!baseSha || !headSha) throw new Error('Branch not found');
    const plan = await this.planMerge(baseSha, headSha);
    if (plan.upToDate) throw new Error('Nothing to merge');
    if (plan.conflicts.length) throw new MergeConflictError(plan.conflicts);
    const commit = await makeCommit({
      tree: plan.tree,
      parents: opts.method === 'merge' ? [baseSha, headSha] : [baseSha],
      author: opts.author,
      message: opts.message,
    });
    const refs = await this.refs();
    await this.client.push(
      [
        { ref: `refs/heads/${opts.base}`, old: baseSha, new: commit.sha },
        ...(opts.extraRefs ?? []).map((r) => ({
          ref: r.ref,
          old: refs.get(r.ref) ?? ZERO_SHA,
          new: r.sha,
        })),
      ],
      [...plan.objects, commit]
    );
    return { sha: commit.sha, headSha };
  }

  async setRef(ref: string, sha: string) {
    const refs = await this.refs();
    if (refs.get(ref) === sha) return;
    await this.client.push(
      [{ ref, old: refs.get(ref) ?? ZERO_SHA, new: sha }],
      []
    );
  }

  async deleteBranch(name: string) {
    const sha = await this.resolve(name);
    if (!sha) return;
    await this.client.push(
      [{ ref: `refs/heads/${name}`, old: sha, new: ZERO_SHA }],
      []
    );
  }

  /** Creates the first commit on an empty repo (used for "Add a README file"). */
  async initialCommit(
    branch: string,
    files: Record<string, string>,
    author: Signature,
    message: string
  ) {
    const blobs = await Promise.all(
      Object.values(files).map((c) => makeBlob(c))
    );
    const tree = await makeTree(
      Object.keys(files).map((name, i) => ({
        name,
        mode: '100644',
        hash: blobs[i].sha,
      }))
    );
    const commit = await makeCommit({
      tree: tree.sha,
      parents: [],
      author,
      message,
    });
    await this.client.push(
      [{ ref: `refs/heads/${branch}`, old: ZERO_SHA, new: commit.sha }],
      [...blobs, tree, commit]
    );
    return commit.sha;
  }
}

function isBinary(bytes: Uint8Array | null): boolean {
  if (!bytes) return false;
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}
