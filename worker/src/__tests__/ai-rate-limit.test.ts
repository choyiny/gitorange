// Workers AI rate limits (3021 / 429): retried with jittered backoff, and a review that is only rate limited is
// never marked failed.
import { describe, expect, it } from 'vitest';
import { isRateLimited, withRateLimitRetry } from '../lib/ai-retry';
import { MODEL_RETRIES } from '../review/detail';
import { appRepo, agentModels, AGENT_MD } from './helpers/reviews';
import {
  invitedAgent,
  openPull,
  reviewers,
  runReviews,
  startReview,
} from './helpers/reviews';

const RATE_LIMITED =
  'AiError: 3021: rate limiting: inference request per min rate reached';

describe('rate-limited Workers AI calls', () => {
  it('recognizes 3021 and 429, and nothing else', () => {
    expect(isRateLimited(new Error(RATE_LIMITED))).toBe(true);
    expect(isRateLimited(new Error('429 Too Many Requests'))).toBe(true);
    expect(
      isRateLimited(new Error(`The review model failed: ${RATE_LIMITED}`))
    ).toBe(true);
    expect(isRateLimited(new Error('model down'))).toBe(false);
    expect(isRateLimited(new Error('Expected a JSON object'))).toBe(false);
  });

  it('retries with growing, jittered delays until the call goes through', async () => {
    const slept: number[] = [];
    let calls = 0;
    const out = await withRateLimitRetry(
      async () => {
        if (++calls <= 3) throw new Error(RATE_LIMITED);
        return 'ok';
      },
      { sleep: async (ms) => void slept.push(ms), random: () => 0.5 }
    );
    expect(out).toBe('ok');
    expect(slept).toHaveLength(3);
    expect(slept[1]).toBeGreaterThan(slept[0]);
    expect(slept[2]).toBeGreaterThan(slept[1]);
  });

  it('jitters: two callers limited together do not retry together', async () => {
    const delays = async (random: () => number) => {
      const slept: number[] = [];
      let calls = 0;
      await withRateLimitRetry(
        async () => {
          if (++calls <= 1) throw new Error(RATE_LIMITED);
          return 1;
        },
        { sleep: async (ms) => void slept.push(ms), random }
      );
      return slept[0];
    };
    expect(await delays(() => 0.1)).not.toBe(await delays(() => 0.9));
  });

  it('rethrows anything else at once', async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          calls++;
          throw new Error('model down');
        },
        { sleep: async () => {} }
      )
    ).rejects.toThrow('model down');
    expect(calls).toBe(1);
  });

  it('gives up once its time budget is spent', async () => {
    let waited = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          throw new Error(RATE_LIMITED);
        },
        {
          sleep: async (ms) => void (waited += ms),
          random: () => 1,
          budgetMs: 60_000,
        }
      )
    ).rejects.toThrow(/3021/);
    expect(waited).toBeLessThanOrEqual(60_000);
  });

  it('spreads a model step’s retries over more than a minute (the rate-limit window)', () => {
    const r = MODEL_RETRIES.retries!;
    const base = parseInt(String(r.delay), 10) * 1000;
    let total = 0;
    for (let i = 0; i < r.limit; i++)
      total += r.backoff === 'exponential' ? base * 2 ** i : base;
    expect(total).toBeGreaterThan(120_000);
  });
});

describe('a rate-limited agent review', () => {
  async function reviewed() {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    await openPull(t, admin, repo, { 'a.txt': 'a\n' });
    await startReview(t);
    return t;
  }

  it('waits and tries again instead of failing', async () => {
    const t = await reviewed();
    let calls = 0;
    const { models } = agentModels();
    const review = models.review.bind(models);
    models.review = async (input, paths) => {
      if (++calls <= 2) throw new Error(RATE_LIMITED);
      return review(input, paths);
    };
    await runReviews(t, models);
    expect((await reviewers(t))[0]).toMatchObject({ status: 'approved' });
  });

  it('fails only once the limit outlasts every wait, and says it was rate limited', async () => {
    const t = await reviewed();
    const { models } = agentModels();
    models.review = async () => {
      throw new Error(RATE_LIMITED);
    };
    await runReviews(t, models);
    const [row] = await reviewers(t);
    expect(row.status).toBe('failed');
    expect(String(row.error)).toMatch(/rate limit/i);
  });
});
