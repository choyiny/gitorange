/** Lesson fixtures: a pull request whose agent findings people dismissed, closing or merging it, lesson rows. */
import { expect } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../../db/schema';
import type { LearnerApi, LearnStartRequest } from '../../learn/contract';
import { executeLearn } from '../../learn/run';
import type { AgentReview } from '../../review/contract';
import { call, settle, type TestEnv } from './app';
import {
  AGENT_MD,
  agentModels,
  appRepo,
  fakePi,
  invitedAgent,
  openPull,
  runReviews,
  startReview,
  step,
  type FakePiAnswer,
} from './reviews';

export const CHANGE = { 'src/auth.ts': 'export const token = "x";\n' };

/** One agent finding on src/auth.ts. */
export const finding = (
  kind: 'needs_person' | 'change_requested',
  title: string
) => ({
  kind,
  title,
  detail: `${title}: the token is written to the log.`,
  changes: [],
  diagram: null,
  snippets: [],
  paths: ['src/auth.ts'],
});

/** Two change requests and a finding for a person. */
export const FINDINGS: AgentReview = {
  verdict: 'findings',
  summary: 'Three concerns.',
  findings: [
    finding('change_requested', 'Token logged'),
    finding('change_requested', 'No expiry'),
    finding('needs_person', 'Secret rotation'),
  ],
};

export const ONE_CHANGE_REQUEST: AgentReview = {
  verdict: 'findings',
  summary: 'One concern.',
  findings: [finding('change_requested', 'Token logged')],
};

/** The AGENT.md each fixture agent starts with. */
export const agentMd = (handle: string) =>
  AGENT_MD({ name: `${handle} agent` });

/** octocat/app with `handles` invited, pull request #1 changing src/auth.ts, reviewed: every agent answers `review`. */
export async function reviewedPull(
  handles: string[] = ['secagent'],
  review: AgentReview = FINDINGS
) {
  const { t, admin, repo } = await appRepo();
  for (const h of handles) await invitedAgent(t, admin, h, agentMd(h));
  const pull = await openPull(t, admin, repo, CHANGE);
  await startReview(t);
  await runReviews(t, agentModels({ review: () => review }).models);
  return { t, admin, repo, head: pull.head };
}

export type FlagRef = {
  id: string;
  agent: string;
  kind: string;
  title: string;
};

/** Pull request `number`'s agent findings, by agent handle, then in the order the agent gave them. */
export async function findings(t: TestEnv, number = 1): Promise<FlagRef[]> {
  return (
    await t.env.DB.prepare(
      `SELECT f.id, u.username AS agent, f.kind, json_extract(f.value, '$.title') AS title
         FROM pr_review_flags f
         JOIN users u ON u.id = f.agent_id
         JOIN pr_classifications c ON c.id = f.classification_id
         JOIN pull_requests p ON p.id = c.pull_request_id
        WHERE p.number = ?
        ORDER BY u.username, c.created_at, f.key`
    )
      .bind(number)
      .all<FlagRef>()
  ).results;
}

/** Dismisses a change request (or approves a finding for a person) on pull request `number`, as `cookie`. */
export async function decide(
  t: TestEnv,
  cookie: string,
  id: string,
  number = 1
) {
  const res = await call(
    t,
    `/api/repos/octocat/app/pulls/${number}/review/flags/${id}/approve`,
    { cookie, method: 'POST' }
  );
  expect(res.status).toBe(200);
  await settle(t);
}

/** Closes (or reopens) pull request `number` through the web route. */
export async function closePull(
  t: TestEnv,
  cookie: string,
  state: 'closed' | 'open' = 'closed',
  number = 1
) {
  const res = await call(t, `/api/repos/octocat/app/pulls/${number}`, {
    cookie,
    method: 'PATCH',
    json: { state },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  await settle(t);
}

/** Approves and merges pull request `number` (landPull). */
export async function mergePull(t: TestEnv, cookie: string, number = 1) {
  const res = await call(t, `/api/repos/octocat/app/pulls/${number}/merge`, {
    cookie,
    json: { approve: true },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  await settle(t);
}

export type LessonRow = {
  id: string;
  agent: string;
  agent_id: string;
  pull_request_id: string;
  repository_id: string;
  finding_ids: string;
  status: string;
  run_id: string | null;
  attempts: number;
  retryable: number;
  base_sha: string | null;
  commit_sha: string | null;
  summary: string | null;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
};

/** Every lesson, by agent handle, oldest first. */
export async function lessons(t: TestEnv): Promise<LessonRow[]> {
  return (
    await t.env.DB.prepare(
      `SELECT l.*, u.username AS agent FROM agent_lessons l JOIN users u ON u.id = l.agent_id
        ORDER BY u.username, l.created_at, l.rowid`
    ).all<LessonRow>()
  ).results;
}

/** The learner's summary in the fixtures. */
export const SUMMARY =
  'Test fixtures hold fake tokens.\nSaid so in the instructions.';

/** `agentMd(handle)` with one more instruction: what the fixtures' learner writes. */
export const learnedMd = (handle: string) =>
  AGENT_MD({
    name: `${handle} agent`,
    body: 'Look for leaked secrets.\nTokens in test fixtures are fake: never flag them.',
  });

/** octocat/app; @secagent's two change requests on #1 dismissed by octocat; #1 closed: one lesson queued. */
export async function closedLesson() {
  const s = await reviewedPull();
  for (const f of (await findings(s.t)).filter(
    (f) => f.kind === 'change_requested'
  ))
    await decide(s.t, s.admin, f.id);
  await closePull(s.t, s.admin);
  return s;
}

/**
 * A scripted learner per object name: fakePi's objects (`answer(n, request)` is what its n-th status() reports; each
 * check adds 2 model calls, 4 tool calls, 1,000 input and 100 output tokens per call; a stopped object reports
 * `missing`), started with startLearning. `files(request)` is what learned() returns.
 */
export function fakeLearner(
  answer: (
    n: number,
    request: LearnStartRequest
  ) => FakePiAnswer | Promise<FakePiAnswer> = () => ({
    state: 'done',
    text: 'Nothing general to learn.',
  }),
  opts: {
    files?: (request: LearnStartRequest) => Record<string, string | null>;
    startedAt?: number;
  } = {}
) {
  const pi = fakePi<LearnStartRequest>(answer, { startedAt: opts.startedAt });
  const api = (name: string): LearnerApi => {
    const o = pi.api(name);
    return {
      startLearning: (request) => o.start(request),
      status: () => o.status(),
      stop: () => o.stop(),
      async learned() {
        const object = pi.objects.get(name);
        return {
          files: object && opts.files ? opts.files(object.request) : {},
        };
      },
    };
  };
  return { api, objects: pi.objects, starts: pi.starts, stopped: pi.stopped };
}

type LearnPayload = { learn?: { lessonId: string } };

/** The learn Workflows started so far. */
export const learnRuns = (t: TestEnv) =>
  t.actions.resolutions.filter((s) => (s.params as LearnPayload).learn);

const ranLessons = new WeakMap<TestEnv, Set<string>>();

/** Runs every learn Workflow started so far (once each), inline, until none are left. No learner: Pi isn't set up. */
export async function runLessons(
  t: TestEnv,
  learner?: (name: string) => LearnerApi
) {
  const db = drizzle(t.env.DB, { schema });
  const done = ranLessons.get(t) ?? new Set<string>();
  ranLessons.set(t, done);
  for (;;) {
    await settle(t);
    const next = learnRuns(t).find((s) => !done.has(s.id));
    if (!next) return;
    done.add(next.id);
    await executeLearn(
      { env: t.env, db, step, learner, instanceId: next.id },
      (next.params as Required<LearnPayload>).learn.lessonId
    );
  }
}
