/**
 * Workers AI rate limits ("AiError: 3021: rate limiting: inference request per min rate reached", or an HTTP 429
 * through AI Gateway) clear within a minute. A Workflow step's own retries (a few seconds apart, the same for every
 * step) all fall inside that minute, and steps limited together retry together, so they fail together. Rate-limited
 * calls are retried here instead, with full-jitter exponential backoff, before the step's retries are spent.
 */

/** Whether `e` says only that Workers AI is rate limiting (3021 or 429). */
export function isRateLimited(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return /\b3021\b|\b429\b|rate.?limit|too many requests/i.test(text);
}

export type RateLimitRetry = {
  /** Waits `ms` (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>;
  /** In [0, 1) (tests pass a fixed one). */
  random?: () => number;
  /** Total time spent waiting before the rate-limit error is rethrown. */
  budgetMs?: number;
  /** The first wait's ceiling; doubled each time up to `capMs`. */
  baseMs?: number;
  capMs?: number;
};

/** Within a step's 5-minute timeout, leaving the model call itself time to answer. */
export const RATE_LIMIT_BUDGET_MS = 150_000;

/**
 * Runs `fn`; while it fails only because of a rate limit, waits a random time below a doubling ceiling (never less
 * than a quarter of it, so the waits grow) and runs it again, until `budgetMs` of waiting is spent. Any other error
 * is rethrown at once.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  o: RateLimitRetry = {}
): Promise<T> {
  const sleep =
    o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = o.random ?? Math.random;
  const budget = o.budgetMs ?? RATE_LIMIT_BUDGET_MS;
  const base = o.baseMs ?? 4_000;
  const cap = o.capMs ?? 60_000;
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimited(e)) throw e;
      const ceiling = Math.min(cap, base * 2 ** attempt);
      const wait = Math.round(ceiling * (0.25 + 0.75 * random()));
      if (waited + wait > budget) throw e;
      waited += wait;
      await sleep(wait);
    }
  }
}
