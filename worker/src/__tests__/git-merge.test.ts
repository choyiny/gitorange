import { describe, expect, it } from 'vitest';
import { ArtifactsRepoClient } from '../git/remote';
import { GitService } from '../git/service';
import { decoder } from '../git/bytes';
import { createFakeArtifacts } from './helpers/fake-artifacts';
import { commitFiles } from './helpers/seed';

const LINES = (n: number, tag = '') =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}`).join('\n') + '\n';

/** A repo with `base` on main, then `ours` on main and `theirs` on feature, both from base. */
async function diverged(
  base: Record<string, string>,
  ours: Record<string, string>,
  theirs: Record<string, string>
) {
  const fake = createFakeArtifacts();
  await fake.binding.create('r');
  const repo = fake.repos.get('r')!;
  const root = await commitFiles(repo, 'main', base, 'base');
  const oursSha = await commitFiles(repo, 'main', ours, 'ours');
  const theirsSha = await commitFiles(repo, 'feature', theirs, 'theirs', [
    root,
  ]);
  const git = new GitService(new ArtifactsRepoClient(fake.binding, 'r'));
  /** Planned objects only exist in memory until pushed; store them so they can be read. */
  const keep = (plan: { objects?: Parameters<typeof repo.add> }) =>
    repo.add(...(plan.objects ?? []));
  return { git, repo, oursSha, theirsSha, keep };
}

async function fileAt(git: GitService, tree: string, name: string) {
  const entry = (await git.tree(tree)).find((e) => e.name === name);
  return entry ? decoder.decode((await git.blob(entry.hash))!) : null;
}

describe('line-level merge', () => {
  it('merges edits to different parts of the same file', async () => {
    const base = LINES(20);
    const ours = base.replace('line 2\n', 'line 2 (ours)\n');
    const theirs = base.replace('line 18\n', 'line 18 (theirs)\n');
    const { git, oursSha, theirsSha, keep } = await diverged(
      { 'a.txt': base },
      { 'a.txt': ours },
      { 'a.txt': theirs }
    );
    const plan = await git.planMerge(oursSha, theirsSha);
    if (plan.upToDate) throw new Error('unexpected');
    keep(plan);
    expect(plan.conflicts).toEqual([]);
    const merged = await fileAt(git, plan.tree, 'a.txt');
    expect(merged).toContain('line 2 (ours)');
    expect(merged).toContain('line 18 (theirs)');
  });

  it('reports overlapping edits with diff3 markers and both sides', async () => {
    const base = LINES(5);
    const { git, oursSha, theirsSha, keep } = await diverged(
      { 'a.txt': base, 'b.txt': 'same\n' },
      { 'a.txt': base.replace('line 3', 'line 3 ours'), 'b.txt': 'same\n' },
      { 'a.txt': base.replace('line 3', 'line 3 theirs'), 'b.txt': 'same\n' }
    );
    const plan = await git.planMerge(oursSha, theirsSha, {
      collectConflictFiles: true,
      labels: { a: 'main', o: 'base', b: 'feature' },
    });
    if (plan.upToDate) throw new Error('unexpected');
    keep(plan);
    expect(plan.conflicts).toEqual(['a.txt']);
    expect(plan.conflictFiles).toHaveLength(1);
    const file = plan.conflictFiles[0];
    expect(file).toMatchObject({ path: 'a.txt', base });
    expect(file.withMarkers).toContain('<<<<<<< main');
    expect(file.withMarkers).toContain('||||||| base');
    expect(file.withMarkers).toContain('>>>>>>> feature');
    expect(file.withMarkers).toContain('line 3 ours');
    expect(file.withMarkers).toContain('line 3 theirs');
    // Untouched files still merge.
    expect(await fileAt(git, plan.tree, 'b.txt')).toBe('same\n');
  });

  it('applies supplied resolutions for conflicted paths', async () => {
    const base = LINES(3);
    const { git, oursSha, theirsSha, keep } = await diverged(
      { 'a.txt': base },
      { 'a.txt': 'ours\n' },
      { 'a.txt': 'theirs\n' }
    );
    const plan = await git.planMerge(oursSha, theirsSha, {
      resolutions: new Map([['a.txt', 'resolved\n']]),
    });
    if (plan.upToDate) throw new Error('unexpected');
    keep(plan);
    expect(plan.conflicts).toEqual([]);
    expect(await fileAt(git, plan.tree, 'a.txt')).toBe('resolved\n');
  });

  it('keeps binary files and delete/modify as conflicts', async () => {
    const { git, oursSha, theirsSha, keep } = await diverged(
      { 'img.bin': 'a\u0000b', 'gone.txt': 'x\n' },
      { 'img.bin': 'a\u0000c', 'gone.txt': 'x changed\n' },
      { 'img.bin': 'a\u0000d' }
    );
    // theirs (feature) only kept img.bin, so it deleted gone.txt
    const plan = await git.planMerge(oursSha, theirsSha, {
      collectConflictFiles: true,
    });
    if (plan.upToDate) throw new Error('unexpected');
    keep(plan);
    expect(plan.conflicts.sort()).toEqual(['gone.txt', 'img.bin']);
    expect(plan.conflictFiles).toEqual([]);
  });

  it('merges files both sides added differently only when they agree line-wise', async () => {
    const { git, oursSha, theirsSha, keep } = await diverged(
      { 'keep.txt': 'k\n' },
      { 'keep.txt': 'k\n', 'new.txt': 'one\n' },
      { 'keep.txt': 'k\n', 'new.txt': 'two\n' }
    );
    const plan = await git.planMerge(oursSha, theirsSha, {
      collectConflictFiles: true,
    });
    if (plan.upToDate) throw new Error('unexpected');
    keep(plan);
    expect(plan.conflicts).toEqual(['new.txt']);
    expect(plan.conflictFiles[0].base).toBeNull();
  });
});

describe('leftover conflict markers', () => {
  it('finds marker lines with their positions, ignoring look-alikes', async () => {
    const { markerLines } = await import('../merge/resolver');
    expect(
      markerLines({
        'a.py': 'ok\n<<<<<<< main\nx\n=======\ny\n>>>>>>> feature\n',
        'b.md':
          '======= heading underline is not a marker? it is: 7 then space\n',
        'c.txt': '<<<<<<<< eight is not a marker\nclean\n',
      })
    ).toEqual([
      { path: 'a.py', line: 2, text: '<<<<<<< main' },
      { path: 'a.py', line: 4, text: '=======' },
      { path: 'a.py', line: 6, text: '>>>>>>> feature' },
      {
        path: 'b.md',
        line: 1,
        text: '======= heading underline is not a marker? it is: 7 then space',
      },
    ]);
  });
});
