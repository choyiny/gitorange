/**
 * Cloudflare list prices for everything GitOrange uses, on the Workers Paid plan. This is the only
 * place prices live. Add a new book (with its `effectiveFrom`) when Cloudflare changes a price, so
 * past months keep the prices that were in force.
 *
 * Included allowances are per Cloudflare account, shared with anything else on the account.
 */

export type Product =
  | 'workers'
  | 'durable-objects'
  | 'workflows'
  | 'd1'
  | 'r2'
  | 'artifacts'
  | 'containers'
  | 'workers-ai'
  | 'email'
  | 'ai-gateway';

export const PRODUCT_LABELS: Record<Product, string> = {
  workers: 'Workers',
  'durable-objects': 'Durable Objects',
  workflows: 'Workflows',
  d1: 'D1',
  r2: 'R2',
  artifacts: 'Artifacts',
  containers: 'Containers (Actions runners)',
  'workers-ai': 'Workers AI',
  email: 'Email Sending',
  'ai-gateway': 'AI Gateway',
};

export interface Price {
  product: Product;
  label: string;
  /** Unit the quantity is measured in, e.g. "requests", "GB-month". */
  unit: string;
  /**
   * `flow` quantities add up over the period; `storage` quantities are daily peaks in bytes,
   * billed as GB-month (the average of each day's peak over 30 days).
   */
  kind: 'flow' | 'storage';
  /** Included per month (or per day, see `includedPer`), in `unit`. */
  included: number;
  includedPer?: 'month' | 'day';
  /** Dollars per `per` units over the allowance. 0 means informational only (not billed). */
  price: number;
  per: number;
  /** Cloudflare starts billing this metric on this UTC day (earlier usage costs nothing). */
  billedFrom?: string;
}

/** Bytes per GB for storage metrics (Cloudflare's docs do not define GB; decimal is assumed). */
export const BYTES_PER_GB = 1e9;

const M = 1_000_000;

/** Metric key → price. Metric keys are what usage_daily.metric holds. */
type PriceTable = Record<string, Price>;

export interface PriceBook {
  /** First UTC day these prices apply to. */
  effectiveFrom: string;
  /** When someone last compared this book with the sources. */
  checkedOn: string;
  sources: string[];
  /** Workers Paid base fee, per account per month. */
  planFee: number;
  prices: PriceTable;
  /** Workers AI token prices per model, in dollars per million tokens. */
  models: Record<string, { in: number; out: number }>;
  /** Workers AI: dollars per 1,000 neurons, and the free neurons per account per day. */
  neurons: { pricePer1000: number; freePerDay: number };
}

export const PRICE_BOOKS: PriceBook[] = [
  {
    effectiveFrom: '2026-01-01',
    checkedOn: '2026-10-04',
    sources: [
      'https://developers.cloudflare.com/workers/platform/pricing/',
      'https://developers.cloudflare.com/durable-objects/platform/pricing/',
      'https://developers.cloudflare.com/workflows/reference/pricing/',
      'https://developers.cloudflare.com/d1/platform/pricing/',
      'https://developers.cloudflare.com/r2/pricing/',
      'https://developers.cloudflare.com/containers/platform/pricing/',
      'https://developers.cloudflare.com/artifacts/platform/pricing/',
      'https://developers.cloudflare.com/workers-ai/platform/pricing/',
      'https://developers.cloudflare.com/email-service/platform/pricing/',
      'https://developers.cloudflare.com/ai-gateway/reference/pricing/',
    ],
    planFee: 5,
    prices: {
      'workers.requests': {
        product: 'workers',
        label: 'Requests',
        unit: 'requests',
        kind: 'flow',
        included: 10 * M,
        price: 0.3,
        per: M,
      },
      'workers.cpu_ms': {
        product: 'workers',
        label: 'CPU time',
        unit: 'CPU ms',
        kind: 'flow',
        included: 30 * M,
        price: 0.02,
        per: M,
      },
      'do.requests': {
        product: 'durable-objects',
        label: 'Requests',
        unit: 'requests',
        kind: 'flow',
        included: M,
        price: 0.15,
        per: M,
      },
      'do.duration_gb_s': {
        product: 'durable-objects',
        label: 'Duration (128 MB per object)',
        unit: 'GB-s',
        kind: 'flow',
        included: 400_000,
        price: 12.5,
        per: M,
      },
      'do.rows_read': {
        product: 'durable-objects',
        label: 'SQLite rows read',
        unit: 'rows',
        kind: 'flow',
        included: 25_000 * M,
        price: 0.001,
        per: M,
      },
      'do.rows_written': {
        product: 'durable-objects',
        label: 'SQLite rows written',
        unit: 'rows',
        kind: 'flow',
        included: 50 * M,
        price: 1,
        per: M,
      },
      'do.storage_bytes': {
        product: 'durable-objects',
        label: 'SQLite storage',
        unit: 'GB-month',
        kind: 'storage',
        included: 5,
        price: 0.2,
        per: 1,
      },
      'workflows.invocations': {
        product: 'workflows',
        label: 'Invocations (billed as Workers requests)',
        unit: 'runs',
        kind: 'flow',
        included: 0,
        price: 0,
        per: 1,
      },
      'workflows.steps': {
        product: 'workflows',
        label: 'Steps',
        unit: 'steps',
        kind: 'flow',
        included: 500_000,
        price: 0.8,
        per: 100_000,
        billedFrom: '2026-08-10',
      },
      'd1.rows_read': {
        product: 'd1',
        label: 'Rows read',
        unit: 'rows',
        kind: 'flow',
        included: 25_000 * M,
        price: 0.001,
        per: M,
      },
      'd1.rows_written': {
        product: 'd1',
        label: 'Rows written',
        unit: 'rows',
        kind: 'flow',
        included: 50 * M,
        price: 1,
        per: M,
      },
      'd1.storage_bytes': {
        product: 'd1',
        label: 'Storage',
        unit: 'GB-month',
        kind: 'storage',
        included: 5,
        price: 0.75,
        per: 1,
      },
      'r2.class_a': {
        product: 'r2',
        label: 'Class A operations',
        unit: 'operations',
        kind: 'flow',
        included: M,
        price: 4.5,
        per: M,
      },
      'r2.class_b': {
        product: 'r2',
        label: 'Class B operations',
        unit: 'operations',
        kind: 'flow',
        included: 10 * M,
        price: 0.36,
        per: M,
      },
      'r2.storage_bytes': {
        product: 'r2',
        label: 'Storage (Standard)',
        unit: 'GB-month',
        kind: 'storage',
        included: 10,
        price: 0.015,
        per: 1,
      },
      'artifacts.operations': {
        product: 'artifacts',
        label: 'Operations',
        unit: 'operations',
        kind: 'flow',
        included: 10_000,
        price: 0.15,
        per: 1000,
        billedFrom: '2026-10-14',
      },
      'containers.vcpu_s': {
        product: 'containers',
        label: 'vCPU (upper bound: billed on active use)',
        unit: 'vCPU-s',
        kind: 'flow',
        included: 375 * 60,
        price: 0.00002,
        per: 1,
      },
      'containers.memory_gib_s': {
        product: 'containers',
        label: 'Memory (provisioned)',
        unit: 'GiB-s',
        kind: 'flow',
        included: 25 * 3600,
        price: 0.0000025,
        per: 1,
      },
      'containers.disk_gb_s': {
        product: 'containers',
        label: 'Disk (provisioned)',
        unit: 'GB-s',
        kind: 'flow',
        included: 200 * 3600,
        price: 0.00000007,
        per: 1,
      },
      'email.sends': {
        product: 'email',
        label: 'Emails sent',
        unit: 'emails',
        kind: 'flow',
        included: 3000,
        price: 0.35,
        per: 1000,
      },
      'ai-gateway.requests': {
        product: 'ai-gateway',
        label: 'Requests (whole gateway; AI Gateway itself is free)',
        unit: 'requests',
        kind: 'flow',
        included: 0,
        price: 0,
        per: 1,
      },
      'ai-gateway.cost': {
        product: 'ai-gateway',
        label: "Gateway's own cost estimate (whole gateway)",
        unit: 'USD',
        kind: 'flow',
        included: 0,
        price: 0,
        per: 1,
      },
    },
    models: {
      '@cf/zai-org/glm-5.3': { in: 1.4, out: 4.4 },
      '@cf/zai-org/glm-5.3-flash': { in: 0.15, out: 0.5 },
      '@cf/cloudflare/clef': { in: 0.24, out: 0 },
      '@cf/cloudflare/clef-flash': { in: 0.09, out: 0 },
    },
    neurons: { pricePer1000: 0.011, freePerDay: 10_000 },
  },
];

/** The book in force on a UTC day (YYYY-MM-DD). */
export function priceBookFor(day: string): PriceBook {
  let book = PRICE_BOOKS[0];
  for (const b of PRICE_BOOKS) if (b.effectiveFrom <= day) book = b;
  return book;
}

/** The product a metric key belongs to. */
export function productOf(metric: string): string {
  const latest = PRICE_BOOKS[PRICE_BOOKS.length - 1];
  return latest.prices[metric]?.product ?? metric.split('.')[0];
}

/** Dollars for `quantity` units of a price, ignoring the allowance. */
export function listCost(p: Price, quantity: number): number {
  return (Math.max(0, quantity) / p.per) * p.price;
}

/** Dollars for the part of `quantity` above the allowance (monthly allowances only). */
export function costOverAllowance(p: Price, quantity: number): number {
  return listCost(p, quantity - p.included);
}

/** Dollars for a Workers AI call, from its token counts. Unknown models cost null. */
export function aiTokenCost(
  book: PriceBook,
  model: string,
  tokensIn: number,
  tokensOut: number
): number | null {
  const m = book.models[model];
  if (!m) return null;
  return (tokensIn * m.in + tokensOut * m.out) / M;
}

/** The free Workers AI neurons of one day, in dollars. */
export function dailyAiAllowance(book: PriceBook): number {
  return (book.neurons.freePerDay / 1000) * book.neurons.pricePer1000;
}

/** Container instance sizes (vCPU, memory GiB, disk GB). */
export const INSTANCE_SIZES: Record<
  string,
  { vcpu: number; memoryGib: number; diskGb: number }
> = {
  lite: { vcpu: 1 / 16, memoryGib: 0.25, diskGb: 2 },
  basic: { vcpu: 1 / 4, memoryGib: 1, diskGb: 4 },
  'standard-1': { vcpu: 1 / 2, memoryGib: 4, diskGb: 8 },
  'standard-2': { vcpu: 1, memoryGib: 6, diskGb: 12 },
  'standard-3': { vcpu: 2, memoryGib: 8, diskGb: 16 },
  'standard-4': { vcpu: 4, memoryGib: 12, diskGb: 20 },
};

/** R2 operation names by billing class (DeleteObject and friends are free). */
const R2_CLASS_A = new Set([
  'ListBuckets',
  'PutBucket',
  'ListObjects',
  'PutObject',
  'CopyObject',
  'CompleteMultipartUpload',
  'CreateMultipartUpload',
  'LifecycleStorageTierTransition',
  'ListMultipartUploads',
  'UploadPart',
  'UploadPartCopy',
  'ListParts',
  'PutBucketEncryption',
  'PutBucketCors',
  'PutBucketLifecycleConfiguration',
]);
const R2_CLASS_B = new Set([
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'UsageSummary',
  'GetBucketEncryption',
  'GetBucketLocation',
  'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);

export function r2Class(actionType: string): 'a' | 'b' | null {
  if (R2_CLASS_A.has(actionType)) return 'a';
  if (R2_CLASS_B.has(actionType)) return 'b';
  return null;
}
