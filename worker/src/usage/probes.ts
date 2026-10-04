/**
 * What to ask Cloudflare's GraphQL Analytics API, filtered to this deployment's own resources
 * (named by vars, never hard-coded). Each probe is one small query for one UTC day, so a field
 * or filter Cloudflare does not accept fails only that probe, and its metrics show as unavailable.
 *
 * `verified` marks probes whose dataset, fields, and filters all appear in Cloudflare's docs.
 * The others use names the docs do not list (checked by introspection later; see the PR).
 */
import type { Product } from './pricing';
import { r2Class } from './pricing';

export interface UsageResources {
  accountId: string;
  workerName: string;
  d1DatabaseId: string;
  buckets: string[];
  artifactsNamespace: string;
  workflows: string[];
  durableObjects: { className: string; namespaceId: string }[];
  /** null when AI Gateway is off. */
  aiGateway: string | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function usageResources(env: CloudflareBindings): UsageResources {
  const gateway = str(env.AI_GATEWAY) || 'default';
  return {
    accountId: str(env.R2_ACCOUNT_ID),
    workerName: str(env.WORKER_NAME),
    d1DatabaseId: str(env.D1_DATABASE_ID),
    buckets: [
      env.LFS_BUCKET_NAME,
      env.ACTIONS_LOGS_BUCKET_NAME,
      env.ACTIONS_CACHE_BUCKET_NAME,
    ]
      .map(str)
      .filter(Boolean),
    artifactsNamespace: str(env.ARTIFACTS_NAMESPACE),
    workflows: [env.ACTIONS_WORKFLOW_NAME, env.MERGE_RESOLUTION_WORKFLOW_NAME]
      .map(str)
      .filter(Boolean),
    durableObjects: [
      { className: 'JobRunner', namespaceId: str(env.JOB_RUNNER_NAMESPACE_ID) },
      {
        className: 'MergeResolver',
        namespaceId: str(env.MERGE_RESOLVER_NAMESPACE_ID),
      },
      { className: 'LiveHub', namespaceId: str(env.LIVE_NAMESPACE_ID) },
    ].filter((d) => d.namespaceId),
    aiGateway: gateway === 'off' ? null : gateway,
  };
}

export interface MetricRow {
  metric: string;
  resource: string;
  quantity: number;
}

/** One group of a GraphQL `*Groups` result. */
type Group = Record<string, any>;

export interface Probe {
  id: string;
  product: Product;
  /** Metric keys this probe writes (zero rows still record a measured 0). */
  metrics: string[];
  resource: string;
  verified: boolean;
  dataset: string;
  /** Filter on the deployment's resource, besides time. */
  filter: Record<string, string>;
  time: 'date' | 'datetime' | 'datetimeHour';
  /** Selection inside each group, e.g. `sum { requests }`. */
  select: string;
  parse(groups: Group[]): MetricRow[];
}

const sumOf = (groups: Group[], path: (g: Group) => unknown) =>
  groups.reduce((n, g) => n + (Number(path(g)) || 0), 0);
const maxOf = (groups: Group[], path: (g: Group) => unknown) =>
  groups.reduce((n, g) => Math.max(n, Number(path(g)) || 0), 0);

/** Every probe this deployment's configuration allows. Unconfigured resources are listed apart. */
export function buildProbes(r: UsageResources): {
  probes: Probe[];
  unconfigured: Record<string, string>;
} {
  const probes: Probe[] = [];
  const unconfigured: Record<string, string> = {};

  if (r.workerName) {
    const w = r.workerName;
    probes.push(
      {
        id: `workers.requests:${w}`,
        product: 'workers',
        metrics: ['workers.requests'],
        resource: w,
        verified: true,
        dataset: 'workersInvocationsAdaptive',
        filter: { scriptName: w },
        time: 'datetime',
        select: 'sum { requests }',
        parse: (g) => [
          {
            metric: 'workers.requests',
            resource: w,
            quantity: sumOf(g, (x) => x.sum?.requests),
          },
        ],
      },
      {
        id: `workers.cpu:${w}`,
        product: 'workers',
        metrics: ['workers.cpu_ms'],
        resource: w,
        verified: false,
        dataset: 'workersInvocationsAdaptive',
        filter: { scriptName: w },
        time: 'datetime',
        select: 'sum { cpuTimeUs }',
        parse: (g) => [
          {
            metric: 'workers.cpu_ms',
            resource: w,
            quantity: sumOf(g, (x) => x.sum?.cpuTimeUs) / 1000,
          },
        ],
      }
    );
  } else unconfigured['workers'] = 'WORKER_NAME is not set';

  if (r.durableObjects.length) {
    for (const { className, namespaceId } of r.durableObjects) {
      const filter = { namespaceId };
      probes.push(
        {
          id: `do.requests:${className}`,
          product: 'durable-objects',
          metrics: ['do.requests'],
          resource: className,
          verified: false,
          dataset: 'durableObjectsInvocationsAdaptiveGroups',
          filter,
          time: 'date',
          select: 'sum { requests }',
          parse: (g) => [
            {
              metric: 'do.requests',
              resource: className,
              quantity: sumOf(g, (x) => x.sum?.requests),
            },
          ],
        },
        {
          // activeTime: microseconds an object was billed for (not hibernating). 128 MB each.
          id: `do.duration:${className}`,
          product: 'durable-objects',
          metrics: ['do.duration_gb_s'],
          resource: className,
          verified: false,
          dataset: 'durableObjectsPeriodicGroups',
          filter,
          time: 'date',
          select: 'sum { activeTime }',
          parse: (g) => [
            {
              metric: 'do.duration_gb_s',
              resource: className,
              quantity: (sumOf(g, (x) => x.sum?.activeTime) / 1e6) * 0.125,
            },
          ],
        },
        {
          id: `do.rows:${className}`,
          product: 'durable-objects',
          metrics: ['do.rows_read', 'do.rows_written'],
          resource: className,
          verified: false,
          dataset: 'durableObjectsPeriodicGroups',
          filter,
          time: 'date',
          select: 'sum { rowsRead rowsWritten }',
          parse: (g) => [
            {
              metric: 'do.rows_read',
              resource: className,
              quantity: sumOf(g, (x) => x.sum?.rowsRead),
            },
            {
              metric: 'do.rows_written',
              resource: className,
              quantity: sumOf(g, (x) => x.sum?.rowsWritten),
            },
          ],
        },
        {
          id: `do.storage:${className}`,
          product: 'durable-objects',
          metrics: ['do.storage_bytes'],
          resource: className,
          verified: false,
          dataset: 'durableObjectsStorageGroups',
          filter,
          time: 'date',
          select: 'max { storedBytes }',
          parse: (g) => [
            {
              metric: 'do.storage_bytes',
              resource: className,
              quantity: maxOf(g, (x) => x.max?.storedBytes),
            },
          ],
        }
      );
    }
  } else
    unconfigured['durable-objects'] =
      'No Durable Object namespace IDs are set (JOB_RUNNER_NAMESPACE_ID, MERGE_RESOLVER_NAMESPACE_ID, LIVE_NAMESPACE_ID)';

  if (r.workflows.length) {
    for (const name of r.workflows) {
      probes.push(
        {
          id: `workflows.invocations:${name}`,
          product: 'workflows',
          metrics: ['workflows.invocations'],
          resource: name,
          verified: true,
          dataset: 'workflowsAdaptiveGroups',
          filter: { workflowName: name, eventType: 'WORKFLOW_START' },
          time: 'datetimeHour',
          select: 'count',
          parse: (g) => [
            {
              metric: 'workflows.invocations',
              resource: name,
              quantity: sumOf(g, (x) => x.count),
            },
          ],
        },
        {
          id: `workflows.steps:${name}`,
          product: 'workflows',
          metrics: ['workflows.steps'],
          resource: name,
          verified: true,
          dataset: 'workflowsAdaptiveGroups',
          filter: { workflowName: name, eventType: 'STEP_START' },
          time: 'datetimeHour',
          select: 'count',
          parse: (g) => [
            {
              metric: 'workflows.steps',
              resource: name,
              quantity: sumOf(g, (x) => x.count),
            },
          ],
        }
      );
    }
  } else
    unconfigured['workflows'] =
      'ACTIONS_WORKFLOW_NAME and MERGE_RESOLUTION_WORKFLOW_NAME are not set';

  if (r.d1DatabaseId) {
    const id = r.d1DatabaseId;
    probes.push(
      {
        id: `d1.rows:${id}`,
        product: 'd1',
        metrics: ['d1.rows_read', 'd1.rows_written'],
        resource: id,
        verified: true,
        dataset: 'd1AnalyticsAdaptiveGroups',
        filter: { databaseId: id },
        time: 'date',
        select: 'sum { rowsRead rowsWritten }',
        parse: (g) => [
          {
            metric: 'd1.rows_read',
            resource: id,
            quantity: sumOf(g, (x) => x.sum?.rowsRead),
          },
          {
            metric: 'd1.rows_written',
            resource: id,
            quantity: sumOf(g, (x) => x.sum?.rowsWritten),
          },
        ],
      },
      {
        id: `d1.storage:${id}`,
        product: 'd1',
        metrics: ['d1.storage_bytes'],
        resource: id,
        verified: true,
        dataset: 'd1StorageAdaptiveGroups',
        filter: { databaseId: id },
        time: 'date',
        select: 'max { databaseSizeBytes }',
        parse: (g) => [
          {
            metric: 'd1.storage_bytes',
            resource: id,
            quantity: maxOf(g, (x) => x.max?.databaseSizeBytes),
          },
        ],
      }
    );
  } else unconfigured['d1'] = 'D1_DATABASE_ID is not set';

  for (const bucket of r.buckets) {
    probes.push(
      {
        id: `r2.operations:${bucket}`,
        product: 'r2',
        metrics: ['r2.class_a', 'r2.class_b'],
        resource: bucket,
        verified: true,
        dataset: 'r2OperationsAdaptiveGroups',
        filter: { bucketName: bucket },
        time: 'datetime',
        select: 'sum { requests } dimensions { actionType }',
        parse: (g) => {
          let a = 0;
          let b = 0;
          for (const x of g) {
            const cls = r2Class(String(x.dimensions?.actionType ?? ''));
            const n = Number(x.sum?.requests) || 0;
            if (cls === 'a') a += n;
            else if (cls === 'b') b += n;
          }
          return [
            { metric: 'r2.class_a', resource: bucket, quantity: a },
            { metric: 'r2.class_b', resource: bucket, quantity: b },
          ];
        },
      },
      {
        id: `r2.storage:${bucket}`,
        product: 'r2',
        metrics: ['r2.storage_bytes'],
        resource: bucket,
        verified: true,
        dataset: 'r2StorageAdaptiveGroups',
        filter: { bucketName: bucket },
        time: 'datetime',
        select: 'max { payloadSize metadataSize }',
        parse: (g) => [
          {
            metric: 'r2.storage_bytes',
            resource: bucket,
            quantity:
              maxOf(g, (x) => x.max?.payloadSize) +
              maxOf(g, (x) => x.max?.metadataSize),
          },
        ],
      }
    );
  }
  if (!r.buckets.length) unconfigured['r2'] = 'No bucket names are set';

  if (r.artifactsNamespace) {
    const ns = r.artifactsNamespace;
    probes.push({
      id: `artifacts.operations:${ns}`,
      product: 'artifacts',
      metrics: ['artifacts.operations'],
      resource: ns,
      verified: false,
      dataset: 'artifactsEventsAdaptiveGroups',
      filter: { repositoryNamespace: ns },
      time: 'datetime',
      select: 'count dimensions { eventKind }',
      // Errors are listed apart from actions; only actions are counted as operations.
      parse: (g) => [
        {
          metric: 'artifacts.operations',
          resource: ns,
          quantity: sumOf(
            g.filter((x) => x.dimensions?.eventKind !== 'error'),
            (x) => x.count
          ),
        },
      ],
    });
  } else unconfigured['artifacts'] = 'ARTIFACTS_NAMESPACE is not set';

  if (r.aiGateway) {
    const gw = r.aiGateway;
    probes.push(
      {
        id: `ai-gateway.requests:${gw}`,
        product: 'ai-gateway',
        metrics: ['ai-gateway.requests'],
        resource: gw,
        verified: true,
        dataset: 'aiGatewayRequestsAdaptiveGroups',
        filter: { gateway: gw },
        time: 'datetimeHour',
        select: 'count',
        parse: (g) => [
          {
            metric: 'ai-gateway.requests',
            resource: gw,
            quantity: sumOf(g, (x) => x.count),
          },
        ],
      },
      {
        id: `ai-gateway.cost:${gw}`,
        product: 'ai-gateway',
        metrics: ['ai-gateway.cost'],
        resource: gw,
        verified: false,
        dataset: 'aiGatewayRequestsAdaptiveGroups',
        filter: { gateway: gw },
        time: 'datetimeHour',
        select: 'sum { cost }',
        parse: (g) => [
          {
            metric: 'ai-gateway.cost',
            resource: gw,
            quantity: sumOf(g, (x) => x.sum?.cost),
          },
        ],
      }
    );
  } else unconfigured['ai-gateway'] = 'AI_GATEWAY is "off"';

  return { probes, unconfigured };
}

/** A GraphQL string literal (JSON string syntax is valid GraphQL for these values). */
const lit = (v: string) => JSON.stringify(v);

function timeFilter(time: Probe['time'], day: string): string {
  switch (time) {
    case 'date':
      return `date_geq: ${lit(day)}, date_leq: ${lit(day)}`;
    case 'datetime':
      return `datetime_geq: ${lit(`${day}T00:00:00Z`)}, datetime_leq: ${lit(`${day}T23:59:59Z`)}`;
    case 'datetimeHour':
      return `datetimeHour_geq: ${lit(`${day}T00:00:00Z`)}, datetimeHour_leq: ${lit(`${day}T23:00:00Z`)}`;
  }
}

/** The query for one probe and one UTC day. */
export function probeQuery(p: Probe, day: string): string {
  const filter = [
    ...Object.entries(p.filter).map(([k, v]) => `${k}: ${lit(v)}`),
    timeFilter(p.time, day),
  ].join(', ');
  return `query GitOrangeUsage($accountTag: string!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      groups: ${p.dataset}(limit: 10000, filter: { ${filter} }) { ${p.select} }
    }
  }
}`;
}

export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

/** Runs one probe for one day. Errors carry Cloudflare's message, never the token. */
export async function runProbe(
  fetchImpl: typeof fetch,
  token: string,
  accountId: string,
  p: Probe,
  day: string
): Promise<MetricRow[]> {
  const res = await fetchImpl(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: probeQuery(p, day),
      variables: { accountTag: accountId },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from the GraphQL API`);
  const body = (await res.json()) as {
    data?: { viewer?: { accounts?: { groups?: Group[] }[] } } | null;
    errors?: { message?: string }[] | null;
  };
  if (body.errors?.length)
    throw new Error(
      body.errors
        .map((e) => e.message ?? 'error')
        .join('; ')
        .slice(0, 300)
    );
  const account = body.data?.viewer?.accounts?.[0];
  if (!account) throw new Error('The token cannot read this account');
  return p.parse(account.groups ?? []);
}
