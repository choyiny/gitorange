import { describe, expect, it } from 'vitest';
import { addMember, bootstrapAdmin, call, makeEnv } from './helpers/app';
import {
  branchMatches,
  invalidProtectedPatterns,
  normalizeProtectedPatterns,
  protectedBy,
} from '../lib/protected-branches';

describe('protected branch patterns', () => {
  it('matches exact names only exactly', () => {
    expect(branchMatches('develop', 'develop')).toBe(true);
    expect(branchMatches('develop', 'develop2')).toBe(false);
    expect(branchMatches('develop', 'feature/develop')).toBe(false);
    expect(branchMatches('release/1.2', 'release/1x2')).toBe(false);
  });

  it('* matches within one path segment', () => {
    expect(branchMatches('release/*', 'release/1.2')).toBe(true);
    expect(branchMatches('release/*', 'release/')).toBe(true);
    expect(branchMatches('release/*', 'release/1/hotfix')).toBe(false);
    expect(branchMatches('release/*', 'release')).toBe(false);
    expect(branchMatches('*', 'main')).toBe(true);
    expect(branchMatches('*', 'feature/x')).toBe(false);
    expect(branchMatches('v*-lts', 'v2-lts')).toBe(true);
    expect(branchMatches('v*-lts', 'v2/x-lts')).toBe(false);
    expect(branchMatches('*/stable', 'team/stable')).toBe(true);
  });

  it('** matches across segments', () => {
    expect(branchMatches('hotfix/**', 'hotfix/a')).toBe(true);
    expect(branchMatches('hotfix/**', 'hotfix/a/b/c')).toBe(true);
    expect(branchMatches('hotfix/**', 'hotfixes/a')).toBe(false);
    expect(branchMatches('**/stable', 'stable')).toBe(true);
    expect(branchMatches('**/stable', 'a/b/stable')).toBe(true);
    expect(branchMatches('**/stable', 'a/unstable')).toBe(false);
    expect(branchMatches('a/**/z', 'a/z')).toBe(true);
    expect(branchMatches('a/**/z', 'a/b/c/z')).toBe(true);
    expect(branchMatches('**', 'any/thing')).toBe(true);
  });

  it('treats regular expression characters literally', () => {
    expect(branchMatches('v1.0', 'v1x0')).toBe(false);
    expect(branchMatches('v1.0+(x)', 'v1.0+(x)')).toBe(true);
    expect(branchMatches('rel.*', 'rel.5')).toBe(true);
    expect(branchMatches('rel.*', 'relx5')).toBe(false);
  });

  it('finds the first pattern a branch matches', () => {
    expect(protectedBy(['develop', 'release/*'], 'release/9')).toBe(
      'release/*'
    );
    expect(protectedBy(['develop'], 'feature')).toBeNull();
    expect(protectedBy(null, 'develop')).toBeNull();
  });

  it('validates and normalizes a list', () => {
    expect(invalidProtectedPatterns(['release/*', 'develop'])).toBeNull();
    expect(invalidProtectedPatterns([''])).toMatch(/empty/);
    expect(invalidProtectedPatterns(['a b'])).toMatch(/whitespace/);
    expect(invalidProtectedPatterns(['x'.repeat(101)])).toMatch(/100/);
    expect(
      invalidProtectedPatterns(Array.from({ length: 51 }, (_, i) => `b${i}`))
    ).toMatch(/50/);
    expect(normalizeProtectedPatterns(['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(normalizeProtectedPatterns([])).toBeNull();
  });
});

async function withRepo() {
  const t = makeEnv();
  const admin = await bootstrapAdmin(t);
  const res = await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', addReadme: true, visibility: 'internal' },
  });
  expect(res.status).toBe(201);
  return { t, admin };
}

const patch = (
  t: Awaited<ReturnType<typeof withRepo>>['t'],
  cookie: string,
  json: unknown
) => call(t, '/api/repos/octocat/app', { cookie, method: 'PATCH', json });

describe('protected branches in repository settings', () => {
  it('starts empty, and a repository admin sets, replaces and clears the list', async () => {
    const { t, admin } = await withRepo();
    const repo = async () =>
      (await (
        await call(t, '/api/repos/octocat/app', { cookie: admin })
      ).json()) as {
        protectedBranches: string[];
      };
    expect((await repo()).protectedBranches).toEqual([]);
    const set = await patch(t, admin, {
      protectedBranches: ['release/*', ' develop ', 'release/*'],
    });
    expect(set.status).toBe(200);
    expect(
      ((await set.json()) as { protectedBranches: string[] }).protectedBranches
    ).toEqual(['release/*', 'develop']);
    expect((await repo()).protectedBranches).toEqual(['release/*', 'develop']);
    // Other settings leave it alone.
    await patch(t, admin, { description: 'demo' });
    expect((await repo()).protectedBranches).toEqual(['release/*', 'develop']);
    await patch(t, admin, { protectedBranches: ['hotfix/**'] });
    expect((await repo()).protectedBranches).toEqual(['hotfix/**']);
    await patch(t, admin, { protectedBranches: [] });
    expect((await repo()).protectedBranches).toEqual([]);
    const row = await t.env.DB.prepare(
      "SELECT protected_branches AS p FROM repositories WHERE name = 'app'"
    ).first<{ p: string | null }>();
    expect(row!.p).toBeNull();
    await patch(t, admin, { protectedBranches: ['develop'] });
    await patch(t, admin, { protectedBranches: null });
    expect((await repo()).protectedBranches).toEqual([]);
  });

  it('is for repository admins only', async () => {
    const { t, admin } = await withRepo();
    const ada = await addMember(t, admin, 'ada');
    const res = await patch(t, ada, { protectedBranches: ['develop'] });
    expect(res.status).toBe(403);
    // A collaborator can push and merge, but not change settings.
    await call(t, '/api/repos/octocat/app/collaborators/ada', {
      cookie: admin,
      method: 'PUT',
    });
    expect(
      (await patch(t, ada, { protectedBranches: ['develop'] })).status
    ).toBe(403);
  });

  it('rejects invalid patterns and keeps the old list', async () => {
    const { t, admin } = await withRepo();
    await patch(t, admin, { protectedBranches: ['develop'] });
    for (const protectedBranches of [
      [''],
      ['release x'],
      ['x'.repeat(101)],
      Array.from({ length: 51 }, (_, i) => `b${i}`),
    ]) {
      const res = await patch(t, admin, { protectedBranches });
      expect(res.status).toBe(400);
    }
    const res = await call(t, '/api/repos/octocat/app', { cookie: admin });
    expect(
      ((await res.json()) as { protectedBranches: string[] }).protectedBranches
    ).toEqual(['develop']);
  });
});
