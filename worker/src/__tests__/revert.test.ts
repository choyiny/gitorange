import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitService } from '../git/service';
import { addMember, call, settle } from './helpers/app';
import { collaborator, crewRepo, FILES, type CrewRepo } from './helpers/crew';
import { commitPaths } from './helpers/seed';

const BASE = '/api/repos/octocat/app';

const revert = (s: CrewRepo, n: number, cookie = s.admin) =>
  call(s.t, `${BASE}/pulls/${n}/revert`, { cookie, method: 'POST' });

/** Pushes `branch` off main's tip with `files` (the whole tree) as one commit per entry of `steps`. */
async function pushSteps(
  s: CrewRepo,
  branch: string,
  steps: Record<string, string>[]
) {
  s.repo.refs.set(`refs/heads/${branch}`, s.repo.refs.get('refs/heads/main')!);
  let sha = '';
  for (const [i, files] of steps.entries())
    sha = await commitPaths(s.repo, branch, files, `${branch} ${i + 1}`);
  return sha;
}

/** Opens a pull request from `branch` and lands it with the merge button. */
async function landed(
  s: CrewRepo,
  branch: string,
  steps: Record<string, string>[],
  title = branch
) {
  await pushSteps(s, branch, steps);
  const n = await s.web(branch, { title });
  await s.merge(n);
  return n;
}

/** The files of the tree at `sha`, flattened to path → contents. */
function filesAt(s: CrewRepo, sha: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (tree: string, prefix: string) => {
    for (const e of s.repo.parseTree(tree)!) {
      if (e.type === 'tree') walk(e.hash, `${prefix}${e.name}/`);
      else
        out[`${prefix}${e.name}`] = new TextDecoder().decode(
          s.repo.objects.get(e.hash)!.data
        );
    }
  };
  walk(s.repo.parseCommit(sha)!.treeHash, '');
  return out;
}

const pullCount = async (s: CrewRepo) =>
  (await s.t.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM pull_requests WHERE repository_id = ?'
  )
    .bind(s.repoId)
    .first<{ n: number }>())!.n;

afterEach(() => vi.restoreAllMocks());

describe('POST /api/repos/{o}/{r}/pulls/{n}/revert', () => {
  it('opens a pull request that undoes every landed commit, on top of the target as it is now', async () => {
    const s = await crewRepo();
    const n = await landed(
      s,
      'feature',
      [
        { ...FILES, 'src/app.ts': 'export const a = 2;\n', 'f.txt': 'one\n' },
        {
          ...FILES,
          'src/app.ts': 'export const a = 2;\n',
          'f.txt': 'one\ntwo\n',
        },
      ],
      'Add feature'
    );
    expect(
      (await s.t.env.DB.prepare(
        'SELECT landed_commits FROM pull_requests WHERE number = ?'
      )
        .bind(n)
        .first<{ landed_commits: number }>())!.landed_commits
    ).toBe(2);
    // main moves on after it.
    await landed(s, 'other', [
      {
        ...FILES,
        'src/app.ts': 'export const a = 2;\n',
        'f.txt': 'one\ntwo\n',
        'other.txt': 'x\n',
      },
    ]);
    const tip = s.repo.refs.get('refs/heads/main')!;

    const res = await revert(s, n);
    expect(res.status).toBe(201);
    const { number } = (await res.json()) as { number: number };
    await settle(s.t);
    expect(number).toBe(3);

    // Never pushed to main: a pull request, reviewed and landed like any other.
    expect(s.repo.refs.get('refs/heads/main')).toBe(tip);
    const head = s.repo.refs.get('refs/heads/revert-1')!;
    const commit = s.repo.parseCommit(head)!;
    expect(commit.parents).toEqual([tip]);
    expect(commit.author).toEqual({
      name: 'Admin',
      email: 'octocat@example.com',
    });
    expect(commit.message).toContain('Revert #1: Add feature');
    expect(filesAt(s, head)).toEqual({ ...FILES, 'other.txt': 'x\n' });

    const page = (await (
      await call(s.t, `${BASE}/pulls/${number}`, { cookie: s.admin })
    ).json()) as {
      pull: {
        title: string;
        body: string;
        headRef: string;
        baseRef: string;
        state: string;
        author: { username: string };
      };
    };
    expect(page.pull).toMatchObject({
      title: 'Revert #1: Add feature',
      headRef: 'revert-1',
      baseRef: 'main',
      state: 'open',
      author: { username: 'octocat' },
    });
    expect(page.pull.body).toContain('#1');

    // Its diff is the landed range, inverted.
    const files = (await (
      await call(s.t, `${BASE}/pulls/${number}/files`, { cookie: s.admin })
    ).json()) as { path: string; status: string }[];
    expect(files.map((f) => [f.path, f.status]).sort()).toEqual([
      ['f.txt', 'removed'],
      ['src/app.ts', 'modified'],
    ]);

    const audit = await s.t.env.DB.prepare(
      "SELECT target, data FROM audit_events WHERE action = 'pull.reverted'"
    ).all<{ target: string; data: string }>();
    expect(audit.results.map((r) => [r.target, JSON.parse(r.data)])).toEqual([
      [
        '#1',
        {
          pull: 1,
          title: 'Add feature',
          revert: 3,
          branch: 'revert-1',
          sha: head,
        },
      ],
    ]);
  });

  it('reverts a squash-era merge (no landed_commits) as its one commit', async () => {
    const s = await crewRepo();
    const squash = await commitPaths(
      s.repo,
      'main',
      { ...FILES, 'squashed.txt': 's\n' },
      'Squashed'
    );
    await s.mergedRow(7, 'old-branch', Date.now(), {
      title: 'Old change',
      sha: squash,
    });
    const res = await revert(s, 7);
    expect(res.status).toBe(201);
    const head = s.repo.refs.get('refs/heads/revert-7')!;
    expect(s.repo.parseCommit(head)!.parents).toEqual([squash]);
    expect(filesAt(s, head)).toEqual(FILES);
  });

  it('409s with a message when later changes touch the same lines, and opens nothing', async () => {
    const s = await crewRepo();
    const n = await landed(s, 'first', [
      { ...FILES, 'src/app.ts': 'export const a = 2;\n' },
    ]);
    await landed(s, 'second', [
      { ...FILES, 'src/app.ts': 'export const a = 3;\n' },
    ]);
    const before = await pullCount(s);
    const res = await revert(s, n);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string; error: string };
    expect(body.message).toContain('src/app.ts');
    expect(body.error).toBe(body.message);
    expect(await pullCount(s)).toBe(before);
    expect(s.repo.refs.has('refs/heads/revert-1')).toBe(false);
  });

  it('refuses a pull request that is not merged', async () => {
    const s = await crewRepo();
    await s.branch('open');
    const n = await s.web('open');
    const res = await revert(s, n);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain(
      'merged'
    );
    expect((await revert(s, 99)).status).toBe(404);
  });

  it('needs push access', async () => {
    const s = await crewRepo();
    const n = await landed(s, 'feature', [{ ...FILES, 'feature.txt': 'f\n' }]);
    const bob = await addMember(s.t, s.admin, 'bob');
    expect((await revert(s, n, bob)).status).toBe(403);
    const ada = await collaborator(s, 'ada');
    const res = await revert(s, n, ada);
    expect(res.status).toBe(201);
    const { number } = (await res.json()) as { number: number };
    const author = await s.t.env.DB.prepare(
      `SELECT u.username FROM pull_requests p JOIN users u ON u.id = p.author_id WHERE p.number = ?`
    )
      .bind(number)
      .first<{ username: string }>();
    expect(author!.username).toBe('ada');
  });

  it('deletes the revert branch when the pull request then fails to open', async () => {
    const s = await crewRepo();
    const n = await landed(s, 'feature', [{ ...FILES, 'feature.txt': 'f\n' }]);
    const before = await pullCount(s);
    // openPull reads the branches afresh; make that read fail after the push.
    vi.spyOn(GitService.prototype, 'refs').mockRejectedValueOnce(
      new Error('Artifacts is down')
    );
    const res = await revert(s, n);
    expect(res.status).toBe(500);
    expect(s.repo.refs.has('refs/heads/revert-1')).toBe(false);
    expect(await pullCount(s)).toBe(before);
    // Nothing left behind: a retry takes the same name.
    const again = await revert(s, n);
    expect(again.status).toBe(201);
    const { number } = (await again.json()) as { number: number };
    const page = (await (
      await call(s.t, `${BASE}/pulls/${number}`, { cookie: s.admin })
    ).json()) as { pull: { headRef: string } };
    expect(page.pull.headRef).toBe('revert-1');
  });

  it('picks a branch name that is free', async () => {
    const s = await crewRepo();
    const n = await landed(s, 'feature', [{ ...FILES, 'feature.txt': 'f\n' }]);
    s.repo.refs.set('refs/heads/revert-1', s.main);
    s.repo.refs.set('refs/heads/revert-1-2', s.main);
    const res = await revert(s, n);
    expect(res.status).toBe(201);
    const { number } = (await res.json()) as { number: number };
    const page = (await (
      await call(s.t, `${BASE}/pulls/${number}`, { cookie: s.admin })
    ).json()) as { pull: { headRef: string } };
    expect(page.pull.headRef).toBe('revert-1-3');
    expect(s.repo.refs.get('refs/heads/revert-1')).toBe(s.main);
  });

  it('409s when the target already undoes it', async () => {
    const s = await crewRepo();
    const n = await landed(s, 'feature', [{ ...FILES, 'feature.txt': 'f\n' }]);
    // Someone already removed the file on main.
    await landed(s, 'undo', [FILES]);
    const res = await revert(s, n);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain(
      'already'
    );
  });
});
