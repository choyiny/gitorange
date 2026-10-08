import { describe, expect, it } from 'vitest';
import { call, settle } from './helpers/app';
import { commitFiles } from './helpers/seed';
import {
  detail,
  divergedPull,
  moved,
  namedSteps,
  NOTES,
  rows,
  runRebases,
} from './helpers/rebase';
import { events } from './helpers/stacking';

/** The commits from `head` down to (not including) `stop`, newest first: [sha, message]. */
function chain(
  repo: Awaited<ReturnType<typeof divergedPull>>['repo'],
  head: string,
  stop: string
) {
  const out: [string, string][] = [];
  for (let sha = head; sha !== stop;) {
    const c = repo.parseCommit(sha);
    if (!c) throw new Error(`${stop} is not an ancestor`);
    out.push([sha, c.message]);
    sha = c.parents[0];
  }
  return out;
}

describe('rebase runs', () => {
  it('rebases an open pull request when its target moves, keeping the old head and recording it', async () => {
    const { t, admin, repo, f2, root } = await divergedPull();
    expect((await detail(t, admin)).rebase!.status).toBe('behind');
    await moved(t, 'main', root);
    expect(await runRebases(t)).toBeGreaterThan(0);
    const head = repo.refs.get('refs/heads/feature')!;
    const tip = repo.refs.get('refs/heads/main')!;
    expect(chain(repo, head, tip).map(([, m]) => m)).toEqual([
      'Elaborate on three',
      'Add b',
    ]);
    expect(repo.refs.get(`refs/pull/1/pre-rebase/${f2.slice(0, 7)}`)).toBe(f2);
    expect(await events(t, 1)).toContainEqual({
      kind: 'rebased',
      data: { from: f2, to: head, onto: 'main', skipped: 0, resolved: 0 },
    });
    const d = await detail(t, admin);
    expect(d.rebase!.status).toBe('up_to_date');
    expect(d.mergeable).toBe(true);
    expect(await rows(t)).toEqual([]);
  });

  it('queues a rebase when a pull request behind its base opens', async () => {
    const { t, admin, repo, root } = await divergedPull();
    await commitFiles(
      repo,
      'two',
      { 'notes.txt': NOTES, 'c.txt': 'c\n' },
      'Add c',
      [root]
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Two', body: '', base: 'main', head: 'two' },
    });
    await runRebases(t);
    const head = repo.refs.get('refs/heads/two')!;
    expect(repo.parseCommit(head)!.parents).toEqual([
      repo.refs.get('refs/heads/main'),
    ]);
  });

  it('starts over from the new head when the agent pushes during the rebase', async () => {
    const { t, repo, f2, root } = await divergedPull();
    await moved(t, 'main', root);
    let pushed = '';
    const { step, names } = namedSteps(async (name) => {
      if (name !== 'write:0') return;
      pushed = await commitFiles(
        repo,
        'feature',
        {
          'notes.txt': NOTES.replace('three', 'three, and a half'),
          'b.txt': 'b\n',
          'late.txt': 'late\n',
        },
        'Late'
      );
    });
    await runRebases(t, { step });
    expect(names).toContain('write:1');
    const head = repo.refs.get('refs/heads/feature')!;
    const tip = repo.refs.get('refs/heads/main')!;
    expect(chain(repo, head, tip).map(([, m]) => m)).toEqual([
      'Late',
      'Elaborate on three',
      'Add b',
    ]);
    // Only the head that was replaced is kept: the agent's own push was never overwritten.
    expect(repo.refs.get(`refs/pull/1/pre-rebase/${pushed.slice(0, 7)}`)).toBe(
      pushed
    );
    expect(repo.refs.has(`refs/pull/1/pre-rebase/${f2.slice(0, 7)}`)).toBe(
      false
    );
  });

  it('records a conflict for the agent, and leaves the branch alone, when AI isn’t there', async () => {
    const { t, admin, repo, f2, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    await runRebases(t); // no resolver
    expect(repo.refs.get('refs/heads/feature')).toBe(f2);
    const [row] = await rows(t);
    expect(row).toMatchObject({
      commit: f2,
      status: 'failed',
      model: 'none',
      paths: '["notes.txt"]',
    });
    expect(row.error).toMatch(
      /^Commit [0-9a-f]{7} conflicts in notes\.txt\. Rebase locally\.$/
    );
    const d = await detail(t, admin);
    expect(d.rebase).toMatchObject({
      status: 'conflict',
      commit: f2,
      files: ['notes.txt'],
    });
    expect(d.mergeable).toBe(false);
    expect(d.pullState!.state).toBe('agent_followup');
    expect(d.pullState!.reasons).toContainEqual({
      kind: 'rebase_conflict',
      commit: f2,
      files: ['notes.txt'],
      error: row.error,
    });
  });

  it('records a conflict AI can’t take: a file deleted on one side and changed on the other', async () => {
    const { t, admin, repo, root } = await divergedPull();
    await commitFiles(repo, 'gone', { 'b.txt': 'b\n' }, 'Delete notes', [root]);
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Gone', body: '', base: 'main', head: 'gone' },
    });
    const old = repo.refs.get('refs/heads/main')!;
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': NOTES.replace('one', 'ONE'), 'other.txt': 'x\n' },
      'Edit notes'
    );
    await moved(t, 'main', old);
    await runRebases(t);
    const gone = (await rows(t)).find((r) => r.paths === '["notes.txt"]')!;
    expect(gone.error).toMatch(/deleted on one side and changed on the other/);
  });

  it('reports too many commits, to squash locally', async () => {
    const { t, repo, root } = await divergedPull();
    for (let i = 0; i < 100; i++)
      await commitFiles(
        repo,
        'feature',
        { 'notes.txt': NOTES, 'b.txt': `${i}\n` },
        `#${i}`
      );
    await moved(t, 'main', root);
    await runRebases(t);
    expect(await rows(t)).toEqual([
      expect.objectContaining({
        commit: null,
        status: 'failed',
        error:
          'Too many commits to rebase (102; at most 100) — squash locally.',
      }),
    ]);
  });

  it('rebases again after the agent force-pushes the old head', async () => {
    const { t, admin, repo, f2, root } = await divergedPull();
    await moved(t, 'main', root);
    await runRebases(t);
    const first = repo.refs.get('refs/heads/feature')!;
    repo.refs.set('refs/heads/feature', f2); // git push --force of the old head
    expect((await detail(t, admin)).rebase!.status).toBe('behind'); // the page starts a rebase
    await runRebases(t);
    const again = repo.refs.get('refs/heads/feature')!;
    expect(again).not.toBe(f2);
    expect(chain(repo, again, repo.refs.get('refs/heads/main')!)).toHaveLength(
      2
    );
    expect(repo.refs.get(`refs/pull/1/pre-rebase/${f2.slice(0, 7)}`)).toBe(f2);
    expect(first).not.toBe(f2);
  });

  it('two runs at the same tips write once', async () => {
    const { t, admin, repo, root } = await divergedPull();
    await moved(t, 'main', root);
    await detail(t, admin); // a page view starts a second run before the first ran
    await settle(t);
    expect(
      t.actions.resolutions.filter(
        (r) => (r.params as { rebase?: unknown }).rebase
      )
    ).toHaveLength(2);
    await runRebases(t);
    expect(
      (await events(t, 1)).filter((e) => e.kind === 'rebased')
    ).toHaveLength(1);
    expect(
      chain(
        repo,
        repo.refs.get('refs/heads/feature')!,
        repo.refs.get('refs/heads/main')!
      )
    ).toHaveLength(2);
  });

  it('ends quietly when the branch is deleted before the write', async () => {
    const { t, repo, root } = await divergedPull();
    await moved(t, 'main', root);
    const { step } = namedSteps((name) => {
      if (name === 'write:0') repo.refs.delete('refs/heads/feature');
    });
    await runRebases(t, { step });
    expect(repo.refs.has('refs/heads/feature')).toBe(false);
    expect([...repo.refs.keys()].some((r) => r.includes('pre-rebase'))).toBe(
      false
    );
  });

  it('rebases a stacked child onto its parent’s branch when the parent moves', async () => {
    const { t, admin, repo, f2, root } = await divergedPull();
    // #2 from `child`, built on feature, stacked on it by hand (as a reconcile would).
    const child = await commitFiles(
      repo,
      'child',
      {
        'notes.txt': NOTES.replace('three', 'three, and a half'),
        'b.txt': 'b\n',
        'c.txt': 'c\n',
      },
      'Add c',
      [f2]
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Child', body: '', base: 'main', head: 'child' },
    });
    await t.env.DB.prepare(
      "UPDATE pull_requests SET base_ref = 'feature' WHERE number = 2"
    ).run();
    await moved(t, 'main', root); // rebases #1; its new head moves `feature`, which rebases #2
    await runRebases(t);
    const parent = repo.refs.get('refs/heads/feature')!;
    expect(parent).not.toBe(f2);
    const head = repo.refs.get('refs/heads/child')!;
    expect(head).not.toBe(child);
    expect(repo.parseCommit(head)!.parents).toEqual([parent]);
    expect(repo.parseCommit(head)!.message).toBe('Add c');
  });

  it('rebases children onto the land target once their parent closes', async () => {
    const { t, admin, repo, f2 } = await divergedPull();
    await commitFiles(
      repo,
      'child',
      { 'notes.txt': NOTES, 'b.txt': 'b\n', 'c.txt': 'c\n' },
      'Add c',
      [f2]
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Child', body: '', base: 'main', head: 'child' },
    });
    await t.env.DB.prepare(
      "UPDATE pull_requests SET base_ref = 'feature' WHERE number = 2"
    ).run();
    await call(t, '/api/repos/octocat/app/pulls/1', {
      cookie: admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    await runRebases(t);
    const head = repo.refs.get('refs/heads/child')!;
    // Its own commit and the closed parent's, now on main's tip.
    expect(
      chain(repo, head, repo.refs.get('refs/heads/main')!).map(([, m]) => m)
    ).toEqual(['Add c', 'Elaborate on three', 'Add b']);
  });

  it('leaves the branch alone and shows nothing to merge when the base already has every change', async () => {
    const { t, admin, repo, root } = await divergedPull();
    const same = await commitFiles(
      repo,
      'same',
      { 'notes.txt': NOTES, 'b.txt': 'b\n' },
      'Add b',
      [root]
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Same', body: '', base: 'main', head: 'same' },
    });
    // main gets the same change as its own commit (a cherry-pick): replaying #2 leaves nothing.
    const old = repo.refs.get('refs/heads/main')!;
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': NOTES, 'other.txt': 'x\n', 'b.txt': 'b\n' },
      'Add b (picked)'
    );
    await moved(t, 'main', old);
    await runRebases(t);
    expect(repo.refs.get('refs/heads/same')).toBe(same);
    expect(
      [...repo.refs.keys()].some((r) => r.startsWith('refs/pull/2/pre-rebase'))
    ).toBe(false);
    expect((await events(t, 2)).map((e) => e.kind)).not.toContain('rebased');
    const d = await detail(t, admin, 2);
    expect(d.rebase).toMatchObject({ status: 'nothing_to_merge', files: [] });
    expect(d.mergeable).toBe(false);
    expect(d.pullState!.reasons.map((r) => r.kind)).not.toContain(
      'rebase_conflict'
    );
    // The page doesn't start another run for it.
    await settle(t);
    expect(await runRebases(t)).toBe(0);
  });

  it('starts a new rebase when the run resolving a commit died, but not while one is running', async () => {
    const { t, admin, repo, f2 } = await divergedPull({ conflict: true });
    await settle(t);
    const pr = (await t.env.DB.prepare(
      'SELECT id, repository_id AS repo FROM pull_requests WHERE number = 1'
    ).first<{ id: string; repo: string }>())!;
    const started = () =>
      t.actions.resolutions.filter(
        (r) => (r.params as { rebase?: unknown }).rebase
      ).length;
    const before = started();
    // A resolution left running by a run that is gone.
    await t.env.DB.prepare(
      `INSERT INTO merge_resolutions (id, pull_request_id, base_sha, head_sha, commit_sha, status, model, conflicted_paths, created_at)
       VALUES ('r', ?, ?, ?, ?, 'running', 'm', '["notes.txt"]', 1)`
    )
      .bind(pr.id, repo.refs.get('refs/heads/main')!, f2, f2)
      .run();
    expect((await detail(t, admin)).rebase).toMatchObject({
      status: 'resolving',
      commit: f2,
    });
    await settle(t);
    expect(started()).toBe(before + 1);
    // A rebase run that started recently and is still running holds the next one back.
    await t.env.DB.prepare(
      `INSERT INTO agent_runs (id, repository_id, pull_request_id, kind, status, title, workflow_instance_id, started_at)
       VALUES ('run', ?, ?, 'rebase', 'running', 'Rebase #1 onto main', 'run', ?)`
    )
      .bind(pr.repo, pr.id, Date.now())
      .run();
    await detail(t, admin);
    await settle(t);
    expect(started()).toBe(before + 1);
  });

  it('never rebases the default branch, and says why', async () => {
    const { t, admin, repo, root } = await divergedPull();
    const release = await commitFiles(
      repo,
      'release',
      { 'notes.txt': NOTES, 'r.txt': 'r\n' },
      'Release notes',
      [root]
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Ship', body: '', base: 'release', head: 'main' },
    });
    await commitFiles(
      repo,
      'release',
      { 'notes.txt': NOTES, 'r.txt': 'r2\n' },
      'Release fix'
    );
    await moved(t, 'release', release);
    const main = repo.refs.get('refs/heads/main')!;
    await runRebases(t);
    expect(repo.refs.get('refs/heads/main')).toBe(main);
    const pr2 = (await t.env.DB.prepare(
      'SELECT id FROM pull_requests WHERE number = 2'
    ).first<{ id: string }>())!.id;
    expect(
      t.actions.resolutions.filter(
        (r) =>
          (r.params as { rebase?: { pullRequestId: string } }).rebase
            ?.pullRequestId === pr2
      )
    ).toEqual([]);
    const error = 'Not rebased: main is the default branch.';
    const d = await detail(t, admin, 2);
    expect(d.rebase).toMatchObject({ status: 'conflict', error });
    expect(d.pullState!.reasons).toContainEqual({
      kind: 'rebase_conflict',
      commit: null,
      files: [],
      error,
    });
  });

  it('rebases neither of two open pull requests sharing a head into different bases, until one closes', async () => {
    const { t, admin, repo, f2, root } = await divergedPull();
    await commitFiles(
      repo,
      'release',
      { 'notes.txt': NOTES, 'r.txt': 'r\n' },
      'Release notes',
      [root]
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Backport', body: '', base: 'release', head: 'feature' },
    });
    await moved(t, 'main', root);
    expect(await runRebases(t)).toBe(0);
    expect(repo.refs.get('refs/heads/feature')).toBe(f2);
    expect((await detail(t, admin, 1)).rebase).toMatchObject({
      status: 'conflict',
      error:
        'Not rebased: feature is the head of another open pull request (#2).',
    });
    expect((await detail(t, admin, 2)).rebase).toMatchObject({
      status: 'conflict',
      error:
        'Not rebased: feature is the head of another open pull request (#1).',
    });
    await settle(t);
    expect(await runRebases(t)).toBe(0); // page views queue nothing either
    // Closing #2 lets #1 rebase onto main.
    await call(t, '/api/repos/octocat/app/pulls/2', {
      cookie: admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    expect(await runRebases(t)).toBeGreaterThan(0);
    const head = repo.refs.get('refs/heads/feature')!;
    expect(
      chain(repo, head, repo.refs.get('refs/heads/main')!).map(([, m]) => m)
    ).toEqual(['Elaborate on three', 'Add b']);
    expect((await detail(t, admin, 1)).rebase!.status).toBe('up_to_date');
  });

  it('never rewrites a branch matching a protected pattern, in a run or when landing, and says why', async () => {
    const { t, admin, repo, root } = await divergedPull();
    const release = await commitFiles(
      repo,
      'release/x',
      { 'notes.txt': NOTES, 'r.txt': 'r\n' },
      'Release notes',
      [root]
    );
    const set = await call(t, '/api/repos/octocat/app', {
      cookie: admin,
      method: 'PATCH',
      json: { protectedBranches: ['develop', 'release/*'] },
    });
    expect(set.status).toBe(200);
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Ship x', body: '', base: 'main', head: 'release/x' },
    });
    await moved(t, 'main', root);
    await runRebases(t);
    // #1 (feature, not protected) still rebases; release/x is left alone.
    expect((await detail(t, admin, 1)).rebase!.status).toBe('up_to_date');
    expect(repo.refs.get('refs/heads/release/x')).toBe(release);
    const error =
      'Not rebased: release/x is a protected branch; bring it up to date yourself.';
    const d = await detail(t, admin, 2);
    expect(d.rebase).toMatchObject({ status: 'conflict', error });
    expect(d.pullState!.reasons).toContainEqual({
      kind: 'rebase_conflict',
      commit: null,
      files: [],
      error,
    });
    // Landing's own rebase won't rewrite it either.
    const merge = await call(t, '/api/repos/octocat/app/pulls/2/merge', {
      cookie: admin,
      json: { approve: true },
    });
    expect(merge.status).toBe(409);
    expect(await merge.text()).toContain(error);
    expect(repo.refs.get('refs/heads/release/x')).toBe(release);
    await runRebases(t);
    expect(repo.refs.get('refs/heads/release/x')).toBe(release);
    // Unprotected, it rebases onto main.
    await call(t, '/api/repos/octocat/app', {
      cookie: admin,
      method: 'PATCH',
      json: { protectedBranches: ['develop'] },
    });
    await detail(t, admin, 2);
    await runRebases(t);
    const head = repo.refs.get('refs/heads/release/x')!;
    expect(head).not.toBe(release);
    expect(repo.parseCommit(head)!.parents).toEqual([
      repo.refs.get('refs/heads/main'),
    ]);
  });

  it('rebases and lands a parent whose child was opened directly against its branch (hand-stacked)', async () => {
    const { t, admin, repo, f2, root } = await divergedPull();
    await commitFiles(
      repo,
      'child',
      {
        'notes.txt': NOTES.replace('three', 'three, and a half'),
        'b.txt': 'b\n',
        'c.txt': 'c\n',
      },
      'Add c',
      [f2]
    );
    const opened = await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Child', body: '', base: 'feature', head: 'child' },
    });
    expect(opened.status).toBe(201);
    await moved(t, 'main', root);
    await runRebases(t);
    const parent = repo.refs.get('refs/heads/feature')!;
    expect(parent).not.toBe(f2);
    const d = await detail(t, admin, 1);
    expect(d.rebase!.status).toBe('up_to_date');
    expect(d.rebase!.error).toBeNull();
    // The child follows its parent's rewritten branch.
    const child = repo.refs.get('refs/heads/child')!;
    expect(repo.parseCommit(child)!.parents).toEqual([parent]);
    const merge = await call(t, '/api/repos/octocat/app/pulls/1/merge', {
      cookie: admin,
      json: { approve: true },
    });
    expect(merge.status).toBe(200);
    expect(repo.refs.get('refs/heads/main')).toBe(parent);
  });

  it('still rebases a parent whose stacked child has its branch as base_ref', async () => {
    const { t, admin, repo, f2, root } = await divergedPull();
    await commitFiles(
      repo,
      'child',
      {
        'notes.txt': NOTES.replace('three', 'three, and a half'),
        'b.txt': 'b\n',
        'c.txt': 'c\n',
      },
      'Add c',
      [f2]
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Child', body: '', base: 'main', head: 'child' },
    });
    // Stacked by GitOrange (as a reconcile does): base_ref is the parent's branch, it still lands on main.
    await t.env.DB.prepare(
      "UPDATE pull_requests SET base_ref = 'feature', land_target = 'main' WHERE number = 2"
    ).run();
    await moved(t, 'main', root);
    await runRebases(t);
    expect(repo.refs.get('refs/heads/feature')).not.toBe(f2);
    const d = await detail(t, admin, 1);
    expect(d.rebase!.status).toBe('up_to_date');
    expect(d.rebase!.error).toBeNull();
  });

  it('ignores a squash-era failed row (commit_sha NULL) written at the same tips during the deploy gap', async () => {
    const { t, admin, repo, f2, tip } = await divergedPull();
    const pr = (await t.env.DB.prepare(
      'SELECT id FROM pull_requests WHERE number = 1'
    ).first<{ id: string }>())!;
    // What the code before rebase merging inserts for a conflict AI can't take: a random id, no commit.
    await t.env.DB.prepare(
      `INSERT INTO merge_resolutions (id, pull_request_id, base_sha, head_sha, commit_sha, status, model, conflicted_paths, error_message, created_at)
       VALUES ('6f1c2a7e-0d3b-4c55-9a51-3b7f0e2d9c11', ?, ?, ?, NULL, 'failed', 'none', '["notes.txt"]', 'These conflicts can''t be resolved automatically', ?)`
    )
      .bind(pr.id, tip, f2, Math.floor(Date.now() / 1000))
      .run();
    const d = await detail(t, admin);
    expect(d.rebase!.status).toBe('behind');
    expect(d.pullState!.reasons.map((r) => r.kind)).not.toContain(
      'rebase_conflict'
    );
    await settle(t);
    expect(await runRebases(t)).toBeGreaterThan(0);
    expect(
      repo.parseCommit(repo.refs.get('refs/heads/feature')!)!.parents
    ).not.toEqual([f2]);
    expect((await detail(t, admin)).rebase!.status).toBe('up_to_date');
  });

  it('queues another rebase when the target moves while a run that then stops is running', async () => {
    const { t, repo, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    const first = t.actions.resolutions.find(
      (r) => (r.params as { rebase?: unknown }).rebase
    )!;
    const pr = (await t.env.DB.prepare(
      'SELECT id, repository_id AS repo FROM pull_requests WHERE number = 1'
    ).first<{ id: string; repo: string }>())!;
    // As in production, the run's own agent run is running while it ends (it must not hold back the requeue).
    await t.env.DB.prepare(
      `INSERT INTO agent_runs (id, repository_id, pull_request_id, kind, status, title, workflow_instance_id, started_at)
       VALUES (?, ?, ?, 'rebase', 'running', 'Rebase #1 onto main', ?, ?)`
    )
      .bind(first.id, pr.repo, pr.id, first.id, Date.now())
      .run();
    let movedOnce = false;
    const { step } = namedSteps(async (name) => {
      if (name !== 'stop:0:0' || movedOnce) return;
      movedOnce = true;
      // main moves (no sweep: that sweep's ensureRebase would have skipped this PR while the run ran).
      await commitFiles(
        repo,
        'main',
        { 'notes.txt': NOTES.replace('three', 'THREE (main)'), 'z.txt': 'z\n' },
        'Main moves again'
      );
    });
    expect(await runRebases(t, { step })).toBe(2);
    const tip = repo.refs.get('refs/heads/main')!;
    expect((await rows(t)).map((r) => r.base)).toContain(tip);
  });

  it('a block that lifts never hides the real conflict at the same tips, nor queues a run per page view', async () => {
    const { t, admin, repo, f2, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    await runRebases(t); // #1 stops at a real conflict
    const conflict = (await rows(t)).find((r) => r.commit === f2)!;
    expect(conflict.error).toMatch(
      /^Commit [0-9a-f]{7} conflicts in notes\.txt/
    );
    // A pull request sharing #1's head opens into another base: #1 is blocked at the same tips.
    await commitFiles(
      repo,
      'release',
      { 'notes.txt': NOTES, 'r.txt': 'r\n' },
      'Release notes',
      [root]
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Backport', body: '', base: 'release', head: 'feature' },
    });
    await moved(t, 'feature', f2); // a sweep checks #1 again: the block is recorded at its tips
    expect((await rows(t)).map((r) => r.error)).toContain(
      'Not rebased: feature is the head of another open pull request (#2).'
    );
    // The block lifts.
    await call(t, '/api/repos/octocat/app/pulls/2', {
      cookie: admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    for (let i = 0; i < 3; i++) await detail(t, admin);
    await settle(t);
    expect(await runRebases(t)).toBeLessThanOrEqual(1);
    const d = await detail(t, admin);
    expect(d.rebase).toMatchObject({
      status: 'conflict',
      commit: f2,
      error: conflict.error,
    });
    expect(d.pullState!.reasons).toContainEqual({
      kind: 'rebase_conflict',
      commit: f2,
      files: ['notes.txt'],
      error: conflict.error,
    });
    await settle(t);
    expect(await runRebases(t)).toBe(0);
  });
});
