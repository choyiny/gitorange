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
