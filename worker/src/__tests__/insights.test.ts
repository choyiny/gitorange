import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { schema } from '../db/schema';
import {
  agents,
  mergeResolutions,
  prReviewers,
  repositoryAgents,
  prClassifications,
  prReviewFlags,
  pullRequests,
  repositories,
  workflowRuns,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import { TOOL_HANDLERS } from '../mcp/tools';
import type { RepoInsights } from '../lib/insights';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  type TestEnv,
} from './helpers/app';

const HOUR = 3600;
const DAY = 86400;

/**
 * A repository with a known history, written straight into D1 (timestamps relative to now):
 *  #1 auto-merged, hands off: reviewed with no flags, CI red then green 30 min after opening
 *  #2 auto-merged after two flags were approved; AI resolution failed, then applied
 *  #3 merged by a person after 3 days, never reviewed
 *  #4 closed without merging; its review failed
 *  #5 open: two reviews, the latest with one unapproved flag; resolution proposed
 *  #6 merged long ago (outside every period but a year)
 */
async function seed(t: TestEnv, cookie: string, name = 'app') {
  const res = await call(t, '/api/repos', {
    cookie,
    json: { name, visibility: 'internal' },
  });
  expect(res.status).toBe(201);
  const db = drizzle(t.env.DB, { schema });
  const repo = (await db
    .select()
    .from(repositories)
    .where(eq(repositories.name, name))
    .get())!;
  const admin = (await db
    .select()
    .from(users)
    .where(eq(users.username, 'octocat'))
    .get())!;

  const now = Math.floor(Date.now() / 1000);
  const at = (secondsAgo: number) => new Date((now - secondsAgo) * 1000);
  const pr = (
    number: number,
    opened: number,
    extra: Partial<typeof pullRequests.$inferInsert> = {}
  ) => ({
    id: `${repo.id}-pr${number}`,
    repositoryId: repo.id,
    number,
    title: `PR ${number}`,
    authorId: admin.id,
    baseRef: 'main',
    headRef: `f${number}`,
    createdAt: at(opened),
    updatedAt: at(opened),
    ...extra,
  });
  await db.insert(pullRequests).values([
    pr(1, 10 * DAY, {
      state: 'merged',
      mergedAutomatically: true,
      mergedAt: at(9 * DAY),
      closedAt: at(9 * DAY),
    }),
    pr(2, 5 * DAY, {
      state: 'merged',
      mergedAutomatically: true,
      mergedAt: at(5 * DAY - 2 * HOUR),
      closedAt: at(5 * DAY - 2 * HOUR),
    }),
    pr(3, 20 * DAY, {
      state: 'merged',
      mergedById: admin.id,
      mergedAt: at(17 * DAY),
      closedAt: at(17 * DAY),
    }),
    pr(4, 4 * DAY, { state: 'closed', closedAt: at(3 * DAY) }),
    pr(5, 2 * DAY),
    pr(6, 120 * DAY, {
      state: 'merged',
      mergedAutomatically: true,
      mergedAt: at(100 * DAY),
      closedAt: at(100 * DAY),
    }),
  ]);
  const id = (n: number) => `${repo.id}-pr${n}`;
  const review = (
    key: string,
    n: number,
    ago: number,
    status: 'done' | 'failed'
  ) => ({
    id: `${id(n)}-${key}`, // a head review's id: <pull request id>-<head sha>
    pullRequestId: id(n),
    headSha: key,
    status,
    summaryModel: 'glm',
    classifierModel: 'clef',
    createdAt: at(ago),
  });
  await db
    .insert(prClassifications)
    .values([
      review('c1', 1, 10 * DAY, 'done'),
      review('c2', 2, 5 * DAY, 'done'),
      review('c4', 4, 4 * DAY, 'failed'),
      review('c5a', 5, 2 * DAY, 'done'),
      review('c5b', 5, DAY, 'done'),
    ]);
  const reviewPull: Record<string, number> = {
    c1: 1,
    c2: 2,
    c4: 4,
    c5a: 5,
    c5b: 5,
  };
  // The admin's user row stands in for an agent; lintbot is a second one, no longer invited.
  const bot = `${repo.id}-lintbot`;
  await db.insert(users).values({
    id: bot,
    name: 'Lint bot',
    email: `${bot}@test.local`,
    username: 'lintbot',
  });
  const flag = (
    key: string,
    classification: string,
    agentId: string,
    index: number,
    ago: number,
    approvedAfter?: number
  ) => ({
    id: `${repo.id}-${key}`,
    classificationId: `${id(reviewPull[classification])}-${classification}`,
    source: 'agent' as const,
    key: `${agentId}:${index}`,
    value: { title: key },
    agentId,
    kind: 'needs_person' as const,
    paths: [],
    createdAt: at(ago),
    ...(approvedAfter !== undefined
      ? { approvedById: admin.id, approvedAt: at(ago - approvedAfter) }
      : {}),
  });
  await db.insert(agents).values(
    [admin.id, bot].map((userId) => ({
      userId,
      name: 'Stand-in',
      triggerAsk: 'Anything?',
      triggerAbove: 0.5,
      createdAt: at(30 * DAY),
    }))
  );
  await db
    .insert(repositoryAgents)
    .values({ repositoryId: repo.id, agentId: admin.id, createdAt: at(DAY) });
  await db.insert(prReviewers).values({
    id: `${repo.id}-rv5`,
    pullRequestId: id(5),
    headSha: 'c5b',
    agentId: admin.id,
    requested: true,
    status: 'flagged',
    createdAt: at(DAY),
  });
  // #5's branch is at its newer reviewed commit.
  t.fake.repos.get(repo.artifactsName)!.refs.set('refs/heads/f5', 'c5b');
  await db.insert(prReviewFlags).values([
    flag('f1', 'c2', admin.id, 0, 5 * DAY, HOUR),
    flag('f2', 'c2', bot, 0, 5 * DAY, 3 * HOUR),
    flag('f3', 'c5a', admin.id, 0, 2 * DAY),
    // lintbot isn't invited and has no reviewer row: its finding doesn't wait for anyone.
    flag('f4', 'c5b', bot, 0, DAY),
    flag('f5', 'c5b', admin.id, 0, DAY),
  ]);
  const resolution = (
    key: string,
    n: number,
    ago: number,
    status: 'failed' | 'applied' | 'proposed',
    model = 'm'
  ) => ({
    id: `${repo.id}-${key}`,
    pullRequestId: id(n),
    baseSha: 'b',
    headSha: 'h',
    status,
    model,
    conflictedPaths: ['a.ts'],
    createdAt: at(ago),
  });
  await db.insert(mergeResolutions).values([
    resolution('r1', 2, 5 * DAY, 'failed'),
    resolution('r2', 2, 5 * DAY - HOUR, 'applied'),
    resolution('r3', 5, DAY, 'proposed'),
    // Conflicts AI can't resolve (binary, delete/edit): recorded, but never an AI attempt.
    resolution('rn', 5, 2 * DAY, 'failed', 'none'),
    resolution('r0', 6, 110 * DAY, 'failed'),
  ]);
  let runNumber = 1;
  const run = (
    ref: string,
    event: 'push' | 'pull_request',
    ago: number,
    conclusion: 'success' | 'failure' | 'cancelled',
    completedAfter = 600
  ) => ({
    id: `${repo.id}-run${runNumber}`,
    repositoryId: repo.id,
    runNumber: runNumber++,
    workflowPath: '.github/workflows/ci.yml',
    name: 'CI',
    event,
    ref,
    headSha: 'h',
    displayTitle: 't',
    status: 'completed' as const,
    conclusion,
    createdAt: at(ago),
    completedAt: at(ago - completedAfter),
  });
  await db
    .insert(workflowRuns)
    .values([
      run('refs/pull/1/head', 'pull_request', 10 * DAY, 'failure'),
      run('refs/pull/1/head', 'pull_request', 10 * DAY - 1200, 'success'),
      run('refs/pull/2/head', 'pull_request', 5 * DAY - 3000, 'success'),
      run('refs/pull/5/head', 'pull_request', DAY, 'cancelled'),
      run('refs/heads/main', 'push', DAY, 'success'),
    ]);
}

async function insights(t: TestEnv, cookie: string, query = '', repo = 'app') {
  const res = await call(t, `/api/repos/octocat/${repo}/insights${query}`, {
    cookie,
  });
  return { status: res.status, body: (await res.json()) as RepoInsights };
}

describe('repository insights', () => {
  it('counts pull requests, auto-merges, human review, resolutions, and CI over 30 days', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await seed(t, admin);
    const { status, body } = await insights(t, admin);
    expect(status).toBe(200);
    expect(body.days).toBe(30);
    expect(body.pulls).toEqual({
      opened: 5,
      merged: 3,
      autoMerged: 2,
      mergedByPerson: 1,
      autoMergeShare: 2 / 3,
      mergedAfterHumanReview: 1,
      mergedHandsOff: 1,
      closedUnmerged: 1,
      openNow: 1,
    });
    // Medians: [1 day, 2 hours, 3 days]; auto [1 day, 2 hours]; person [3 days].
    expect(body.timeToMerge).toEqual({
      all: DAY,
      auto: (DAY + 2 * HOUR) / 2,
      person: 3 * DAY,
    });
    expect(body.reviews).toEqual({
      runs: 5,
      completed: 4,
      failed: 1,
      autoVerdicts: 1,
      humanVerdicts: 3,
      pullsReviewed: 4,
      pullsNeedingHuman: 2,
    });
    expect(body.flags).toEqual({
      raised: 5,
      approved: 2,
      medianTimeToApproval: 2 * HOUR,
      // Only the agent's finding for a person on #5's head review waits (the Approvals rule).
      pendingNow: 1,
      pendingPullsNow: 1,
      byKind: [
        { key: 'octocat', title: '@octocat', raised: 3, approved: 1 },
        { key: 'lintbot', title: '@lintbot', raised: 2, approved: 1 },
      ],
    });
    expect(body.resolutions).toEqual({
      attempts: 3,
      succeeded: 2,
      applied: 1,
      failed: 1,
      rejected: 0,
      inProgress: 0,
      pulls: 2,
    });
    // Push runs don't count; time to green: #1 after 30 min, #2 after 1 hour.
    expect(body.ci).toEqual({
      runs: 4,
      succeeded: 2,
      failed: 1,
      cancelled: 1,
      passRate: 2 / 3,
      medianTimeToGreen: 45 * 60,
    });
  });

  it('narrows to the chosen period, and reports nothing for an idle repository', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await seed(t, admin);
    const week = (await insights(t, admin, '?days=7')).body;
    expect(week.pulls).toMatchObject({
      opened: 3,
      merged: 1,
      autoMerged: 1,
      autoMergeShare: 1,
      closedUnmerged: 1,
      openNow: 1,
    });
    expect(week.timeToMerge).toEqual({
      all: 2 * HOUR,
      auto: 2 * HOUR,
      person: null,
    });
    const year = (await insights(t, admin, '?days=365')).body;
    expect(year.pulls.merged).toBe(4);
    expect(year.resolutions.attempts).toBe(4);

    expect((await insights(t, admin, '?days=12')).status).toBe(400);

    await call(t, '/api/repos', { cookie: admin, json: { name: 'idle' } });
    const idle = (await insights(t, admin, '', 'idle')).body;
    expect(idle.pulls.opened).toBe(0);
    expect(idle.pulls.autoMergeShare).toBeNull();
    expect(idle.timeToMerge.all).toBeNull();
    expect(idle.flags.byKind).toEqual([]);
    expect(idle.ci.passRate).toBeNull();
  });

  it('follows the read permission: hidden from people who cannot see a private repository', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const mona = await addMember(t, admin, 'mona');
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'secret', visibility: 'private' },
    });
    expect((await insights(t, mona, '', 'secret')).status).toBe(404);
    await seed(t, admin);
    expect((await insights(t, mona)).status).toBe(200);
  });

  it('is available to agents as a read-only MCP tool', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await seed(t, admin);
    const db = drizzle(t.env.DB, { schema });
    const user = (await db
      .select()
      .from(users)
      .where(eq(users.username, 'octocat'))
      .get())!;
    const tool = TOOL_HANDLERS.get('gitorange_get_repository_insights')!;
    expect(tool.definition.annotations.readOnlyHint).toBe(true);
    const ctx = {
      db,
      env: t.env,
      user: user as never,
      baseURL: 'http://test.local',
      after: () => {},
      moderator: null,
    };
    const result = await tool.handler(
      { repository: 'octocat/app', days: 7 },
      ctx
    );
    const out = JSON.parse(result.content[0].text);
    expect(out.full_name).toBe('octocat/app');
    expect(out.days).toBe(7);
    expect(out.pulls.auto_merged).toBe(1);
    expect(out.pulls.auto_merge_share).toBe(1);
    expect(out.flags.pending_now).toBe(1);
    expect(out.flags.by_kind[0].key).toBe('octocat');
    expect(out.web_url).toBe('http://test.local/octocat/app/insights?days=7');
    await expect(
      tool.handler({ repository: 'octocat/app', days: 3 }, ctx)
    ).rejects.toThrow(/days must be one of/);
    await expect(
      tool.handler({ repository: 'octocat/nope' }, ctx)
    ).rejects.toThrow(/No repository named/);
  });
});
