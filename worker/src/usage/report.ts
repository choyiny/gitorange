/**
 * The Site admin "Usage & cost" report for one calendar month (UTC): GitOrange's own usage, its
 * cost at list price, the cost if GitOrange had the account's included allowances to itself,
 * and a projection to month end. Costs are computed here from pricing.ts, never stored.
 */
import { and, gte, isNull, lt, or } from 'drizzle-orm';
import {
  aiUsage,
  runnerSessions,
  usageDaily,
  usageSyncs,
} from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import { findReposByIds } from '../lib/repos';
import {
  aiTokenCost,
  BYTES_PER_GB,
  costOverAllowance,
  dailyAiAllowance,
  INSTANCE_SIZES,
  listCost,
  priceBookFor,
  PRODUCT_LABELS,
  type Price,
  type Product,
} from './pricing';
import { buildProbes, usageResources } from './probes';
import { addDays, analyticsConfigured } from './sync';

export type LineStatus = 'measured' | 'unavailable' | 'not-configured';

export interface UsageLine {
  metric: string;
  product: Product;
  productLabel: string;
  label: string;
  unit: string;
  /** Month to date, in `unit` (storage: GB-month accrued so far). */
  quantity: number;
  included: number;
  includedPer: 'month' | 'day';
  /** The account-wide allowance in words, e.g. "10,000,000 requests per month". */
  includedLabel: string;
  /** Every unit at list price, no allowance. */
  listCost: number;
  /** Only the part above the allowance, as if the account ran nothing else. */
  dedicatedCost: number;
  projectedQuantity: number;
  projectedListCost: number;
  projectedDedicatedCost: number;
  status: LineStatus;
  /** Why a line is unavailable or not configured, or which resources failed to sync. */
  reason?: string;
  /** cloudflare: GraphQL Analytics. gitorange: counted by the app. estimate: an upper bound or approximation. */
  source: 'cloudflare' | 'gitorange' | 'estimate';
  note?: string;
  billedFrom?: string;
  resources: { resource: string; quantity: number }[];
}

export interface UsageReport {
  month: string;
  from: string;
  /** Last day of the month (inclusive). */
  to: string;
  daysInMonth: number;
  generatedAt: string;
  analyticsConfigured: boolean;
  lastSync: { day: string; completedAt: string | null; status: string } | null;
  prices: { checkedOn: string; sources: string[]; planFee: number };
  lines: UsageLine[];
  totals: {
    listCost: number;
    dedicatedCost: number;
    projectedListCost: number;
    projectedDedicatedCost: number;
  };
  daily: { date: string; costs: Partial<Record<Product, number>> }[];
  actions: {
    minutes: number;
    cost: number;
    running: number;
    byRepository: { repository: string; minutes: number; cost: number }[];
    byInstance: { instanceType: string; minutes: number; cost: number }[];
  };
  ai: {
    requests: number;
    cost: number;
    /** Calls whose model did not report token counts (not priced). */
    unreportedRequests: number;
    byFeature: AiBreakdown[];
    byRepository: AiBreakdown[];
  };
  /** The whole AI Gateway, which other apps or a dev instance may share. Not in the totals. */
  gateway: {
    id: string;
    requests: number | null;
    estimatedCost: number | null;
    status: LineStatus;
    reason?: string;
  } | null;
  /** Billed usage nothing can measure. */
  notMeasured: string[];
}

export interface AiBreakdown {
  key: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

export const NOT_MEASURED = [
  'Artifacts storage (Cloudflare publishes no storage metric; operations are measured)',
  'Workflows storage (no analytics dataset)',
  'Container network egress (no analytics dataset)',
  'Workers Logs events (no analytics dataset)',
];

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (m: string) => MONTH_RE.test(m);

/** First day, last day, and length of a YYYY-MM month. */
export function monthBounds(month: string) {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  return {
    from: start.toISOString().slice(0, 10),
    to: addDays(end.toISOString().slice(0, 10), -1),
    start,
    end,
    days,
  };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Seconds of [a, b) that fall in [from, to). */
function overlap(a: number, b: number, from: number, to: number) {
  return Math.max(0, (Math.min(b, to) - Math.max(a, from)) / 1000);
}

interface Series {
  /** Day → quantity in the metric's stored unit (bytes for storage). */
  byDay: Map<string, number>;
  byResource: Map<string, number>;
}

/**
 * Prices one metric's daily series. `observedDays` is how many days of the month the series
 * covers (fractional for app-recorded data up to now); the rest of the month is projected at
 * the same daily average (storage: at the latest daily peak).
 */
export function priceSeries(
  p: Price,
  byDay: Map<string, number>,
  opts: { daysInMonth: number; observedDays: number; monthEnd: string }
) {
  const days = [...byDay.keys()].sort();
  const billable = (d: string) => !p.billedFrom || d >= p.billedFrom;
  const notBilledThisMonth = !!p.billedFrom && p.billedFrom > opts.monthEnd;
  const remaining = Math.max(0, opts.daysInMonth - opts.observedDays);
  if (p.kind === 'storage') {
    const gb = (bytes: number) => bytes / BYTES_PER_GB;
    const quantity = days.reduce((n, d) => n + gb(byDay.get(d)!) / 30, 0);
    const latest = days.length ? gb(byDay.get(days[days.length - 1])!) : 0;
    const projectedQuantity = quantity + (latest * remaining) / 30;
    return {
      quantity,
      listCost: listCost(p, quantity),
      dedicatedCost: costOverAllowance(p, quantity),
      projectedQuantity,
      projectedListCost: listCost(p, projectedQuantity),
      projectedDedicatedCost: costOverAllowance(p, projectedQuantity),
      dailyCost: new Map(
        days.map((d) => [d, listCost(p, gb(byDay.get(d)!) / 30)])
      ),
    };
  }
  const quantity = days.reduce((n, d) => n + byDay.get(d)!, 0);
  const billed = days.filter(billable).reduce((n, d) => n + byDay.get(d)!, 0);
  const avg = opts.observedDays > 0 ? quantity / opts.observedDays : 0;
  const projectedQuantity = quantity + avg * remaining;
  const projectedBilled = notBilledThisMonth ? 0 : billed + avg * remaining;
  return {
    quantity,
    listCost: listCost(p, billed),
    dedicatedCost: costOverAllowance(p, billed),
    projectedQuantity,
    projectedListCost: listCost(p, projectedBilled),
    projectedDedicatedCost: costOverAllowance(p, projectedBilled),
    dailyCost: new Map(
      days.map((d) => [d, billable(d) ? listCost(p, byDay.get(d)!) : 0])
    ),
  };
}

export async function usageReport(
  db: DrizzleDB,
  env: CloudflareBindings,
  month: string,
  now = new Date()
): Promise<UsageReport> {
  const b = monthBounds(month);
  const book = priceBookFor(b.from);
  const nowMs = now.getTime();
  const monthEndMs = Math.min(b.end.getTime(), nowMs);
  // App-recorded data covers the month up to now (fractional days).
  const elapsedDays = Math.max(
    0,
    Math.min(b.days, (monthEndMs - b.start.getTime()) / 86_400_000)
  );
  const configured = analyticsConfigured(env);
  const resources = usageResources(env);
  const { probes, unconfigured } = buildProbes(resources);

  const [rows, syncs, sessions, aiRows] = await Promise.all([
    db
      .select()
      .from(usageDaily)
      .where(
        and(gte(usageDaily.date, b.from), lt(usageDaily.date, addDays(b.to, 1)))
      )
      .all(),
    db
      .select()
      .from(usageSyncs)
      .where(
        and(gte(usageSyncs.id, b.from), lt(usageSyncs.id, addDays(b.to, 1)))
      )
      .all(),
    db
      .select()
      .from(runnerSessions)
      .where(
        and(
          lt(runnerSessions.startedAt, b.end),
          or(
            isNull(runnerSessions.stoppedAt),
            gte(runnerSessions.stoppedAt, b.start)
          )
        )
      )
      .all(),
    db
      .select()
      .from(aiUsage)
      .where(and(gte(aiUsage.createdAt, b.start), lt(aiUsage.createdAt, b.end)))
      .all(),
  ]);

  // ── Series per metric from usage_daily ──
  const series = new Map<string, Series>();
  const syncedDays = new Set<string>();
  for (const r of rows) {
    let s = series.get(r.metric);
    if (!s)
      series.set(r.metric, (s = { byDay: new Map(), byResource: new Map() }));
    const isStorage = book.prices[r.metric]?.kind === 'storage';
    // Storage: the account's daily peak is the sum of each resource's peak.
    s.byDay.set(r.date, (s.byDay.get(r.date) ?? 0) + r.quantity);
    s.byResource.set(
      r.resource,
      isStorage
        ? Math.max(s.byResource.get(r.resource) ?? 0, r.quantity)
        : (s.byResource.get(r.resource) ?? 0) + r.quantity
    );
    if (r.source === 'cloudflare') syncedDays.add(r.date);
  }
  // The latest error each probe reported this month.
  const probeErrors = new Map<string, string>();
  for (const s of [...syncs].sort((x, y) => x.id.localeCompare(y.id)))
    for (const [k, v] of Object.entries(s.errors ?? {})) probeErrors.set(k, v);
  for (const s of syncs) syncedDays.add(s.id);
  const cloudflareDays = syncedDays.size;

  const daily = new Map<string, Partial<Record<Product, number>>>();
  const addDaily = (day: string, product: Product, cost: number) => {
    const d = daily.get(day) ?? {};
    d[product] = (d[product] ?? 0) + cost;
    daily.set(day, d);
  };

  const lines: UsageLine[] = [];
  const line = (
    metric: string,
    p: Price,
    priced: ReturnType<typeof priceSeries>,
    extra: Partial<UsageLine> & Pick<UsageLine, 'status' | 'source'>,
    resourcesOf: Map<string, number> = new Map()
  ): UsageLine => ({
    metric,
    product: p.product,
    productLabel: PRODUCT_LABELS[p.product],
    label: p.label,
    unit: p.unit,
    quantity: round(priced.quantity),
    included: p.included,
    includedPer: p.includedPer ?? 'month',
    includedLabel: p.included
      ? `${p.included.toLocaleString('en-US')} ${p.unit} per ${p.includedPer ?? 'month'}`
      : p.price
        ? 'none'
        : 'not billed',
    listCost: round(priced.listCost),
    dedicatedCost: round(priced.dedicatedCost),
    projectedQuantity: round(priced.projectedQuantity),
    projectedListCost: round(priced.projectedListCost),
    projectedDedicatedCost: round(priced.projectedDedicatedCost),
    billedFrom: p.billedFrom,
    resources: [...resourcesOf.entries()]
      .map(([resource, quantity]) => ({
        resource,
        quantity: round(
          p.kind === 'storage' ? quantity / BYTES_PER_GB : quantity
        ),
      }))
      .sort((x, y) => y.quantity - x.quantity),
    ...extra,
  });

  // ── Cloudflare analytics metrics ──
  const cloudflareMetrics = Object.entries(book.prices).filter(
    ([m, p]) =>
      p.product !== 'containers' &&
      p.product !== 'email' &&
      p.product !== 'ai-gateway'
  );
  for (const [metric, p] of cloudflareMetrics) {
    const s = series.get(metric);
    const metricProbes = probes.filter((x) => x.metrics.includes(metric));
    const failures = metricProbes
      .filter((x) => probeErrors.has(x.id))
      .map((x) => `${x.resource}: ${probeErrors.get(x.id)}`);
    const unverified = metricProbes.some((x) => !x.verified);
    let status: LineStatus = 'measured';
    let reason: string | undefined;
    if (!s) {
      if (!configured) {
        status = 'not-configured';
        reason =
          'Set the CF_ANALYTICS_TOKEN secret (an account API token with Account Analytics: Read).';
      } else if (!metricProbes.length) {
        status = 'not-configured';
        reason = unconfigured[p.product] ?? 'Not configured';
      } else {
        status = 'unavailable';
        reason = failures.length
          ? `Cloudflare did not return this metric: ${failures.join('; ')}`
          : 'Not synced yet. Use Sync now, or wait for the daily sync.';
      }
    } else if (failures.length)
      reason = `Partly unavailable: ${failures.join('; ')}`;
    const priced = priceSeries(p, s?.byDay ?? new Map(), {
      daysInMonth: b.days,
      observedDays: cloudflareDays,
      monthEnd: b.to,
    });
    for (const [d, c] of priced.dailyCost) addDaily(d, p.product, c);
    lines.push(
      line(
        metric,
        p,
        priced,
        {
          status,
          reason,
          source: 'cloudflare',
          note: unverified
            ? 'Uses analytics fields not yet confirmed in Cloudflare docs.'
            : undefined,
        },
        s?.byResource
      )
    );
  }

  // ── Email (counted by GitOrange) ──
  {
    const p = book.prices['email.sends'];
    const s = series.get('email.sends');
    const priced = priceSeries(p, s?.byDay ?? new Map(), {
      daysInMonth: b.days,
      observedDays: elapsedDays,
      monthEnd: b.to,
    });
    for (const [d, c] of priced.dailyCost) addDaily(d, 'email', c);
    lines.push(
      line('email.sends', p, priced, {
        status: 'measured',
        source: 'gitorange',
      })
    );
  }

  // ── Containers, from runner sessions ──
  const repoIds = new Set<string>();
  const containerSecs = new Map<string, number>(); // day → seconds × size (per metric below)
  const perMetricDay = {
    'containers.vcpu_s': new Map<string, number>(),
    'containers.memory_gib_s': new Map<string, number>(),
    'containers.disk_gb_s': new Map<string, number>(),
  };
  const byRepoSecs = new Map<string, { secs: number; cost: number }>();
  const byInstance = new Map<string, { secs: number; cost: number }>();
  let running = 0;
  const unitCost = (size: (typeof INSTANCE_SIZES)[string]) =>
    size.vcpu * book.prices['containers.vcpu_s'].price +
    size.memoryGib * book.prices['containers.memory_gib_s'].price +
    size.diskGb * book.prices['containers.disk_gb_s'].price;
  for (const s of sessions) {
    const size = INSTANCE_SIZES[s.instanceType] ?? INSTANCE_SIZES['standard-2'];
    const start = s.startedAt.getTime();
    const stop = s.stoppedAt
      ? s.stoppedAt.getTime()
      : Math.min(s.deadlineAt.getTime(), nowMs);
    if (!s.stoppedAt && s.deadlineAt.getTime() > nowMs) running++;
    let total = 0;
    for (let d = b.from; d <= b.to; d = addDays(d, 1)) {
      const dayStart = Date.parse(`${d}T00:00:00Z`);
      const secs = overlap(start, stop, dayStart, dayStart + 86_400_000);
      if (!secs) continue;
      total += secs;
      containerSecs.set(d, (containerSecs.get(d) ?? 0) + secs);
      perMetricDay['containers.vcpu_s'].set(
        d,
        (perMetricDay['containers.vcpu_s'].get(d) ?? 0) + secs * size.vcpu
      );
      perMetricDay['containers.memory_gib_s'].set(
        d,
        (perMetricDay['containers.memory_gib_s'].get(d) ?? 0) +
          secs * size.memoryGib
      );
      perMetricDay['containers.disk_gb_s'].set(
        d,
        (perMetricDay['containers.disk_gb_s'].get(d) ?? 0) + secs * size.diskGb
      );
    }
    const key = s.repositoryId ?? '';
    if (s.repositoryId) repoIds.add(s.repositoryId);
    const r = byRepoSecs.get(key) ?? { secs: 0, cost: 0 };
    r.secs += total;
    r.cost += total * unitCost(size);
    byRepoSecs.set(key, r);
    const i = byInstance.get(s.instanceType) ?? { secs: 0, cost: 0 };
    i.secs += total;
    i.cost += total * unitCost(size);
    byInstance.set(s.instanceType, i);
  }
  for (const [metric, byDay] of Object.entries(perMetricDay)) {
    const p = book.prices[metric];
    const priced = priceSeries(p, byDay, {
      daysInMonth: b.days,
      observedDays: elapsedDays,
      monthEnd: b.to,
    });
    for (const [d, c] of priced.dailyCost) addDaily(d, 'containers', c);
    lines.push(
      line(metric, p, priced, {
        status: 'measured',
        source: metric === 'containers.vcpu_s' ? 'estimate' : 'gitorange',
        note:
          metric === 'containers.vcpu_s'
            ? 'Runner time × vCPUs. Cloudflare bills vCPU on active use only, so the real charge is lower.'
            : 'Runner time × the instance size, from GitOrange Actions jobs.',
      })
    );
  }

  // ── Workers AI, from recorded calls ──
  const aiDaily = new Map<string, number>();
  const byFeature = new Map<string, AiBreakdown>();
  const byRepoAi = new Map<string, AiBreakdown>();
  let aiRequests = 0;
  let unreported = 0;
  let aiTokens = 0;
  const bump = (
    m: Map<string, AiBreakdown>,
    key: string,
    r: (typeof aiRows)[number],
    cost: number
  ) => {
    const x = m.get(key) ?? {
      key,
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
    };
    x.requests += r.requests;
    x.tokensIn += r.tokensIn ?? 0;
    x.tokensOut += r.tokensOut ?? 0;
    x.cost += cost;
    m.set(key, x);
  };
  for (const r of aiRows) {
    aiRequests += r.requests;
    const cost =
      r.tokensIn === null && r.tokensOut === null
        ? null
        : aiTokenCost(book, r.model, r.tokensIn ?? 0, r.tokensOut ?? 0);
    if (cost === null) unreported += r.requests;
    aiTokens += (r.tokensIn ?? 0) + (r.tokensOut ?? 0);
    const day = r.createdAt.toISOString().slice(0, 10);
    aiDaily.set(day, (aiDaily.get(day) ?? 0) + (cost ?? 0));
    bump(byFeature, r.feature, r, cost ?? 0);
    if (r.repositoryId) repoIds.add(r.repositoryId);
    bump(byRepoAi, r.repositoryId ?? '', r, cost ?? 0);
  }
  {
    const allowance = dailyAiAllowance(book);
    const days = [...aiDaily.keys()];
    const list = days.reduce((n, d) => n + aiDaily.get(d)!, 0);
    const dedicated = days.reduce(
      (n, d) => n + Math.max(0, aiDaily.get(d)! - allowance),
      0
    );
    const factor = elapsedDays > 0 ? b.days / elapsedDays : 1;
    const avgDaily = elapsedDays > 0 ? list / elapsedDays : 0;
    for (const [d, c] of aiDaily) addDaily(d, 'workers-ai', c);
    lines.push({
      metric: 'workers-ai.tokens',
      product: 'workers-ai',
      productLabel: PRODUCT_LABELS['workers-ai'],
      label: 'Model tokens (priced per model)',
      unit: 'tokens',
      quantity: aiTokens,
      included: book.neurons.freePerDay,
      includedPer: 'day',
      includedLabel: `${book.neurons.freePerDay.toLocaleString('en-US')} neurons per day`,
      listCost: round(list),
      dedicatedCost: round(dedicated),
      projectedQuantity: round(aiTokens * factor),
      projectedListCost: round(list * factor),
      projectedDedicatedCost: round(
        dedicated +
          Math.max(0, avgDaily - allowance) * Math.max(0, b.days - elapsedDays)
      ),
      status: 'measured',
      source: 'estimate',
      note:
        'Billed in neurons; priced here from token counts at Cloudflare’s per-model rates. ' +
        `The allowance is ${book.neurons.freePerDay.toLocaleString('en-US')} neurons per day for the whole account.` +
        (unreported
          ? ` ${unreported} call(s) reported no token counts and are not priced.`
          : ''),
      resources: [],
    });
  }

  // ── Names for the breakdowns ──
  const ids = [...repoIds];
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 90) {
    const found = await findReposByIds(db, ids.slice(i, i + 90));
    for (const [id, f] of found)
      names.set(id, `${f.namespace.username}/${f.repo.name}`);
  }
  const repoName = (id: string) =>
    id ? (names.get(id) ?? '(deleted repository)') : '(no repository)';

  // ── AI Gateway: whole gateway, reported apart ──
  let gateway: UsageReport['gateway'] = null;
  if (resources.aiGateway) {
    const req = series.get('ai-gateway.requests');
    const cost = series.get('ai-gateway.cost');
    const sum = (s?: Series) =>
      s ? [...s.byDay.values()].reduce((n, v) => n + v, 0) : null;
    const err = probes
      .filter((p) => p.product === 'ai-gateway' && probeErrors.has(p.id))
      .map((p) => probeErrors.get(p.id))
      .join('; ');
    gateway = {
      id: resources.aiGateway,
      requests: sum(req),
      estimatedCost: cost ? round(sum(cost)!) : null,
      status: req ? 'measured' : configured ? 'unavailable' : 'not-configured',
      reason: err || undefined,
    };
  }

  const totals = lines.reduce(
    (t, l) => ({
      listCost: t.listCost + l.listCost,
      dedicatedCost: t.dedicatedCost + l.dedicatedCost,
      projectedListCost: t.projectedListCost + l.projectedListCost,
      projectedDedicatedCost:
        t.projectedDedicatedCost + l.projectedDedicatedCost,
    }),
    {
      listCost: 0,
      dedicatedCost: 0,
      projectedListCost: 0,
      projectedDedicatedCost: 0,
    }
  );
  const actionsCost = [...byRepoSecs.values()].reduce((n, r) => n + r.cost, 0);
  const latest = [...syncs].sort(
    (x, y) => (y.completedAt?.getTime() ?? 0) - (x.completedAt?.getTime() ?? 0)
  )[0];

  return {
    month,
    from: b.from,
    to: b.to,
    daysInMonth: b.days,
    generatedAt: now.toISOString(),
    analyticsConfigured: configured,
    lastSync: latest
      ? {
          day: latest.id,
          completedAt: latest.completedAt?.toISOString() ?? null,
          status: latest.status,
        }
      : null,
    prices: {
      checkedOn: book.checkedOn,
      sources: book.sources,
      planFee: book.planFee,
    },
    lines,
    totals: {
      listCost: round(totals.listCost),
      dedicatedCost: round(totals.dedicatedCost),
      projectedListCost: round(totals.projectedListCost),
      projectedDedicatedCost: round(totals.projectedDedicatedCost),
    },
    daily: [...daily.entries()]
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([date, costs]) => ({
        date,
        costs: Object.fromEntries(
          Object.entries(costs).map(([k, v]) => [k, round(v!)])
        ),
      })),
    actions: {
      minutes: round(
        [...containerSecs.values()].reduce((n, s) => n + s, 0) / 60
      ),
      cost: round(actionsCost),
      running,
      byRepository: [...byRepoSecs.entries()]
        .map(([id, r]) => ({
          repository: repoName(id),
          minutes: round(r.secs / 60),
          cost: round(r.cost),
        }))
        .sort((x, y) => y.cost - x.cost),
      byInstance: [...byInstance.entries()]
        .map(([instanceType, r]) => ({
          instanceType,
          minutes: round(r.secs / 60),
          cost: round(r.cost),
        }))
        .sort((x, y) => y.cost - x.cost),
    },
    ai: {
      requests: aiRequests,
      cost: round([...aiDaily.values()].reduce((n, c) => n + c, 0)),
      unreportedRequests: unreported,
      byFeature: [...byFeature.values()]
        .map((x) => ({ ...x, cost: round(x.cost) }))
        .sort((x, y) => y.cost - x.cost),
      byRepository: [...byRepoAi.values()]
        .map((x) => ({ ...x, key: repoName(x.key), cost: round(x.cost) }))
        .sort((x, y) => y.cost - x.cost),
    },
    gateway,
    notMeasured: NOT_MEASURED,
  };
}
