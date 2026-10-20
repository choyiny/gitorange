import { describe, expect, it } from 'vitest';
import { addMember } from './helpers/app';
import { connect, crewRepo, tool, type CrewRepo } from './helpers/crew';

const head = (s: CrewRepo) => s.repo.refs.get('refs/heads/main')!;

async function landed(s: CrewRepo, n: number, bump: string | null) {
  await s.mergedRow(n, `topic-${n}`, 1_760_000_000_000 + n * 60_000, {
    title: `Change ${n}`,
  });
  await s.t.env.DB.prepare(
    'UPDATE pull_requests SET version_bump = ? WHERE repository_id = ? AND number = ?'
  )
    .bind(bump, s.repoId, n)
    .run();
}

const parse = (r: { content: { text: string }[] }) =>
  JSON.parse(r.content[0].text);

describe('release MCP tools', () => {
  it('lists unreleased changes, then cuts a release recorded via the app', async () => {
    const s = await crewRepo();
    const { access_token } = await connect(s.t, s.admin, 'Claude Code');
    await landed(s, 1, 'minor');
    await landed(s, 2, null);

    const listed = await tool(s.t, access_token, 'gitorange_list_releases', {
      repository: 'octocat/app',
    });
    const l = parse(listed);
    expect(l.unreleased.head).toBe(head(s));
    expect(l.unreleased.next).toBeNull();
    expect(l.unreleased.pulls.map((p: { bump: string }) => p.bump)).toEqual([
      'minor',
      'patch (default)',
    ]);
    expect(l.releases).toEqual([]);

    const first = await tool(s.t, access_token, 'gitorange_create_release', {
      repository: 'octocat/app',
      head_sha: l.unreleased.head,
    });
    expect(first.isError).toBe(true);
    expect(first.content[0].text).toContain('first release needs a version');

    const cut = await tool(s.t, access_token, 'gitorange_create_release', {
      repository: 'octocat/app',
      head_sha: l.unreleased.head,
      version: 'v0.1.0',
    });
    expect(cut.isError).toBeUndefined();
    expect(parse(cut)).toMatchObject({
      tag: 'v0.1.0',
      url: expect.stringMatching(/\/octocat\/app\/releases\/v0\.1\.0$/),
    });
    expect(s.repo.refs.get('refs/tags/v0.1.0')).toBe(head(s));

    const after = parse(
      await tool(s.t, access_token, 'gitorange_list_releases', {
        repository: 'octocat/app',
      })
    );
    expect(after.releases.map((r: { tag: string }) => r.tag)).toEqual([
      'v0.1.0',
    ]);
    expect(after.unreleased.pulls).toEqual([]);
    expect(
      Math.abs(Date.parse(after.releases[0].created_at) - Date.now())
    ).toBeLessThan(60_000);

    const audit = await s.t.env.DB.prepare(
      "SELECT via FROM audit_events WHERE action = 'release.created'"
    ).first<{ via: string | null }>();
    expect(audit!.via).toBe('Claude Code');
  });

  it('names the new head when the branch moved', async () => {
    const s = await crewRepo();
    const { access_token } = await connect(s.t, s.admin);
    await landed(s, 1, 'patch');
    const res = await tool(s.t, access_token, 'gitorange_create_release', {
      repository: 'octocat/app',
      head_sha: 'a'.repeat(40),
      version: 'v0.1.0',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain(head(s));
  });

  it('refuses a member without push access', async () => {
    const s = await crewRepo();
    await landed(s, 1, 'patch');
    const member = await addMember(s.t, s.admin, 'bob');
    const { access_token } = await connect(s.t, member);
    const res = await tool(s.t, access_token, 'gitorange_create_release', {
      repository: 'octocat/app',
      head_sha: head(s),
      version: 'v0.1.0',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('push access');
    expect(s.repo.refs.get('refs/tags/v0.1.0')).toBeUndefined();
  });
});
