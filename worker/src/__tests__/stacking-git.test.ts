// Stacking: relations git already decides (ancestry and rebased copies), cycles never recorded, and landing never
// carrying another open pull request's commits. Fixtures: helpers/stacking.ts.
import { describe, expect, it } from 'vitest';
import type { Relation } from '../stack/models';
import { buildTree, type EdgeInput } from '../stack/tree';
import { call, type TestEnv } from './helpers/app';
import { commitPaths } from './helpers/seed';
import {
  drain,
  edges,
  repoWithAgent,
  stackModels,
  type StackCalls,
} from './helpers/stacking';

/** Opens a pull request from `branch` (already pushed) into main. */
async function openBranch(
  t: TestEnv,
  admin: string,
  branch: string,
  title: string
) {
  const res = await call(t, '/api/repos/octocat/app/pulls', {
    cookie: admin,
    json: { title, body: `${title}.`, base: 'main', head: branch },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { number: number }).number;
}

/** The pairs (as "lo:hi") either model was asked about. */
function asked(calls: StackCalls) {
  return new Set(
    [...calls.triaged, ...calls.related].map((i) => {
      const [x, y] = [i.a.number, i.b.number].sort((p, q) => p - q);
      return `${x}:${y}`;
    })
  );
}

/** The open PRs' tree from the pair rows, as the stack view builds it. */
async function tree(t: TestEnv, open: number[]) {
  const rows = (await edges(t)) as unknown as {
    a: number;
    b: number;
    stage: EdgeInput['stage'];
    kind: EdgeInput['kind'];
    prerequisite: 'a' | 'b' | null;
    reason: string | null;
  }[];
  return buildTree(
    open,
    rows.map((r) => ({ ...r, instructions: null, files: [] }))
  );
}

const pick = (
  rows: Record<string, unknown>[],
  a: number,
  b: number
): Record<string, unknown> | undefined =>
  rows.find((r) => r.a === a && r.b === b);

/** Clef and the reasoning model say the child is the prerequisite: the inversion seen in production. */
const INVERTED: Relation = {
  kind: 'builds_on',
  prerequisite: 'b',
  reason: '#1 extends what #2 adds.',
  instructions: null,
};

describe('relations git decides', () => {
  it('stacks a child on the parent its branch contains, without asking a model', async () => {
    const { t, admin, repo, files, open } = await repoWithAgent();
    const { models, calls } = stackModels({
      related: () => true,
      relation: () => INVERTED,
    });
    expect(await open('one', { 'a.txt': 'a\n' }, 'One')).toBe(1);
    repo.refs.set('refs/heads/two', repo.refs.get('refs/heads/one')!);
    await commitPaths(
      repo,
      'two',
      { ...files, 'a.txt': 'a\n', 'b.txt': 'b\n' },
      'Two'
    );
    expect(await openBranch(t, admin, 'two', 'Two')).toBe(2);
    await drain(t, models);
    expect(asked(calls).has('1:2')).toBe(false);
    expect(pick(await edges(t), 1, 2)).toMatchObject({
      stage: 'done',
      kind: 'builds_on',
      prerequisite: 'a',
    });
    expect(String(pick(await edges(t), 1, 2)!.reason)).toMatch(/#2.*#1/);
  });

  it('sees a rebased copy of the parent’s commits as the same commits', async () => {
    const { t, admin, repo, files, open } = await repoWithAgent();
    const { models, calls } = stackModels({
      related: () => true,
      relation: () => INVERTED,
    });
    const main = repo.refs.get('refs/heads/main')!;
    // #1's commit, and a copy of it on #2's branch: same author, time and message, another committer time.
    const authored = 1_600_000_000;
    repo.refs.set('refs/heads/one', main);
    await commitPaths(repo, 'one', { ...files, 'a.txt': 'a\n' }, 'Add a', {
      timestamp: authored,
    });
    repo.refs.set('refs/heads/two', main);
    await commitPaths(repo, 'two', { ...files, 'a.txt': 'a\n' }, 'Add a', {
      timestamp: authored,
    });
    expect(repo.refs.get('refs/heads/two')).not.toBe(
      repo.refs.get('refs/heads/one')
    );
    await commitPaths(
      repo,
      'two',
      { ...files, 'a.txt': 'a\n', 'b.txt': 'b\n' },
      'Add b'
    );
    void open;
    expect(await openBranch(t, admin, 'one', 'One')).toBe(1);
    expect(await openBranch(t, admin, 'two', 'Two')).toBe(2);
    await drain(t, models);
    expect(asked(calls).has('1:2')).toBe(false);
    expect(pick(await edges(t), 1, 2)).toMatchObject({
      kind: 'builds_on',
      prerequisite: 'a',
    });
  });

  it('never takes a commit with the same author, time and message but another change for a copy', async () => {
    const { t, admin, repo, files } = await repoWithAgent();
    const { models, calls } = stackModels({ related: () => true });
    const main = repo.refs.get('refs/heads/main')!;
    const authored = 1_600_000_000;
    repo.refs.set('refs/heads/one', main);
    await commitPaths(repo, 'one', { ...files, 'a.txt': 'a\n' }, 'Format', {
      timestamp: authored,
    });
    repo.refs.set('refs/heads/two', main);
    await commitPaths(repo, 'two', { ...files, 'x.txt': 'x\n' }, 'Format', {
      timestamp: authored,
    });
    await commitPaths(
      repo,
      'two',
      { ...files, 'x.txt': 'x\n', 'b.txt': 'b\n' },
      'Add b'
    );
    await openBranch(t, admin, 'one', 'One');
    await openBranch(t, admin, 'two', 'Two');
    await drain(t, models);
    expect(asked(calls).has('1:2')).toBe(true);
  });

  it('judges siblings on their own commits, never on the parent they share', async () => {
    const { t, admin, repo, files, open } = await repoWithAgent();
    const { models, calls } = stackModels({ related: () => true });
    await open('one', { 'a.txt': 'a\n' }, 'One');
    const one = repo.refs.get('refs/heads/one')!;
    for (const [branch, file] of [
      ['two', 'b.txt'],
      ['three', 'c.txt'],
    ] as const) {
      repo.refs.set(`refs/heads/${branch}`, one);
      await commitPaths(
        repo,
        branch,
        { ...files, 'a.txt': 'a\n', [file]: `${file}\n` },
        branch
      );
      await openBranch(t, admin, branch, branch);
    }
    await drain(t, models);
    // Parent and children: git.
    expect(asked(calls).has('1:2')).toBe(false);
    expect(asked(calls).has('1:3')).toBe(false);
    // The siblings: the models see only what each adds on top of #1.
    const triage = calls.triaged.find(
      (i) => i.a.number === 2 && i.b.number === 3
    )!;
    expect(triage.a.summaries).not.toContain('a.txt');
    expect(triage.b.summaries).not.toContain('a.txt');
    expect(triage.sharedFiles).toEqual([]);
    const deep = calls.related.find(
      (i) => i.a.number === 2 && i.b.number === 3
    )!;
    expect(deep.a.diffs).not.toContain('a.txt');
    expect(deep.b.diffs).not.toContain('a.txt');
    expect(deep.a.diffs).toContain('b.txt');
  });
});

describe('cycles', () => {
  /** #1, #2, #3 on their own files; the models relate them in a circle. */
  async function circle(rel: (a: number, b: number) => Relation) {
    const { t, open } = await repoWithAgent();
    const { models } = stackModels({
      related: () => true,
      relation: (i) => rel(i.a.number, i.b.number),
    });
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await open('three', { 'c.txt': 'c\n' }, 'Three');
    await drain(t, models);
    return t;
  }
  const builds = (prerequisite: 'a' | 'b'): Relation => ({
    kind: 'builds_on',
    prerequisite,
    reason: 'Builds on it.',
    instructions: null,
  });

  it('never records a model’s edge that would close a cycle', async () => {
    // 2 on 1, 3 on 2, and 1 on 3.
    const t = await circle((a, b) =>
      a === 1 && b === 3 ? builds('b') : builds('a')
    );
    const nodes = await tree(t, [1, 2, 3]);
    for (const n of nodes.values()) expect(n.cycleWith).toEqual([]);
    const rows = await edges(t);
    const left = rows.filter((r) => r.kind === 'independent');
    expect(left).toHaveLength(1);
    expect(String(left[0].reason)).toMatch(/cycle/);
  });

  it('turns a conflict around rather than close a cycle', async () => {
    // 2 on 1, 3 on 2; #1 and #3 conflict with #3 first, which would close the circle: #1 goes first instead.
    const t = await circle((a, b) =>
      a === 1 && b === 3
        ? {
            kind: 'conflicts',
            prerequisite: 'b',
            reason: 'Both edit it.',
            instructions: null,
          }
        : builds('a')
    );
    const nodes = await tree(t, [1, 2, 3]);
    for (const n of nodes.values()) expect(n.cycleWith).toEqual([]);
    expect(pick(await edges(t), 1, 3)).toMatchObject({
      kind: 'conflicts',
      prerequisite: 'a',
    });
    expect(pick(await edges(t), 1, 2)).toMatchObject({ kind: 'builds_on' });
    expect(pick(await edges(t), 2, 3)).toMatchObject({ kind: 'builds_on' });
  });
});

describe('landing never carries another open pull request’s commits', () => {
  /** #1 on main, #2 on #1's branch; no stack run has looked at them yet. */
  async function stacked(copy: boolean) {
    const { t, admin, repo, files } = await repoWithAgent(false);
    const main = repo.refs.get('refs/heads/main')!;
    repo.refs.set('refs/heads/one', main);
    await commitPaths(repo, 'one', { ...files, 'a.txt': 'a\n' }, 'Add a', {
      timestamp: 1_600_000_000,
    });
    if (copy) {
      repo.refs.set('refs/heads/two', main);
      await commitPaths(repo, 'two', { ...files, 'a.txt': 'a\n' }, 'Add a', {
        timestamp: 1_600_000_000,
      });
    } else repo.refs.set('refs/heads/two', repo.refs.get('refs/heads/one')!);
    await commitPaths(
      repo,
      'two',
      { ...files, 'a.txt': 'a\n', 'b.txt': 'b\n' },
      'Add b'
    );
    await openBranch(t, admin, 'one', 'One');
    await openBranch(t, admin, 'two', 'Two');
    const merge = (n: number) =>
      call(t, `/api/repos/octocat/app/pulls/${n}/merge`, {
        cookie: admin,
        json: { approve: true },
      });
    return { t, repo, main, merge };
  }

  for (const copy of [false, true])
    it(`refuses the child while the parent is open (${copy ? 'a rebased copy' : 'the same commits'})`, async () => {
      const { repo, main, merge } = await stacked(copy);
      const res = await merge(2);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /carries.*#1/
      );
      expect(repo.refs.get('refs/heads/main')).toBe(main);
      // The parent lands; then the child may.
      expect((await merge(1)).status).toBe(200);
    });
});
