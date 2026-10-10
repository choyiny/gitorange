import { changesPatchId } from '../git/patch-id';
import type { Commit, GitService } from '../git/service';

/**
 * A branch's own commits over a target, parents first. Each has a rebase identity: author email, author time and
 * message, which `git rebase` (and GitOrange's rebase runs) keep. Two branches holding the same commits, or rebased
 * copies of them, share identities; a match between different SHAs counts only when the two commits' patch ids agree
 * too (`git/patch-id.ts`). That is how stacking tells a child from its parent without asking a model.
 */
export type Lineage = {
  shas: string[];
  ids: string[];
  /** The range was longer than MAX_LINEAGE: containment can't be told. */
  truncated: boolean;
};

/** Beyond this many commits a branch's lineage is not compared (no git verdict, no trimming). */
export const MAX_LINEAGE = 300;

async function identity(c: Commit): Promise<string> {
  const text = `${c.author.email.toLowerCase()}\n${c.authoredAt}\n${c.message.trim()}`;
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest).slice(0, 10)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** The commits `head` has over `base`, as a lineage. */
export async function lineageOf(
  git: GitService,
  base: string,
  head: string
): Promise<Lineage> {
  if (base === head) return { shas: [], ids: [], truncated: false };
  const commits = await git.commitsBetween(base, head);
  const kept = commits.slice(-MAX_LINEAGE);
  return {
    shas: kept.map((c) => c.hash),
    ids: await Promise.all(kept.map(identity)),
    truncated: commits.length > MAX_LINEAGE,
  };
}

// A commit's patch id never changes: remembered per isolate (capped), like `contains`.
const patchMemo = new Map<string, Promise<string | null>>();
const MAX_MEMO = 2000;

/** The patch id of what commit `sha` changed over its first parent; null when git can't say. */
function patchIdOf(git: GitService, sha: string): Promise<string | null> {
  const hit = patchMemo.get(sha);
  if (hit) return hit;
  const p = (async () => {
    const c = await git.commit(sha);
    if (!c) return null;
    const parent = c.parents[0] ? await git.commit(c.parents[0]) : null;
    const changes = await git.diffTrees(parent?.treeHash ?? null, c.treeHash);
    return changesPatchId(git, changes);
  })().catch(() => null);
  if (patchMemo.size >= MAX_MEMO)
    patchMemo.delete(patchMemo.keys().next().value!);
  patchMemo.set(sha, p);
  return p;
}

/**
 * The identities of `x`'s commits that `y` also holds: the same commit, or a copy with the same rebase identity and
 * patch id.
 */
export async function sharedWith(
  git: GitService,
  x: Lineage,
  y: Lineage
): Promise<Set<string>> {
  const theirs = new Map<string, string[]>();
  y.ids.forEach((id, i) =>
    theirs.set(id, [...(theirs.get(id) ?? []), y.shas[i]])
  );
  const out = new Set<string>();
  for (let i = 0; i < x.ids.length; i++) {
    const id = x.ids[i];
    const shas = theirs.get(id);
    if (!shas || out.has(id)) continue;
    if (shas.includes(x.shas[i])) {
      out.add(id);
      continue;
    }
    const mine = await patchIdOf(git, x.shas[i]);
    if (!mine) continue;
    for (const s of shas)
      if ((await patchIdOf(git, s)) === mine) {
        out.add(id);
        break;
      }
  }
  return out;
}

/** `outer` holds every commit of `inner` (or a rebased copy of it), and more. */
export async function holdsWhole(
  git: GitService,
  outer: Lineage,
  inner: Lineage
): Promise<boolean> {
  if (outer.truncated || inner.truncated || !inner.ids.length) return false;
  // Cheap first: every identity must be there before any patch id is read.
  const have = new Set(outer.ids);
  if (!inner.ids.every((i) => have.has(i))) return false;
  const want = new Set(inner.ids);
  if (have.size <= want.size) return false;
  return (await sharedWith(git, inner, outer)).size === want.size;
}

/**
 * The commit `x`'s own changes start from: the last of its leading commits that belong to `owned` (the commits of
 * open pull requests it holds whole). Null when none lead (its changes start at the target).
 */
export function ownBase(x: Lineage, owned: Set<string>): string | null {
  let k = 0;
  while (k < x.ids.length && owned.has(x.ids[k])) k++;
  // All of them: nothing of its own; compare it whole rather than as an empty change.
  if (k === 0 || k === x.ids.length) return null;
  return x.shas[k - 1];
}
