import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { latestSync } from '../usage/sync';
/**
 * Site admin → Setup: checks this deployment's secrets, bindings, and variables and says how to
 * fix what's wrong. Computed per request, nothing stored. Never returns or logs a secret's value:
 * secrets are reported as present, missing, or too short.
 */
import { presign } from './lfs';
import { aiGateway } from './ai-gateway';
import journal from '../../../migrations/meta/_journal.json?raw';

export type SetupStatus = 'ok' | 'warning' | 'error';
/** One fix step: prose, optionally a command to run and a link to open. */
export type SetupStep = { text: string; code?: string; link?: string };
export type SetupCheck = {
  id: string;
  category:
    | 'Secrets'
    | 'Bindings'
    | 'Connectivity'
    | 'Variables'
    | 'AI Gateway'
    | 'Usage & cost';
  title: string;
  status: SetupStatus;
  detail: string;
  fix: SetupStep[];
};

const PROBE_TIMEOUT_MS = 4000;
/** A key that never exists: probes only read it. */
const PROBE_KEY = '__gitorange-setup-probe';
/** `.dev.vars.example`'s placeholder. */
const EXAMPLE_AUTH_SECRET = 'change-me-to-a-long-random-string';
export const MIN_AUTH_SECRET_LENGTH = 32;

const DASH = {
  r2Tokens: 'https://dash.cloudflare.com/?to=/:account/r2/api-tokens',
  r2: 'https://dash.cloudflare.com/?to=/:account/r2/overview',
  email: 'https://dash.cloudflare.com/?to=/:account/email-service',
  gateway: 'https://dash.cloudflare.com/?to=/:account/ai/ai-gateway',
  workers: 'https://dash.cloudflare.com/?to=/:account/workers-and-pages',
};
const DOCS = 'docs/configuration.md';

/** Migrations this build ships, as wrangler records them in `d1_migrations.name`. */
export function knownMigrations(): string[] {
  const j = JSON.parse(journal) as { entries: { tag: string }[] };
  return j.entries.map((e) => `${e.tag}.sql`);
}

async function withTimeout<T>(
  p: Promise<T>,
  ms = PROBE_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** An error's message, short and on one line. Binding errors don't carry secrets. */
function reason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s+/g, ' ').slice(0, 160) || 'unknown error';
}

const isPlaceholder = (v: string) => /<[^>]*>/.test(v);

type Ctx = {
  env: Partial<CloudflareBindings> & Record<string, unknown>;
  /** The origin the admin is looking at the page from. */
  origin: string;
  /** Running under `yarn dev` (loopback): fixes go in .dev.vars and `env.dev`. */
  local: boolean;
};

function secretFix(ctx: Ctx, name: string, generate?: string): SetupStep[] {
  if (ctx.local)
    return [
      {
        text: `Add ${name} to .dev.vars in the repository root (see .dev.vars.example), then restart yarn dev.`,
        code: generate
          ? `echo "${name}=$(${generate})" >> .dev.vars`
          : `${name}=…`,
      },
    ];
  return [
    {
      text: `From the repository root, set the secret on the deployed worker (it prompts for the value, and rolls out a new version):`,
      code: generate
        ? `${generate} | yarn wrangler secret put ${name}`
        : `yarn wrangler secret put ${name}`,
    },
  ];
}

// ── Secrets ──────────────────────────────────────────────────────────────────

function secretChecks(ctx: Ctx): SetupCheck[] {
  const { env } = ctx;
  const out: SetupCheck[] = [];
  const auth =
    typeof env.BETTER_AUTH_SECRET === 'string' ? env.BETTER_AUTH_SECRET : '';
  const authFix = [
    ...secretFix(ctx, 'BETTER_AUTH_SECRET', 'openssl rand -hex 32'),
    {
      text: 'Changing it signs everyone out and disconnects every MCP app; they reconnect by signing in again.',
    },
  ];
  out.push(
    !auth
      ? {
          id: 'secret-better-auth',
          category: 'Secrets',
          title: 'BETTER_AUTH_SECRET',
          status: 'error',
          detail:
            'Missing. Sessions and the MCP OAuth signing keys are protected with a built-in default secret anyone can read, or sign-in fails outright.',
          fix: authFix,
        }
      : auth === EXAMPLE_AUTH_SECRET
        ? {
            id: 'secret-better-auth',
            category: 'Secrets',
            title: 'BETTER_AUTH_SECRET',
            status: 'error',
            detail:
              'Still the placeholder from .dev.vars.example, so anyone can forge sessions. Replace it with a random value.',
            fix: authFix,
          }
        : auth.length < MIN_AUTH_SECRET_LENGTH
          ? {
              id: 'secret-better-auth',
              category: 'Secrets',
              title: 'BETTER_AUTH_SECRET',
              status: 'error',
              detail: `Set, but only ${auth.length} characters. Use at least ${MIN_AUTH_SECRET_LENGTH} random characters so sessions can't be forged.`,
              fix: authFix,
            }
          : {
              id: 'secret-better-auth',
              category: 'Secrets',
              title: 'BETTER_AUTH_SECRET',
              status: 'ok',
              detail: `Set (${MIN_AUTH_SECRET_LENGTH}+ characters).`,
              fix: [],
            }
  );

  const missing = (
    ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const
  ).filter((n) => !env[n]);
  out.push(
    missing.length
      ? {
          id: 'secret-r2',
          category: 'Secrets',
          title: 'R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY',
          status: 'error',
          detail: `Missing ${missing.join(' and ')}. Git LFS answers "not configured" (pushes with LFS files fail) and Actions jobs run without a cache. Everything else works.`,
          fix: [
            {
              text: 'Create an R2 API token: R2 → Manage API tokens → Create API token, permission Object Read & Write, scoped to the LFS and Actions cache buckets. Copy its Access Key ID and Secret Access Key (S3 credentials).',
              link: DASH.r2Tokens,
            },
            ...missing.flatMap((n) => secretFix(ctx, n)),
          ],
        }
      : {
          id: 'secret-r2',
          category: 'Secrets',
          title: 'R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY',
          status: 'ok',
          detail: 'Both set. Git LFS and the Actions cache can sign R2 URLs.',
          fix: [],
        }
  );
  return out;
}

// ── Bindings present ─────────────────────────────────────────────────────────

type BindingSpec = {
  name: keyof CloudflareBindings;
  required: boolean;
  /** What breaks without it. */
  without: string;
  snippet: string;
};

const BINDINGS: BindingSpec[] = [
  {
    name: 'DB',
    required: true,
    without:
      'Nothing works: users, repositories, and pull requests live in D1.',
    snippet: `"d1_databases": [
  { "binding": "DB", "database_name": "gitorange-db", "database_id": "<id from wrangler d1 create>", "migrations_dir": "migrations" }
]`,
  },
  {
    name: 'ARTIFACTS',
    required: true,
    without:
      'No git storage: repositories cannot be created, browsed, cloned, or pushed.',
    snippet: `"artifacts": [{ "binding": "ARTIFACTS", "namespace": "gitorange" }]`,
  },
  {
    name: 'ASSETS',
    required: true,
    without: 'The web app is not served.',
    snippet: `"assets": {
  "binding": "ASSETS",
  "directory": "./dist/client",
  "not_found_handling": "single-page-application",
  "run_worker_first": ["/api/*", "/*/*.git/*", "/*/*.git", "/mcp", "/.well-known/*"]
}`,
  },
  {
    name: 'LFS',
    required: true,
    without:
      'Git LFS cannot store files, and deleting a repository cannot clean up its LFS objects.',
    snippet: `"r2_buckets": [
  { "binding": "LFS", "bucket_name": "gitorange-lfs" },
  …
]`,
  },
  {
    name: 'EMAIL',
    required: false,
    without:
      'Invitation and verification emails are not sent; you have to share invite links by hand.',
    snippet: `"send_email": [{ "name": "EMAIL" }]`,
  },
  {
    name: 'ACTIONS_RUN',
    required: false,
    without: 'Actions is off: pushes never queue workflow runs.',
    snippet: `"workflows": [
  { "name": "gitorange-actions-run", "binding": "ACTIONS_RUN", "class_name": "ActionsRun" },
  …
]`,
  },
  {
    name: 'JOB_RUNNER',
    required: false,
    without: 'Actions jobs have no container to run in.',
    snippet: `"containers": [
  { "class_name": "JobRunner", "scheduling_policy": "durable_object", "images": { "runner": { "dockerfile": "./actions/runner/Dockerfile" } } }
],
"durable_objects": { "bindings": [{ "name": "JOB_RUNNER", "class_name": "JobRunner" }, …] }`,
  },
  {
    name: 'ACTIONS_QUEUE',
    required: false,
    without:
      'Actions jobs start as soon as they are ready, with no limit on how many run at once (Site admin → Settings → Jobs running at once is ignored).',
    snippet: `"durable_objects": { "bindings": [{ "name": "ACTIONS_QUEUE", "class_name": "ActionsQueue" }, …] },
"exports": { "ActionsQueue": { "type": "durable-object", "storage": "sqlite" }, … }`,
  },
  {
    name: 'ACTIONS_LOGS',
    required: false,
    without: 'Actions step logs cannot be stored or shown.',
    snippet: `"r2_buckets": [
  { "binding": "ACTIONS_LOGS", "bucket_name": "gitorange-actions-logs" },
  …
]`,
  },
  {
    name: 'ACTIONS_CACHE',
    required: false,
    without:
      'Actions jobs run without a cache (actions/cache, setup-node cache:).',
    snippet: `"r2_buckets": [
  { "binding": "ACTIONS_CACHE", "bucket_name": "gitorange-actions-cache" },
  …
]`,
  },
  {
    name: 'MERGE_RESOLUTION',
    required: false,
    without:
      'No AI conflict resolution and no agent reviews: conflicts must be resolved locally and a person approves every pull request.',
    snippet: `"workflows": [
  { "name": "gitorange-merge-resolution", "binding": "MERGE_RESOLUTION", "class_name": "MergeResolutionWorkflow" },
  …
]`,
  },
  {
    name: 'MERGE_RESOLVER',
    required: false,
    without: 'AI conflict resolution has no workspace to run in.',
    snippet: `"durable_objects": { "bindings": [{ "name": "MERGE_RESOLVER", "class_name": "MergeResolver" }, …] }`,
  },
  {
    name: 'AGENT_REVIEWER',
    required: false,
    without:
      'engine: pi agents review as a single pass (one model call), as engine: pass agents do, and their reviews say so.',
    snippet: `"durable_objects": { "bindings": [{ "name": "AGENT_REVIEWER", "class_name": "AgentReviewer" }, …] }`,
  },
  {
    name: 'AI',
    required: false,
    without:
      'Workers AI is unavailable: AI conflict resolution and agent reviews fail.',
    snippet: `"ai": { "binding": "AI" }`,
  },
  {
    name: 'LIVE',
    required: false,
    without:
      "Pages don't update live; people refresh to see new pushes, runs, and approvals.",
    snippet: `"durable_objects": { "bindings": [{ "name": "LIVE", "class_name": "LiveHub" }, …] }`,
  },
];

function bindingChecks(ctx: Ctx): SetupCheck[] {
  return BINDINGS.map((b): SetupCheck => {
    const present = Boolean(ctx.env[b.name]);
    if (present)
      return {
        id: `binding-${b.name}`,
        category: 'Bindings',
        title: b.name,
        status: 'ok',
        detail: 'Bound.',
        fix: [],
      };
    return {
      id: `binding-${b.name}`,
      category: 'Bindings',
      title: b.name,
      status: b.required ? 'error' : 'warning',
      detail: `Not bound. ${b.without}`,
      fix: [
        {
          text: ctx.local
            ? 'Add it to the env.dev block of wrangler.jsonc (named environments do not inherit bindings), then restart yarn dev:'
            : 'Add it to wrangler.jsonc (copy it from wrangler.jsonc.example; keep the top level and env.dev in sync):',
          code: b.snippet,
        },
        ...(ctx.local ? [] : [{ text: 'Then redeploy:', code: 'yarn deploy' }]),
        { text: `Every binding is described in ${DOCS}.` },
      ],
    };
  });
}

// ── Live probes ──────────────────────────────────────────────────────────────

async function d1Checks(ctx: Ctx): Promise<SetupCheck[]> {
  const db = ctx.env.DB;
  if (!db) return [];
  try {
    await withTimeout(db.prepare('SELECT 1').first());
  } catch (e) {
    return [
      {
        id: 'probe-d1',
        category: 'Connectivity',
        title: 'D1 database',
        status: 'error',
        detail: `A test query failed (${reason(e)}).`,
        fix: [
          {
            text: 'Check that database_id in wrangler.jsonc names a database in this account:',
            code: 'yarn wrangler d1 list',
          },
        ],
      },
    ];
  }
  const migrate = ctx.local ? 'yarn db:migrate:local' : 'yarn db:migrate:prod';
  let applied: Set<string>;
  try {
    const { results } = await withTimeout(
      db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()
    );
    applied = new Set(results.map((r) => r.name));
  } catch {
    applied = new Set();
  }
  const pending = knownMigrations().filter((m) => !applied.has(m));
  if (pending.length)
    return [
      {
        id: 'probe-d1',
        category: 'Connectivity',
        title: 'D1 database',
        status: 'error',
        detail: `Reachable, but ${pending.length} migration${pending.length === 1 ? '' : 's'} not applied (${pending.slice(0, 3).join(', ')}${pending.length > 3 ? ', …' : ''}). Features that use the new tables fail.`,
        fix: [{ text: 'Apply them from the repository root:', code: migrate }],
      },
    ];
  return [
    {
      id: 'probe-d1',
      category: 'Connectivity',
      title: 'D1 database',
      status: 'ok',
      detail: 'Reachable; every migration is applied.',
      fix: [],
    },
  ];
}

async function r2BucketChecks(ctx: Ctx): Promise<SetupCheck[]> {
  const buckets = (['LFS', 'ACTIONS_LOGS', 'ACTIONS_CACHE'] as const).filter(
    (n) => ctx.env[n]
  );
  return Promise.all(
    buckets.map(async (name): Promise<SetupCheck> => {
      try {
        await withTimeout((ctx.env[name] as R2Bucket).head(PROBE_KEY));
        return {
          id: `probe-r2-${name}`,
          category: 'Connectivity',
          title: `R2 bucket ${name}`,
          status: 'ok',
          detail: 'Reachable.',
          fix: [],
        };
      } catch (e) {
        return {
          id: `probe-r2-${name}`,
          category: 'Connectivity',
          title: `R2 bucket ${name}`,
          status: name === 'LFS' ? 'error' : 'warning',
          detail: `Bound, but a read failed (${reason(e)}).`,
          fix: [
            {
              text: "Check that the binding's bucket_name exists in this account (create it if not):",
              code: 'yarn wrangler r2 bucket list',
              link: DASH.r2,
            },
          ],
        };
      }
    })
  );
}

/** What R2's S3 API said about one pre-signed read of a missing key. */
async function presignedProbe(
  ctx: Ctx,
  bucket: string
): Promise<{ ok: true } | { ok: false; code: string }> {
  const env = ctx.env as CloudflareBindings;
  const url = await presign(env, PROBE_KEY, 'GET', { bucket });
  const res = await withTimeout(fetch(url));
  const body = await res.text().catch(() => '');
  const code =
    /<Code>([A-Za-z]+)<\/Code>/.exec(body)?.[1] ?? `HTTP ${res.status}`;
  // A missing key (or, unlikely, a present one) proves account, bucket, and token all work.
  if (res.ok || code === 'NoSuchKey') return { ok: true };
  return { ok: false, code };
}

function r2CodeMeaning(code: string, bucketVar: string): string {
  switch (code) {
    case 'NoSuchBucket':
      return `${bucketVar} doesn't name a bucket in R2_ACCOUNT_ID's account.`;
    case 'InvalidAccessKeyId':
      return 'R2 does not recognise R2_ACCESS_KEY_ID (the token was deleted, or it belongs to another account).';
    case 'SignatureDoesNotMatch':
      return "R2_SECRET_ACCESS_KEY doesn't match R2_ACCESS_KEY_ID.";
    case 'AccessDenied':
      return `The R2 token can't read this bucket: give it Object Read & Write on ${bucketVar}.`;
    default:
      return `R2 answered ${code}.`;
  }
}

async function presignChecks(ctx: Ctx): Promise<SetupCheck[]> {
  const { env } = ctx;
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return [];
  const out: SetupCheck[] = [];
  const targets = [
    {
      id: 'probe-presign-lfs',
      title: 'Git LFS pre-signed URLs',
      bucketVar: 'LFS_BUCKET_NAME',
      bucket: env.LFS_BUCKET_NAME,
      bad: 'error' as const,
    },
    ...(env.ACTIONS_CACHE
      ? [
          {
            id: 'probe-presign-cache',
            title: 'Actions cache pre-signed URLs',
            bucketVar: 'ACTIONS_CACHE_BUCKET_NAME',
            bucket: env.ACTIONS_CACHE_BUCKET_NAME,
            bad: 'warning' as const,
          },
        ]
      : []),
  ];
  for (const t of targets) {
    if (!env.R2_ACCOUNT_ID || !t.bucket) continue; // Reported under Variables.
    let result: Awaited<ReturnType<typeof presignedProbe>>;
    try {
      result = await presignedProbe(ctx, t.bucket);
    } catch (e) {
      result = { ok: false, code: reason(e) };
    }
    out.push(
      result.ok
        ? {
            id: t.id,
            category: 'Connectivity',
            title: t.title,
            status: 'ok',
            detail:
              'The R2 token, R2_ACCOUNT_ID, and bucket name work together.',
            fix: [],
          }
        : {
            id: t.id,
            category: 'Connectivity',
            title: t.title,
            status: t.bad,
            detail: `A signed test read failed. ${r2CodeMeaning(result.code, t.bucketVar)}`,
            fix: [
              {
                text: `Check R2_ACCOUNT_ID and ${t.bucketVar} in wrangler.jsonc against the bucket's real name and account:`,
                code: 'yarn wrangler r2 bucket list',
              },
              {
                text: 'If the token is wrong, create a new one (Object Read & Write on the LFS and Actions cache buckets) and set both secrets again:',
                code: ctx.local
                  ? 'R2_ACCESS_KEY_ID=…\nR2_SECRET_ACCESS_KEY=…   # in .dev.vars'
                  : 'yarn wrangler secret put R2_ACCESS_KEY_ID\nyarn wrangler secret put R2_SECRET_ACCESS_KEY',
                link: DASH.r2Tokens,
              },
            ],
          }
    );
  }
  return out;
}

async function artifactsCheck(ctx: Ctx): Promise<SetupCheck[]> {
  const artifacts = ctx.env.ARTIFACTS;
  if (!artifacts) return [];
  try {
    await withTimeout(artifacts.list({ limit: 1 }));
    return [
      {
        id: 'probe-artifacts',
        category: 'Connectivity',
        title: 'Artifacts',
        status: 'ok',
        detail: 'Reachable; repositories can be listed.',
        fix: [],
      },
    ];
  } catch (e) {
    return [
      {
        id: 'probe-artifacts',
        category: 'Connectivity',
        title: 'Artifacts',
        status: 'error',
        detail: `Listing repositories failed (${reason(e)}). Git reads, pushes, and new repositories will fail.`,
        fix: [
          {
            text: 'Check that the account has Artifacts access and that the namespace in wrangler.jsonc exists:',
            code: 'yarn wrangler artifacts namespaces list',
          },
        ],
      },
    ];
  }
}

function emailCheck(ctx: Ctx): SetupCheck[] {
  const { env } = ctx;
  if (!env.EMAIL) return []; // Reported under Bindings.
  const from = (env.FROM_EMAIL ?? '').trim();
  const valid = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(from);
  if (!valid)
    return [
      {
        id: 'probe-email',
        category: 'Connectivity',
        title: 'Email sending',
        status: 'warning',
        detail: from
          ? `FROM_EMAIL ("${from.slice(0, 80)}") isn't an email address, so invitations can't be sent.`
          : 'FROM_EMAIL is not set, so invitations and verification emails are not sent.',
        fix: [
          {
            text: 'Set FROM_EMAIL in wrangler.jsonc vars to an address on a domain onboarded to Cloudflare Email Sending, then redeploy:',
            code: '"FROM_EMAIL": "noreply@example.com"',
            link: DASH.email,
          },
        ],
      },
    ];
  return [
    {
      id: 'probe-email',
      category: 'Connectivity',
      title: 'Email sending',
      status: 'ok',
      detail: `Sending from ${from}. Its domain must be onboarded to Email Sending; this check sends nothing, so invite someone to confirm delivery.`,
      fix: [],
    },
  ];
}

// ── Variables ────────────────────────────────────────────────────────────────

function varFix(ctx: Ctx, line: string): SetupStep[] {
  return [
    {
      text: ctx.local
        ? 'Set it in the env.dev vars of wrangler.jsonc, then restart yarn dev:'
        : 'Set it in the top-level vars of wrangler.jsonc, then redeploy (yarn deploy):',
      code: line,
    },
  ];
}

function variableChecks(ctx: Ctx): SetupCheck[] {
  const { env } = ctx;
  const out: SetupCheck[] = [];
  const base = (env.BASE_URL ?? '').trim();
  let baseOrigin: string | null = null;
  try {
    if (base && !isPlaceholder(base)) baseOrigin = new URL(base).origin;
  } catch {
    baseOrigin = null;
  }
  const baseFix = varFix(ctx, `"BASE_URL": "${ctx.origin}"`);
  out.push(
    !baseOrigin
      ? {
          id: 'var-base-url',
          category: 'Variables',
          title: 'BASE_URL',
          status: 'error',
          detail: base
            ? `"${base.slice(0, 100)}" isn't a URL. Sign-in, invite links, and MCP OAuth use it.`
            : 'Not set. Sign-in, invite links, and MCP OAuth use it.',
          fix: baseFix,
        }
      : baseOrigin !== ctx.origin
        ? {
            id: 'var-base-url',
            category: 'Variables',
            title: 'BASE_URL',
            status: 'error',
            detail: `Is ${baseOrigin}, but you're using ${ctx.origin}. Sign-in from this address is rejected as an untrusted origin, and invite links and MCP OAuth point elsewhere.`,
            fix: [
              ...baseFix,
              {
                text: 'If both addresses should work, open the instance at BASE_URL instead.',
              },
            ],
          }
        : {
            id: 'var-base-url',
            category: 'Variables',
            title: 'BASE_URL',
            status: 'ok',
            detail: `${baseOrigin}, matching this page.`,
            fix: [],
          }
  );

  const name = (env.APP_NAME ?? '').trim();
  out.push({
    id: 'var-app-name',
    category: 'Variables',
    title: 'APP_NAME',
    status: name ? 'ok' : 'warning',
    detail: name
      ? `"${name}".`
      : 'Not set; the instance is called "GitOrange" in titles, emails, and the MCP server id.',
    fix: name ? [] : varFix(ctx, '"APP_NAME": "GitOrange"'),
  });

  // Where pre-signed URLs point; only matters once the R2 token is set.
  const acct = (env.R2_ACCOUNT_ID ?? '').trim();
  out.push(
    !acct || isPlaceholder(acct)
      ? {
          id: 'var-r2-account',
          category: 'Variables',
          title: 'R2_ACCOUNT_ID',
          status: 'error',
          detail:
            'Not set. Git LFS and the Actions cache cannot build R2 URLs.',
          fix: [
            {
              text: 'Your account id is the hex string in the dashboard URL, or:',
              code: 'yarn wrangler whoami',
            },
            ...varFix(ctx, '"R2_ACCOUNT_ID": "<32 hex characters>"'),
          ],
        }
      : !/^[0-9a-f]{32}$/.test(acct)
        ? {
            id: 'var-r2-account',
            category: 'Variables',
            title: 'R2_ACCOUNT_ID',
            status: 'warning',
            detail:
              "Doesn't look like a Cloudflare account id (32 hex characters).",
            fix: [
              { text: 'Find your account id:', code: 'yarn wrangler whoami' },
              ...varFix(ctx, '"R2_ACCOUNT_ID": "<32 hex characters>"'),
            ],
          }
        : {
            id: 'var-r2-account',
            category: 'Variables',
            title: 'R2_ACCOUNT_ID',
            status: 'ok',
            detail: 'Set.',
            fix: [],
          }
  );
  for (const [v, binding, status, without] of [
    [
      'LFS_BUCKET_NAME',
      'LFS',
      'error',
      'Git LFS cannot build upload and download URLs.',
    ],
    [
      'ACTIONS_CACHE_BUCKET_NAME',
      'ACTIONS_CACHE',
      'warning',
      'Actions jobs run without a cache.',
    ],
  ] as const) {
    const value = (env[v] ?? '').trim();
    out.push({
      id: `var-${v.toLowerCase().replace(/_/g, '-')}`,
      category: 'Variables',
      title: v,
      status: value ? 'ok' : status,
      detail: value
        ? `"${value}". It must equal the ${binding} binding's bucket_name.`
        : `Not set. ${without}`,
      fix: value
        ? []
        : varFix(ctx, `"${v}": "<the ${binding} binding's bucket_name>"`),
    });
  }

  for (const [v, use, example] of [
    ['RESOLVER_MODEL', 'AI conflict resolution', '@cf/zai-org/glm-5.3'],
    ['SUMMARY_MODEL', 'auto-merge file summaries', '@cf/zai-org/glm-5.3-flash'],
    ['REVIEW_MODEL', 'auto-merge flag investigations', '@cf/zai-org/glm-5.3'],
  ] as const) {
    const value = (env[v] ?? '').trim();
    const ok = /^@cf\/[^/\s]+\/[^/\s]+$/.test(value);
    out.push({
      id: `var-${v.toLowerCase().replace(/_/g, '-')}`,
      category: 'Variables',
      title: v,
      status: ok ? 'ok' : 'warning',
      detail: ok
        ? `${value}.`
        : value
          ? `"${value.slice(0, 80)}" isn't a Workers AI model id (@cf/<author>/<model>); ${use} fails.`
          : `Not set; ${use} fails.`,
      fix: ok ? [] : varFix(ctx, `"${v}": "${example}"`),
    });
  }
  return out;
}

// ── AI Gateway ───────────────────────────────────────────────────────────────

async function gatewayChecks(ctx: Ctx): Promise<SetupCheck[]> {
  const { env } = ctx;
  const raw = (env.AI_GATEWAY ?? '').trim();
  const setFix = varFix(ctx, '"AI_GATEWAY": "default"');
  if (raw === 'off')
    return [
      {
        id: 'ai-gateway',
        category: 'AI Gateway',
        title: 'AI_GATEWAY',
        status: 'warning',
        detail:
          'Off: Workers AI is called directly, so requests, tokens, and cost are not logged anywhere you can see them.',
        fix: [
          ...setFix,
          {
            text: '"default" is created on first use. To use another name, create that gateway first:',
            link: DASH.gateway,
          },
        ],
      },
    ];
  const id = raw || 'default';
  const unset: SetupCheck[] = raw
    ? []
    : [
        {
          id: 'ai-gateway-var',
          category: 'AI Gateway',
          title: 'AI_GATEWAY',
          status: 'warning',
          detail:
            'Not set, so calls go through the "default" gateway. Set it explicitly so the choice is visible in wrangler.jsonc.',
          fix: setFix,
        },
      ];
  if (!env.AI)
    return [
      ...unset,
      {
        id: 'ai-gateway',
        category: 'AI Gateway',
        title: `Gateway "${id}"`,
        status: 'warning',
        detail: 'Not checked: the AI binding is missing (see Bindings).',
        fix: [],
      },
    ];
  try {
    // Free and local to the binding: confirms the gateway API answers for this account.
    await withTimeout(env.AI.gateway(id).getUrl());
  } catch (e) {
    return [
      ...unset,
      {
        id: 'ai-gateway',
        category: 'AI Gateway',
        title: `Gateway "${id}"`,
        status: 'warning',
        detail: `The AI binding could not reach AI Gateway (${reason(e)}).`,
        fix: [
          {
            text: `Create the gateway "${id}" in the dashboard (or set AI_GATEWAY to "default", which is created on first use), then redeploy.`,
            link: DASH.gateway,
          },
        ],
      },
    ];
  }
  return [
    ...unset,
    {
      id: 'ai-gateway',
      category: 'AI Gateway',
      title: `Gateway "${id}"`,
      status: 'ok',
      detail:
        id === 'default'
          ? 'AI calls are logged in the "default" gateway (created on first use). Checking for free can\'t prove the gateway accepts requests: use Test to send one tiny request.'
          : `AI calls are logged in "${id}". Checking for free can't prove that gateway exists: use Test to send one tiny request.`,
      fix: [
        {
          text: 'Logs, token counts, and cost are in the dashboard:',
          link: DASH.gateway,
        },
      ],
    },
  ];
}

// ── Usage & cost ─────────────────────────────────────────────────────────────

/** Resource vars that scope Cloudflare analytics to this deployment, and what each one measures. */
const USAGE_VARS: [string, string, string][] = [
  ['WORKER_NAME', 'Worker requests and CPU', 'gitorange'],
  [
    'D1_DATABASE_ID',
    'D1 rows read and written, storage',
    '<the database_id of DB>',
  ],
  [
    'ACTIONS_LOGS_BUCKET_NAME',
    'R2 usage of the Actions logs bucket',
    'gitorange-actions-logs',
  ],
  ['ARTIFACTS_NAMESPACE', 'Artifacts operations', 'gitorange'],
  [
    'ACTIONS_WORKFLOW_NAME',
    'Workflows usage of Actions runs',
    'gitorange-actions-run',
  ],
  [
    'MERGE_RESOLUTION_WORKFLOW_NAME',
    'Workflows usage of AI resolution and review',
    'gitorange-merge-resolution',
  ],
];

const DO_NAMESPACES: [string, string][] = [
  ['JOB_RUNNER_NAMESPACE_ID', 'JobRunner'],
  ['MERGE_RESOLVER_NAMESPACE_ID', 'MergeResolver'],
  ['AGENT_REVIEWER_NAMESPACE_ID', 'AgentReviewer'],
  ['LIVE_NAMESPACE_ID', 'LiveHub'],
];

async function usageChecks(ctx: Ctx): Promise<SetupCheck[]> {
  const { env } = ctx;
  const value = (k: string) => String(env[k] ?? '').trim();
  const out: SetupCheck[] = [];
  const token = value('CF_ANALYTICS_TOKEN');
  out.push(
    token
      ? {
          id: 'usage-token',
          category: 'Usage & cost',
          title: 'CF_ANALYTICS_TOKEN',
          status: 'ok',
          detail: 'Set. Usage & cost pulls Cloudflare analytics daily.',
          fix: [],
        }
      : {
          id: 'usage-token',
          category: 'Usage & cost',
          title: 'CF_ANALYTICS_TOKEN',
          status: 'warning',
          detail:
            "Not set. Usage & cost shows only GitOrange's own records (Actions runners, AI tokens, emails), not Cloudflare's analytics.",
          fix: [
            {
              text: 'Create an account API token with only Account Analytics: Read, scoped to this account.',
              link: 'https://dash.cloudflare.com/?to=/:account/api-tokens',
            },
            ...secretFix(ctx, 'CF_ANALYTICS_TOKEN'),
          ],
        }
  );

  const missingVars = USAGE_VARS.filter(([k]) => {
    const v = value(k);
    return !v || isPlaceholder(v);
  });
  out.push(
    missingVars.length
      ? {
          id: 'usage-vars',
          category: 'Usage & cost',
          title: 'Usage resource variables',
          status: 'warning',
          detail: `Not set, so these aren't measured: ${missingVars
            .map(([k, what]) => `${k} (${what})`)
            .join('; ')}.`,
          fix: varFix(
            ctx,
            missingVars.map(([k, , ex]) => `"${k}": "${ex}"`).join(',\n')
          ),
        }
      : {
          id: 'usage-vars',
          category: 'Usage & cost',
          title: 'Usage resource variables',
          status: 'ok',
          detail:
            'Worker, D1, buckets, Artifacts namespace, and Workflows are all named.',
          fix: [],
        }
  );

  const badIds = DO_NAMESPACES.filter(
    ([k]) => !/^[0-9a-f]{32}$/.test(value(k))
  );
  out.push(
    badIds.length
      ? {
          id: 'usage-do-namespaces',
          category: 'Usage & cost',
          title: 'Durable Object namespace IDs',
          status: 'warning',
          detail: `${badIds
            .map(([k]) =>
              value(k) ? `${k} isn't a 32-character hex ID` : `${k} is not set`
            )
            .join('; ')}, so Durable Object usage for ${badIds
            .map(([, c]) => c)
            .join(', ')} isn't measured.`,
          fix: [
            {
              text: `Open Durable Objects in the dashboard and select ${badIds
                .map(
                  ([, c]) => `${ctx.local ? 'gitorange-dev' : 'gitorange'}_${c}`
                )
                .join(
                  ', '
                )}. The namespace ID is the 32-character hex string in the page URL (…/durable-objects/view/<ID>/overview).`,
              link: 'https://dash.cloudflare.com/?to=/:account/workers/durable-objects',
            },
            {
              text: 'For JobRunner, the container application lists it too (durable_objects.namespace_id):',
              code: 'yarn wrangler containers list\nyarn wrangler containers info <application id> --json',
            },
            ...varFix(
              ctx,
              badIds.map(([k]) => `"${k}": "<namespace id>"`).join(',\n')
            ),
          ],
        }
      : {
          id: 'usage-do-namespaces',
          category: 'Usage & cost',
          title: 'Durable Object namespace IDs',
          status: 'ok',
          detail:
            'JobRunner, MergeResolver, AgentReviewer, and LiveHub are all set.',
          fix: [],
        }
  );

  if (token && env.DB) {
    try {
      const last = await withTimeout(
        latestSync(drizzle(env.DB as D1Database, { schema }))
      );
      const failed = last ? Object.entries(last.errors ?? {}) : [];
      out.push(
        !last
          ? {
              id: 'usage-sync',
              category: 'Usage & cost',
              title: 'Last usage sync',
              status: 'warning',
              detail: 'Never synced yet. The daily sync runs at 02:30 UTC.',
              fix: [
                {
                  text: 'Or open Site admin → Usage & cost and click Sync now.',
                },
              ],
            }
          : failed.length
            ? {
                id: 'usage-sync',
                category: 'Usage & cost',
                title: 'Last usage sync',
                status: 'warning',
                detail: `${last.id}: ${failed.length} metric${failed.length === 1 ? '' : 's'} unavailable. ${failed
                  .slice(0, 5)
                  .map(([k, e]) => `${k}: ${String(e).slice(0, 160)}`)
                  .join(' · ')}`,
                fix: [
                  {
                    text: 'Most are fixed by the variables above. A "not configured" metric is skipped on purpose; an API error usually means the token lacks Account Analytics: Read or a field name changed.',
                  },
                ],
              }
            : {
                id: 'usage-sync',
                category: 'Usage & cost',
                title: 'Last usage sync',
                status: 'ok',
                detail: `${last.id}: every metric synced.`,
                fix: [],
              }
      );
    } catch {
      // D1 problems are reported by the D1 check.
    }
  }
  return out;
}

const ORDER: Record<SetupStatus, number> = { error: 0, warning: 1, ok: 2 };

/** Every check, errors first. */
export async function runSetupChecks(
  env: CloudflareBindings,
  origin: string
): Promise<SetupCheck[]> {
  const host = new URL(origin).hostname;
  const ctx: Ctx = {
    env: env as Ctx['env'],
    origin,
    local: ['localhost', '127.0.0.1', '[::1]'].includes(host),
  };
  const probes = await Promise.all([
    d1Checks(ctx),
    artifactsCheck(ctx),
    r2BucketChecks(ctx),
    presignChecks(ctx),
    gatewayChecks(ctx),
    usageChecks(ctx),
  ]);
  const checks = [
    ...secretChecks(ctx),
    ...bindingChecks(ctx),
    ...probes[0],
    ...probes[1],
    ...probes[2],
    ...probes[3],
    ...emailCheck(ctx),
    ...variableChecks(ctx),
    ...probes[4],
    ...probes[5],
  ];
  // Stable sort: within a status, keep the category order above.
  return checks.sort((a, b) => ORDER[a.status] - ORDER[b.status]);
}

/** One tiny, capped Workers AI request through the configured gateway (Setup's Test button). */
export async function testAiGateway(env: CloudflareBindings): Promise<{
  ok: boolean;
  gateway: string | null;
  logged: boolean;
  detail: string;
}> {
  const e = env as Partial<CloudflareBindings>;
  const gw = aiGateway(env, 'review-summary', { purpose: 'setup-test' });
  if (!e.AI)
    return {
      ok: false,
      gateway: gw?.id ?? null,
      logged: false,
      detail: 'The AI binding is missing.',
    };
  const model = env.SUMMARY_MODEL?.trim() || '@cf/zai-org/glm-5.3-flash';
  try {
    await withTimeout(
      e.AI.run(
        model as Parameters<Ai['run']>[0],
        {
          messages: [{ role: 'user', content: 'Reply with the word OK.' }],
          max_tokens: 4,
        } as never,
        gw ? { gateway: gw } : {}
      ),
      20_000
    );
  } catch (err) {
    return {
      ok: false,
      gateway: gw?.id ?? null,
      logged: false,
      detail: `The request failed: ${reason(err)}`,
    };
  }
  const logged = Boolean(gw && e.AI.aiGatewayLogId);
  return {
    ok: true,
    gateway: gw?.id ?? null,
    logged,
    detail: gw
      ? logged
        ? `Workers AI answered through "${gw.id}", and the request was logged.`
        : `Workers AI answered, but no gateway log id came back; check that "${gw.id}" exists and has logging on.`
      : 'Workers AI answered. AI_GATEWAY is off, so nothing was logged.',
  };
}
