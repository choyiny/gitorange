import { describe, expect, it } from 'vitest';
import { addMember, bootstrapAdmin, call, makeEnv } from './helpers/app';
import { commitFiles } from './helpers/seed';

async function withRepo() {
  const t = makeEnv();
  const admin = await bootstrapAdmin(t);
  const res = await call(t, '/api/repos', {
    cookie: admin,
    json: {
      name: 'app',
      description: 'demo',
      addReadme: true,
      visibility: 'internal',
    },
  });
  expect(res.status).toBe(201);
  const repo = [...t.fake.repos.values()][0];
  return { t, admin, repo };
}

describe('repositories', () => {
  it('creates an Artifacts repo named by id, with an initial README commit', async () => {
    const { t, admin, repo } = await withRepo();
    expect(repo.name).toMatch(/^r_[0-9a-f-]{36}$/);
    const contents = await call(t, '/api/repos/octocat/app/contents?refPath=', {
      cookie: admin,
    });
    const body = (await contents.json()) as {
      kind: string;
      entries: { name: string }[];
      readme: { text: string };
    };
    expect(body.kind).toBe('tree');
    expect(body.entries.map((e) => e.name)).toEqual(['README.md']);
    expect(body.readme.text).toContain('# app');
  });

  it('rejects a duplicate name for the same owner', async () => {
    const { t, admin } = await withRepo();
    expect(
      (await call(t, '/api/repos', { cookie: admin, json: { name: 'app' } }))
        .status
    ).toBe(409);
  });

  it('lets every member read but only admins change settings', async () => {
    const { t, admin } = await withRepo();
    const bob = await addMember(t, admin, 'bob');
    const detail = (await (
      await call(t, '/api/repos/octocat/app', { cookie: bob })
    ).json()) as { permissions: object };
    expect(detail.permissions).toEqual({
      read: true,
      write: false,
      admin: false,
    });
    expect(
      (
        await call(t, '/api/repos/octocat/app', {
          cookie: bob,
          method: 'DELETE',
        })
      ).status
    ).toBe(403);
    expect(
      (await call(t, '/api/repos/octocat/app', { method: 'GET' })).status
    ).toBe(401);
  });

  it('resolves branch names containing slashes in tree paths', async () => {
    const { t, admin, repo } = await withRepo();
    await commitFiles(repo, 'feature/x', { 'a.txt': 'a' }, 'feat');
    const res = await call(
      t,
      '/api/repos/octocat/app/contents?refPath=feature/x/a.txt',
      { cookie: admin }
    );
    const body = (await res.json()) as {
      ref: string;
      path: string;
      kind: string;
      file: { text: string };
    };
    expect(body).toMatchObject({
      ref: 'feature/x',
      path: 'a.txt',
      kind: 'blob',
    });
    expect(body.file.text).toBe('a');
  });
});

describe('pull requests', () => {
  async function withBranch() {
    const ctx = await withRepo();
    const main = ctx.repo.refs.get('refs/heads/main')!;
    await commitFiles(
      ctx.repo,
      'feature',
      {
        'README.md': '# app\n\ndemo\n\nUsage: greet\n',
        'greet.py': 'print("hi")\n',
      },
      'Add greet',
      [main]
    );
    return ctx;
  }

  it('numbers pull requests sequentially per repository', async () => {
    const { t, admin, repo } = await withBranch();
    const a = await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'A', base: 'main', head: 'feature' },
    });
    expect(((await a.json()) as { number: number }).number).toBe(1);
    await commitFiles(repo, 'other', { 'x.txt': 'x' }, 'x', [
      repo.refs.get('refs/heads/main')!,
    ]);
    const b = await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'B', base: 'main', head: 'other' },
    });
    expect(((await b.json()) as { number: number }).number).toBe(2);
  });

  it('refuses a second open PR for the same branches', async () => {
    const { t, admin } = await withBranch();
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'A', base: 'main', head: 'feature' },
    });
    const dup = await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'A', base: 'main', head: 'feature' },
    });
    expect(dup.status).toBe(409);
  });

  it('requires push access to open a PR', async () => {
    const { t, admin } = await withBranch();
    const bob = await addMember(t, admin, 'bob');
    const res = await call(t, '/api/repos/octocat/app/pulls', {
      cookie: bob,
      json: { title: 'A', base: 'main', head: 'feature' },
    });
    expect(res.status).toBe(403);
    // ...but any member may comment.
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'A', base: 'main', head: 'feature' },
    });
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/1/comments', {
          cookie: bob,
          json: { body: 'nice' },
        })
      ).status
    ).toBe(201);
  });

  it('shows the diff and merges a diverged branch with a real merge commit', async () => {
    const { t, admin, repo } = await withBranch();
    await commitFiles(
      repo,
      'main',
      { 'README.md': '# app\n\ndemo\n', LICENSE: 'MIT\n' },
      'Add license'
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Greet', base: 'main', head: 'feature' },
    });

    const files = (await (
      await call(t, '/api/repos/octocat/app/pulls/1/files', { cookie: admin })
    ).json()) as { path: string; status: string }[];
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['README.md', 'modified'],
      ['greet.py', 'added'],
    ]);

    const detail = (await (
      await call(t, '/api/repos/octocat/app/pulls/1', { cookie: admin })
    ).json()) as { mergeable: boolean };
    expect(detail.mergeable).toBe(true);

    const baseBefore = repo.refs.get('refs/heads/main')!;
    const headSha = repo.refs.get('refs/heads/feature')!;
    const merge = await call(t, '/api/repos/octocat/app/pulls/1/merge', {
      cookie: admin,
      json: {},
    });
    expect(merge.status).toBe(200);
    const { sha } = (await merge.json()) as { sha: string };

    // Rebase and merge: one commit on top of the base, so history stays linear.
    expect(repo.refs.get('refs/heads/main')).toBe(sha);
    expect(repo.refs.get('refs/pull/1/head')).toBe(headSha);
    const commit = repo.parseCommit(sha)!;
    expect(commit.parents).toEqual([baseBefore]);
    expect(commit.message).toBe('Greet (#1)');
    expect(repo.parseTree(commit.treeHash)!.map((e) => e.name)).toEqual([
      'LICENSE',
      'README.md',
      'greet.py',
    ]);

    const after = (await (
      await call(t, '/api/repos/octocat/app/pulls/1', { cookie: admin })
    ).json()) as { pull: { state: string } };
    expect(after.pull.state).toBe('merged');
    // Files remain viewable after the head branch is deleted.
    await call(t, '/api/repos/octocat/app/branches?name=feature', {
      cookie: admin,
      method: 'DELETE',
    });
    const still = (await (
      await call(t, '/api/repos/octocat/app/pulls/1/files', { cookie: admin })
    ).json()) as unknown[];
    expect(still).toHaveLength(2);
  });

  it('squash merges into a single-parent commit', async () => {
    const { t, admin, repo } = await withBranch();
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Greet', base: 'main', head: 'feature' },
    });
    const base = repo.refs.get('refs/heads/main')!;
    const res = await call(t, '/api/repos/octocat/app/pulls/1/merge', {
      cookie: admin,
      json: { method: 'squash' },
    });
    const { sha } = (await res.json()) as { sha: string };
    const commit = repo.parseCommit(sha)!;
    expect(commit.parents).toEqual([base]);
    expect(commit.message).toBe('Greet (#1)');
  });

  it('reports conflicts and refuses to merge them', async () => {
    const { t, admin, repo } = await withBranch();
    await commitFiles(
      repo,
      'main',
      { 'README.md': '# different\n' },
      'Change readme'
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Greet', base: 'main', head: 'feature' },
    });
    const detail = (await (
      await call(t, '/api/repos/octocat/app/pulls/1', { cookie: admin })
    ).json()) as {
      mergeable: boolean;
      conflicts: string[];
    };
    expect(detail.mergeable).toBe(false);
    expect(detail.conflicts).toEqual(['README.md']);
    const res = await call(t, '/api/repos/octocat/app/pulls/1/merge', {
      cookie: admin,
      json: { method: 'rebase' },
    });
    expect(res.status).toBe(409);
  });

  it('does not let a collaborator-less member merge', async () => {
    const { t, admin } = await withBranch();
    const bob = await addMember(t, admin, 'bob');
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Greet', base: 'main', head: 'feature' },
    });
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/1/merge', {
          cookie: bob,
          json: {},
        })
      ).status
    ).toBe(403);
  });
});

describe('hardening', () => {
  it('rejects pull requests whose base or head is not a branch', async () => {
    const { t, admin, repo } = await withRepo();
    const main = repo.refs.get('refs/heads/main')!;
    await commitFiles(repo, 'feature', { 'x.txt': 'x' }, 'x', [main]);
    const res = await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'A', base: main, head: 'feature' },
    });
    expect(res.status).toBe(400);
  });

  it('shows member emails only to site admins and the member themself', async () => {
    const { t, admin } = await withRepo();
    const bob = await addMember(t, admin, 'bob');
    await addMember(t, admin, 'carol');
    type M = { username: string; email: string | null }[];
    const asBob = (await (
      await call(t, '/api/users', { cookie: bob })
    ).json()) as M;
    expect(asBob.find((m) => m.username === 'carol')!.email).toBeNull();
    expect(asBob.find((m) => m.username === 'bob')!.email).toBe(
      'bob@example.com'
    );
    const asAdmin = (await (
      await call(t, '/api/users', { cookie: admin })
    ).json()) as M;
    expect(asAdmin.find((m) => m.username === 'carol')!.email).toBe(
      'carol@example.com'
    );
  });
});
