import { describe, expect, it } from 'vitest';
import { queueOrder } from '../lib/queue';
import { addMember, call, settle } from './helpers/app';
import { collaborator, connect, crewRepo, type CrewRepo } from './helpers/crew';
import {
  agentModels,
  appRepo,
  invitedAgent,
  openPull,
  runReviews,
  startReview,
} from './helpers/reviews';

const BASE = '/api/repos/octocat/app';

type PersonRef = {
  login: string;
  name: string | null;
  isAgent: boolean;
  color: string | null;
};
type QueueTarget = {
  target: string;
  paused: { at: number; by: PersonRef } | null;
  entries: {
    position: number;
    number: number;
    title: string;
    author: PersonRef;
    createdVia: string | null;
    session: string | null;
    sessionId: string;
    state: string;
    blockers: string[];
    etaMinutes: number | null;
  }[];
};

async function queue(s: CrewRepo, cookie = s.admin) {
  const res = await call(s.t, `${BASE}/queue`, { cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as QueueTarget[];
}
const pause = (s: CrewRepo, cookie: string, json?: unknown) =>
  call(s.t, `${BASE}/merging/pause`, {
    cookie,
    method: 'POST',
    ...(json === undefined ? {} : { json }),
  });
const resume = (s: CrewRepo, cookie: string) =>
  call(s.t, `${BASE}/merging/pause`, { cookie, method: 'DELETE' });
const approve = async (s: CrewRepo, n: number) => {
  const res = await call(s.t, `${BASE}/pulls/${n}/approval`, {
    cookie: s.admin,
    method: 'POST',
  });
  expect(res.status).toBe(200);
  await settle(s.t);
};
const prId = async (s: CrewRepo, n: number) =>
  (await s.t.env.DB.prepare(
    'SELECT id FROM pull_requests WHERE repository_id = ? AND number = ?'
  )
    .bind(s.repoId, n)
    .first<{ id: string }>())!.id;

/** An ordering edge, as reconcile adds them: `after` lands after `before`. */
async function orderedAfter(s: CrewRepo, after: number, before: number) {
  const [a, b] = [await prId(s, before), await prId(s, after)];
  const now = Math.floor(Date.now() / 1000);
  await s.t.env.DB.prepare(
    `INSERT INTO pr_edges (id, repository_id, land_target, pr_a_id, pr_b_id, slot, for_pr_id, for_head, a_head, b_head,
                           stage, kind, prerequisite, reason, created_at, updated_at)
     VALUES (?, ?, 'main', ?, ?, 'order', ?, 'x', 'x', 'x', 'done', 'ordered_after', 'a', 'Same lines', ?, ?)`
  )
    .bind(crypto.randomUUID(), s.repoId, a, b, b, now, now)
    .run();
}

/** Completed pull request runs that took `minutes` each, and finished reviews that took `reviewMs` each. */
async function history(s: CrewRepo, minutes: number[], reviewMs: number[]) {
  const now = Math.floor(Date.now() / 1000);
  let n = 100;
  for (const m of minutes)
    await s.t.env.DB.prepare(
      `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title,
                                  status, conclusion, created_at, started_at, completed_at)
       VALUES (?, ?, ?, '.github/workflows/ci.yml', 'CI', 'pull_request', 'refs/pull/9/head', 'old', 'Old', 'completed',
               'success', ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        s.repoId,
        n++,
        now - 3600,
        now - 3600,
        now - 3600 + m * 60
      )
      .run();
  // Neither a push run nor an unfinished one counts.
  await s.t.env.DB.prepare(
    `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title,
                                status, conclusion, created_at, completed_at)
     VALUES (?, ?, ?, '.github/workflows/ci.yml', 'CI', 'push', 'refs/heads/main', 'old', 'Old', 'completed', 'success',
             ?, ?), (?, ?, ?, '.github/workflows/ci.yml', 'CI', 'pull_request', 'refs/pull/9/head', 'old', 'Old',
             'in_progress', NULL, ?, NULL)`
  )
    .bind(
      crypto.randomUUID(),
      s.repoId,
      n++,
      now - 9000,
      now,
      crypto.randomUUID(),
      s.repoId,
      n++,
      now - 9000
    )
    .run();
  const pr = (await s.t.env.DB.prepare(
    'SELECT id FROM pull_requests WHERE repository_id = ? LIMIT 1'
  )
    .bind(s.repoId)
    .first<{ id: string }>())!.id;
  for (const ms of reviewMs)
    await s.t.env.DB.prepare(
      `INSERT INTO pr_classifications (id, pull_request_id, head_sha, status, summary_model, classifier_model, duration_ms,
                                       created_at, finished_at)
       VALUES (?, ?, ?, 'done', 'glm', 'clef', ?, ?, ?)`
    )
      .bind(
        `${pr}-${crypto.randomUUID()}`,
        pr,
        crypto.randomUUID(),
        ms,
        now - 600,
        now - 500
      )
      .run();
}

const auditRows = (s: CrewRepo) =>
  s.t.env.DB.prepare(
    `SELECT a.action, a.target, a.data, u.username AS actor FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.action LIKE 'merging.%' ORDER BY a.created_at, a.rowid`
  ).all<{ action: string; target: string; data: string; actor: string }>();

describe('queueOrder', () => {
  it('puts prerequisites before what waits on them, otherwise oldest first', () => {
    const prs = [1, 2, 3, 4].map((number) => ({ number, createdAt: number }));
    expect(queueOrder(prs, new Map())).toEqual([1, 2, 3, 4]);
    // #1 lands after #3; #3 after #4.
    expect(
      queueOrder(
        prs,
        new Map([
          [1, [3]],
          [3, [4]],
        ])
      )
    ).toEqual([4, 3, 1, 2]);
    // Creation time wins over the number; a circle (never in a tree, but) still lists each once.
    expect(
      queueOrder(
        [
          { number: 1, createdAt: 5 },
          { number: 2, createdAt: 1 },
        ],
        new Map([
          [1, [2]],
          [2, [1]],
        ])
      )
    ).toEqual([1, 2]);
  });
});

describe('GET /api/repos/{o}/{r}/queue', () => {
  it('lists each target’s open pull requests in landing order: ordering edges first, then when they were opened', async () => {
    const s = await crewRepo();
    const claude = (await connect(s.t, s.admin, 'Claude Code')).access_token;
    for (const b of ['a', 'b', 'c', 'd']) await s.branch(b);
    s.repo.refs.set('refs/heads/release', s.main);
    const n1 = await s.web('a', { title: 'First' });
    const n2 = await s.mcp(claude, 'b', { title: 'Second', session: 's4' });
    const n3 = await s.web('c', { title: 'Third' });
    const n4 = await s.web('d', { title: 'For release', base: 'release' });
    await orderedAfter(s, n1, n3);

    const targets = await queue(s);
    // The default branch first, then other targets by name.
    expect(targets.map((t) => t.target)).toEqual(['main', 'release']);
    const [main, release] = targets;
    expect(main.paused).toBeNull();
    expect(main.entries.map((e) => [e.position, e.number])).toEqual([
      [1, n3],
      [2, n1],
      [3, n2],
    ]);
    expect(main.entries[2]).toMatchObject({
      title: 'Second',
      author: { login: 'octocat', name: 'Admin', isAgent: false, color: null },
      createdVia: 'Claude Code',
      session: 's4',
    });
    expect(main.entries[0]).toMatchObject({ createdVia: null, session: null });
    // #1 waits for #3: it lands after it.
    expect(main.entries[1].blockers).toContain(`Lands after #${n3}`);
    expect(release.entries.map((e) => e.number)).toEqual([n4]);
  });

  it('always lists the default branch, and takes blockers from the pull request’s state', async () => {
    const s = await crewRepo();
    expect(await queue(s)).toEqual([
      { target: 'main', paused: null, entries: [] },
    ]);
    await s.branch('a');
    const n = await s.web('a', { title: 'Add a' });
    let [main] = await queue(s);
    expect(main.entries).toEqual([
      {
        position: 1,
        number: n,
        title: 'Add a',
        author: {
          login: 'octocat',
          name: 'Admin',
          isAgent: false,
          color: null,
        },
        createdVia: null,
        session: null,
        sessionId: expect.stringMatching(/^s-[0-9a-f]{10}$/),
        state: 'human_review',
        blockers: ['Needs a person to approve it'],
        etaMinutes: null,
      },
    ]);
    await approve(s, n);
    [main] = await queue(s);
    expect(main.entries[0]).toMatchObject({ state: 'ready', blockers: [] });
  });

  it('estimates when each lands: the median run and review times, added up down the queue', async () => {
    const s = await crewRepo();
    for (const b of ['a', 'b', 'c']) await s.branch(b);
    const ns = [await s.web('a'), await s.web('b'), await s.web('c')];
    // No history yet: no estimate.
    expect((await queue(s))[0].entries.map((e) => e.etaMinutes)).toEqual([
      null,
      null,
      null,
    ]);
    // Runs took 2, 4 and 30 minutes (median 4); reviews 30 s, 60 s and 90 s (median 1 minute): 5 minutes each.
    await history(s, [2, 4, 30], [30_000, 60_000, 90_000]);
    let [main] = await queue(s);
    expect(main.entries.map((e) => [e.number, e.etaMinutes])).toEqual([
      [ns[0], 5],
      [ns[1], 10],
      [ns[2], 15],
    ]);
    // The first is ready: it lands now, and the next one starts after it.
    await approve(s, ns[0]);
    [main] = await queue(s);
    expect(main.entries.map((e) => e.etaMinutes)).toEqual([0, 5, 10]);
  });

  it('is readable by anyone who can read the repository; 404 for others', async () => {
    const s = await crewRepo();
    const bob = await addMember(s.t, s.admin, 'bob');
    expect((await call(s.t, `${BASE}/queue`, { cookie: bob })).status).toBe(
      200
    );
    await s.setRepo('visibility', 'private');
    expect((await call(s.t, `${BASE}/queue`, { cookie: bob })).status).toBe(
      404
    );
  });
});

describe('POST/DELETE /api/repos/{o}/{r}/merging/pause', () => {
  it('pauses the merge button and shows merging_paused; resuming clears it; both are audited', async () => {
    const s = await crewRepo();
    const ada = await collaborator(s, 'ada');
    await s.branch('a');
    const n = await s.web('a');
    await approve(s, n);

    const paused = await pause(s, ada, { reason: 'Looking into errors' });
    expect(paused.status).toBe(200);
    const { paused: p } = (await paused.json()) as {
      paused: QueueTarget['paused'];
    };
    expect(p).toEqual({
      at: expect.any(Number),
      by: { login: 'ada', name: 'ada', isAgent: false, color: null },
    });
    expect(Math.abs(p!.at - Date.now())).toBeLessThan(60_000);
    await settle(s.t);

    const [main] = await queue(s);
    expect(main.paused).toEqual(p);
    expect(main.entries[0]).toMatchObject({
      state: 'waiting',
      blockers: ['Merging is paused'],
    });
    const page = (await (
      await call(s.t, `${BASE}/pulls/${n}`, { cookie: s.admin })
    ).json()) as { pullState: unknown };
    expect(page.pullState).toEqual({
      state: 'waiting',
      reasons: [{ kind: 'merging_paused' }],
    });
    // The merge button refuses.
    const refused = await call(s.t, `${BASE}/pulls/${n}/merge`, {
      cookie: s.admin,
      json: {},
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      reason: 'paused',
      error: expect.stringContaining('Merging is paused'),
    });

    const resumed = await resume(s, ada);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ paused: null });
    await settle(s.t);
    expect((await queue(s))[0].paused).toBeNull();
    const merged = await call(s.t, `${BASE}/pulls/${n}/merge`, {
      cookie: s.admin,
      json: {},
    });
    expect(merged.status).toBe(200);

    const rows = (await auditRows(s)).results;
    expect(rows.map((r) => [r.action, r.target, r.actor])).toEqual([
      ['merging.paused', 'octocat/app', 'ada'],
      ['merging.resumed', 'octocat/app', 'ada'],
    ]);
    expect(JSON.parse(rows[0].data)).toEqual({
      reason: 'Looking into errors',
    });
  });

  it('records a pause once, and a resume only when paused', async () => {
    const s = await crewRepo();
    expect((await resume(s, s.admin)).status).toBe(200);
    const first = (await (await pause(s, s.admin)).json()) as {
      paused: QueueTarget['paused'];
    };
    const again = (await (await pause(s, s.admin)).json()) as {
      paused: QueueTarget['paused'];
    };
    expect(again).toEqual(first);
    expect(
      (await auditRows(s)).results.map((r) => [r.action, JSON.parse(r.data)])
    ).toEqual([['merging.paused', {}]]);
  });

  it('needs push access', async () => {
    const s = await crewRepo();
    const bob = await addMember(s.t, s.admin, 'bob');
    expect((await pause(s, bob)).status).toBe(403);
    await pause(s, s.admin);
    expect((await resume(s, bob)).status).toBe(403);
    expect((await queue(s, bob))[0].paused).not.toBeNull();
    expect(
      (await call(s.t, `${BASE}/merging/pause`, { method: 'POST' })).status
    ).toBe(401);
  });

  it('pings the repository’s live channel', async () => {
    const s = await crewRepo();
    const pings: string[] = [];
    (s.t.env as unknown as { LIVE: unknown }).LIVE = {
      getByName: () => ({
        publish: async (channel: string) => void pings.push(channel),
      }),
    };
    await pause(s, s.admin);
    await settle(s.t);
    expect(pings).toContain(`repo:${s.repoId}`);
  });

  it('holds auto-merge while paused, and lands what is ready on resume', async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent');
    await openPull(t, admin, repo, { 'src/auth.ts': 'x\n' });
    expect(
      (
        await call(t, `${BASE}/merging/pause`, {
          cookie: admin,
          method: 'POST',
        })
      ).status
    ).toBe(200);
    await startReview(t);
    await runReviews(t, agentModels().models);
    await settle(t);
    const state = () =>
      t.env.DB.prepare(
        'SELECT state, merged_automatically FROM pull_requests WHERE number = 1'
      ).first<{ state: string; merged_automatically: number }>();
    expect((await state())!.state).toBe('open');
    const page = (await (
      await call(t, `${BASE}/pulls/1`, { cookie: admin })
    ).json()) as {
      review: { autoMerge: { state: string; reasons?: string[] } };
    };
    expect(page.review.autoMerge).toEqual({
      state: 'waiting',
      reasons: ['Merging is paused'],
      disabledAt: null,
    });

    await call(t, `${BASE}/merging/pause`, {
      cookie: admin,
      method: 'DELETE',
    });
    await settle(t);
    expect(await state()).toEqual({ state: 'merged', merged_automatically: 1 });
  });
});
