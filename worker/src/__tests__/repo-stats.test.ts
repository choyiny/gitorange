import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { findRepoById } from '../lib/repos';
import { pullBucket, repoStats, type RepoStats } from '../lib/repo-stats';
import { agentColor, PRESETS } from '../agents/presets';
import type { PullState } from '../pulls/state';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
  type TestEnv,
} from './helpers/app';
import { commitPaths } from './helpers/seed';

const DAY = 86400;

type Board = {
  fullName: string;
  stats?: RepoStats;
}[];

const FILES = { 'src/app.ts': 'export const a = 1;\n' };

/**
 * octocat/app (internal) with a base commit on main, and helpers to open PRs and read the board. With `ai`, the
 * Workflow bindings exist, so reviews and stack checks can run here (and pull requests wait for them).
 */
async function boardRepo(
  opts: {
    name?: string;
    visibility?: 'internal' | 'private';
    ai?: boolean;
  } = {}
) {
  const t = makeEnv({ actions: opts.ai ?? false });
  const admin = await bootstrapAdmin(t);
  const name = opts.name ?? 'app';
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name, visibility: opts.visibility ?? 'internal' },
  });
  const repo = [...t.fake.repos.values()][0];
  const main = await commitPaths(repo, 'main', FILES, 'base');
  const db = drizzle(t.env.DB, { schema });
  const repoId = (await t.env.DB.prepare(
    'SELECT id FROM repositories WHERE name = ?'
  )
    .bind(name)
    .first<{ id: string }>())!.id;

  async function open(branch: string, changes: Record<string, string> = {}) {
    repo.refs.set(`refs/heads/${branch}`, main);
    await commitPaths(
      repo,
      branch,
      { ...FILES, [`${branch}.txt`]: `${branch}\n`, ...changes },
      branch
    );
    const res = await call(t, `/api/repos/octocat/${name}/pulls`, {
      cookie: admin,
      json: { title: branch, body: '', base: 'main', head: branch },
    });
    expect(res.status).toBe(201);
    await settle(t);
    return ((await res.json()) as { number: number }).number;
  }
  async function approve(n: number) {
    const res = await call(
      t,
      `/api/repos/octocat/${name}/pulls/${n}/approval`,
      {
        cookie: admin,
        method: 'POST',
      }
    );
    expect(res.status).toBe(200);
    await settle(t);
  }
  async function run(
    n: number,
    branch: string,
    status: string,
    conclusion: string | null
  ) {
    await t.env.DB.prepare(
      `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title, status, conclusion, created_at)
       VALUES (?, ?, ?, '.github/workflows/ci.yml', 'CI', 'pull_request', 'x', ?, 'x', ?, ?, 0)`
    )
      .bind(
        crypto.randomUUID(),
        repoId,
        n,
        repo.refs.get(`refs/heads/${branch}`)!,
        status,
        conclusion
      )
      .run();
  }
  /** The board as `cookie` sees it, keyed by repository full name. */
  async function board(cookie = admin, query = '?stats=1') {
    const res = await call(t, `/api/repos${query}`, { cookie });
    expect(res.status).toBe(200);
    return new Map(((await res.json()) as Board).map((r) => [r.fullName, r]));
  }
  return { t, admin, repo, main, db, repoId, open, approve, run, board };
}

/** Writes a merged pull request straight into D1, merged `daysAgo` UTC days ago at midday. */
async function merged(
  t: TestEnv,
  repoId: string,
  number: number,
  daysAgo: number,
  opts: { auto?: boolean; now?: number } = {}
) {
  const now = opts.now ?? Date.now();
  const midnight = Math.floor(now / 1000 / DAY) * DAY;
  const at = midnight - daysAgo * DAY + 12 * 3600;
  const author = (await t.env.DB.prepare('SELECT id FROM users LIMIT 1').first<{
    id: string;
  }>())!.id;
  await t.env.DB.prepare(
    `INSERT INTO pull_requests (id, repository_id, number, title, author_id, base_ref, head_ref, state, merged_at, closed_at, merged_automatically, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'main', ?, 'merged', ?, ?, ?, ?, ?)`
  )
    .bind(
      `${repoId}-m${number}`,
      repoId,
      number,
      `Merged ${number}`,
      author,
      `m${number}`,
      at,
      at,
      opts.auto ? 1 : 0,
      at - 3600,
      at
    )
    .run();
}

describe('pullBucket', () => {
  const state = (s: PullState['state'], kinds: string[] = []): PullState => ({
    state: s,
    reasons: kinds.map((kind) => ({ kind }) as never),
  });

  it('puts a person’s move, the agent’s move, running work and the line apart', () => {
    expect(pullBucket(state('human_review', ['needs_approval']))).toBe(
      'needsPerson'
    );
    expect(pullBucket(state('agent_followup', ['check_failed']))).toBe(
      'changesRequested'
    );
    for (const kind of [
      'checks_running',
      'agent_reviewing',
      'resolution_running',
      'stack_checking',
    ])
      expect(pullBucket(state('waiting', [kind]))).toBe('checking');
    // Waiting on its order, or on another pull request, is the line.
    expect(pullBucket(state('waiting', ['rebase_onto']))).toBe('queued');
    expect(pullBucket(state('ready'))).toBe('queued');
  });

  it('counts a pull request waiting for both running work and its order as checking', () => {
    expect(
      pullBucket(state('waiting', ['rebase_onto', 'checks_running']))
    ).toBe('checking');
  });
});

describe('GET /api/repos?stats=1', () => {
  it('leaves stats out unless asked for', async () => {
    const s = await boardRepo();
    expect((await s.board(s.admin, '')).get('octocat/app')!.stats).toBe(
      undefined
    );
    expect((await s.board(s.admin, '?stats=0')).get('octocat/app')!.stats).toBe(
      undefined
    );
  });

  it('counts open pull requests by whose move it is, from their computed states', async () => {
    const s = await boardRepo();
    // Needs a person: no agent reviewed it and nobody approved.
    await s.open('one');
    // Changes requested: approved, but its checks failed.
    await s.open('two');
    await s.approve(2);
    await s.run(1, 'two', 'completed', 'failure');
    // Checking: approved, checks still running.
    await s.open('three');
    await s.approve(3);
    await s.run(2, 'three', 'in_progress', null);
    // Queued: approved and ready.
    await s.open('four');
    await s.approve(4);
    // A closed pull request is not open.
    await s.t.env.DB.prepare(
      `INSERT INTO pull_requests (id, repository_id, number, title, author_id, base_ref, head_ref, state, created_at, updated_at)
       SELECT 'closed1', ?, 50, 'Closed', author_id, 'main', 'old', 'closed', 0, 0 FROM pull_requests LIMIT 1`
    )
      .bind(s.repoId)
      .run();

    const stats = (await s.board()).get('octocat/app')!.stats!;
    expect(stats.pulls).toEqual({
      open: 4,
      needsPerson: 1,
      changesRequested: 1,
      checking: 1,
      queued: 1,
    });
  });

  it('counts a pull request whose stack check has not run as checking, once AI is set up', async () => {
    const s = await boardRepo({ ai: true });
    await s.open('one');
    await s.open('two');
    await s.approve(1);
    await s.approve(2);
    // Two open pull requests into main: each waits until Clef has compared the pair.
    expect((await s.board()).get('octocat/app')!.stats!.pulls).toEqual({
      open: 2,
      needsPerson: 0,
      changesRequested: 0,
      checking: 2,
      queued: 0,
    });
  });

  it('counts the open pull requests whose state cannot be computed (a branch gone) as open only', async () => {
    const s = await boardRepo();
    await s.open('one');
    await s.open('two');
    s.repo.refs.delete('refs/heads/two');
    const { pulls } = (await s.board()).get('octocat/app')!.stats!;
    expect(pulls).toEqual({
      open: 2,
      needsPerson: 1,
      changesRequested: 0,
      checking: 0,
      queued: 0,
    });
  });

  it('reads the states of each repository once, however many pull requests it has', async () => {
    const s = await boardRepo();
    for (const b of ['a', 'b', 'c', 'd', 'e']) await s.open(b);
    const statements: string[] = [];
    const counting = new Proxy(s.t.env.DB, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const db = drizzle(counting, { schema });
    const found = (await findRepoById(db, s.repoId))!;
    statements.length = 0;
    const stats = (await repoStats(s.t.env, db, [found.repo])).get(s.repoId)!;
    expect(stats.pulls.open).toBe(5);
    // One read of the Actions runs for the whole repository (five heads fit one chunk), not one per pull request.
    expect(
      statements.filter((q) => /from "workflow_runs"/i.test(q))
    ).toHaveLength(1);
  });

  it('lists merges over the last seven UTC days, oldest first, and how many were automatic', async () => {
    const s = await boardRepo();
    await merged(s.t, s.repoId, 1, 0, { auto: true });
    await merged(s.t, s.repoId, 2, 0);
    await merged(s.t, s.repoId, 3, 2, { auto: true });
    await merged(s.t, s.repoId, 4, 6, { auto: true });
    // Outside the window.
    await merged(s.t, s.repoId, 5, 7, { auto: true });
    await merged(s.t, s.repoId, 6, 30);

    const stats = (await s.board()).get('octocat/app')!.stats!;
    expect(stats.merged7d).toBe(4);
    expect(stats.mergedByDay).toEqual([1, 0, 0, 0, 1, 0, 2]);
    expect(stats.mergedAutomaticallyPct).toBe(75);
  });

  it('has no automatic share and seven empty days when nothing merged', async () => {
    const s = await boardRepo();
    await merged(s.t, s.repoId, 1, 9, { auto: true });
    const stats = (await s.board()).get('octocat/app')!.stats!;
    expect(stats.merged7d).toBe(0);
    expect(stats.mergedByDay).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(stats.mergedAutomaticallyPct).toBeNull();
  });

  it('puts a merge on the day it happened in UTC, whatever the time of day', async () => {
    const s = await boardRepo();
    const db = drizzle(s.t.env.DB, { schema });
    const found = (await findRepoById(db, s.repoId))!;
    // Noon on 8 October 2026 UTC. 23:59 the day before and 00:00 the day itself fall on different days.
    const now = new Date(Date.UTC(2026, 9, 8, 12, 0, 0));
    const author = (await s.t.env.DB.prepare(
      'SELECT id FROM users LIMIT 1'
    ).first<{
      id: string;
    }>())!.id;
    const insert = (number: number, at: number) =>
      s.t.env.DB.prepare(
        `INSERT INTO pull_requests (id, repository_id, number, title, author_id, base_ref, head_ref, state, merged_at, merged_automatically, created_at, updated_at)
         VALUES (?, ?, ?, 'x', ?, 'main', ?, 'merged', ?, 0, 0, 0)`
      )
        .bind(`p${number}`, s.repoId, number, author, `h${number}`, at)
        .run();
    await insert(1, Date.UTC(2026, 9, 7, 23, 59, 59) / 1000);
    await insert(2, Date.UTC(2026, 9, 8, 0, 0, 0) / 1000);
    await insert(3, Date.UTC(2026, 9, 2, 0, 0, 0) / 1000); // the first day of the window
    await insert(4, Date.UTC(2026, 9, 1, 23, 59, 59) / 1000); // the day before it
    const stats = (await repoStats(s.t.env, db, [found.repo], { now })).get(
      s.repoId
    )!;
    expect(stats.mergedByDay).toEqual([1, 0, 0, 0, 0, 1, 1]);
    expect(stats.merged7d).toBe(3);
  });

  it('lists the invited agents with their colour and what each is doing', async () => {
    const s = await boardRepo();
    const make = async (body: Record<string, unknown>) => {
      const res = await call(s.t, '/api/admin/agents', {
        cookie: s.admin,
        json: body,
      });
      expect(res.status).toBe(201);
    };
    // No colour in its AGENT.md, but a preset handle: the preset's colour.
    await make({ handle: 'securityagent', name: 'Security' });
    // A preset: its colour comes from its AGENT.md.
    await make({ preset: 'data' });
    // Neither: a stable one from the palette.
    await make({ handle: 'docsagent', name: 'Docs' });
    // Not invited here.
    await make({ handle: 'loneagent', name: 'Lone' });
    for (const h of ['securityagent', 'dataagent', 'docsagent'])
      await call(s.t, `/api/repos/octocat/app/agents/${h}`, {
        cookie: s.admin,
        method: 'PUT',
      });

    const two = await s.open('two');
    const id = async (h: string) =>
      (await s.t.env.DB.prepare('SELECT id FROM users WHERE username = ?')
        .bind(h)
        .first<{ id: string }>())!.id;
    const prId = (await s.t.env.DB.prepare(
      'SELECT id FROM pull_requests WHERE number = ?'
    )
      .bind(two)
      .first<{ id: string }>())!.id;
    const review = async (h: string, status: string, at: number) =>
      s.t.env.DB.prepare(
        `INSERT INTO pr_reviewers (id, pull_request_id, head_sha, agent_id, requested, status, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          prId,
          `sha-${h}-${at}`,
          await id(h),
          status,
          at
        )
        .run();
    // dataagent: an old approval, then a newer review in progress on the same pull request: it is reviewing.
    await review('dataagent', 'approved', 100);
    await review('dataagent', 'reviewing', 200);

    const stats = (await s.board()).get('octocat/app')!.stats!;
    expect(stats.agents).toEqual([
      {
        handle: 'dataagent',
        name: 'Data',
        color: PRESETS.data.color,
        status: 'reviewing',
      },
      {
        handle: 'docsagent',
        name: 'Docs',
        color: agentColor({ color: null }, 'docsagent'),
        status: 'idle',
      },
      {
        handle: 'securityagent',
        name: 'Security',
        color: '#2a78d6',
        status: 'idle',
      },
    ]);
  });

  it('shows the most pressing status when an agent is on several pull requests', async () => {
    const s = await boardRepo();
    await call(s.t, '/api/admin/agents', {
      cookie: s.admin,
      json: { handle: 'secagent', name: 'Sec' },
    });
    await call(s.t, '/api/repos/octocat/app/agents/secagent', {
      cookie: s.admin,
      method: 'PUT',
    });
    const agent = (await s.t.env.DB.prepare(
      `SELECT id FROM users WHERE username = 'secagent'`
    ).first<{ id: string }>())!.id;
    const numbers = [
      await s.open('p1'),
      await s.open('p2'),
      await s.open('p3'),
    ];
    const rows = (
      await s.t.env.DB.prepare(
        'SELECT id, number FROM pull_requests ORDER BY number'
      ).all<{ id: string; number: number }>()
    ).results;
    const statuses = ['approved', 'flagged', 'reviewing'];
    for (const [i, n] of numbers.entries())
      await s.t.env.DB.prepare(
        `INSERT INTO pr_reviewers (id, pull_request_id, head_sha, agent_id, requested, status, created_at)
         VALUES (?, ?, 'h', ?, 1, ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          rows.find((r) => r.number === n)!.id,
          agent,
          statuses[i],
          100 + i
        )
        .run();
    const stats = (await s.board()).get('octocat/app')!.stats!;
    expect(stats.agents.map((a) => [a.handle, a.status])).toEqual([
      ['secagent', 'flagged'],
    ]);
  });

  it('counts branches, and says null when the refs cannot be read', async () => {
    const s = await boardRepo();
    await s.open('one');
    await s.open('two');
    expect((await s.board()).get('octocat/app')!.stats!.branchCount).toBe(3);
    // Refs come from Artifacts: when that fails the board still answers, from what D1 knows.
    s.t.fake.repos.clear();
    const stats = (await s.board()).get('octocat/app')!.stats!;
    expect(stats.branchCount).toBeNull();
    expect(stats.pulls.open).toBe(2);
    // What it learned while Artifacts answered stays.
    expect(stats.language).toBe('TypeScript');
  });

  it('reports when the repository last changed', async () => {
    const s = await boardRepo();
    await s.t.env.DB.prepare(
      'UPDATE repositories SET updated_at = 1700000000 WHERE id = ?'
    )
      .bind(s.repoId)
      .run();
    expect((await s.board()).get('octocat/app')!.stats!.updatedAt).toBe(
      1700000000000
    );
  });

  it('only includes repositories the viewer can see, each with its own stats', async () => {
    const s = await boardRepo();
    const bob = await addMember(s.t, s.admin, 'bob');
    await call(s.t, '/api/repos', {
      cookie: s.admin,
      json: { name: 'secret', visibility: 'private' },
    });
    const board = await s.board(bob);
    expect([...board.keys()]).toEqual(['octocat/app']);
    expect(board.get('octocat/app')!.stats).toBeDefined();
    expect([...(await s.board(s.admin)).keys()].sort()).toEqual([
      'octocat/app',
      'octocat/secret',
    ]);
  });
});

describe('repository language', () => {
  it('is the most common source language in the default branch, ignoring vendored and prose files', async () => {
    const s = await boardRepo();
    await commitPaths(
      s.repo,
      'main',
      {
        'src/a.ts': 'a',
        'src/b.tsx': 'b',
        'src/deep/c.ts': 'c',
        'scripts/x.py': 'x',
        'scripts/y.py': 'y',
        'README.md': 'r',
        'docs/one.md': '1',
        'docs/two.md': '2',
        'docs/three.md': '3',
        'node_modules/dep/index.js': 'j',
        'node_modules/dep/more.js': 'j',
        'node_modules/dep/most.js': 'j',
        'node_modules/dep/lots.js': 'j',
      },
      'sources'
    );
    expect((await s.board()).get('octocat/app')!.stats!.language).toBe(
      'TypeScript'
    );
  });

  it('is Markdown when a repository has nothing but prose and data', async () => {
    const s = await boardRepo();
    await commitPaths(
      s.repo,
      'main',
      { 'AGENT.md': 'a', 'knowledge/one.md': '1', 'avatar.png': 'p' },
      'agent'
    );
    expect((await s.board()).get('octocat/app')!.stats!.language).toBe(
      'Markdown'
    );
  });

  it('is null for an empty repository or one without source files', async () => {
    const s = await boardRepo();
    await commitPaths(s.repo, 'main', { 'data.json': '{}', LICENSE: 'x' }, 'x');
    expect((await s.board()).get('octocat/app')!.stats!.language).toBeNull();
    s.repo.refs.clear();
    const stats = (await s.board()).get('octocat/app')!.stats!;
    expect(stats.language).toBeNull();
    expect(stats.branchCount).toBe(0);
  });

  it('is read once per default branch commit and kept until the branch moves', async () => {
    const s = await boardRepo();
    const head1 = s.repo.refs.get('refs/heads/main')!;
    const cached = () =>
      s.t.env.DB.prepare(
        'SELECT language, language_sha FROM repositories WHERE id = ?'
      )
        .bind(s.repoId)
        .first<{ language: string | null; language_sha: string | null }>();
    // base commit: src/app.ts
    expect((await s.board()).get('octocat/app')!.stats!.language).toBe(
      'TypeScript'
    );
    expect(await cached()).toEqual({
      language: 'TypeScript',
      language_sha: head1,
    });

    // The cache answers while the commit is the same, without reading the tree.
    await s.t.env.DB.prepare(
      `UPDATE repositories SET language = 'Cached' WHERE id = ?`
    )
      .bind(s.repoId)
      .run();
    expect((await s.board()).get('octocat/app')!.stats!.language).toBe(
      'Cached'
    );

    // A new commit on the default branch recomputes it.
    const head2 = await commitPaths(
      s.repo,
      'main',
      { 'a.py': 'a', 'b.py': 'b', 'c.py': 'c' },
      'python'
    );
    expect((await s.board()).get('octocat/app')!.stats!.language).toBe(
      'Python'
    );
    expect(await cached()).toEqual({ language: 'Python', language_sha: head2 });
  });

  it('keeps what it knew when the tree cannot be read', async () => {
    const s = await boardRepo();
    await s.t.env.DB.prepare(
      `UPDATE repositories SET language = 'Go', language_sha = 'old' WHERE id = ?`
    )
      .bind(s.repoId)
      .run();
    // The commit is gone from the object store but the branch still names it.
    s.repo.objects.clear();
    expect((await s.board()).get('octocat/app')!.stats!.language).toBe('Go');
    expect(
      (await s.t.env.DB.prepare('SELECT language_sha FROM repositories').first<{
        language_sha: string;
      }>())!.language_sha
    ).toBe('old');
  });
});
