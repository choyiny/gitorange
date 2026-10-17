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
import type { Ctx } from '../apply.ts';
import { renderConfig } from '../apply-steps.ts';
import { applyCommand, main, resolveToken, type Deps } from '../cli.ts';
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
    confirm?: boolean;
    setupStatus?: { setupRequired: boolean; codeRequired: boolean };
    onCloudflare?: (cf: FakeCloudflare) => void;
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
    if (url === `${BASE}/api/setup/status`) {
      return Response.json(
        opts.setupStatus ?? { setupRequired: true, codeRequired: true }
      );
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
      opts.onCloudflare?.(cf);
      return cf;
    },
  };
  return {
    deps,
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
      deployedConfigHash: renderConfig({ cwd } as Ctx, s, VERSION).hash,
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

describe('resolveToken', () => {
  it('prefers CLOUDFLARE_API_TOKEN without running wrangler', async () => {
    const r = fakeRunner({});
    expect(await resolveToken({ CLOUDFLARE_API_TOKEN: 'env-tok' }, r)).toBe(
      'env-tok'
    );
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
    expect(await resolveToken({}, r)).toBe(tok);
    expect(r.calls[0]!.args).toEqual(['-s', 'wrangler', 'auth', 'token']);
  });
  it('with no token-shaped line says to run wrangler login', async () => {
    const r = fakeRunner({
      yarn: () => ({
        code: 0,
        stdout: 'You are not logged in.\nshort\n',
        stderr: '',
      }),
    });
    await expect(resolveToken({}, r)).rejects.toThrow(
      'Run yarn wrangler login first.'
    );
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
    expect(applyCommand(s, false, 'abc')).toBe(
      `yarn gitorange install --name acme --account ${ACCOUNT} --workers-dev --from-email 'o'\\''brien+git@example.com' --expect-plan abc --yes`
    );
  });
});
