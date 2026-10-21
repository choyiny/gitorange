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
import type { Ctx, Optional } from '../apply.ts';
import { renderConfig } from '../apply-steps.ts';
import type { Io } from '../collect.ts';
import { ConfigConflict } from '../config.ts';
import { resourceNames } from '../names.ts';
import { R2_MARKER_KEY } from '../observe.ts';
import { DOCKER_NOT_INSTALLED } from '../preflight.ts';
import type { RunResult } from '../runner.ts';
import { packageSource } from '../source.ts';
import {
  newState,
  readState,
  writeState,
  type InstallState,
} from '../state.ts';
import { formatUpgradePlan, planUpgrade, upgrade } from '../upgrade.ts';
import {
  fakeCloudflare,
  fakePackage,
  fakeRunner,
  type FakeCloudflareSeed,
} from './fakes.ts';

const ACCOUNT = 'a'.repeat(32);
const BASE = 'https://acme.me.workers.dev';
const ID = 'acme-1a2b3c4d5e6f';
const TO = '1.3.0';
const LAST =
  'Migrations cannot be undone. If the new release is broken, the way back is the next release.';
const TYPED = [
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'CF_ANALYTICS_TOKEN',
];
/** What a worker installed with every credential has, except the generated auth secret. */
const ALL_BUT_AUTH = [...TYPED, 'SETUP_CODE_HASH'];
const ALL_SECRETS = [...ALL_BUT_AUTH, 'BETTER_AUTH_SECRET'];
const DO_IDS = {
  JOB_RUNNER_NAMESPACE_ID: 'ns-job',
  MERGE_RESOLVER_NAMESPACE_ID: 'ns-merge',
  AGENT_REVIEWER_NAMESPACE_ID: 'ns-review',
  LIVE_NAMESPACE_ID: 'ns-live',
};
const DO_NAMESPACES = [
  { id: 'ns-job', script: 'acme', class: 'JobRunner' },
  { id: 'ns-merge', script: 'acme', class: 'MergeResolver' },
  { id: 'ns-review', script: 'acme', class: 'AgentReviewer' },
  { id: 'ns-live', script: 'acme', class: 'LiveHub' },
];

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gitorange-upgrade-'));
  home = join(root, 'home', 'acme');
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const res = (
  key: string,
  kind: 'd1' | 'r2' | 'worker' | 'workflow',
  name: string,
  id = name,
  ownership: 'created' | 'adopted' = 'created'
) => ({ key, kind, name, id, ownership, state: 'ready' as const });

const marker = (s: InstallState, key: string) =>
  JSON.stringify({
    installationId: s.installationId,
    ownershipNonce: s.ownershipNonce,
    key,
  });

/** Installed at 1.2.0, without the Actions cache bucket (a resource the new version needs). */
function installedAt120(): InstallState {
  const s = newState({
    installationId: ID,
    accountId: ACCOUNT,
    inputs: { name: 'acme', hostname: null, workersDev: true, fromEmail: null },
    names: resourceNames('acme'),
    baseUrl: BASE,
  });
  return {
    ...s,
    ownershipNonce: 'n'.repeat(64),
    status: 'installed',
    resources: [
      res('d1', 'd1', 'acme-db', 'd1-existing'),
      res('lfs', 'r2', 'acme-lfs'),
      res('actionsLogs', 'r2', 'acme-actions-logs'),
      res('worker', 'worker', 'acme'),
      res('actionsWorkflow', 'workflow', 'acme-actions-run'),
      res('mergeWorkflow', 'workflow', 'acme-merge-resolution'),
    ],
    steps: [{ key: 'deploy:1', at: '2026-10-16T00:00:00.000Z' }],
    deployedVersion: '1.2.0',
    deployedConfigHash: 'old',
    doNamespaceIds: { ...DO_IDS },
  };
}

function seedFor(s: InstallState): FakeCloudflareSeed {
  return {
    d1: [{ uuid: 'd1-existing', name: 'acme-db' }],
    d1Migrations: { 'd1-existing': ['0000_init.sql'] },
    r2: {
      'acme-lfs': { [R2_MARKER_KEY]: marker(s, 'lfs') },
      'acme-actions-logs': { [R2_MARKER_KEY]: marker(s, 'actionsLogs') },
    },
    workflows: [
      { name: 'acme-actions-run', scriptName: 'acme' },
      { name: 'acme-merge-resolution', scriptName: 'acme' },
    ],
    workerVars: {
      acme: {
        GITORANGE_INSTALLATION: JSON.stringify({
          installationId: s.installationId,
          ownershipNonce: s.ownershipNonce,
        }),
      },
    },
    doNamespaces: DO_NAMESPACES,
  };
}

type Deploy = { args: string[]; secrets: Record<string, string> | null };

function harness(
  opts: {
    state?: InstallState;
    seed?: FakeCloudflareSeed;
    /** The version /.well-known reports before the first deploy. */
    running?: string | null;
    /** The installation id it reports before the first deploy. */
    runningId?: string | null;
    secrets?: string[];
    confirm?: boolean;
    tty?: boolean;
    /** Setup open without a code: verify refuses. */
    setupOpen?: boolean;
    /** The HTTP status R2 answers a key check with (default 200). */
    r2Check?: number;
    docker?: () => RunResult | Promise<RunResult>;
  } = {}
) {
  const s = opts.state ?? installedAt120();
  writeState(home, s);
  const cf = fakeCloudflare(opts.seed ?? seedFor(s));
  const pkgRoot = fakePackage(join(root, 'pkg'), {
    version: TO,
    commit: 'c'.repeat(40),
  });
  mkdirSync(join(pkgRoot, 'migrations'), { recursive: true });
  copyFileSync(
    new URL('../../../wrangler.jsonc.example', import.meta.url),
    join(pkgRoot, 'wrangler.jsonc.example')
  );
  writeFileSync(
    join(pkgRoot, 'migrations', '0000_init.sql'),
    'CREATE TABLE a (x);'
  );
  writeFileSync(
    join(pkgRoot, 'migrations', '0001_more.sql'),
    'CREATE TABLE b (y);'
  );
  const source = packageSource(pkgRoot);
  const deploys: Deploy[] = [];
  const migrations: string[][] = [];
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  let deployResult: RunResult = ok();
  const runner = fakeRunner({
    docker: opts.docker ?? (() => ok('27.0.0\n')),
    [process.execPath]: (args) => {
      const w = args.slice(1);
      if (w[0] === 'deploy') {
        const i = args.indexOf('--secrets-file');
        deploys.push({
          args,
          secrets:
            i >= 0
              ? (JSON.parse(readFileSync(args[i + 1]!, 'utf8')) as Record<
                  string,
                  string
                >)
              : null,
        });
        return deployResult;
      }
      if (w[0] === 'secret') {
        const names = opts.secrets ?? ALL_BUT_AUTH;
        return ok(JSON.stringify(names.map((name) => ({ name }))));
      }
      if (w[0] === 'd1') {
        migrations.push(w);
        return ok();
      }
      throw new Error(`unexpected wrangler ${args.join(' ')}`);
    },
  });
  const printed: string[] = [];
  const io: Io = {
    tty: opts.tty ?? false,
    async prompt() {
      return null;
    },
    async select() {
      throw new Error('no select');
    },
    async confirm() {
      return opts.confirm ?? true;
    },
    print(t) {
      printed.push(t);
    },
  };
  let down = false;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url === `${BASE}/.well-known/gitorange`) {
      const deployed = deploys.length > 0 && deployResult.code === 0;
      if (down && !deployed) throw new TypeError('fetch failed');
      return Response.json({
        installationId: deployed
          ? ID
          : opts.runningId === undefined
            ? ID
            : opts.runningId,
        version: deployed
          ? TO
          : opts.running === undefined
            ? '1.2.0'
            : opts.running,
      });
    }
    if (url === `${BASE}/api/setup/status`) {
      return Response.json({
        setupRequired: opts.setupOpen === true,
        codeRequired: opts.setupOpen !== true,
      });
    }
    if (
      url.startsWith(`https://${ACCOUNT}.r2.cloudflarestorage.com/acme-lfs`)
    ) {
      return new Response('', { status: opts.r2Check ?? 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const ctx: Ctx = {
    cf,
    runner,
    io,
    dir: home,
    source,
    configDir: home,
    fetchImpl,
    sleep: async () => {},
    now: () => new Date('2026-10-17T00:00:00Z'),
  };
  return {
    ctx,
    cf,
    runner,
    deploys,
    migrations,
    printed,
    state: s,
    /** /.well-known unreachable until a deploy succeeds. */
    siteDown() {
      down = true;
    },
    failDeploys() {
      deployResult = { code: 1, stdout: '', stderr: 'boom' };
    },
    okDeploys() {
      deployResult = ok();
    },
    saved: () => readState(home, ID)!,
    /** Runner calls other than the Docker check. */
    nonDocker: () => runner.calls.filter((c) => c.cmd !== 'docker'),
  };
}

const run = (
  h: ReturnType<typeof harness>,
  o: Partial<Parameters<typeof upgrade>[1]> = {}
) =>
  upgrade(h.ctx, {
    state: h.saved(),
    yes: true,
    replaceCustomCode: false,
    resume: false,
    ...o,
  });

describe('planUpgrade', () => {
  it('plan lists migrations, new secret and new resource', async () => {
    const h = harness();
    const p = await planUpgrade(h.ctx, h.state);
    expect(p.from).toBe('1.2.0');
    expect(p.to).toBe(TO);
    expect(p.comparison).toEqual({ kind: 'upgrade' });
    expect(p.migrations).toEqual(['0001_more.sql']);
    expect(p.create.map((a) => [a.kind, a.name])).toEqual([
      ['r2', 'acme-actions-cache'],
    ]);
    expect(p.secrets).toEqual(['BETTER_AUTH_SECRET']);
    expect(p.missing).toEqual([]);
    expect(p.configChanged).toBe(true);
    expect(p.digest).toMatch(/^[0-9a-f]{12}$/);
    const lines = formatUpgradePlan(p).split('\n');
    expect(lines[0]).toBe('Upgrade acme: 1.2.0 → 1.3.0');
    expect(lines).toContain('Migrations: 0001_more.sql');
    expect(lines).toContain('Create: r2 acme-actions-cache');
    expect(lines).toContain('New secrets: BETTER_AUTH_SECRET');
    expect(lines).toContain('Config: changes');
    expect(lines.some((l) => l.startsWith('Missing'))).toBe(false);
    expect(lines.at(-1)).toBe(LAST);
  });

  it('no d1_migrations table: every migration is pending', async () => {
    const s = installedAt120();
    const h = harness({ seed: { ...seedFor(s), d1Migrations: {} } });
    const p = await planUpgrade(h.ctx, h.state);
    expect(p.migrations).toEqual(['0000_init.sql', '0001_more.sql']);
  });

  it('no d1_migrations table but other tables: the plan stops', async () => {
    const s = installedAt120();
    const h = harness({
      seed: {
        ...seedFor(s),
        d1Migrations: {},
        d1Tables: { 'd1-existing': ['users', 'repositories'] },
      },
    });
    await expect(planUpgrade(h.ctx, h.state)).rejects.toThrow(
      'D1 acme-db has tables but no d1_migrations table; GitOrange cannot tell which migrations ran.'
    );
    await expect(run(h)).rejects.toThrow('no d1_migrations table');
    expect(h.deploys).toHaveLength(0);
    expect(h.migrations).toHaveLength(0);
    expect(h.saved().status).toBe('installed');
  });
});

describe('upgrade', () => {
  it('applies resources, config, migrations, deploy, durable-objects, markers, verify', async () => {
    const h = harness();
    const s = await run(h);
    expect(s.status).toBe('installed');
    expect(s.deployedVersion).toBe(TO);
    expect(s.upgradedAt).toBe('2026-10-17T00:00:00.000Z');
    expect(s.upgradeTarget).toBeUndefined();
    expect(s.resources.find((r) => r.key === 'actionsCache')?.ownership).toBe(
      'created'
    );
    expect(h.cf.state.lifecycle['acme-actions-cache']).toBeDefined();
    expect(h.migrations).toHaveLength(1);
    expect(h.deploys).toHaveLength(1);
    expect(s.deployedConfigHash).toBe(renderConfig(h.ctx, s, TO).hash);
    expect(
      [
        'resources',
        'config',
        'migrations',
        'deploy',
        'durable-objects',
        'markers',
        'verify',
      ].map((k) => s.steps.some((x) => x.key === `upgrade:${TO}:${k}`))
    ).toEqual([true, true, true, true, true, true, true]);
    expect(
      h.cf.state.d1[0]!.queries.some((q) =>
        q.startsWith('INSERT OR REPLACE INTO install_state')
      )
    ).toBe(true);
    // Every Durable Object namespace id is recorded: none are read again.
    expect(h.cf.calls.some((c) => c.method === 'durableObjectNamespaces')).toBe(
      false
    );
    expect(h.printed.at(-1)).toBe(`Upgraded acme to ${TO}: ${BASE}`);
    expect(readState(home, ID)!.status).toBe('installed');
  });

  it('kept tunable vars are in the regenerated config', async () => {
    const base = installedAt120();
    const h = harness({
      state: {
        ...base,
        inputs: { ...base.inputs, vars: { AI_GATEWAY: 'mine' } },
      },
    });
    const s = await run(h);
    const config = readFileSync(join(home, 'wrangler.jsonc'), 'utf8');
    expect(config).toContain('"AI_GATEWAY": "mine"');
    expect(config).toContain('"APP_NAME": "GitOrange"');
    expect(s.inputs.vars).toEqual({ AI_GATEWAY: 'mine' });
  });

  it('a missing Durable Object namespace id is read and deployed', async () => {
    const h = harness({
      state: {
        ...installedAt120(),
        doNamespaceIds: { JOB_RUNNER_NAMESPACE_ID: 'ns-job' },
      },
    });
    const s = await run(h);
    expect(s.doNamespaceIds).toEqual(DO_IDS);
    expect(h.deploys).toHaveLength(2);
    expect(h.deploys[1]!.secrets).toBeNull();
    expect(s.deployedConfigHash).toBe(renderConfig(h.ctx, s, TO).hash);
    const config = readFileSync(join(home, 'wrangler.jsonc'), 'utf8');
    expect(config).toContain('"LIVE_NAMESPACE_ID": "ns-live"');
  });

  it('docker missing stops before planning', async () => {
    const h = harness({
      docker: () => Promise.reject(new Error('spawn docker ENOENT')),
    });
    const before = readFileSync(join(home, `${ID}.json`), 'utf8');
    await expect(run(h)).rejects.toThrow(DOCKER_NOT_INSTALLED);
    await expect(run(h, { plan: true })).rejects.toThrow(DOCKER_NOT_INSTALLED);
    expect(h.cf.calls).toEqual([]);
    expect(h.nonDocker()).toEqual([]);
    expect(h.printed).toEqual([]);
    expect(readFileSync(join(home, `${ID}.json`), 'utf8')).toBe(before);
    expect(existsSync(join(home, `${ID}.lock`))).toBe(false);
    expect(existsSync(join(home, 'wrangler.jsonc'))).toBe(false);
  });

  it('downgrade refused', async () => {
    const h = harness({ running: '1.4.0' });
    await expect(run(h)).rejects.toThrow(
      'Run that version instead: npx gitorange@1.4.0 upgrade --name acme'
    );
    expect(h.nonDocker()).toHaveLength(0);
    expect(h.saved().status).toBe('installed');
  });

  it('installation id mismatch stops', async () => {
    const h = harness({ runningId: 'someone-else' });
    await expect(run(h)).rejects.toThrow(
      'this is not the install the state describes'
    );
    expect(h.deploys).toHaveLength(0);
  });

  it('null id accepted only after adopt', async () => {
    const plain = harness({ runningId: null });
    await expect(run(plain)).rejects.toThrow(
      'this is not the install the state describes'
    );
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });

    const adopted = harness({
      runningId: null,
      state: { ...installedAt120(), adoptedAt: '2026-10-16T00:00:00.000Z' },
    });
    const s = await run(adopted);
    expect(s.status).toBe('installed');
    expect(adopted.deploys).toHaveLength(1);

    // After that first upgrade, a null id stops again.
    const later = harness({ runningId: null, running: TO, state: s });
    await expect(run(later)).rejects.toThrow(
      'this is not the install the state describes'
    );
  });

  it('the first upgrade after adopt writes the adopted bucket marker and leaves its lifecycle', async () => {
    const base = installedAt120();
    const s0: InstallState = {
      ...base,
      adoptedAt: '2026-10-16T00:00:00.000Z',
      resources: [
        ...base.resources.map((r) =>
          r.key === 'lfs' ? { ...r, ownership: 'adopted' as const } : r
        ),
        res(
          'actionsCache',
          'r2',
          'acme-actions-cache',
          'acme-actions-cache',
          'adopted'
        ),
      ],
    };
    const seed = seedFor(s0);
    const h = harness({
      state: s0,
      seed: {
        ...seed,
        r2: { ...seed.r2, 'acme-lfs': {}, 'acme-actions-cache': {} },
      },
    });
    await run(h);
    expect(JSON.parse(h.cf.state.r2['acme-lfs']![R2_MARKER_KEY]!)).toEqual({
      installationId: ID,
      ownershipNonce: s0.ownershipNonce,
      key: 'lfs',
    });
    expect(h.cf.calls.some((c) => c.method === 'putR2Lifecycle')).toBe(false);
  });

  it('custom code stops without --replace-custom-code', async () => {
    const h = harness({ running: 'deadbeef1234-dirty' });
    const e = await run(h).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    const m = (e as Error).message;
    expect(m).toContain('not a release');
    expect(m).toContain('stock GitOrange');
    expect(m).toContain('own checkout');
    expect(m).toContain(
      'npx gitorange@1.3.0 upgrade --name acme --replace-custom-code'
    );
    expect(h.nonDocker()).toHaveLength(0);
  });

  it('custom code proceeds with --replace-custom-code', async () => {
    const h = harness({ running: 'deadbeef1234-dirty' });
    const s = await run(h, { replaceCustomCode: true });
    expect(s.status).toBe('installed');
    expect(h.printed.join('\n')).toContain(
      'Replacing custom code: deadbeef1234-dirty (uncommitted changes) → GitOrange 1.3.0'
    );
  });

  it('hand-edited config refused', async () => {
    const h = harness();
    writeFileSync(join(home, 'wrangler.jsonc'), '{}\n');
    const e = await run(h).catch((x: Error) => x);
    expect(e).toBeInstanceOf(ConfigConflict);
    expect((e as Error).message).toContain(join(home, 'wrangler.jsonc'));
    expect(h.deploys).toHaveLength(0);
    expect(readFileSync(join(home, 'wrangler.jsonc'), 'utf8')).toBe('{}\n');
  });

  it('only missing secrets are sent', async () => {
    const h = harness();
    await run(h);
    expect(h.deploys).toHaveLength(1);
    expect(Object.keys(h.deploys[0]!.secrets ?? {})).toEqual([
      'BETTER_AUTH_SECRET',
    ]);
  });

  it('upgrade never adds SETUP_CODE_HASH', async () => {
    const h = harness({ secrets: [...TYPED, 'BETTER_AUTH_SECRET'] });
    const p = await planUpgrade(h.ctx, h.state);
    expect(p.secrets).toEqual([]);
    expect(formatUpgradePlan(p)).not.toContain('SETUP_CODE_HASH');
    await run(h);
    expect(h.deploys).toHaveLength(1);
    expect(h.deploys[0]!.args).not.toContain('--secrets-file');
  });

  it('no missing secrets: deploys without a secrets file', async () => {
    const h = harness({ secrets: ALL_SECRETS });
    await run(h);
    expect(h.deploys).toHaveLength(1);
    expect(h.deploys[0]!.args).not.toContain('--secrets-file');
  });

  it('missing R2 keys do not block --yes', async () => {
    const h = harness({
      secrets: ['BETTER_AUTH_SECRET', 'CF_ANALYTICS_TOKEN'],
    });
    const p = await planUpgrade(h.ctx, h.state);
    expect(formatUpgradePlan(p).split('\n')).toContain(
      'Missing (you add them): R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY'
    );
    const s = await run(h);
    expect(h.deploys).toHaveLength(1);
    expect(h.deploys[0]!.args).not.toContain('--secrets-file');
    expect(s.status).toBe('installed');
    expect(s.skipped).toEqual(['r2-keys']);
    const text = h.printed.join('\n');
    expect(text).toContain(
      `Missing (you add them): R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY. Add them with: ${h.ctx.source.command('install --resume --name acme')}`
    );
  });

  it('typed credentials go out with the deploy; the digest ignores them', async () => {
    const h = harness({ secrets: ['BETTER_AUTH_SECRET'] });
    const p = await planUpgrade(h.ctx, h.state);
    const asked: string[][] = [];
    const s = await run(h, {
      expectPlan: p.digest,
      async askOptional(missing): Promise<Optional> {
        asked.push(missing);
        return { r2: { id: 'kid', secret: 'ksecret' }, analytics: 'tok' };
      },
    });
    expect(asked).toEqual([['r2-keys', 'analytics-token']]);
    expect(h.deploys[0]!.secrets).toEqual({
      R2_ACCESS_KEY_ID: 'kid',
      R2_SECRET_ACCESS_KEY: 'ksecret',
      CF_ANALYTICS_TOKEN: 'tok',
    });
    expect(s.skipped).toEqual([]);
    expect(h.printed.join('\n')).not.toContain('Add them with');
    expect(JSON.stringify(s)).not.toContain('ksecret');
  });

  it('rejected R2 keys are skipped, not a stop', async () => {
    const h = harness({
      secrets: ['BETTER_AUTH_SECRET', 'CF_ANALYTICS_TOKEN'],
      r2Check: 403,
    });
    const s = await run(h, {
      askOptional: async () => ({ r2: { id: 'kid', secret: 'bad' } }),
    });
    expect(s.status).toBe('installed');
    expect(h.deploys).toHaveLength(1);
    expect(h.deploys[0]!.args).not.toContain('--secrets-file');
    expect(s.skipped).toEqual(['r2-keys']);
    expect(h.printed.join('\n')).toContain(
      'R2 rejected these keys (HTTP 403).'
    );
  });

  it('nothing typed is asked for when the worker has every credential', async () => {
    const h = harness();
    let asked = false;
    await run(h, {
      askOptional: async () => {
        asked = true;
        return {};
      },
    });
    expect(asked).toBe(false);
  });

  it('resume after failed deploy skips migrations', async () => {
    const h = harness();
    h.failDeploys();
    const e = await run(h).catch((x: Error) => x);
    expect((e as Error).message).toContain(
      'Run: npx gitorange@1.3.0 upgrade --resume --name acme'
    );
    const failed = h.saved();
    expect(failed.status).toBe('failed');
    expect(failed.upgradeTarget).toBe(TO);
    expect(failed.steps.map((x) => x.key)).toContain(
      `upgrade:${TO}:migrations`
    );
    expect(h.migrations).toHaveLength(1);

    h.okDeploys();
    const deploysBefore = h.deploys.length;
    const s = await run(h, { resume: true });
    expect(h.migrations).toHaveLength(1);
    expect(h.deploys.length - deploysBefore).toBe(1);
    expect(s.status).toBe('installed');
    expect(s.deployedVersion).toBe(TO);
    expect(s.upgradeTarget).toBeUndefined();
  });

  it('resume with /.well-known unreachable continues', async () => {
    const h = harness();
    h.failDeploys();
    await run(h).catch(() => {});
    expect(h.saved().status).toBe('failed');
    h.okDeploys();
    h.siteDown();
    const s = await run(h, { resume: true });
    expect(s.status).toBe('installed');
    expect(s.deployedVersion).toBe(TO);
  });

  it('a fresh upgrade with /.well-known unreachable stops', async () => {
    const h = harness();
    h.siteDown();
    await expect(run(h)).rejects.toThrow('Could not read');
    expect(h.nonDocker()).toHaveLength(0);
  });

  it('resumes a killed run (status upgrading)', async () => {
    const base = installedAt120();
    const h = harness({
      state: {
        ...base,
        status: 'upgrading',
        upgradeTarget: TO,
        resources: [
          ...base.resources,
          res('actionsCache', 'r2', 'acme-actions-cache'),
        ],
        steps: [
          ...base.steps,
          {
            key: 'provision-intent:actionsCache',
            at: '2026-10-17T00:00:00.000Z',
          },
          { key: 'lifecycle:v1', at: '2026-10-17T00:00:00.000Z' },
          { key: `upgrade:${TO}:resources`, at: '2026-10-17T00:00:00.000Z' },
          { key: `upgrade:${TO}:migrations`, at: '2026-10-17T00:00:00.000Z' },
        ],
      },
      seed: {
        ...seedFor(base),
        r2: {
          ...seedFor(base).r2,
          'acme-actions-cache': {
            [R2_MARKER_KEY]: marker(base, 'actionsCache'),
          },
        },
      },
    });
    const s = await run(h, { resume: true });
    expect(h.migrations).toHaveLength(0);
    expect(h.deploys).toHaveLength(1);
    expect(s.status).toBe('installed');
    expect(s.deployedVersion).toBe(TO);
  });

  it('a failed verify names only the upgrade resume command', async () => {
    const h = harness({ setupOpen: true });
    const e = await run(h).catch((x: Error) => x);
    const m = (e as Error).message;
    expect(m).toContain('anyone could claim this instance');
    expect(m).toContain('npx gitorange@1.3.0 upgrade --resume --name acme');
    expect(m).not.toContain('install --resume');
  });

  it('an unfinished upgrade to another version stops', async () => {
    const h = harness({
      state: { ...installedAt120(), status: 'failed', upgradeTarget: '1.2.5' },
    });
    await expect(run(h, { resume: true })).rejects.toThrow(
      'An upgrade to 1.2.5 is unfinished; run npx gitorange@1.2.5 upgrade --resume'
    );
    expect(h.deploys).toHaveLength(0);
  });

  it('expect-plan mismatch stops', async () => {
    const h = harness();
    await expect(run(h, { expectPlan: '000000000000' })).rejects.toThrow(
      'The plan changed since it was reviewed'
    );
    expect(h.deploys).toHaveLength(0);
    expect(h.migrations).toHaveLength(0);
    expect(h.saved().status).toBe('installed');
  });

  it('expect-plan match applies', async () => {
    const h = harness();
    const p = await planUpgrade(h.ctx, h.state);
    const s = await run(h, { expectPlan: p.digest });
    expect(s.status).toBe('installed');
  });

  it('declined confirmation changes nothing', async () => {
    const h = harness({ tty: true, confirm: false });
    await expect(run(h, { yes: false })).rejects.toThrow('Nothing was changed');
    expect(h.deploys).toHaveLength(0);
    expect(h.saved().status).toBe('installed');
  });

  it('same version redeploys', async () => {
    const first = harness();
    const s = await run(first);
    const again = harness({
      running: TO,
      state: s,
      secrets: ALL_SECRETS,
      seed: {
        ...seedFor(s),
        d1Migrations: { 'd1-existing': ['0000_init.sql', '0001_more.sql'] },
        r2: {
          ...seedFor(s).r2,
          'acme-actions-cache': { [R2_MARKER_KEY]: marker(s, 'actionsCache') },
        },
      },
    });
    const s2 = await run(again);
    expect(again.deploys).toHaveLength(1);
    expect(again.deploys[0]!.args).not.toContain('--secrets-file');
    expect(again.printed.join('\n')).toContain('Migrations: none');
    expect(again.printed.join('\n')).toContain('Create: none');
    expect(s2.status).toBe('installed');
    expect(s2.deployedVersion).toBe(TO);
  });

  it('a second upgrade to the same version regenerates the config and collects what is missing', async () => {
    const first = harness();
    const s = await run(first);
    expect(s.steps.some((x) => x.key === `upgrade:${TO}:deploy`)).toBe(true);
    // Since then: the config file differs and the worker lost its auth secret and analytics token.
    writeFileSync(
      join(home, 'wrangler.jsonc'),
      readFileSync(join(home, 'wrangler.jsonc'), 'utf8').replace(
        '"LIVE_NAMESPACE_ID": "ns-live"',
        '"LIVE_NAMESPACE_ID": "stale"'
      )
    );
    const again = harness({
      running: TO,
      state: { ...s, deployedConfigHash: 'stale' },
      secrets: ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'SETUP_CODE_HASH'],
      seed: {
        ...seedFor(s),
        d1Migrations: { 'd1-existing': ['0000_init.sql', '0001_more.sql'] },
        r2: {
          ...seedFor(s).r2,
          'acme-actions-cache': { [R2_MARKER_KEY]: marker(s, 'actionsCache') },
        },
      },
    });
    const asked: string[][] = [];
    const s2 = await run(again, {
      askOptional: async (missing) => {
        asked.push(missing);
        return { analytics: 'tok' };
      },
    });
    expect(again.printed.join('\n')).toContain('Config: changes');
    expect(asked).toEqual([['analytics-token']]);
    expect(again.deploys).toHaveLength(1);
    expect(Object.keys(again.deploys[0]!.secrets ?? {}).sort()).toEqual([
      'BETTER_AUTH_SECRET',
      'CF_ANALYTICS_TOKEN',
    ]);
    expect(readFileSync(join(home, 'wrangler.jsonc'), 'utf8')).toContain(
      '"LIVE_NAMESPACE_ID": "ns-live"'
    );
    expect(s2.deployedConfigHash).toBe(renderConfig(again.ctx, s2, TO).hash);
  });

  it.each([
    ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'],
    ['R2_SECRET_ACCESS_KEY', 'R2_ACCESS_KEY_ID'],
  ])(
    'a lone %s is reported, never paired with a typed half',
    async (present, absent) => {
      const h = harness({
        secrets: ['BETTER_AUTH_SECRET', 'CF_ANALYTICS_TOKEN', present],
      });
      const p = await planUpgrade(h.ctx, h.state);
      const fix = `Delete it (${h.ctx.source.wranglerCommand(`secret delete ${present} --name acme`)}), then run the upgrade again to add a matching pair.`;
      const lines = formatUpgradePlan(p).split('\n');
      expect(lines).toContain(
        `Problem: the worker has ${present} without ${absent}, so the R2 upload keys are left as they are. ${fix}`
      );
      expect(lines.some((l) => l.startsWith('Missing'))).toBe(false);
      let asked = false;
      const s = await run(h, {
        askOptional: async () => {
          asked = true;
          return { r2: { id: 'kid', secret: 'ksecret' } };
        },
      });
      expect(asked).toBe(false);
      expect(h.deploys).toHaveLength(1);
      expect(h.deploys[0]!.args).not.toContain('--secrets-file');
      expect(s.status).toBe('installed');
      expect(h.printed.at(-1)).toContain(`Problem: the worker has ${present}`);
    }
  );

  it('a corrupt state file fails without leaking the lock', async () => {
    const h = harness();
    const state = h.saved();
    writeFileSync(join(home, `${ID}.json`), '{ not json');
    await expect(
      upgrade(h.ctx, {
        state,
        yes: true,
        replaceCustomCode: false,
        resume: false,
      })
    ).rejects.toThrow();
    expect(existsSync(join(home, `${ID}.lock`))).toBe(false);
  });

  it('--plan writes nothing and prints the apply command', async () => {
    const h = harness();
    const before = readFileSync(join(home, `${ID}.json`), 'utf8');
    await run(h, { plan: true });
    expect(readFileSync(join(home, `${ID}.json`), 'utf8')).toBe(before);
    expect(existsSync(join(home, `${ID}.lock`))).toBe(false);
    expect(existsSync(join(home, 'wrangler.jsonc'))).toBe(false);
    expect(h.deploys).toHaveLength(0);
    const p = await planUpgrade(h.ctx, h.state);
    expect(h.printed.join('\n')).toContain(
      `npx gitorange@${TO} upgrade --name acme --expect-plan ${p.digest} --yes`
    );
  });
});

describe('a database ahead of the package', () => {
  const ahead = (extra: string[]) => {
    const s = installedAt120();
    const seed = seedFor(s);
    return harness({
      running: 'deadbeef1234-dirty',
      seed: {
        ...seed,
        d1Migrations: {
          'd1-existing': ['0000_init.sql', '0001_more.sql', ...extra],
        },
      },
    });
  };

  it('stops before planning, even with --replace-custom-code', async () => {
    const h = ahead(['0002_future.sql', '0003_later.sql']);
    const before = readFileSync(join(home, `${ID}.json`), 'utf8');
    const msg =
      'The database has migrations this release does not ship (0002_future.sql, 0003_later.sql): it is ahead of 1.3.0. Upgrade to a newer release instead. Nothing was changed.';
    await expect(planUpgrade(h.ctx, h.state)).rejects.toThrow(msg);
    await expect(run(h, { replaceCustomCode: true })).rejects.toThrow(msg);
    await expect(
      run(h, { replaceCustomCode: true, plan: true })
    ).rejects.toThrow(msg);
    expect(h.deploys).toHaveLength(0);
    expect(h.migrations).toHaveLength(0);
    expect(readFileSync(join(home, `${ID}.json`), 'utf8')).toBe(before);
    expect(existsSync(join(home, 'wrangler.jsonc'))).toBe(false);
    expect(existsSync(join(home, `${ID}.lock`))).toBe(false);
  });

  it('a database exactly at the package has nothing pending', async () => {
    const h = ahead([]);
    const p = await planUpgrade(h.ctx, h.state);
    expect(p.migrations).toEqual([]);
    const s = await run(h, { replaceCustomCode: true });
    expect(s.status).toBe('installed');
  });
});

describe('var drift since adopt or the last upgrade', () => {
  const adopted = (): InstallState => ({
    ...installedAt120(),
    adoptedAt: '2026-10-16T00:00:00.000Z',
  });
  const withVars = (
    s: InstallState,
    vars: Record<string, string>
  ): FakeCloudflareSeed => {
    const seed = seedFor(s);
    return {
      ...seed,
      workerVars: { acme: { ...seed.workerVars!.acme!, ...vars } },
    };
  };

  it('a var edited on the dashboard after adopt stops the first upgrade', async () => {
    const s = adopted();
    const h = harness({
      state: s,
      seed: withVars(s, { REVIEW_MODEL: '@cf/edited/model' }),
    });
    const before = readFileSync(join(home, `${ID}.json`), 'utf8');
    const e = await run(h).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe(
      [
        'Worker acme has vars the upgrade would drop or change:',
        '  REVIEW_MODEL  "@cf/edited/model" -> "@cf/zai-org/glm-5.3"',
        'Change or remove them on the worker, then run the upgrade again. Nothing was changed.',
      ].join('\n')
    );
    await expect(planUpgrade(h.ctx, h.state)).rejects.toThrow(
      'REVIEW_MODEL  "@cf/edited/model"'
    );
    expect(h.deploys).toHaveLength(0);
    expect(readFileSync(join(home, `${ID}.json`), 'utf8')).toBe(before);
  });

  it('a kept var is not a stop; editing it later is', async () => {
    const base = adopted();
    const s = {
      ...base,
      inputs: { ...base.inputs, vars: { AI_GATEWAY: 'mine' } },
    };
    const h = harness({ state: s, seed: withVars(s, { AI_GATEWAY: 'mine' }) });
    const done = await run(h);
    expect(done.status).toBe('installed');
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });

    // A later upgrade: the kept value edited on the dashboard stops it.
    const s2 = { ...s, upgradedAt: '2026-10-17T00:00:00.000Z' };
    const later = harness({
      state: s2,
      seed: withVars(s2, { AI_GATEWAY: 'other' }),
    });
    await expect(run(later)).rejects.toThrow('  AI_GATEWAY  "other" -> "mine"');
  });

  it('a later upgrade follows a new template default for a var the install never kept', async () => {
    const s = installedAt120();
    const h = harness({
      state: s,
      seed: withVars(s, { REVIEW_MODEL: '@cf/old/default' }),
    });
    expect((await run(h)).status).toBe('installed');
  });

  it('localhost-only TRUSTED_ORIGINS is listed as a drop, inside the digest', async () => {
    const s = adopted();
    const plain = harness({ state: s });
    const without = await planUpgrade(plain.ctx, plain.state);
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });

    const h = harness({
      state: s,
      seed: withVars(s, { TRUSTED_ORIGINS: 'http://localhost:8080' }),
    });
    const p = await planUpgrade(h.ctx, h.state);
    const lines = formatUpgradePlan(p).split('\n');
    expect(lines).toContain(
      'Drops these vars (the worker does not need them):'
    );
    expect(lines).toContain(
      '  TRUSTED_ORIGINS  "http://localhost:8080" -> removed (drops local development origins)'
    );
    expect(p.digest).not.toBe(without.digest);
    expect((await run(h)).status).toBe('installed');
  });
});

describe('an adopted Artifacts namespace the API cannot list', () => {
  it('plans with the namespace bound, not verified', async () => {
    const s = { ...installedAt120(), adoptedAt: '2026-10-16T00:00:00.000Z' };
    const h = harness({ state: s });
    h.cf.failNext('listArtifactsNamespaces', new Error('403 Forbidden'));
    const p = await planUpgrade(h.ctx, h.state);
    expect(formatUpgradePlan(p).split('\n')).toContain(
      'artifacts acme: bound, not verified'
    );
  });

  it('an install that was never adopted still stops', async () => {
    const h = harness();
    h.cf.failNext('listArtifactsNamespaces', new Error('403 Forbidden'));
    await expect(planUpgrade(h.ctx, h.state)).rejects.toThrow('403 Forbidden');
  });
});
