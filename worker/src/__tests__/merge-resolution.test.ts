import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import {
  executeResolution,
  MAX_CONCURRENT_PER_REPO,
  resolutionRef,
  startNext,
  type StepRunner,
} from '../merge/resolution';
import type { ResolveRequest, ResolveResult } from '../merge/resolver';
import {
  ensureResolution,
  executeSweep,
  type SweepParams,
} from '../merge/auto';
import { findRepoById, gitFor } from '../lib/repos';
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
  resolve: (
    req: ResolveRequest
  ) => Partial<ResolveResult> | Promise<Partial<ResolveResult>>,
  /** `steps` records step names (sleeps as `sleep:<name>`). */
  opts: { steps?: string[] } = {}
) {
  const requests: ResolveRequest[] = [];
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      opts.steps?.push(name);
      return ((b ?? a) as () => Promise<unknown>)();
    },
    sleep: async (name: string) => void opts.steps?.push(`sleep:${name}`),
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
            ...(await resolve(req)),
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
    sleep: async () => {},
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
      transcript: JSON.stringify([
        { role: 'user', content: 'Resolve' },
        {
          role: 'assistant',
          usage: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 0 },
        },
        { role: 'toolResult', content: 'ok' },
        {
          role: 'assistant',
          usage: { input: 300, output: 50, cacheRead: 0, cacheWrite: 0 },
        },
      ]),
    }));

    // Usage & cost: the conversation's tokens, attributed to the PR and repository.
    const usage = await t.env.DB.prepare('SELECT * FROM ai_usage').all<
      Record<string, unknown>
    >();
    expect(usage.results).toHaveLength(1);
    expect(usage.results[0]).toMatchObject({
      id: `merge-resolution:${id}`,
      feature: 'merge-resolution',
      merge_resolution_id: id,
      requests: 2,
      tokens_in: 1800,
      tokens_out: 250,
      tokens_cached: 500,
    });
    expect(usage.results[0].repository_id).toBeTruthy();
    expect(usage.results[0].pull_request_id).toBeTruthy();

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

    // The resolution makes the PR mergeable, and a plain merge lands it.
    expect(d).toMatchObject({ mergeable: true, resolvedByAi: true });
    const merge = await call(t, '/api/repos/octocat/app/pulls/1/merge', {
      cookie: admin,
      json: { approve: true },
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
    // The resolver checks for markers in onYield; leftovers are rejected here.
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
      json: { resolutionId: id, approve: true },
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
    await conflictOnMain(repo);
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
      json: { approve: true },
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

describe('faster AI conflict resolution', () => {
  const plainStep = {
    do: async (_name: string, a: unknown, b?: unknown) =>
      ((b ?? a) as () => Promise<unknown>)(),
    sleep: async () => {},
  } as unknown as StepRunner;

  /** The PR, its repository's git, and a db, to drive ensureResolution directly. */
  async function handles(t: TestEnv) {
    const db = drizzle(t.env.DB, { schema });
    const pr = (await db.query.pullRequests.findFirst())!;
    const found = (await findRepoById(db, pr.repositoryId))!;
    return { db, pr, git: gitFor(t.env, found.repo) };
  }

  const row = (t: TestEnv, id: string) =>
    t.env.DB.prepare(
      'SELECT status, error_message FROM merge_resolutions WHERE id = ?'
    )
      .bind(id)
      .first<{ status: string; error_message: string | null }>();

  const count = async (t: TestEnv) =>
    (
      await t.env.DB.prepare(
        'SELECT COUNT(*) AS n FROM merge_resolutions'
      ).first<{ n: number }>()
    )?.n ?? 0;

  const resolutionStarts = (t: TestEnv) =>
    t.actions.resolutions.filter(
      (r) => (r.params as { resolutionId?: string }).resolutionId
    );

  it('cancels an attempt as soon as its target moves, and gives its slot to a queued one', async () => {
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
    await commitFiles(
      repo,
      'release',
      { 'notes.txt': BASE.replace('three', 'THREE') },
      'release',
      [root]
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
        json: {
          title: `PR ${i}`,
          base: i === 1 ? 'release' : 'main',
          head: `f${i}`,
        },
      });
      await settle(t);
    }
    const byPr = async (n: number) =>
      (await t.env.DB.prepare(
        `SELECT m.id, m.status FROM merge_resolutions m
           JOIN pull_requests p ON p.id = m.pull_request_id WHERE p.number = ?`
      )
        .bind(n)
        .first<{ id: string; status: string }>())!;
    const first = await byPr(1);
    const queued = await byPr(6);
    expect(first.status).toBe('running');
    expect(queued.status).toBe('queued');

    // release takes PR 1's line: its conflict is gone, so no new attempt starts for it.
    await commitFiles(
      repo,
      'release',
      { 'notes.txt': BASE.replace('three', 'three (1)') },
      'Take #1'
    );
    const repositoryId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{ id: string }>())!.id;
    await executeSweep(
      { env: t.env, db: drizzle(t.env.DB, { schema }), step: plainStep },
      { repositoryId, branches: ['release'] }
    );

    expect(t.actions.terminatedResolutions).toContain(first.id);
    expect(await row(t, first.id)).toEqual({
      status: 'failed',
      error_message: 'Superseded by newer commits.',
    });
    expect((await byPr(6)).status).toBe('running');
    expect(resolutionStarts(t).map((r) => r.id)).toContain(queued.id);
  });

  it('stops without calling the model when the commits moved before it ran', async () => {
    const { t, admin, repo } = await conflictingPull();
    const id = (await detail(t, admin)).resolution!.id;
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': BASE.replace('three', 'THREE!!! (main again)') },
      'Change line three again'
    );
    const requests = await runResolution(t, id, () => ({
      files: { 'notes.txt': 'resolved\n' },
    }));
    expect(requests).toHaveLength(0);
    expect(await row(t, id)).toEqual({
      status: 'failed',
      error_message: 'Superseded by newer commits.',
    });
  });

  it('starts one attempt when two triggers race for the same commits', async () => {
    const t = makeEnv({ actions: true });
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'internal' },
    });
    const repo = [...t.fake.repos.values()][0];
    const root = await commitFiles(repo, 'main', { 'notes.txt': BASE }, 'base');
    const head = await commitFiles(
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
    // main gains a conflicting commit without a push event.
    const base = await commitFiles(
      repo,
      'main',
      { 'notes.txt': BASE.replace('three', 'THREE') },
      'Shout'
    );
    const db = drizzle(t.env.DB, { schema });
    const pr = (await db.query.pullRequests.findFirst())!;
    const found = (await findRepoById(db, pr.repositoryId))!;
    const git = gitFor(t.env, found.repo);
    const started = await Promise.all([
      ensureResolution(t.env, db, git, pr, { base, head }),
      ensureResolution(t.env, db, git, pr, { base, head }),
    ]);
    expect(started.filter(Boolean)).toHaveLength(1);
    expect(await count(t)).toBe(1);
    expect(resolutionStarts(t)).toHaveLength(1);
  });

  it('reviews at once, then lets a burst of landings settle before one attempt', async () => {
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
    // Two landings in a row; each would start a sweep.
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': BASE.replace('three', 'THREE') },
      'First'
    );
    const tip = await commitFiles(
      repo,
      'main',
      { 'notes.txt': BASE.replace('three', 'THREE!') },
      'Second'
    );
    const repositoryId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{ id: string }>())!.id;
    const prId = (await t.env.DB.prepare('SELECT id FROM pull_requests').first<{
      id: string;
    }>())!.id;
    const stacks = () =>
      t.actions.resolutions.filter(
        (r) => (r.params as { stack?: unknown }).stack
      ).length;
    for (let i = 0; i < 2; i++) {
      const steps: string[] = [];
      const atSleep = { stacks: 0, attempts: 0 };
      const stacksBefore = stacks();
      const step = {
        do: async (name: string, a: unknown, b?: unknown) => {
          steps.push(name);
          return ((b ?? a) as () => Promise<unknown>)();
        },
        sleep: async (name: string) => {
          steps.push(`sleep:${name}`);
          atSleep.stacks = stacks() - stacksBefore;
          atSleep.attempts = await count(t);
        },
      } as unknown as StepRunner;
      await executeSweep(
        { env: t.env, db: drizzle(t.env.DB, { schema }), step },
        { repositoryId, branches: ['main'] }
      );
      // Review and stack discovery start at once; resolution waits for the burst to settle.
      expect(steps).toEqual([
        'repo',
        'targets',
        `pr:${prId}`,
        'sleep:settle',
        `resolve:${prId}`,
      ]);
      if (i === 0) expect(atSleep).toEqual({ stacks: 1, attempts: 0 });
    }
    const rows = await t.env.DB.prepare(
      'SELECT base_sha, status FROM merge_resolutions'
    ).all<{ base_sha: string; status: string }>();
    expect(rows.results).toEqual([{ base_sha: tip, status: 'running' }]);
    expect(resolutionStarts(t)).toHaveLength(1);
  });

  it('runs an attempt without waiting, and drops it if the commits move during the model run', async () => {
    const { t, admin, repo } = await conflictingPull();
    const id = (await detail(t, admin)).resolution!.id;
    const steps: string[] = [];
    const requests = await runResolution(
      t,
      id,
      async () => {
        await commitFiles(
          repo,
          'main',
          { 'notes.txt': BASE.replace('three', 'THREE, again') },
          'Another landing'
        );
        return { files: { 'notes.txt': 'resolved\n' } };
      },
      { steps }
    );
    expect(requests).toHaveLength(1);
    expect(steps.some((s) => s.startsWith('sleep:'))).toBe(false);
    expect(await row(t, id)).toEqual({
      status: 'failed',
      error_message: 'Superseded by newer commits.',
    });
    expect(repo.refs.has(resolutionRef(id))).toBe(false);
  });

  it('never cancels the current attempt on a caller holding old commits', async () => {
    const { t, repo } = await conflictingPull();
    const { db, pr, git } = await handles(t);
    const head = repo.refs.get('refs/heads/feature')!;
    const oldBase = repo.refs.get('refs/heads/main')!;
    const newBase = await commitFiles(
      repo,
      'main',
      { 'notes.txt': BASE.replace('three', 'THREE!!! (main again)') },
      'Change line three again'
    );
    expect(
      await ensureResolution(t.env, db, git, pr, { base: newBase, head })
    ).toBe(true);
    // A slow PR view resolved the refs before main moved.
    expect(
      await ensureResolution(t.env, db, git, pr, { base: oldBase, head })
    ).toBe(false);
    const running = await t.env.DB.prepare(
      "SELECT base_sha FROM merge_resolutions WHERE status = 'running'"
    ).all<{ base_sha: string }>();
    expect(running.results).toEqual([{ base_sha: newBase }]);
  });

  it('tries again when the target moves away and back (A, B, A)', async () => {
    const { t, repo } = await conflictingPull();
    const { db, pr, git } = await handles(t);
    const head = repo.refs.get('refs/heads/feature')!;
    const a = repo.refs.get('refs/heads/main')!;
    const b = await commitFiles(
      repo,
      'main',
      { 'notes.txt': BASE.replace('three', 'THREE!!! (main again)') },
      'B'
    );
    await ensureResolution(t.env, db, git, pr, { base: b, head });
    repo.refs.set('refs/heads/main', a); // B is reverted
    expect(await ensureResolution(t.env, db, git, pr, { base: a, head })).toBe(
      true
    );
    const running = await t.env.DB.prepare(
      "SELECT base_sha FROM merge_resolutions WHERE status = 'running'"
    ).all<{ base_sha: string }>();
    expect(running.results).toEqual([{ base_sha: a }]);
  });

  it('never runs more than the cap when two workers fill free slots at once', async () => {
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
    for (let i = 1; i <= MAX_CONCURRENT_PER_REPO + 3; i++) {
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
    // One slot frees up without anyone filling it yet.
    await t.env.DB.prepare(
      `UPDATE merge_resolutions SET status = 'failed' WHERE id =
         (SELECT id FROM merge_resolutions WHERE status = 'running' LIMIT 1)`
    ).run();
    const repositoryId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{ id: string }>())!.id;
    const db = drizzle(t.env.DB, { schema });
    await Promise.all([
      startNext(t.env, db, repositoryId),
      startNext(t.env, db, repositoryId),
      startNext(t.env, db, repositoryId),
    ]);
    const running = await t.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM merge_resolutions WHERE status = 'running'"
    ).first<{ n: number }>();
    expect(running?.n).toBe(MAX_CONCURRENT_PER_REPO);
  });

  it('starts a resolve someone asked for without waiting', async () => {
    const { t, admin } = await conflictingPull();
    await t.env.DB.prepare(
      "UPDATE merge_resolutions SET status = 'failed'"
    ).run();
    const { id } = (await (
      await call(t, '/api/repos/octocat/app/pulls/1/resolutions', {
        cookie: admin,
        method: 'POST',
      })
    ).json()) as { id: string };
    const steps: string[] = [];
    const requests = await runResolution(
      t,
      id,
      () => ({ files: { 'notes.txt': 'resolved\n' } }),
      { steps }
    );
    expect(requests).toHaveLength(1);
    expect(steps).not.toContain('sleep:settle');
  });

  /** main and feature both change line 3 of `path`; `.orangeignore` on main lists `generated/`. */
  async function conflictIn(path: string) {
    const t = makeEnv({ actions: true });
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'internal' },
    });
    const repo = [...t.fake.repos.values()][0];
    const ignore = { '.orangeignore': 'generated/\n' };
    const root = await commitFiles(
      repo,
      'main',
      { [path]: BASE, ...ignore },
      'base'
    );
    await commitFiles(
      repo,
      'main',
      { [path]: BASE.replace('three', 'THREE (main)'), ...ignore },
      'Shout line three'
    );
    await commitFiles(
      repo,
      'feature',
      { [path]: BASE.replace('three', 'three, and a half'), ...ignore },
      'Elaborate on three',
      [root]
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Elaborate', base: 'main', head: 'feature' },
    });
    await settle(t);
    return { t, admin };
  }

  for (const path of [
    'generated/api.ts',
    'yarn.lock',
    'migrations/meta/0008_snapshot.json',
  ])
    it(`leaves a conflict in a generated file (${path}) to a person`, async () => {
      const { t, admin } = await conflictIn(path);
      expect(await count(t)).toBe(0);
      expect(resolutionStarts(t)).toHaveLength(0);
      const d = await detail(t, admin);
      expect(d).toMatchObject({
        conflicts: [path],
        conflictsResolvable: false,
        resolution: null,
      });
      await settle(t); // the PR view's backstop doesn't start one either
      expect(await count(t)).toBe(0);
      const res = await call(t, '/api/repos/octocat/app/pulls/1/resolutions', {
        cookie: admin,
        method: 'POST',
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(path);
    });

  it('still resolves a normal text conflict next to an .orangeignore', async () => {
    const { t, admin } = await conflictIn('src/api.ts');
    expect(await count(t)).toBe(1);
    expect(resolutionStarts(t)).toHaveLength(1);
    expect((await detail(t, admin)).conflictsResolvable).toBe(true);
  });
});
