import { describe, expect, it } from 'vitest';
import { addMember, call, settle } from './helpers/app';
import { connect, crewRepo, type CrewRepo } from './helpers/crew';

const BASE = '/api/repos/octocat/app';

type LivePayload = {
  queue: { target: string; paused: unknown; entries: { number: number }[] }[];
  floor: {
    id: string;
    client: string | null;
    label: string | null;
    author: { login: string };
    pulls: { number: number; state: string; pullState: unknown }[];
    requests: { number: number; text: string }[];
    lastActivity: number;
  }[];
  events: { id: string; at: number; action: string; target: string }[];
};

async function live(s: CrewRepo, cookie = s.admin) {
  const res = await call(s.t, `${BASE}/live`, { cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as LivePayload;
}

describe('GET /api/repos/{o}/{r}/live', () => {
  it('returns the merge queue, the open requests by session, and the newest events', async () => {
    const s = await crewRepo();
    const claude = (await connect(s.t, s.admin, 'Claude Code')).access_token;
    await s.branch('a');
    const n1 = await s.mcp(claude, 'a', {
      title: 'Make a',
      session: 's4',
      request: 'Please make a',
    });
    await s.branch('b');
    const n2 = await s.web('b');
    await s.branch('c');
    const n3 = await s.web('c');
    await s.merge(n3);
    await call(s.t, `${BASE}/merging/pause`, {
      cookie: s.admin,
      method: 'POST',
    });
    await settle(s.t);

    const payload = await live(s);
    expect(Object.keys(payload).sort()).toEqual(['events', 'floor', 'queue']);
    // The same queue as the queue endpoint.
    expect(payload.queue).toEqual(
      await (await call(s.t, `${BASE}/queue`, { cookie: s.admin })).json()
    );
    expect(payload.queue[0].entries.map((e) => e.number)).toEqual([n1, n2]);
    expect(payload.queue[0].paused).not.toBeNull();

    // The floor: open pull requests only, grouped by session.
    const floor = payload.floor.map((f) => [
      f.client,
      f.label,
      f.pulls.map((p) => p.number),
    ]);
    expect(floor).toHaveLength(2);
    expect(floor).toEqual(
      expect.arrayContaining([
        ['Claude Code', 's4', [n1]],
        [null, null, [n2]],
      ])
    );
    const s4 = payload.floor.find((f) => f.label === 's4')!;
    expect(s4.requests).toEqual([{ number: n1, text: 'Please make a' }]);
    expect(s4.pulls[0]).toMatchObject({
      state: 'open',
      pullState: { state: 'human_review' },
    });

    // Newest first: the pause, then the merge.
    expect(payload.events[0]).toMatchObject({
      action: 'merging.paused',
      target: 'octocat/app',
    });
    expect(payload.events.map((e) => e.action)).toContain('pull.merged');
  });

  it('keeps only the 50 newest events', async () => {
    const s = await crewRepo();
    // A minute ahead, so b0 is newer than the repository.created event, which can share a millisecond with now
    // (equal times are ordered by random id).
    const newest = Date.now() + 60_000;
    for (let i = 0; i < 60; i++)
      await s.t.env.DB.prepare(
        `INSERT INTO audit_events (id, repository_id, actor_id, actor_kind, action, target, data, created_at)
         VALUES (?, ?, NULL, 'system', 'branch.deleted', ?, '{}', ?)`
      )
        .bind(crypto.randomUUID(), s.repoId, `b${i}`, newest - i * 1000)
        .run();
    const { events } = await live(s);
    expect(events).toHaveLength(50);
    expect(events[0].target).toBe('b0');
  });

  it('is readable by anyone who can read the repository; 404 for others', async () => {
    const s = await crewRepo();
    const bob = await addMember(s.t, s.admin, 'bob');
    expect((await live(s, bob)).queue[0].target).toBe('main');
    await s.setRepo('visibility', 'private');
    expect((await call(s.t, `${BASE}/live`, { cookie: bob })).status).toBe(404);
  });
});
