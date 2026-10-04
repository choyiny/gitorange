import { describe, expect, it } from 'vitest';
import {
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
  type TestEnv,
} from './helpers/app';
import { commitFiles } from './helpers/seed';

const BASE = 'one\ntwo\nthree\nfour\nfive\n';

type ListedPull = { number: number; aiResolution: string | null };

/** main and feature both change line 3 of notes.txt; the PR opening queues a resolution. */
async function conflictingPull() {
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
    { 'notes.txt': BASE.replace('three', 'THREE (main)') },
    'Shout line three'
  );
  await commitFiles(
    repo,
    'feature',
    { 'notes.txt': BASE.replace('three', 'three, and a half') },
    'Elaborate on three',
    [root]
  );
  await commitFiles(repo, 'clean', { 'other.txt': 'x\n' }, 'Clean', [root]);
  for (const head of ['feature', 'clean'])
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: head, body: '', base: 'main', head },
    });
  await settle(t);
  return { t, admin, repo };
}

async function listed(t: TestEnv, cookie: string, state = 'open') {
  const body = (await (
    await call(t, `/api/repos/octocat/app/pulls?state=${state}`, { cookie })
  ).json()) as { pulls: ListedPull[] };
  return Object.fromEntries(body.pulls.map((p) => [p.number, p.aiResolution]));
}

async function setStatus(t: TestEnv, status: string, errorMessage?: string) {
  await t.env.DB.prepare(
    'UPDATE merge_resolutions SET status = ?, error_message = ?'
  )
    .bind(status, errorMessage ?? null)
    .run();
}

describe('pull request list: AI conflict resolution', () => {
  it('shows a running resolution on its PR only', async () => {
    const { t, admin } = await conflictingPull();
    expect(await listed(t, admin)).toEqual({ 1: 'running', 2: null });
  });

  it('reports queued, proposed, and failed attempts', async () => {
    const { t, admin } = await conflictingPull();
    await setStatus(t, 'queued');
    expect((await listed(t, admin))[1]).toBe('queued');
    await setStatus(t, 'proposed');
    expect((await listed(t, admin))[1]).toBe('proposed');
    await setStatus(t, 'failed', 'The model gave up.');
    expect((await listed(t, admin))[1]).toBe('failed');
    // A discarded resolution also leaves the conflicts to a person.
    await setStatus(t, 'rejected');
    expect((await listed(t, admin))[1]).toBe('failed');
  });

  it('uses only the latest attempt', async () => {
    const { t, admin } = await conflictingPull();
    const row = await t.env.DB.prepare('SELECT * FROM merge_resolutions').first<
      Record<string, unknown>
    >();
    await setStatus(t, 'failed', 'The model gave up.');
    // A retry in the same second as the failed attempt.
    await t.env.DB.prepare(
      `INSERT INTO merge_resolutions (id, pull_request_id, base_sha, head_sha, status, model,
         conflicted_paths, created_at) VALUES ('retry', ?, ?, ?, 'running', 'm', '[]', ?)`
    )
      .bind(row!.pull_request_id, row!.base_sha, row!.head_sha, row!.created_at)
      .run();
    expect((await listed(t, admin))[1]).toBe('running');
  });

  it('ignores an attempt for commits the branches moved past', async () => {
    const { t, admin, repo } = await conflictingPull();
    await setStatus(t, 'proposed');
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': BASE.replace('three', 'THREE (main)'), 'more.txt': 'x\n' },
      'Another change'
    );
    expect((await listed(t, admin))[1]).toBeNull();
  });

  it('leaves closed PRs out', async () => {
    const { t, admin } = await conflictingPull();
    await call(t, '/api/repos/octocat/app/pulls/1', {
      cookie: admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    expect(await listed(t, admin, 'closed')).toEqual({ 1: null });
  });
});
