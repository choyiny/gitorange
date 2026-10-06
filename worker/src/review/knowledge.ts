import { decoder } from '../git/bytes';
import type { GitService } from '../git/service';

export const KNOWLEDGE_DIR = 'knowledge';
export const MAX_KNOWLEDGE_FILES = 20;
export const MAX_KNOWLEDGE_BYTES = 64 * 1024;
/** Tree entries the walk visits before it gives up; unread paths named in full. */
export const MAX_KNOWLEDGE_ENTRIES = 200;
export const MAX_UNREAD_LISTED = 50;

/** What a review reads from `knowledge/`, and what it only lists by path. */
export type Knowledge = {
  files: { path: string; text: string }[];
  unread: string[];
};

const isTree = (mode: string) => mode === '40000' || mode === '040000';

async function markdownUnder(
  git: GitService,
  treeHash: string,
  prefix: string,
  walk: { visited: number; truncated: boolean }
): Promise<{ path: string; hash: string }[]> {
  const out: { path: string; hash: string }[] = [];
  for (const e of await git.tree(treeHash)) {
    if (walk.visited >= MAX_KNOWLEDGE_ENTRIES) {
      walk.truncated = true;
      break;
    }
    walk.visited++;
    const path = `${prefix}/${e.name}`;
    if (isTree(e.mode))
      out.push(...(await markdownUnder(git, e.hash, path, walk)));
    else if (/\.md$/i.test(e.name)) out.push({ path, hash: e.hash });
  }
  return out;
}

/**
 * The agent's `knowledge/**\/*.md` at `sha`, in path order: read while they fit in 20 files and 64 KB in total;
 * from the first one that doesn't fit, every later file is listed by path instead.
 */
export async function readKnowledge(
  git: GitService,
  sha: string
): Promise<Knowledge> {
  const dir = await git.entryAt(sha, KNOWLEDGE_DIR);
  if (dir?.type !== 'tree') return { files: [], unread: [] };
  const walk = { visited: 0, truncated: false };
  const all = (await markdownUnder(git, dir.hash, KNOWLEDGE_DIR, walk)).sort(
    (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
  const files: Knowledge['files'] = [];
  const unread: string[] = [];
  let bytes = 0;
  for (const f of all) {
    if (unread.length || files.length >= MAX_KNOWLEDGE_FILES) {
      unread.push(f.path);
      continue;
    }
    // The size comes with the Blob (as for AGENT.md): a file over the budget is listed before its bytes load.
    const blob = await (await git.client.repo()).readBlob(f.hash);
    if (!blob || bytes + blob.size > MAX_KNOWLEDGE_BYTES) {
      unread.push(f.path);
      continue;
    }
    const data = new Uint8Array(await blob.arrayBuffer());
    bytes += data.length;
    files.push({ path: f.path, text: decoder.decode(data) });
  }
  const listed = unread.slice(0, MAX_UNREAD_LISTED);
  const more = unread.length - listed.length;
  if (more > 0) listed.push(`…and ${more} more`);
  else if (walk.truncated) listed.push('…and more');
  return { files, unread: listed };
}
