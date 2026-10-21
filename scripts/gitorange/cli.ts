// `gitorange <command>`: the user-facing installer (spec §2–§6). Every outside effect comes in
// through `Deps`, so tests drive `main` with fakes; the real wiring is at the bottom.
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { install, resumeInstalled, type Ctx, type Optional } from './apply.ts';
import { assertConfigWritable, OPTIONAL_ITEMS } from './apply-steps.ts';
import { restCloudflare, type Cloudflare } from './cloudflare.ts';
import { clackIo, collect, type Io } from './collect.ts';
import { ConfigConflict } from './config.ts';
import {
  gitorangeHome,
  installDir,
  pickInstall,
  pickResumable,
} from './home.ts';
import { installationIdOf, resourceNames, validateName } from './names.ts';
import { observe } from './observe.ts';
import { computePlan, formatPlan } from './plan.ts';
import { preflight } from './preflight.ts';
import { processRunner, type Runner } from './runner.ts';
import { checkoutSource, packageSource, type Source } from './source.ts';
import {
  analyticsTokenLink,
  checkAnalyticsToken,
  r2TokenLink,
} from './secrets.ts';
import {
  hasStep,
  listStates,
  newState,
  readState,
  type InstallState,
} from './state.ts';
import { findState, status, UsageError } from './status.ts';
import { upgrade } from './upgrade.ts';

export const usage = (
  source: Source
) => `Usage: ${source.command('<command> [options]')}

Commands:
  install    Create or update a GitOrange installation on Cloudflare
  status     Show a recorded installation and check that it answers
  upgrade    Move an installation to this package's version (npx only)

install options:
  --name <name>          Installation name (default: gitorange)
  --account <id|name>    Cloudflare account (not needed when the login sees one)
  --hostname <host>      Serve on a custom hostname in one of the account's zones
  --workers-dev          Serve on <name>.<subdomain>.workers.dev instead
  --from-email <address> Invitation sender (a domain set up for Email Sending)
  --no-email             No invitation email (invite links still work)
  --plan                 Only show what would change, then print the apply command
  --expect-plan <digest> Apply only if the plan still has this digest
  --resume               Continue a recorded installation (or add skipped credentials)
  --new-setup-code       With --resume on an installed instance nobody has claimed yet:
                         replace the setup code (the old one stops working)
  --yes                  Apply without asking (required when not in a terminal)

  Environment: CLOUDFLARE_API_TOKEN (else wrangler's login), GITORANGE_R2_ACCESS_KEY_ID,
  GITORANGE_R2_SECRET_ACCESS_KEY, GITORANGE_CF_ANALYTICS_TOKEN.

status options:
  --name <name>          Which installation (default: the only one recorded)

upgrade options:
  --name <name>          Which installation (default: the only one recorded)
  --plan                 Only show what would change, then print the apply command
  --expect-plan <digest> Apply only if the plan still has this digest
  --resume               Continue a failed upgrade
  --replace-custom-code  Replace a running version that is not a release with this one
  --yes                  Apply without asking (required when not in a terminal); credentials
                         the worker lacks are then left out and listed (add them later)
`;

const DEFAULT_NAME = 'gitorange';

export type Deps = Omit<Ctx, 'cf'> & {
  env: Record<string, string | undefined>;
  /** Package mode: the directory holding every install (<home>/<slug>/); null = checkout mode (dir and configDir as given). */
  home: string | null;
  /** The Cloudflare API token; throws with what to do when there is none. */
  token(): Promise<string>;
  cloudflare(token: string): Cloudflare;
};

type InstallFlags = {
  name?: string;
  account?: string;
  hostname?: string;
  'workers-dev'?: boolean;
  'from-email'?: string;
  'no-email'?: boolean;
  plan?: boolean;
  'expect-plan'?: string;
  resume?: boolean;
  'new-setup-code'?: boolean;
  yes?: boolean;
};

const INSTALL_OPTIONS = {
  name: { type: 'string' },
  account: { type: 'string' },
  hostname: { type: 'string' },
  'workers-dev': { type: 'boolean' },
  'from-email': { type: 'string' },
  'no-email': { type: 'boolean' },
  plan: { type: 'boolean' },
  'expect-plan': { type: 'string' },
  resume: { type: 'boolean' },
  'new-setup-code': { type: 'boolean' },
  yes: { type: 'boolean' },
} as const;

type UpgradeFlags = {
  name?: string;
  plan?: boolean;
  'expect-plan'?: string;
  resume?: boolean;
  yes?: boolean;
  'replace-custom-code'?: boolean;
};

const UPGRADE_OPTIONS = {
  name: { type: 'string' },
  plan: { type: 'boolean' },
  'expect-plan': { type: 'string' },
  resume: { type: 'boolean' },
  yes: { type: 'boolean' },
  'replace-custom-code': { type: 'boolean' },
} as const;

const NOT_A_TERMINAL =
  'Not running in a terminal: pass --yes to apply (or --plan to only review).';

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const hostProblem = (v: string) =>
  HOST_RE.test(v)
    ? undefined
    : `${v} is not a hostname (like git.example.com).`;
const emailProblem = (v: string) =>
  EMAIL_RE.test(v) ? undefined : `${v} is not an email address.`;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const TOKEN_LINE = /^[A-Za-z0-9._-]{20,}$/;

/**
 * The token: CLOUDFLARE_API_TOKEN, else the last token-shaped line of `wrangler auth token`
 * (banners and colour codes around it are ignored). Run without `--config`: a package install's
 * config may not exist yet.
 */
export async function resolveToken(
  env: Record<string, string | undefined>,
  runner: Runner,
  source: Source
): Promise<string> {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN;
  let token: string | undefined;
  try {
    const c = source.wranglerBare(['auth', 'token']);
    const r = await runner.run(c.cmd, c.args);
    if (r.code === 0)
      token = r.stdout
        .replace(ANSI, '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => TOKEN_LINE.test(l))
        .pop();
  } catch {
    // no wrangler: same message
  }
  if (!token) throw new Error(`Run ${source.wranglerCommand('login')} first.`);
  return token;
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const [command, ...rest] = argv;
  const { io } = deps;
  if (command === undefined || command === '--help' || command === '-h') {
    io.print(usage(deps.source));
    return command === undefined ? 2 : 0;
  }
  try {
    if (command === 'install') {
      const { values } = parseArgs({
        args: rest,
        options: INSTALL_OPTIONS,
        strict: true,
        allowPositionals: false,
      });
      return await runInstall(values, deps);
    }
    if (command === 'status') {
      const { values } = parseArgs({
        args: rest,
        options: { name: { type: 'string' } },
        strict: true,
        allowPositionals: false,
      });
      // Package mode: the install's own directory under home.
      const picked = deps.home ? pickInstall(deps.home, values.name) : null;
      const dir = picked ? installDir(deps.home!, picked.slug) : deps.dir;
      return await status(values, { ...deps, dir });
    }
    if (command === 'upgrade') {
      const { values } = parseArgs({
        args: rest,
        options: UPGRADE_OPTIONS,
        strict: true,
        allowPositionals: false,
      });
      return await runUpgrade(values, deps);
    }
  } catch (e) {
    if (e instanceof UsageError || isParseArgsError(e)) {
      io.print(`${(e as Error).message}\n\n${usage(deps.source)}`);
      return 2;
    }
    throw e;
  }
  io.print(`Unknown command: ${command}\n\n${usage(deps.source)}`);
  return 2;
}

function isParseArgsError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS');
}

type Resolved = {
  name: string;
  accountId: string;
  hostname: string | null;
  fromEmail: string | null;
};

/** Checks that need no network: conflicting or malformed flags are usage errors. */
function checkFlags(f: InstallFlags): void {
  if (f.hostname !== undefined && f['workers-dev']) {
    throw new UsageError('Pass either --hostname or --workers-dev, not both.');
  }
  if (f['from-email'] !== undefined && f['no-email']) {
    throw new UsageError('Pass either --from-email or --no-email, not both.');
  }
  const bad =
    (f.name !== undefined ? (validateName(f.name) ?? undefined) : undefined) ??
    (f.hostname !== undefined ? hostProblem(f.hostname) : undefined) ??
    (f['from-email'] !== undefined ? emailProblem(f['from-email']) : undefined);
  if (bad) throw new UsageError(bad);
}

async function resolveAccount(
  cf: Cloudflare,
  io: Io,
  flag: string | undefined
): Promise<string> {
  const accounts = await cf.listAccounts();
  if (accounts.length === 0) {
    throw new Error('This Cloudflare login sees no accounts.');
  }
  if (flag !== undefined) {
    const hit =
      accounts.find((a) => a.id === flag) ??
      accounts.find((a) => a.name.toLowerCase() === flag.toLowerCase());
    if (!hit) {
      throw new Error(
        `No account matches --account ${flag}. This login sees: ${accounts.map((a) => `${a.name} (${a.id})`).join(', ')}.`
      );
    }
    return hit.id;
  }
  if (accounts.length === 1) return accounts[0]!.id;
  if (!io.tty) {
    throw new UsageError(
      '--account is required when not running in a terminal (this login sees more than one account).'
    );
  }
  return io.select(
    'Cloudflare account',
    accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.id})` }))
  );
}

/** collect(), with a missing or invalid input as a usage error (exit 2). */
async function ask(io: Io, o: Parameters<typeof collect>[1]): Promise<string> {
  try {
    return await collect(io, o);
  } catch (e) {
    const m = (e as Error).message;
    throw m === 'Cancelled.' ? e : new UsageError(m);
  }
}

/** Spec §2 order: name → account → hostname → sender. Flag, then a prompt in a terminal (collect). */
async function resolveInputs(
  f: InstallFlags,
  cf: Cloudflare,
  io: Io
): Promise<Resolved> {
  const name = await ask(io, {
    flag: f.name,
    message: 'Installation name',
    initial: DEFAULT_NAME,
    fallback: DEFAULT_NAME,
    validate: (x) => validateName(x) ?? undefined,
    flagName: '--name',
  });

  const accountId = await resolveAccount(cf, io, f.account);

  const hostFlag = '--hostname <host> or --workers-dev';
  let hostname: string | null = null;
  if (!f['workers-dev']) {
    const custom =
      f.hostname !== undefined ||
      !io.tty ||
      (await io.select('Where should it be served?', [
        {
          value: 'workers.dev',
          label: `workers.dev (${name}.<subdomain>.workers.dev)`,
        },
        {
          value: 'custom',
          label: 'A custom hostname on a zone in this account',
        },
      ])) === 'custom';
    if (custom) {
      hostname = await ask(io, {
        flag: f.hostname,
        message: 'Hostname (like git.example.com)',
        validate: hostProblem,
        flagName: hostFlag,
      });
    }
  }

  let fromEmail: string | null = null;
  if (!f['no-email']) {
    const v = await ask(io, {
      flag: f['from-email'],
      message:
        'Invitation sender email (empty for none: invite links still work)',
      validate: (x) => (x === '' ? undefined : emailProblem(x)),
      flagName: '--from-email <address> or --no-email',
    });
    fromEmail = v === '' ? null : v;
  }
  return {
    name,
    accountId,
    hostname: hostname?.toLowerCase() ?? null,
    fromEmail,
  };
}

/** `--resume` without `--name`: the only unfinished installation, else the only one. */
function resumable(dir: string, name: string | undefined): InstallState | null {
  if (name !== undefined) return findState(dir, name);
  const all = listStates(dir);
  const unfinished = all.filter((s) => s.status !== 'installed');
  if (unfinished.length === 1) return unfinished[0]!;
  if (unfinished.length > 1 || all.length > 1) {
    throw new UsageError(
      `More than one installation is recorded in ${dir} (${all.map((s) => s.inputs.name).join(', ')}): pass --name.`
    );
  }
  return all[0] ?? null;
}

/** The flags given that disagree with what `s` recorded. */
async function differences(
  f: InstallFlags,
  s: InstallState,
  cf: Cloudflare
): Promise<string[]> {
  const out: string[] = [];
  if (f.account !== undefined && f.account !== s.accountId) {
    const hit = (await cf.listAccounts()).find(
      (a) => a.name.toLowerCase() === f.account!.toLowerCase()
    );
    if (hit?.id !== s.accountId) out.push('account');
  }
  if (
    (f.hostname !== undefined &&
      f.hostname.toLowerCase() !== s.inputs.hostname) ||
    (f['workers-dev'] && !s.inputs.workersDev)
  ) {
    out.push('hostname');
  }
  if (
    (f['from-email'] !== undefined && f['from-email'] !== s.inputs.fromEmail) ||
    (f['no-email'] && s.inputs.fromEmail !== null)
  ) {
    out.push('from-email');
  }
  return out;
}

/** Single-quotes a value for a POSIX shell unless it is plainly safe. */
export function shellQuote(v: string): string {
  return /^[A-Za-z0-9@._:/-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * The apply command for a reviewed plan: the resolved inputs as flags, never a secret. `digest`
 * is null for an installed resume, which applies no plan.
 */
export function applyCommand(
  s: InstallState,
  resume: boolean,
  digest: string | null,
  newSetupCode: boolean,
  source: Source
): string {
  const i = s.inputs;
  const q = shellQuote;
  return [
    source.command('install'),
    ...(resume ? ['--resume'] : []),
    `--name ${q(i.name)}`,
    `--account ${q(s.accountId)}`,
    i.hostname ? `--hostname ${q(i.hostname)}` : '--workers-dev',
    i.fromEmail ? `--from-email ${q(i.fromEmail)}` : '--no-email',
    ...(digest ? [`--expect-plan ${digest}`] : []),
    ...(newSetupCode ? ['--new-setup-code'] : []),
    '--yes',
  ].join(' ');
}

/** The optional items still to offer: all before the first deploy, else only those skipped. */
function toOffer(s: InstallState): Set<string> {
  const fresh = s.status !== 'installed' && !hasStep(s, 'deploy:1');
  return new Set(
    OPTIONAL_ITEMS.map((i) => i.id).filter(
      (id) => fresh || s.skipped.includes(id)
    )
  );
}

/**
 * Spec §2: env first, else (when `prompt`, a terminal) a link and masked prompts; empty skips.
 * Only the items in `offer` are collected.
 */
async function collectOptional(
  deps: Deps,
  s: InstallState,
  offer: Set<string> = toOffer(s),
  prompt: boolean = deps.io.tty
): Promise<Optional> {
  const { io, env } = deps;
  const optional: Optional = {};
  const later = `add it later with: ${deps.source.command(`install --resume --name ${s.inputs.name}`)}`;

  if (offer.has('r2-keys')) {
    const id = env.GITORANGE_R2_ACCESS_KEY_ID;
    const secret = env.GITORANGE_R2_SECRET_ACCESS_KEY;
    if (id || secret) {
      if (!id || !secret) {
        throw new UsageError(
          'Set both GITORANGE_R2_ACCESS_KEY_ID and GITORANGE_R2_SECRET_ACCESS_KEY, or neither.'
        );
      }
      optional.r2 = { id, secret };
    } else if (prompt) {
      const n = s.names;
      io.print(
        [
          '',
          'Optional: R2 upload keys for Git LFS and the Actions cache.',
          `Create an R2 API token (Object Read & Write); it may cover all buckets or just ${n.lfs}, ${n.actionsLogs} and ${n.actionsCache}:`,
          `  ${r2TokenLink(s.accountId, [n.lfs, n.actionsLogs, n.actionsCache])}`,
          `Leave empty to skip (${later}).`,
        ].join('\n')
      );
      const keyId = await io.prompt('R2 access key ID', { mask: true });
      const keySecret = keyId
        ? await io.prompt('R2 secret access key', { mask: true })
        : null;
      if (keyId && keySecret) optional.r2 = { id: keyId, secret: keySecret };
    }
  }

  if (offer.has('analytics-token')) {
    const check = (t: string) =>
      checkAnalyticsToken(s.accountId, t, deps.fetchImpl);
    const fromEnv = env.GITORANGE_CF_ANALYTICS_TOKEN;
    if (fromEnv) {
      const problem = await check(fromEnv);
      if (problem) throw new Error(`GITORANGE_CF_ANALYTICS_TOKEN: ${problem}`);
      optional.analytics = fromEnv;
    } else if (prompt) {
      io.print(
        [
          '',
          'Optional: a token for the Usage & cost page (Account Analytics, read).',
          `  ${analyticsTokenLink(s.accountId, `GitOrange analytics (${s.inputs.name})`)}`,
          `Leave empty to skip (${later}).`,
        ].join('\n')
      );
      for (let attempt = 1; attempt <= 2; attempt++) {
        const t = await io.prompt('Analytics API token', { mask: true });
        if (!t) break;
        const problem = await check(t);
        if (!problem) {
          optional.analytics = t;
          break;
        }
        io.print(
          attempt === 1
            ? `${problem} Try again, or leave empty to skip.`
            : `${problem} Skipped.`
        );
      }
    }
  }
  return optional;
}

async function runInstall(f: InstallFlags, deps: Deps): Promise<number> {
  const { io } = deps;
  checkFlags(f);
  // Review Focus 4: before the token or any Cloudflare call.
  if (!io.tty && !f.plan && !f.yes) {
    io.print(NOT_A_TERMINAL);
    return 2;
  }

  let token: string;
  try {
    token = await deps.token();
  } catch (e) {
    io.print((e as Error).message);
    return 1;
  }
  const { env: _env, token: _t, cloudflare, home, ...rest } = deps;
  let ctx: Ctx = { ...rest, cf: cloudflare(token) };
  // Package mode: state, lock and wrangler.jsonc live together in <home>/<slug>/, chosen once the name is known.
  const inInstall = (slug: string) => {
    if (home === null) return;
    const d = installDir(home, slug);
    ctx = { ...ctx, dir: d, configDir: d };
  };

  try {
    let s: InstallState;
    let recorded: boolean;
    if (f.resume) {
      if (home !== null) inInstall(pickResumable(home, f.name).slug);
      const found = resumable(ctx.dir, f.name);
      if (!found) {
        io.print(
          f.name === undefined
            ? `No installation found to resume in ${ctx.dir}.`
            : `No installation named ${f.name} found in ${ctx.dir}.`
        );
        return 1;
      }
      if (
        found.status === 'upgrading' ||
        (found.status === 'failed' && found.upgradeTarget !== undefined)
      ) {
        io.print(
          `An upgrade to ${found.upgradeTarget} is unfinished; run ${deps.source.command(`upgrade --resume --name ${found.inputs.name}`)}.`
        );
        return 1;
      }
      const diff = await differences(f, found, ctx.cf);
      if (diff.length > 0) {
        io.print(
          `These options differ from the recorded installation: ${diff.join(', ')}`
        );
        return 1;
      }
      s = found;
      recorded = true;
    } else {
      const r = await resolveInputs(f, ctx.cf, io);
      inInstall(r.name);
      const id = installationIdOf(
        r.accountId,
        r.name,
        r.hostname ?? 'workers.dev'
      );
      const existing = readState(ctx.dir, id);
      if (existing) {
        if (existing.status === 'installed') {
          io.print(
            `${r.name} is already installed at ${existing.baseUrl}. Nothing was changed.\n` +
              `Check it: ${deps.source.command(`status --name ${r.name}`)}\n` +
              `Add skipped credentials: ${deps.source.command(`install --resume --name ${r.name}`)}\n` +
              `Replace a lost setup code (before the first admin exists): ${deps.source.command(`install --resume --name ${r.name} --new-setup-code`)}`
          );
          return 0;
        }
        io.print(
          `An installation of ${r.name} is recorded with status ${existing.status}. Rerun with --resume: ${deps.source.command(`install --resume --name ${r.name}`)}`
        );
        return 1;
      }
      // Transient: written only by install(), never by --plan.
      s = newState({
        installationId: id,
        accountId: r.accountId,
        inputs: {
          name: r.name,
          hostname: r.hostname,
          workersDev: r.hostname === null,
          fromEmail: r.fromEmail,
        },
        names: resourceNames(r.name),
        baseUrl: '',
      });
      recorded = false;
    }

    const pre = await preflight(ctx.cf, ctx.runner, {
      accountId: s.accountId,
      hostname: s.inputs.hostname,
      workersDev: s.inputs.workersDev,
      fromEmail: s.inputs.fromEmail,
      workerName: s.names.worker,
      source: ctx.source,
    });
    if (pre.failures.length > 0) {
      io.print('Preflight found problems; nothing was changed.\n');
      for (const x of pre.failures)
        io.print(`✗ ${x.message}${x.fix ? `\n  Fix: ${x.fix}` : ''}`);
      return 1;
    }
    // A recorded base URL is never recomputed.
    if (!recorded) {
      if (!pre.baseUrl) throw new Error('Could not work out the base URL.');
      s = { ...s, baseUrl: pre.baseUrl };
    }

    const plan = computePlan(
      {
        installationId: s.installationId,
        ownershipNonce: s.ownershipNonce,
        names: s.names,
      },
      await observe(ctx.cf, s.accountId, s.names),
      s
    );
    io.print(formatPlan(plan, s.inputs, s.baseUrl));
    const installed = s.status === 'installed';

    if (f.plan) {
      try {
        assertConfigWritable(ctx);
      } catch (e) {
        if (!(e instanceof ConfigConflict)) throw e;
        const config = join(ctx.configDir, 'wrangler.jsonc');
        const aside =
          ctx.source.kind === 'package'
            ? `${config} ${config}.hand`
            : 'wrangler.jsonc wrangler.jsonc.hand';
        io.print(
          `\nwrangler.jsonc was written by hand: apply will refuse until you move it aside (e.g. \`mv ${aside}\`).`
        );
      }
      io.print(`\nPlan ${plan.digest}\n\nTo apply it:`);
      // An installed resume applies no plan (resumeInstalled), so its command carries no digest.
      io.print(
        applyCommand(
          s,
          Boolean(f.resume),
          installed ? null : plan.digest,
          Boolean(f['new-setup-code']),
          deps.source
        )
      );
      return 0;
    }
    const expected = f['expect-plan'];
    if (expected !== undefined && expected !== plan.digest) {
      io.print(
        `\nThe plan changed since it was reviewed (expected ${expected}, now ${plan.digest}). Nothing was changed.\n\nPlan ${plan.digest}`
      );
      return 1;
    }

    if (!installed && !f.yes && !(await io.confirm('Apply this plan?', true))) {
      io.print('Nothing was changed.');
      return 1;
    }
    const optional = await collectOptional(deps, s);
    if (installed) {
      await resumeInstalled(ctx, s, optional, {
        newSetupCode: Boolean(f['new-setup-code']),
      });
    } else {
      await install(ctx, {
        state: s,
        // Binds the apply to the plan shown (and confirmed): a plan that changes meanwhile stops.
        expectPlan: expected ?? plan.digest,
        yes: Boolean(f.yes),
        optional,
      });
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError) throw e;
    // A PlanStop's message is the text meant for the person, like every other failure here.
    io.print((e as Error).message);
    return 1;
  }
}

/** `upgrade` (spec §6): package mode only; a checkout points at npx. */
async function runUpgrade(f: UpgradeFlags, deps: Deps): Promise<number> {
  const { io, home } = deps;
  if (home === null) {
    io.print(
      `Upgrades run from npm: npx gitorange adopt --from ${deps.configDir}, then npx gitorange upgrade.`
    );
    return 2;
  }
  if (!io.tty && !f.plan && !f.yes) {
    io.print(NOT_A_TERMINAL);
    return 2;
  }
  const picked = pickInstall(home, f.name);
  let token: string;
  try {
    token = await deps.token();
  } catch (e) {
    io.print((e as Error).message);
    return 1;
  }
  const { env: _env, token: _t, cloudflare, home: _h, ...rest } = deps;
  const d = installDir(home, picked.slug);
  const ctx: Ctx = { ...rest, cf: cloudflare(token), dir: d, configDir: d };
  try {
    await upgrade(ctx, {
      state: picked.state,
      yes: Boolean(f.yes),
      expectPlan: f['expect-plan'],
      replaceCustomCode: Boolean(f['replace-custom-code']),
      resume: Boolean(f.resume),
      plan: Boolean(f.plan),
      // Credentials the worker lacks: from the env, else masked prompts unless --yes. Never a stop.
      askOptional: (missing) =>
        collectOptional(deps, picked.state, new Set(missing), io.tty && !f.yes),
    });
    return 0;
  } catch (e) {
    io.print((e as Error).message);
    return 1;
  }
}

/**
 * Whether this module is the program being run. `import.meta.main` exists from Node 22.18/24.2;
 * where it is undefined (an older Node), compare the script path instead.
 */
export function isEntry(
  main: boolean | undefined,
  argv1: string | undefined,
  url: string
): boolean {
  if (main !== undefined) return main;
  if (argv1 === undefined) return false;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(argv1) === real(fileURLToPath(url));
}

if (isEntry(import.meta.main, process.argv[1], import.meta.url)) {
  const cwd = process.cwd();
  // The npm bundle defines __GITORANGE_PACKAGE_ROOT__; in a checkout it is not defined at all.
  const PACKAGED = typeof __GITORANGE_PACKAGE_ROOT__ === 'string';
  const home = PACKAGED ? gitorangeHome(process.env) : null;
  // The bundle lives at <root>/bin/gitorange.js.
  const source = PACKAGED
    ? packageSource(dirname(dirname(fileURLToPath(import.meta.url))))
    : checkoutSource(cwd);
  const deps: Deps = {
    io: clackIo,
    env: process.env,
    runner: processRunner,
    dir: home ?? join(cwd, '.gitorange'),
    source,
    home,
    configDir: home ?? cwd,
    fetchImpl: fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    token: () => resolveToken(process.env, processRunner, source),
    cloudflare: (token) => restCloudflare(token, fetch),
  };
  process.exitCode = await main(process.argv.slice(2), deps);
}
