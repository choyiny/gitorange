import { describe, expect, it } from 'vitest';
import { call, type TestEnv } from './helpers/app';
import { commitFiles } from './helpers/seed';
import {
  divergedPull,
  fakeResolver,
  moved,
  NOTES,
  runRebases,
} from './helpers/rebase';

export async function listed(t: TestEnv, cookie: string, state = 'open') {
  const body = (await (
    await call(t, `/api/repos/octocat/app/pulls?state=${state}`, { cookie })
  ).json()) as { pulls: { number: number; aiResolution: string | null }[] };
  return Object.fromEntries(body.pulls.map((p) => [p.number, p.aiResolution]));
}

describe('pull request list: AI resolving a rebase conflict', () => {
  it("doesn't call a stop AI never attempted (model none) an AI resolution", async () => {
    const { t, admin, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    await runRebases(t); // no resolver: the run stops for the agent
    expect(await listed(t, admin)).toEqual({ 1: null });
  });

  it('shows a running resolution, then a failed one, on its PR only', async () => {
    const { t, admin, repo, root } = await divergedPull({ conflict: true });
    await commitFiles(
      repo,
      'clean',
      { 'notes.txt': NOTES, 'c.txt': 'c\n' },
      'Clean',
      [root]
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Clean', body: '', base: 'main', head: 'clean' },
    });
    await moved(t, 'main', root);
    let during: Record<string, string | null> = {};
    const { resolver } = fakeResolver(async () => {
      during = await listed(t, admin);
      return { status: 'unanswered', reason: 'gave up' };
    });
    await runRebases(t, { resolver });
    expect(during[1]).toBe('running');
    expect(await listed(t, admin)).toEqual({ 1: 'failed', 2: null });
  });

  it('ignores a row for tips the branches moved past, and leaves closed PRs out', async () => {
    const { t, admin, repo, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    await runRebases(t, {
      resolver: fakeResolver(() => ({ status: 'unanswered' })).resolver,
    });
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': NOTES.replace('three', 'THREE (main)'), 'z.txt': 'z\n' },
      'More'
    );
    expect(await listed(t, admin)).toEqual({ 1: null });
    await call(t, '/api/repos/octocat/app/pulls/1', {
      cookie: admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    expect(await listed(t, admin, 'closed')).toEqual({ 1: null });
  });
});
