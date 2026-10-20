import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { repositories } from '../db/app.schema';
import { gitFor } from '../lib/repos';
import {
  cutRelease,
  getRelease,
  listReleases,
  releasedIn,
  unreleased,
} from '../lib/releases';
import { call } from './helpers/app';
import { crewRepo, FILES, type CrewRepo } from './helpers/crew';
import { commitPaths } from './helpers/seed';

const ORIGIN = 'https://git.test';
const NAME = 'octocat/app';

const repoRow = async (s: CrewRepo) =>
  (await s.db
    .select()
    .from(repositories)
    .where(eq(repositories.id, s.repoId))
    .get())!;

const head = (s: CrewRepo, branch = 'main') =>
  s.repo.refs.get(`refs/heads/${branch}`)!;

let at = 1_760_000_000_000;

/** A pull request landed on `base` (default main), with its bump. */
async function landed(
  s: CrewRepo,
  n: number,
  bump: 'major' | 'minor' | 'patch' | null,
  opts: { title?: string; base?: string } = {}
) {
  await s.mergedRow(n, `topic-${n}`, (at += 60_000), {
    title: opts.title ?? `Change ${n}`,
    base: opts.base,
  });
  await s.t.env.DB.prepare(
    'UPDATE pull_requests SET version_bump = ? WHERE repository_id = ? AND number = ?'
  )
    .bind(bump, s.repoId, n)
    .run();
}

async function pending(s: CrewRepo) {
  return unreleased(s.db, await repoRow(s), ORIGIN, NAME);
}

async function cut(
  s: CrewRepo,
  opts: { version?: string; headSha?: string; title?: string } = {}
) {
  const admin = await s.t.env.DB.prepare(
    "SELECT id FROM users WHERE username = 'octocat'"
  ).first<{ id: string }>();
  return cutRelease({
    env: s.t.env,
    db: s.db,
    repo: await repoRow(s),
    repoFullName: NAME,
    origin: ORIGIN,
    actor: { id: admin!.id },
    headSha: opts.headSha ?? head(s),
    version: opts.version,
    title: opts.title,
  });
}

async function releaseRows(s: CrewRepo) {
  return (
    await s.t.env.DB.prepare(
      'SELECT tag FROM releases WHERE repository_id = ? ORDER BY tag'
    )
      .bind(s.repoId)
      .all<{ tag: string }>()
  ).results.map((r) => r.tag);
}

describe('unreleased changes', () => {
  it('unreleased lists merged PRs into the default branch, with bumps', async () => {
    const s = await crewRepo();
    await landed(s, 1, 'minor', { title: 'Add search' });
    await landed(s, 2, null, { title: 'Fix typo' });
    const u = await pending(s);
    expect(u.pulls).toEqual([
      expect.objectContaining({
        number: 1,
        title: 'Add search',
        author: 'octocat',
        bump: 'minor',
      }),
      expect.objectContaining({
        number: 2,
        title: 'Fix typo',
        author: 'octocat',
        bump: null,
      }),
    ]);
    expect(typeof u.pulls[0].mergedAt).toBe('number');
    expect(u.latest).toBeNull();
  });

  it('a PR into another branch is not unreleased', async () => {
    const s = await crewRepo();
    await landed(s, 1, 'minor');
    await landed(s, 2, 'major', { base: 'feature/stack' });
    expect((await pending(s)).pulls.map((p) => p.number)).toEqual([1]);
  });

  it('renaming the default branch', async () => {
    const s = await crewRepo();
    await landed(s, 1, 'minor');
    await commitPaths(s.repo, 'trunk', FILES, 'trunk');
    await s.setRepo('default_branch', 'trunk');
    expect((await pending(s)).pulls).toEqual([]);
    await landed(s, 2, 'patch', { base: 'trunk' });
    expect((await pending(s)).pulls.map((p) => p.number)).toEqual([2]);
  });
});

describe('cutting a release', () => {
  it('first release must be typed', async () => {
    const s = await crewRepo();
    await landed(s, 1, 'minor');
    const u = await pending(s);
    expect(u.next).toBeNull();
    expect(u.notesPreview).toBe('First release.');
    expect(await cut(s)).toEqual({
      ok: false,
      status: 400,
      message: 'The first release needs a version, for example v0.1.0',
    });
    expect(await releaseRows(s)).toEqual([]);
  });

  it('first release records everything without listing it', async () => {
    const s = await crewRepo();
    await landed(s, 1, 'minor');
    await landed(s, 2, null);
    const r = await cut(s, { version: 'v0.1.0' });
    if (!r.ok) throw new Error(r.message);
    expect(r.release.tag).toBe('v0.1.0');
    expect(r.release.title).toBe('v0.1.0');
    expect(r.release.notes).toBe('First release.');
    expect(r.release.commitSha).toBe(head(s));
    expect(r.release.createdBy).toBe('octocat');
    expect(r.release.pulls).toEqual([]);
    const recorded = await s.t.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM release_pulls'
    ).first<{ n: number }>();
    expect(recorded!.n).toBe(2);
    const u = await pending(s);
    expect(u.pulls).toEqual([]);
    expect(u.next).toBeNull();
    expect(u.latest?.tag).toBe('v0.1.0');
    expect(s.repo.refs.get('refs/tags/v0.1.0')).toBe(head(s));
    const audit = await s.t.env.DB.prepare(
      "SELECT target FROM audit_events WHERE action = 'release.created'"
    ).all<{ target: string }>();
    expect(audit.results).toEqual([{ target: 'v0.1.0' }]);
  });

  it('next version takes the largest bump', async () => {
    const s = await crewRepo();
    await landed(s, 1, 'major');
    expect((await cut(s, { version: 'v0.1.0' })).ok).toBe(true);
    await commitPaths(s.repo, 'main', { ...FILES, 'b.txt': 'b' }, 'more');
    await landed(s, 2, 'patch', { title: 'Fix the footer' });
    await landed(s, 3, 'minor', { title: 'Add search' });
    const u = await pending(s);
    expect(u.next).toBe('v0.2.0');
    expect(u.notesPreview).toContain('### Minor');
    const r = await cut(s);
    if (!r.ok) throw new Error(r.message);
    expect(r.release.tag).toBe('v0.2.0');
    expect(s.repo.refs.get('refs/tags/v0.2.0')).toBe(head(s));
    expect(r.release.notes).toBe(
      [
        '### Minor',
        '',
        '- Add search (#3) @octocat',
        '',
        '### Patch',
        '',
        '- Fix the footer (#2) @octocat',
        '',
        `Full changes: ${ORIGIN}/${NAME}/compare/v0.1.0...v0.2.0`,
      ].join('\n')
    );
    expect(r.release.pulls).toEqual([
      { number: 2, title: 'Fix the footer', bump: 'patch' },
      { number: 3, title: 'Add search', bump: 'minor' },
    ]);
    // The preview is what the cut writes.
    expect(r.release.notes).toBe(u.notesPreview);
  });

  it('missing bump counts as patch', async () => {
    const s = await crewRepo();
    await landed(s, 1, null);
    expect((await cut(s, { version: 'v0.2.0' })).ok).toBe(true);
    await landed(s, 2, null);
    await landed(s, 3, null);
    expect((await pending(s)).next).toBe('v0.2.1');
    const r = await cut(s);
    expect(r.ok && r.release.tag).toBe('v0.2.1');
  });

  it('override must be greater and free', async () => {
    const s = await crewRepo();
    await landed(s, 1, null);
    expect((await cut(s, { version: 'v0.2.0' })).ok).toBe(true);
    await landed(s, 2, null);
    expect(await cut(s, { version: 'v0.1.0' })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await cut(s, { version: 'v0.2.0' })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await cut(s, { version: '1.0.0' })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await cut(s, { version: 'v1.0.0-rc.1' })).toMatchObject({
      ok: false,
      status: 400,
    });
    const r = await cut(s, { version: 'v1.0.0' });
    expect(r.ok && r.release.tag).toBe('v1.0.0');
  });

  it('a hand-pushed tag blocks the computed version', async () => {
    const s = await crewRepo();
    await landed(s, 1, null);
    expect((await cut(s, { version: 'v0.2.9' })).ok).toBe(true);
    const old = head(s);
    await commitPaths(s.repo, 'main', { ...FILES, 'b.txt': 'b' }, 'more');
    // Pushed by hand at an older commit: not a release, and never moved.
    s.repo.refs.set('refs/tags/v0.3.0', old);
    await landed(s, 2, 'minor');
    expect((await pending(s)).next).toBe('v0.3.0');
    expect(await cut(s)).toEqual({
      ok: false,
      status: 409,
      message: 'Tag v0.3.0 already exists; type a version',
    });
    expect(s.repo.refs.get('refs/tags/v0.3.0')).toBe(old);
    // Typed, the same version is refused for the same reason; another one goes through.
    expect(await cut(s, { version: 'v0.3.0' })).toMatchObject({
      ok: false,
      status: 409,
    });
    const r = await cut(s, { version: 'v0.3.1' });
    expect(r.ok && r.release.tag).toBe('v0.3.1');
    // The hand-pushed tag never counts as the latest release.
    expect(
      (await listReleases(s.db, await repoRow(s))).map((x) => x.tag)
    ).toEqual(['v0.3.1', 'v0.2.9']);
  });

  it('a moved default branch is 409 with the new head', async () => {
    const s = await crewRepo();
    await landed(s, 1, null);
    const seen = head(s);
    const moved = await commitPaths(
      s.repo,
      'main',
      { ...FILES, 'b.txt': 'b' },
      'more'
    );
    expect(await cut(s, { version: 'v0.1.0', headSha: seen })).toEqual({
      ok: false,
      status: 409,
      message: expect.stringContaining(moved),
      head: moved,
    });
    expect(s.repo.refs.get('refs/tags/v0.1.0')).toBeUndefined();
  });

  it('nothing to release is 409', async () => {
    const s = await crewRepo();
    expect(await cut(s, { version: 'v0.1.0' })).toEqual({
      ok: false,
      status: 409,
      message: 'Nothing to release',
    });
    await landed(s, 1, null);
    expect((await cut(s, { version: 'v0.1.0' })).ok).toBe(true);
    expect(await cut(s)).toEqual({
      ok: false,
      status: 409,
      message: 'Nothing to release',
    });
    expect(s.repo.refs.get('refs/tags/v0.1.1')).toBeUndefined();
  });

  it('concurrent cuts', async () => {
    const s = await crewRepo();
    await landed(s, 1, null);
    const results = await Promise.all([
      cut(s, { version: 'v0.1.0' }),
      cut(s, { version: 'v0.1.0' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      expect.objectContaining({ ok: false, status: 409 }),
    ]);
    expect(await releaseRows(s)).toEqual(['v0.1.0']);
    expect(s.repo.refs.get('refs/tags/v0.1.0')).toBe(head(s));
  });

  it('retry after a half-finished cut', async () => {
    const s = await crewRepo();
    await landed(s, 1, null);
    // The tag went out but the row did not.
    await gitFor(s.t.env, await repoRow(s)).createRef(
      'refs/tags/v0.1.0',
      head(s)
    );
    const r = await cut(s, { version: 'v0.1.0' });
    expect(r.ok && r.release.tag).toBe('v0.1.0');
    expect(await releaseRows(s)).toEqual(['v0.1.0']);
  });

  it('the tag queues push runs', async () => {
    const s = await crewRepo({ actions: true });
    await commitPaths(
      s.repo,
      'main',
      {
        ...FILES,
        '.github/workflows/release.yml': `name: Release
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo publish
`,
      },
      'Add the release workflow'
    );
    await landed(s, 1, null);
    expect((await cut(s, { version: 'v0.1.0' })).ok).toBe(true);
    const runs = await s.t.env.DB.prepare(
      'SELECT ref, head_sha FROM workflow_runs'
    ).all<{ ref: string; head_sha: string }>();
    expect(runs.results).toEqual([
      { ref: 'refs/tags/v0.1.0', head_sha: head(s) },
    ]);
  });

  it('contents freeze', async () => {
    const s = await crewRepo();
    await landed(s, 1, null);
    expect((await cut(s, { version: 'v0.1.0' })).ok).toBe(true);
    await landed(s, 2, 'minor', { title: 'Add search' });
    const second = await cut(s);
    if (!second.ok) throw new Error(second.message);
    await landed(s, 3, 'major');
    const repo = await repoRow(s);
    const v020 = await getRelease(s.db, repo, 'v0.2.0');
    expect(v020?.pulls).toEqual([
      { number: 2, title: 'Add search', bump: 'minor' },
    ]);
    expect(await getRelease(s.db, repo, 'v9.9.9')).toBeNull();
    expect(await releasedIn(s.db, `${s.repoId}-m1`)).toBe('v0.1.0');
    expect(await releasedIn(s.db, `${s.repoId}-m2`)).toBe('v0.2.0');
    expect(await releasedIn(s.db, `${s.repoId}-m3`)).toBeNull();
    // Pull request responses carry it: the page and the list (one lookup for the whole list).
    const pull = (await (
      await call(s.t, '/api/repos/octocat/app/pulls/2', { cookie: s.admin })
    ).json()) as { pull: { releasedIn: string | null } };
    expect(pull.pull.releasedIn).toBe('v0.2.0');
    const list = (await (
      await call(s.t, '/api/repos/octocat/app/pulls?state=merged', {
        cookie: s.admin,
      })
    ).json()) as { pulls: { number: number; releasedIn: string | null }[] };
    expect(
      Object.fromEntries(list.pulls.map((p) => [p.number, p.releasedIn]))
    ).toEqual({ 1: 'v0.1.0', 2: 'v0.2.0', 3: null });
  });

  it('tags lists every tag, hand-pushed too', async () => {
    const s = await crewRepo();
    await landed(s, 1, null);
    expect((await cut(s, { version: 'v0.1.0' })).ok).toBe(true);
    s.repo.refs.set('refs/tags/build-7', s.main);
    s.repo.refs.set('refs/tags/v0.0.9', s.main);
    const tags = await gitFor(s.t.env, await repoRow(s)).tags();
    expect(tags).toEqual([
      { name: 'v0.1.0', sha: head(s) },
      { name: 'v0.0.9', sha: s.main },
      { name: 'build-7', sha: s.main },
    ]);
  });
});
