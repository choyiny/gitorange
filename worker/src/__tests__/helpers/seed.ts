import {
  makeBlob,
  makeCommit,
  makeTree,
  type TreeEntry,
} from '../../git/objects';
import type { FakeRepo } from './fake-artifacts';

let clock = 1_700_000_000;

/** Writes a commit with the given flat files onto `branch` in the fake repo, like a `git push`. */
export async function commitFiles(
  repo: FakeRepo,
  branch: string,
  files: Record<string, string>,
  message: string,
  parents?: string[]
) {
  const blobs = await Promise.all(
    Object.entries(files).map(
      async ([name, content]) => [name, await makeBlob(content)] as const
    )
  );
  const entries: TreeEntry[] = blobs.map(([name, b]) => ({
    name,
    mode: '100644',
    hash: b.sha,
  }));
  const tree = await makeTree(entries);
  const parent =
    parents ??
    (repo.refs.get(`refs/heads/${branch}`)
      ? [repo.refs.get(`refs/heads/${branch}`)!]
      : []);
  const commit = await makeCommit({
    tree: tree.sha,
    parents: parent,
    author: { name: 'Dev', email: 'dev@example.com', timestamp: clock++ },
    message,
  });
  repo.add(...blobs.map(([, b]) => b), tree, commit);
  repo.refs.set(`refs/heads/${branch}`, commit.sha);
  return commit.sha;
}

/** Like commitFiles, but paths may contain directories (`.github/workflows/ci.yml`). */
export async function commitPaths(
  repo: FakeRepo,
  branch: string,
  files: Record<string, string>,
  message: string,
  opts: { moveRef?: boolean } = {}
) {
  type Dir = { files: Map<string, string>; dirs: Map<string, Dir> };
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/');
    let d = root;
    for (const p of parts.slice(0, -1)) {
      if (!d.dirs.has(p)) d.dirs.set(p, { files: new Map(), dirs: new Map() });
      d = d.dirs.get(p)!;
    }
    d.files.set(parts[parts.length - 1], content);
  }
  const write = async (d: Dir): Promise<string> => {
    const entries: TreeEntry[] = [];
    for (const [name, content] of d.files) {
      const b = await makeBlob(content);
      repo.add(b);
      entries.push({ name, mode: '100644', hash: b.sha });
    }
    for (const [name, sub] of d.dirs)
      entries.push({ name, mode: '40000', hash: await write(sub) });
    const tree = await makeTree(entries);
    repo.add(tree);
    return tree.sha;
  };
  const parent = repo.refs.get(`refs/heads/${branch}`);
  const commit = await makeCommit({
    tree: await write(root),
    parents: parent ? [parent] : [],
    author: { name: 'Dev', email: 'dev@example.com', timestamp: clock++ },
    message,
  });
  repo.add(commit);
  if (opts.moveRef !== false) repo.refs.set(`refs/heads/${branch}`, commit.sha);
  return commit.sha;
}
