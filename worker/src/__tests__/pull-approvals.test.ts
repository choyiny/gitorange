import { describe, expect, it } from 'vitest';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
} from './helpers/app';
import { commitPaths } from './helpers/seed';

const BASE = { 'a.txt': 'one\n' };

async function setup() {
  const t = makeEnv();
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'internal' },
  });
  const repo = [...t.fake.repos.values()][0];
  const main = await commitPaths(repo, 'main', BASE, 'base');
  repo.refs.set('refs/heads/feature', main);
  const head = await commitPaths(repo, 'feature', { 'a.txt': 'two\n' }, 'Two');
  const res = await call(t, '/api/repos/octocat/app/pulls', {
    cookie: admin,
    json: { title: 'Two', body: '', base: 'main', head: 'feature' },
  });
  expect(res.status).toBe(201);
  await settle(t);
  return { t, admin, repo, head };
}

type Detail = {
  headSha: string;
  approvals: { user: { username: string }; createdAt: string }[];
  events: {
    kind: string;
    actor: { username: string } | null;
    data: Record<string, unknown> | null;
  }[];
};
const detail = async (
  t: Awaited<ReturnType<typeof setup>>['t'],
  cookie: string
) =>
  (await (
    await call(t, '/api/repos/octocat/app/pulls/1', { cookie })
  ).json()) as Detail;
const approve = (
  t: Awaited<ReturnType<typeof setup>>['t'],
  cookie: string,
  method = 'POST'
) => call(t, '/api/repos/octocat/app/pulls/1/approval', { cookie, method });

describe('approving a pull request', () => {
  it('records the head commit as approved by a person with merge access', async () => {
    const { t, admin, head } = await setup();
    const res = await approve(t, admin);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, headSha: head });
    const d = await detail(t, admin);
    expect(d.approvals.map((a) => a.user.username)).toEqual(['octocat']);
    // On the timeline, with who approved which commit.
    expect(d.events.filter((e) => e.kind === 'approved')).toMatchObject([
      { actor: { username: 'octocat' }, data: { head_sha: head } },
    ]);
  });

  it('keeps one approval, and one timeline entry, when approving twice', async () => {
    const { t, admin } = await setup();
    await approve(t, admin);
    await approve(t, admin);
    const n = await t.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM pr_approvals'
    ).first<{ n: number }>();
    expect(n!.n).toBe(1);
    const events = (await detail(t, admin)).events.filter(
      (e) => e.kind === 'approved'
    );
    expect(events).toHaveLength(1);
  });

  it('needs a new approval for a new commit', async () => {
    const { t, admin, repo } = await setup();
    await approve(t, admin);
    await commitPaths(repo, 'feature', { 'a.txt': 'three\n' }, 'Three');
    expect((await detail(t, admin)).approvals).toEqual([]);
  });

  it('counts an approval again when the branch returns to its commit', async () => {
    const { t, admin, repo, head } = await setup();
    await approve(t, admin);
    await commitPaths(repo, 'feature', { 'a.txt': 'three\n' }, 'Three');
    repo.refs.set('refs/heads/feature', head); // force-push back
    expect((await detail(t, admin)).approvals).toHaveLength(1);
  });

  it('withdraws only your own approval of the head', async () => {
    const { t, admin } = await setup();
    await approve(t, admin);
    const res = await approve(t, admin, 'DELETE');
    expect(res.status).toBe(200);
    expect((await detail(t, admin)).approvals).toEqual([]);
  });

  it('records a withdrawal on the timeline, once, and only when there was an approval', async () => {
    const { t, admin, head } = await setup();
    // Nothing to withdraw: no entry.
    expect((await approve(t, admin, 'DELETE')).status).toBe(200);
    await approve(t, admin);
    await approve(t, admin, 'DELETE');
    await approve(t, admin, 'DELETE');
    const events = (await detail(t, admin)).events.filter(
      (e) => e.kind === 'withdrawn'
    );
    expect(events).toMatchObject([
      { actor: { username: 'octocat' }, data: { head_sha: head } },
    ]);
  });

  it('refuses members without merge access', async () => {
    const { t, admin } = await setup();
    const mona = await addMember(t, admin, 'mona');
    expect((await approve(t, mona)).status).toBe(403);
  });

  it('refuses a pull request that is no longer open', async () => {
    const { t, admin } = await setup();
    await call(t, '/api/repos/octocat/app/pulls/1', {
      cookie: admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    const res = await approve(t, admin);
    expect(res.status).toBe(400);
  });
});
