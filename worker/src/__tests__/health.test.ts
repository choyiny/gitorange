import { describe, expect, it } from 'vitest';
import { isoWeekStart, trendOf, weekStarts } from '../lib/health';
import { addMember, call } from './helpers/app';
import { newAgent } from './helpers/agents';
import { crewRepo, type CrewRepo } from './helpers/crew';
import { FINDINGS } from './helpers/lessons';
import {
  agentModels,
  invitedAgent,
  runReviews,
  startReview,
} from './helpers/reviews';

const BASE = '/api/repos/octocat/app';
const DAY = 86_400_000;
const WEEK = 7 * DAY;

type HealthArea = {
  id: string;
  label: string;
  color: string | null;
  agent: string | null;
  thisWeek: number;
  lastWeek: number;
  weeks: number[];
  trend: 'better' | 'same' | 'worse';
  status: string;
  detail: string;
  open: number;
};
type HealthReport = {
  summary: string;
  decisionsWaiting: number;
  areas: HealthArea[];
  contributors: {
    who: {
      kind: 'person' | 'session';
      label: string;
      login: string;
      client: string | null;
    };
    merged: number;
    findings: number;
    note: string | null;
    trend: 'better' | 'same' | 'worse';
  }[];
};

async function health(s: CrewRepo, cookie = s.admin) {
  const res = await call(s.t, `${BASE}/health`, { cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as HealthReport;
}
const area = (r: HealthReport, id: string) => r.areas.find((a) => a.id === id)!;

/** Epoch ms `days` days into the ISO week `weeksAgo` weeks back (0: this week), clamped to before now. */
function inWeek(weeksAgo: number, days = 0) {
  const start = isoWeekStart(Date.now()) - weeksAgo * WEEK;
  return Math.min(start + days * DAY + 3_600_000, Date.now() - 1000);
}

const exec = (s: CrewRepo, sql: string, ...binds: unknown[]) =>
  s.t.env.DB.prepare(sql)
    .bind(...binds)
    .run();
const idOf = async (s: CrewRepo, username: string) =>
  (await s.t.env.DB.prepare('SELECT id FROM users WHERE username = ?')
    .bind(username)
    .first<{ id: string }>())!.id;

/** A pull request row straight in D1 (merged at `mergedAt` ms, or open). */
async function pr(
  s: CrewRepo,
  number: number,
  o: {
    mergedAt?: number;
    author?: string;
    via?: string | null;
    session?: string | null;
  } = {}
) {
  const id = `${s.repoId}-p${number}`;
  const at = Math.floor((o.mergedAt ?? Date.now()) / 1000);
  await exec(
    s,
    'UPDATE repositories SET next_pr_number = MAX(next_pr_number, ?) WHERE id = ?',
    number + 1,
    s.repoId
  );
  await exec(
    s,
    `INSERT INTO pull_requests (id, repository_id, number, title, author_id, base_ref, land_target, head_ref, state,
                                merged_at, closed_at, created_via, session_label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'main', 'main', ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    s.repoId,
    number,
    `PR ${number}`,
    await idOf(s, o.author ?? 'octocat'),
    `gone-${number}`,
    o.mergedAt ? 'merged' : 'open',
    o.mergedAt ? at : null,
    o.mergedAt ? at : null,
    o.via ?? null,
    o.session ?? null,
    at - 60,
    at
  );
  return id;
}

/** `count` findings by `agent` on pull request `prId`, raised at `at` ms. */
async function findings(
  s: CrewRepo,
  prId: string,
  agent: string,
  at: number,
  count = 1,
  o: { kind?: string; approvedAt?: number } = {}
) {
  const classification = `${prId}-${crypto.randomUUID()}`;
  await exec(
    s,
    `INSERT INTO pr_classifications (id, pull_request_id, head_sha, status, summary_model, classifier_model, created_at)
     VALUES (?, ?, ?, 'done', 'glm', 'clef', ?)`,
    classification,
    prId,
    crypto.randomUUID(),
    Math.floor(at / 1000)
  );
  const agentId = await idOf(s, agent);
  for (let i = 0; i < count; i++)
    await exec(
      s,
      `INSERT INTO pr_review_flags (id, classification_id, key, value, paths, agent_id, kind, approved_at, created_at)
       VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
      crypto.randomUUID(),
      classification,
      `${agentId}:${i}`,
      JSON.stringify({ title: `Finding ${i}` }),
      agentId,
      o.kind ?? 'needs_person',
      o.approvedAt ? Math.floor(o.approvedAt / 1000) : null,
      Math.floor(at / 1000)
    );
}

/** A finished push run on main at `at` ms. */
async function mainRun(s: CrewRepo, at: number, conclusion: string) {
  const n = Math.floor(Math.random() * 1e9);
  await exec(
    s,
    `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title,
                                status, conclusion, created_at, completed_at)
     VALUES (?, ?, ?, '.github/workflows/ci.yml', 'CI', 'push', 'refs/heads/main', ?, 'x', 'completed', ?, ?, ?)`,
    crypto.randomUUID(),
    s.repoId,
    n,
    `sha-${n}`,
    conclusion,
    Math.floor(at / 1000) - 60,
    Math.floor(at / 1000)
  );
}

describe('health maths', () => {
  it('starts ISO weeks on Monday 00:00 UTC, eight of them, oldest first', () => {
    // Thursday 8 October 2026, 15:00 UTC.
    const now = Date.UTC(2026, 9, 8, 15);
    expect(new Date(isoWeekStart(now)).toISOString()).toBe(
      '2026-10-05T00:00:00.000Z'
    );
    // A Monday is the start of its own week; a Sunday belongs to the week before.
    expect(isoWeekStart(Date.UTC(2026, 9, 5))).toBe(Date.UTC(2026, 9, 5));
    expect(isoWeekStart(Date.UTC(2026, 9, 11, 23))).toBe(Date.UTC(2026, 9, 5));
    const starts = weekStarts(now);
    expect(starts).toHaveLength(8);
    expect(new Date(starts[0]).toISOString()).toBe('2026-08-17T00:00:00.000Z');
    expect(starts[7]).toBe(Date.UTC(2026, 9, 5));
  });

  it('calls a week worse when it has more problems than the week before', () => {
    expect(trendOf(3, 1)).toBe('worse');
    expect(trendOf(1, 3)).toBe('better');
    expect(trendOf(2, 2)).toBe('same');
    expect(trendOf(0, 0)).toBe('same');
  });
});

describe('GET /api/repos/{o}/{r}/health', () => {
  it('has one row per invited agent with its findings per week, then tests and merging', async () => {
    const s = await crewRepo();
    await invitedAgent(s.t, s.admin, 'secagent');
    // Created, never invited here: no row, even with findings.
    await newAgent(s.t, s.admin, 'dataagent', 'Data agent');
    const merged = await pr(s, 1, { mergedAt: inWeek(0) });
    // 2 this week, 1 last week, 3 four weeks back, 1 nine weeks back (outside the window).
    await findings(s, merged, 'secagent', inWeek(0), 2);
    await findings(s, merged, 'secagent', inWeek(1), 1, {
      kind: 'change_requested',
    });
    await findings(s, merged, 'secagent', inWeek(4, 2), 3);
    await findings(s, merged, 'secagent', inWeek(9), 1);
    await findings(s, merged, 'dataagent', inWeek(0), 4);

    const report = await health(s);
    expect(report.areas.map((a) => a.id)).toEqual([
      'agent:secagent',
      'tests',
      'merging',
    ]);
    expect(area(report, 'agent:secagent')).toEqual({
      id: 'agent:secagent',
      label: 'secagent agent',
      color: expect.stringMatching(/^#[0-9a-f]{6}$/),
      agent: 'secagent',
      thisWeek: 2,
      lastWeek: 1,
      weeks: [0, 0, 0, 3, 0, 0, 1, 2],
      trend: 'worse',
      status: 'No open problems',
      detail: '2 raised this week, 1 more than last week',
      open: 0,
    });
    expect(report.summary).toBe(
      'secagent agent got worse: 2 findings this week, up from 1.'
    );
  });

  it('measures tests on main by the share of runs that failed, week over week', async () => {
    const s = await crewRepo();
    // This week: 3 of 4 passed. Last week: 2 of 2. Cancelled runs don't count.
    for (const c of ['success', 'success', 'success', 'failure', 'cancelled'])
      await mainRun(s, inWeek(0), c);
    for (const c of ['success', 'success']) await mainRun(s, inWeek(1), c);
    const tests = area(await health(s), 'tests');
    expect(tests).toMatchObject({
      label: 'Tests on main',
      color: null,
      agent: null,
      thisWeek: 25,
      lastWeek: 0,
      weeks: [0, 0, 0, 0, 0, 0, 0, 25],
      trend: 'worse',
      detail: '75% of 4 runs passed this week, was 100% last week',
    });
    // The newest run on main is the one that decides whether it fails now.
    expect(['Passing', 'Failing now']).toContain(tests.status);
  });

  it('calls the trend the same, and claims no improvement, when this week has no runs to compare', async () => {
    const s = await crewRepo();
    // Last week half the runs failed; this week nothing has run on main. Zero is "no data", not "no failures".
    for (const c of ['success', 'failure']) await mainRun(s, inWeek(1), c);
    const tests = area(await health(s), 'tests');
    expect(tests).toMatchObject({
      thisWeek: 0,
      lastWeek: 50,
      trend: 'same',
      detail: 'No test runs this week',
    });
    expect(`${tests.status} ${tests.detail}`).not.toMatch(
      /better|improv|fewer|down|was/i
    );
    expect((await health(s)).summary).toBe('Nothing got worse this week.');
  });

  it('calls the trend the same, and claims no decline, when last week has no runs to compare', async () => {
    const s = await crewRepo();
    // This week 1 of 4 runs failed; last week had no runs at all (only an older week did).
    for (const c of ['success', 'success', 'success', 'failure'])
      await mainRun(s, inWeek(0), c);
    await mainRun(s, inWeek(3), 'success');
    const report = await health(s);
    const tests = area(report, 'tests');
    expect(tests).toMatchObject({
      thisWeek: 25,
      lastWeek: 0,
      trend: 'same',
      detail: '75% of 4 runs passed this week',
    });
    expect(`${tests.status} ${tests.detail}`).not.toMatch(
      /worse|down|was|more/i
    );
    // "Got worse" is never said of a row with nothing to compare against.
    expect(report.summary).toBe('Nothing got worse this week.');
  });

  it('says so when no tests have run', async () => {
    const quiet = await crewRepo();
    expect(area(await health(quiet), 'tests')).toMatchObject({
      thisWeek: 0,
      lastWeek: 0,
      trend: 'same',
      status: 'No tests have run yet',
      detail: 'No test runs this week',
      open: 0,
    });
  });

  it('counts merges, reverts and clashes fixed for merging', async () => {
    const s = await crewRepo();
    const a = await pr(s, 1, { mergedAt: inWeek(0) });
    await pr(s, 2, { mergedAt: inWeek(0) });
    await pr(s, 3, { mergedAt: inWeek(1) });
    const admin = await idOf(s, 'octocat');
    for (const weeksAgo of [0, 0, 2])
      await exec(
        s,
        `INSERT INTO audit_events (id, repository_id, actor_id, actor_kind, action, target, data, created_at)
         VALUES (?, ?, ?, 'person', 'pull.reverted', '#1', '{}', ?)`,
        crypto.randomUUID(),
        s.repoId,
        admin,
        inWeek(weeksAgo)
      );
    await exec(
      s,
      `INSERT INTO merge_resolutions (id, pull_request_id, base_sha, head_sha, commit_sha, status, model, conflicted_paths,
                                      created_at, decided_at)
       VALUES (?, ?, 'b', 'h', 'c', 'applied', 'm', '[]', ?, ?)`,
      crypto.randomUUID(),
      a,
      Math.floor(inWeek(0) / 1000),
      Math.floor(inWeek(0) / 1000)
    );
    expect(area(await health(s), 'merging')).toEqual({
      id: 'merging',
      label: 'Merging',
      color: null,
      agent: null,
      thisWeek: 2,
      lastWeek: 0,
      weeks: [0, 0, 0, 0, 0, 1, 0, 2],
      trend: 'worse',
      status: '2 merged this week, 1 clash fixed by GitOrange',
      detail: '2 reverts this week, 2 more than last week',
      open: 0,
    });
  });

  it('says nothing got worse when no row did, and counts decisions waiting', async () => {
    const s = await crewRepo();
    await s.branch('a');
    await s.web('a');
    const report = await health(s);
    expect(report.summary).toBe('Nothing got worse this week.');
    // The open pull request needs a person to approve it.
    expect(report.decisionsWaiting).toBe(1);
    expect(area(report, 'merging')).toMatchObject({
      status: 'Nothing merged this week',
      detail: 'No reverts this week or last',
      trend: 'same',
    });
  });

  it('names several rows that got worse in one sentence', async () => {
    const s = await crewRepo();
    await invitedAgent(s.t, s.admin, 'secagent');
    const p = await pr(s, 1, { mergedAt: inWeek(0) });
    await findings(s, p, 'secagent', inWeek(0), 1);
    // Last week's passing run is the baseline: without one there is nothing for the tests to be worse than.
    await mainRun(s, inWeek(1), 'success');
    await mainRun(s, inWeek(0), 'failure');
    expect((await health(s)).summary).toBe(
      'secagent agent and Tests on main got worse this week.'
    );
  });

  it('lists people and coding sessions that merged this week, with the findings on their changes', async () => {
    const s = await crewRepo();
    await invitedAgent(s.t, s.admin, 'secagent');
    await addMember(s.t, s.admin, 'ada');
    const s4a = await pr(s, 1, {
      mergedAt: inWeek(0),
      via: 'Claude Code',
      session: 's4',
    });
    await pr(s, 2, { mergedAt: inWeek(0), via: 'Claude Code', session: 's4' });
    await pr(s, 3, { mergedAt: inWeek(0), author: 'ada' });
    // Last week only: not listed.
    await pr(s, 4, { mergedAt: inWeek(1), author: 'octocat' });
    await findings(s, s4a, 'secagent', inWeek(0), 2);
    await findings(s, s4a, 'secagent', inWeek(1), 1);

    const { contributors } = await health(s);
    expect(contributors).toEqual([
      {
        who: {
          kind: 'session',
          label: 's4',
          login: 'octocat',
          client: 'Claude Code',
        },
        merged: 2,
        findings: 2,
        note: '2 findings on #1',
        trend: 'worse',
      },
      {
        who: { kind: 'person', label: 'ada', login: 'ada', client: null },
        merged: 1,
        findings: 0,
        note: null,
        trend: 'same',
      },
    ]);
  });

  it('counts open findings per agent from the pull requests’ current state', async () => {
    const s = await crewRepo({ actions: true });
    await invitedAgent(s.t, s.admin, 'secagent');
    await s.branch('a');
    await s.web('a');
    await startReview(s.t);
    // Two change requests for the author's agent and one finding for a person.
    await runReviews(s.t, agentModels({ review: () => FINDINGS }).models);
    const report = await health(s);
    expect(area(report, 'agent:secagent')).toMatchObject({
      thisWeek: 3,
      open: 3,
      status: '3 open problems',
    });
    expect(report.decisionsWaiting).toBe(1);
  });

  it('is readable by anyone who can read the repository; 404 for others', async () => {
    const s = await crewRepo();
    const bob = await addMember(s.t, s.admin, 'bob');
    expect((await call(s.t, `${BASE}/health`, { cookie: bob })).status).toBe(
      200
    );
    await s.setRepo('visibility', 'private');
    expect((await call(s.t, `${BASE}/health`, { cookie: bob })).status).toBe(
      404
    );
  });
});
