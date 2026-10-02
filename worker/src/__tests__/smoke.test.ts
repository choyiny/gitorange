import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/** Regression test for the harness itself: migrations applied and the worker boots. */
describe('test harness', () => {
  it('applies D1 migrations before the suite runs', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all<{ name: string }>();
    const tables = results.map((r) => r.name);
    expect(tables).toContain('d1_migrations');
    expect(tables.length).toBeGreaterThan(1);
  });

  it('serves the worker over SELF.fetch', async () => {
    const res = await SELF.fetch('http://test.local/api/setup/status');
    expect(res.status).toBeLessThan(500);
  });
});
