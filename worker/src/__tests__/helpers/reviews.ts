/** Shared fixtures for reviewer-agent reviews: a repository with invited agents, fake models, inline Workflows. */
import { expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../../db/schema';
import { pullRequests, repositories } from '../../db/app.schema';
import type { StepRunner } from '../../merge/resolution';
import type { AgentReview, AgentReviewInput } from '../../review/contract';
import {
  ensureHeadReview,
  executeHeadReview,
  executeReviewerRetry,
} from '../../review/head';
import type { AgentReviewModels } from '../../review/models';
import type {
  PiLimits,
  PiReviewerApi,
  PiStartRequest,
  PiStartResult,
  PiStatus,
} from '../../review/pi-contract';
import { agentRepo, newAgent } from './agents';
import { bootstrapAdmin, call, makeEnv, settle, type TestEnv } from './app';
import type { FakeRepo } from './fake-artifacts';
import { commitPaths } from './seed';

export const step = {
  do: async (_name: string, a: unknown, b?: unknown) =>
    ((b ?? a) as () => Promise<unknown>)(),
  sleep: async () => {},
  // No event ever arrives in tests: every Pi review is driven by its checks, as after a lost event.
  waitForEvent: async (name: string) => {
    throw new Error(`${name}: timed out`);
  },
} as unknown as StepRunner;

export const AGENT_MD = (
  o: {
    name?: string;
    ask?: string;
    above?: number | string;
    engine?: string;
    body?: string;
  } = {}
) => `---
name: ${JSON.stringify(o.name ?? 'Security Agent')}
trigger:
  ask: ${JSON.stringify(o.ask ?? 'Does this touch authentication?')}
  above: ${o.above ?? 0.5}
engine: ${o.engine ?? 'pass'}
---
${o.body ?? 'Look for leaked secrets.'}
`;

export const BASE = { 'src/app.ts': 'export const a = 1;\n' };

/** octocat/app (internal), created first so it is the fake's first repository. */
export async function appRepo() {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'internal' },
  });
  return { t, admin, repo: [...t.fake.repos.values()][0] };
}

/** Creates agent `handle`, sets its repository's main to `md` (plus `extra` files), and invites it. */
export async function invitedAgent(
  t: TestEnv,
  admin: string,
  handle = 'secagent',
  md = AGENT_MD(),
  extra: Record<string, string> = {},
  repoFullName = 'octocat/app'
) {
  await newAgent(t, admin, handle, `${handle} agent`);
  const repo = await agentRepo(t, handle);
  const sha = await commitPaths(
    repo,
    'main',
    { 'AGENT.md': md, ...extra },
    'Configure agent'
  );
  const res = await call(t, `/api/repos/${repoFullName}/agents/${handle}`, {
    cookie: admin,
    method: 'PUT',
  });
  expect(res.status).toBe(200);
  return { repo, sha };
}

/** Opens a pull request on octocat/app from `branch` (off main), whose tree is `base` plus `changes`. */
export async function openPull(
  t: TestEnv,
  admin: string,
  repo: FakeRepo,
  changes: Record<string, string>,
  opts: { base?: Record<string, string>; branch?: string; title?: string } = {}
) {
  const base = opts.base ?? BASE;
  const branch = opts.branch ?? 'feature';
  const main =
    repo.refs.get('refs/heads/main') ??
    (await commitPaths(repo, 'main', base, 'base'));
  repo.refs.set(`refs/heads/${branch}`, main);
  const title = opts.title ?? 'Change things';
  const head = await commitPaths(repo, branch, { ...base, ...changes }, title);
  const res = await call(t, '/api/repos/octocat/app/pulls', {
    cookie: admin,
    json: { title, body: 'Some changes.', base: 'main', head: branch },
  });
  expect(res.status).toBe(201);
  const { number } = (await res.json()) as { number: number };
  await settle(t);
  return { head, number };
}

/** Starts the review of pull request `number`'s current head in repository `repoName` (as a push would). */
export async function startReview(t: TestEnv, number = 1, repoName = 'app') {
  const db = drizzle(t.env.DB, { schema });
  const row = await db
    .select()
    .from(pullRequests)
    .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
    .where(
      and(eq(repositories.name, repoName), eq(pullRequests.number, number))
    )
    .get();
  const head = t.fake.repos
    .get(row!.repositories.artifactsName)!
    .refs.get(`refs/heads/${row!.pull_requests.headRef}`)!;
  return ensureHeadReview(t.env, db, row!.pull_requests, { head });
}

export const APPROVE: AgentReview = {
  verdict: 'approve',
  summary: 'Nothing for me here.',
  findings: [],
};

export type ReviewCalls = {
  summarized: string[];
  triggered: { state: unknown; questions: Record<string, string> }[];
  reviewed: AgentReviewInput[];
};

/**
 * Fake models. Clef answers `probabilities[handle]` (0.9 when unset; nothing for `omit`); each agent's review
 * answers `review(input)` (approve when unset), or throws for the handles in `failReview`.
 */
export function agentModels(
  opts: {
    probabilities?: Record<string, number>;
    omit?: string[];
    failTrigger?: boolean;
    onTrigger?: () => Promise<unknown>;
    review?: (i: AgentReviewInput) => AgentReview | Promise<AgentReview>;
    failReview?: string[];
  } = {}
): { models: AgentReviewModels; calls: ReviewCalls } {
  const calls: ReviewCalls = { summarized: [], triggered: [], reviewed: [] };
  return {
    calls,
    models: {
      reviewModelId: '@cf/zai-org/glm-5.3',
      summarize: async (f) => {
        calls.summarized.push(f.path);
        return `Changes ${f.path}.`;
      },
      trigger: async (state, questions) => {
        if (opts.failTrigger) throw new Error('Clef down');
        calls.triggered.push({ state, questions });
        await opts.onTrigger?.();
        return Object.fromEntries(
          Object.keys(questions)
            .filter((h) => !opts.omit?.includes(h))
            .map((h) => [h, opts.probabilities?.[h] ?? 0.9])
        );
      },
      review: async (input) => {
        if (opts.failReview?.includes(input.handle))
          throw new Error('model down');
        calls.reviewed.push(input);
        return (await opts.review?.(input)) ?? APPROVE;
      },
    },
  };
}

type Payload = { headReview?: { id: string }; reviewer?: { id: string } };
const ran = new WeakMap<TestEnv, Set<string>>();

export type FakePiAnswer =
  | { state: 'running' }
  | { state: 'done'; text: string }
  | { state: 'unanswered'; reason: string }
  | { state: 'missing' };

/** What fakePi's objects are started with: a review's request, or (fakeLearner) a lesson's. */
type FakePiRequest = { model: string; limits: PiLimits };

/** A fake object's start, status and stop, for any request type `R`. */
export type FakePiApi<R extends FakePiRequest = PiStartRequest> = {
  start(request: R): Promise<PiStartResult>;
  status(): Promise<PiStatus>;
  stop(): Promise<void>;
};

/**
 * A scripted AgentReviewer per DO name: `answer(n, request)` is what its n-th status() reports (1-based). Each check
 * adds `turnsPerCheck` model calls (2), twice as many tool calls, 1,000 input and 100 output tokens per call.
 * Records every start (by name) and every stop; a stopped object reports `missing`. Its start returns the request's
 * model and limits (what a real DO runs with), or `effective` where given; `failStart` makes start throw after the
 * object exists (as a start step that timed out after the DO began). `R`: the request type (a lesson's for
 * fakeLearner).
 */
export function fakePi<R extends FakePiRequest = PiStartRequest>(
  answer: (
    n: number,
    request: R
  ) => FakePiAnswer | Promise<FakePiAnswer> = () => ({
    state: 'done',
    text: JSON.stringify(APPROVE),
  }),
  opts: {
    startedAt?: number;
    turnsPerCheck?: number;
    failStart?: boolean;
    effective?: { model?: string; limits?: Partial<PiLimits> };
  } = {}
) {
  const objects = new Map<
    string,
    {
      request: R;
      startedAt: number;
      checks: number;
      stopped: boolean;
    }
  >();
  const starts: string[] = [];
  const stopped: string[] = [];
  const api = (name: string): FakePiApi<R> => ({
    async start(request) {
      starts.push(name);
      const o = objects.get(name) ?? {
        request,
        startedAt: opts.startedAt ?? Date.now(),
        checks: 0,
        stopped: false,
      };
      objects.set(name, o);
      if (opts.failStart) throw new Error('start timed out');
      return {
        startedAt: o.startedAt,
        model: opts.effective?.model ?? o.request.model,
        limits: { ...o.request.limits, ...opts.effective?.limits },
      };
    },
    async status(): Promise<PiStatus> {
      const o = objects.get(name);
      const none = {
        turns: 0,
        toolCalls: 0,
        tokensIn: null,
        tokensOut: null,
        tokensCached: null,
      };
      if (!o || o.stopped) return { state: 'missing', startedAt: 0, ...none };
      o.checks += 1;
      const a = await answer(o.checks, o.request);
      const turns = o.checks * (opts.turnsPerCheck ?? 2);
      return {
        ...a,
        startedAt: o.startedAt,
        turns,
        toolCalls: turns * 2,
        tokensIn: turns * 1000,
        tokensOut: turns * 100,
        tokensCached: 0,
      } as PiStatus;
    },
    async stop() {
      const o = objects.get(name);
      if (o) o.stopped = true;
      stopped.push(name);
    },
  });
  return { api, objects, starts, stopped };
}

/** Runs every review Workflow started so far (once each), inline, until none are left. */
export async function runReviews(
  t: TestEnv,
  models: AgentReviewModels,
  opts: { pi?: (name: string) => PiReviewerApi } = {}
) {
  const db = drizzle(t.env.DB, { schema });
  const done = ran.get(t) ?? new Set<string>();
  ran.set(t, done);
  for (;;) {
    await settle(t);
    const next = t.actions.resolutions.find((s) => {
      const p = s.params as Payload;
      return !done.has(s.id) && (p.headReview || p.reviewer);
    });
    if (!next) return;
    done.add(next.id);
    const p = next.params as Payload;
    const deps = {
      env: t.env,
      db,
      step,
      models,
      pi: opts.pi,
      instanceId: next.id,
    };
    if (p.headReview) await executeHeadReview(deps, p.headReview.id);
    else if (p.reviewer) await executeReviewerRetry(deps, p.reviewer.id);
  }
}

export type ReviewerRow = {
  id: string;
  agent: string;
  status: string;
  requested: number;
  probability: number | null;
  agent_sha: string | null;
  summary: string | null;
  error: string | null;
  head_sha: string;
};

/** Pull request `number` of octocat/app's reviewer rows, oldest first, then by handle. */
export async function reviewers(t: TestEnv, number = 1) {
  return (
    await t.env.DB.prepare(
      `SELECT r.id, u.username AS agent, r.status, r.requested, r.probability, r.agent_sha, r.summary, r.error,
              r.head_sha
         FROM pr_reviewers r
         JOIN users u ON u.id = r.agent_id
         JOIN pull_requests p ON p.id = r.pull_request_id
         JOIN repositories x ON x.id = p.repository_id
        WHERE x.name = 'app' AND p.number = ?
        ORDER BY r.created_at, u.username`
    )
      .bind(number)
      .all<ReviewerRow>()
  ).results;
}

export type FlagRow = {
  id: string;
  agent: string | null;
  kind: string;
  key: string;
  value: string | null;
  paths: string;
  detail: string | null;
  agent_sha: string | null;
  approved_at: number | null;
};

/** Every review flag, by key. */
export async function flags(t: TestEnv) {
  return (
    await t.env.DB.prepare(
      `SELECT f.id, u.username AS agent, f.kind, f.key, f.value, f.paths, f.detail, f.agent_sha,
              f.approved_at
         FROM pr_review_flags f LEFT JOIN users u ON u.id = f.agent_id
        ORDER BY f.key`
    ).all<FlagRow>()
  ).results;
}
