import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { install, resumeInstalled, verify, type Ctx } from '../apply.ts';
import { renderConfig } from '../apply-steps.ts';
import type { Io } from '../collect.ts';
import { resourceNames } from '../names.ts';
import { R2_MARKER_KEY } from '../observe.ts';
import type { RunResult } from '../runner.ts';
import { setupCodeHash } from '../secrets.ts';
import { checkoutSource, packageSource } from '../source.ts';
import { newState, readState, type InstallState } from '../state.ts';
import {
  fakeCloudflare,
  fakePackage,
  fakeRunner,
  type FakeCloudflareSeed,
} from './fakes.ts';

const ACCOUNT = 'a'.repeat(32);
const VERSION = 'abcdef123456';
const BASE = 'https://acme.me.workers.dev';
const ID = 'acme-1a2b3c4d5e6f';

const DO_NAMESPACES = [
  { id: 'ns-job', script: 'acme', class: 'JobRunner' },
  { id: 'ns-merge', script: 'acme', class: 'MergeResolver' },
  { id: 'ns-review', script: 'acme', class: 'AgentReviewer' },
  { id: 'ns-live', script: 'acme', class: 'LiveHub' },
  { id: 'ns-other', script: 'someone-else', class: 'LiveHub' },
];

let root: string;
let cwd: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gitorange-apply-'));
  cwd = join(root, 'repo');
  dir = join(cwd, '.gitorange');
  mkdirSync(join(cwd, 'migrations'), { recursive: true });
  copyFileSync(
    new URL('../../../wrangler.jsonc.example', import.meta.url),
    join(cwd, 'wrangler.jsonc.example')
  );
  writeFileSync(
    join(cwd, 'migrations', '0000_init.sql'),
    'CREATE TABLE a (x);'
  );
  writeFileSync(
    join(cwd, 'migrations', '0001_more.sql'),
    'CREATE TABLE b (y);'
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function freshState(): InstallState {
  const s = newState({
    installationId: ID,
    accountId: ACCOUNT,
    inputs: {
      name: 'acme',
      hostname: null,
      workersDev: true,
      fromEmail: null,
    },
    names: resourceNames('acme'),
    baseUrl: BASE,
  });
  return { ...s, ownershipNonce: 'n'.repeat(64) };
}

function marker(s: InstallState, key: string): string {
  return JSON.stringify({
    installationId: s.installationId,
    ownershipNonce: s.ownershipNonce,
    key,
  });
}

/** State of a finished install whose resources the fake also holds. */
function installedFixture(): { s: InstallState; seed: FakeCloudflareSeed } {
  const s = freshState();
  const res = (
    key: string,
    kind: 'd1' | 'r2' | 'worker' | 'workflow',
    name: string,
    id = name
  ) => ({
    key,
    kind,
    name,
    id,
    ownership: 'created' as const,
    state: 'ready' as const,
  });
  const done: InstallState = {
    ...s,
    status: 'installed',
    resources: [
      res('d1', 'd1', 'acme-db', 'd1-existing'),
      res('lfs', 'r2', 'acme-lfs'),
      res('actionsLogs', 'r2', 'acme-actions-logs'),
      res('actionsCache', 'r2', 'acme-actions-cache'),
      res('worker', 'worker', 'acme'),
      res('actionsWorkflow', 'workflow', 'acme-actions-run'),
      res('mergeWorkflow', 'workflow', 'acme-merge-resolution'),
    ],
    steps: [
      'provision-intent:d1',
      'lifecycle:v1',
      'deploy:1',
      'setup-code:1',
      'do-namespaces',
    ].map((key) => ({ key, at: '2026-10-16T00:00:00.000Z' })),
    skipped: ['r2-keys', 'analytics-token'],
    doNamespaceIds: {
      JOB_RUNNER_NAMESPACE_ID: 'ns-job',
      MERGE_RESOLVER_NAMESPACE_ID: 'ns-merge',
      AGENT_REVIEWER_NAMESPACE_ID: 'ns-review',
      LIVE_NAMESPACE_ID: 'ns-live',
    },
  };
  return {
    s: done,
    seed: {
      d1: [{ uuid: 'd1-existing', name: 'acme-db' }],
      r2: {
        'acme-lfs': { [R2_MARKER_KEY]: marker(done, 'lfs') },
        'acme-actions-logs': { [R2_MARKER_KEY]: marker(done, 'actionsLogs') },
        'acme-actions-cache': { [R2_MARKER_KEY]: marker(done, 'actionsCache') },
      },
      doNamespaces: DO_NAMESPACES,
    },
  };
}

/** The installed state as last deployed at `version` from this checkout. */
function pinned(
  h: { ctx: Ctx },
  s: InstallState,
  version = VERSION
): InstallState {
  return {
    ...s,
    deployedConfigHash: renderConfig(h.ctx, s, version).hash,
    deployedVersion: version,
  };
}

/** What a later run sees in Cloudflare after an earlier run deployed. */
function carryOver(
  cf: {
    state: {
      d1: { uuid: string; name: string }[];
      r2: Record<string, Record<string, string>>;
    };
  },
  s: InstallState
): FakeCloudflareSeed {
  return {
    d1: cf.state.d1.map(({ uuid, name }) => ({ uuid, name })),
    r2: cf.state.r2,
    workflows: [
      { name: s.names.actionsWorkflow, scriptName: s.names.worker },
      { name: s.names.mergeWorkflow, scriptName: s.names.worker },
    ],
    workerVars: {
      [s.names.worker]: {
        GITORANGE_INSTALLATION: JSON.stringify({
          installationId: s.installationId,
          ownershipNonce: s.ownershipNonce,
        }),
      },
    },
  };
}

type Deploy = { args: string[]; secrets: Record<string, string> | null };

function harness(
  opts: {
    seed?: FakeCloudflareSeed;
    /** What `git rev-parse` reports and the default well-known answer carries. */
    version?: string;
    secretList?: RunResult;
    deploy?: RunResult;
    wellKnown?: () => Response | Promise<Response>;
    setupStatus?: { setupRequired: boolean; codeRequired: boolean };
    r2Status?: number;
    tty?: boolean;
    prompts?: (string | null)[];
    confirm?: boolean;
    /** Run from an npm package (fakePackage) instead of the checkout. */
    pkg?: boolean;
  } = {}
) {
  const cf = fakeCloudflare({ doNamespaces: DO_NAMESPACES, ...opts.seed });
  const deploys: Deploy[] = [];
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  let source = checkoutSource(cwd);
  let configDir = cwd;
  if (opts.pkg) {
    const pkgRoot = fakePackage(join(root, 'pkg'), {
      version: '1.0.0',
      commit: 'c'.repeat(40),
    });
    mkdirSync(join(pkgRoot, 'migrations'), { recursive: true });
    copyFileSync(
      join(cwd, 'wrangler.jsonc.example'),
      join(pkgRoot, 'wrangler.jsonc.example')
    );
    for (const f of ['0000_init.sql', '0001_more.sql'])
      copyFileSync(join(cwd, 'migrations', f), join(pkgRoot, 'migrations', f));
    source = packageSource(pkgRoot);
    configDir = join(root, 'home', 'acme');
    mkdirSync(configDir, { recursive: true });
  }
  // Both sources reach wrangler through one handler: yarn as `-s [wrangler] …`, a package as `<bin> …`.
  const wrangler = (args: string[]) => {
    const a = args.slice(1);
    if (a[0] === 'wrangler') a.shift();
    return a;
  };
  const handle = (args: string[]): RunResult => {
    const w = wrangler(args);
    if (w[0] === 'deploy') {
      const i = args.indexOf('--secrets-file');
      deploys.push({
        args,
        secrets:
          i >= 0
            ? (JSON.parse(readFileSync(args[i + 1], 'utf8')) as Record<
                string,
                string
              >)
            : null,
      });
      return opts.deploy ?? ok();
    }
    if (w[0] === 'secret') {
      return opts.secretList ?? { code: 1, stdout: '', stderr: 'not found' };
    }
    if (w[0] === 'd1') return ok();
    throw new Error(`unexpected wrangler ${args.join(' ')}`);
  };
  const runner = fakeRunner({
    'git rev-parse': () => ok(`${opts.version ?? VERSION}\n`),
    'git status': () => ok(''),
    yarn: handle,
    [process.execPath]: handle,
  });
  const printed: string[] = [];
  const prompts = [...(opts.prompts ?? [])];
  const confirms: { msg: string; initial: boolean }[] = [];
  const io: Io = {
    tty: opts.tty ?? false,
    async prompt() {
      return prompts.shift() ?? null;
    },
    async select() {
      throw new Error('no select');
    },
    async confirm(msg, initial) {
      confirms.push({ msg, initial });
      return opts.confirm ?? true;
    },
    print(t) {
      printed.push(t);
    },
  };
  const fetched: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    fetched.push(url);
    if (url.includes('.r2.cloudflarestorage.com')) {
      return new Response('', { status: opts.r2Status ?? 200 });
    }
    if (url === `${BASE}/.well-known/gitorange`) {
      if (opts.wellKnown) return opts.wellKnown();
      return Response.json({
        installationId: ID,
        version: opts.version ?? (opts.pkg ? '1.0.0' : VERSION),
        schemaDigest: 'x',
      });
    }
    if (url === `${BASE}/api/setup/status`) {
      return Response.json({
        ...(opts.setupStatus ?? { setupRequired: true, codeRequired: true }),
        appName: 'GitOrange',
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const slept: number[] = [];
  const ctx: Ctx = {
    cf,
    runner,
    io,
    dir,
    source,
    configDir,
    fetchImpl,
    sleep: async (ms) => {
      slept.push(ms);
    },
    now: () => new Date('2026-10-17T00:00:00Z'),
  };
  const count = (m: string) => cf.calls.filter((c) => c.method === m).length;
  return { ctx, cf, runner, deploys, printed, fetched, slept, count, confirms };
}

const noOptional = { yes: true, optional: {} };

describe('install', () => {
  it('package source runs wrangler directly', async () => {
    const h = harness({ pkg: true });
    await install(h.ctx, { state: freshState(), ...noOptional });

    const config = join(h.ctx.configDir, 'wrangler.jsonc');
    const wranglerCalls = h.runner.calls.filter(
      (c) => c.cmd === process.execPath
    );
    expect(wranglerCalls.length).toBeGreaterThanOrEqual(3);
    expect(h.runner.calls.every((c) => c.cmd === process.execPath)).toBe(true);
    for (const c of wranglerCalls) {
      if (c.args.includes('deploy')) {
        expect(c.args.join(' ')).toContain(`--config ${config}`);
      } else {
        expect(c.args.slice(-2)).toEqual(['--config', config]);
      }
      expect(c.opts?.cwd).toBe(h.ctx.configDir);
    }
    expect(wranglerCalls.some((c) => c.args.includes('deploy'))).toBe(true);
    expect(wranglerCalls.some((c) => c.args.includes('migrations'))).toBe(true);
    expect(
      h.runner.calls.some((c) => c.cmd === 'yarn' || c.cmd === 'git')
    ).toBe(false);
    expect(existsSync(config)).toBe(true);
    expect(readFileSync(config, 'utf8').split('\n')[0]).toContain(
      'Edit inputs with npx gitorange@1.0.0 install, not by hand.'
    );
    expect(existsSync(join(cwd, 'wrangler.jsonc'))).toBe(false);
    expect(h.printed.join('\n')).toContain(
      'npx gitorange@1.0.0 install --resume --name acme'
    );
  });

  it('fresh install creates everything once, deploys, verifies, ends installed', async () => {
    const h = harness();
    const out = await install(h.ctx, { state: freshState(), ...noOptional });

    expect(h.count('createD1')).toBe(1);
    expect(h.count('createR2')).toBe(3);
    const markers = h.cf.calls.filter(
      (c) => c.method === 'putR2Object' && c.args[2] === R2_MARKER_KEY
    );
    expect(markers.map((c) => c.args[1]).sort()).toEqual([
      'acme-actions-cache',
      'acme-actions-logs',
      'acme-lfs',
    ]);
    for (const b of ['acme-lfs', 'acme-actions-logs', 'acme-actions-cache']) {
      expect(JSON.parse(h.cf.state.r2[b][R2_MARKER_KEY])).toMatchObject({
        installationId: ID,
        ownershipNonce: out.ownershipNonce,
      });
    }
    expect(h.count('putR2Lifecycle')).toBe(1);
    expect(h.cf.state.lifecycle['acme-actions-cache']).toEqual([
      { id: 'expire-7d', prefix: 'actions-cache/', days: 7 },
    ]);

    // Migrations, then the D1 marker row.
    const migrate = h.runner.calls.findIndex(
      (c) =>
        c.cmd === 'yarn' &&
        c.args.join(' ') === '-s wrangler d1 migrations apply DB --remote'
    );
    expect(migrate).toBeGreaterThanOrEqual(0);
    const insert = h.cf.calls.find(
      (c) =>
        c.method === 'queryD1' &&
        String(c.args[2]).includes('INSERT OR REPLACE INTO install_state')
    );
    expect(insert?.args[3]).toEqual([
      ID,
      out.ownershipNonce,
      VERSION,
      expect.stringContaining('schemaDigest'),
      Date.parse('2026-10-17T00:00:00Z'),
    ]);

    // First deploy carries the secrets; the second (DO namespace ids) does not.
    expect(h.deploys).toHaveLength(2);
    expect(h.deploys[0].args).toContain('--secrets-file');
    expect(Object.keys(h.deploys[0].secrets!).sort()).toEqual([
      'BETTER_AUTH_SECRET',
      'SETUP_CODE_HASH',
    ]);
    expect(h.deploys[1].secrets).toBeNull();

    const config = readFileSync(join(cwd, 'wrangler.jsonc'), 'utf8');
    expect(config).toContain('"JOB_RUNNER_NAMESPACE_ID": "ns-job"');
    expect(config).toContain(`"GITORANGE_VERSION": "${VERSION}"`);

    expect(out.status).toBe('installed');
    expect(readState(dir, ID)?.status).toBe('installed');
    expect(out.doNamespaceIds.LIVE_NAMESPACE_ID).toBe('ns-live');
    expect(out.resources.map((r) => r.key).sort()).toEqual([
      'actionsCache',
      'actionsLogs',
      'actionsWorkflow',
      'd1',
      'lfs',
      'mergeWorkflow',
      'worker',
    ]);
    expect(out.skipped).toEqual(['r2-keys', 'analytics-token']);
    const summary = h.printed.join('\n');
    const code = /Setup code: (\S+)/.exec(summary)?.[1];
    expect(code).toBeTruthy();
    expect(setupCodeHash(code!)).toBe(h.deploys[0].secrets!.SETUP_CODE_HASH);
    expect(summary).toContain(`${BASE}/setup`);
    expect(summary).toContain('yarn gitorange install --resume --name acme');
    // No secret ever lands in the state file.
    const stateText = readFileSync(join(dir, `${ID}.json`), 'utf8');
    expect(stateText).not.toContain(code!);
    expect(stateText).not.toContain(h.deploys[0].secrets!.BETTER_AUTH_SECRET);
    expect(existsSync(join(dir, `${ID}.lock`))).toBe(false);
  });

  it('runs every wrangler and deploy subprocess with the chosen account', async () => {
    const h = harness();
    await install(h.ctx, { state: freshState(), ...noOptional });
    const yarn = h.runner.calls.filter((c) => c.cmd === 'yarn');
    expect(yarn.length).toBeGreaterThanOrEqual(4);
    for (const c of yarn) {
      expect(c.opts?.env).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    }
  });

  it('resume after a crash between create and record', async () => {
    const s = freshState();
    const crashed: InstallState = {
      ...s,
      status: 'provisioning',
      steps: [{ key: 'provision-intent:lfs', at: '2026-10-16T00:00:00.000Z' }],
    };
    const h = harness({
      seed: { r2: { 'acme-lfs': { [R2_MARKER_KEY]: marker(s, 'lfs') } } },
    });
    const out = await install(h.ctx, { state: crashed, ...noOptional });

    expect(
      h.cf.calls.filter((c) => c.method === 'createR2').map((c) => c.args[1])
    ).toEqual(['acme-actions-logs', 'acme-actions-cache']);
    expect(out.resources.find((r) => r.key === 'lfs')).toMatchObject({
      id: 'acme-lfs',
    });
    expect(out.status).toBe('installed');
  });

  it('retries a failed marker write instead of stranding the bucket', async () => {
    const h = harness();
    h.cf.failNext('putR2Object', new Error('HTTP 500'));
    h.cf.failNext('putR2Object', new Error('HTTP 503'));
    const out = await install(h.ctx, { state: freshState(), ...noOptional });
    expect(out.status).toBe('installed');
    expect(JSON.parse(h.cf.state.r2['acme-lfs'][R2_MARKER_KEY])).toMatchObject({
      installationId: ID,
      key: 'lfs',
    });
    expect(h.slept.slice(0, 2)).toEqual([1000, 2000]);
  });

  it('a marker write failing three times fails the step, and the resume reuses the empty bucket', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++)
      h.cf.failNext('putR2Object', new Error('HTTP 500'));
    await expect(
      install(h.ctx, { state: freshState(), ...noOptional })
    ).rejects.toThrow(/Step provision:lfs failed/);
    const saved = readState(dir, ID)!;
    expect(saved.steps.map((x) => x.key)).toContain('provision-intent:lfs');
    expect(h.cf.state.r2['acme-lfs']).toEqual({});

    const again = harness({
      seed: {
        d1: h.cf.state.d1.map(({ uuid, name }) => ({ uuid, name })),
        r2: h.cf.state.r2,
      },
    });
    const out = await install(again.ctx, { state: saved, ...noOptional });
    expect(
      again.cf.calls
        .filter((c) => c.method === 'createR2')
        .map((c) => c.args[1])
    ).toEqual(['acme-actions-logs', 'acme-actions-cache']);
    expect(
      JSON.parse(again.cf.state.r2['acme-lfs'][R2_MARKER_KEY])
    ).toMatchObject({ installationId: ID, key: 'lfs' });
    expect(out.status).toBe('installed');
  });

  it('looks again before recording a provision intent', async () => {
    const h = harness();
    // Someone creates an empty bucket with our name between the plan and the create.
    const real = h.cf.listR2.bind(h.cf);
    let n = 0;
    h.cf.listR2 = async (a) => {
      n++;
      // Calls: the plan, the look before d1, the look before acme-lfs.
      if (n === 3) h.cf.state.r2['acme-lfs'] = {};
      return real(a);
    };
    const err = (await install(h.ctx, {
      state: freshState(),
      ...noOptional,
    }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain('`acme-lfs` already exists');
    const saved = readState(dir, ID)!;
    expect(saved.steps.map((x) => x.key)).not.toContain('provision-intent:lfs');
  });

  it('resume after a crash before the D1 marker', async () => {
    const crashed: InstallState = {
      ...freshState(),
      status: 'provisioning',
      steps: [{ key: 'provision-intent:d1', at: '2026-10-16T00:00:00.000Z' }],
    };
    const h = harness({
      seed: { d1: [{ uuid: 'd1-orphan', name: 'acme-db' }] },
    });
    const out = await install(h.ctx, { state: crashed, ...noOptional });

    expect(h.count('createD1')).toBe(0);
    expect(out.resources.find((r) => r.key === 'd1')).toMatchObject({
      id: 'd1-orphan',
    });
    expect(
      h.cf.state.d1[0].queries.some((q) => q.includes('install_state'))
    ).toBe(true);
  });

  it('BETTER_AUTH_SECRET is not resent when the worker already has it', async () => {
    const h = harness({
      secretList: {
        code: 0,
        stdout: JSON.stringify([
          { name: 'BETTER_AUTH_SECRET', type: 'secret_text' },
        ]),
        stderr: '',
      },
    });
    await install(h.ctx, { state: freshState(), ...noOptional });
    expect(Object.keys(h.deploys[0].secrets!)).toEqual(['SETUP_CODE_HASH']);
    const list = h.runner.calls.find((c) => c.args.includes('secret'));
    expect(list?.args).toEqual([
      '-s',
      'wrangler',
      'secret',
      'list',
      '--name',
      'acme',
      '--format',
      'json',
    ]);
  });

  it('a failing secret list on an existing worker is an error', async () => {
    const s = freshState();
    const h = harness({
      seed: {
        workerVars: {
          acme: {
            GITORANGE_INSTALLATION: JSON.stringify({
              installationId: s.installationId,
              ownershipNonce: s.ownershipNonce,
            }),
          },
        },
      },
      secretList: { code: 1, stdout: '', stderr: 'boom' },
    });
    await expect(install(h.ctx, { state: s, ...noOptional })).rejects.toThrow(
      /Step secrets failed/
    );
    expect(h.deploys).toHaveLength(0);
  });

  it('expect-plan mismatch stops before any create', async () => {
    const h = harness();
    const err = await install(h.ctx, {
      state: freshState(),
      expectPlan: '000000000000',
      ...noOptional,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/000000000000/);
    expect((err as Error).message).toMatch(/create\s+d1\s+acme-db/);
    expect((err as Error).message).toMatch(/Step plan failed/);
    expect(h.count('createD1') + h.count('createR2')).toBe(0);
    expect(readState(dir, ID)?.status).toBe('failed');
  });

  it('a PlanStop message survives inside the wrapped error', async () => {
    const h = harness({ seed: { r2: { 'acme-lfs': {} } } });
    const err = (await install(h.ctx, {
      state: freshState(),
      ...noOptional,
    }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain(
      '`acme-lfs` already exists and was not created by this installation. Nothing was changed.'
    );
    expect(err.message).toContain(
      'Run: yarn gitorange install --resume --name acme'
    );
    expect(h.count('createD1') + h.count('createR2')).toBe(0);
  });

  it('a hand-written wrangler.jsonc stops before any Cloudflare write', async () => {
    writeFileSync(join(cwd, 'wrangler.jsonc'), '{ "name": "mine" }\n');
    const h = harness();
    await expect(
      install(h.ctx, { state: freshState(), ...noOptional })
    ).rejects.toThrow(/was not generated by gitorange/);
    expect(
      h.count('createD1') + h.count('createR2') + h.count('putR2Object')
    ).toBe(0);
    expect(readFileSync(join(cwd, 'wrangler.jsonc'), 'utf8')).toBe(
      '{ "name": "mine" }\n'
    );
    // No state file or lock is left behind.
    expect(existsSync(dir)).toBe(false);
  });

  it('rejected R2 keys stop before the deploy', async () => {
    const h = harness({ r2Status: 403 });
    const err = (await install(h.ctx, {
      state: freshState(),
      yes: true,
      optional: { r2: { id: 'AKID', secret: 'SECRETVALUE' } },
    }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain('R2 rejected these keys (HTTP 403).');
    expect(err.message).not.toContain('SECRETVALUE');
    expect(h.deploys).toHaveLength(0);
    expect(readState(dir, ID)?.status).toBe('failed');
  });

  it('rejected R2 keys are asked for once more in a terminal', async () => {
    let calls = 0;
    const h = harness({ tty: true, prompts: ['AKID2', 'SECRET2'] });
    const base = h.ctx.fetchImpl;
    h.ctx.fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes('.r2.cloudflarestorage.com')) {
        calls++;
        return new Response('', { status: calls === 1 ? 403 : 200 });
      }
      return base(input, init);
    }) as typeof fetch;
    const out = await install(h.ctx, {
      state: freshState(),
      yes: true,
      optional: { r2: { id: 'AKID', secret: 'BAD' } },
    });
    expect(h.deploys[0].secrets).toMatchObject({
      R2_ACCESS_KEY_ID: 'AKID2',
      R2_SECRET_ACCESS_KEY: 'SECRET2',
    });
    expect(out.skipped).toEqual(['analytics-token']);
  });

  it('a failing deploy leaves status failed and prints the resume command', async () => {
    const h = harness({
      deploy: { code: 1, stdout: '', stderr: 'upload failed' },
    });
    const err = (await install(h.ctx, {
      state: freshState(),
      ...noOptional,
    }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain('upload failed');
    expect(err.message).toContain(
      'Step deploy:1 failed. Nothing after it ran. Run: yarn gitorange install --resume --name acme'
    );
    const saved = readState(dir, ID)!;
    expect(saved.status).toBe('failed');
    expect(saved.steps.map((x) => x.key)).not.toContain('deploy:1');
    expect(existsSync(join(dir, `${ID}.lock`))).toBe(false);

    // The resume picks up at the deploy: nothing is created again.
    const again = harness({
      seed: {
        d1: h.cf.state.d1.map(({ uuid, name }) => ({ uuid, name })),
        r2: h.cf.state.r2,
      },
    });
    const out = await install(again.ctx, { state: saved, ...noOptional });
    expect(again.count('createD1') + again.count('createR2')).toBe(0);
    expect(again.count('putR2Lifecycle')).toBe(0);
    expect(again.runner.calls.some((c) => c.args.includes('migrations'))).toBe(
      false
    );
    expect(out.status).toBe('installed');
  });
});

describe('verify', () => {
  it('retries while the certificate is issuing', async () => {
    let n = 0;
    const h = harness({
      wellKnown: () => {
        n++;
        if (n <= 2) throw new TypeError('fetch failed');
        return Response.json({
          installationId: ID,
          version: VERSION,
          schemaDigest: 'x',
        });
      },
    });
    await verify(h.ctx, freshState());
    expect(n).toBe(3);
    expect(h.slept).toEqual([5000, 5000]);
  });

  it('gives up after 60 s naming the URL', async () => {
    const h = harness({
      wellKnown: () => {
        throw new TypeError('fetch failed');
      },
    });
    const err = (await verify(h.ctx, freshState()).catch(
      (e: Error) => e
    )) as Error;
    expect(err.message).toContain(`${BASE}/.well-known/gitorange`);
    expect(err.message).toContain('fetch failed');
    expect(h.slept).toHaveLength(12);
    expect(h.slept.reduce((a, b) => a + b, 0)).toBe(60_000);
  });

  it('retries a wrong version, then fails with the last body', async () => {
    const h = harness({
      wellKnown: () =>
        Response.json({
          installationId: ID,
          version: 'old',
          schemaDigest: 'x',
        }),
    });
    const err = (await verify(h.ctx, freshState()).catch(
      (e: Error) => e
    )) as Error;
    expect(err.message).toContain('old');
    expect(h.slept.length).toBe(12);
  });

  it('on a custom hostname, says the certificate may still be issuing', async () => {
    const h = harness({
      wellKnown: () => {
        throw new TypeError('fetch failed');
      },
    });
    const s = freshState();
    const custom = {
      ...s,
      inputs: { ...s.inputs, hostname: 'git.example.com', workersDev: false },
    };
    const err = (await verify(h.ctx, custom).catch((e: Error) => e)) as Error;
    expect(err.message).toContain(
      "A custom domain's certificate can take several minutes to issue; wait, then run: yarn gitorange install --resume --name acme"
    );
    const plain = (await verify(h.ctx, s).catch((e: Error) => e)) as Error;
    expect(plain.message).not.toContain('certificate');
  });

  it('fails when setup is open without a code', async () => {
    const h = harness({
      setupStatus: { setupRequired: true, codeRequired: false },
    });
    await expect(verify(h.ctx, freshState())).rejects.toThrow(/setup code/i);
  });

  it('passes once setup is complete', async () => {
    const h = harness({
      setupStatus: { setupRequired: false, codeRequired: false },
    });
    await expect(verify(h.ctx, freshState())).resolves.toBeUndefined();
  });
});

describe('config hash', () => {
  it('covers the deployed (top-level) config, not the env block', async () => {
    const h = harness();
    const s = await install(h.ctx, { state: freshState(), ...noOptional });
    const path = join(cwd, 'wrangler.jsonc');
    const before = renderConfig(h.ctx, s, VERSION).hash;
    expect(before).toBe(s.deployedConfigHash);
    const text = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      text.replace('"WORKER_NAME": "gitorange-dev"', '"WORKER_NAME": "my-dev"')
    );
    expect(readFileSync(path, 'utf8')).toContain('"WORKER_NAME": "my-dev"');
    expect(renderConfig(h.ctx, s, VERSION).hash).toBe(before);
    // A top-level change still counts.
    expect(renderConfig(h.ctx, s, 'fedcba654321').hash).not.toBe(before);
  });
});

describe('resumeInstalled', () => {
  it('rerun after installed with nothing to add creates nothing', async () => {
    const { s, seed } = installedFixture();
    const h = harness({
      seed,
      setupStatus: { setupRequired: false, codeRequired: false },
    });
    const out = await resumeInstalled(h.ctx, pinned(h, s), {});
    expect(h.cf.calls.filter((c) => /^(create|put)/.test(c.method))).toEqual(
      []
    );
    expect(h.deploys).toHaveLength(0);
    expect(h.printed.join('\n')).toContain('Nothing to do.');
    expect(out.status).toBe('installed');
  });

  it('adds LFS keys with one deploy', async () => {
    const { s, seed } = installedFixture();
    const h = harness({
      seed,
      setupStatus: { setupRequired: false, codeRequired: false },
    });
    const out = await resumeInstalled(h.ctx, pinned(h, s), {
      r2: { id: 'AKID', secret: 'SEC' },
    });
    expect(h.deploys).toHaveLength(1);
    expect(h.deploys[0].secrets).toEqual({
      R2_ACCESS_KEY_ID: 'AKID',
      R2_SECRET_ACCESS_KEY: 'SEC',
    });
    expect(out.skipped).toEqual(['analytics-token']);
    expect(out.status).toBe('installed');
    expect(h.cf.calls.filter((c) => /^create/.test(c.method))).toEqual([]);
  });

  it('reissues a lost setup code with --new-setup-code, only while no user exists', async () => {
    const { s, seed } = installedFixture();
    const open = harness({
      seed,
      setupStatus: { setupRequired: true, codeRequired: true },
    });
    const out = await resumeInstalled(
      open.ctx,
      pinned(open, s),
      {},
      { newSetupCode: true }
    );
    expect(open.confirms).toEqual([]);
    expect(open.deploys).toHaveLength(1);
    expect(Object.keys(open.deploys[0].secrets!)).toEqual(['SETUP_CODE_HASH']);
    const code = /Setup code: (\S+)/.exec(open.printed.join('\n'))?.[1];
    expect(setupCodeHash(code!)).toBe(open.deploys[0].secrets!.SETUP_CODE_HASH);
    expect(out.steps.map((x) => x.key)).toContain('setup-code:2');

    const closed = harness({
      seed,
      setupStatus: { setupRequired: false, codeRequired: false },
    });
    await resumeInstalled(
      closed.ctx,
      pinned(closed, s),
      {},
      { newSetupCode: true }
    );
    expect(closed.deploys).toHaveLength(0);
    expect(closed.printed.join('\n')).not.toContain('Setup code:');
  });

  it('without a terminal and without --new-setup-code, keeps the old code', async () => {
    const { s, seed } = installedFixture();
    const h = harness({
      seed,
      setupStatus: { setupRequired: true, codeRequired: true },
    });
    const out = await resumeInstalled(h.ctx, pinned(h, s), {});
    expect(h.deploys).toHaveLength(0);
    expect(h.confirms).toEqual([]);
    const printed = h.printed.join('\n');
    expect(printed).not.toContain('Setup code:');
    expect(printed).toContain(
      'yarn gitorange install --resume --name acme --new-setup-code'
    );
    expect(out.steps.map((x) => x.key)).not.toContain('setup-code:2');
  });

  it('in a terminal, asks before replacing the code (default no)', async () => {
    const { s, seed } = installedFixture();
    const declined = harness({
      seed,
      tty: true,
      confirm: false,
      setupStatus: { setupRequired: true, codeRequired: true },
    });
    await resumeInstalled(declined.ctx, pinned(declined, s), {});
    expect(declined.confirms).toEqual([
      {
        msg: 'Issue a new setup code? The old one stops working.',
        initial: false,
      },
    ]);
    expect(declined.deploys).toHaveLength(0);
    expect(declined.printed.join('\n')).not.toContain('Setup code:');

    const accepted = harness({
      seed,
      tty: true,
      confirm: true,
      setupStatus: { setupRequired: true, codeRequired: true },
    });
    await resumeInstalled(accepted.ctx, pinned(accepted, s), {});
    expect(accepted.deploys).toHaveLength(1);
    expect(Object.keys(accepted.deploys[0].secrets!)).toEqual([
      'SETUP_CODE_HASH',
    ]);
  });

  it('a declined code still sends supplied credentials', async () => {
    const { s, seed } = installedFixture();
    const h = harness({
      seed,
      tty: true,
      confirm: false,
      setupStatus: { setupRequired: true, codeRequired: true },
    });
    await resumeInstalled(h.ctx, pinned(h, s), { analytics: 'TOKEN' });
    expect(h.deploys).toHaveLength(1);
    expect(h.deploys[0].secrets).toEqual({ CF_ANALYTICS_TOKEN: 'TOKEN' });
  });

  it('deploys with the chosen account', async () => {
    const { s, seed } = installedFixture();
    const h = harness({
      seed,
      setupStatus: { setupRequired: false, codeRequired: false },
    });
    await resumeInstalled(h.ctx, pinned(h, s), { analytics: 'TOKEN' });
    const deploy = h.runner.calls.find((c) => c.args[1] === 'deploy');
    expect(deploy?.opts?.env).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
  });

  it('a failing deploy keeps the install installed', async () => {
    const { s, seed } = installedFixture();
    const h = harness({
      seed,
      setupStatus: { setupRequired: false, codeRequired: false },
      deploy: { code: 1, stdout: '', stderr: 'nope' },
    });
    await expect(
      resumeInstalled(h.ctx, pinned(h, s), { analytics: 'TOKEN' })
    ).rejects.toThrow(/Step deploy failed/);
    expect(readState(dir, ID)?.status).toBe('installed');
  });

  it('after HEAD moved: Nothing to do, no deploy, verifies the recorded version', async () => {
    const { s, seed } = installedFixture();
    const h = harness({
      seed,
      version: 'fedcba654321',
      // The instance still runs the recorded version.
      wellKnown: () =>
        Response.json({
          installationId: ID,
          version: VERSION,
          schemaDigest: 'x',
        }),
      setupStatus: { setupRequired: false, codeRequired: false },
    });
    const at = pinned(h, s, VERSION);
    await resumeInstalled(h.ctx, at, {});
    expect(h.deploys).toHaveLength(0);
    expect(existsSync(join(cwd, 'wrangler.jsonc'))).toBe(false);
    const out = h.printed.join('\n');
    expect(out).toContain('Nothing to do.');
    expect(out).toContain('Upgrades come in a later release');
  });

  it('checks for a hand-written wrangler.jsonc first', async () => {
    writeFileSync(join(cwd, 'wrangler.jsonc'), '{ "name": "mine" }\n');
    const { s, seed } = installedFixture();
    const h = harness({ seed });
    await expect(resumeInstalled(h.ctx, s, {})).rejects.toThrow(
      /was not generated by gitorange/
    );
    expect(h.fetched).toEqual([]);
  });
});

describe('install resumed after a failed verify', () => {
  async function failVerify() {
    const first = harness({
      wellKnown: () => {
        throw new TypeError('fetch failed');
      },
    });
    const err = (await install(first.ctx, {
      state: freshState(),
      ...noOptional,
    }).catch((e: Error) => e)) as Error;
    return { first, err, saved: readState(dir, ID)! };
  }

  it('ends installed, and keeps the setup code visible on the failure', async () => {
    const { first, err, saved } = await failVerify();
    expect(err.message).toContain('Step verify failed');
    expect(saved.status).toBe('failed');
    const code = /Setup code: (\S+)/.exec(first.printed.join('\n'))?.[1];
    expect(code).toBeTruthy();
    expect(setupCodeHash(code!)).toBe(
      first.deploys[0].secrets!.SETUP_CODE_HASH
    );
    expect(err.message).not.toContain(code!);
    expect(readFileSync(join(dir, `${ID}.json`), 'utf8')).not.toContain(code!);

    const again = harness({ seed: carryOver(first.cf, saved) });
    const out = await install(again.ctx, { state: saved, ...noOptional });
    expect(out.status).toBe('installed');
    expect(again.deploys).toHaveLength(0);
    expect(again.count('createD1') + again.count('createR2')).toBe(0);
    const printed = again.printed.join('\n');
    expect(printed).not.toContain('Setup code:');
    expect(printed).toContain(
      'The first admin still needs a setup code. If you no longer have it, run: yarn gitorange install --resume --name acme --new-setup-code'
    );
  });

  it('redeploys once when HEAD moved, then verifies the new version', async () => {
    const { first, saved } = await failVerify();
    const again = harness({
      seed: carryOver(first.cf, saved),
      version: 'fedcba654321',
    });
    const out = await install(again.ctx, { state: saved, ...noOptional });
    expect(again.deploys).toHaveLength(1);
    expect(again.deploys[0].secrets).toBeNull();
    expect(out.deployedVersion).toBe('fedcba654321');
    expect(out.status).toBe('installed');
    expect(readFileSync(join(cwd, 'wrangler.jsonc'), 'utf8')).toContain(
      '"GITORANGE_VERSION": "fedcba654321"'
    );
  });
});
