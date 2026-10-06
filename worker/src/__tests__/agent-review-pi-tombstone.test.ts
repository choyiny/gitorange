import { describe, expect, it, vi } from 'vitest';
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { AgentReviewer } from '../review/agent-reviewer';
import {
  PI_DEFAULT_LIMITS,
  PI_TOMBSTONE_MS,
  piReviewerName,
  type PiReviewerApi,
  type PiStartRequest,
} from '../review/pi-contract';
import type { AgentReviewInput } from '../review/contract';
import {
  AGENT_MD,
  agentModels,
  appRepo,
  fakePi,
  invitedAgent,
  openPull,
  reviewers,
  runReviews,
  startReview,
} from './helpers/reviews';

type T = Awaited<ReturnType<typeof appRepo>>['t'];

/** octocat/app with @secagent (engine: pi) invited and pull request #1's head under review. */
async function underReview() {
  const { t, admin, repo } = await appRepo();
  await invitedAgent(t, admin, 'secagent', AGENT_MD({ engine: 'pi' }));
  await openPull(t, admin, repo, { 'src/auth.ts': 'export const a = 2;\n' });
  await startReview(t);
  return t;
}

/** The (only) reviewer row's attempt. */
async function attempt(t: T) {
  const r = await t.env.DB.prepare(
    'SELECT id, created_at FROM pr_reviewers'
  ).first<{ id: string; created_at: number }>();
  return { id: r!.id, generation: r!.created_at * 1000 };
}

/** A reviewer row attempt, still reviewing (its review ran with a fake Pi, then was set back). */
async function reviewing() {
  const t = await underReview();
  await runReviews(t, agentModels().models, { pi: fakePi().api });
  const a = await attempt(t);
  await setStatus(t, a.id, 'reviewing');
  return { t, ...a };
}

const setStatus = (t: T, id: string, status: string) =>
  t.env.DB.prepare('UPDATE pr_reviewers SET status = ? WHERE id = ?')
    .bind(status, id)
    .run();

const request = (reviewerId: string, generation: number): PiStartRequest => ({
  reviewerId,
  generation,
  handle: 'secagent',
  input: {} as AgentReviewInput,
  changedPaths: ['src/auth.ts'],
  // No Artifacts binding in the object's env: a start that gets past its checks fails at the checkout.
  repository: { artifactsName: 'r_none' },
  headSha: 'a'.repeat(40),
  ignoreText: null,
  model: '@cf/zai-org/glm-5.3',
  limits: PI_DEFAULT_LIMITS,
  notify: null,
});

const stub = (reviewerId: string, generation: number) =>
  env.AGENT_REVIEWER.getByName(piReviewerName(reviewerId, generation));

/** Runs `fn` inside the object, with its instance. */
const inReviewer = <R>(
  s: DurableObjectStub,
  fn: (reviewer: AgentReviewer, state: DurableObjectState) => Promise<R>
) =>
  runInDurableObject(s, (instance, state) =>
    fn(instance as unknown as AgentReviewer, state)
  );

/** What the object stores, by key. */
const stored = async (state: DurableObjectState) => [
  ...(await state.storage.list()).keys(),
];

describe('a stopped Pi reviewer', () => {
  it('does nothing on a later start, on this instance or a fresh one (evicted)', async () => {
    const { id, generation } = await reviewing();
    await inReviewer(stub(id, generation), async (reviewer, state) => {
      // Still this attempt, reviewing: the start gets as far as its draft.
      await expect(reviewer.start(request(id, generation))).rejects.toThrow();
      expect(await state.storage.get('draft')).toBeDefined();

      await reviewer.stop();
      expect(await stored(state)).toEqual(['stopped']);
      const at = (await state.storage.get<number>('stopped'))!;
      expect(await state.storage.getAlarm()).toBe(at + PI_TOMBSTONE_MS);

      const submit = vi.spyOn(reviewer.harness, 'submit');
      expect(await reviewer.start(request(id, generation))).toEqual({
        stopped: true,
      });
      // A stop again keeps the first tombstone's clock.
      await reviewer.stop();
      expect(await state.storage.get('stopped')).toBe(at);

      // Evicted: a new instance over the same storage, with a fresh in-memory gate.
      const fresh = new AgentReviewer(state, env);
      const freshSubmit = vi.spyOn(fresh.harness, 'submit');
      expect(await fresh.start(request(id, generation))).toEqual({
        stopped: true,
      });
      expect(await stored(state)).toEqual(['stopped']);
      expect(submit).not.toHaveBeenCalled();
      expect(freshSubmit).not.toHaveBeenCalled();
    });
  });

  it('a start whose row was cancelled meanwhile starts nothing, and tombstones the object', async () => {
    const { t, id, generation } = await reviewing();
    await setStatus(t, id, 'not_needed');
    await inReviewer(stub(id, generation), async (reviewer, state) => {
      expect(await reviewer.start(request(id, generation))).toEqual({
        stopped: true,
      });
      expect(await stored(state)).toEqual(['stopped']);
      expect(await state.storage.getAlarm()).not.toBeNull();
      // The row reviewing again (it can't, for this generation) changes nothing: the tombstone wins.
      await setStatus(t, id, 'reviewing');
      expect(await reviewer.start(request(id, generation))).toEqual({
        stopped: true,
      });
    });
  });

  it('a start for an older attempt of the row starts nothing', async () => {
    const { id, generation } = await reviewing();
    await inReviewer(stub(id, generation - 1000), async (reviewer, state) => {
      expect(await reviewer.start(request(id, generation - 1000))).toEqual({
        stopped: true,
      });
      expect(await stored(state)).toEqual(['stopped']);
    });
  });

  it('a name stopped before it ever started never starts', async () => {
    const { id, generation } = await reviewing();
    const s = stub(id, generation);
    await s.stop();
    await inReviewer(s, async (_reviewer, state) => {
      expect(await stored(state)).toEqual(['stopped']);
      const fresh = new AgentReviewer(state, env);
      expect(await fresh.start(request(id, generation))).toEqual({
        stopped: true,
      });
      expect(await stored(state)).toEqual(['stopped']);
    });
  });

  it('forgets everything a day after the tombstone, and not before', async () => {
    const { id, generation } = await reviewing();
    const s = stub(id, generation);
    await s.stop();
    // Early (a stray wake): the tombstone stays and the alarm is set again for its day.
    expect(await runDurableObjectAlarm(s)).toBe(true);
    const at = await inReviewer(s, async (_reviewer, state) => {
      expect(await stored(state)).toEqual(['stopped']);
      const stopped = (await state.storage.get<number>('stopped'))!;
      expect(await state.storage.getAlarm()).toBe(stopped + PI_TOMBSTONE_MS);
      // A day on.
      await state.storage.put('stopped', Date.now() - PI_TOMBSTONE_MS - 1);
      return stopped;
    });
    expect(at).toBeGreaterThan(0);
    expect(await runDurableObjectAlarm(s)).toBe(true);
    await inReviewer(s, async (_reviewer, state) => {
      expect(await stored(state)).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});

describe('the review Workflow and a stopped Pi reviewer', () => {
  it('a cancel landing between the step reading its row and starting the object: skipped, nothing runs', async () => {
    const t = await underReview();
    const real = (name: string) =>
      env.AGENT_REVIEWER.getByName(name) as unknown as PiReviewerApi;
    const statuses: string[] = [];
    const pi = (name: string): PiReviewerApi => ({
      async start(req) {
        // Cancelled after runAgentReview read the row reviewing.
        await setStatus(t, req.reviewerId, 'not_needed');
        return real(name).start(req);
      },
      async status() {
        statuses.push(name);
        return real(name).status();
      },
      stop: () => real(name).stop(),
    });
    await runReviews(t, agentModels().models, { pi });

    const { id, generation } = await attempt(t);
    expect(statuses).toEqual([]);
    expect((await reviewers(t))[0]).toMatchObject({ status: 'not_needed' });
    await inReviewer(stub(id, generation), async (_reviewer, state) => {
      expect(await stored(state)).toEqual(['stopped']);
    });
  });
});
