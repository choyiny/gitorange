import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitService } from '../git/service';
import { addMember, call } from './helpers/app';
import { newAgent } from './helpers/agents';
import { crewRepo, FILES, type CrewRepo } from './helpers/crew';
import { commitPaths } from './helpers/seed';

type SearchResults = {
  repos: { name: string; description: string | null }[];
  pulls: { repo: string; number: number; title: string; state: string }[];
  agents: { handle: string; name: string; color: string }[];
  people: { login: string; name: string | null }[];
  branches: { repo: string; name: string }[];
  files: { repo: string; path: string }[];
};

async function search(
  s: CrewRepo,
  q: string,
  opts: { repo?: string; cookie?: string } = {}
) {
  const params = new URLSearchParams({ q });
  if (opts.repo) params.set('repo', opts.repo);
  const res = await call(s.t, `/api/search?${params}`, {
    cookie: opts.cookie ?? s.admin,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SearchResults;
}

async function newRepo(
  s: CrewRepo,
  name: string,
  visibility: 'private' | 'internal' = 'internal',
  description?: string
) {
  const res = await call(s.t, '/api/repos', {
    cookie: s.admin,
    json: { name, visibility, ...(description ? { description } : {}) },
  });
  expect(res.status).toBe(201);
  return (await s.t.env.DB.prepare('SELECT id FROM repositories WHERE name = ?')
    .bind(name)
    .first<{ id: string }>())!.id;
}

/** A pull request row straight in D1. */
async function pullRow(
  s: CrewRepo,
  repoId: string,
  number: number,
  title: string
) {
  const author = (await s.t.env.DB.prepare(
    "SELECT id FROM users WHERE username = 'octocat'"
  ).first<{ id: string }>())!.id;
  const now = Math.floor(Date.now() / 1000);
  await s.t.env.DB.prepare(
    `INSERT INTO pull_requests (id, repository_id, number, title, author_id, base_ref, head_ref, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'main', ?, 'open', ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      repoId,
      number,
      title,
      author,
      `b${number}`,
      now,
      now
    )
    .run();
}

afterEach(() => vi.restoreAllMocks());

describe('GET /api/search', () => {
  it('finds only what the caller can see', async () => {
    const s = await crewRepo();
    const bob = await addMember(s.t, s.admin, 'bob');
    const secret = await newRepo(s, 'secret-app', 'private', 'Hidden');
    await pullRow(s, s.repoId, 1, 'Add login page');
    await pullRow(s, secret, 1, 'Add login secret');

    const forBob = await search(s, 'app', { cookie: bob });
    expect(forBob.repos).toEqual([{ name: 'octocat/app', description: null }]);
    const forAdmin = await search(s, 'app');
    expect(forAdmin.repos.map((r) => r.name).sort()).toEqual([
      'octocat/app',
      'octocat/secret-app',
    ]);
    expect(forAdmin.repos.find((r) => r.name === 'octocat/secret-app')).toEqual(
      { name: 'octocat/secret-app', description: 'Hidden' }
    );

    expect((await search(s, 'login', { cookie: bob })).pulls).toEqual([
      {
        repo: 'octocat/app',
        number: 1,
        title: 'Add login page',
        state: 'open',
      },
    ]);
    expect((await search(s, 'login')).pulls).toHaveLength(2);
    // A number finds pull requests by number.
    expect(
      (await search(s, '#1', { cookie: bob })).pulls.map((p) => p.repo)
    ).toEqual(['octocat/app']);

    // A repository the caller can't read gives no branches or files.
    const hidden = await search(s, 'a', {
      cookie: bob,
      repo: 'octocat/secret-app',
    });
    expect(hidden.branches).toEqual([]);
    expect(hidden.files).toEqual([]);
  });

  it('finds agents and people by handle or name; agents are not people', async () => {
    const s = await crewRepo();
    await addMember(s.t, s.admin, 'bob');
    await newAgent(s.t, s.admin, 'secagent', 'Security Agent');
    const found = await search(s, 'secur');
    expect(found.agents).toEqual([
      {
        handle: 'secagent',
        name: 'Security Agent',
        color: expect.stringMatching(/^#[0-9a-f]{6}$/),
      },
    ]);
    expect(found.people).toEqual([]);
    expect((await search(s, 'secagent')).people).toEqual([]);
    expect((await search(s, 'bo')).people).toEqual([
      { login: 'bob', name: 'bob' },
    ]);
    expect((await search(s, 'admin')).people).toEqual([
      { login: 'octocat', name: 'Admin' },
    ]);
  });

  it('returns at most 8 of each kind', async () => {
    const s = await crewRepo();
    for (let i = 0; i < 10; i++) {
      await newRepo(s, `demo-${i}`);
      await pullRow(s, s.repoId, i + 1, `Demo change ${i}`);
    }
    await commitPaths(
      s.repo,
      'main',
      {
        ...FILES,
        ...Object.fromEntries(
          Array.from({ length: 12 }, (_, i) => [`docs/demo-${i}.md`, `${i}\n`])
        ),
      },
      'Docs'
    );
    for (let i = 0; i < 10; i++)
      s.repo.refs.set(`refs/heads/demo-${i}`, s.main);
    const found = await search(s, 'demo', { repo: 'octocat/app' });
    expect(found.repos).toHaveLength(8);
    expect(found.pulls).toHaveLength(8);
    expect(found.branches).toHaveLength(8);
    expect(found.files).toHaveLength(8);
  });

  it('searches branches and files only within the repository given', async () => {
    const s = await crewRepo();
    await s.branch('feature-login');
    await commitPaths(
      s.repo,
      'main',
      {
        ...FILES,
        'src/login/form.tsx': 'x\n',
        'docs/login.md': 'y\n',
        'README.md': 'z\n',
      },
      'Login'
    );
    expect(await search(s, 'login')).toMatchObject({ branches: [], files: [] });
    const scoped = await search(s, 'login', { repo: 'octocat/app' });
    expect(scoped.branches).toEqual([
      { repo: 'octocat/app', name: 'feature-login' },
    ]);
    // Names that start with it first, then shorter paths.
    expect(scoped.files).toEqual([
      { repo: 'octocat/app', path: 'docs/login.md' },
      { repo: 'octocat/app', path: 'src/login/form.tsx' },
    ]);
    // Case doesn't matter.
    expect((await search(s, 'README', { repo: 'octocat/app' })).files).toEqual([
      { repo: 'octocat/app', path: 'README.md' },
    ]);
  });

  it('reads the file list once a minute at most', async () => {
    const s = await crewRepo();
    const trees = vi.spyOn(GitService.prototype, 'tree');
    await search(s, 'app', { repo: 'octocat/app' });
    const first = trees.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    expect((await search(s, 'app', { repo: 'octocat/app' })).files).toEqual([
      { repo: 'octocat/app', path: 'src/app.ts' },
    ]);
    expect(trees.mock.calls.length).toBe(first);
  });

  it('returns nothing for a blank query, and needs a session', async () => {
    const s = await crewRepo();
    expect(await search(s, '   ')).toEqual({
      repos: [],
      pulls: [],
      agents: [],
      people: [],
      branches: [],
      files: [],
    });
    expect((await call(s.t, '/api/search?q=app')).status).toBe(401);
    expect(
      (await call(s.t, '/api/search?q=app&repo=nope', { cookie: s.admin }))
        .status
    ).toBe(400);
  });
});
