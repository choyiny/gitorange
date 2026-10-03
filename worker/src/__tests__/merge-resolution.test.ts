import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import {
  executeResolution,
  resolutionRef,
  type StepRunner,
} from '../merge/resolution';
import type { ResolveRequest, ResolveResult } from '../merge/resolver';
import { executeSweep, type SweepParams } from '../merge/auto';
import { handleGitRequest } from '../git-http';
import { concat } from '../git/bytes';
import { FLUSH, pktLine } from '../git/pktline';
import { buildPack } from '../git/pack';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
  type TestEnv,
} from './helpers/app';
import { commitFiles } from './helpers/seed';

const BASE = 'one\ntwo\nthree\nfour\nfive\n';

type Detail = {
  mergeable: boolean;
  conflicts: string[];
  conflictsResolvable: boolean;
  resolvedByAi: boolean;
  aiResolution: boolean;
  resolution: {
    id: string;
    status: string;
    explanation: string | null;
    errorMessage: string | null;
    resultSha: string | null;
    conflictedPaths: string[];
    touchedExtraPaths: string[];
    stale: boolean;
  } | null;
};

/** main and feature both change line 3 of notes.txt, from a common base. */
async function conflictingPull(files: Record<string, string> = {}) {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'internal' },
  });
  const repo = [...t.fake.repos.values()][0];
  const root = await commitFiles(
    repo,
    'main',
    { 'notes.txt': BASE, ...files },
    'base'
  );
  await commitFiles(
    repo,
    'main',
    { 'notes.txt': BASE.replace('three', 'THREE (main)'), ...files },
    'Shout line three'
  );
  await commitFiles(
    repo,
    'feature',
    { 'notes.txt': BASE.replace('three', 'three, and a half'), ...files },
    'Elaborate on three',
    [root]
  );
  await call(t, '/api/repos/octocat/app/pulls', {
    cookie: admin,
    json: {
      title: 'Elaborate',
      body: 'Line three needs more detail.',
      base: 'main',
      head: 'feature',
    },
  });
  await settle(t);
  return { t, admin, repo };
}

async function detail(t: TestEnv, cookie: string) {
  return (await (
    await call(t, '/api/repos/octocat/app/pulls/1', { cookie })
  ).json()) as Detail;
}

/** Runs the resolution Workflow inline with a scripted resolver. */
async function runResolution(
  t: TestEnv,
  id: string,
  resolve: (req: ResolveRequest) => Partial<ResolveResult>
) {
  const requests: ResolveRequest[] = [];
  const step = {
    do: async (_name: string, a: unknown, b?: unknown) =>
      ((b ?? a) as () => Promise<unknown>)(),
  } as unknown as StepRunner;
  await executeResolution(
    {
      env: t.env,
      db: drizzle(t.env.DB, { schema }),
      step,
      resolver: () => ({
        resolve: async (req) => {
          requests.push(req);
          return {
            status: 'done',
            explanation: 'Kept both.',
            files: {},
            transcript: '[]',
            ...resolve(req),
          };
        },
      }),
    },
    id
  );
  return requests;
}

/** Runs every sweep Workflow started so far (once each), inline. */
const swept = new WeakMap<TestEnv, Set<string>>();
async function runSweeps(t: TestEnv) {
  const done = swept.get(t) ?? new Set<string>();
  swept.set(t, done);
  const step = {
    do: async (_name: string, a: unknown, b?: unknown) =>
      ((b ?? a) as () => Promise<unknown>)(),
  } as unknown as StepRunner;
  for (const s of t.actions.resolutions) {
    const params = s.params as { sweep?: SweepParams };
    if (!params.sweep || done.has(s.id)) continue;
    done.add(s.id);
    await executeSweep(
      { env: t.env, db: drizzle(t.env.DB, { schema }), step },
      params.sweep
    );
  }
}

describe('AI conflict resolution', () => {
  it('starts resolving on its own when a conflicting PR opens', async () => {
    const { t, admin } = await conflictingPull();
    const d = await detail(t, admin);
    expect(d).toMatchObject({
      mergeable: false,
      conflicts: ['notes.txt'],
      conflictsResolvable: true,
      aiResolution: true,
      resolution: { status: 'running', conflictedPaths: ['notes.txt'] },
    });
    const id = d.resolution!.id;
    expect(t.actions.resolutions).toContainEqual({
      id,
      params: { resolutionId: id },
    });
    // Asking by hand while it runs returns the same attempt.
    const again = (await (
      await call(t, '/api/repos/octocat/app/pulls/1/resolutions', {
        cookie: admin,
        method: 'POST',
      })
    ).json()) as { id: string };
    expect(again.id).toBe(id);
  });

  it('proposes a squashed commit on the base, then lands it on merge', async () => {
    const { t, admin, repo } = await conflictingPull();
    const { id } = (await (
      await call(t, '/api/repos/octocat/app/pulls/1/resolutions', {
        cookie: admin,
        method: 'POST',
      })
    ).json()) as { id: string };
    const resolved = BASE.replace('three', 'THREE (main), and a half');
    const requests = await runResolution(t, id, () => ({
      files: { 'notes.txt': resolved },
      explanation: 'Kept the uppercase from main and the detail from the PR.',
    }));

    // The model saw the file with diff3 markers and both sides' intent.
    expect(requests[0].files['notes.txt']).toContain('<<<<<<< main');
    expect(requests[0].files['notes.txt']).toContain('>>>>>>> feature');
    expect(requests[0].oursIntent).toContain('Shout line three');
    expect(requests[0].theirsIntent).toContain('Elaborate');
    expect(requests[0].theirsIntent).toContain('Line three needs more detail.');

    const d = await detail(t, admin);
    expect(d.resolution).toMatchObject({
      id,
      status: 'proposed',
      explanation: 'Kept the uppercase from main and the detail from the PR.',
      stale: false,
      touchedExtraPaths: [],
    });
    const baseTip = repo.refs.get('refs/heads/main')!;
    const proposed = repo.parseCommit(repo.refs.get(resolutionRef(id))!)!;
    expect(proposed.parents).toEqual([baseTip]);

    // The resolution is part of the PR now: it shows as mergeable, and a plain merge lands it.
    expect(d).toMatchObject({ mergeable: true, resolvedByAi: true });
    const merge = await call(t, '/api/repos/octocat/app/pulls/1/merge', {
      cookie: admin,
      json: {},
    });
    expect(merge.status).toBe(200);
    const { sha } = (await merge.json()) as { sha: string };
    const landed = repo.parseCommit(sha)!;
    expect(repo.refs.get('refs/heads/main')).toBe(sha);
    expect(landed.parents).toEqual([baseTip]);
    expect(landed.treeHash).toBe(proposed.treeHash);
    expect(landed.message).toBe('Elaborate (#1)');
    expect((await detail(t, admin)).resolution?.status).toBe('applied');
  });

  it('fails a result that still has markers after the agent run, without a second attempt', async () => {
    // The agent's own run checks for markers before it ends (resolver onYield); anything that
    // still has them is rejected here.
    const { t, admin } = await conflictingPull();
    const id = (await detail(t, admin)).resolution!.id;
    await runResolution(t, id, (req) => ({ files: req.files }));
    expect((await detail(t, admin)).resolution).toMatchObject({
      id,
      status: 'failed',
      errorMessage: 'notes.txt still has conflict markers.',
    });
    const n = await t.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM merge_resolutions'
    ).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('leaves an inference failure for a person to retry', async () => {
    const { t, admin } = await conflictingPull();
    const id = (await detail(t, admin)).resolution!.id;
    await runResolution(t, id, () => ({
      status: 'unanswered',
      reason: 'faulted',
    }));
    const d = await detail(t, admin);
    expect(d.resolution).toMatchObject({
      id,
      status: 'failed',
      errorMessage: "The model didn't finish (faulted).",
    });
    expect(d.mergeable).toBe(false);
    // A person can start another attempt.
    const res = await call(t, '/api/repos/octocat/app/pulls/1/resolutions', {
      cookie: admin,
      method: 'POST',
    });
    expect(res.status).toBe(201);
  });

  it('flags files the model touched beyond the conflicts', async () => {
    const { t, admin } = await conflictingPull();
    const { id } = (await (
      await call(t, '/api/repos/octocat/app/pulls/1/resolutions', {
        cookie: admin,
        method: 'POST',
      })
    ).json()) as { id: string };
    await runResolution(t, id, () => ({
      files: { 'notes.txt': 'resolved\n', 'extra.txt': 'new\n' },
    }));
    expect((await detail(t, admin)).resolution).toMatchObject({
      status: 'proposed',
      touchedExtraPaths: ['extra.txt'],
    });
  });

  it('refuses to land a resolution after the base moved', async () => {
    const { t, admin, repo } = await conflictingPull();
    const { id } = (await (
      await call(t, '/api/repos/octocat/app/pulls/1/resolutions', {
        cookie: admin,
        method: 'POST',
      })
    ).json()) as { id: string };
    await runResolution(t, id, () => ({
      files: { 'notes.txt': 'resolved\n' },
    }));
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': BASE.replace('three', 'THREE (main)'), 'more.txt': 'x\n' },
      'Another change'
    );
    expect((await detail(t, admin)).resolution?.stale).toBe(true);
    const merge = await call(t, '/api/repos/octocat/app/pulls/1/merge', {
      cookie: admin,
      json: { resolutionId: id },
    });
    expect(merge.status).toBe(409);
  });

  it('only lets people who can merge start a resolution', async () => {
    const { t, admin } = await conflictingPull();
    const bob = await addMember(t, admin, 'bob');
    const denied = await call(t, '/api/repos/octocat/app/pulls/1/resolutions', {
      cookie: bob,
      method: 'POST',
    });
    expect(denied.status).toBe(403);
  });

  it('leaves binary conflicts to a human', async () => {
    const { t, admin, repo } = await conflictingPull();
    // Both sides rewrite the file with NUL bytes, so it can't be merged as text.
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': 'a\u0000main\n' },
      'binary main'
    );
    await commitFiles(
      repo,
      'feature',
      { 'notes.txt': 'a\u0000feature\n' },
      'binary feature'
    );
    const d = await detail(t, admin);
    expect(d.conflictsResolvable).toBe(false);
    const res = await call(t, '/api/repos/octocat/app/pulls/1/resolutions', {
      cookie: admin,
      method: 'POST',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "can't be resolved automatically"
    );
  });

  it('lets a resolution be discarded', async () => {
    const { t, admin } = await conflictingPull();
    const { id } = (await (
      await call(t, '/api/repos/octocat/app/pulls/1/resolutions', {
        cookie: admin,
        method: 'POST',
      })
    ).json()) as { id: string };
    await runResolution(t, id, () => ({
      files: { 'notes.txt': 'resolved\n' },
    }));
    const res = await call(
      t,
      `/api/repos/octocat/app/pulls/1/resolutions/${id}/reject`,
      { cookie: admin, method: 'POST' }
    );
    expect(res.status).toBe(200);
    expect((await detail(t, admin)).resolution?.status).toBe('rejected');
  });
});

describe('automatic AI conflict resolution', () => {
  async function pat(t: TestEnv, cookie: string) {
    const res = await call(t, '/api/tokens', {
      cookie,
      json: { name: 'cli', expiresInDays: 30 },
    });
    return ((await res.json()) as { plaintext: string }).plaintext;
  }

  /** A real push through the git proxy that moves `branch` to `sha`. */
  async function push(
    t: TestEnv,
    token: string,
    branch: string,
    old: string,
    sha: string
  ) {
    const res = await handleGitRequest(
      new Request('http://test.local/octocat/app.git/git-receive-pack', {
        method: 'POST',
        headers: { Authorization: `Basic ${btoa(`u:${token}`)}` },
        body: concat([
          pktLine(`${old} ${sha} refs/heads/${branch}\0report-status\n`),
          FLUSH,
          await buildPack([]),
        ]),
      }),
      t.env,
      t.ctx
    );
    expect(res.status).toBe(200);
    await settle(t);
    await runSweeps(t);
  }

  async function count(t: TestEnv) {
    const row = await t.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM merge_resolutions'
    ).first<{ n: number }>();
    return row?.n ?? 0;
  }

  it('starts when a push to the base branch puts an open PR into conflict', async () => {
    const t = makeEnv({ actions: true });
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'internal' },
    });
    const repo = [...t.fake.repos.values()][0];
    const root = await commitFiles(repo, 'main', { 'notes.txt': BASE }, 'base');
    await commitFiles(
      repo,
      'feature',
      { 'notes.txt': BASE.replace('three', 'three, and a half') },
      'Elaborate',
      [root]
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Elaborate', base: 'main', head: 'feature' },
    });
    await settle(t);
    expect(await count(t)).toBe(0); // no conflict yet

    // Someone pushes a conflicting change to main.
    const old = repo.refs.get('refs/heads/main')!;
    const conflicting = await commitFiles(
      repo,
      'main',
      { 'notes.txt': BASE.replace('three', 'THREE') },
      'Shout'
    );
    repo.refs.set('refs/heads/main', old); // the push below moves it
    const token = await pat(t, admin);
    await push(t, token, 'main', old, conflicting);
    expect((await detail(t, admin)).resolution).toMatchObject({
      status: 'running',
    });
    expect(await count(t)).toBe(1);

    // Pushing an unrelated branch doesn't start another attempt for the same commits.
    const other = await commitFiles(
      repo,
      'other',
      { 'x.txt': 'x\n' },
      'other',
      [conflicting]
    );
    repo.refs.delete('refs/heads/other');
    await push(t, token, 'other', '0'.repeat(40), other);
    expect(await count(t)).toBe(1);
  });

  it('does not redo a discarded resolution until a branch moves', async () => {
    const { t, admin, repo } = await conflictingPull();
    const id = (await detail(t, admin)).resolution!.id;
    await runResolution(t, id, () => ({
      files: { 'notes.txt': 'resolved\n' },
    }));
    await call(t, `/api/repos/octocat/app/pulls/1/resolutions/${id}/reject`, {
      cookie: admin,
      method: 'POST',
    });
    const token = await pat(t, admin);
    // A push that doesn't touch main or feature: nothing new.
    const tip = repo.refs.get('refs/heads/main')!;
    const side = await commitFiles(repo, 'side', { 'y.txt': 'y\n' }, 'side', [
      tip,
    ]);
    repo.refs.delete('refs/heads/side');
    await push(t, token, 'side', '0'.repeat(40), side);
    expect(await count(t)).toBe(1);

    // New commits on the PR branch: a fresh attempt.
    const head = repo.refs.get('refs/heads/feature')!;
    const next = await commitFiles(
      repo,
      'feature',
      { 'notes.txt': BASE.replace('three', 'three and three quarters') },
      'More detail'
    );
    repo.refs.set('refs/heads/feature', head);
    await push(t, token, 'feature', head, next);
    expect(await count(t)).toBe(2);
    expect((await detail(t, admin)).resolution?.status).toBe('running');
  });
});

describe('AI resolution needs no button', () => {
  /** A clean PR whose base then gains a conflicting commit without any push event. */
  async function silentlyConflicting() {
    const t = makeEnv({ actions: true });
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'internal' },
    });
    const repo = [...t.fake.repos.values()][0];
    const root = await commitFiles(repo, 'main', { 'notes.txt': BASE }, 'base');
    await commitFiles(
      repo,
      'feature',
      { 'notes.txt': BASE.replace('three', 'three, and a half') },
      'Elaborate',
      [root]
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Elaborate', base: 'main', head: 'feature' },
    });
    await settle(t);
    return { t, admin, repo };
  }

  const conflictOnMain = (
    repo: Awaited<ReturnType<typeof silentlyConflicting>>['repo']
  ) =>
    commitFiles(
      repo,
      'main',
      { 'notes.txt': BASE.replace('three', 'THREE') },
      'Shout'
    );

  it('starts when a PR with missed conflicts is viewed', async () => {
    const { t, admin, repo } = await silentlyConflicting();
    await conflictOnMain(repo); // e.g. landed before AI resolution existed
    const first = await detail(t, admin);
    expect(first.conflictsResolvable).toBe(true);
    await settle(t);
    expect((await detail(t, admin)).resolution).toMatchObject({
      status: 'running',
    });
    // Viewing again doesn't start a second attempt.
    await settle(t);
    const n = await t.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM merge_resolutions'
    ).first<{
      n: number;
    }>();
    expect(n?.n).toBe(1);
  });

  it('starts when a conflicting PR is reopened', async () => {
    const { t, admin, repo } = await silentlyConflicting();
    await call(t, '/api/repos/octocat/app/pulls/1', {
      cookie: admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    await conflictOnMain(repo);
    const res = await call(t, '/api/repos/octocat/app/pulls/1', {
      cookie: admin,
      method: 'PATCH',
      json: { state: 'open' },
    });
    expect(res.status).toBe(200);
    await settle(t);
    const n = await t.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM merge_resolutions WHERE status = 'running'"
    ).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('does not restart a failed attempt for the same commits on its own', async () => {
    const { t, admin } = await conflictingPull();
    const id = (await detail(t, admin)).resolution!.id;
    await runResolution(t, id, () => ({
      status: 'unanswered',
      reason: 'faulted',
    }));
    await detail(t, admin);
    await settle(t);
    expect((await detail(t, admin)).resolution).toMatchObject({
      id,
      status: 'failed',
    });
  });
});

describe('many open PRs while main moves', () => {
  async function pat(t: TestEnv, cookie: string) {
    const res = await call(t, '/api/tokens', {
      cookie,
      json: { name: 'cli', expiresInDays: 30 },
    });
    return ((await res.json()) as { plaintext: string }).plaintext;
  }

  /** Moves main to a new commit through the git proxy (so the push triggers fire). */
  async function pushToMain(
    t: TestEnv,
    token: string,
    repo: ReturnType<TestEnv['fake']['repos']['get']> & object,
    files: Record<string, string>,
    message: string
  ) {
    const old = repo.refs.get('refs/heads/main')!;
    const sha = await commitFiles(repo, 'main', files, message);
    repo.refs.set('refs/heads/main', old);
    const res = await handleGitRequest(
      new Request('http://test.local/octocat/app.git/git-receive-pack', {
        method: 'POST',
        headers: { Authorization: `Basic ${btoa(`u:${token}`)}` },
        body: concat([
          pktLine(`${old} ${sha} refs/heads/main\0report-status\n`),
          FLUSH,
          await buildPack([]),
        ]),
      }),
      t.env,
      t.ctx
    );
    expect(res.status).toBe(200);
    await settle(t);
    await runSweeps(t);
    return sha;
  }

  const resolutionStarts = (t: TestEnv) =>
    t.actions.resolutions.filter(
      (r) => (r.params as { resolutionId?: string }).resolutionId
    ).length;

  it('carries a resolution forward when main moves elsewhere, with no model call', async () => {
    const { t, admin, repo } = await conflictingPull();
    const id = (await detail(t, admin)).resolution!.id;
    await runResolution(t, id, () => ({
      files: { 'notes.txt': BASE.replace('three', 'THREE (main), and a half') },
      explanation: 'Kept both.',
    }));
    const startsBefore = resolutionStarts(t);

    const token = await pat(t, admin);
    const newMain = await pushToMain(
      t,
      token,
      repo,
      {
        'notes.txt': BASE.replace('three', 'THREE (main)'),
        'other.txt': 'unrelated\n',
      },
      'Unrelated change'
    );
    const d = await detail(t, admin);
    expect(d).toMatchObject({ resolvedByAi: true, mergeable: true });
    expect(d.resolution).toMatchObject({
      status: 'proposed',
      explanation: 'Kept both.',
    });
    expect(d.resolution!.id).not.toBe(id);
    expect(resolutionStarts(t)).toBe(startsBefore); // reused, not recomputed
    const proposed = repo.parseCommit(d.resolution!.resultSha!)!;
    expect(proposed.parents).toEqual([newMain]);

    const merge = await call(t, '/api/repos/octocat/app/pulls/1/merge', {
      cookie: admin,
      json: {},
    });
    expect(merge.status).toBe(200);
  });

  it('starts a fresh attempt, superseding the running one, when main changes the conflicted file', async () => {
    const { t, admin, repo } = await conflictingPull();
    const first = (await detail(t, admin)).resolution!;
    expect(first.status).toBe('running');
    const token = await pat(t, admin);
    await pushToMain(
      t,
      token,
      repo,
      { 'notes.txt': BASE.replace('three', 'THREE!!! (main again)') },
      'Change line three again'
    );
    const d = await detail(t, admin);
    expect(d.resolution!.id).not.toBe(first.id);
    expect(d.resolution!.status).toBe('running');
    expect(t.actions.terminatedResolutions).toContain(first.id);
    const old = await t.env.DB.prepare(
      'SELECT status, error_message FROM merge_resolutions WHERE id = ?'
    )
      .bind(first.id)
      .first<{ status: string; error_message: string }>();
    expect(old).toEqual({
      status: 'failed',
      error_message: 'Superseded by newer commits.',
    });
  });

  it('runs at most five at once per repository and starts queued ones as slots free up', async () => {
    const t = makeEnv({ actions: true });
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'internal' },
    });
    const repo = [...t.fake.repos.values()][0];
    const root = await commitFiles(repo, 'main', { 'notes.txt': BASE }, 'base');
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': BASE.replace('three', 'THREE') },
      'main'
    );
    for (let i = 1; i <= 6; i++) {
      await commitFiles(
        repo,
        `f${i}`,
        { 'notes.txt': BASE.replace('three', `three (${i})`) },
        `feature ${i}`,
        [root]
      );
      await call(t, '/api/repos/octocat/app/pulls', {
        cookie: admin,
        json: { title: `PR ${i}`, base: 'main', head: `f${i}` },
      });
      await settle(t);
    }
    const statuses = async () =>
      (
        await t.env.DB.prepare(
          'SELECT status, COUNT(*) AS n FROM merge_resolutions GROUP BY status ORDER BY status'
        ).all<{ status: string; n: number }>()
      ).results;
    expect(await statuses()).toEqual([
      { status: 'queued', n: 1 },
      { status: 'running', n: 5 },
    ]);

    // One finishes: the queued one takes its slot.
    const running = await t.env.DB.prepare(
      "SELECT id FROM merge_resolutions WHERE status = 'running' ORDER BY created_at LIMIT 1"
    ).first<{ id: string }>();
    await runResolution(t, running!.id, () => ({
      files: { 'notes.txt': 'resolved\n' },
    }));
    expect(await statuses()).toEqual([
      { status: 'proposed', n: 1 },
      { status: 'running', n: 5 },
    ]);
  });
});
