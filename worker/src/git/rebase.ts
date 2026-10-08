import {
  makeCommit,
  makeTree,
  type GitObject,
  type Signature,
  type TreeEntry,
} from './objects';
import { changesPatchId, patchId } from './patch-id';
import type { Commit, ConflictFile, FileChange, GitService } from './service';

/** At most this many of a branch's own commits are replayed in one rebase. */
export const MAX_REBASE_COMMITS = 100;
/** The newest commits that reached the target since the merge base, checked for patch identity. */
const MAX_UPSTREAM = 500;
/** The trailer of a commit whose conflicts AI resolved. */
export const RESOLVED_TRAILER = 'Conflicts-resolved-by: GitOrange AI';
/** The committer of every rebased commit (its author stays the original one). */
export const REBASE_COMMITTER = {
  name: 'GitOrange',
  email: 'noreply@gitorange',
};

/** Resolved contents of conflicting commits: original commit sha → path → content (null deletes it). */
export type CommitResolutions = Map<string, Map<string, string | null>>;

export type ReplayedCommit = {
  original: string;
  rebased: string;
  /** Its conflicts were resolved (it carries RESOLVED_TRAILER). */
  resolved: boolean;
};

export type RebaseResult =
  /** The head already contains the target. */
  | { kind: 'up_to_date' }
  | { kind: 'too_many'; count: number }
  | {
      kind: 'done';
      head: string;
      commits: ReplayedCommit[];
      /** Commits left out: the target already had their change (patch identity), or nothing of it was left. */
      skipped: number;
      /**
       * Every replayed commit that needed no resolution makes the same change as before, and so do the merge commits'
       * own edits (the CARRY_OVER_MESSAGE commit); false after an octopus merge, whose edits aren't carried.
       */
      samePatches: boolean;
      /** Every object the rebase made: what a push sends. */
      objects: GitObject[];
    }
  | {
      kind: 'conflict';
      /** The commit the replay stopped at. */
      commit: Commit;
      conflicts: string[];
      /** Text conflicts, with diff3 markers (labels: the target, then the commit's sha7). */
      files: ConflictFile[];
      replayed: ReplayedCommit[];
      skipped: number;
    };

export type RebaseOptions = {
  head: string;
  onto: string;
  committer: Signature;
  /** The target's name in conflict markers. */
  ontoLabel?: string;
  resolutions?: CommitResolutions;
};

const TRAILER_LINE = /^[A-Za-z][\w-]*: \S.*$/;

/** `message` with RESOLVED_TRAILER: in its trailer block when it ends in one, else as a new paragraph. */
export function withResolvedTrailer(message: string): string {
  const body = message.replace(/\s+$/, '');
  const paragraphs = body.split(/\n\n/);
  const last = paragraphs.at(-1) ?? '';
  const inBlock =
    paragraphs.length > 1 &&
    last.split('\n').every((l) => TRAILER_LINE.test(l));
  return `${body}${inBlock ? '\n' : '\n\n'}${RESOLVED_TRAILER}`;
}

async function parentTree(git: GitService, c: Commit): Promise<string | null> {
  if (!c.parents.length) return null;
  const p = await git.commit(c.parents[0]);
  if (!p) throw new Error(`Missing commit ${c.parents[0]}`);
  return p.treeHash;
}

const pathsKey = (changes: FileChange[]) =>
  changes
    .map((c) => c.path)
    .sort()
    .join('\0');

/** The message of the commit that brings over edits made inside a branch's merge commits. */
export const CARRY_OVER_MESSAGE = 'Carry over changes made in merge commits';

/**
 * `commits` ordered so each comes after its parents within the set (Kahn's algorithm; ties keep the given order).
 * `commitsBetween` walks breadth-first, which can put a side branch's commit before its own parent.
 */
function topological(commits: Commit[]): Commit[] {
  const inSet = new Set(commits.map((c) => c.hash));
  const waiting = new Map(
    commits.map((c) => [c.hash, c.parents.filter((p) => inSet.has(p)).length])
  );
  const children = new Map<string, string[]>();
  for (const c of commits)
    for (const p of new Set(c.parents))
      if (inSet.has(p)) children.set(p, [...(children.get(p) ?? []), c.hash]);
  const order = new Map(commits.map((c, i) => [c.hash, i]));
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const ready = commits.filter((c) => waiting.get(c.hash) === 0);
  const out: Commit[] = [];
  while (ready.length) {
    ready.sort((a, b) => order.get(a.hash)! - order.get(b.hash)!);
    const c = ready.shift()!;
    out.push(c);
    for (const child of children.get(c.hash) ?? []) {
      const n = waiting.get(child)! - 1;
      waiting.set(child, n);
      if (n === 0) ready.push(byHash.get(child)!);
    }
  }
  return out;
}

const isTreeMode = (mode: string) => mode === '40000' || mode === '040000';

/** `tree` with each path in `sets` replaced by an entry (null removes it); new trees go to `made`. Null when empty. */
async function setPaths(
  git: GitService,
  tree: string | null,
  sets: Map<string, { mode: string; hash: string } | null>,
  made: GitObject[]
): Promise<string | null> {
  const entries = new Map<string, TreeEntry>(
    (tree ? await git.tree(tree) : []).map((e) => [
      e.name,
      { name: e.name, mode: e.mode, hash: e.hash },
    ])
  );
  const dirs = new Map<string, typeof sets>();
  for (const [path, entry] of sets) {
    const slash = path.indexOf('/');
    if (slash >= 0) {
      const name = path.slice(0, slash);
      const sub = dirs.get(name) ?? new Map();
      sub.set(path.slice(slash + 1), entry);
      dirs.set(name, sub);
    } else if (entry) entries.set(path, { name: path, ...entry });
    else entries.delete(path);
  }
  for (const [name, sub] of dirs) {
    const old = entries.get(name);
    const hash = await setPaths(
      git,
      old && isTreeMode(old.mode) ? old.hash : null,
      sub,
      made
    );
    if (hash) entries.set(name, { name, mode: '40000', hash });
    else entries.delete(name);
  }
  if (!entries.size) return null;
  const t = await makeTree([...entries.values()]);
  made.push(t);
  return t.sha;
}

/**
 * The tree a two-parent merge commit would have had with no edits of its own, decided per path: each path its
 * parents merge cleanly takes the clean merge; each path they conflict in takes the merge commit's own entry, so a
 * hand-resolved conflict counts as no edit (it conflicts again, and is resolved, in the replay of the branch's own
 * commits). Made objects are staged, never pushed. Null when the merge has no own delta to look at (an octopus).
 */
async function autoMerge(
  git: GitService,
  merge: Commit
): Promise<string | null> {
  if (merge.parents.length !== 2) return null;
  const [p0, p1] = await Promise.all(merge.parents.map((p) => git.commit(p)));
  if (!p0 || !p1) throw new Error(`Missing parent of ${merge.hash}`);
  const base = await git.mergeBase(p0.hash, p1.hash);
  const baseTree = base ? ((await git.commit(base))?.treeHash ?? null) : null;
  const state = { created: [] as GitObject[], conflicts: [] as string[] };
  let tree = await git.mergeTrees(baseTree, p0.treeHash, p1.treeHash, state);
  git.stage(state.created);
  if (state.conflicts.length) {
    const own = new Map<string, { mode: string; hash: string } | null>();
    for (const path of state.conflicts) {
      const at = await git.entryAt(merge.hash, path);
      own.set(
        path,
        !at
          ? null
          : at.type === 'tree'
            ? { mode: '40000', hash: at.hash }
            : { mode: at.entry.mode, hash: at.entry.hash }
      );
    }
    const made: GitObject[] = [];
    tree = await setPaths(git, tree, own, made);
    git.stage(made);
  }
  if (tree) return tree;
  const empty = await makeTree([]);
  git.stage([empty]);
  return empty.sha;
}

type Merged = {
  tree: string | null;
  created: GitObject[];
  conflicts: string[];
  files: ConflictFile[];
  /** Supplied resolutions were needed and used. */
  resolved: boolean;
};

/**
 * A three-way tree merge that uses `resolutions` only for the files that conflict without them, so a stale resolution
 * never overwrites a file that now merges cleanly.
 */
async function mergeResolving(
  git: GitService,
  trees: [base: string | null, ours: string | null, theirs: string | null],
  labels: { a: string; o: string; b: string },
  resolutions: Map<string, string | null> | undefined
): Promise<Merged> {
  const run = async (res?: Map<string, string | null>) => {
    const state = {
      created: [] as GitObject[],
      conflicts: [] as string[],
      conflictFiles: [] as ConflictFile[],
      resolutions: res,
      labels,
    };
    const tree = await git.mergeTrees(...trees, state);
    return {
      tree,
      created: state.created,
      conflicts: state.conflicts,
      files: state.conflictFiles,
      resolved: !!res,
    };
  };
  const clean = await run();
  if (!clean.conflicts.length || !resolutions?.size) return clean;
  const used = new Map(
    [...resolutions].filter(([path]) => clean.conflicts.includes(path))
  );
  if (!used.size) return clean;
  const again = await run(used);
  return again.conflicts.length ? { ...again, resolved: false } : again;
}

/**
 * Replays `head`'s own commits (since its merge base with `onto`, parents before children) onto `onto`. Each commit
 * is a three-way tree merge (base: its parent's tree; ours: the replay so far; theirs: the commit's tree) and keeps
 * its author, author date and message; the committer is `opts.committer`. Merge commits are flattened; edits made
 * inside them (each two-parent merge's tree against its parents merged path by path, see autoMerge; octopus merges
 * carry nothing) are applied onto the replay and brought over by one extra commit (CARRY_OVER_MESSAGE). Commits already in `onto`'s history, and commits whose patch identity
 * matches one that reached `onto` since the merge base, are left out, as are commits with nothing left to apply. Stops
 * at the first commit (or merge commit's own edits) that conflicts, unless `opts.resolutions` has contents for its
 * conflicting files. Pushes nothing: the new objects are returned (and staged on `git`). Deterministic: the same
 * inputs give the same commits.
 */
export async function rebase(
  git: GitService,
  opts: RebaseOptions
): Promise<RebaseResult> {
  const mb = await git.mergeBase(opts.onto, opts.head);
  if (mb === opts.onto) return { kind: 'up_to_date' };
  const onto = await git.commit(opts.onto);
  if (!onto) throw new Error(`Missing commit ${opts.onto}`);
  const all = topological(await git.commitsBetween(opts.onto, opts.head));
  const merges = all.filter((c) => c.parents.length > 1);
  const own = all.filter((c) => c.parents.length <= 1);
  if (own.length > MAX_REBASE_COMMITS)
    return { kind: 'too_many', count: own.length };

  const changes = new Map<string, FileChange[]>();
  for (const c of own)
    changes.set(
      c.hash,
      await git.diffTrees(await parentTree(git, c), c.treeHash)
    );
  // Identities of what reached the target, only for commits touching exactly the paths one of ours touches.
  // (Like git, a change the target made and later reverted still matches, so that branch commit is skipped.)
  const keys = new Set([...changes.values()].map(pathsKey));
  const landed = new Set<string>();
  if (mb)
    for (const u of (await git.commitsBetween(opts.head, opts.onto)).slice(
      -MAX_UPSTREAM
    )) {
      if (u.parents.length > 1) continue;
      const ch = await git.diffTrees(await parentTree(git, u), u.treeHash);
      if (keys.has(pathsKey(ch))) landed.add(await changesPatchId(git, ch));
    }

  // Deduplicated by sha: replays often make the same blob or tree twice, and a push sends each object once.
  const objects = new Map<string, GitObject>();
  const keep = (made: GitObject[]) => {
    git.stage(made);
    for (const o of made) objects.set(o.sha, o);
  };
  const emptyTree = async () => {
    const empty = await makeTree([]);
    keep([empty]);
    return empty.sha;
  };
  const label = opts.ontoLabel ?? 'onto';
  const commits: ReplayedCommit[] = [];
  let skipped = 0;
  let samePatches = true;
  let tip = opts.onto;
  let tree = onto.treeHash;
  for (const c of own) {
    const id = await changesPatchId(git, changes.get(c.hash)!);
    if (landed.has(id)) {
      // Left out, as git does. Still the same change only if the target really has it: replaying it changes nothing.
      // (One the target landed and later reverted would change the tree: the pull request's change is not the same.)
      if (samePatches) {
        const again = await mergeResolving(
          git,
          [await parentTree(git, c), tree, c.treeHash],
          { a: label, o: 'base', b: c.hash.slice(0, 7) },
          undefined
        );
        git.stage(again.created);
        samePatches = !again.conflicts.length && again.tree === tree;
      }
      skipped++;
      continue;
    }
    const m = await mergeResolving(
      git,
      [await parentTree(git, c), tree, c.treeHash],
      { a: label, o: 'base', b: c.hash.slice(0, 7) },
      opts.resolutions?.get(c.hash)
    );
    if (m.conflicts.length)
      return {
        kind: 'conflict',
        commit: c,
        conflicts: m.conflicts,
        files: m.files,
        replayed: commits,
        skipped,
      };
    keep(m.created);
    const merged = m.tree ?? (await emptyTree());
    if (merged === tree) {
      skipped++; // nothing of it is left to apply
      continue;
    }
    const commit = await makeCommit({
      tree: merged,
      parents: [tip],
      author: {
        name: c.author.name,
        email: c.author.email,
        timestamp: c.authoredAt,
      },
      committer: opts.committer,
      message: m.resolved ? withResolvedTrailer(c.message) : c.message,
    });
    keep([commit]);
    if (!m.resolved && samePatches)
      samePatches = (await patchId(git, tree, merged)) === id;
    commits.push({
      original: c.hash,
      rebased: commit.sha,
      resolved: m.resolved,
    });
    tip = commit.sha;
    tree = merged;
  }

  // Edits made inside merge commits (a conflict fix, a build fix): each merge's own delta, from what merging its
  // parents gives to what it records, applied onto the replay. Never the whole branch, which would undo the skips.
  let carried = tree;
  let lastCarried: Commit | null = null;
  let carriedResolved = false;
  for (const merge of merges) {
    const auto = await autoMerge(git, merge);
    // An octopus merge's own edits can't be told apart, so none are carried: the change may not be the same.
    if (!auto) samePatches = false;
    if (!auto || auto === merge.treeHash) continue; // no edits of its own
    const m = await mergeResolving(
      git,
      [auto, carried, merge.treeHash],
      { a: label, o: 'base', b: merge.hash.slice(0, 7) },
      opts.resolutions?.get(merge.hash)
    );
    if (m.conflicts.length)
      return {
        kind: 'conflict',
        commit: merge,
        conflicts: m.conflicts,
        files: m.files,
        replayed: commits,
        skipped,
      };
    keep(m.created);
    const next = m.tree ?? (await emptyTree());
    // Like a replayed commit: the merge's own edits must make the same change (nothing left of them is a skip).
    if (!m.resolved && samePatches && next !== carried)
      samePatches =
        (await patchId(git, carried, next)) ===
        (await patchId(git, auto, merge.treeHash));
    carried = next;
    lastCarried = merge;
    carriedResolved ||= m.resolved;
  }
  if (lastCarried && carried !== tree) {
    const commit = await makeCommit({
      tree: carried,
      parents: [tip],
      author: opts.committer,
      committer: opts.committer,
      message: carriedResolved
        ? withResolvedTrailer(CARRY_OVER_MESSAGE)
        : CARRY_OVER_MESSAGE,
    });
    keep([commit]);
    commits.push({
      original: lastCarried.hash,
      rebased: commit.sha,
      resolved: carriedResolved,
    });
    tip = commit.sha;
  }
  return {
    kind: 'done',
    head: tip,
    commits,
    skipped,
    samePatches,
    objects: [...objects.values()],
  };
}
