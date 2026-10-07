import { describe, expect, it } from 'vitest';
import { PI_FALLBACK_NOTE, PI_GONE } from '../review/outcome';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import type { StepRunner } from '../merge/resolution';
import {
  executeHeadReview,
  REVIEW_STALE_MS,
  REVIEW_STOPPED,
  stopStaleReviews,
} from '../review/head';
import {
  isWaitTimeout,
  piBudgetSpent,
  PI_CLOSED,
  PI_LOST,
  PI_SUPERSEDED,
  piTimeUp,
} from '../review/pi';
import {
  PI_DEFAULT_LIMITS,
  piChecks,
  piEventType,
  piReviewerName,
} from '../review/pi-contract';
import {
  AGENT_MD,
  agentModels,
  appRepo,
  APPROVE,
  BASE,
  fakePi,
  flags,
  invitedAgent,
  openPull,
  reviewers,
  runReviews,
  startReview,
} from './helpers/reviews';
import { call } from './helpers/app';
import { commitPaths } from './helpers/seed';

const CHANGE = {
  'src/auth.ts': 'export const token = "x";\nexport const ttl = 60;\n',
};

/** Changes a Site admin setting as `cookie` (a site admin). */
const setting = (t: T, cookie: string, key: string, value: unknown) =>
  call(t, `/api/admin/settings/${key}`, {
    cookie,
    method: 'PUT',
    json: { value },
  });

type T = Awaited<ReturnType<typeof appRepo>>['t'];

/** octocat/app with @secagent (engine: pi) invited and pull request #1's head under review. */
async function piReview(
  md = AGENT_MD({ engine: 'pi', body: 'Check tokens.' })
) {
  const { t, admin, repo } = await appRepo();
  const agent = await invitedAgent(t, admin, 'secagent', md);
  const pull = await openPull(t, admin, repo, CHANGE);
  const review = await startReview(t);
  return { t, admin, repo, agentSha: agent.sha, reviewId: review!.id, ...pull };
}

const done = (review: unknown) => ({
  state: 'done' as const,
  text: JSON.stringify(review),
});

const FINDINGS = {
  verdict: 'findings',
  summary: 'Read the token handling and its callers.',
  findings: [
    {
      kind: 'needs_person',
      title: 'Hard-coded token',
      detail: 'Adds a literal token to the source.',
      changes: [{ what: 'token', before: 'none', after: 'literal "x"' }],
      diagram: null,
      snippets: [{ path: 'src/auth.ts', start: 1, end: 1, why: 'the literal' }],
      files: ['src/auth.ts'],
    },
    {
      kind: 'change_requested',
      title: 'Fixed TTL',
      detail: 'Read the TTL from configuration instead of hard-coding 60.',
      changes: [{ what: 'ttl', before: 'none', after: '60' }],
      diagram: null,
      snippets: [],
      files: ['src/auth.ts'],
    },
  ],
};

/** The (only) reviewer row's id and generation. */
async function attempt(t: T) {
  const r = await t.env.DB.prepare(
    'SELECT id, created_at FROM pr_reviewers ORDER BY created_at DESC'
  ).first<{ id: string; created_at: number }>();
  return { id: r!.id, generation: r!.created_at * 1000 };
}

describe('engine: pi', () => {
  it("reviews in the Pi workspace with the single pass's input, and records its approval", async () => {
    const { t, head, agentSha, reviewId } = await piReview();
    const pi = fakePi(() =>
      done({ ...APPROVE, summary: 'Read the callers; fine.' })
    );
    const { models, calls } = agentModels();
    await runReviews(t, models, { pi: pi.api });

    expect((await reviewers(t))[0]).toMatchObject({
      status: 'approved',
      summary: 'Read the callers; fine.',
    });
    expect(calls.reviewed).toEqual([]);
    const { id, generation } = await attempt(t);
    const name = piReviewerName(id, generation);
    expect(pi.starts).toEqual([name]);
    const { request } = pi.objects.get(name)!;
    expect(request).toMatchObject({
      reviewerId: id,
      generation,
      handle: 'secagent',
      headSha: head,
      changedPaths: ['src/auth.ts'],
      model: '@cf/zai-org/glm-5.3',
      limits: PI_DEFAULT_LIMITS,
      ignoreText: null,
      input: {
        handle: 'secagent',
        agentSha,
        instructions: 'Check tokens.',
        title: 'Change things',
      },
    });
    expect(request.input.diffs).toContain('export const token');
    expect(request.notify).toEqual({
      instanceId: expect.stringMatching(/^review-/),
      type: piEventType(id, generation),
    });
    // Ended: the DO is told to delete its workspace and transcript.
    expect(pi.stopped).toEqual([name]);
    const usage = await t.env.DB.prepare(
      "SELECT id, model, requests, tokens_in, tokens_out, classification_id FROM ai_usage WHERE feature = 'review-agent-pi'"
    ).all();
    expect(usage.results).toEqual([
      {
        id: `review-agent-pi:${id}:${generation}`,
        model: '@cf/zai-org/glm-5.3',
        requests: 2,
        tokens_in: 2000,
        tokens_out: 200,
        classification_id: reviewId,
      },
    ]);
  });

  it('records findings as agent-owned flags with excerpts cut from the real diff', async () => {
    const { t, agentSha } = await piReview();
    const pi = fakePi(() => done(FINDINGS));
    await runReviews(t, agentModels().models, { pi: pi.api });
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'changes_requested',
      summary: 'Read the token handling and its callers.',
    });
    const [first, second] = await flags(t);
    expect(first).toMatchObject({
      agent: 'secagent',
      kind: 'needs_person',
      agent_sha: agentSha,
    });
    expect(first.detail).toContain('Adds a literal token to the source.');
    expect(first.detail).toContain('```diff\n+export const token = "x";');
    expect(second).toMatchObject({ kind: 'change_requested' });
  });

  it('keeps waiting while Pi works', async () => {
    const { t } = await piReview();
    const pi = fakePi((n) => (n < 4 ? { state: 'running' } : done(APPROVE)));
    await runReviews(t, agentModels().models, { pi: pi.api });
    expect((await reviewers(t))[0].status).toBe('approved');
    const [object] = [...pi.objects.values()];
    expect(object.checks).toBe(4);
  });

  it("fails with the parser's message when Pi's answer isn't the contract", async () => {
    const { t } = await piReview();
    const pi = fakePi(() => ({
      state: 'done',
      text: 'Looks good to me, approving.',
    }));
    await runReviews(t, agentModels().models, { pi: pi.api });
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'failed',
      error: 'The review model failed: The review model did not answer in JSON',
    });
    expect(await flags(t)).toEqual([]);
    expect(pi.stopped).toHaveLength(1);
  });

  // One instance per test (setup runs once), so each case is its own test.
  it('fails when Pi gives up', async () => {
    const gaveUp = await piReview();
    await runReviews(gaveUp.t, agentModels().models, {
      pi: fakePi(() => ({ state: 'unanswered', reason: 'model error' })).api,
    });
    expect((await reviewers(gaveUp.t))[0]).toMatchObject({
      status: 'failed',
      error: 'The review model failed: Pi did not finish (model error).',
    });
  });

  it('fails when its workspace is gone', async () => {
    const lost = await piReview();
    await runReviews(lost.t, agentModels().models, {
      pi: fakePi(() => ({ state: 'missing' })).api,
    });
    expect((await reviewers(lost.t))[0]).toMatchObject({
      status: 'failed',
      error: PI_LOST,
    });
  });

  it('stops a review past the wall clock', async () => {
    const slow = await piReview();
    const late = fakePi(() => ({ state: 'running' }), {
      startedAt: Date.now() - PI_DEFAULT_LIMITS.wallClockMs - 1000,
    });
    await runReviews(slow.t, agentModels().models, { pi: late.api });
    expect((await reviewers(slow.t))[0]).toMatchObject({
      status: 'failed',
      error: piTimeUp(PI_DEFAULT_LIMITS),
    });
    expect(late.stopped).toHaveLength(1);
  });

  it('stops a review over its budget', async () => {
    const costly = await piReview();
    const spender = fakePi(() => ({ state: 'running' }), {
      turnsPerCheck: PI_DEFAULT_LIMITS.maxModelCalls + 1,
    });
    await runReviews(costly.t, agentModels().models, { pi: spender.api });
    expect((await reviewers(costly.t))[0]).toMatchObject({
      status: 'failed',
      error: piBudgetSpent(PI_DEFAULT_LIMITS),
    });
    // Its spend is on the record.
    const usage = await costly.t.env.DB.prepare(
      "SELECT requests FROM ai_usage WHERE feature = 'review-agent-pi'"
    ).first<{ requests: number }>();
    expect(usage!.requests).toBe(PI_DEFAULT_LIMITS.maxModelCalls + 1);
  });

  it('reports a budget the Durable Object enforced itself as the budget being spent', async () => {
    const { t } = await piReview();
    const pi = fakePi(() => ({
      state: 'unanswered',
      reason: 'The Pi review used up its budget (80 model calls).',
    }));
    await runReviews(t, agentModels().models, { pi: pi.api });
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'failed',
      error: piBudgetSpent(PI_DEFAULT_LIMITS),
    });
    expect(pi.stopped).toHaveLength(1);
  });

  it('honours lowered limits from Site admin, read when the review starts', async () => {
    const { t, admin } = await piReview();
    expect(
      (await setting(t, admin, 'review.pi_max_model_calls', 5)).status
    ).toBe(200);
    expect(
      (await setting(t, admin, 'review.pi_max_tool_calls', 12)).status
    ).toBe(200);
    expect((await setting(t, admin, 'review.pi_minutes', 5)).status).toBe(200);
    const lowered = {
      wallClockMs: 5 * 60_000,
      maxToolCalls: 12,
      maxModelCalls: 5,
      maxInputTokens: PI_DEFAULT_LIMITS.maxInputTokens,
    };
    // 6 model calls by the first check: over the lowered budget of 5, far under the default 80.
    const pi = fakePi(() => ({ state: 'running' }), { turnsPerCheck: 6 });
    await runReviews(t, agentModels().models, { pi: pi.api });
    const [object] = [...pi.objects.values()];
    // The DO gets the review's limits (it enforces the tool budget and expires after the wall clock).
    expect(object.request.limits).toEqual(lowered);
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'failed',
      error: piBudgetSpent(lowered),
    });
    expect(piBudgetSpent(lowered)).toBe(
      'The Pi review used up its budget (5 model calls or 4,000,000 input tokens).'
    );
  });

  it('honours a lowered wall clock', async () => {
    const { t, admin } = await piReview();
    expect((await setting(t, admin, 'review.pi_minutes', 5)).status).toBe(200);
    // Started 6 minutes ago: past the lowered 5 minutes, well inside the default 30.
    const pi = fakePi(() => ({ state: 'running' }), {
      startedAt: Date.now() - 6 * 60_000,
    });
    await runReviews(t, agentModels().models, { pi: pi.api });
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'failed',
      error: 'The Pi review ran out of time (5 minutes).',
    });
  });

  it('runs on the deep review model, and records its usage under that model', async () => {
    const { t, admin } = await piReview();
    expect(
      (await setting(t, admin, 'ai.review_pi_model', '@cf/qwen/qwen3-coder'))
        .status
    ).toBe(200);
    const pi = fakePi(() => done(APPROVE));
    await runReviews(t, agentModels().models, { pi: pi.api });
    const [object] = [...pi.objects.values()];
    expect(object.request.model).toBe('@cf/qwen/qwen3-coder');
    const usage = await t.env.DB.prepare(
      "SELECT model FROM ai_usage WHERE feature = 'review-agent-pi'"
    ).all<{ model: string }>();
    expect(usage.results).toEqual([{ model: '@cf/qwen/qwen3-coder' }]);
  });

  it('checks right after a wait times out, but waits the interval out when the wait fails otherwise', async () => {
    expect(isWaitTimeout(new Error('pi-wait:secagent:1: timed out'))).toBe(
      true
    );
    expect(isWaitTimeout(new Error('waitForEvent timeout'))).toBe(true);
    // The Workflows engine's own wording (miniflare), and its error's name.
    expect(isWaitTimeout(new Error('Execution timed out after 120000ms'))).toBe(
      true
    );
    expect(
      isWaitTimeout(
        Object.assign(new Error('gone'), { name: 'WorkflowTimeoutError' })
      )
    ).toBe(true);
    expect(isWaitTimeout(new Error('waitForEvent is not supported'))).toBe(
      false
    );
    const { t, reviewId } = await piReview();
    const pi = fakePi((n) => (n < 3 ? { state: 'running' } : done(APPROVE)));
    const slept: string[] = [];
    const failingWaits = {
      do: async (_name: string, a: unknown, b?: unknown) =>
        ((b ?? a) as () => Promise<unknown>)(),
      sleep: async (name: string) => void slept.push(name),
      waitForEvent: async () => {
        throw new Error('waitForEvent is not supported');
      },
    } as unknown as StepRunner;
    await executeHeadReview(
      {
        env: t.env,
        db: drizzle(t.env.DB, { schema }),
        step: failingWaits,
        models: agentModels().models,
        pi: pi.api,
        instanceId: 'review-failing-waits',
      },
      reviewId
    );
    // One interval before each check, never back-to-back checks; the review still ends on its answer.
    expect(slept.filter((n) => n.startsWith('pi-wait:'))).toEqual([
      'pi-wait:secagent:1:sleep',
      'pi-wait:secagent:2:sleep',
      'pi-wait:secagent:3:sleep',
    ]);
    expect((await reviewers(t))[0].status).toBe('approved');
  });

  it("falls back to a single pass where Pi isn't set up, and says so", async () => {
    const { t } = await piReview();
    const { models, calls } = agentModels();
    await runReviews(t, models);
    expect(calls.reviewed).toHaveLength(1);
    const [row] = await reviewers(t);
    expect(row.status).toBe('approved');
    expect(row.summary).toBe(`${APPROVE.summary} ${PI_FALLBACK_NOTE}`);
  });

  it('reviews engine: pass agents with the single pass even where Pi is set up', async () => {
    const { t } = await piReview(AGENT_MD());
    const pi = fakePi();
    const { models, calls } = agentModels();
    await runReviews(t, models, { pi: pi.api });
    expect(calls.reviewed).toHaveLength(1);
    expect(pi.starts).toEqual([]);
    expect((await reviewers(t))[0].summary).toBe(APPROVE.summary);
  });

  describe('stopping the Durable Object on every way out', () => {
    /** Runs the head review inline with `steps` (waits that time out unless given). */
    const runWith = (
      t: T,
      reviewId: string,
      pi: ReturnType<typeof fakePi>,
      steps: Partial<Record<'waitForEvent' | 'sleep', unknown>> = {}
    ) =>
      executeHeadReview(
        {
          env: t.env,
          db: drizzle(t.env.DB, { schema }),
          step: {
            do: async (_name: string, a: unknown, b?: unknown) =>
              ((b ?? a) as () => Promise<unknown>)(),
            sleep: async () => {},
            waitForEvent: async (name: string) => {
              throw new Error(`${name}: timed out`);
            },
            ...steps,
          } as unknown as StepRunner,
          models: agentModels().models,
          pi: pi.api,
          instanceId: 'review-inline',
        },
        reviewId
      );

    const usageOf = (t: T) =>
      t.env.DB.prepare(
        "SELECT id, model, requests FROM ai_usage WHERE feature = 'review-agent-pi'"
      ).all<{ id: string; model: string; requests: number }>();

    it('stops the reviewer when the start step fails after the object began, and records what it spent', async () => {
      const { t } = await piReview();
      const pi = fakePi(() => ({ state: 'running' }), { failStart: true });
      await runReviews(t, agentModels().models, { pi: pi.api });
      const { id, generation } = await attempt(t);
      expect((await reviewers(t))[0]).toMatchObject({
        status: 'failed',
        error: 'The review failed: start timed out',
      });
      expect(pi.stopped).toEqual([piReviewerName(id, generation)]);
      expect((await usageOf(t)).results).toEqual([
        {
          id: `review-agent-pi:${id}:${generation}`,
          model: '@cf/zai-org/glm-5.3',
          requests: 2,
        },
      ]);
    });

    it('stops a review whose agent is removed mid-review, and writes nothing', async () => {
      const { t, admin } = await piReview();
      const pi = fakePi(async (n) => {
        if (n === 1) {
          const res = await call(t, '/api/repos/octocat/app/agents/secagent', {
            cookie: admin,
            method: 'DELETE',
          });
          expect(res.status).toBe(200);
          return { state: 'running' };
        }
        return done(FINDINGS);
      });
      await runReviews(t, agentModels().models, { pi: pi.api });
      expect(pi.stopped).toHaveLength(1);
      expect(await flags(t)).toEqual([]);
      const row = await t.env.DB.prepare(
        'SELECT status, summary FROM pr_reviewers'
      ).first();
      expect(row).toEqual({
        status: 'not_needed',
        summary: 'Removed from the repository.',
      });
    });

    it('stops a review whose row was deleted mid-review', async () => {
      const { t } = await piReview();
      const pi = fakePi(async (n) => {
        if (n === 1) await t.env.DB.prepare('DELETE FROM pr_reviewers').run();
        return n === 1 ? { state: 'running' } : done(FINDINGS);
      });
      await runReviews(t, agentModels().models, { pi: pi.api });
      expect(pi.stopped).toHaveLength(1);
      expect(await flags(t)).toEqual([]);
    });

    it('stops the reviewer and fails the row when its status keeps failing', async () => {
      const { t, reviewId } = await piReview();
      const pi = fakePi(() => {
        throw new Error('the object is unreachable');
      });
      await runWith(t, reviewId, pi);
      const { id, generation } = await attempt(t);
      expect((await reviewers(t))[0]).toMatchObject({
        status: 'failed',
        error: 'The review failed: the object is unreachable',
      });
      expect(pi.stopped).toEqual([piReviewerName(id, generation)]);
    });

    it('records the spend read best effort when a check fails for good', async () => {
      const { t, reviewId } = await piReview();
      // Running, then a failing check, then (read by the failure step) running again.
      const pi = fakePi((n) => {
        if (n === 2) throw new Error('the object is unreachable');
        return { state: 'running' };
      });
      await runWith(t, reviewId, pi);
      const { id, generation } = await attempt(t);
      expect((await reviewers(t))[0].status).toBe('failed');
      expect((await usageOf(t)).results).toEqual([
        {
          id: `review-agent-pi:${id}:${generation}`,
          model: '@cf/zai-org/glm-5.3',
          requests: 6,
        },
      ]);
    });
  });

  describe('the last check', () => {
    // Events that arrive before Pi settles (a notification for an earlier state) make checks come early.
    const early = { waitForEvent: async () => ({ payload: null }) };

    it('lets a review whose checks came early run on past piChecks, inside its wall clock', async () => {
      const { t, reviewId } = await piReview();
      const n = piChecks(PI_DEFAULT_LIMITS);
      const pi = fakePi((i) => (i <= n ? { state: 'running' } : done(APPROVE)));
      await executeHeadReview(
        {
          env: t.env,
          db: drizzle(t.env.DB, { schema }),
          step: {
            do: async (_name: string, a: unknown, b?: unknown) =>
              ((b ?? a) as () => Promise<unknown>)(),
            sleep: async () => {},
            ...early,
          } as unknown as StepRunner,
          models: agentModels().models,
          pi: pi.api,
          instanceId: 'review-early',
        },
        reviewId
      );
      expect((await reviewers(t))[0].status).toBe('approved');
      expect([...pi.objects.values()][0].checks).toBe(n + 1);
    });

    it('ends a review two checks past piChecks whatever its clock says', async () => {
      const { t, reviewId } = await piReview();
      const pi = fakePi(() => ({ state: 'running' }));
      await executeHeadReview(
        {
          env: t.env,
          db: drizzle(t.env.DB, { schema }),
          step: {
            do: async (_name: string, a: unknown, b?: unknown) =>
              ((b ?? a) as () => Promise<unknown>)(),
            sleep: async () => {},
            ...early,
          } as unknown as StepRunner,
          models: agentModels().models,
          pi: pi.api,
          instanceId: 'review-early',
        },
        reviewId
      );
      expect((await reviewers(t))[0]).toMatchObject({
        status: 'failed',
        error: piTimeUp(PI_DEFAULT_LIMITS),
      });
      expect([...pi.objects.values()][0].checks).toBe(
        piChecks(PI_DEFAULT_LIMITS) + 2
      );
    });
  });

  it('carries the model and limits the Durable Object runs with, not a re-read of the settings', async () => {
    const { t } = await piReview();
    const effective = {
      model: '@cf/qwen/qwen3-coder',
      limits: { maxModelCalls: 5 },
    };
    const pi = fakePi(() => ({ state: 'running' }), {
      turnsPerCheck: 6,
      effective,
    });
    await runReviews(t, agentModels().models, { pi: pi.api });
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'failed',
      error: piBudgetSpent({ ...PI_DEFAULT_LIMITS, maxModelCalls: 5 }),
    });
    const usage = await t.env.DB.prepare(
      "SELECT model FROM ai_usage WHERE feature = 'review-agent-pi'"
    ).all<{ model: string }>();
    expect(usage.results).toEqual([{ model: '@cf/qwen/qwen3-coder' }]);
  });
});

const retry = (t: T, cookie: string, id: string) =>
  call(t, `/api/repos/octocat/app/pulls/1/reviewers/${id}/retry`, {
    cookie,
    method: 'POST',
  });

/** Like a Workflow replaying: a step that already completed returns its stored result without running again. */
function replayingStep() {
  const cache = new Map<string, unknown>();
  return {
    do: async (name: string, a: unknown, b?: unknown) => {
      if (cache.has(name)) return cache.get(name);
      const out = await ((b ?? a) as () => Promise<unknown>)();
      const stored =
        out === undefined ? undefined : JSON.parse(JSON.stringify(out));
      cache.set(name, stored);
      return stored;
    },
    sleep: async () => {},
    waitForEvent: async (name: string) => {
      throw new Error(`${name}: timed out`);
    },
  } as unknown as StepRunner;
}

describe('a Pi review in flight', () => {
  it('stops when the agent is removed from the repository, and writes nothing', async () => {
    const { t, admin } = await piReview();
    const pi = fakePi(async (n) => {
      if (n === 1) {
        const res = await call(t, '/api/repos/octocat/app/agents/secagent', {
          cookie: admin,
          method: 'DELETE',
        });
        expect(res.status).toBe(200);
      }
      return { state: 'running' };
    });
    const { models, calls } = agentModels();
    await runReviews(t, models, { pi: pi.api });
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'not_needed',
      summary: 'Removed from the repository.',
    });
    expect(await flags(t)).toEqual([]);
    expect(calls.reviewed).toEqual([]);
    expect(pi.stopped).toHaveLength(1);
    // What it spent before it was stopped is still on the record.
    const usage = await t.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ai_usage WHERE feature = 'review-agent-pi'"
    ).first<{ n: number }>();
    expect(usage!.n).toBe(1);
  });

  it('stops when a newer commit replaces the head', async () => {
    const { t, repo, head } = await piReview();
    const pi = fakePi(async (n) => {
      if (n === 1)
        await commitPaths(
          repo,
          'feature',
          { ...BASE, ...CHANGE, 'src/more.ts': 'export const m = 1;\n' },
          'More'
        );
      return n === 1 ? { state: 'running' } : done(FINDINGS);
    });
    await runReviews(t, agentModels().models, { pi: pi.api });
    const old = (await reviewers(t)).find((r) => r.head_sha === head)!;
    expect(old).toMatchObject({ status: 'not_needed', summary: PI_SUPERSEDED });
    expect(await flags(t)).toEqual([]);
    expect(pi.stopped).toHaveLength(1);
  });

  it('fails when the pull request is closed, so Retry can review it again once reopened', async () => {
    const { t, admin } = await piReview();
    const pi = fakePi(async (n) => {
      if (n === 1)
        await call(t, '/api/repos/octocat/app/pulls/1', {
          cookie: admin,
          method: 'PATCH',
          json: { state: 'closed' },
        });
      return { state: 'running' };
    });
    await runReviews(t, agentModels().models, { pi: pi.api });
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'failed',
      error: PI_CLOSED,
    });
    expect(pi.stopped).toHaveLength(1);
  });

  it('Retry after a failed Pi review starts a fresh Pi reviewer', async () => {
    const { t, admin } = await piReview();
    let gaveUp = true;
    const pi = fakePi(() =>
      gaveUp ? { state: 'unanswered', reason: 'model error' } : done(APPROVE)
    );
    await runReviews(t, agentModels().models, { pi: pi.api });
    const [failed] = await reviewers(t);
    expect(failed.status).toBe('failed');
    gaveUp = false;
    expect((await retry(t, admin, failed.id)).status).toBe(200);
    await runReviews(t, agentModels().models, { pi: pi.api });
    expect((await reviewers(t))[0].status).toBe('approved');
    // Two attempts, two objects: the second never sees the first one's workspace.
    expect(new Set(pi.starts).size).toBe(2);
    expect(pi.stopped).toEqual(pi.starts);
  });

  it('an answer for an attempt that was retried meanwhile is not recorded', async () => {
    const { t } = await piReview();
    const pi = fakePi(async () => {
      // A Retry renewed the row while Pi was answering.
      await t.env.DB.prepare(
        'UPDATE pr_reviewers SET created_at = created_at + 5'
      ).run();
      return done(FINDINGS);
    });
    await runReviews(t, agentModels().models, { pi: pi.api });
    expect((await reviewers(t))[0].status).toBe('reviewing');
    expect(await flags(t)).toEqual([]);
    expect(pi.stopped).toHaveLength(1);
  });

  it('a check after stale recovery writes nothing', async () => {
    // (That the limits stay inside the stale window is pinned once, by Task 5's settings test.)
    const { t } = await piReview();
    const db = drizzle(t.env.DB, { schema });
    const pi = fakePi(async (n) => {
      // The daily job runs as if this review's Workflow had died 2 hours ago.
      if (n === 1)
        await stopStaleReviews(
          t.env,
          db,
          new Date(Date.now() + REVIEW_STALE_MS + 60_000)
        );
      return n === 1 ? { state: 'running' } : done(FINDINGS);
    });
    await runReviews(t, agentModels().models, { pi: pi.api });
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'failed',
      error: REVIEW_STOPPED,
    });
    expect(await flags(t)).toEqual([]);
    expect(pi.stopped).toHaveLength(1);
  });

  it('fails a started review whose Workflow lost the AgentReviewer binding, so Retry can review it again', async () => {
    const { t, reviewId } = await piReview();
    // The start step's result is cached (the review started), then the binding was removed and the Workflow resumed.
    const step = {
      do: async (name: string, a: unknown, b?: unknown) =>
        name === 'review:secagent'
          ? {
              verdict: 'started',
              needsPerson: 0,
              changeRequested: 0,
              engine: 'pi',
              started: {
                generation: (await attempt(t)).generation,
                startedAt: Date.now(),
                model: '@cf/zai-org/glm-5.3',
                limits: PI_DEFAULT_LIMITS,
              },
            }
          : ((b ?? a) as () => Promise<unknown>)(),
      sleep: async () => {},
      waitForEvent: async (name: string) => {
        throw new Error(`${name}: timed out`);
      },
    } as unknown as StepRunner;
    await executeHeadReview(
      {
        env: t.env,
        db: drizzle(t.env.DB, { schema }),
        step,
        models: agentModels().models,
      },
      reviewId
    );
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'failed',
      error: PI_GONE,
    });
  });

  it('pings live pages after a check only when it ends the review', async () => {
    const { t, reviewId } = await piReview();
    const pi = fakePi((n) => (n < 3 ? { state: 'running' } : done(FINDINGS)));
    const log: string[] = [];
    const env = {
      ...t.env,
      LIVE: {
        getByName: () => ({
          publish: async (channel: string) => {
            if (channel.startsWith('repo:')) log.push('ping');
          },
        }),
      },
    } as unknown as typeof t.env;
    await executeHeadReview(
      {
        env,
        db: drizzle(t.env.DB, { schema }),
        step: {
          do: async (name: string, a: unknown, b?: unknown) => {
            const out = await ((b ?? a) as () => Promise<unknown>)();
            log.push(name);
            return out;
          },
          sleep: async () => {},
          waitForEvent: async (name: string) => {
            throw new Error(`${name}: timed out`);
          },
        } as unknown as StepRunner,
        models: agentModels().models,
        pi: pi.api,
        instanceId: 'review-live',
      },
      reviewId
    );
    const after = (name: string) => log[log.indexOf(name) + 1];
    // Two checks found Pi still working: nothing anyone sees changed, so no ping.
    expect(after('pi:secagent:1')).not.toBe('ping');
    expect(after('pi:secagent:2')).not.toBe('ping');
    // The check that recorded the answer pings, as does the start.
    expect(after('pi:secagent:3')).toBe('ping');
    expect(after('review:secagent')).toBe('ping');
  });

  it('a replayed Workflow starts nothing again and records nothing twice', async () => {
    const { t, reviewId } = await piReview();
    const pi = fakePi((n) => (n < 2 ? { state: 'running' } : done(FINDINGS)));
    const db = drizzle(t.env.DB, { schema });
    const deps = {
      env: t.env,
      db,
      step: replayingStep(),
      models: agentModels().models,
      pi: pi.api,
      instanceId: 'review-replay',
    };
    await executeHeadReview(deps, reviewId);
    const before = {
      flags: await flags(t),
      checks: [...pi.objects.values()][0].checks,
    };
    // The Workflow replays: every step comes back from the cache.
    await executeHeadReview(deps, reviewId);
    expect(pi.starts).toHaveLength(1);
    expect([...pi.objects.values()][0].checks).toBe(before.checks);
    expect(await flags(t)).toEqual(before.flags);
    expect((await reviewers(t))[0].status).toBe('changes_requested');
    const usage = await t.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ai_usage WHERE feature = 'review-agent-pi'"
    ).first<{ n: number }>();
    expect(usage!.n).toBe(1);
  });
});
