import { describe, expect, it } from 'vitest';
import { addMember, call, settle, type TestEnv } from './helpers/app';
import { commitFiles } from './helpers/seed';
import {
  detail,
  divergedPull,
  fakeResolver,
  moved,
  NOTES,
  rows,
  runRebases,
} from './helpers/rebase';
import { connect, tool } from './helpers/mcp';
import { MODEL_UNREACHABLE } from '../merge/commit-resolution';
import type { ConflictResolverApi } from '../merge/resolver';
import { RESOLVED_TRAILER } from '../git/rebase';

const RESOLVED = NOTES.replace('three', 'THREE (main), and a half');

const unreachable = (ids: string[]) => (id: string) =>
  ({
    resolve: async () => {
      ids.push(id);
      throw new Error('AI down');
    },
  }) as ConflictResolverApi;

const retry = (t: TestEnv, cookie: string, n = 1) =>
  call(t, `/api/repos/octocat/app/pulls/${n}/rebase`, {
    cookie,
    method: 'POST',
  });

/** PR #1 whose rebase stopped at its conflicting commit because the model couldn't be reached. */
async function stoppedPull() {
  const p = await divergedPull({ conflict: true });
  await moved(p.t, 'main', p.root);
  const failedIds: string[] = [];
  await runRebases(p.t, { resolver: unreachable(failedIds) });
  return { ...p, failedIds };
}

const queuedRebases = (t: TestEnv) =>
  t.actions.resolutions.filter((r) => (r.params as { rebase?: unknown }).rebase)
    .length;

describe('trying a stopped rebase again', () => {
  it('asks AI again about the commit it failed on, and writes the rebase', async () => {
    const { t, admin, repo, f2, failedIds } = await stoppedPull();
    expect(repo.refs.get('refs/heads/feature')).toBe(f2);
    const before = await detail(t, admin);
    expect(before.rebase!.status).toBe('conflict');
    expect(before.pullState!.reasons).toContainEqual({
      kind: 'rebase_conflict',
      commit: f2,
      files: ['notes.txt'],
      error: MODEL_UNREACHABLE,
    });
    const queued = queuedRebases(t);

    const res = await retry(t, admin);
    expect(res.status).toBe(200);
    // The stop is set aside: the pull request is behind again, and a rebase run is queued.
    expect(await res.json()).toMatchObject({ status: 'behind', onto: 'main' });
    await settle(t);
    expect(queuedRebases(t)).toBe(queued + 1);
    const mid = await detail(t, admin);
    expect(mid.rebase!.status).toBe('behind');
    expect(
      mid.pullState!.reasons.some((r) => r.kind === 'rebase_conflict')
    ).toBe(false);
    expect((await rows(t)).map((r) => [r.commit, r.status])).toEqual([
      [f2, 'rejected'],
    ]);

    const { resolver, requests } = fakeResolver(() => ({
      files: { 'notes.txt': RESOLVED },
    }));
    await runRebases(t, { resolver });
    // AI was asked again, through a resolver of its own (not the failed attempt's).
    expect(requests).toHaveLength(1);
    expect(requests[0].id).not.toBe(failedIds[0]);
    expect(requests[0].id.startsWith(`${(await rows(t))[0].id}:`)).toBe(true);
    const head = repo.refs.get('refs/heads/feature')!;
    expect(head).not.toBe(f2);
    expect(repo.parseCommit(head)!.message).toBe(
      `Elaborate on three\n\n${RESOLVED_TRAILER}`
    );
    expect((await rows(t)).map((r) => [r.commit, r.status, r.error])).toEqual([
      [f2, 'applied', null],
    ]);
    const after = await detail(t, admin);
    expect(after.rebase!.status).toBe('up_to_date');
    expect(
      after.pullState?.reasons.some((r) => r.kind === 'rebase_conflict') ??
        false
    ).toBe(false);
  });

  it('shows the stop again when the retry fails too', async () => {
    const { t, admin, f2 } = await stoppedPull();
    expect((await retry(t, admin)).status).toBe(200);
    await runRebases(t, { resolver: unreachable([]) });
    const d = await detail(t, admin);
    expect(d.rebase).toMatchObject({
      status: 'conflict',
      commit: f2,
      error: MODEL_UNREACHABLE,
    });
    expect((await rows(t)).map((r) => r.status)).toEqual(['failed']);
  });

  it('records a stop AI never takes again (a binary conflict)', async () => {
    const { t, admin, repo, root } = await divergedPull();
    const old = repo.refs.get('refs/heads/main')!;
    repo.refs.set('refs/heads/feature', root);
    const f = await commitFiles(
      repo,
      'feature',
      { 'notes.txt': NOTES, 'logo.bin': 'a\u0000feature' },
      'Logo'
    );
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': NOTES, 'other.txt': 'x\n', 'logo.bin': 'a\u0000main' },
      'Logo too'
    );
    await moved(t, 'main', old);
    const { resolver, requests } = fakeResolver();
    await runRebases(t, { resolver });
    expect((await detail(t, admin)).rebase!.status).toBe('conflict');
    expect((await retry(t, admin)).status).toBe(200);
    await runRebases(t, { resolver });
    expect(requests).toEqual([]);
    const d = await detail(t, admin);
    expect(d.rebase).toMatchObject({ status: 'conflict', commit: f });
    expect(d.pullState!.reasons).toContainEqual(
      expect.objectContaining({ kind: 'rebase_conflict', commit: f })
    );
    expect((await rows(t)).map((r) => [r.status, r.model])).toEqual([
      ['failed', 'none'],
    ]);
  });

  it('needs merge permission', async () => {
    const { t, admin } = await stoppedPull();
    const ada = await addMember(t, admin, 'ada');
    // ada can read the internal repository, but not merge.
    expect((await detail(t, ada)).rebase!.status).toBe('conflict');
    const res = await retry(t, ada);
    expect(res.status).toBe(403);
    expect((await rows(t)).map((r) => r.status)).toEqual(['failed']);
  });

  it('refuses a branch GitOrange never rebases, with why', async () => {
    const { t, admin } = await divergedPull({ conflict: true });
    const patched = await call(t, '/api/repos/octocat/app', {
      cookie: admin,
      method: 'PATCH',
      json: { protectedBranches: ['feature'] },
    });
    expect(patched.status).toBe(200);
    const message =
      'Not rebased: feature is a protected branch; bring it up to date yourself.';
    expect((await detail(t, admin)).rebase!.error).toBe(message);
    const res = await retry(t, admin);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: message });
  });

  it('refuses when nothing is stopped', async () => {
    const { t, admin, root } = await divergedPull();
    // Behind, not stopped: GitOrange is rebasing it.
    const behind = await retry(t, admin);
    expect(behind.status).toBe(409);
    expect(await behind.json()).toEqual({
      error: 'Nothing to retry: GitOrange is rebasing it onto main.',
    });
    await moved(t, 'main', root);
    await runRebases(t);
    expect((await detail(t, admin)).rebase!.status).toBe('up_to_date');
    const res = await retry(t, admin);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Nothing to retry: it is up to date with main.',
    });
    expect((await retry(t, admin, 9)).status).toBe(404);
  });

  it('works over MCP for people who can merge', async () => {
    const { t, admin, f2 } = await stoppedPull();
    const ada = await addMember(t, admin, 'ada');
    const args = { repository: 'octocat/app', number: 1 };
    const denied = await tool(
      t,
      (await connect(t, ada)).access_token,
      'gitorange_retry_rebase',
      args
    );
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/permission/);

    const token = (await connect(t, admin)).access_token;
    const got = await tool(t, token, 'gitorange_get_pull_request', args);
    expect(JSON.parse(got.content[0].text).merge.rebase_conflict).toMatchObject(
      { commit: f2, error: MODEL_UNREACHABLE }
    );
    const ok = await tool(t, token, 'gitorange_retry_rebase', args);
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toMatch(/^Rebasing #1 onto main again/);
    await settle(t);
    const { resolver } = fakeResolver(() => ({
      files: { 'notes.txt': RESOLVED },
    }));
    await runRebases(t, { resolver });
    expect((await detail(t, admin)).rebase!.status).toBe('up_to_date');

    const again = await tool(t, token, 'gitorange_retry_rebase', args);
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toBe(
      'Nothing to retry: it is up to date with main.'
    );
  });

  it('puts the stop back when a rebase run is still finishing', async () => {
    const { t, admin, f2 } = await stoppedPull();
    const pr = await t.env.DB.prepare(
      'SELECT id, repository_id FROM pull_requests'
    ).first<{ id: string; repository_id: string }>();
    await t.env.DB.prepare(
      `INSERT INTO agent_runs (id, repository_id, pull_request_id, kind, status, title, workflow_instance_id, started_at)
       VALUES ('still-running', ?, ?, 'rebase', 'running', 'Rebase', 'still-running', ?)`
    )
      .bind(pr!.repository_id, pr!.id, Date.now())
      .run();
    const before = await rows(t);
    const queued = queuedRebases(t);
    const res = await retry(t, admin);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'A rebase run is still finishing; try again in a moment.',
    });
    expect(queuedRebases(t)).toBe(queued);
    expect(await rows(t)).toEqual(before);
    expect((await rows(t)).map((r) => r.status)).toEqual(['failed']);
    const d = await detail(t, admin);
    expect(d.rebase).toMatchObject({ status: 'conflict', commit: f2 });
    expect(d.pullState!.reasons).toContainEqual(
      expect.objectContaining({ kind: 'rebase_conflict', commit: f2 })
    );
  });

  it('starts one run when retries arrive together', async () => {
    const { t, admin } = await stoppedPull();
    const queued = queuedRebases(t);
    const [a, b] = await Promise.all([retry(t, admin), retry(t, admin)]);
    expect([a.status, b.status].filter((s) => s === 200).length).toBe(1);
    await settle(t);
    expect(queuedRebases(t)).toBe(queued + 1);
  });

  it('refuses a closed pull request', async () => {
    const { t, admin } = await stoppedPull();
    await t.env.DB.prepare("UPDATE pull_requests SET state = 'closed'").run();
    const res = await retry(t, admin);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Only open pull requests are rebased.',
    });
    expect((await rows(t)).map((r) => r.status)).toEqual(['failed']);
  });
});
