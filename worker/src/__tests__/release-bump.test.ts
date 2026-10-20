import { describe, expect, it } from 'vitest';
import { addMember, call, settle } from './helpers/app';
import { collaborator, connect, crewRepo, tool } from './helpers/crew';

const BASE = '/api/repos/octocat/app';

type PullJson = { versionBump: string | null; releasedIn: string | null };

const open = (
  s: Awaited<ReturnType<typeof crewRepo>>,
  head: string,
  extra: Record<string, unknown> = {}
) =>
  call(s.t, `${BASE}/pulls`, {
    cookie: s.admin,
    json: { title: head, body: '', base: 'main', head, ...extra },
  });

const getPull = async (s: Awaited<ReturnType<typeof crewRepo>>, n: number) =>
  (await (
    await call(s.t, `${BASE}/pulls/${n}`, { cookie: s.admin })
  ).json()) as { pull: PullJson };

const patch = (
  s: Awaited<ReturnType<typeof crewRepo>>,
  n: number,
  json: unknown,
  cookie = s.admin
) => call(s.t, `${BASE}/pulls/${n}`, { cookie, method: 'PATCH', json });

describe('version bump on pull requests', () => {
  it('create with a bump stores it and returns it', async () => {
    const s = await crewRepo();
    await s.branch('feature');
    const res = await open(s, 'feature', { versionBump: 'minor' });
    expect(res.status).toBe(201);
    const created = (await res.json()) as PullJson & { number: number };
    expect(created.versionBump).toBe('minor');
    expect(created.releasedIn).toBeNull();
    await settle(s.t);
    const { pull } = await getPull(s, created.number);
    expect(pull.versionBump).toBe('minor');
    expect(pull.releasedIn).toBeNull();
  });

  it('a pull request opened without a bump has none', async () => {
    const s = await crewRepo();
    await s.branch('feature');
    const n = await s.web('feature');
    expect((await getPull(s, n)).pull.versionBump).toBeNull();
  });

  it('PATCH changes the bump and audits it, once, only when it changes', async () => {
    const s = await crewRepo();
    await s.branch('feature');
    const res = await open(s, 'feature', { versionBump: 'minor' });
    const n = ((await res.json()) as { number: number }).number;
    await settle(s.t);

    expect((await patch(s, n, { versionBump: 'major' })).status).toBe(200);
    await settle(s.t);
    expect((await getPull(s, n)).pull.versionBump).toBe('major');
    const audit = await s.t.env.DB.prepare(
      "SELECT target, data FROM audit_events WHERE action = 'pull.version_bump'"
    ).all<{ target: string; data: string }>();
    expect(audit.results).toHaveLength(1);
    expect(JSON.parse(audit.results[0].data)).toMatchObject({
      from: 'minor',
      to: 'major',
    });
    const ev = await s.t.env.DB.prepare(
      "SELECT data FROM pr_events WHERE kind = 'version_bump'"
    ).all<{ data: string }>();
    expect(ev.results.map((r) => JSON.parse(r.data))).toEqual([
      { from: 'minor', to: 'major' },
    ]);

    // The same value again records nothing.
    expect((await patch(s, n, { versionBump: 'major' })).status).toBe(200);
    // Clearing it does.
    expect((await patch(s, n, { versionBump: null })).status).toBe(200);
    await settle(s.t);
    expect((await getPull(s, n)).pull.versionBump).toBeNull();
    const count = await s.t.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'pull.version_bump'"
    ).first<{ n: number }>();
    expect(count!.n).toBe(2);
  });

  it('the bump cannot change after landing', async () => {
    const s = await crewRepo();
    await s.branch('feature');
    const n = await s.web('feature');
    await s.merge(n);
    const res = await patch(s, n, { versionBump: 'major' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'This pull request is already merged',
    });
  });

  it('the author or a writer may change it; others get 403', async () => {
    const s = await crewRepo();
    await s.branch('feature');
    const n = await s.web('feature');
    const writer = await collaborator(s, 'writer');
    expect((await patch(s, n, { versionBump: 'patch' }, writer)).status).toBe(
      200
    );
    const reader = await addMember(s.t, s.admin, 'reader');
    expect((await patch(s, n, { versionBump: 'major' }, reader)).status).toBe(
      403
    );
    expect((await getPull(s, n)).pull.versionBump).toBe('patch');
  });

  it('an invalid bump is 400', async () => {
    const s = await crewRepo();
    await s.branch('feature');
    expect((await open(s, 'feature', { versionBump: 'huge' })).status).toBe(
      400
    );
    const n = await s.web('feature');
    expect((await patch(s, n, { versionBump: 'huge' })).status).toBe(400);
  });

  it('MCP create takes version_bump', async () => {
    const s = await crewRepo();
    await s.branch('feature');
    const { access_token } = await connect(s.t, s.admin, 'Claude Code');
    const created = await tool(
      s.t,
      access_token,
      'gitorange_create_pull_request',
      {
        repository: 'octocat/app',
        head: 'feature',
        title: 'Add',
        version_bump: 'patch',
      }
    );
    expect(created.isError).toBeFalsy();
    const { number } = JSON.parse(created.content[0].text) as {
      number: number;
    };
    await settle(s.t);
    const got = await tool(s.t, access_token, 'gitorange_get_pull_request', {
      repository: 'octocat/app',
      number,
    });
    const pr = JSON.parse(got.content[0].text) as {
      version_bump: string | null;
      released_in: string | null;
    };
    expect(pr.version_bump).toBe('patch');
    expect(pr.released_in).toBeNull();
  });

  it('MCP create refuses an invalid version_bump and opens nothing', async () => {
    const s = await crewRepo();
    await s.branch('feature');
    const { access_token } = await connect(s.t, s.admin, 'Claude Code');
    const res = await tool(s.t, access_token, 'gitorange_create_pull_request', {
      repository: 'octocat/app',
      head: 'feature',
      title: 'Add',
      version_bump: 'huge',
    });
    expect(res.isError).toBe(true);
    const n = await s.t.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM pull_requests'
    ).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});
