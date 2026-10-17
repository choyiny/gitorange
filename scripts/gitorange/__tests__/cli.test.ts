import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, resolveToken, type Deps } from '../cli.ts';
import type { Io } from '../collect.ts';
import { installationIdOf, resourceNames } from '../names.ts';
import type { RunResult } from '../runner.ts';
import {
  listStates,
  newState,
  readState,
  writeState,
  type InstallState,
} from '../state.ts';
import {
  fakeCloudflare,
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
    analyticsOk?: boolean;
  } = {}
) {
  let cf: FakeCloudflare | null = null;
  let tokenCalls = 0;
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const runner = fakeRunner({
    docker: () => ok('27.0.0\n'),
    'git rev-parse': () => ok(`${VERSION}\n`),
    'git status': () => ok(''),
    yarn: (args) => {
      if (args[1] === 'deploy') return ok();
      if (args[1] === 'wrangler' && args[2] === 'secret')
        return { code: 1, stdout: '', stderr: 'not found' };
      if (args[1] === 'wrangler' && args[2] === 'd1') return ok();
      throw new Error(`unexpected yarn ${args.join(' ')}`);
    },
  });
  const out: string[] = [];
  const prompts = [...(opts.prompts ?? [])];
  const asked: string[] = [];
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
      return initial;
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
    if (url === `${BASE}/api/setup/status`) {
      return Response.json({ setupRequired: true, codeRequired: true });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const deps: Deps = {
    io,
    env: opts.env ?? {},
    runner,
    dir,
    cwd,
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
      return cf;
    },
  };
  return {
    deps,
    out,
    asked,
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
    expect(h.fetched).toEqual([`${BASE}/.well-known/gitorange`]);
    expect(h.cf()).toBeNull();
    expect(h.runner.calls).toEqual([]);
    expect(listStates(dir)).toEqual([s]);
  });

  it('exits 1 when the well-known answer disagrees', async () => {
    const h = harness({
      wellKnown: () => Response.json({ installationId: ID, version: 'other' }),
    });
    writeState(dir, installedState());
    expect(await main(['status'], h.deps)).toBe(1);
    expect(h.text()).toContain('other');
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

describe('resolveToken', () => {
  it('prefers CLOUDFLARE_API_TOKEN without running wrangler', async () => {
    const r = fakeRunner({});
    expect(await resolveToken({ CLOUDFLARE_API_TOKEN: 'env-tok' }, r)).toBe(
      'env-tok'
    );
    expect(r.calls).toEqual([]);
  });
  it("uses the last line of wrangler's auth token", async () => {
    const r = fakeRunner({
      yarn: () => ({ code: 0, stdout: 'banner\nwr-tok\n', stderr: '' }),
    });
    expect(await resolveToken({}, r)).toBe('wr-tok');
    expect(r.calls[0]!.args).toEqual(['-s', 'wrangler', 'auth', 'token']);
  });
  it('without a login says to run wrangler login', async () => {
    const r = fakeRunner({
      yarn: () => ({ code: 1, stdout: '', stderr: 'Not logged in' }),
    });
    await expect(resolveToken({}, r)).rejects.toThrow(
      'Run yarn wrangler login first.'
    );
  });
});
