import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../apply.ts';
import { renderConfig } from '../apply-steps.ts';
import {
  applyCommand,
  isEntry,
  main,
  resolveToken,
  type Deps,
} from '../cli.ts';
import type { Io } from '../collect.ts';
import { installationIdOf, resourceNames } from '../names.ts';
import { R2_MARKER_KEY } from '../observe.ts';
import type { RunResult } from '../runner.ts';
import { checkoutSource, packageSource } from '../source.ts';
import {
  listStates,
  newState,
  readState,
  writeState,
  type InstallState,
} from '../state.ts';
import {
  fakeCloudflare,
  fakePackage,
  fakeRunner,
  type FakeCloudflare,
  type FakeCloudflareSeed,
} from './fakes.ts';

const ACCOUNT = 'a'.repeat(32);
const VERSION = 'abcdef123456';
const ID = installationIdOf(ACCOUNT, 'acme', 'workers.dev');
const BASE = 'https://acme.me.workers.dev';
const FLAGS = [
  '--name',
  'acme',
  '--account',
  ACCOUNT,
  '--workers-dev',
  '--no-email',
];
const DO_NAMESPACES = [
  { id: 'ns-job', script: 'acme', class: 'JobRunner' },
  { id: 'ns-merge', script: 'acme', class: 'MergeResolver' },
  { id: 'ns-review', script: 'acme', class: 'AgentReviewer' },
  { id: 'ns-live', script: 'acme', class: 'LiveHub' },
];

let root: string;
let cwd: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gitorange-cli-'));
  cwd = join(root, 'repo');
  dir = join(cwd, '.gitorange');
  mkdirSync(join(cwd, 'migrations'), { recursive: true });
  copyFileSync(
    new URL('../../../wrangler.jsonc.example', import.meta.url),
    join(cwd, 'wrangler.jsonc.example')
  );
  writeFileSync(join(cwd, 'migrations', '0000_init.sql'), 'CREATE TABLE a;');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function harness(
  opts: {
    tty?: boolean;
    env?: Record<string, string>;
    seed?: FakeCloudflareSeed;
    prompts?: (string | null)[];
    wellKnown?: () => Response;
    /** The npm registry's dist-tags.latest; null = the registry answers 500. */
    latest?: string | null;
    analyticsOk?: boolean;
    confirm?: boolean;
    setupStatus?: { setupRequired: boolean; codeRequired: boolean };
    onCloudflare?: (cf: FakeCloudflare) => void;
    docker?: Record<string, () => RunResult | Promise<RunResult>>;
    /** What `wrangler secret list` answers (default: exit 1, no such worker). */
    secretList?: RunResult;
    /** What a deploy answers (default: success). */
    deployResult?: RunResult;
    /** Package mode: state and config go under this home. */
    pkg?: { home: string; source: ReturnType<typeof packageSource> };
  } = {}
) {
  let cf: FakeCloudflare | null = null;
  let tokenCalls = 0;
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const notFound: RunResult = { code: 1, stdout: '', stderr: 'not found' };
  /** Each deploy's secrets file (null: none). */
  const deploys: (Record<string, string> | null)[] = [];
  const deployed = (args: string[]): RunResult => {
    const i = args.indexOf('--secrets-file');
    deploys.push(
      i >= 0
        ? (JSON.parse(readFileSync(args[i + 1]!, 'utf8')) as Record<
            string,
            string
          >)
        : null
    );
    return opts.deployResult ?? ok();
  };
  const runner = fakeRunner({
    ...(opts.docker ?? { docker: () => ok('27.0.0\n') }),
    'git rev-parse': () => ok(`${VERSION}\n`),
    'git status': () => ok(''),
    [process.execPath]: (args) => {
      if (args[1] === 'deploy') return deployed(args);
      if (args[1] === 'd1') return ok();
      if (args[1] === 'secret') return opts.secretList ?? notFound;
      throw new Error(`unexpected wrangler ${args.join(' ')}`);
    },
    yarn: (args) => {
      if (args[1] === 'deploy') return deployed(args);
      if (args[1] === 'wrangler' && args[2] === 'secret')
        return opts.secretList ?? notFound;
      if (args[1] === 'wrangler' && args[2] === 'd1') return ok();
      throw new Error(`unexpected yarn ${args.join(' ')}`);
    },
  });
  const out: string[] = [];
  const prompts = [...(opts.prompts ?? [])];
  const asked: string[] = [];
  const confirms: string[] = [];
  const io: Io = {
    tty: opts.tty ?? false,
    async prompt(msg) {
      asked.push(msg);
      return prompts.shift() ?? null;
    },
    async select<T>(_m: string, options: { value: T }[]) {
      return options[0]!.value;
    },
    async confirm(_m: string, initial: boolean) {
      confirms.push(_m);
      return opts.confirm ?? initial;
    },
    print(t) {
      out.push(t);
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
    if (url === 'https://api.cloudflare.com/client/v4/graphql') {
      return Response.json(
        opts.analyticsOk === false
          ? { errors: [{ message: 'denied' }], data: null }
          : { data: { viewer: { accounts: [{ accountTag: ACCOUNT }] } } }
      );
    }
    if (url === `${BASE}/.well-known/gitorange`) {
      if (opts.wellKnown) return opts.wellKnown();
      return Response.json({ installationId: ID, version: VERSION });
    }
    if (url === 'https://registry.npmjs.org/gitorange') {
      if (opts.latest === undefined || opts.latest === null)
        return new Response('down', { status: 500 });
      return Response.json({ 'dist-tags': { latest: opts.latest } });
    }
    if (url === `${BASE}/api/setup/status`) {
      return Response.json(
        opts.setupStatus ?? { setupRequired: true, codeRequired: true }
      );
    }
    if (url.startsWith(`https://${ACCOUNT}.r2.cloudflarestorage.com/`)) {
      return new Response('', { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const deps: Deps = {
    io,
    env: opts.env ?? {},
    runner,
    dir: opts.pkg?.home ?? dir,
    source: opts.pkg?.source ?? checkoutSource(cwd),
    home: opts.pkg?.home ?? null,
    configDir: opts.pkg?.home ?? cwd,
    fetchImpl,
    sleep: async () => {},
    now: () => new Date('2026-10-17T00:00:00Z'),
    async token() {
      tokenCalls++;
      return 'tok';
    },
    cloudflare() {
      cf = fakeCloudflare({
        accounts: [{ id: ACCOUNT, name: 'Acme' }],
        subdomain: 'me',
        doNamespaces: DO_NAMESPACES,
        ...opts.seed,
      });
      opts.onCloudflare?.(cf);
      return cf;
    },
  };
  return {
    deps,
    deploys,
    out,
    asked,
    confirms,
    fetched,
    runner,
    text: () => out.join('\n'),
    cf: () => cf,
    tokenCalls: () => tokenCalls,
  };
}

function installedState(): InstallState {
  const s = newState({
    installationId: ID,
    accountId: ACCOUNT,
    inputs: { name: 'acme', hostname: null, workersDev: true, fromEmail: null },
    names: resourceNames('acme'),
    baseUrl: BASE,
  });
  return {
    ...s,
    status: 'installed',
    resources: [
      {
        key: 'd1',
        kind: 'd1',
        name: 'acme-db',
        id: 'd1-x',
        ownership: 'created',
        state: 'ready',
      },
    ],
    steps: [{ key: 'deploy:1', at: '2026-10-16T00:00:00.000Z' }],
    deployedVersion: VERSION,
  };
}

const MUTATING = [
  'createD1',
  'createR2',
  'putR2Lifecycle',
  'putR2Object',
  'queryD1',
];

describe('usage', () => {
  it('--help lists install and status, exit 0', async () => {
    const h = harness();
    expect(await main(['--help'], h.deps)).toBe(0);
    expect(h.text()).toContain('install');
    expect(h.text()).toContain('status');
    expect(h.text()).toContain('--expect-plan');
    expect(h.text()).toContain('--new-setup-code');
  });

  it('unknown command exits 2', async () => {
    const h = harness();
    expect(await main(['nope'], h.deps)).toBe(2);
  });
});

describe('install', () => {
  it('without a terminal and without --yes exits 2 before any read', async () => {
    const h = harness();
    expect(await main(['install', ...FLAGS], h.deps)).toBe(2);
    expect(h.text()).toContain(
      'Not running in a terminal: pass --yes to apply (or --plan to only review).'
    );
    expect(h.cf()).toBeNull();
    expect(h.tokenCalls()).toBe(0);
  });

  it('--hostname with --workers-dev is a usage error', async () => {
    const h = harness();
    const code = await main(
      ['install', '--plan', '--hostname', 'git.example.com', '--workers-dev'],
      h.deps
    );
    expect(code).toBe(2);
    expect(h.cf()).toBeNull();
  });

  it('--plan prints the plan and the apply command, writes nothing', async () => {
    const h = harness();
    expect(await main(['install', '--plan', ...FLAGS], h.deps)).toBe(0);
    const text = h.text();
    expect(text).toContain('create  d1');
    const digest = /Plan ([0-9a-f]{12})/.exec(text)?.[1];
    expect(digest).toBeDefined();
    expect(h.out.at(-1)).toBe(
      `yarn gitorange install --name acme --account ${ACCOUNT} --workers-dev --no-email --expect-plan ${digest} --yes`
    );
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(cwd, 'wrangler.jsonc'))).toBe(false);
    expect(h.cf()!.calls.filter((c) => MUTATING.includes(c.method))).toEqual(
      []
    );
  });

  it('--plan warns that a hand-written wrangler.jsonc blocks the apply', async () => {
    writeFileSync(join(cwd, 'wrangler.jsonc'), '{ "name": "mine" }\n');
    const h = harness();
    expect(await main(['install', '--plan', ...FLAGS], h.deps)).toBe(0);
    expect(h.text()).toContain(
      'wrangler.jsonc was written by hand: apply will refuse until you move it aside'
    );
    const clean = harness();
    rmSync(join(cwd, 'wrangler.jsonc'));
    await main(['install', '--plan', ...FLAGS], clean.deps);
    expect(clean.text()).not.toContain('written by hand');
  });

  it('the R2 token text matches the link (all buckets or just these three)', async () => {
    const h = harness({ tty: true, prompts: ['', ''] });
    await main(['install', '--yes', ...FLAGS], h.deps);
    expect(h.text()).toContain(
      'Create an R2 API token (Object Read & Write); it may cover all buckets or just acme-lfs, acme-actions-logs and acme-actions-cache:'
    );
  });

  it('uses the only account and the default name without flags', async () => {
    const h = harness();
    expect(
      await main(['install', '--plan', '--workers-dev', '--no-email'], h.deps)
    ).toBe(0);
    expect(h.out.at(-1)).toContain(
      `--name gitorange --account ${ACCOUNT} --workers-dev --no-email`
    );
  });

  it('preflight failure exits 1 with the fix text', async () => {
    const h = harness({ seed: { subdomain: null } });
    expect(await main(['install', '--plan', ...FLAGS], h.deps)).toBe(1);
    expect(h.text()).toContain('The account has no workers.dev subdomain yet.');
    expect(h.text()).toContain('Open Workers & Pages');
  });

  it('a PlanStop exits 1 with its message', async () => {
    const h = harness({ seed: { d1: [{ uuid: 'x', name: 'acme-db' }] } });
    expect(await main(['install', '--plan', ...FLAGS], h.deps)).toBe(1);
    expect(h.text()).toContain('already exists');
  });

  it('--resume with a different --hostname exits 1 naming hostname', async () => {
    const h = harness();
    const s = { ...installedState(), status: 'failed' as const };
    writeState(dir, s);
    const code = await main(
      [
        'install',
        '--resume',
        '--yes',
        '--name',
        'acme',
        '--hostname',
        'git.example.com',
      ],
      h.deps
    );
    expect(code).toBe(1);
    expect(h.text()).toContain(
      'These options differ from the recorded installation: hostname'
    );
  });

  it('an existing unfinished state without --resume exits 1 pointing to --resume', async () => {
    const h = harness();
    writeState(dir, { ...installedState(), status: 'failed' });
    expect(await main(['install', '--yes', ...FLAGS], h.deps)).toBe(1);
    expect(h.text()).toContain('--resume');
  });

  it('an installed state without --resume says so and changes nothing', async () => {
    const h = harness();
    writeState(dir, installedState());
    expect(await main(['install', '--yes', ...FLAGS], h.deps)).toBe(0);
    expect(h.text()).toContain('already installed');
    expect(h.cf()!.calls.filter((c) => MUTATING.includes(c.method))).toEqual(
      []
    );
  });

  it('--yes without a terminal installs and records skipped credentials', async () => {
    const h = harness();
    expect(await main(['install', '--yes', ...FLAGS], h.deps)).toBe(0);
    const s = readState(dir, ID)!;
    expect(s.status).toBe('installed');
    expect(s.skipped).toEqual(['r2-keys', 'analytics-token']);
    expect(h.text()).toContain(`GitOrange is installed at ${BASE}`);
  });

  it('--expect-plan with a stale digest fails without creating anything', async () => {
    const h = harness();
    const code = await main(
      ['install', '--yes', '--expect-plan', '000000000000', ...FLAGS],
      h.deps
    );
    expect(code).toBe(1);
    expect(h.text()).toContain('The plan changed');
    expect(h.cf()!.calls.filter((c) => c.method === 'createD1')).toEqual([]);
  });

  it('--yes --expect-plan <stale> stops before any credential prompt or create', async () => {
    const h = harness({ tty: true, prompts: ['x', 'y', 'z'] });
    const code = await main(
      ['install', '--yes', '--expect-plan', '000000000000', ...FLAGS],
      h.deps
    );
    expect(code).toBe(1);
    expect(h.asked).toEqual([]);
    expect(h.out.at(-1)).toMatch(/Plan [0-9a-f]{12}$/);
    expect(h.cf()!.calls.filter((c) => MUTATING.includes(c.method))).toEqual(
      []
    );
    expect(existsSync(dir)).toBe(false);
  });

  it('a plan that changes after it was shown stops the apply', async () => {
    const h = harness({
      onCloudflare(cf) {
        // The second observe (install's recomputation) sees our workflow appear: reuse, not create.
        const orig = cf.listWorkflows.bind(cf);
        let n = 0;
        cf.listWorkflows = async (a) => {
          const r = await orig(a);
          return ++n >= 2
            ? [...r, { name: 'acme-actions-run', scriptName: 'acme' }]
            : r;
        };
      },
    });
    expect(await main(['install', '--yes', ...FLAGS], h.deps)).toBe(1);
    expect(h.text()).toContain('The plan changed since it was reviewed');
    expect(h.cf()!.calls.filter((c) => c.method === 'createD1')).toEqual([]);
  });

  it('declining "Apply this plan?" exits 1 and writes nothing', async () => {
    const h = harness({ tty: true, confirm: false });
    expect(await main(['install', ...FLAGS], h.deps)).toBe(1);
    expect(h.confirms).toEqual(['Apply this plan?']);
    expect(h.text()).toContain('Nothing was changed.');
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(cwd, 'wrangler.jsonc'))).toBe(false);
    expect(h.cf()!.calls.filter((c) => MUTATING.includes(c.method))).toEqual(
      []
    );
  });

  it('--from-email with --no-email is a usage error', async () => {
    const h = harness();
    const code = await main(
      ['install', '--plan', '--from-email', 'a@example.com', '--no-email'],
      h.deps
    );
    expect(code).toBe(2);
    expect(h.cf()).toBeNull();
  });

  it('several accounts without a terminal need --account (exit 2)', async () => {
    const h = harness({
      seed: {
        accounts: [
          { id: ACCOUNT, name: 'Acme' },
          { id: 'b'.repeat(32), name: 'Other' },
        ],
      },
    });
    const code = await main(
      ['install', '--plan', '--name', 'acme', '--workers-dev', '--no-email'],
      h.deps
    );
    expect(code).toBe(2);
    expect(h.text()).toContain('--account is required');
  });

  it('--plan --resume prints a command with --resume and the digest', async () => {
    const h = harness({ seed: { d1: [{ uuid: 'd1-x', name: 'acme-db' }] } });
    writeState(dir, { ...installedState(), status: 'failed' });
    expect(
      await main(['install', '--plan', '--resume', '--name', 'acme'], h.deps)
    ).toBe(0);
    expect(h.out.at(-1)).toMatch(
      new RegExp(
        `^yarn gitorange install --resume --name acme --account ${ACCOUNT} --workers-dev --no-email --expect-plan [0-9a-f]{12} --yes$`
      )
    );
  });

  it('--plan --resume on an installed state prints no --expect-plan', async () => {
    const h = harness({ seed: { d1: [{ uuid: 'd1-x', name: 'acme-db' }] } });
    writeState(dir, installedState());
    expect(
      await main(['install', '--plan', '--resume', '--name', 'acme'], h.deps)
    ).toBe(0);
    expect(h.out.at(-1)).toBe(
      `yarn gitorange install --resume --name acme --account ${ACCOUNT} --workers-dev --no-email --yes`
    );
  });

  it('--resume on an installed state runs resumeInstalled: verify only', async () => {
    const h = harness({
      seed: { d1: [{ uuid: 'd1-x', name: 'acme-db' }] },
      setupStatus: { setupRequired: false, codeRequired: false },
    });
    const s = installedState();
    writeState(dir, s);
    expect(
      await main(['install', '--resume', '--yes', '--name', 'acme'], h.deps)
    ).toBe(0);
    expect(h.out.at(-1)).toBe('Nothing to do.');
    expect(h.confirms).toEqual([]);
    expect(
      h
        .cf()!
        .calls.filter((c) =>
          ['createD1', 'createR2', 'putR2Object', 'putR2Lifecycle'].includes(
            c.method
          )
        )
    ).toEqual([]);
    expect(h.runner.calls.some((c) => c.args[1] === 'deploy')).toBe(false);
    expect(h.fetched).toContain(`${BASE}/.well-known/gitorange`);
    expect(readState(dir, ID)!.status).toBe('installed');
  });

  it('--resume --new-setup-code on an installed state replaces the code', async () => {
    const deployed = (h: ReturnType<typeof harness>) =>
      h.runner.calls.filter((c) => c.args[1] === 'deploy').length;
    const without = harness({
      seed: { d1: [{ uuid: 'd1-x', name: 'acme-db' }] },
    });
    const s = installedState();
    // Deployed from this checkout, so the code can be replaced without an upgrade.
    writeState(dir, {
      ...s,
      deployedConfigHash: renderConfig(
        { source: checkoutSource(cwd), configDir: cwd } as Ctx,
        s,
        VERSION
      ).hash,
    });
    expect(
      await main(
        ['install', '--resume', '--yes', '--name', 'acme'],
        without.deps
      )
    ).toBe(0);
    expect(deployed(without)).toBe(0);
    expect(without.text()).toContain('--new-setup-code');

    const withFlag = harness({
      seed: { d1: [{ uuid: 'd1-x', name: 'acme-db' }] },
    });
    expect(
      await main(
        ['install', '--resume', '--yes', '--name', 'acme', '--new-setup-code'],
        withFlag.deps
      )
    ).toBe(0);
    expect(deployed(withFlag)).toBe(1);
    expect(withFlag.text()).toMatch(/Setup code: \S+/);
    expect(withFlag.confirms).toEqual([]);
  });

  it('--plan --resume --new-setup-code carries the flag into the apply command', async () => {
    const h = harness({ seed: { d1: [{ uuid: 'd1-x', name: 'acme-db' }] } });
    writeState(dir, installedState());
    expect(
      await main(
        ['install', '--plan', '--resume', '--name', 'acme', '--new-setup-code'],
        h.deps
      )
    ).toBe(0);
    expect(h.out.at(-1)).toBe(
      `yarn gitorange install --resume --name acme --account ${ACCOUNT} --workers-dev --no-email --new-setup-code --yes`
    );
  });

  it('a rejected analytics token from the env exits 1 without a terminal', async () => {
    const h = harness({
      env: { GITORANGE_CF_ANALYTICS_TOKEN: 'bad' },
      analyticsOk: false,
    });
    expect(await main(['install', '--yes', ...FLAGS], h.deps)).toBe(1);
    expect(h.text()).toContain("can't read Account Analytics");
    expect(h.cf()!.calls.filter((c) => c.method === 'createD1')).toEqual([]);
    expect(h.text()).not.toContain('bad');
  });

  it('in a terminal, offers the optional credentials and skips empty answers', async () => {
    const h = harness({ tty: true, prompts: ['', ''] });
    expect(await main(['install', ...FLAGS], h.deps)).toBe(0);
    expect(h.text()).toContain('acme-lfs');
    expect(h.text()).toContain('dash.cloudflare.com');
    expect(readState(dir, ID)!.skipped).toEqual(['r2-keys', 'analytics-token']);
  });
});

describe('status', () => {
  it('prints the recorded state and the well-known check, changing nothing', async () => {
    const h = harness();
    const s = installedState();
    writeState(dir, s);
    expect(await main(['status'], h.deps)).toBe(0);
    const text = h.text();
    expect(text).toContain('installed');
    expect(text).toContain(BASE);
    expect(text).toContain('acme-db');
    expect(h.fetched).toEqual([
      'https://registry.npmjs.org/gitorange',
      `${BASE}/.well-known/gitorange`,
    ]);
    expect(h.cf()).toBeNull();
    expect(h.runner.calls).toEqual([]);
    expect(listStates(dir)).toEqual([s]);
  });

  it('at the latest prints no upgrade hint', async () => {
    const h = harness({ latest: VERSION });
    writeState(dir, installedState());
    expect(await main(['status'], h.deps)).toBe(0);
    expect(h.text()).toMatch(new RegExp(`Latest\\s+${VERSION}\\n`));
    expect(h.text()).not.toContain('upgrade --name');
  });

  it('offline prints latest unknown and exits 0', async () => {
    const h = harness({ latest: null });
    writeState(dir, installedState());
    expect(await main(['status'], h.deps)).toBe(0);
    expect(h.text()).toMatch(/Latest\s+unknown/);
  });

  it('status --from in a checkout is a usage error', async () => {
    const h = harness();
    expect(await main(['status', '--from', '/x'], h.deps)).toBe(2);
  });

  it('a moved install shows where', async () => {
    const h = harness();
    writeState(dir, {
      ...installedState(),
      movedTo: '/home/me/.gitorange/acme',
    });
    await main(['status'], h.deps);
    expect(h.text()).toMatch(/Moved\s+\/home\/me\/\.gitorange\/acme/);
  });

  it('live line compares running and state', async () => {
    const h = harness({
      wellKnown: () => Response.json({ installationId: ID, version: 'zzz' }),
    });
    writeState(dir, installedState());
    expect(await main(['status'], h.deps)).toBe(1);
    expect(h.text()).toContain('version zzz');
    expect(h.text()).toContain(`version ${VERSION}`);
  });

  it('exits 1 when the well-known answer disagrees', async () => {
    const h = harness({
      wellKnown: () => Response.json({ installationId: ID, version: 'other' }),
    });
    writeState(dir, installedState());
    expect(await main(['status'], h.deps)).toBe(1);
    expect(h.text()).toContain('other');
  });

  it.each([
    ['null', 'null'],
    ['not JSON', '<html>hi</html>'],
  ])('exits 1 on a 2xx body that is %s', async (_label, body) => {
    const h = harness({ wellKnown: () => new Response(body, { status: 200 }) });
    writeState(dir, installedState());
    expect(await main(['status'], h.deps)).toBe(1);
    expect(h.text()).toContain(
      `Unexpected answer from ${BASE}/.well-known/gitorange`
    );
  });

  it('exits 1 when unreachable', async () => {
    const h = harness({
      wellKnown: () => {
        throw new Error('ECONNREFUSED');
      },
    });
    writeState(dir, installedState());
    expect(await main(['status'], h.deps)).toBe(1);
    expect(h.text()).toContain('ECONNREFUSED');
  });

  it('with no installation says so and exits 1', async () => {
    const h = harness();
    expect(await main(['status'], h.deps)).toBe(1);
    expect(h.text()).toContain('No installation found');
  });
});

const source = checkoutSource('/repo');

describe('resolveToken', () => {
  it('prefers CLOUDFLARE_API_TOKEN without running wrangler', async () => {
    const r = fakeRunner({});
    expect(
      await resolveToken({ CLOUDFLARE_API_TOKEN: 'env-tok' }, r, source)
    ).toBe('env-tok');
    expect(r.calls).toEqual([]);
  });
  it("uses the last token-shaped line of wrangler's output, without colour codes", async () => {
    const tok = 'AbC_def-123.456789012345';
    const r = fakeRunner({
      yarn: () => ({
        code: 0,
        stdout: `\u001b[33m▲ [WARNING] a newer wrangler is out\u001b[0m\n\u001b[1m${tok}\u001b[22m\n\n`,
        stderr: '',
      }),
    });
    expect(await resolveToken({}, r, source)).toBe(tok);
    expect(r.calls[0]!.args).toEqual(['-s', 'wrangler', 'auth', 'token']);
  });
  it("package mode runs its wrangler's auth token without --config", async () => {
    const pkgSource = packageSource(
      fakePackage(mkdtempSync(join(tmpdir(), 'tok-')), {
        version: '1.2.0',
        commit: 'abc123def456',
      })
    );
    const tok = 'AbC_def-123.456789012345';
    const r = fakeRunner({
      [process.execPath]: () => ({ code: 0, stdout: `${tok}\n`, stderr: '' }),
    });
    expect(await resolveToken({}, r, pkgSource)).toBe(tok);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.cmd).toBe(process.execPath);
    expect(r.calls[0]!.args.slice(1)).toEqual(['auth', 'token']);
    expect(r.calls[0]!.args).not.toContain('--config');
  });
  it('package mode without a login prints its pinned login command', async () => {
    const pkgSource = packageSource(
      fakePackage(mkdtempSync(join(tmpdir(), 'tok-')), {
        version: '1.2.0',
        commit: 'abc123def456',
      })
    );
    const r = fakeRunner({
      [process.execPath]: () => ({ code: 1, stdout: '', stderr: 'x' }),
    });
    await expect(resolveToken({}, r, pkgSource)).rejects.toThrow(
      'Run npx wrangler@4.127.0 login first.'
    );
  });
  it('with no token-shaped line says to run wrangler login', async () => {
    const r = fakeRunner({
      yarn: () => ({
        code: 0,
        stdout: 'You are not logged in.\nshort\n',
        stderr: '',
      }),
    });
    await expect(resolveToken({}, r, source)).rejects.toThrow(
      'Run yarn wrangler login first.'
    );
  });

  it('without a login says to run wrangler login', async () => {
    const r = fakeRunner({
      yarn: () => ({ code: 1, stdout: '', stderr: 'Not logged in' }),
    });
    await expect(resolveToken({}, r, source)).rejects.toThrow(
      'Run yarn wrangler login first.'
    );
  });
});

describe('applyCommand', () => {
  it('single-quotes values outside the safe set', () => {
    const s = {
      ...installedState(),
      inputs: {
        name: 'acme',
        hostname: null,
        workersDev: true,
        fromEmail: "o'brien+git@example.com",
      },
    };
    expect(applyCommand(s, false, 'abc', false, source)).toBe(
      `yarn gitorange install --name acme --account ${ACCOUNT} --workers-dev --from-email 'o'\\''brien+git@example.com' --expect-plan abc --yes`
    );
  });
});

describe('isEntry', () => {
  const url = 'file:///repo/scripts/gitorange/cli.ts';
  it('uses import.meta.main when the runtime has it', () => {
    expect(isEntry(true, undefined, url)).toBe(true);
    expect(isEntry(false, '/repo/scripts/gitorange/cli.ts', url)).toBe(false);
  });
  it('falls back to comparing argv[1] on Node without import.meta.main', () => {
    expect(isEntry(undefined, '/repo/scripts/gitorange/cli.ts', url)).toBe(
      true
    );
    expect(isEntry(undefined, '/repo/other.ts', url)).toBe(false);
    expect(isEntry(undefined, undefined, url)).toBe(false);
  });
});

describe('package mode', () => {
  const pkg = () => {
    const home = join(root, 'home');
    const pkgRoot = fakePackage(mkdtempSync(join(tmpdir(), 'pkg-')), {
      version: '1.2.0',
      commit: 'abc123def456',
    });
    copyFileSync(
      join(cwd, 'wrangler.jsonc.example'),
      join(pkgRoot, 'wrangler.jsonc.example')
    );
    mkdirSync(join(pkgRoot, 'migrations'), { recursive: true });
    writeFileSync(
      join(pkgRoot, 'migrations', '0000_init.sql'),
      'CREATE TABLE a;'
    );
    const source = packageSource(pkgRoot);
    return { home, source };
  };
  const names = (p: string) =>
    existsSync(p) ? readdirSync(p).sort() : ([] as string[]);

  it('install writes under home/<slug>, privately, and nothing in the cwd', async () => {
    const pkgOpts = pkg();
    const h = harness({
      pkg: pkgOpts,
      wellKnown: () => Response.json({ installationId: ID, version: '1.2.0' }),
    });
    const code = await main(['install', '--yes', ...FLAGS], h.deps);
    expect(code).toBe(0);
    const idir = join(pkgOpts.home, 'acme');
    expect(names(idir).some((f) => f.endsWith('.json'))).toBe(true);
    expect(names(idir)).toContain('wrangler.jsonc');
    expect(statSync(idir).mode & 0o777).toBe(0o700);
    expect(statSync(join(idir, 'wrangler.jsonc')).mode & 0o777).toBe(0o600);
    for (const f of names(idir).filter((f) => f.endsWith('.json')))
      expect(statSync(join(idir, f)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(cwd, 'wrangler.jsonc'))).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it('a hand-written config hint names the full path', async () => {
    const pkgOpts = pkg();
    mkdirSync(join(pkgOpts.home, 'acme'), { recursive: true });
    writeFileSync(join(pkgOpts.home, 'acme', 'wrangler.jsonc'), '{}\n');
    const h = harness({ pkg: pkgOpts });
    expect(await main(['install', '--plan', ...FLAGS], h.deps)).toBe(0);
    const c = join(pkgOpts.home, 'acme', 'wrangler.jsonc');
    expect(h.text()).toContain(`\`mv ${c} ${c}.hand\``);
  });

  it('status prints latest, and the npx upgrade command when running is older', async () => {
    const pkgOpts = pkg();
    writeState(join(pkgOpts.home, 'acme'), {
      ...installedState(),
      deployedVersion: '1.0.0',
    });
    const h = harness({
      pkg: pkgOpts,
      latest: '9.9.9',
      wellKnown: () => Response.json({ installationId: ID, version: '1.0.0' }),
    });
    expect(await main(['status'], h.deps)).toBe(0);
    expect(h.text()).toMatch(/Latest\s+9\.9\.9/);
    expect(h.text()).toContain('(npx gitorange@9.9.9 upgrade --name acme)');
  });

  it('status --from reads a checkout, read-only, and hints adopt then upgrade', async () => {
    const checkout = join(root, 'checkout');
    const cdir = join(checkout, '.gitorange');
    writeState(cdir, { ...installedState(), deployedVersion: '1.0.0' });
    const pkgOpts = pkg();
    const h = harness({
      pkg: pkgOpts,
      latest: '9.9.9',
      wellKnown: () => Response.json({ installationId: ID, version: '1.0.0' }),
    });
    expect(await main(['status', '--from', checkout], h.deps)).toBe(0);
    expect(h.text()).toContain('acme-db');
    expect(h.text()).toContain(
      `(npx gitorange@9.9.9 adopt --from ${checkout} --name acme, then npx gitorange@9.9.9 upgrade --name acme)`
    );
    expect(listStates(cdir)).toHaveLength(1);
    expect(existsSync(join(pkgOpts.home, 'acme'))).toBe(false);
  });

  it('status reads the only install under home', async () => {
    const pkgOpts = pkg();
    writeState(join(pkgOpts.home, 'acme'), installedState());
    const h = harness({ pkg: pkgOpts });
    expect(await main(['status'], h.deps)).toBe(0);
    expect(h.text()).toContain('acme');
  });

  it('status with several installs asks for --name', async () => {
    const pkgOpts = pkg();
    writeState(join(pkgOpts.home, 'acme'), installedState());
    writeState(join(pkgOpts.home, 'beta'), installedState());
    const h = harness({ pkg: pkgOpts });
    expect(await main(['status'], h.deps)).toBe(2);
    expect(h.text()).toContain('Several installs: acme, beta. Pass --name.');
  });
});

describe('docker', () => {
  const NOT_INSTALLED =
    'Docker is not installed. GitOrange runs Actions jobs in containers, and deploying builds the runner image with Docker. Install Docker Desktop (https://docs.docker.com/get-docker/), start it, then run the same command again.';
  const NOT_RUNNING =
    'Docker is installed but not running. Start Docker Desktop (or the Docker daemon), then run the same command again.';
  const ok = { code: 0, stdout: '27.0.0\n', stderr: '' };

  it('not installed: the exact message, nothing written, --plan prints no digest', async () => {
    const h = harness({
      docker: {
        docker: () => Promise.reject(new Error('spawn docker ENOENT')),
      },
    });
    expect(await main(['install', '--plan', ...FLAGS], h.deps)).toBe(1);
    expect(h.text()).toContain(NOT_INSTALLED);
    expect(h.text()).not.toContain('Plan ');
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(cwd, 'wrangler.jsonc'))).toBe(false);
    const apply = harness({
      docker: { docker: () => ({ code: 127, stdout: '', stderr: '' }) },
    });
    expect(await main(['install', '--yes', ...FLAGS], apply.deps)).toBe(1);
    expect(apply.text()).toContain(NOT_INSTALLED);
    expect(existsSync(dir)).toBe(false);
  });

  it('not running: the exact message, nothing written, --plan prints no digest', async () => {
    const h = harness({
      docker: {
        'docker --version': () => ok,
        'docker info': () => ({ code: 1, stdout: '', stderr: 'no daemon' }),
      },
    });
    expect(await main(['install', '--plan', ...FLAGS], h.deps)).toBe(1);
    expect(h.text()).toContain(NOT_RUNNING);
    expect(h.text()).not.toContain('Plan ');
    expect(h.text()).not.toContain('not installed');
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(cwd, 'wrangler.jsonc'))).toBe(false);
  });

  it('status never runs docker', async () => {
    writeState(dir, installedState());
    const h = harness();
    expect(await main(['status'], h.deps)).toBe(0);
    expect(h.runner.calls.filter((c) => c.cmd === 'docker')).toEqual([]);
  });
});

describe('upgrade', () => {
  const home = () => join(root, 'home');
  const idir = () => join(home(), 'acme');
  const seedInstall = (over: Partial<InstallState> = {}) => {
    const s = {
      ...installedState(),
      deployedVersion: '1.2.0',
      doNamespaceIds: {
        JOB_RUNNER_NAMESPACE_ID: 'ns-job',
        MERGE_RESOLVER_NAMESPACE_ID: 'ns-merge',
        AGENT_REVIEWER_NAMESPACE_ID: 'ns-review',
        LIVE_NAMESPACE_ID: 'ns-live',
      },
      ...over,
    };
    writeState(idir(), s);
    return s;
  };
  const seedFor = (s: InstallState): FakeCloudflareSeed => {
    const marker = (key: string) => ({
      [R2_MARKER_KEY]: JSON.stringify({
        installationId: s.installationId,
        ownershipNonce: s.ownershipNonce,
        key,
      }),
    });
    return {
      d1: [{ uuid: 'd1-x', name: 'acme-db' }],
      d1Migrations: { 'd1-x': ['0000_init.sql'] },
      r2: {
        'acme-lfs': marker('lfs'),
        'acme-actions-logs': marker('actionsLogs'),
        'acme-actions-cache': marker('actionsCache'),
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
    };
  };
  const secretList = (names: string[]): RunResult => ({
    code: 0,
    stdout: JSON.stringify(names.map((name) => ({ name }))),
    stderr: '',
  });
  const ALL = [
    'BETTER_AUTH_SECRET',
    'SETUP_CODE_HASH',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'CF_ANALYTICS_TOKEN',
  ];
  const pkg130 = () => {
    const pkgRoot = fakePackage(mkdtempSync(join(tmpdir(), 'pkg-')), {
      version: '1.3.0',
      commit: 'c'.repeat(40),
    });
    copyFileSync(
      join(cwd, 'wrangler.jsonc.example'),
      join(pkgRoot, 'wrangler.jsonc.example')
    );
    mkdirSync(join(pkgRoot, 'migrations'), { recursive: true });
    writeFileSync(
      join(pkgRoot, 'migrations', '0000_init.sql'),
      'CREATE TABLE a;'
    );
    writeFileSync(
      join(pkgRoot, 'migrations', '0001_more.sql'),
      'CREATE TABLE b;'
    );
    return { home: home(), source: packageSource(pkgRoot) };
  };
  /** An installed acme at 1.2.0 under home; the site reports 1.3.0 once a deploy succeeded. */
  const upgradeHarness = (
    o: {
      tty?: boolean;
      secrets?: string[];
      prompts?: (string | null)[];
      running?: () => string;
      deployResult?: RunResult;
      state?: Partial<InstallState>;
      /** Keep the state already under home (a second run). */
      keep?: boolean;
    } = {}
  ) => {
    const s = o.keep ? readState(idir(), ID)! : seedInstall(o.state);
    let deployedOk = false;
    const h = harness({
      pkg: pkg130(),
      tty: o.tty,
      prompts: o.prompts,
      secretList: secretList(o.secrets ?? ALL),
      deployResult: o.deployResult,
      seed: seedFor(s),
      setupStatus: { setupRequired: false, codeRequired: false },
      wellKnown: () => {
        deployedOk = h.deploys.length > 0 && o.deployResult?.code !== 1;
        return Response.json({
          installationId: ID,
          version: deployedOk ? '1.3.0' : (o.running?.() ?? '1.2.0'),
        });
      },
    });
    return h;
  };

  it('--help lists upgrade and its options', async () => {
    const h = harness();
    expect(await main(['--help'], h.deps)).toBe(0);
    expect(h.text()).toContain('upgrade');
    expect(h.text()).toContain('--replace-custom-code');
  });

  it('upgrade --plan prints the apply command and writes nothing', async () => {
    const h = upgradeHarness();
    const before = readFileSync(join(idir(), `${ID}.json`), 'utf8');
    expect(await main(['upgrade', '--plan'], h.deps)).toBe(0);
    const text = h.text();
    expect(text).toContain('Upgrade acme: 1.2.0 → 1.3.0');
    const digest = /Plan ([0-9a-f]{12})/.exec(text)?.[1];
    expect(digest).toBeDefined();
    expect(text).toContain(
      `npx gitorange@1.3.0 upgrade --name acme --expect-plan ${digest} --yes`
    );
    expect(h.deploys).toHaveLength(0);
    expect(readFileSync(join(idir(), `${ID}.json`), 'utf8')).toBe(before);
    expect(readdirSync(idir())).toEqual([`${ID}.json`]);
  });

  it('the printed apply command applies with no digest mismatch', async () => {
    const p = upgradeHarness();
    expect(await main(['upgrade', '--plan'], p.deps)).toBe(0);
    const cmd = p.out.at(-1)!;
    const h = upgradeHarness();
    expect(await main(cmd.split(' ').slice(2), h.deps)).toBe(0);
    expect(h.text()).not.toContain('The plan changed');
    expect(h.text()).toContain('Upgraded acme to 1.3.0');
    const s = readState(idir(), ID)!;
    expect(s.status).toBe('installed');
    expect(s.deployedVersion).toBe('1.3.0');
  });

  it('upgrade without tty needs --yes or --plan', async () => {
    const h = upgradeHarness();
    expect(await main(['upgrade'], h.deps)).toBe(2);
    expect(h.text()).toContain(
      'Not running in a terminal: pass --yes to apply (or --plan to only review).'
    );
    expect(h.tokenCalls()).toBe(0);
  });

  it('a failed deploy prints the upgrade resume command, which completes it', async () => {
    const first = upgradeHarness({
      deployResult: { code: 1, stdout: '', stderr: 'boom' },
    });
    expect(await main(['upgrade', '--yes', '--name', 'acme'], first.deps)).toBe(
      1
    );
    const printed = /Run: (npx gitorange@1\.3\.0 (.+))$/m.exec(first.text());
    expect(printed?.[1]).toBe(
      'npx gitorange@1.3.0 upgrade --resume --name acme'
    );
    const failed = readState(idir(), ID)!;
    expect(failed.status).toBe('failed');
    expect(failed.upgradeTarget).toBe('1.3.0');

    const again = upgradeHarness({ keep: true, tty: true });
    expect(await main(printed![2]!.split(' '), again.deps)).toBe(0);
    expect(again.confirms).toEqual(['Apply this upgrade?']);
    const s = readState(idir(), ID)!;
    expect(s.status).toBe('installed');
    expect(s.deployedVersion).toBe('1.3.0');
    expect(again.deploys).toHaveLength(1);
  });

  it('missing R2 keys do not block --yes, and say how to add them', async () => {
    const h = upgradeHarness({
      secrets: ['BETTER_AUTH_SECRET', 'SETUP_CODE_HASH', 'CF_ANALYTICS_TOKEN'],
    });
    expect(await main(['upgrade', '--yes'], h.deps)).toBe(0);
    expect(h.asked).toEqual([]);
    expect(h.deploys).toEqual([null]);
    const text = h.text();
    expect(text).toContain(
      'Missing (you add them): R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY\n'
    );
    expect(text).toContain(
      'Missing (you add them): R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY. Add them with: npx gitorange@1.3.0 install --resume --name acme'
    );
    expect(readState(idir(), ID)!.skipped).toEqual(['r2-keys']);
  });

  it('in a terminal, missing typed credentials are asked for (masked) and deployed', async () => {
    const h = upgradeHarness({
      tty: true,
      secrets: ['BETTER_AUTH_SECRET', 'SETUP_CODE_HASH'],
      prompts: ['kid', 'ksecret', 'tok'],
    });
    expect(await main(['upgrade'], h.deps)).toBe(0);
    expect(h.confirms).toEqual(['Apply this upgrade?']);
    expect(h.asked).toEqual([
      'R2 access key ID',
      'R2 secret access key',
      'Analytics API token',
    ]);
    expect(h.deploys).toEqual([
      {
        R2_ACCESS_KEY_ID: 'kid',
        R2_SECRET_ACCESS_KEY: 'ksecret',
        CF_ANALYTICS_TOKEN: 'tok',
      },
    ]);
    expect(h.text()).not.toContain('ksecret');
    expect(h.text()).not.toContain('Add them with');
    expect(readState(idir(), ID)!.skipped).toEqual([]);
  });

  it('in a terminal with --yes, nothing is asked', async () => {
    const h = upgradeHarness({
      tty: true,
      secrets: ['BETTER_AUTH_SECRET', 'SETUP_CODE_HASH'],
      prompts: ['kid', 'ksecret', 'tok'],
    });
    expect(await main(['upgrade', '--yes'], h.deps)).toBe(0);
    expect(h.asked).toEqual([]);
    expect(h.deploys).toEqual([null]);
    expect(readState(idir(), ID)!.skipped).toEqual([
      'r2-keys',
      'analytics-token',
    ]);
  });

  it('docker missing stops before planning', async () => {
    seedInstall();
    const h = harness({
      pkg: pkg130(),
      docker: {
        docker: () => Promise.reject(new Error('spawn docker ENOENT')),
      },
    });
    const before = readFileSync(join(idir(), `${ID}.json`), 'utf8');
    expect(await main(['upgrade', '--yes'], h.deps)).toBe(1);
    expect(h.text()).toContain('Docker is not installed.');
    expect(h.text()).not.toContain('Upgrade acme');
    expect(h.cf()!.calls).toEqual([]);
    expect(readFileSync(join(idir(), `${ID}.json`), 'utf8')).toBe(before);
    expect(readdirSync(idir())).toEqual([`${ID}.json`]);
  });

  it('checkout mode points at npx', async () => {
    const h = harness();
    expect(await main(['upgrade', '--yes'], h.deps)).toBe(2);
    expect(h.text()).toContain(
      `Upgrades run from npm: npx gitorange adopt --from ${cwd}, then npx gitorange upgrade.`
    );
    expect(h.tokenCalls()).toBe(0);
  });

  it.each([
    ['upgrading', {}],
    ['failed', { upgradeTarget: '1.3.0' }],
  ] as const)(
    'install --resume refuses an unfinished upgrade (%s)',
    async (status, extra) => {
      seedInstall({ status, upgradeTarget: '1.3.0', ...extra });
      const h = harness({ pkg: pkg130() });
      expect(
        await main(['install', '--resume', '--yes', '--name', 'acme'], h.deps)
      ).toBe(1);
      expect(h.text()).toContain(
        'An upgrade to 1.3.0 is unfinished; run npx gitorange@1.3.0 upgrade --resume --name acme.'
      );
      expect(h.deploys).toHaveLength(0);
    }
  );
});

describe('adopt', () => {
  const home = () => join(root, 'home');
  const MOVED = () => join(home(), resourceNames('acme').worker);
  const seedCheckout = (over: Partial<InstallState> = {}) => {
    const s = { ...installedState(), ...over };
    writeState(dir, s);
    writeFileSync(join(cwd, 'wrangler.jsonc'), '// generated\n{}\n');
    return s;
  };
  const MOVED_LINE = () =>
    `This install moved to ${MOVED()}. Run npx gitorange upgrade --name ${resourceNames('acme').worker}.`;
  const pkgHarness = (o: { tty?: boolean; confirm?: boolean } = {}) =>
    harness({
      ...o,
      pkg: {
        home: home(),
        source: packageSource(
          fakePackage(mkdtempSync(join(tmpdir(), 'pkg-')), {
            version: '1.2.0',
            commit: 'abc123def456',
          })
        ),
      },
    });

  it('moves the install, then the checkout refuses install and --resume', async () => {
    seedCheckout();
    const h = pkgHarness();
    expect(await main(['adopt', '--from', cwd, '--yes'], h.deps)).toBe(0);
    expect(h.text()).toContain(`Moved acme to ${MOVED()}`);
    expect(readState(MOVED(), ID)!.adoptedAt).toBe('2026-10-17T00:00:00.000Z');
    expect(readState(dir, ID)!.movedTo).toBe(MOVED());
    expect(h.tokenCalls()).toBe(0);

    const fresh = harness({});
    expect(await main(['install', ...FLAGS, '--yes'], fresh.deps)).toBe(1);
    expect(fresh.text()).toContain(MOVED_LINE());
    expect(fresh.deploys).toHaveLength(0);

    const resume = harness({});
    expect(
      await main(
        ['install', '--resume', '--name', 'acme', '--yes'],
        resume.deps
      )
    ).toBe(1);
    expect(resume.text()).toContain(MOVED_LINE());
    expect(resume.deploys).toHaveLength(0);
  });

  it('asks before moving, and a no changes nothing', async () => {
    seedCheckout();
    const h = pkgHarness({ tty: true, confirm: false });
    expect(await main(['adopt', '--from', cwd], h.deps)).toBe(1);
    expect(h.confirms).toEqual(['Move this install?']);
    expect(existsSync(MOVED())).toBe(false);
    expect(readState(dir, ID)!.movedTo).toBeUndefined();
  });

  it('without a terminal and --yes exits 2', async () => {
    seedCheckout();
    const h = pkgHarness();
    expect(await main(['adopt', '--from', cwd], h.deps)).toBe(2);
    expect(h.text()).toContain('Not running in a terminal');
    expect(existsSync(MOVED())).toBe(false);
  });

  it('needs --from', async () => {
    const h = pkgHarness();
    expect(await main(['adopt', '--yes'], h.deps)).toBe(2);
    expect(h.text()).toContain('adopt needs --from');
  });

  it('worker-only flags with --from are usage errors', async () => {
    const h = pkgHarness();
    expect(
      await main(['adopt', '--from', cwd, '--plan', '--yes'], h.deps)
    ).toBe(2);
    expect(h.text()).toContain('--plan is only for adopt --worker.');
  });

  it('checkout mode points at npx', async () => {
    seedCheckout();
    const h = harness({});
    expect(await main(['adopt', '--from', cwd, '--yes'], h.deps)).toBe(2);
    expect(h.text()).toContain(`npx gitorange adopt --from ${cwd}`);
    expect(readState(dir, ID)!.movedTo).toBeUndefined();
  });

  it('a taken destination exits 1 and leaves the checkout alone', async () => {
    const s = seedCheckout();
    writeState(MOVED(), s);
    const h = pkgHarness();
    expect(await main(['adopt', '--from', cwd, '--yes'], h.deps)).toBe(1);
    expect(h.text()).toContain(`${MOVED()} already has an install`);
    expect(readState(dir, ID)!.movedTo).toBeUndefined();
  });
});

describe('adopt --worker', () => {
  const home = () => join(root, 'home');
  const seed: FakeCloudflareSeed = {
    workers: {
      acme: [
        { type: 'd1', name: 'DB', id: 'd1-acme' },
        { type: 'plain_text', name: 'BASE_URL', text: BASE },
        { type: 'secret_text', name: 'BETTER_AUTH_SECRET' },
      ],
    },
    d1: [{ uuid: 'd1-acme', name: 'acme-db' }],
    doNamespaces: [],
  };
  const pkgHarness = (o: Parameters<typeof harness>[0] = {}) => {
    const pkgRoot = fakePackage(mkdtempSync(join(tmpdir(), 'pkg-')), {
      version: '1.2.0',
      commit: 'abc123def456',
    });
    copyFileSync(
      new URL('../../../wrangler.jsonc.example', import.meta.url),
      join(pkgRoot, 'wrangler.jsonc.example')
    );
    return harness({
      seed,
      wellKnown: () => new Response('', { status: 404 }),
      ...o,
      pkg: { home: home(), source: packageSource(pkgRoot) },
    });
  };

  it('--plan prints the report and the apply command, which applies; nothing deploys', async () => {
    const h = pkgHarness();
    expect(await main(['adopt', '--worker', 'acme', '--plan'], h.deps)).toBe(0);
    const text = h.text();
    expect(text).toContain('Adopt worker acme');
    const digest = /Plan ([0-9a-f]{12})/.exec(text)![1]!;
    const command = `npx gitorange@1.2.0 adopt --worker acme --account ${ACCOUNT} --expect-plan ${digest} --yes`;
    expect(text).toContain(command);
    expect(existsSync(home())).toBe(false);

    const apply = pkgHarness();
    expect(await main(command.split(' ').slice(2), apply.deps)).toBe(0);
    const s = listStates(join(home(), 'acme'))[0]!;
    expect(s.resources.every((r) => r.ownership === 'adopted')).toBe(true);
    expect(s.adoptedAt).toBe('2026-10-17T00:00:00.000Z');
    expect(apply.runner.calls).toHaveLength(0);
    expect(apply.deploys).toHaveLength(0);
  });

  it('--from and --worker together exit 2', async () => {
    const h = pkgHarness();
    expect(
      await main(['adopt', '--from', cwd, '--worker', 'acme', '--yes'], h.deps)
    ).toBe(2);
    expect(h.text()).toContain('Pass either --from or --worker, not both.');
  });

  it('without a terminal and --yes exits 2; checkout mode points at npx', async () => {
    const h = pkgHarness();
    expect(await main(['adopt', '--worker', 'acme'], h.deps)).toBe(2);
    expect(h.text()).toContain('Not running in a terminal');
    const c = harness({ seed });
    expect(await main(['adopt', '--worker', 'acme', '--yes'], c.deps)).toBe(2);
    expect(c.text()).toContain('npx gitorange adopt --worker acme');
    expect(c.tokenCalls()).toBe(0);
  });

  it('a wrong worker name exits 1 and writes nothing', async () => {
    const h = pkgHarness();
    expect(await main(['adopt', '--worker', 'nope', '--yes'], h.deps)).toBe(1);
    expect(h.text()).toContain(`No worker named nope on account ${ACCOUNT}`);
    expect(existsSync(home())).toBe(false);
  });

  it('--name with --worker and a bad worker name are usage errors', async () => {
    const h = pkgHarness();
    expect(
      await main(['adopt', '--worker', 'acme', '--name', 'x', '--yes'], h.deps)
    ).toBe(2);
    expect(h.text()).toContain(
      '--name is only for adopt --from; with --worker the install is named after the worker.'
    );
    const bad = pkgHarness();
    expect(await main(['adopt', '--worker', 'A_B', '--yes'], bad.deps)).toBe(2);
    expect(bad.text()).toContain('--worker A_B:');
  });
});
