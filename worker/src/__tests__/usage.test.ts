import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import {
  aiTokenCost,
  costOverAllowance,
  listCost,
  priceBookFor,
  r2Class,
} from '../usage/pricing';
import { monthBounds, priceSeries, usageReport } from '../usage/report';
import { addDays, dayOf, daysToSync, syncUsage } from '../usage/sync';
import { GRAPHQL_URL } from '../usage/probes';
import { usageFromTranscript } from '../usage/record';
import { runScheduled, USAGE_SYNC_CRON } from '../cron';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  type TestEnv,
} from './helpers/app';

const book = priceBookFor('2026-10-01');
const TOKEN = 'test-analytics-token';

afterEach(() => vi.restoreAllMocks());

/** An env with Cloudflare analytics set up and a named AI Gateway. */
function configured(t: TestEnv) {
  Object.assign(t.env, {
    CF_ANALYTICS_TOKEN: TOKEN,
    AI_GATEWAY: 'xyspace-gitorange',
  });
  return t;
}

type Call = { url: string; auth: string; query: string; accountTag: string };

/**
 * A fake GraphQL Analytics API. Answers each dataset with fixed groups; `cpuTimeUs` is an
 * unknown field, the way Cloudflare rejects a name it does not have.
 */
function fakeGraphql(scale = 1) {
  const calls: Call[] = [];
  const answers: Record<string, unknown[]> = {
    workersInvocationsAdaptive: [{ sum: { requests: 1_000 * scale } }],
    durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 50 } }],
    durableObjectsPeriodicGroups: [
      { sum: { activeTime: 8_000_000, rowsRead: 10, rowsWritten: 5 } },
    ],
    durableObjectsStorageGroups: [{ max: { storedBytes: 2_000_000 } }],
    workflowsAdaptiveGroups: [{ count: 3 }, { count: 4 }],
    d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 9_000, rowsWritten: 300 } }],
    d1StorageAdaptiveGroups: [{ max: { databaseSizeBytes: 5_000_000 } }],
    r2OperationsAdaptiveGroups: [
      { sum: { requests: 10 }, dimensions: { actionType: 'PutObject' } },
      { sum: { requests: 40 }, dimensions: { actionType: 'GetObject' } },
      { sum: { requests: 7 }, dimensions: { actionType: 'DeleteObject' } },
    ],
    r2StorageAdaptiveGroups: [
      { max: { payloadSize: 1_000_000, metadataSize: 1_000 } },
    ],
    artifactsEventsAdaptiveGroups: [
      { count: 20, dimensions: { eventKind: 'action' } },
      { count: 2, dimensions: { eventKind: 'error' } },
    ],
    aiGatewayRequestsAdaptiveGroups: [{ count: 12, sum: { cost: 0.5 } }],
  };
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      query: string;
      variables: { accountTag: string };
    };
    calls.push({
      url,
      auth: new Headers(init.headers).get('Authorization') ?? '',
      query: body.query,
      accountTag: body.variables.accountTag,
    });
    const reply = (v: unknown) =>
      new Response(JSON.stringify(v), {
        headers: { 'Content-Type': 'application/json' },
      });
    if (body.query.includes('cpuTimeUs'))
      return reply({
        data: null,
        errors: [{ message: 'unknown field "cpuTimeUs"' }],
      });
    const dataset = /groups: (\w+)\(/.exec(body.query)![1];
    return reply({
      data: { viewer: { accounts: [{ groups: answers[dataset] ?? [] }] } },
      errors: null,
    });
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

async function usageRows(t: TestEnv) {
  return (
    await t.env.DB.prepare(
      'SELECT date, product, metric, resource, quantity, source FROM usage_daily ORDER BY metric, resource'
    ).all<{
      date: string;
      product: string;
      metric: string;
      resource: string;
      quantity: number;
      source: string;
    }>()
  ).results;
}

describe('Usage pricing', () => {
  it('prices flows at list price and above the allowance', () => {
    const p = book.prices['workers.requests'];
    expect(listCost(p, 12_000_000)).toBeCloseTo(3.6);
    expect(costOverAllowance(p, 12_000_000)).toBeCloseTo(0.6);
    expect(costOverAllowance(p, 9_000_000)).toBe(0);
  });

  it('bills storage as GB-month: the average of daily peaks over 30 days', () => {
    const p = book.prices['d1.storage_bytes'];
    const byDay = new Map<string, number>();
    for (let i = 0; i < 30; i++) byDay.set(addDays('2026-09-01', i), 10e9);
    const r = priceSeries(p, byDay, {
      daysInMonth: 30,
      observedDays: 30,
      monthEnd: '2026-09-30',
    });
    expect(r.quantity).toBeCloseTo(10);
    expect(r.listCost).toBeCloseTo(7.5);
    expect(r.dedicatedCost).toBeCloseTo(3.75);
    // Half the month observed: projected at the latest peak.
    const half = new Map([...byDay].slice(0, 15));
    const h = priceSeries(p, half, {
      daysInMonth: 30,
      observedDays: 15,
      monthEnd: '2026-09-30',
    });
    expect(h.quantity).toBeCloseTo(5);
    expect(h.projectedQuantity).toBeCloseTo(10);
  });

  it('projects flows at the daily average and skips days before billing starts', () => {
    const p = book.prices['artifacts.operations'];
    expect(p.billedFrom).toBe('2026-10-14');
    const byDay = new Map<string, number>();
    for (let i = 0; i < 20; i++) byDay.set(addDays('2026-10-01', i), 1_000);
    const r = priceSeries(p, byDay, {
      daysInMonth: 31,
      observedDays: 20,
      monthEnd: '2026-10-31',
    });
    expect(r.quantity).toBe(20_000);
    // Only Oct 14..20 (7 days) are billed: 7,000 operations.
    expect(r.listCost).toBeCloseTo(7 * 0.15);
    expect(r.dedicatedCost).toBe(0);
    expect(r.projectedQuantity).toBeCloseTo(31_000);
    expect(r.projectedListCost).toBeCloseTo(18 * 0.15);
    expect(r.dailyCost.get('2026-10-01')).toBe(0);
    // A month entirely before billing starts costs nothing.
    const sept = priceSeries(p, new Map([['2026-09-10', 50_000]]), {
      daysInMonth: 30,
      observedDays: 10,
      monthEnd: '2026-09-30',
    });
    expect(sept.listCost).toBe(0);
    expect(sept.projectedListCost).toBe(0);
  });

  it('prices Workers AI tokens per model, and R2 operations by class', () => {
    expect(aiTokenCost(book, '@cf/zai-org/glm-5.3', 1e6, 1e6)).toBeCloseTo(5.8);
    expect(aiTokenCost(book, '@cf/cloudflare/clef', 1e6, 0)).toBeCloseTo(0.24);
    expect(aiTokenCost(book, '@cf/unknown/model', 1, 1)).toBeNull();
    expect(r2Class('PutObject')).toBe('a');
    expect(r2Class('GetObject')).toBe('b');
    expect(r2Class('DeleteObject')).toBeNull();
  });

  it('knows month lengths', () => {
    expect(monthBounds('2026-02')).toMatchObject({
      from: '2026-02-01',
      to: '2026-02-28',
      days: 28,
    });
    expect(monthBounds('2026-10').days).toBe(31);
  });
});

describe('usageFromTranscript', () => {
  it('counts a pi harness transcript: entry records carry their messages under model', () => {
    const entries = [
      {
        id: 'e1',
        conversationId: 'c',
        kind: 'user',
        model: [{ role: 'user', content: 'hi' }],
      },
      {
        id: 'e2',
        conversationId: 'c',
        kind: 'assistant',
        model: [
          {
            role: 'assistant',
            content: [],
            usage: { input: 100, output: 10, cacheRead: 40 },
          },
        ],
      },
      {
        id: 'e3',
        conversationId: 'c',
        kind: 'tool',
        model: [{ role: 'toolResult', content: [] }],
      },
      { id: 'e4', conversationId: 'c', kind: 'note', data: {} },
      {
        id: 'e5',
        conversationId: 'c',
        kind: 'assistant',
        model: [
          { role: 'assistant', content: [], usage: { input: 5, output: 1 } },
        ],
      },
    ];
    expect(usageFromTranscript(entries)).toEqual({
      requests: 2,
      tokensIn: 145,
      tokensOut: 11,
      tokensCached: 40,
    });
    // Plain messages still count.
    expect(
      usageFromTranscript([
        { role: 'assistant', usage: { input: 1, output: 2 } },
      ])
    ).toEqual({ requests: 1, tokensIn: 1, tokensOut: 2, tokensCached: 0 });
  });
});

describe('Usage sync', () => {
  it('does nothing without the analytics token', async () => {
    const t = makeEnv();
    const g = fakeGraphql();
    const res = await syncUsage(t.env, ['2026-10-01'], { fetch: g.fetch });
    expect(res.configured).toBe(false);
    expect(g.calls).toHaveLength(0);
  });

  it("asks only about this deployment's own resources, and stores each day", async () => {
    const t = configured(makeEnv());
    const g = fakeGraphql();
    const res = await syncUsage(t.env, ['2026-10-01'], { fetch: g.fetch });
    expect(res.configured).toBe(true);

    for (const c of g.calls) {
      expect(c.url).toBe(GRAPHQL_URL);
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
      expect(c.accountTag).toBe(t.env.R2_ACCOUNT_ID);
      // Every query is filtered to one of this deployment's resources.
      expect(c.query).toMatch(
        /scriptName: "gitorange-test"|namespaceId: "ns-(job-runner|merge-resolver)"|workflowName: "gitorange-(actions-run|merge-resolution)-test"|databaseId: "11111111-2222-3333-4444-555555555555"|bucketName: "gitorange-(lfs|actions-logs|actions-cache)-test"|repositoryNamespace: "gitorange-test"|gateway: "xyspace-gitorange"/
      );
    }
    // LIVE_NAMESPACE_ID is empty in the test config: LiveHub is not asked about.
    expect(g.calls.some((c) => c.query.includes('LiveHub'))).toBe(false);

    const rows = await usageRows(t);
    const q = (metric: string, resource: string) =>
      rows.find((r) => r.metric === metric && r.resource === resource)
        ?.quantity;
    expect(q('workers.requests', 'gitorange-test')).toBe(1000);
    expect(q('do.requests', 'JobRunner')).toBe(50);
    expect(q('do.duration_gb_s', 'MergeResolver')).toBe(1); // 8 s × 0.125 GB
    expect(q('workflows.steps', 'gitorange-actions-run-test')).toBe(7);
    expect(q('d1.rows_written', '11111111-2222-3333-4444-555555555555')).toBe(
      300
    );
    expect(q('r2.class_a', 'gitorange-lfs-test')).toBe(10);
    expect(q('r2.class_b', 'gitorange-lfs-test')).toBe(40);
    expect(q('r2.storage_bytes', 'gitorange-actions-cache-test')).toBe(
      1_001_000
    );
    expect(q('artifacts.operations', 'gitorange-test')).toBe(20);
    expect(q('ai-gateway.requests', 'xyspace-gitorange')).toBe(12);
    expect(rows.find((r) => r.metric === 'do.requests')?.product).toBe(
      'durable-objects'
    );
    // The unknown field failed only its own probe.
    expect(q('workers.cpu_ms', 'gitorange-test')).toBeUndefined();
    const sync = await t.env.DB.prepare(
      'SELECT status, errors FROM usage_syncs WHERE id = ?'
    )
      .bind('2026-10-01')
      .first<{ status: string; errors: string }>();
    expect(sync?.status).toBe('partial');
    const errors = JSON.parse(sync!.errors);
    expect(errors['workers.cpu:gitorange-test']).toContain('cpuTimeUs');
    expect(errors['durable-objects:unconfigured']).toBeUndefined();
    expect(JSON.stringify(errors)).not.toContain(TOKEN);
  });

  it('replaces a day when synced again, leaving app-counted usage alone', async () => {
    const t = configured(makeEnv());
    await t.env.DB.prepare(
      `INSERT INTO usage_daily (date, product, metric, resource, quantity, source, fetched_at)
       VALUES ('2026-10-01', 'email', 'email.sends', '', 3, 'gitorange', 0)`
    ).run();
    await syncUsage(t.env, ['2026-10-01'], { fetch: fakeGraphql().fetch });
    await syncUsage(t.env, ['2026-10-01'], { fetch: fakeGraphql(2).fetch });
    const rows = await usageRows(t);
    expect(
      rows.filter((r) => r.metric === 'workers.requests').map((r) => r.quantity)
    ).toEqual([2000]);
    expect(rows.find((r) => r.metric === 'email.sends')?.quantity).toBe(3);
  });

  it('re-reads recent days and backfills a few never-synced ones per run', async () => {
    const t = configured(makeEnv());
    const db = drizzle(t.env.DB, { schema });
    const now = new Date('2026-10-04T02:30:00Z');
    const first = await daysToSync(db, now);
    expect(first.slice(0, 3)).toEqual([
      '2026-10-03',
      '2026-10-02',
      '2026-10-01',
    ]);
    expect(first.slice(3)).toEqual([
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
      '2026-09-07',
    ]);
    await syncUsage(t.env, first, { fetch: fakeGraphql().fetch, db });
    expect((await daysToSync(db, now)).slice(3)).toEqual([
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
    ]);
  });

  it('runs from the daily cron, and ignores crons it does not know', async () => {
    const t = configured(makeEnv());
    const g = fakeGraphql();
    vi.spyOn(globalThis, 'fetch').mockImplementation(g.fetch);
    await runScheduled({ cron: '0 0 1 1 *' }, t.env);
    expect(g.calls).toHaveLength(0);
    await runScheduled({ cron: USAGE_SYNC_CRON }, t.env);
    expect(g.calls.length).toBeGreaterThan(0);
    const synced = await t.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM usage_syncs'
    ).first<{ n: number }>();
    expect(synced?.n).toBe(7);
  });
});

describe('Usage report', () => {
  it('is for site admins only', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const bob = await addMember(t, admin, 'bob');
    expect((await call(t, '/api/admin/usage', { cookie: bob })).status).toBe(
      403
    );
    expect((await call(t, '/api/admin/usage')).status).toBe(401);
    expect(
      (await call(t, '/api/admin/usage?month=2026-13', { cookie: admin }))
        .status
    ).toBe(400);
    const res = await call(t, '/api/admin/usage', { cookie: admin });
    expect(res.status).toBe(200);
    const r = (await res.json()) as Awaited<ReturnType<typeof usageReport>>;
    expect(r.month).toBe(dayOf(new Date()).slice(0, 7));
    expect(r.analyticsConfigured).toBe(false);
    const workers = r.lines.find((l) => l.metric === 'workers.requests')!;
    expect(workers.status).toBe('not-configured');
    expect(workers.reason).toContain('CF_ANALYTICS_TOKEN');
  });

  it('prices Actions runners, AI calls, and synced analytics for a month', async () => {
    const t = configured(makeEnv());
    const admin = await bootstrapAdmin(t);
    const db = drizzle(t.env.DB, { schema });
    await syncUsage(t.env, ['2026-09-10', '2026-09-11'], {
      fetch: fakeGraphql().fetch,
      db,
    });
    const start = Date.parse('2026-09-10T12:00:00Z');
    await t.env.DB.batch([
      // 10 minutes on standard-2, 5 minutes on standard-4 (no repository: deleted).
      t.env.DB.prepare(
        `INSERT INTO runner_sessions (id, job_id, repository_id, instance_type, started_at, stopped_at, deadline_at)
         VALUES ('a:1', NULL, NULL, 'standard-2', ?, ?, ?)`
      ).bind(start, start + 600_000, start + 3_600_000),
      t.env.DB.prepare(
        `INSERT INTO runner_sessions (id, job_id, repository_id, instance_type, started_at, stopped_at, deadline_at)
         VALUES ('b:1', NULL, NULL, 'standard-4', ?, ?, ?)`
      ).bind(start, start + 300_000, start + 3_600_000),
      // Outside the month.
      t.env.DB.prepare(
        `INSERT INTO runner_sessions (id, job_id, repository_id, instance_type, started_at, stopped_at, deadline_at)
         VALUES ('c:1', NULL, NULL, 'standard-2', ?, ?, ?)`
      ).bind(
        start + 40 * 86_400_000,
        start + 40 * 86_400_000 + 60_000,
        start + 41 * 86_400_000
      ),
      t.env.DB.prepare(
        `INSERT INTO ai_usage (id, created_at, feature, model, requests, tokens_in, tokens_out)
         VALUES ('x', ?, 'review-investigate', '@cf/zai-org/glm-5.3', 1, 1000000, 0)`
      ).bind(start),
      t.env.DB.prepare(
        `INSERT INTO ai_usage (id, created_at, feature, model, requests, tokens_in, tokens_out)
         VALUES ('y', ?, 'review-classify', '@cf/cloudflare/clef', 2, NULL, NULL)`
      ).bind(start),
    ]);

    const res = await call(t, '/api/admin/usage?month=2026-09', {
      cookie: admin,
    });
    expect(res.status).toBe(200);
    const r = (await res.json()) as Awaited<ReturnType<typeof usageReport>>;

    const perSecond = (vcpu: number, mem: number, disk: number) =>
      vcpu * 0.00002 + mem * 0.0000025 + disk * 0.00000007;
    const actionsCost = 600 * perSecond(1, 6, 12) + 300 * perSecond(4, 12, 20);
    expect(r.actions.minutes).toBeCloseTo(15);
    expect(r.actions.cost).toBeCloseTo(actionsCost, 5);
    expect(r.actions.byRepository).toEqual([
      expect.objectContaining({ repository: '(no repository)', minutes: 15 }),
    ]);
    expect(r.actions.byInstance.map((x) => x.instanceType).sort()).toEqual([
      'standard-2',
      'standard-4',
    ]);
    const vcpu = r.lines.find((l) => l.metric === 'containers.vcpu_s')!;
    expect(vcpu.quantity).toBe(600 + 300 * 4);
    expect(vcpu.source).toBe('estimate');

    expect(r.ai.cost).toBeCloseTo(1.4);
    expect(r.ai.requests).toBe(3);
    expect(r.ai.unreportedRequests).toBe(2);
    expect(r.ai.byFeature[0]).toMatchObject({
      key: 'review-investigate',
      cost: 1.4,
    });

    const requests = r.lines.find((l) => l.metric === 'workers.requests')!;
    expect(requests).toMatchObject({
      status: 'measured',
      source: 'cloudflare',
      quantity: 2000,
      dedicatedCost: 0,
    });
    expect(requests.listCost).toBeCloseTo(2000 * 0.3e-6);
    const cpu = r.lines.find((l) => l.metric === 'workers.cpu_ms')!;
    expect(cpu.status).toBe('unavailable');
    expect(cpu.reason).toContain('cpuTimeUs');
    // The gateway is reported apart, never in GitOrange's totals.
    expect(r.gateway).toMatchObject({
      id: 'xyspace-gitorange',
      requests: 24,
      estimatedCost: 1,
      status: 'measured',
    });
    expect(r.lines.some((l) => l.product === 'ai-gateway')).toBe(false);
    const sum = r.lines.reduce((n, l) => n + l.listCost, 0);
    expect(r.totals.listCost).toBeCloseTo(sum, 5);
    expect(r.daily.map((d) => d.date)).toEqual(['2026-09-10', '2026-09-11']);
    expect(r.prices.planFee).toBe(5);
  });

  it('syncs on demand, at most every five minutes', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const notSetUp = await call(t, '/api/admin/usage/sync', {
      cookie: admin,
      method: 'POST',
    });
    expect(notSetUp.status).toBe(400);
    configured(t);
    const g = fakeGraphql();
    vi.spyOn(globalThis, 'fetch').mockImplementation(g.fetch);
    const res = await call(t, '/api/admin/usage/sync', {
      cookie: admin,
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: string[] };
    expect(body.days[0]).toBe(dayOf(new Date()));
    expect(body.days).toHaveLength(4);
    const again = await call(t, '/api/admin/usage/sync', {
      cookie: admin,
      method: 'POST',
    });
    expect(again.status).toBe(429);
  });
});
