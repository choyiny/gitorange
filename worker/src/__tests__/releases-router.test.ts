import { describe, expect, it } from 'vitest';
import { call } from './helpers/app';
import { addMember } from './helpers/app';
import { collaborator, crewRepo, FILES, type CrewRepo } from './helpers/crew';
import { commitPaths } from './helpers/seed';

const BASE = '/api/repos/octocat/app';
let at = 1_760_000_000_000;

async function landed(
  s: CrewRepo,
  n: number,
  bump: 'major' | 'minor' | 'patch' | null,
  title = `Change ${n}`
) {
  await s.mergedRow(n, `topic-${n}`, (at += 60_000), { title });
  await s.t.env.DB.prepare(
    'UPDATE pull_requests SET version_bump = ? WHERE repository_id = ? AND number = ?'
  )
    .bind(bump, s.repoId, n)
    .run();
}

const head = (s: CrewRepo) => s.repo.refs.get('refs/heads/main')!;

const post = (s: CrewRepo, cookie: string, json: unknown) =>
  call(s.t, `${BASE}/releases`, { cookie, json });

describe('releases routes', () => {
  it('lists unreleased changes, cuts, reads, lists and edits', async () => {
    const s = await crewRepo();
    await landed(s, 1, 'minor', 'Add search');

    const un = await call(s.t, `${BASE}/releases/unreleased`, {
      cookie: s.admin,
    });
    expect(un.status).toBe(200);
    expect(await un.json()).toMatchObject({
      pulls: [expect.objectContaining({ number: 1, bump: 'minor' })],
      latest: null,
      next: null,
      head: head(s),
      notesPreview: 'First release.',
    });

    const cutRes = await post(s, s.admin, {
      headSha: head(s),
      version: 'v0.1.0',
    });
    expect(cutRes.status).toBe(201);
    expect(await cutRes.json()).toMatchObject({
      tag: 'v0.1.0',
      commitSha: head(s),
      createdBy: 'octocat',
    });

    const one = await call(s.t, `${BASE}/releases/v0.1.0`, {
      cookie: s.admin,
    });
    expect(one.status).toBe(200);
    expect(((await one.json()) as { tag: string }).tag).toBe('v0.1.0');

    const list = await call(s.t, `${BASE}/releases`, { cookie: s.admin });
    expect(
      ((await list.json()) as { tag: string }[]).map((r) => r.tag)
    ).toEqual(['v0.1.0']);

    const patched = await call(s.t, `${BASE}/releases/v0.1.0`, {
      cookie: s.admin,
      method: 'PATCH',
      json: { title: 'Hello', notes: 'New notes' },
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      title: 'Hello',
      notes: 'New notes',
    });
    const audit = await s.t.env.DB.prepare(
      "SELECT target FROM audit_events WHERE action = 'release.updated'"
    ).all<{ target: string }>();
    expect(audit.results).toEqual([{ target: 'v0.1.0' }]);

    s.repo.refs.set('refs/tags/v9.9.9', head(s));
    const tags = await call(s.t, `${BASE}/tags`, { cookie: s.admin });
    expect(await tags.json()).toEqual([
      { name: 'v9.9.9', sha: head(s), release: null },
      { name: 'v0.1.0', sha: head(s), release: 'v0.1.0' },
    ]);
  });

  it('a moved default branch is a 409 carrying the new head', async () => {
    const s = await crewRepo();
    await landed(s, 1, 'patch');
    const stale = head(s);
    await commitPaths(s.repo, 'main', { ...FILES, 'b.txt': 'b' }, 'more');
    const res = await post(s, s.admin, { headSha: stale, version: 'v0.1.0' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ head: head(s) });
  });

  it('a first release without a version is a 400', async () => {
    const s = await crewRepo();
    await landed(s, 1, 'patch');
    const res = await post(s, s.admin, { headSha: head(s) });
    expect(res.status).toBe(400);
  });

  it('needs push access to cut or edit; reading works for any member', async () => {
    const s = await crewRepo();
    await landed(s, 1, 'patch');
    expect(
      (await post(s, s.admin, { headSha: head(s), version: 'v0.1.0' })).status
    ).toBe(201);
    const reader = await addMember(s.t, s.admin, 'reader');
    expect(
      (await post(s, reader, { headSha: head(s), version: 'v0.2.0' })).status
    ).toBe(403);
    const patch = await call(s.t, `${BASE}/releases/v0.1.0`, {
      cookie: reader,
      method: 'PATCH',
      json: { title: 'x' },
    });
    expect(patch.status).toBe(403);
    for (const path of [
      '/releases',
      '/releases/unreleased',
      '/releases/v0.1.0',
      '/tags',
    ])
      expect(
        (await call(s.t, `${BASE}${path}`, { cookie: reader })).status
      ).toBe(200);
    const pusher = await collaborator(s, 'pusher');
    expect(
      (
        await call(s.t, `${BASE}/releases/v0.1.0`, {
          cookie: pusher,
          method: 'PATCH',
          json: { title: 'By a pusher' },
        })
      ).status
    ).toBe(200);
  });

  it('an unknown tag is a 404, and releases cannot be deleted', async () => {
    const s = await crewRepo();
    expect(
      (await call(s.t, `${BASE}/releases/v1.0.0`, { cookie: s.admin })).status
    ).toBe(404);
    expect(
      (
        await call(s.t, `${BASE}/releases/v1.0.0`, {
          cookie: s.admin,
          method: 'PATCH',
          json: { title: 'x' },
        })
      ).status
    ).toBe(404);
    expect(
      (
        await call(s.t, `${BASE}/releases/v0.1.0`, {
          cookie: s.admin,
          method: 'DELETE',
        })
      ).status
    ).toBe(404);
  });
});
