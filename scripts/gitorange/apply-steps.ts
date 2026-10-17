// Step helpers for apply.ts: local files, wrangler/yarn invocations, the R2 key check and verify.
// Nothing here puts a secret into argv, a log line, the state file or an error message.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cloudflare } from './cloudflare.ts';
import type { Io } from './collect.ts';
import {
  ConfigConflict,
  generateWranglerConfig,
  isGenerated,
} from './config.ts';
import type { Runner } from './runner.ts';
import { checkR2Keys, withSecretsFile } from './secrets.ts';
import type { InstallState } from './state.ts';

export type Ctx = {
  cf: Cloudflare;
  runner: Runner;
  io: Io;
  /** Where state and lock files live (`.gitorange/`). */
  dir: string;
  /** The checkout: wrangler.jsonc, wrangler.jsonc.example and migrations/ live here. */
  cwd: string;
  fetchImpl: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): Date;
};

export type Optional = {
  r2?: { id: string; secret: string };
  analytics?: string;
};

/** Optional credentials, as recorded in `state.skipped` when not supplied. */
export const OPTIONAL_ITEMS = [
  {
    id: 'r2-keys',
    label: 'R2 upload keys (Git LFS, Actions cache)',
    has: (o: Optional) => Boolean(o.r2),
  },
  {
    id: 'analytics-token',
    label: 'Usage & cost analytics token',
    has: (o: Optional) => Boolean(o.analytics),
  },
] as const;

/** `prev` minus what `o` supplies; `null` means every optional item was offered. */
export function skippedAfter(prev: string[] | null, o: Optional): string[] {
  return OPTIONAL_ITEMS.filter(
    (i) => !i.has(o) && (prev === null || prev.includes(i.id))
  ).map((i) => i.id);
}

export function optionalSecrets(o: Optional): Record<string, string> {
  const out: Record<string, string> = {};
  if (o.r2) {
    out.R2_ACCESS_KEY_ID = o.r2.id;
    out.R2_SECRET_ACCESS_KEY = o.r2.secret;
  }
  if (o.analytics) out.CF_ANALYTICS_TOKEN = o.analytics;
  return out;
}

const tail = (text: string) => text.trim().split('\n').slice(-10).join('\n');

async function mustRun(ctx: Ctx, what: string, cmd: string, args: string[]) {
  const r = await ctx.runner.run(cmd, args, { cwd: ctx.cwd });
  if (r.code !== 0) {
    const out = tail(r.stderr || r.stdout);
    throw new Error(
      `${what} failed (exit ${r.code})${out ? `:\n${out}` : '.'}`
    );
  }
  return r;
}

/** `git rev-parse --short=12 HEAD`, plus `-dirty` with uncommitted changes: what verify expects. */
export async function buildVersion(ctx: Ctx): Promise<string> {
  const head = await mustRun(ctx, 'git rev-parse', 'git', [
    'rev-parse',
    '--short=12',
    'HEAD',
  ]);
  const status = await mustRun(ctx, 'git status', 'git', [
    'status',
    '--porcelain',
  ]);
  const sha = head.stdout.trim();
  return status.stdout.trim() ? `${sha}-dirty` : sha;
}

const configPath = (ctx: Ctx) => join(ctx.cwd, 'wrangler.jsonc');

function existingConfig(ctx: Ctx): string | null {
  const p = configPath(ctx);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** Throws ConfigConflict when wrangler.jsonc exists and is hand-written. Touches nothing. */
export function assertConfigWritable(ctx: Ctx): void {
  const text = existingConfig(ctx);
  if (text !== null && !isGenerated(text)) throw new ConfigConflict();
}

/** The wrangler.jsonc text for `s` at `version`, and its sha256. Writes nothing. */
export function renderConfig(
  ctx: Ctx,
  s: InstallState,
  version: string,
  doNamespaceIds = s.doNamespaceIds
): { text: string; hash: string } {
  const template = readFileSync(
    join(ctx.cwd, 'wrangler.jsonc.example'),
    'utf8'
  );
  const text = generateWranglerConfig(template, s, {
    doNamespaceIds,
    version,
    existing: existingConfig(ctx),
  });
  return { text, hash: createHash('sha256').update(text).digest('hex') };
}

/** Generates and writes wrangler.jsonc; returns the sha256 of the text. */
export function writeConfig(
  ctx: Ctx,
  s: InstallState,
  version: string,
  doNamespaceIds = s.doNamespaceIds
): string {
  const { text, hash } = renderConfig(ctx, s, version, doNamespaceIds);
  if (text !== existingConfig(ctx)) writeFileSync(configPath(ctx), text);
  return hash;
}

/** sha256 over the sorted migrations/*.sql names and contents. */
export function migrationsDigest(cwd: string): string {
  const d = join(cwd, 'migrations');
  const hash = createHash('sha256');
  for (const f of readdirSync(d)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    hash
      .update(`${f}\0`)
      .update(readFileSync(join(d, f)))
      .update('\0');
  }
  return hash.digest('hex');
}

export async function applyMigrations(ctx: Ctx): Promise<void> {
  await mustRun(ctx, 'wrangler d1 migrations apply', 'yarn', [
    '-s',
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'DB',
    '--remote',
  ]);
}

export async function writeInstallRow(
  ctx: Ctx,
  s: InstallState,
  d1Id: string,
  version: string,
  schemaDigest: string
): Promise<void> {
  await ctx.cf.queryD1(
    s.accountId,
    d1Id,
    'INSERT OR REPLACE INTO install_state (installation_id, ownership_nonce, version, manifest_json, updated_at) VALUES (?, ?, ?, ?, ?)',
    [
      s.installationId,
      s.ownershipNonce,
      version,
      JSON.stringify({ schemaDigest }),
      ctx.now().getTime(),
    ]
  );
}

/**
 * Secret names the worker already has. A worker that does not exist yet (`workerIsNew`) makes
 * wrangler exit non-zero: that means none.
 */
export async function existingSecretNames(
  ctx: Ctx,
  worker: string,
  workerIsNew: boolean
): Promise<string[]> {
  const r = await ctx.runner.run(
    'yarn',
    ['-s', 'wrangler', 'secret', 'list', '--name', worker, '--format', 'json'],
    { cwd: ctx.cwd }
  );
  if (r.code !== 0) {
    if (workerIsNew) return [];
    throw new Error(
      `wrangler secret list failed (exit ${r.code}):\n${tail(r.stderr || r.stdout)}`
    );
  }
  try {
    const rows = JSON.parse(r.stdout) as { name: string }[];
    return rows.map((x) => x.name);
  } catch {
    throw new Error('wrangler secret list did not print JSON.');
  }
}

/** `yarn -s deploy`, with a 0600 secrets file only when there are secrets to send. */
export async function deploy(
  ctx: Ctx,
  secrets: Record<string, string>
): Promise<void> {
  if (Object.keys(secrets).length === 0) {
    await mustRun(ctx, 'yarn deploy', 'yarn', ['-s', 'deploy']);
    return;
  }
  await withSecretsFile(secrets, (path) =>
    mustRun(ctx, 'yarn deploy', 'yarn', [
      '-s',
      'deploy',
      '--secrets-file',
      path,
    ])
  );
}

/** Durable Object class -> var name (from scripts/do-namespaces.mjs). */
const DO_VARS: Record<string, string> = {
  JobRunner: 'JOB_RUNNER_NAMESPACE_ID',
  MergeResolver: 'MERGE_RESOLVER_NAMESPACE_ID',
  AgentReviewer: 'AGENT_REVIEWER_NAMESPACE_ID',
  LiveHub: 'LIVE_NAMESPACE_ID',
};

export async function readDoNamespaceIds(
  ctx: Ctx,
  s: InstallState
): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const ns of await ctx.cf.durableObjectNamespaces(s.accountId)) {
    const v = DO_VARS[ns.class];
    if (ns.script === s.names.worker && v) found[v] = ns.id;
  }
  const missing = Object.values(DO_VARS).filter((v) => !found[v]);
  if (missing.length > 0) {
    throw new Error(
      `Durable Object namespaces not found for worker ${s.names.worker}: ${missing.join(', ')}.`
    );
  }
  return found;
}

export function sameIds(
  a: Record<string, string>,
  b: Record<string, string>
): boolean {
  const ka = Object.keys(a).sort();
  return (
    JSON.stringify(ka) === JSON.stringify(Object.keys(b).sort()) &&
    ka.every((k) => a[k] === b[k])
  );
}

/**
 * Checks R2 keys against the LFS bucket. Rejected: in a terminal, asks once more (masked);
 * otherwise throws the check's message.
 */
export async function confirmR2Keys(
  ctx: Ctx,
  s: InstallState,
  keys: { id: string; secret: string }
): Promise<{ id: string; secret: string }> {
  const check = (k: { id: string; secret: string }) =>
    checkR2Keys(s.accountId, s.names.lfs, k, ctx.fetchImpl);
  const problem = await check(keys);
  if (!problem) return keys;
  if (!ctx.io.tty) throw new Error(problem);
  ctx.io.print(problem);
  const id = await ctx.io.prompt('R2 access key ID', {});
  const secret =
    id === null
      ? null
      : await ctx.io.prompt('R2 secret access key', { mask: true });
  if (id === null || secret === null) throw new Error(problem);
  const again = { id, secret };
  const second = await check(again);
  if (second) throw new Error(second);
  return again;
}

// 13 tries 5 s apart: 60 s of waiting while a custom domain's certificate is issued.
const VERIFY_TRIES = 13;
const VERIFY_INTERVAL_MS = 5000;

const summarize = (text: string) =>
  text.length > 200 ? `${text.slice(0, 200)}…` : text;

export type SetupStatus = { setupRequired?: boolean; codeRequired?: boolean };

export async function setupStatus(
  ctx: Ctx,
  s: InstallState
): Promise<SetupStatus> {
  const url = `${s.baseUrl}/api/setup/status`;
  const res = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}.`);
  return (await res.json()) as SetupStatus;
}

/**
 * `/.well-known/gitorange` must report this installation at `version` (retried every 5 s for
 * 60 s), then setup must not be open without a code. Returns the setup status.
 */
export async function verifyAt(
  ctx: Ctx,
  s: InstallState,
  version: string
): Promise<SetupStatus> {
  const url = `${s.baseUrl}/.well-known/gitorange`;
  let last = '';
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await ctx.fetchImpl(url, {
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.text();
      if (res.status === 200) {
        const got = JSON.parse(body) as {
          installationId?: unknown;
          version?: unknown;
        };
        if (got.installationId === s.installationId && got.version === version)
          break;
      }
      last = `HTTP ${res.status}: ${summarize(body)}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (attempt >= VERIFY_TRIES) {
      throw new Error(
        `${url} did not report installation ${s.installationId} at version ${version} within 60 s. Last response: ${last}`
      );
    }
    await ctx.sleep(VERIFY_INTERVAL_MS);
  }

  const st = await setupStatus(ctx, s);
  if (st.setupRequired && !st.codeRequired) {
    throw new Error(
      `${s.baseUrl}/api/setup/status reports setup open without a setup code: anyone could claim this instance. Run yarn gitorange install --resume --name ${s.inputs.name}.`
    );
  }
  return st;
}

/** verifyAt the version last deployed (HEAD's when none is recorded). */
export async function verify(ctx: Ctx, s: InstallState): Promise<void> {
  await verifyAt(ctx, s, s.deployedVersion ?? (await buildVersion(ctx)));
}

export function summary(
  s: InstallState,
  code: string | null,
  optional: Optional
): string {
  const lines = [`GitOrange is installed at ${s.baseUrl}`, ''];
  if (code) {
    lines.push(
      `Setup code: ${code}`,
      `Open ${s.baseUrl}/setup and enter it to create the first admin. It is shown only once.`,
      ''
    );
  }
  const n = s.names;
  lines.push(
    'Set:',
    `  D1 database   ${n.d1}`,
    `  R2 buckets    ${n.lfs}, ${n.actionsLogs}, ${n.actionsCache}`,
    `  Email sender  ${s.inputs.fromEmail ?? '(none: email is off)'}`
  );
  for (const i of OPTIONAL_ITEMS)
    if (i.has(optional)) lines.push(`  ${i.label}`);
  const skipped = OPTIONAL_ITEMS.filter((i) => s.skipped.includes(i.id));
  if (skipped.length > 0) {
    lines.push('', 'Skipped:');
    for (const i of skipped) lines.push(`  ${i.label}`);
    lines.push(
      `Add them later with: yarn gitorange install --resume --name ${s.inputs.name}`
    );
  }
  return lines.join('\n');
}
