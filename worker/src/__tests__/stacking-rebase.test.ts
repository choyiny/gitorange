// The stacked-child reproductions (rebase-merging spec, "Problem"): a child stacked on a parent that lands.
import { describe, expect, it } from 'vitest';
import type { Relation } from '../stack/models';
import type { TestEnv } from './helpers/app';
import { call, settle } from './helpers/app';
import { commitPaths } from './helpers/seed';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import {
  drain,
  events,
  pushTo,
  repoWithAgent,
  stackModels,
} from './helpers/stacking';
import { detail, fakeResolver, rows, runSweeps, step } from './helpers/rebase';
import type { ConflictResolverApi } from '../merge/resolver';
import { executeRebase, type RebaseParams } from '../merge/rebase';

const BUILDS_A: Relation = {
  kind: 'builds_on',
  prerequisite: 'a',
  reason: 'Builds on it.',
  instructions: null,
};
const PARENT_A = 'line 1\nfunction f() {\n  return 1;\n}\n';

/** Pull request ids whose queued rebase runs are held back (left queued, not run) until released. */
const held = new WeakMap<TestEnv, Set<string>>();
const ran = new WeakMap<TestEnv, Set<string>>();

/** Runs every sweep and every queued rebase run not held back (once each); returns how many rebases ran. */
async function runRebases(
  t: TestEnv,
  resolver?: (id: string) => ConflictResolverApi
) {
  const db = drizzle(t.env.DB, { schema });
  const done = ran.get(t) ?? new Set<string>();
  ran.set(t, done);
  const hold = held.get(t) ?? new Set<string>();
  let n = 0;
  for (;;) {
    await runSweeps(t);
    const next = t.actions.resolutions.find((r) => {
      const p = (r.params as { rebase?: RebaseParams }).rebase;
      return p && !done.has(r.id) && !hold.has(p.pullRequestId);
    });
    if (!next) return n;
    done.add(next.id);
    n++;
    await executeRebase(
      { env: t.env, db, step, resolver, instanceId: next.id },
      (next.params as { rebase: RebaseParams }).rebase
    );
  }
}

/** Queued rebase runs of `pullRequestId` not run yet. */
function queuedRebases(t: TestEnv, pullRequestId: string) {
  const done = ran.get(t) ?? new Set<string>();
  return t.actions.resolutions.filter(
    (r) =>
      !done.has(r.id) &&
      (r.params as { rebase?: RebaseParams }).rebase?.pullRequestId ===
        pullRequestId
  ).length;
}

/** Runs stacking, sweeps and rebase runs until nothing is left. */
async function quiet(
  t: TestEnv,
  models: ReturnType<typeof stackModels>['models'],
  resolver?: (id: string) => ConflictResolverApi
) {
  for (;;) {
    await drain(t, models);
    if (!(await runRebases(t, resolver))) return;
  }
}

/** Approves pull request #n (auto-merge then lands it) and runs everything that follows. */
async function approve(
  t: TestEnv,
  admin: string,
  models: ReturnType<typeof stackModels>['models'],
  n: number
) {
  const res = await call(t, `/api/repos/octocat/app/pulls/${n}/approval`, {
    cookie: admin,
    method: 'POST',
  });
  expect(res.status).toBeLessThan(300);
  await quiet(t, models);
}

/**
 * #1 `one` adds a.txt; #2 `two` starts at one's head and adds `childChange`, opened against main and stacked on one by
 * discovery. Then `parentLater` (if any) is pushed to one; with `mainFirst`, an unrelated #3 (`three`, adds z.txt)
 * lands on main first, so #1 is rebased by GitOrange before it lands. Then #1 lands. With `holdChild`, #2's rebase runs
 * stay queued until #1 has landed, so #2 still holds #1's original commits when it is rebased onto main.
 */
async function scenario(
  childChange: Record<string, string>,
  parentLater?: Record<string, string>,
  opts: { mainFirst?: boolean; holdChild?: boolean } = {}
) {
  const { t, admin, repo, open, files } = await repoWithAgent(true);
  // Only #1 and #2 are related: #3 stays independent.
  const { models } = stackModels({
    related: (i) => [i.a.number, i.b.number].sort().join() === '1,2',
    relation: () => BUILDS_A,
  });
  await open('one', { 'a.txt': PARENT_A }, 'One');
  repo.refs.set('refs/heads/two', repo.refs.get('refs/heads/one')!);
  await commitPaths(
    repo,
    'two',
    { ...files, 'a.txt': PARENT_A, ...childChange },
    'Two'
  );
  const res = await call(t, '/api/repos/octocat/app/pulls', {
    cookie: admin,
    json: { title: 'Two', body: 'Two.', base: 'main', head: 'two' },
  });
  expect(res.status).toBe(201);
  await quiet(t, models);
  expect(
    await t.env.DB.prepare(
      'SELECT base_ref AS base FROM pull_requests WHERE number = 2'
    ).first()
  ).toEqual({ base: 'one' });
  if (parentLater) {
    await pushTo(t, repo, 'one', {
      ...files,
      'a.txt': PARENT_A,
      ...parentLater,
    });
    await quiet(t, models);
  }
  // The parent's head as its author pushed it, and the child's.
  const parentHead = repo.refs.get('refs/heads/one')!;
  const childHead = repo.refs.get('refs/heads/two')!;
  const childId = (await t.env.DB.prepare(
    'SELECT id FROM pull_requests WHERE number = 2'
  ).first<{ id: string }>())!.id;
  if (opts.holdChild) held.set(t, new Set([childId]));
  if (opts.mainFirst) {
    expect(await open('three', { 'z.txt': 'z\n' }, 'Three')).toBe(3);
    await quiet(t, models);
    await approve(t, admin, models, 3);
    expect(
      await t.env.DB.prepare(
        'SELECT state, merge_commit_sha AS sha FROM pull_requests WHERE number = 3'
      ).first()
    ).toEqual({ state: 'merged', sha: repo.refs.get('refs/heads/main') });
    expect(fileAt(repo, repo.refs.get('refs/heads/main')!, 'z.txt')).toBe(
      'z\n'
    );
  }
  await approve(t, admin, models, 1);
  const landed = (await t.env.DB.prepare(
    'SELECT merge_commit_sha AS sha FROM pull_requests WHERE number = 1'
  ).first<{ sha: string }>())!.sha;
  if (opts.holdChild) {
    // #1 landed (rebased first) while #2 was never restacked: it is still the child as pushed, on #1's original head.
    expect(repo.refs.get('refs/heads/two')).toBe(childHead);
    expect(repo.parseCommit(childHead)!.parents).toEqual([parentHead]);
    expect(queuedRebases(t, childId)).toBeGreaterThan(0);
    held.delete(t);
    await quiet(t, models);
  }
  return { t, admin, repo, models, files, parentHead, childHead, landed };
}

async function landedCleanly(s: Awaited<ReturnType<typeof scenario>>) {
  const { t, admin, repo, parentHead } = s;
  await settle(t);
  expect(
    (
      await t.env.DB.prepare(
        'SELECT number, state, base_ref AS base FROM pull_requests ORDER BY number'
      ).all()
    ).results
  ).toEqual([
    { number: 1, state: 'merged', base: 'main' },
    { number: 2, state: 'open', base: 'main' },
    ...(s.landed === parentHead
      ? []
      : [{ number: 3, state: 'merged', base: 'main' }]),
  ]);
  // #1 landed by fast-forward: main is its landed head.
  expect(repo.refs.get('refs/heads/main')).toBe(s.landed);
  const d = await detail(t, admin, 2);
  expect(d.rebase!.status).toBe('up_to_date');
  expect(d.mergeable).toBe(true);
  expect(d.pullState!.reasons.map((r) => r.kind)).not.toContain(
    'rebase_conflict'
  );
  expect(await rows(t)).toEqual([]);
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

/** A top-level file's text at `commit`. */
function fileAt(repo: Scenario['repo'], commit: string, name: string) {
  const tree = repo.parseTree(repo.parseCommit(commit)!.treeHash)!;
  const entry = tree.find((e) => e.name === name);
  return entry
    ? new TextDecoder().decode(repo.objects.get(entry.hash)!.data)
    : null;
}

/** Messages of the first-parent run from `head` down, newest first. */
function messages(repo: Scenario['repo'], head: string) {
  const out: string[] = [];
  for (let c = repo.parseCommit(head); c; c = repo.parseCommit(c.parents[0]))
    out.push(c.message);
  return out;
}

/** #2 is approved and lands: main fast-forwards to its head, which keeps its commit. */
async function childLands(s: Scenario) {
  const { t, admin, repo, models } = s;
  const head = repo.refs.get('refs/heads/two')!;
  const res = await call(t, '/api/repos/octocat/app/pulls/2/approval', {
    cookie: admin,
    method: 'POST',
  });
  expect(res.status).toBeLessThan(300);
  await quiet(t, models);
  expect(
    await t.env.DB.prepare(
      `SELECT state, merge_commit_sha AS sha, landed_commits AS n FROM pull_requests WHERE number = 2`
    ).first()
  ).toEqual({ state: 'merged', sha: head, n: 1 });
  expect(repo.refs.get('refs/heads/main')).toBe(head);
  return head;
}

describe('a stacked child after its parent lands', () => {
  it('A: the child only adds a file', async () => {
    const s = await scenario({ 'b.txt': 'b\n' });
    const two = s.repo.refs.get('refs/heads/two')!;
    await landedCleanly(s);
    // Already on the parent's head: nothing to rebase, so the child's own commit lands as it was pushed.
    expect(await childLands(s)).toBe(two);
    expect(messages(s.repo, two)).toEqual(['Two', 'One', 'base']);
  });

  it('B: the parent fixed its lines after the child stacked; the child only adds a file', async () => {
    const s = await scenario(
      { 'b.txt': 'b\n' },
      { 'a.txt': 'line 1\nfunction f() {\n  return 10;\n}\n' }
    );
    await landedCleanly(s);
    const head = s.repo.refs.get('refs/heads/two')!;
    // The child carries the parent's fix (rebased onto it), and its own commit once.
    expect(s.repo.parseCommit(head)!.message).toBe('Two');
    expect(s.repo.parseCommit(head)!.parents).toEqual([s.parentHead]);
    // It lands by fast-forward: main has the parent's fixed lines and the child's file, every commit kept.
    expect(await childLands(s)).toBe(head);
    const main = s.repo.refs.get('refs/heads/main')!;
    expect(fileAt(s.repo, main, 'a.txt')).toBe(
      'line 1\nfunction f() {\n  return 10;\n}\n'
    );
    expect(fileAt(s.repo, main, 'b.txt')).toBe('b\n');
    expect(messages(s.repo, main)).toEqual([
      'Two',
      'Update one',
      'One',
      'base',
    ]);
  });

  it('C: the child edits the lines its parent added', async () => {
    const s = await scenario({
      'a.txt': 'line 1\nfunction f() {\n  return 2;\n}\n',
    });
    const two = s.repo.refs.get('refs/heads/two')!;
    await landedCleanly(s);
    // It lands as pushed, by fast-forward: main gets the child's edit on top of the parent's lines.
    expect(await childLands(s)).toBe(two);
    expect(fileAt(s.repo, two, 'a.txt')).toBe(
      'line 1\nfunction f() {\n  return 2;\n}\n'
    );
    expect(messages(s.repo, two)).toEqual(['Two', 'One', 'base']);
  });

  /**
   * #3 landed on main first, so GitOrange rebased #1 (new SHAs) before it landed; the child, built on #1's old
   * commits, is rebased onto main with exactly its own commit on top.
   */
  async function rebasedOntoMain(s: Scenario, parentCommits: string[]) {
    await landedCleanly(s);
    const { repo, landed, parentHead, childHead } = s;
    expect(landed).not.toBe(parentHead);
    // #1's landed commits are new commits with its own messages, on top of #3's.
    const before = new Set<string>();
    for (
      let c = repo.parseCommit(parentHead);
      c;
      c = repo.parseCommit(c.parents[0])
    )
      before.add(c.hash);
    let c = repo.parseCommit(landed)!;
    for (const msg of parentCommits) {
      expect(c.message).toBe(msg);
      expect(before.has(c.hash)).toBe(false);
      c = repo.parseCommit(c.parents[0])!;
    }
    expect(c.message).toBe('Three');
    const head = repo.refs.get('refs/heads/two')!;
    expect(head).not.toBe(childHead);
    expect(repo.parseCommit(head)!.message).toBe('Two');
    expect(repo.parseCommit(head)!.parents).toEqual([landed]);
    expect(await childLands(s)).toBe(head);
    const main = repo.refs.get('refs/heads/main')!;
    expect(messages(repo, main)).toEqual([
      'Two',
      ...parentCommits,
      'Three',
      'base',
    ]);
    expect(fileAt(repo, main, 'z.txt')).toBe('z\n');
    return main;
  }

  it('A′: the child only adds a file, and main moved before its parent landed', async () => {
    const s = await scenario({ 'b.txt': 'b\n' }, undefined, {
      mainFirst: true,
    });
    const main = await rebasedOntoMain(s, ['One']);
    expect(fileAt(s.repo, main, 'b.txt')).toBe('b\n');
    expect(fileAt(s.repo, main, 'a.txt')).toBe(PARENT_A);
  });

  it('B′: the parent fixed its lines after the child stacked, and main moved before it landed', async () => {
    const s = await scenario(
      { 'b.txt': 'b\n' },
      { 'a.txt': 'line 1\nfunction f() {\n  return 10;\n}\n' },
      { mainFirst: true }
    );
    const main = await rebasedOntoMain(s, ['Update one', 'One']);
    expect(fileAt(s.repo, main, 'a.txt')).toBe(
      'line 1\nfunction f() {\n  return 10;\n}\n'
    );
    expect(fileAt(s.repo, main, 'b.txt')).toBe('b\n');
  });

  it('C′: the child edits its parent’s lines, and main moved before the parent landed', async () => {
    const s = await scenario(
      { 'a.txt': 'line 1\nfunction f() {\n  return 2;\n}\n' },
      undefined,
      { mainFirst: true }
    );
    const main = await rebasedOntoMain(s, ['One']);
    expect(fileAt(s.repo, main, 'a.txt')).toBe(
      'line 1\nfunction f() {\n  return 2;\n}\n'
    );
  });

  /**
   * Forced: #2 stayed on #1's original commits until #1 had landed (rebased), so its one rebase, onto main, skips #1's
   * original commits by patch identity and keeps only its own.
   */
  async function forcedOntoMain(s: Scenario, parentCommits: string[]) {
    const { t, repo, childHead, landed } = s;
    const rebased = (await events(t, 2)).filter((e) => e.kind === 'rebased');
    expect(rebased.at(-1)!.data).toMatchObject({
      from: childHead,
      to: repo.refs.get('refs/heads/two'),
      onto: 'main',
      skipped: parentCommits.length,
      resolved: 0,
    });
    expect(repo.parseCommit(repo.refs.get('refs/heads/two')!)!.parents).toEqual(
      [landed]
    );
    return rebasedOntoMain(s, parentCommits);
  }

  it('A″: the child only adds a file, still on its parent’s original commits when the rebased parent landed', async () => {
    const s = await scenario({ 'b.txt': 'b\n' }, undefined, {
      mainFirst: true,
      holdChild: true,
    });
    const main = await forcedOntoMain(s, ['One']);
    expect(fileAt(s.repo, main, 'b.txt')).toBe('b\n');
    expect(fileAt(s.repo, main, 'a.txt')).toBe(PARENT_A);
  });

  it('B″: the parent’s fix, then main moved; the child held its parent’s original commits until it landed', async () => {
    const s = await scenario(
      { 'b.txt': 'b\n' },
      { 'a.txt': 'line 1\nfunction f() {\n  return 10;\n}\n' },
      { mainFirst: true, holdChild: true }
    );
    const main = await forcedOntoMain(s, ['Update one', 'One']);
    expect(fileAt(s.repo, main, 'a.txt')).toBe(
      'line 1\nfunction f() {\n  return 10;\n}\n'
    );
    expect(fileAt(s.repo, main, 'b.txt')).toBe('b\n');
  });

  it('C″: the child edits its parent’s lines, still on its parent’s original commits when the rebased parent landed', async () => {
    const s = await scenario(
      { 'a.txt': 'line 1\nfunction f() {\n  return 2;\n}\n' },
      undefined,
      { mainFirst: true, holdChild: true }
    );
    const main = await forcedOntoMain(s, ['One']);
    expect(fileAt(s.repo, main, 'a.txt')).toBe(
      'line 1\nfunction f() {\n  return 2;\n}\n'
    );
  });

  it('a real conflict with main still surfaces, naming the child’s commit', async () => {
    const s = await scenario({
      'a.txt': 'line 1\nfunction f() {\n  return 2;\n}\n',
    });
    const { t, admin, repo, files, models } = s;
    const two = repo.refs.get('refs/heads/two')!;
    // Someone else changes the same line on main after the parent landed.
    await pushTo(t, repo, 'main', {
      ...files,
      'a.txt': 'line 1\nfunction f() {\n  return 3;\n}\n',
    });
    // The AI gets the child's one conflicting commit, and can't resolve it.
    const { resolver, requests } = fakeResolver(() => ({
      status: 'unanswered',
      reason: 'gave up',
    }));
    await quiet(t, models, resolver);
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0].request.files)).toEqual(['a.txt']);
    expect(requests[0].request.files['a.txt']).toContain('<<<<<<<');
    expect((await rows(t)).map((r) => [r.commit, r.status])).toEqual([
      [two, 'failed'],
    ]);
    // The branch is left for the agent, and the conflict shows.
    expect(repo.refs.get('refs/heads/two')).toBe(two);
    const d = await detail(t, admin, 2);
    expect(d.rebase).toMatchObject({
      status: 'conflict',
      commit: two,
      files: ['a.txt'],
    });
    expect(d.pullState!.reasons).toContainEqual(
      expect.objectContaining({
        kind: 'rebase_conflict',
        commit: two,
        files: ['a.txt'],
      })
    );
  });

  it('pairs a pull request with a landed one by everything it landed', async () => {
    const { t, admin, repo, open, files } = await repoWithAgent(false);
    const { models, calls } = stackModels();
    await open('one', { 'x.txt': 'x\n' }, 'One');
    await commitPaths(
      repo,
      'one',
      { ...files, 'x.txt': 'x\n', 'y.txt': 'y\n' },
      'One more'
    );
    await quiet(t, models);
    const res = await call(t, '/api/repos/octocat/app/pulls/1/merge', {
      cookie: admin,
      json: { approve: true },
    });
    expect(res.status).toBe(200);
    await quiet(t, models);
    calls.triaged.length = 0;
    await open('two', { 'x.txt': 'x2\n' }, 'Two');
    await quiet(t, models);
    const pair = calls.triaged.find((i) => i.a.landed || i.b.landed)!;
    const landed = pair.a.landed ? pair.a : pair.b;
    expect(landed.summaries).toContain('x.txt');
    expect(landed.summaries).toContain('y.txt');
  });
});
