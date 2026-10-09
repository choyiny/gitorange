import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { pullRequests } from '../db/app.schema';
import { findRepoById, gitFor } from '../lib/repos';
import { landPull } from '../merge/land';
import { addMember, call, settle } from './helpers/app';
import {
  collaborator,
  connect,
  crewRepo,
  FILES,
  type CrewRepo,
} from './helpers/crew';
import { commitPaths } from './helpers/seed';

const DAY = 86_400_000;

type Branch = {
  name: string;
  sha: string;
  isDefault: boolean;
  isProtected: boolean;
  updatedAt: number | null;
  author: {
    login: string;
    name: string | null;
    isAgent: boolean;
    color: string | null;
  } | null;
  pull: {
    number: number;
    title: string;
    state: 'open' | 'closed' | 'merged';
    pullState: { state: string; reasons: { kind: string }[] } | null;
    createdVia: string | null;
    session: string | null;
    sessionId: string;
  } | null;
  mergedNotDeleted: boolean;
};

const BASE = '/api/repos/octocat/app';

async function branches(s: CrewRepo, cookie = s.admin) {
  const res = await call(s.t, `${BASE}/branches`, { cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as Branch[];
}
const byName = (list: Branch[]) =>
  Object.fromEntries(list.map((b) => [b.name, b]));

/** Keeps merged branches (the setting is on by default), so there is something to clean up. */
async function keepMerged(s: CrewRepo) {
  await s.setRepo('delete_merged_branches', 0);
}

describe('GET /api/repos/{o}/{r}/branches', () => {
  it('lists every branch with its tip, flags, last commit time, author and pull request', async () => {
    const s = await crewRepo();
    await keepMerged(s);
    const claude = (await connect(s.t, s.admin, 'Claude Code')).access_token;
    await s.setRepo('protected_branches', JSON.stringify(['release/*']));
    s.repo.refs.set('refs/heads/release/1.0', s.main);
    const shipped = await s.branch('shipped');
    const done = await s.mcp(claude, 'shipped', { title: 'Ship it' });
    await s.merge(done);
    const feature = await s.branch('feature');
    await s.branch('plain');
    const open = await s.mcp(claude, 'feature', {
      title: 'Add feature',
      session: 's4',
    });

    const list = await branches(s);
    expect(list.map((b) => b.name)).toEqual([
      'feature',
      'main',
      'plain',
      'release/1.0',
      'shipped',
    ]);
    const b = byName(list);

    // The default branch is always protected.
    expect(b.main).toMatchObject({
      sha: s.repo.refs.get('refs/heads/main'),
      isDefault: true,
      isProtected: true,
      pull: null,
      mergedNotDeleted: false,
    });
    expect(b['release/1.0']).toMatchObject({
      isDefault: false,
      isProtected: true,
      mergedNotDeleted: false,
    });
    expect(b.plain).toMatchObject({
      isDefault: false,
      isProtected: false,
      pull: null,
      // Its commits are by "dev@example.com", who isn't a member.
      author: null,
      mergedNotDeleted: false,
    });
    // updatedAt is the tip commit's committer time, in epoch milliseconds.
    expect(b.feature.sha).toBe(feature);
    expect(b.feature.updatedAt).toBe(
      s.repo.parseCommit(feature)!.committedAt * 1000
    );
    expect(b.feature.pull).toEqual({
      number: open,
      title: 'Add feature',
      state: 'open',
      pullState: { state: 'human_review', reasons: expect.any(Array) },
      createdVia: 'Claude Code',
      session: 's4',
      sessionId: expect.stringMatching(/^s-[0-9a-f]{10}$/),
    });
    // Made by whoever opened its pull request.
    expect(b.feature.author).toEqual({
      login: 'octocat',
      name: 'Admin',
      isAgent: false,
      color: null,
    });
    // Landed by fast-forward, and kept: the tip is still the merged commit.
    expect(b.shipped.sha).toBe(shipped);
    expect(b.shipped.pull).toMatchObject({
      number: done,
      state: 'merged',
      pullState: null,
    });
    expect(b.shipped.mergedNotDeleted).toBe(true);
  });

  it('names a branch’s author from its tip commit when it has no pull request', async () => {
    const s = await crewRepo();
    s.repo.refs.set('refs/heads/mine', s.main);
    await commitPaths(s.repo, 'mine', { ...FILES, 'm.txt': 'm\n' }, 'mine');
    // A commit by a member's account email.
    const { commitFiles } = await import('./helpers/seed');
    s.repo.refs.set('refs/heads/hers', s.main);
    await commitFiles(s.repo, 'hers', { 'a.txt': 'a\n' }, 'hers', [s.main], {
      name: 'Admin',
      email: 'octocat@example.com',
    });
    const b = byName(await branches(s));
    expect(b.mine.author).toBeNull();
    expect(b.hers.author).toMatchObject({ login: 'octocat', isAgent: false });
  });

  it('has a null updatedAt and author for a tip it cannot read', async () => {
    const s = await crewRepo();
    s.repo.refs.set('refs/heads/ghost', 'f'.repeat(40));
    const ghost = byName(await branches(s)).ghost;
    expect(ghost).toMatchObject({
      sha: 'f'.repeat(40),
      updatedAt: null,
      author: null,
      pull: null,
    });
  });

  it('uses the newest pull request when a branch has had several', async () => {
    const s = await crewRepo();
    await s.branch('again');
    const first = await s.web('again', { title: 'First try' });
    await call(s.t, `${BASE}/pulls/${first}`, {
      cookie: s.admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    const second = await s.web('again', { title: 'Second try' });
    const pull = byName(await branches(s)).again.pull!;
    expect(pull).toMatchObject({ number: second, title: 'Second try' });
  });

  it('is hidden from a member who cannot read the repository', async () => {
    const s = await crewRepo();
    await call(s.t, '/api/repos', {
      cookie: s.admin,
      json: { name: 'secret', visibility: 'private' },
    });
    const bob = await addMember(s.t, s.admin, 'bob');
    expect(
      (await call(s.t, '/api/repos/octocat/secret/branches', { cookie: bob }))
        .status
    ).toBe(404);
    expect((await call(s.t, `${BASE}/branches`)).status).toBe(401);
    expect((await call(s.t, `${BASE}/branches`, { cookie: bob })).status).toBe(
      200
    );
  });
});

describe('merged, not deleted', () => {
  it('needs the newest pull request for the branch to be merged, and the branch to be there', async () => {
    const s = await crewRepo();
    const now = Date.now();
    // Merged, branch still there.
    s.repo.refs.set('refs/heads/old-merged', s.main);
    await s.mergedRow(1, 'old-merged', now - DAY);
    // Merged, branch long gone: nothing to list.
    await s.mergedRow(2, 'long-gone', now - DAY);
    // Merged once, then a newer pull request is open from it.
    s.repo.refs.set('refs/heads/reused', s.main);
    await s.mergedRow(3, 'reused', now - 2 * DAY);
    await s.branch('reused');
    const reopened = await s.web('reused');
    expect(reopened).toBeGreaterThan(3);

    const b = byName(await branches(s));
    expect(b['old-merged'].mergedNotDeleted).toBe(true);
    expect(b['old-merged'].pull).toMatchObject({ number: 1, state: 'merged' });
    expect(b['long-gone']).toBeUndefined();
    expect(b.reused.mergedNotDeleted).toBe(false);
    expect(b.reused.pull).toMatchObject({ number: reopened, state: 'open' });
  });

  it('never counts the default branch or a protected one', async () => {
    const s = await crewRepo();
    const now = Date.now();
    await s.setRepo(
      'protected_branches',
      JSON.stringify(['release/*', 'stable'])
    );
    for (const name of ['release/2', 'stable', 'other'])
      s.repo.refs.set(`refs/heads/${name}`, s.main);
    // A merged pull request whose head is main itself (a backport into a release branch).
    await s.mergedRow(1, 'main', now - DAY, { base: 'release/2' });
    await s.mergedRow(2, 'release/2', now - DAY);
    await s.mergedRow(3, 'stable', now - DAY);
    await s.mergedRow(4, 'other', now - DAY);
    const b = byName(await branches(s));
    expect(b.main.mergedNotDeleted).toBe(false);
    expect(b['release/2'].mergedNotDeleted).toBe(false);
    expect(b.stable.mergedNotDeleted).toBe(false);
    expect(b.other.mergedNotDeleted).toBe(true);
  });

  it('does not count a branch someone pushed to after it landed, or one another open pull request uses', async () => {
    const s = await crewRepo();
    await keepMerged(s);
    await s.branch('later');
    await s.merge(await s.web('later'));
    await s.branch('parent');
    await s.merge(await s.web('parent'));
    // Both landed and were kept. New commits arrive on `later`...
    expect(byName(await branches(s)).later.mergedNotDeleted).toBe(true);
    await commitPaths(
      s.repo,
      'later',
      { ...FILES, 'more.txt': 'more\n' },
      'More'
    );
    // ...and another pull request is opened onto `parent`.
    await s.branch('child');
    await s.web('child', { base: 'parent' });
    const b = byName(await branches(s));
    expect(b.later.mergedNotDeleted).toBe(false);
    expect(b.parent.mergedNotDeleted).toBe(false);
  });
});

describe('POST /api/repos/{o}/{r}/branches/clean', () => {
  async function withMerged() {
    const s = await crewRepo();
    await keepMerged(s);
    const claude = (await connect(s.t, s.admin, 'Claude Code')).access_token;
    await s.setRepo('protected_branches', JSON.stringify(['keep/*']));
    s.repo.refs.set('refs/heads/keep/1', s.main);
    for (const name of ['a', 'b']) {
      await s.branch(name);
      await s.merge(await s.mcp(claude, name));
    }
    await s.branch('open');
    await s.mcp(claude, 'open');
    // Merged pull requests whose branches are protected or the default one.
    await s.mergedRow(50, 'keep/1', Date.now() - DAY);
    await s.mergedRow(51, 'main', Date.now() - DAY, { base: 'keep/1' });
    return s;
  }
  const clean = (s: CrewRepo, cookie = s.admin) =>
    call(s.t, `${BASE}/branches/clean`, { cookie, method: 'POST' });
  const auditRows = (s: CrewRepo) =>
    s.t.env.DB.prepare(
      "SELECT actor_id, actor_kind, action, target, data FROM audit_events WHERE action = 'branches.cleaned'"
    ).all<{
      actor_id: string;
      actor_kind: string;
      action: string;
      target: string;
      data: string;
    }>();

  it('deletes exactly the merged, not deleted branches, and says which', async () => {
    const s = await withMerged();
    expect(
      (await branches(s)).filter((b) => b.mergedNotDeleted).map((b) => b.name)
    ).toEqual(['a', 'b']);
    const res = await clean(s);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: ['a', 'b'] });
    const refs = [...s.repo.refs.keys()];
    expect(refs).not.toContain('refs/heads/a');
    expect(refs).not.toContain('refs/heads/b');
    // Never the default branch, a protected branch, or one with an open pull request.
    expect(refs).toEqual(
      expect.arrayContaining([
        'refs/heads/main',
        'refs/heads/keep/1',
        'refs/heads/open',
      ])
    );
    expect((await branches(s)).some((b) => b.mergedNotDeleted)).toBe(false);
  });

  it('records one audit row listing the names, and nothing when there was nothing to delete', async () => {
    const s = await withMerged();
    const tips = {
      a: s.repo.refs.get('refs/heads/a'),
      b: s.repo.refs.get('refs/heads/b'),
    };
    await clean(s);
    const { results } = await auditRows(s);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      actor_kind: 'person',
      action: 'branches.cleaned',
      target: '2 branches',
    });
    // With the tip each had, so a branch deleted by mistake can be put back.
    expect(JSON.parse(results[0].data)).toEqual({
      branches: ['a', 'b'],
      shas: tips,
    });
    const again = await clean(s);
    expect(await again.json()).toEqual({ deleted: [] });
    expect((await auditRows(s)).results).toHaveLength(1);
  });

  it('leaves a branch alone that got commits after a legacy (pre fast-forward) merge, and takes one that did not', async () => {
    const s = await crewRepo();
    const now = Date.now();
    // Merged when merging made a commit (landed_commits null): the merge pinned the head it merged.
    s.repo.refs.set('refs/heads/legacy-same', s.main);
    s.repo.refs.set('refs/heads/legacy-moved', s.main);
    s.repo.refs.set('refs/heads/legacy-unpinned', s.main);
    await s.mergedRow(1, 'legacy-same', now - DAY);
    await s.mergedRow(2, 'legacy-moved', now - DAY);
    await s.mergedRow(3, 'legacy-unpinned', now - DAY, { pin: false });
    // Work pushed to one branch after its merge, and to the unpinned one: nothing says what was merged.
    const moved = await commitPaths(
      s.repo,
      'legacy-moved',
      { ...FILES, 'later.txt': 'unmerged work\n' },
      'After the merge'
    );
    const b = byName(await branches(s));
    expect(b['legacy-same'].mergedNotDeleted).toBe(true);
    expect(b['legacy-moved']).toMatchObject({
      sha: moved,
      mergedNotDeleted: false,
    });
    expect(b['legacy-unpinned'].mergedNotDeleted).toBe(false);

    const res = await clean(s);
    expect(await res.json()).toEqual({ deleted: ['legacy-same'] });
    const refs = [...s.repo.refs.keys()];
    expect(refs).toContain('refs/heads/legacy-moved');
    expect(refs).toContain('refs/heads/legacy-unpinned');
    expect(refs).not.toContain('refs/heads/legacy-same');
    expect(s.repo.refs.get('refs/heads/legacy-moved')).toBe(moved);
    // The map's leftovers agree.
    const map = (await (
      await call(s.t, `${BASE}/branches/map`, { cookie: s.admin })
    ).json()) as { leftover: { branch: string }[] };
    expect(map.leftover.map((l) => l.branch)).toEqual([]);
  });

  it('counts a fast-forward landed row only with the landed commit still at the tip', async () => {
    const s = await crewRepo();
    const now = Date.now();
    s.repo.refs.set('refs/heads/ff-same', s.main);
    s.repo.refs.set('refs/heads/ff-moved', s.main);
    s.repo.refs.set('refs/heads/ff-no-sha', s.main);
    await s.mergedRow(1, 'ff-same', now - DAY, { landed: 1, sha: s.main });
    await s.mergedRow(2, 'ff-moved', now - DAY, {
      landed: 1,
      sha: 'a'.repeat(40),
    });
    // Landed by fast-forward but with no recorded commit: nothing to compare the tip with.
    await s.mergedRow(3, 'ff-no-sha', now - DAY, { landed: 1, sha: null });
    const b = byName(await branches(s));
    expect(b['ff-same'].mergedNotDeleted).toBe(true);
    expect(b['ff-moved'].mergedNotDeleted).toBe(false);
    expect(b['ff-no-sha'].mergedNotDeleted).toBe(false);
  });

  it('needs push rights', async () => {
    const s = await withMerged();
    const bob = await addMember(s.t, s.admin, 'bob');
    const refused = await clean(s, bob);
    expect(refused.status).toBe(403);
    expect([...s.repo.refs.keys()]).toContain('refs/heads/a');
    expect((await auditRows(s)).results).toHaveLength(0);
    // A collaborator can push, so can clean.
    const ada = await collaborator(s, 'ada');
    expect(await (await clean(s, ada)).json()).toEqual({ deleted: ['a', 'b'] });
    expect(
      (await call(s.t, `${BASE}/branches/clean`, { method: 'POST' })).status
    ).toBe(401);
  });

  it('pings the repository’s live channel like other repository changes', async () => {
    const s = await withMerged();
    const pings: string[] = [];
    (s.t.env as unknown as { LIVE: unknown }).LIVE = {
      getByName: () => ({
        publish: async (channel: string) => void pings.push(channel),
      }),
    };
    await clean(s);
    await settle(s.t);
    expect(pings).toContain(`repo:${s.repoId}`);
  });

  it('leaves a branch alone when someone pushed to it after it landed', async () => {
    const s = await withMerged();
    await commitPaths(s.repo, 'a', { ...FILES, 'extra.txt': 'x\n' }, 'Extra');
    const res = await clean(s);
    expect(await res.json()).toEqual({ deleted: ['b'] });
    expect([...s.repo.refs.keys()]).toContain('refs/heads/a');
  });
});

describe('DELETE /api/repos/{o}/{r}/branches', () => {
  const rows = (s: CrewRepo) =>
    s.t.env.DB.prepare(
      "SELECT target, data FROM audit_events WHERE action = 'branch.deleted'"
    ).all<{ target: string; data: string }>();
  const del = (s: CrewRepo, name: string) =>
    call(s.t, `${BASE}/branches?name=${encodeURIComponent(name)}`, {
      cookie: s.admin,
      method: 'DELETE',
    });

  it('records the deletion with the sha it removed', async () => {
    const s = await crewRepo();
    const sha = await s.branch('old');
    expect((await del(s, 'old')).status).toBe(200);
    expect(s.repo.refs.has('refs/heads/old')).toBe(false);
    const { results } = await rows(s);
    expect(results).toHaveLength(1);
    expect(results[0].target).toBe('old');
    expect(JSON.parse(results[0].data)).toEqual({ sha });
  });

  it('records nothing for a branch that does not exist, or for a tag of that name', async () => {
    const s = await crewRepo();
    s.repo.refs.set('refs/tags/v1', s.main);
    expect((await del(s, 'nope')).status).toBe(200);
    expect((await del(s, 'v1')).status).toBe(200);
    expect((await rows(s)).results).toEqual([]);
    expect(s.repo.refs.has('refs/tags/v1')).toBe(true);
    // Still refuses the default branch.
    expect((await del(s, 'main')).status).toBe(400);
  });
});

describe('GET /api/repos/{o}/{r}/branches/map', () => {
  type Map_ = {
    from: number;
    to: number;
    main: {
      name: string;
      status: string;
      landings: { number: number; title: string; at: number; sha: string }[];
    };
    open: {
      branch: string;
      number: number;
      title: string;
      openedAt: number;
      state: string;
      reasons: string[];
      author: { login: string };
      createdVia: string | null;
      session: string | null;
      sessionId: string;
      stackedOn: number | null;
    }[];
    leftover: { branch: string; number: number; mergedAt: number }[];
  };
  const map = async (s: CrewRepo, query = '', cookie = s.admin) => {
    const res = await call(s.t, `${BASE}/branches/map${query}`, { cookie });
    return res;
  };
  const getMap = async (s: CrewRepo, query = '') => {
    const res = await map(s, query);
    expect(res.status).toBe(200);
    return (await res.json()) as Map_;
  };
  const run = (
    s: CrewRepo,
    n: number,
    over: {
      event?: string;
      ref?: string;
      status?: string;
      conclusion?: string | null;
      sha?: string;
      path?: string;
    }
  ) =>
    s.t.env.DB.prepare(
      `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title, status, conclusion, created_at)
       VALUES (?, ?, ?, ?, 'CI', ?, ?, ?, 'x', ?, ?, 0)`
    )
      .bind(
        crypto.randomUUID(),
        s.repoId,
        n,
        over.path ?? '.github/workflows/ci.yml',
        over.event ?? 'push',
        over.ref ?? 'refs/heads/main',
        over.sha ?? s.main,
        over.status ?? 'completed',
        over.conclusion === undefined ? 'success' : over.conclusion
      )
      .run();

  it('covers the last 10 days by default, up to 30, and refuses anything else', async () => {
    const s = await crewRepo();
    const before = Date.now();
    const m = await getMap(s);
    expect(m.to).toBeGreaterThanOrEqual(before);
    expect(m.to - m.from).toBe(10 * DAY);
    const wide = await getMap(s, '?days=30');
    expect(wide.to - wide.from).toBe(30 * DAY);
    expect((await getMap(s, '?days=1')).main.name).toBe('main');
    for (const bad of ['0', '31', '-3', 'abc', '2.5'])
      expect((await map(s, `?days=${bad}`)).status).toBe(400);
  });

  it('lists what landed on the default branch in the window, oldest first', async () => {
    const s = await crewRepo();
    const now = Date.now();
    await s.mergedRow(1, 'f1', now - 20 * DAY, {
      title: 'Old one',
      sha: 'a'.repeat(40),
    });
    await s.mergedRow(2, 'f2', now - 3 * DAY, {
      title: 'Recent',
      sha: 'b'.repeat(40),
    });
    await s.mergedRow(3, 'f3', now - 1 * DAY, {
      title: 'Newest',
      sha: 'c'.repeat(40),
    });
    // Merged into another branch: not a landing on main.
    s.repo.refs.set('refs/heads/release', s.main);
    await s.mergedRow(4, 'f4', now - 1 * DAY, { base: 'release' });
    const m = await getMap(s);
    expect(m.main.landings).toEqual([
      {
        number: 2,
        title: 'Recent',
        at: Math.floor((now - 3 * DAY) / 1000) * 1000,
        sha: 'b'.repeat(40),
      },
      {
        number: 3,
        title: 'Newest',
        at: Math.floor((now - DAY) / 1000) * 1000,
        sha: 'c'.repeat(40),
      },
    ]);
    // The window widens with days.
    expect(
      (await getMap(s, '?days=30')).main.landings.map((l) => l.number)
    ).toEqual([1, 2, 3]);
    expect(
      (await getMap(s, '?days=2')).main.landings.map((l) => l.number)
    ).toEqual([3]);
  });

  it('shows landings from the merge button', async () => {
    const s = await crewRepo();
    await s.branch('feature');
    const n = await s.web('feature', { title: 'Ship it' });
    await s.merge(n);
    const m = await getMap(s);
    expect(m.main.landings).toHaveLength(1);
    expect(m.main.landings[0]).toMatchObject({
      number: n,
      title: 'Ship it',
      sha: s.repo.refs.get('refs/heads/main'),
    });
    expect(m.main.landings[0].at).toBeGreaterThan(Date.now() - 60_000);
  });

  it('reports main’s status from the latest run on the default branch', async () => {
    const s = await crewRepo();
    expect((await getMap(s)).main.status).toBe('unknown');
    // Runs on pull requests and other branches say nothing about main.
    await run(s, 1, {
      event: 'pull_request',
      ref: 'refs/pull/1/head',
      conclusion: 'failure',
    });
    await run(s, 2, { ref: 'refs/heads/other', conclusion: 'failure' });
    expect((await getMap(s)).main.status).toBe('unknown');
    await run(s, 3, { conclusion: 'failure' });
    expect((await getMap(s)).main.status).toBe('failing');
    // A newer run replaces it.
    await run(s, 4, { conclusion: 'success' });
    expect((await getMap(s)).main.status).toBe('passing');
    await run(s, 5, { status: 'in_progress', conclusion: null });
    expect((await getMap(s)).main.status).toBe('running');
    await run(s, 6, { status: 'queued', conclusion: null });
    expect((await getMap(s)).main.status).toBe('running');
    await run(s, 7, { conclusion: 'cancelled' });
    expect((await getMap(s)).main.status).toBe('failing');
    await run(s, 8, { conclusion: 'skipped' });
    expect((await getMap(s)).main.status).toBe('passing');
  });

  it('lists open pull requests into main with their state, author, app and session', async () => {
    const s = await crewRepo();
    const claude = (await connect(s.t, s.admin, 'Claude Code')).access_token;
    const ada = await collaborator(s, 'ada');
    for (const b of ['one', 'two', 'three', 'four']) await s.branch(b);
    s.repo.refs.set('refs/heads/release', s.main);
    const one = await s.mcp(claude, 'one', {
      title: 'By Claude',
      session: 's7',
    });
    const two = await s.web('two', { title: 'By Ada', cookie: ada });
    // Into another branch, and closed: not on main's map.
    await s.web('three', { base: 'release' });
    const four = await s.web('four');
    await call(s.t, `${BASE}/pulls/${four}`, {
      cookie: s.admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });

    const m = await getMap(s);
    expect(m.open.map((o) => o.number)).toEqual([one, two]);
    expect(m.open[0]).toMatchObject({
      branch: 'one',
      number: one,
      title: 'By Claude',
      state: 'human_review',
      author: { login: 'octocat', name: 'Admin', isAgent: false, color: null },
      createdVia: 'Claude Code',
      session: 's7',
      sessionId: expect.stringMatching(/^s-[0-9a-f]{10}$/),
      stackedOn: null,
    });
    expect(m.open[0].reasons).toContain('needs_approval');
    expect(m.open[0].openedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(m.open[1]).toMatchObject({
      branch: 'two',
      author: { login: 'ada' },
      createdVia: null,
      session: null,
    });
  });

  it('says which pull request a stacked one is stacked on', async () => {
    const s = await crewRepo();
    await s.branch('parent');
    await s.branch('child');
    await s.branch('solo');
    const parent = await s.web('parent');
    const child = await s.web('child', { base: 'parent' });
    const solo = await s.web('solo');
    // Stacking keeps the land target at main while the base is the parent's branch.
    await s.t.env.DB.prepare(
      "UPDATE pull_requests SET land_target = 'main' WHERE number = ?"
    )
      .bind(child)
      .run();
    const m = await getMap(s);
    const by = Object.fromEntries(m.open.map((o) => [o.number, o]));
    expect(Object.keys(by).map(Number).sort()).toEqual([parent, child, solo]);
    expect(by[child].stackedOn).toBe(parent);
    expect(by[parent].stackedOn).toBeNull();
    expect(by[solo].stackedOn).toBeNull();
  });

  it('lists merged branches nobody deleted, with their pull request and merge time', async () => {
    const s = await crewRepo();
    const now = Date.now();
    s.repo.refs.set('refs/heads/left-1', s.main);
    s.repo.refs.set('refs/heads/left-2', s.main);
    await s.mergedRow(7, 'left-1', now - 40 * DAY);
    await s.mergedRow(8, 'left-2', now - 2 * DAY);
    const m = await getMap(s);
    // Leftovers are not limited to the window.
    expect(m.leftover).toEqual([
      {
        branch: 'left-1',
        number: 7,
        mergedAt: Math.floor((now - 40 * DAY) / 1000) * 1000,
      },
      {
        branch: 'left-2',
        number: 8,
        mergedAt: Math.floor((now - 2 * DAY) / 1000) * 1000,
      },
    ]);
    // Deleted ones are gone from the map.
    expect(
      (
        await call(s.t, `${BASE}/branches/clean`, {
          cookie: s.admin,
          method: 'POST',
        })
      ).status
    ).toBe(200);
    expect((await getMap(s)).leftover).toEqual([]);
  });

  it('is hidden from a member who cannot read the repository', async () => {
    const s = await crewRepo();
    await call(s.t, '/api/repos', {
      cookie: s.admin,
      json: { name: 'secret', visibility: 'private' },
    });
    const bob = await addMember(s.t, s.admin, 'bob');
    expect(
      (
        await call(s.t, '/api/repos/octocat/secret/branches/map', {
          cookie: bob,
        })
      ).status
    ).toBe(404);
    expect((await map(s, '', bob)).status).toBe(200);
    expect((await call(s.t, `${BASE}/branches/map`)).status).toBe(401);
  });
});

describe('landing deletes the head branch when the repository says so', () => {
  const mergedRows = (s: CrewRepo) =>
    s.t.env.DB.prepare(
      "SELECT target, data, actor_kind FROM audit_events WHERE action = 'branch.deleted'"
    ).all<{ target: string; data: string; actor_kind: string }>();

  it('is on by default, and the merge button deletes the branch', async () => {
    const s = await crewRepo();
    const repo = (await (
      await call(s.t, BASE, { cookie: s.admin })
    ).json()) as {
      deleteMergedBranches: boolean;
    };
    expect(repo.deleteMergedBranches).toBe(true);
    const head = await s.branch('feature');
    const n = await s.web('feature');
    await s.merge(n);
    expect(s.repo.refs.has('refs/heads/feature')).toBe(false);
    expect(s.repo.refs.get('refs/heads/main')).toBe(head);
    const { results } = await mergedRows(s);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      target: 'feature',
      actor_kind: 'system',
    });
    // `pull` is the pull request whose landing deleted it, so the audit log can say "after #n merged".
    expect(JSON.parse(results[0].data)).toEqual({
      sha: head,
      merged: true,
      pull: n,
    });
  });

  it('keeps the branch when the repository keeps merged branches', async () => {
    const s = await crewRepo();
    const patch = await call(s.t, BASE, {
      cookie: s.admin,
      method: 'PATCH',
      json: { deleteMergedBranches: false },
    });
    expect(patch.status).toBe(200);
    expect(
      ((await patch.json()) as { deleteMergedBranches: boolean })
        .deleteMergedBranches
    ).toBe(false);
    const head = await s.branch('feature');
    await s.merge(await s.web('feature'));
    expect(s.repo.refs.get('refs/heads/feature')).toBe(head);
    expect((await mergedRows(s)).results).toEqual([]);
  });

  it('deletes after auto-merge lands it too', async () => {
    const s = await crewRepo();
    await s.branch('feature');
    const n = await s.web('feature');
    await call(s.t, `${BASE}/pulls/${n}/approval`, {
      cookie: s.admin,
      method: 'POST',
    });
    const found = (await findRepoById(s.db, s.repoId))!;
    const pr = (await s.db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.number, n))
      .get())!;
    const result = await landPull({
      env: s.t.env,
      db: s.db,
      repo: found.repo,
      repoFullName: 'octocat/app',
      git: gitFor(s.t.env, found.repo),
      pr,
      by: null,
      after: (w) => s.t.ctx.waitUntil(w),
    });
    expect(result.ok).toBe(true);
    await settle(s.t);
    expect(s.repo.refs.has('refs/heads/feature')).toBe(false);
    // Auto-merge's deletion names the pull request too.
    const { results } = await mergedRows(s);
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0].data)).toMatchObject({
      merged: true,
      pull: n,
    });
  });

  it('keeps a branch another open pull request is based on, and a protected branch', async () => {
    const s = await crewRepo();
    await s.setRepo('protected_branches', JSON.stringify(['release/*']));
    await s.branch('parent');
    await s.branch('child');
    const parent = await s.web('parent');
    await s.web('child', { base: 'parent' });
    await s.merge(parent);
    // A release branch cut from the new main, with its own change.
    s.repo.refs.set(
      'refs/heads/release/1',
      s.repo.refs.get('refs/heads/main')!
    );
    await commitPaths(
      s.repo,
      'release/1',
      { ...FILES, 'r.txt': 'r\n' },
      'Release work'
    );
    await s.merge(await s.web('release/1'));
    expect(s.repo.refs.has('refs/heads/parent')).toBe(true);
    expect(s.repo.refs.has('refs/heads/release/1')).toBe(true);
    // Not leftovers either: Clean up never deletes them.
    const b = byName(await branches(s));
    expect(b.parent.mergedNotDeleted).toBe(false);
    expect(b['release/1'].mergedNotDeleted).toBe(false);
  });
});

describe('PATCH deleteMergedBranches', () => {
  it('needs repository admin, and is audited as a settings change', async () => {
    const s = await crewRepo();
    const ada = await collaborator(s, 'ada');
    const refused = await call(s.t, BASE, {
      cookie: ada,
      method: 'PATCH',
      json: { deleteMergedBranches: false },
    });
    expect(refused.status).toBe(403);
    const ok = await call(s.t, BASE, {
      cookie: s.admin,
      method: 'PATCH',
      json: { deleteMergedBranches: false },
    });
    expect(ok.status).toBe(200);
    const row = (await s.t.env.DB.prepare(
      "SELECT data FROM audit_events WHERE action = 'settings.changed'"
    ).first<{ data: string }>())!;
    expect(JSON.parse(row.data)).toEqual({
      changes: { deleteMergedBranches: { from: true, to: false } },
    });
    // Saying the same again changes nothing.
    await call(s.t, BASE, {
      cookie: s.admin,
      method: 'PATCH',
      json: { deleteMergedBranches: false },
    });
    expect(
      (await s.t.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'settings.changed'"
      ).first<{ n: number }>())!.n
    ).toBe(1);
    const got = (await (await call(s.t, BASE, { cookie: ada })).json()) as {
      deleteMergedBranches: boolean;
    };
    expect(got.deleteMergedBranches).toBe(false);
  });
});
