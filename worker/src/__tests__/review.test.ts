import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { deleteMergedBranch } from '../merge/land';
import { findRepoById, gitFor } from '../lib/repos';
import {
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
  type TestEnv,
} from './helpers/app';
import { commitPaths } from './helpers/seed';

const APP = { 'src/app.ts': 'export const a = 1;\n' };

/** A repository with an open PR adding `changes`. */
async function pullWith(changes: Record<string, string>) {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'internal' },
  });
  const repo = [...t.fake.repos.values()][0];
  const main = await commitPaths(repo, 'main', APP, 'base');
  repo.refs.set('refs/heads/feature', main);
  await commitPaths(
    repo,
    'feature',
    {
      ...APP,
      ...changes,
    },
    'Change things'
  );
  await call(t, '/api/repos/octocat/app/pulls', {
    cookie: admin,
    json: {
      title: 'Change things',
      body: 'Some changes.',
      base: 'main',
      head: 'feature',
    },
  });
  await settle(t);
  return { t, admin, repo };
}

describe('code excerpts for flags', () => {
  it('takes the lines a model points at from the real diff, numbered as in the file', async () => {
    const { renderNumberedDiff, snippetLines } =
      await import('../review/detail');
    const d = {
      path: 'a.py',
      status: 'modified' as const,
      oldHash: null,
      newHash: null,
      mode: '100644',
      additions: 2,
      deletions: 1,
      binary: false,
      tooLarge: false,
      hunks: [
        {
          oldStart: 10,
          oldLines: 3,
          newStart: 10,
          newLines: 4,
          lines: [' keep', '-old', '+new', '+newer', ' tail'],
        },
      ],
    };
    expect(renderNumberedDiff(d)).toBe(
      [
        '    10     | keep',
        '-   11 old | old',
        '+   11     | new',
        '+   12     | newer',
        '    13     | tail',
      ].join('\n')
    );
    expect(snippetLines(d, 11, 12)).toBe('-old\n+new\n+newer');
    expect(snippetLines(d, 50, 60)).toBeNull();
  });
});

describe('what the investigating model reads', () => {
  it('leaves out generated files and lockfiles, caps huge diffs, and reads source first', async () => {
    const { diffsFor } = await import('../review/detail');
    const { ArtifactsRepoClient } = await import('../git/remote');
    const { GitService } = await import('../git/service');
    const { createFakeArtifacts } = await import('./helpers/fake-artifacts');
    const fake = createFakeArtifacts();
    await fake.binding.create('r');
    const repo = fake.repos.get('r')!;
    const base = await commitPaths(repo, 'main', { 'src/a.ts': 'a\n' }, 'base');
    const huge = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    const head = await commitPaths(
      repo,
      'main',
      {
        'src/a.ts': 'a\nb\n',
        'docs/guide.md': 'guide\n',
        'worker/src/__tests__/a.test.ts': 'test\n',
        'migrations/meta/0008_snapshot.json': huge,
        'yarn.lock': 'lock\n',
        'src/big.ts': huge,
      },
      'change'
    );
    const git = new GitService(new ArtifactsRepoClient(fake.binding, 'r'));
    const [from, to] = await Promise.all([git.commit(base), git.commit(head)]);
    const changes = await git.diffTrees(from!.treeHash, to!.treeHash);
    const { ignoreMatcher } = await import('../review/ignore');
    const text = await diffsFor(
      git,
      changes,
      [],
      ignoreMatcher('migrations/meta/*.json')
    );
    expect(text).not.toContain('--- migrations/meta/0008_snapshot.json');
    expect(text).not.toContain('--- yarn.lock');
    expect(text).toContain(
      'Ignored (lockfiles and .orangeignore), not shown: migrations/meta/0008_snapshot.json, yarn.lock'
    );
    expect(text).toContain("(the rest of this file's diff is not shown)");
    // Source, then tests, then docs.
    const at = (p: string) => text.indexOf(`--- ${p}`);
    expect(at('src/a.ts')).toBeLessThan(at('worker/src/__tests__/a.test.ts'));
    expect(at('worker/src/__tests__/a.test.ts')).toBeLessThan(
      at('docs/guide.md')
    );
    expect(text.length).toBeLessThan(130 * 1024);
  });
});

describe('Mermaid diagrams', () => {
  it('keeps multi-line or escaped diagrams and drops one-line ones', async () => {
    const { mermaidSource } = await import('../review/models');
    // A literal "\n" from the model becomes a real line break.
    expect(
      mermaidSource('erDiagram\\n  SETTINGS {\\n    text key PK "NEW"\\n  }')
    ).toBe('erDiagram\n  SETTINGS {\n    text key PK "NEW"\n  }');
    expect(mermaidSource('flowchart LR\nA-->B')).toBe('flowchart LR\nA-->B');
    // A single line is not drawable.
    expect(mermaidSource('erDiagram SETTINGS { text key PK }')).toBeNull();
    // Fences and comments dropped.
    expect(
      mermaidSource('```mermaid\nerDiagram\n%% note\nX {\ntext id PK\n}\n```')
    ).toBe('erDiagram\nX {\ntext id PK\n}');
    expect(mermaidSource('erDiagram')).toBeNull();
    expect(mermaidSource('')).toBeNull();
  });
});

describe('.orangeignore', () => {
  it('reads .gitignore-style patterns', async () => {
    const { ignoreMatcher } = await import('../review/ignore');
    const ignored = ignoreMatcher(
      [
        '# generated',
        'worker-configuration.d.ts',
        'migrations/meta/',
        '*.snap',
        'dist/**/*.js',
        '/build',
        '!dist/keep.js',
      ].join('\n')
    );
    for (const p of [
      'worker/worker-configuration.d.ts',
      'migrations/meta/0008_snapshot.json',
      'src/__snapshots__/a.test.ts.snap',
      'dist/a/b.js',
      'dist/x.js',
      'build/out.txt',
      'yarn.lock',
      'packages/a/package-lock.json',
    ])
      expect(ignored(p), p).toBe(true);
    for (const p of [
      'worker/src/index.ts',
      'migrations/0008_x.sql',
      'dist/keep.js',
      'src/build/x.ts',
      'snap.ts',
    ])
      expect(ignored(p), p).toBe(false);
    // No file: only lockfiles.
    expect(ignoreMatcher(null)('yarn.lock')).toBe(true);
    expect(ignoreMatcher(null)('gen.d.ts')).toBe(false);
  });
});

describe('auto-merge deletes the merged branch', () => {
  /** Calls the cleanup directly, as auto-merge does after landing pull request #`number`. */
  async function cleanup(t: TestEnv, number: number, headSha: string) {
    const db = drizzle(t.env.DB, { schema });
    const pr = (await db.query.pullRequests.findFirst({
      where: (p, { eq }) => eq(p.number, number),
    }))!;
    const found = (await findRepoById(db, pr.repositoryId))!;
    return deleteMergedBranch({
      env: t.env,
      db,
      repo: found.repo,
      git: gitFor(t.env, found.repo),
      pr,
      headSha,
    });
  }

  async function mergeByHand(t: TestEnv, admin: string, number = 1) {
    const res = await call(t, `/api/repos/octocat/app/pulls/${number}/merge`, {
      cookie: admin,
      json: { approve: true },
    });
    expect(res.status).toBe(200);
    await settle(t);
  }

  it('keeps the branch after a manual merge', async () => {
    const { t, admin, repo } = await pullWith({ 'src/b.ts': 'b\n' });
    const head = repo.refs.get('refs/heads/feature');
    await mergeByHand(t, admin);
    expect(repo.refs.get('refs/heads/feature')).toBe(head);
  });

  it('keeps the branch when someone pushed to it after the merged commit', async () => {
    const { t, admin, repo } = await pullWith({ 'src/b.ts': 'b\n' });
    const merged = repo.refs.get('refs/heads/feature')!;
    await mergeByHand(t, admin);
    const pushed = await commitPaths(
      repo,
      'feature',
      { ...APP, 'src/b.ts': 'b2\n' },
      'Later'
    );
    expect(await cleanup(t, 1, merged)).toBe(false);
    expect(repo.refs.get('refs/heads/feature')).toBe(pushed);
    // The ref update itself is compare-and-swap: a stale head is refused.
    const db = drizzle(t.env.DB, { schema });
    const found = (await findRepoById(
      db,
      [...(await db.query.repositories.findMany())][0].id
    ))!;
    await expect(
      gitFor(t.env, found.repo).deleteBranch('feature', merged)
    ).rejects.toThrow();
    expect(repo.refs.get('refs/heads/feature')).toBe(pushed);
    // At the merged commit it goes.
    expect(await cleanup(t, 1, pushed)).toBe(true);
    expect(repo.refs.has('refs/heads/feature')).toBe(false);
  });

  it('keeps a branch another open pull request builds on', async () => {
    const { t, admin, repo } = await pullWith({ 'src/b.ts': 'b\n' });
    const head = repo.refs.get('refs/heads/feature')!;
    repo.refs.set('refs/heads/child', head);
    await commitPaths(repo, 'child', { ...APP, 'src/c.ts': 'c\n' }, 'Child');
    const opened = await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Child', base: 'feature', head: 'child' },
    });
    expect(opened.status).toBe(201);
    await mergeByHand(t, admin);
    expect(await cleanup(t, 1, head)).toBe(false);
    expect(repo.refs.get('refs/heads/feature')).toBe(head);
  });

  it('never deletes the default branch', async () => {
    const { t, admin, repo } = await pullWith({ 'src/b.ts': 'b\n' });
    // A pull request from main into an older release branch.
    const main = repo.refs.get('refs/heads/main')!;
    repo.refs.set('refs/heads/release', main);
    const tip = await commitPaths(
      repo,
      'main',
      { ...APP, 'src/m.ts': 'm\n' },
      'Main moves on'
    );
    const opened = await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Backport', base: 'release', head: 'main' },
    });
    expect(opened.status).toBe(201);
    await mergeByHand(t, admin, 2);
    expect(await cleanup(t, 2, tip)).toBe(false);
    expect(repo.refs.get('refs/heads/main')).toBe(tip);
  });
});
