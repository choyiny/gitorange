import { describe, expect, it } from 'vitest';
import { ArtifactsRepoClient } from '../git/remote';
import { GitService } from '../git/service';
import { decoder } from '../git/bytes';
import { patchId } from '../git/patch-id';
import {
  CARRY_OVER_MESSAGE,
  rebase,
  REBASE_COMMITTER,
  RESOLVED_TRAILER,
  withResolvedTrailer,
} from '../git/rebase';
import { createFakeArtifacts, type FakeRepo } from './helpers/fake-artifacts';
import { commitFiles } from './helpers/seed';

const AT = { ...REBASE_COMMITTER, timestamp: 1_800_000_000 };
const ALICE = { name: 'Alice', email: 'alice@example.com' };
const LINES = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
/** `text` with line `n` tagged. */
const edit = (text: string, n: number, tag: string) =>
  text.replace(`line ${n}\n`, `line ${n} ${tag}\n`);

async function fixture() {
  const fake = createFakeArtifacts();
  await fake.binding.create('r');
  const repo = fake.repos.get('r')!;
  const git = new GitService(new ArtifactsRepoClient(fake.binding, 'r'));
  return { fake, repo, git };
}

/** A file at a commit; the rebase's objects must have been added to the fake first. */
async function text(git: GitService, commit: string, path: string) {
  const at = await git.entryAt(commit, path);
  return at?.type === 'blob'
    ? decoder.decode((await git.blob(at.entry.hash))!)
    : null;
}

/** Throws unless the rebase finished; keeps its objects readable from the fake. */
function done(repo: FakeRepo, r: Awaited<ReturnType<typeof rebase>>) {
  if (r.kind !== 'done') throw new Error(`expected done, got ${r.kind}`);
  repo.add(...r.objects);
  return r;
}

describe('rebase', () => {
  it('replays the branch’s commits onto the target, keeping authors, dates and messages', async () => {
    const { repo, git } = await fixture();
    const base = LINES(20);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    const f1 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1') },
      'First',
      [root],
      ALICE
    );
    const f2 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(edit(base, 2, 'f1'), 18, 'f2') },
      'Second\n\nWith a body.',
      undefined,
      ALICE
    );
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 10, 'main') },
      'Main moves'
    );
    const r = done(
      repo,
      await rebase(git, {
        head: f2,
        onto: tip,
        committer: AT,
        ontoLabel: 'main',
      })
    );
    expect(r.commits.map((c) => [c.original, c.resolved])).toEqual([
      [f1, false],
      [f2, false],
    ]);
    expect(r.skipped).toBe(0);
    expect(r.samePatches).toBe(true);
    const second = repo.parseCommit(r.head)!;
    const first = repo.parseCommit(second.parents[0])!;
    expect(first.parents).toEqual([tip]);
    expect([first.message, second.message]).toEqual([
      'First',
      'Second\n\nWith a body.',
    ]);
    for (const [c, original] of [
      [first, f1],
      [second, f2],
    ] as const) {
      expect(c.author).toEqual(ALICE);
      expect(c.authoredAt).toBe(repo.parseCommit(original)!.authoredAt);
      expect(c.committer).toEqual({
        name: 'GitOrange',
        email: 'noreply@gitorange',
      });
      expect(c.committedAt).toBe(AT.timestamp);
    }
    expect(await text(git, r.head, 'a.txt')).toBe(
      edit(edit(edit(base, 2, 'f1'), 10, 'main'), 18, 'f2')
    );
  });

  it('is up to date when the head already contains the target', async () => {
    const { repo, git } = await fixture();
    const root = await commitFiles(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    const head = await commitFiles(
      repo,
      'feature',
      { 'a.txt': 'b\n' },
      'Change',
      [root]
    );
    expect(await rebase(git, { head, onto: root, committer: AT })).toEqual({
      kind: 'up_to_date',
    });
  });

  it('skips a commit the target already has under another sha, wherever it landed in the file', async () => {
    const { repo, git } = await fixture();
    const base = LINES(20);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1') },
      'Fix line 2',
      [root]
    );
    const f2 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1'), 'b.txt': 'b\n' },
      'Add b'
    );
    // main shifts every line down, then makes the same fix (cherry-picked: another sha, other line numbers).
    await commitFiles(repo, 'main', { 'a.txt': `header\n${base}` }, 'Header');
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': `header\n${edit(base, 2, 'f1')}` },
      'Fix line 2 (picked)'
    );
    const r = done(
      repo,
      await rebase(git, { head: f2, onto: tip, committer: AT })
    );
    expect(r.skipped).toBe(1);
    expect(r.commits.map((c) => c.original)).toEqual([f2]);
    expect(repo.parseCommit(r.head)!.parents).toEqual([tip]);
    expect(await text(git, r.head, 'a.txt')).toBe(
      `header\n${edit(base, 2, 'f1')}`
    );
    expect(await text(git, r.head, 'b.txt')).toBe('b\n');
  });

  it('gives the same change the same identity whatever its context, and a different change another', async () => {
    const { repo, git } = await fixture();
    let n = 0;
    const tree = async (content: string) =>
      repo.parseCommit(
        await commitFiles(repo, `t${n++}`, { 'a.txt': content }, 'x', [])
      )!.treeHash;
    const [a1, a2] = [
      await tree('one\ntwo\nthree\n'),
      await tree('one\nTWO\nthree\n'),
    ];
    const [b1, b2] = [
      await tree('zero\n  one\ntwo\nthree  \nfour\n'),
      await tree('zero\n  one\nTWO\nthree  \nfour\n'),
    ];
    const c2 = await tree('one\nTwo\nthree\n');
    expect(await patchId(git, a1, a2)).toBe(await patchId(git, b1, b2));
    expect(await patchId(git, a1, c2)).not.toBe(await patchId(git, a1, a2));
  });

  it('skips commits already in the target’s history', async () => {
    const { repo, git } = await fixture();
    const root = await commitFiles(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    const f1 = await commitFiles(repo, 'feature', { 'a.txt': 'a1\n' }, 'One', [
      root,
    ]);
    const f2 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': 'a1\n', 'b.txt': 'b\n' },
      'Two'
    );
    repo.refs.set('refs/heads/main', f1); // f1 landed by fast-forward
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': 'a1\n', 'c.txt': 'c\n' },
      'Main moves'
    );
    const r = done(
      repo,
      await rebase(git, { head: f2, onto: tip, committer: AT })
    );
    expect(r.commits.map((c) => c.original)).toEqual([f2]);
    expect(repo.parseCommit(r.head)!.parents).toEqual([tip]);
  });

  it('flattens merge commits on the branch', async () => {
    const { repo, git } = await fixture();
    const base = LINES(20);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    const f1 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1') },
      'One',
      [root]
    );
    const m1 = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 10, 'm1') },
      'Main 1'
    );
    await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(edit(base, 2, 'f1'), 10, 'm1') },
      'Merge main',
      [f1, m1]
    );
    const f2 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(edit(edit(base, 2, 'f1'), 10, 'm1'), 18, 'f2') },
      'Two'
    );
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 10, 'm1'), 'o.txt': 'o\n' },
      'Main 2'
    );
    const r = done(
      repo,
      await rebase(git, { head: f2, onto: tip, committer: AT })
    );
    expect(r.commits.map((c) => c.original)).toEqual([f1, f2]);
    expect(repo.parseCommit(r.head)!.parents).toHaveLength(1);
    expect(await text(git, r.head, 'a.txt')).toBe(
      edit(edit(edit(base, 2, 'f1'), 10, 'm1'), 18, 'f2')
    );
    expect(await text(git, r.head, 'o.txt')).toBe('o\n');
  });

  it('drops a commit whose changes the target already made (no empty commit)', async () => {
    const { repo, git } = await fixture();
    const base = LINES(10);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1') },
      'Fix 2',
      [root]
    );
    const f2 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1'), 'b.txt': 'b\n' },
      'Add b'
    );
    // Same fix plus another change in one commit: a different patch identity, but nothing left to apply.
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(edit(base, 2, 'f1'), 8, 'm') },
      'Fix 2 and 8'
    );
    const r = done(
      repo,
      await rebase(git, { head: f2, onto: tip, committer: AT })
    );
    expect(r.commits.map((c) => c.original)).toEqual([f2]);
    expect(r.skipped).toBe(1);
  });

  it('notices when a replayed commit no longer makes the same change', async () => {
    const { repo, git } = await fixture();
    const base = LINES(10);
    const root = await commitFiles(
      repo,
      'main',
      { 'a.txt': base, 'c.txt': 'c\n' },
      'base'
    );
    const f1 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1'), 'c.txt': 'c2\n' },
      'Two files',
      [root]
    );
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(edit(base, 2, 'f1'), 8, 'm'), 'c.txt': 'c\n' },
      'Upstream'
    );
    const r = done(
      repo,
      await rebase(git, { head: f1, onto: tip, committer: AT })
    );
    expect(r.commits.map((c) => c.original)).toEqual([f1]);
    expect(r.samePatches).toBe(false); // the rebased commit only changes c.txt now
  });

  it('stops at the first conflicting commit with its files and what replayed before it', async () => {
    const { repo, git } = await fixture();
    const base = LINES(5);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    const f1 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': base, 'b.txt': 'b\n' },
      'Add b',
      [root]
    );
    const f2 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': base.replace('line 3', 'line 3 feature'), 'b.txt': 'b\n' },
      'Change line 3'
    );
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': base.replace('line 3', 'line 3 main') },
      'Main line 3'
    );
    const r = await rebase(git, {
      head: f2,
      onto: tip,
      committer: AT,
      ontoLabel: 'main',
    });
    if (r.kind !== 'conflict') throw new Error(r.kind);
    expect(r.commit.hash).toBe(f2);
    expect(r.conflicts).toEqual(['a.txt']);
    expect(r.replayed.map((c) => c.original)).toEqual([f1]);
    const markers = r.files[0].withMarkers;
    expect(markers).toContain('<<<<<<< main');
    expect(markers).toContain(`>>>>>>> ${f2.slice(0, 7)}`);
    expect(markers).toContain('line 3 main');
    expect(markers).toContain('line 3 feature');
  });

  it('applies resolved contents for a conflicting commit and marks it with the trailer', async () => {
    const { repo, git } = await fixture();
    const base = LINES(5);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    await commitFiles(
      repo,
      'feature',
      { 'a.txt': base, 'b.txt': 'b\n' },
      'Add b',
      [root]
    );
    const f2 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': base.replace('line 3', 'line 3 feature'), 'b.txt': 'b\n' },
      'Change line 3'
    );
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': base.replace('line 3', 'line 3 main') },
      'Main line 3'
    );
    const resolved = base.replace('line 3', 'line 3 main and feature');
    const r = done(
      repo,
      await rebase(git, {
        head: f2,
        onto: tip,
        committer: AT,
        resolutions: new Map([[f2, new Map([['a.txt', resolved]])]]),
      })
    );
    expect(r.commits.map((c) => c.resolved)).toEqual([false, true]);
    expect(repo.parseCommit(r.head)!.message).toBe(
      `Change line 3\n\n${RESOLVED_TRAILER}`
    );
    expect(await text(git, r.head, 'a.txt')).toBe(resolved);
  });

  it('keeps messages byte for byte, trailers included', async () => {
    const { repo, git } = await fixture();
    const root = await commitFiles(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    const message = 'Fix it\n\nCo-authored-by: Bob <bob@example.com>';
    const head = await commitFiles(
      repo,
      'feature',
      { 'a.txt': 'a\n', 'b.txt': 'b\n' },
      message,
      [root]
    );
    const tip = await commitFiles(repo, 'main', { 'a.txt': 'a2\n' }, 'Main');
    const r = done(repo, await rebase(git, { head, onto: tip, committer: AT }));
    expect(repo.parseCommit(r.head)!.message).toBe(message);
  });

  it('adds the trailer to an existing trailer block', () => {
    expect(
      withResolvedTrailer('Fix it\n\nCo-authored-by: Bob <bob@example.com>')
    ).toBe(
      `Fix it\n\nCo-authored-by: Bob <bob@example.com>\n${RESOLVED_TRAILER}`
    );
    expect(withResolvedTrailer('Fix it')).toBe(`Fix it\n\n${RESOLVED_TRAILER}`);
    expect(withResolvedTrailer('Fix: the parser\n')).toBe(
      `Fix: the parser\n\n${RESOLVED_TRAILER}`
    );
  });

  it('refuses more than 100 commits', async () => {
    const { repo, git } = await fixture();
    const root = await commitFiles(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    repo.refs.set('refs/heads/feature', root);
    for (let i = 0; i < 101; i++)
      await commitFiles(
        repo,
        'feature',
        { 'a.txt': 'a\n', 'n.txt': `${i}\n` },
        `#${i}`
      );
    const tip = await commitFiles(repo, 'main', { 'a.txt': 'b\n' }, 'Main');
    expect(
      await rebase(git, {
        head: repo.refs.get('refs/heads/feature')!,
        onto: tip,
        committer: AT,
      })
    ).toEqual({
      kind: 'too_many',
      count: 101,
    });
  });

  it('builds the same commits from the same inputs (a replayed Workflow step rebuilds them)', async () => {
    const { fake, repo, git } = await fixture();
    const root = await commitFiles(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    const head = await commitFiles(
      repo,
      'feature',
      { 'a.txt': 'a\n', 'b.txt': 'b\n' },
      'Add b',
      [root]
    );
    const tip = await commitFiles(repo, 'main', { 'a.txt': 'a2\n' }, 'Main');
    const again = new GitService(new ArtifactsRepoClient(fake.binding, 'r'));
    const [x, y] = [
      await rebase(git, { head, onto: tip, committer: AT }),
      await rebase(again, { head, onto: tip, committer: AT }),
    ];
    expect(x.kind === 'done' && y.kind === 'done' && x.head === y.head).toBe(
      true
    );
  });

  it('finishes with no commits when the target already has every change (callers refuse it)', async () => {
    const { repo, git } = await fixture();
    const root = await commitFiles(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    const head = await commitFiles(repo, 'feature', { 'a.txt': 'b\n' }, 'B', [
      root,
    ]);
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': 'b\n' },
      'B (picked)'
    );
    const r = await rebase(git, { head, onto: tip, committer: AT });
    expect(r).toMatchObject({
      kind: 'done',
      head: tip,
      commits: [],
      skipped: 1,
    });
  });

  it('returns each object it made once', async () => {
    const { repo, git } = await fixture();
    const root = await commitFiles(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    // Two commits that make the same file contents again (the same blob and subtree on each replay).
    await commitFiles(
      repo,
      'feature',
      { 'a.txt': 'a\n', 'b.txt': 'x\n' },
      '1',
      [root]
    );
    await commitFiles(repo, 'feature', { 'a.txt': 'a\n' }, '2');
    const head = await commitFiles(
      repo,
      'feature',
      { 'a.txt': 'a\n', 'b.txt': 'x\n' },
      '3'
    );
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': 'a\n', 'c.txt': 'c\n' },
      'Main'
    );
    const r = done(repo, await rebase(git, { head, onto: tip, committer: AT }));
    expect(r.commits).toHaveLength(3);
    const shas = r.objects.map((o) => o.sha);
    expect(new Set(shas).size).toBe(shas.length);
    expect(await text(git, r.head, 'b.txt')).toBe('x\n');
  });

  it('replays a side branch merged back into the branch after its parents', async () => {
    const { repo, git } = await fixture();
    const base = LINES(20);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    const x1 = edit(base, 3, 'x');
    const x = await commitFiles(repo, 'feature', { 'a.txt': x1 }, 'X', [root]);
    // a1 edits X's own line again: replayed before X, it would conflict.
    const a1t = x1.replace('line 3 x\n', 'line 3 x a1\n');
    const a1 = await commitFiles(repo, 'feature', { 'a.txt': a1t }, 'a1');
    const a2t = edit(a1t, 7, 'a2');
    const a2 = await commitFiles(repo, 'feature', { 'a.txt': a2t }, 'a2');
    const a3t = edit(a2t, 11, 'a3');
    const a3 = await commitFiles(repo, 'feature', { 'a.txt': a3t }, 'a3');
    const b1 = await commitFiles(
      repo,
      'side',
      { 'a.txt': edit(x1, 15, 'b1') },
      'b1',
      [x]
    );
    const final = edit(a3t, 15, 'b1');
    const m2 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': final },
      'Merge side',
      [a3, b1]
    );
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 19, 'main') },
      'Main'
    );
    const r = done(
      repo,
      await rebase(git, { head: m2, onto: tip, committer: AT })
    );
    const order = r.commits.map((c) => c.original);
    expect([...order].sort()).toEqual([x, a1, a2, a3, b1].sort());
    for (const [i, sha] of order.entries())
      for (const p of repo.parseCommit(sha)!.parents)
        if (order.includes(p)) expect(order.indexOf(p)).toBeLessThan(i);
    expect(await text(git, r.head, 'a.txt')).toBe(edit(final, 19, 'main'));
  });

  it('carries over edits made inside a merge commit in one extra commit', async () => {
    const { repo, git } = await fixture();
    const base = LINES(20);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    const f1 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1') },
      'One',
      [root]
    );
    const m1 = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 10, 'm1') },
      'Main 1'
    );
    // The merge also fixes line 15 (a build fix made while merging).
    const merge = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(edit(edit(base, 2, 'f1'), 10, 'm1'), 15, 'fix') },
      'Merge main',
      [f1, m1]
    );
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 10, 'm1'), 'o.txt': 'o\n' },
      'Main 2'
    );
    const r = done(
      repo,
      await rebase(git, { head: merge, onto: tip, committer: AT })
    );
    expect(r.commits.map((c) => [c.original, c.resolved])).toEqual([
      [f1, false],
      [merge, false],
    ]);
    const carry = repo.parseCommit(r.head)!;
    expect(carry.message).toBe(CARRY_OVER_MESSAGE);
    expect(carry.author).toEqual({
      name: 'GitOrange',
      email: 'noreply@gitorange',
    });
    expect(carry.parents).toEqual([r.commits[0].rebased]);
    expect(await text(git, r.head, 'a.txt')).toBe(
      edit(edit(edit(base, 2, 'f1'), 10, 'm1'), 15, 'fix')
    );
    expect(await text(git, r.head, 'o.txt')).toBe('o\n');
    // The merge's own edit makes the same change on the new target: the review carries over.
    expect(r.samePatches).toBe(true);
  });

  it('notices when a merge commit’s own edits no longer make the same change', async () => {
    const { repo, git } = await fixture();
    const base = LINES(20);
    const root = await commitFiles(
      repo,
      'main',
      { 'a.txt': base, 'c.txt': 'c\n' },
      'base'
    );
    const f1 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1'), 'c.txt': 'c\n' },
      'One',
      [root]
    );
    const m1 = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 10, 'm1'), 'c.txt': 'c\n' },
      'Main 1'
    );
    // The merge fixes line 15 and c.txt.
    const merge = await commitFiles(
      repo,
      'feature',
      {
        'a.txt': edit(edit(edit(base, 2, 'f1'), 10, 'm1'), 15, 'fix'),
        'c.txt': 'c2\n',
      },
      'Merge main',
      [f1, m1]
    );
    // main makes the line 15 fix itself: the carried-over edits only change c.txt now.
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(edit(base, 10, 'm1'), 15, 'fix'), 'c.txt': 'c\n' },
      'Main 2'
    );
    const r = done(
      repo,
      await rebase(git, { head: merge, onto: tip, committer: AT })
    );
    expect(r.commits.map((c) => [c.original, c.resolved])).toEqual([
      [f1, false],
      [merge, false],
    ]);
    expect(repo.parseCommit(r.head)!.message).toBe(CARRY_OVER_MESSAGE);
    expect(await text(git, r.head, 'c.txt')).toBe('c2\n');
    expect(r.samePatches).toBe(false);
  });

  it('stops at a merge commit whose own edit conflicts with the target', async () => {
    const { repo, git } = await fixture();
    const base = LINES(20);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    const f1 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1') },
      'One',
      [root]
    );
    const m1 = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 10, 'm1') },
      'Main 1'
    );
    const merge = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(edit(edit(base, 2, 'f1'), 10, 'm1'), 15, 'fix') },
      'Merge main',
      [f1, m1]
    );
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(edit(base, 10, 'm1'), 15, 'main') },
      'Main 2'
    );
    const r = await rebase(git, { head: merge, onto: tip, committer: AT });
    if (r.kind !== 'conflict') throw new Error(r.kind);
    expect(r.commit.hash).toBe(merge);
    expect(r.conflicts).toEqual(['a.txt']);
    expect(r.replayed.map((c) => c.original)).toEqual([f1]);
  });

  it('ignores a resolution for a commit that replays cleanly', async () => {
    const { repo, git } = await fixture();
    const root = await commitFiles(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    const head = await commitFiles(
      repo,
      'feature',
      { 'a.txt': 'a\n', 'b.txt': 'b\n' },
      'Add b',
      [root]
    );
    const tip = await commitFiles(repo, 'main', { 'a.txt': 'a2\n' }, 'Main');
    const r = done(
      repo,
      await rebase(git, {
        head,
        onto: tip,
        committer: AT,
        resolutions: new Map([[head, new Map([['b.txt', 'stale\n']])]]),
      })
    );
    expect(r.commits.map((c) => c.resolved)).toEqual([false]);
    expect(repo.parseCommit(r.head)!.message).toBe('Add b');
    expect(await text(git, r.head, 'b.txt')).toBe('b\n');
  });

  it('tells indenting from dedenting, but not trailing whitespace', async () => {
    const { repo, git } = await fixture();
    let n = 0;
    const tree = async (content: string) =>
      repo.parseCommit(
        await commitFiles(repo, `w${n++}`, { 'a.txt': content }, 'x', [])
      )!.treeHash;
    const before = await tree('a\n  x\nb\n');
    const indented = await tree('a\n    x\nb\n');
    const dedented = await tree('a\nx\nb\n');
    expect(await patchId(git, before, indented)).not.toBe(
      await patchId(git, before, dedented)
    );
    const [p, q] = [await tree('one\ntwo\n'), await tree('one\nTWO\n')];
    const [pt, qt] = [await tree('one\ntwo  \n'), await tree('one\nTWO\t\n')];
    expect(await patchId(git, p, q)).toBe(await patchId(git, pt, qt));
  });

  /** A branch with X (line 2), a merge of main's m1 (line 10) with no edits of its own, then f2 (line 18). */
  async function mergedBranch() {
    const { repo, git } = await fixture();
    const base = LINES(20);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    const x = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'x') },
      'X',
      [root]
    );
    const m1 = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 10, 'm1') },
      'Main 1'
    );
    await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(edit(base, 2, 'x'), 10, 'm1') },
      'Merge main',
      [x, m1]
    );
    const f2 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(edit(edit(base, 2, 'x'), 10, 'm1'), 18, 'f2') },
      'F2'
    );
    // main cherry-picks X (another sha).
    await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(edit(base, 2, 'x'), 10, 'm1') },
      'X (picked)'
    );
    return { repo, git, base, f2 };
  }

  it('does not bring back a change the target picked and then reverted', async () => {
    const { repo, git, base, f2 } = await mergedBranch();
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 10, 'm1') },
      'Revert X'
    );
    const r = done(
      repo,
      await rebase(git, { head: f2, onto: tip, committer: AT })
    );
    expect(r.commits.map((c) => c.original)).toEqual([f2]);
    expect(r.skipped).toBe(1);
    expect(repo.parseCommit(r.head)!.message).toBe('F2');
    // Left out, yet the target doesn't have it: the branch's change is not the same.
    expect(r.samePatches).toBe(false);
    expect(await text(git, r.head, 'a.txt')).toBe(
      edit(edit(base, 10, 'm1'), 18, 'f2')
    );
  });

  it('does not conflict on a merge commit when the target picked a change and edited it further', async () => {
    const { repo, git, base, f2 } = await mergedBranch();
    const further = edit(edit(base, 2, 'x more'), 10, 'm1');
    const tip = await commitFiles(repo, 'main', { 'a.txt': further }, 'More');
    const r = done(
      repo,
      await rebase(git, { head: f2, onto: tip, committer: AT })
    );
    expect(r.commits.map((c) => c.original)).toEqual([f2]);
    expect(await text(git, r.head, 'a.txt')).toBe(edit(further, 18, 'f2'));
  });

  /**
   * X edits line 5; main's m1 edits line 5 too and adds L on line 12; the merge of m1 into the branch conflicted and
   * was resolved by hand ("x m"), with `extra` files of its own.
   */
  async function handResolvedMerge(extra: Record<string, string> = {}) {
    const { repo, git } = await fixture();
    const base = LINES(20);
    const b = LINES(10);
    const root = await commitFiles(
      repo,
      'main',
      { 'a.txt': base, 'b.txt': b },
      'base'
    );
    const x = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 5, 'x'), 'b.txt': b },
      'X',
      [root]
    );
    const m1 = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(edit(base, 5, 'm'), 12, 'L'), 'b.txt': b },
      'Main 1'
    );
    const merge = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(edit(base, 5, 'x m'), 12, 'L'), 'b.txt': b, ...extra },
      'Merge main',
      [x, m1]
    );
    return { repo, git, base, b, x, merge };
  }

  it('does not bring back what main reverted after a hand-resolved merge', async () => {
    const { repo, git, base, b, x, merge } = await handResolvedMerge();
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 5, 'm'), 'b.txt': b },
      'Revert L'
    );
    const resolved = edit(base, 5, 'x m');
    const r = done(
      repo,
      await rebase(git, {
        head: merge,
        onto: tip,
        committer: AT,
        resolutions: new Map([[x, new Map([['a.txt', resolved]])]]),
      })
    );
    expect(r.commits.map((c) => [c.original, c.resolved])).toEqual([[x, true]]);
    expect(repo.parseCommit(r.head)!.message).toBe(withResolvedTrailer('X'));
    expect(await text(git, r.head, 'a.txt')).toBe(resolved);
  });

  it('does not conflict when main edits a hunk that came in through a hand-resolved merge', async () => {
    const { repo, git, base, b, x, merge } = await handResolvedMerge();
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(edit(base, 5, 'm'), 12, 'L2'), 'b.txt': b },
      'Change L'
    );
    const resolved = edit(edit(base, 5, 'x m'), 12, 'L2');
    const r = done(
      repo,
      await rebase(git, {
        head: merge,
        onto: tip,
        committer: AT,
        resolutions: new Map([[x, new Map([['a.txt', resolved]])]]),
      })
    );
    expect(r.commits.map((c) => c.original)).toEqual([x]);
    expect(await text(git, r.head, 'a.txt')).toBe(resolved);
  });

  it('carries over a hand-resolved merge’s edit in a path that merged cleanly', async () => {
    const { repo, git, base, b, x, merge } = await handResolvedMerge({
      'b.txt': edit(LINES(10), 3, 'fix'),
    });
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 5, 'm'), 'b.txt': b },
      'Revert L'
    );
    const resolved = edit(base, 5, 'x m');
    const r = done(
      repo,
      await rebase(git, {
        head: merge,
        onto: tip,
        committer: AT,
        resolutions: new Map([[x, new Map([['a.txt', resolved]])]]),
      })
    );
    expect(r.commits.map((c) => c.original)).toEqual([x, merge]);
    expect(repo.parseCommit(r.head)!.message).toBe(CARRY_OVER_MESSAGE);
    expect(await text(git, r.head, 'a.txt')).toBe(resolved);
    expect(await text(git, r.head, 'b.txt')).toBe(edit(b, 3, 'fix'));
  });

  it('carries nothing over from an octopus merge', async () => {
    const { repo, git } = await fixture();
    const base = LINES(20);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    const x = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'x') },
      'X',
      [root]
    );
    const s1 = await commitFiles(
      repo,
      'side',
      { 'a.txt': base, 'c.txt': 'c\n' },
      'S1',
      [root]
    );
    const m1 = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 10, 'm1') },
      'Main 1'
    );
    const octopus = await commitFiles(
      repo,
      'feature',
      {
        'a.txt': edit(edit(edit(base, 2, 'x'), 10, 'm1'), 18, 'own'),
        'c.txt': 'c\n',
      },
      'Octopus',
      [x, m1, s1]
    );
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 10, 'm1'), 'o.txt': 'o\n' },
      'Main 2'
    );
    const r = done(
      repo,
      await rebase(git, { head: octopus, onto: tip, committer: AT })
    );
    expect(r.commits.map((c) => c.original).sort()).toEqual([x, s1].sort());
    expect(repo.parseCommit(r.head)!.message).not.toBe(CARRY_OVER_MESSAGE);
    // Its own edit (line 18) is left behind: the pull request's change is not the same.
    expect(r.samePatches).toBe(false);
    expect(await text(git, r.head, 'a.txt')).toBe(
      edit(edit(base, 2, 'x'), 10, 'm1')
    );
  });
});
