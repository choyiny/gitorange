import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoptWorker, planAdoptWorker, varChanges } from '../adopt-worker.ts';
import type { Ctx } from '../apply.ts';
import { CloudflareError, type WorkerBinding } from '../cloudflare.ts';
import type { Io } from '../collect.ts';
import { installationIdOf } from '../names.ts';
import { packageSource } from '../source.ts';
import { readState } from '../state.ts';
import {
  fakeCloudflare,
  fakePackage,
  fakeRunner,
  type FakeCloudflareSeed,
} from './fakes.ts';

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gitorange-adopt-worker-'));
  home = join(root, 'home');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const now = () => new Date('2026-10-17T12:00:00Z');
const W_ACCOUNT = 'b'.repeat(32);
const W_BASE = 'https://acme.me.workers.dev';

const DO_BINDINGS: [string, string][] = [
  ['JOB_RUNNER', 'JobRunner'],
  ['ACTIONS_QUEUE', 'ActionsQueue'],
  ['MERGE_RESOLVER', 'MergeResolver'],
  ['AGENT_REVIEWER', 'AgentReviewer'],
  ['LIVE', 'LiveHub'],
];

/** A hand-deployed worker: resources named by hand, not after the slug. */
const BINDINGS: WorkerBinding[] = [
  { type: 'd1', name: 'DB', id: 'd1-acme' },
  { type: 'r2_bucket', name: 'LFS', bucket_name: 'acme-objects' },
  { type: 'r2_bucket', name: 'ACTIONS_LOGS', bucket_name: 'acme-logs' },
  { type: 'r2_bucket', name: 'ACTIONS_CACHE', bucket_name: 'acme-cache' },
  {
    type: 'workflow',
    name: 'ACTIONS_RUN',
    workflow_name: 'acme-run',
    class_name: 'ActionsRun',
  },
  {
    type: 'workflow',
    name: 'MERGE_RESOLUTION',
    workflow_name: 'acme-merge',
    class_name: 'MergeResolutionWorkflow',
  },
  { type: 'artifacts', name: 'ARTIFACTS', namespace: 'acme-git' },
  ...DO_BINDINGS.map(([name, class_name]) => ({
    type: 'durable_object_namespace',
    name,
    class_name,
  })),
  { type: 'ai', name: 'AI' },
  { type: 'assets', name: 'ASSETS' },
  { type: 'send_email', name: 'EMAIL' },
  { type: 'plain_text', name: 'BASE_URL', text: W_BASE },
  { type: 'plain_text', name: 'FROM_EMAIL', text: 'noreply@acme.dev' },
  { type: 'plain_text', name: 'APP_NAME', text: 'GitOrange' },
  { type: 'plain_text', name: 'JOB_RUNNER_NAMESPACE_ID', text: 'ns-job' },
  { type: 'plain_text', name: 'LIVE_NAMESPACE_ID', text: '' },
  { type: 'plain_text', name: 'GITORANGE_VERSION', text: '' },
  { type: 'plain_text', name: 'GITORANGE_INSTALLATION', text: '' },
  { type: 'secret_text', name: 'BETTER_AUTH_SECRET' },
  { type: 'secret_text', name: 'R2_ACCESS_KEY_ID' },
  { type: 'secret_text', name: 'R2_SECRET_ACCESS_KEY' },
];

const DO_NAMESPACES = DO_BINDINGS.map(([, cls]) => ({
  id: `ns-${cls}`,
  script: 'acme',
  class: cls,
}));
DO_NAMESPACES[0]!.id = 'ns-job';

function workerSeed(
  over: Partial<FakeCloudflareSeed> = {},
  bindings: WorkerBinding[] = BINDINGS
): FakeCloudflareSeed {
  return {
    accounts: [{ id: W_ACCOUNT, name: 'Acme' }],
    subdomain: 'me',
    workers: { acme: bindings },
    d1: [{ uuid: 'd1-acme', name: 'acme-database' }],
    r2: { 'acme-objects': {}, 'acme-logs': {}, 'acme-cache': {} },
    workflows: [
      { name: 'acme-run', scriptName: 'acme' },
      { name: 'acme-merge', scriptName: 'acme' },
    ],
    artifactsNamespaces: ['acme-git'],
    doNamespaces: DO_NAMESPACES,
    containerApps: [
      { id: 'ns-job', name: 'acme-jobrunner', namespaceId: 'ns-job' },
    ],
    ...over,
  };
}

const without = (...names: string[]) =>
  BINDINGS.filter((b) => !names.includes(b.name));

const withVar = (name: string, text: string): WorkerBinding[] => [
  ...without(name),
  { type: 'plain_text', name, text },
];

function workerHarness(
  o: {
    seed?: FakeCloudflareSeed;
    confirm?: boolean;
    wellKnown?: () => Response;
  } = {}
) {
  const pkgRoot = fakePackage(join(root, 'pkg'), {
    version: '1.3.0',
    commit: 'abc',
  });
  copyFileSync(
    new URL('../../../wrangler.jsonc.example', import.meta.url),
    join(pkgRoot, 'wrangler.jsonc.example')
  );
  const cf = fakeCloudflare(o.seed ?? workerSeed());
  // Docker is scripted so a call would be recorded, not thrown as unscripted: adopt must make none.
  const runner = fakeRunner({
    docker: () => ({ code: 0, stdout: '27.0.0\n', stderr: '' }),
  });
  const out: string[] = [];
  const confirms: string[] = [];
  const io: Io = {
    tty: true,
    async prompt() {
      return null;
    },
    async select<T>(_m: string, options: { value: T }[]) {
      return options[0]!.value;
    },
    async confirm(m) {
      confirms.push(m);
      return o.confirm ?? true;
    },
    print(t) {
      out.push(t);
    },
  };
  const fetchImpl = (async () =>
    o.wellKnown?.() ?? new Response('nope', { status: 404 })) as typeof fetch;
  const ctx: Ctx = {
    cf,
    runner,
    io,
    dir: join(root, 'unused'),
    configDir: join(root, 'unused'),
    source: packageSource(pkgRoot),
    fetchImpl,
    sleep: async () => {},
    now,
  };
  return { ctx, cf, runner, out, confirms, text: () => out.join('\n') };
}

/** Every Cloudflare call that changes something. */
const WRITES = [
  'createD1',
  'createR2',
  'putR2Lifecycle',
  'putR2Object',
  'queryD1',
];

const dest = () => join(home, 'acme');

const run = (
  h: ReturnType<typeof workerHarness>,
  over: { yes?: boolean; expectPlan?: string } = {}
) =>
  adoptWorker(h.ctx, {
    accountId: W_ACCOUNT,
    worker: 'acme',
    yes: over.yes ?? true,
    expectPlan: over.expectPlan,
    home,
  });

const plan = (h: ReturnType<typeof workerHarness>) =>
  planAdoptWorker(h.ctx, { accountId: W_ACCOUNT, worker: 'acme' });

describe('adoptWorker', () => {
  it('bindings mapped to adopted resources', async () => {
    const h = workerHarness();
    const s = await run(h);
    const id = installationIdOf(W_ACCOUNT, 'acme', 'workers.dev');
    expect(s.installationId).toBe(id);
    expect(s.status).toBe('installed');
    expect(s.adoptedAt).toBe('2026-10-17T12:00:00.000Z');
    expect(s.upgradedAt).toBeUndefined();
    expect(s.deployedConfigHash).toBeUndefined();
    expect(s.deployedVersion).toBeUndefined();
    expect(s.ownershipNonce).toMatch(/^[0-9a-f]{64}$/);
    expect(s.baseUrl).toBe(W_BASE);
    expect(s.inputs).toEqual({
      name: 'acme',
      hostname: null,
      workersDev: true,
      fromEmail: 'noreply@acme.dev',
    });
    expect(s.names).toEqual({
      worker: 'acme',
      d1: 'acme-database',
      lfs: 'acme-objects',
      actionsLogs: 'acme-logs',
      actionsCache: 'acme-cache',
      artifacts: 'acme-git',
      actionsWorkflow: 'acme-run',
      mergeWorkflow: 'acme-merge',
    });
    expect(
      s.resources.map((r) => [r.key, r.kind, r.name, r.id, r.ownership])
    ).toEqual([
      ['d1', 'd1', 'acme-database', 'd1-acme', 'adopted'],
      ['lfs', 'r2', 'acme-objects', 'acme-objects', 'adopted'],
      ['actionsLogs', 'r2', 'acme-logs', 'acme-logs', 'adopted'],
      ['actionsCache', 'r2', 'acme-cache', 'acme-cache', 'adopted'],
      ['actionsWorkflow', 'workflow', 'acme-run', 'acme-run', 'adopted'],
      ['mergeWorkflow', 'workflow', 'acme-merge', 'acme-merge', 'adopted'],
      ['worker', 'worker', 'acme', 'acme', 'adopted'],
    ]);
    expect(s.doNamespaceIds).toEqual({
      JOB_RUNNER_NAMESPACE_ID: 'ns-job',
      MERGE_RESOLVER_NAMESPACE_ID: 'ns-MergeResolver',
      AGENT_REVIEWER_NAMESPACE_ID: 'ns-AgentReviewer',
      LIVE_NAMESPACE_ID: 'ns-LiveHub',
    });
    expect(readState(dest(), id)).toEqual(s);

    const config = readFileSync(join(dest(), 'wrangler.jsonc'), 'utf8');
    expect(config).toContain('"database_id": "d1-acme"');
    expect(config).toContain('"bucket_name": "acme-objects"');
    expect(config).toContain('"namespace": "acme-git"');
    expect(config).toContain('"name": "acme-merge"');
    expect(config).toContain(
      join(root, 'pkg', 'gitorange', 'worker', 'index.js')
    );
    expect(statSync(join(dest(), 'wrangler.jsonc')).mode & 0o777).toBe(0o600);
    expect(statSync(dest()).mode & 0o777).toBe(0o700);

    expect(h.text()).toContain(
      [
        'Resources (recorded as adopted, as found):',
        '  d1         acme-database (d1-acme)',
        '  r2         acme-objects',
        '  r2         acme-logs',
        '  r2         acme-cache',
        '  workflow   acme-run',
        '  workflow   acme-merge',
        '  worker     acme',
        '  artifacts  acme-git',
        '  containers acme-jobrunner',
        '  durable objects  JobRunner, ActionsQueue, MergeResolver, AgentReviewer, LiveHub',
      ].join('\n')
    );
    expect(h.text()).toContain(
      `Adopted acme into ${dest()}.\nCheck it: npx gitorange@1.3.0 status --name acme\nUpgrade it: npx gitorange@1.3.0 upgrade --name acme`
    );
  });

  it('missing bound resource stops', async () => {
    const h = workerHarness({ seed: workerSeed({ d1: [] }) });
    await expect(run(h)).rejects.toThrow(
      'Binding DB points to D1 d1-acme, which does not exist. Nothing was changed.'
    );
    const r2 = workerHarness({
      seed: workerSeed({ r2: { 'acme-objects': {}, 'acme-logs': {} } }),
    });
    await expect(run(r2)).rejects.toThrow(
      'Binding ACTIONS_CACHE points to R2 bucket acme-cache, which does not exist.'
    );
    const wf = workerHarness({
      seed: workerSeed({
        workflows: [{ name: 'acme-run', scriptName: 'acme' }],
      }),
    });
    await expect(run(wf)).rejects.toThrow(
      'Binding MERGE_RESOLUTION points to workflow acme-merge, which does not exist.'
    );
    const dobj = workerHarness({
      seed: workerSeed({ doNamespaces: DO_NAMESPACES.slice(1) }),
    });
    await expect(run(dobj)).rejects.toThrow(
      'Binding JOB_RUNNER points to Durable Object class JobRunner, which does not exist on acme.'
    );
    expect(existsSync(home)).toBe(false);
  });

  it('a workflow run by another worker stops', async () => {
    const h = workerHarness({
      seed: workerSeed({
        workflows: [
          { name: 'acme-run', scriptName: 'acme' },
          { name: 'acme-merge', scriptName: 'other' },
        ],
      }),
    });
    await expect(run(h)).rejects.toThrow(
      'Binding MERGE_RESOLUTION points to workflow acme-merge, which belongs to worker other, not acme.'
    );
    expect(existsSync(home)).toBe(false);
  });

  it('unknown binding stops', async () => {
    const h = workerHarness({
      seed: workerSeed({}, [
        ...BINDINGS,
        { type: 'kv_namespace', name: 'CACHE', id: 'kv1' },
      ]),
    });
    await expect(run(h)).rejects.toThrow(
      "Worker acme has bindings GitOrange's template does not: CACHE (kv_namespace). Nothing was changed."
    );
    // A template name with the wrong type, and a Durable Object binding to another worker's class.
    const typed = workerHarness({
      seed: workerSeed({}, [
        ...without('LFS'),
        { type: 'kv_namespace', name: 'LFS', id: 'kv1' },
      ]),
    });
    await expect(run(typed)).rejects.toThrow('LFS (kv_namespace)');
    const foreign = workerHarness({
      seed: workerSeed({}, [
        ...without('LIVE'),
        {
          type: 'durable_object_namespace',
          name: 'LIVE',
          class_name: 'LiveHub',
          script_name: 'other',
        },
      ]),
    });
    await expect(run(foreign)).rejects.toThrow(
      'LIVE (durable_object_namespace)'
    );
    expect(existsSync(home)).toBe(false);
  });

  it('unknown durable object class stops', async () => {
    const bound = workerHarness({
      seed: workerSeed({}, [
        ...BINDINGS,
        {
          type: 'durable_object_namespace',
          name: 'SESSIONS',
          class_name: 'SessionStore',
        },
      ]),
    });
    await expect(run(bound)).rejects.toThrow(
      "Worker acme has Durable Object classes GitOrange's template does not declare: SessionStore. The first upgrade's config declares exactly the template's classes (JobRunner, ActionsQueue, MergeResolver, AgentReviewer, LiveHub). Nothing was changed."
    );
    // A class the worker exports without binding it counts too.
    const unbound = workerHarness({
      seed: workerSeed({
        doNamespaces: [
          ...DO_NAMESPACES,
          { id: 'ns-old', script: 'acme', class: 'OldHub' },
          { id: 'ns-x', script: 'other', class: 'Elsewhere' },
        ],
      }),
    });
    await expect(run(unbound)).rejects.toThrow(
      "Durable Object classes GitOrange's template does not declare: OldHub."
    );
    expect(existsSync(home)).toBe(false);
  });

  it('a KV-backed durable object class stops', async () => {
    const h = workerHarness({
      seed: workerSeed({
        doNamespaces: DO_NAMESPACES.map((n) =>
          n.class === 'LiveHub' ? { ...n, sqlite: false } : n
        ),
      }),
    });
    await expect(run(h)).rejects.toThrow(
      'Durable Object class LiveHub on acme uses the KV storage backend; the template declares it with SQLite storage. Nothing was changed.'
    );
    expect(existsSync(home)).toBe(false);
  });

  it('unverifiable binding is reported, not a stop', async () => {
    const h = workerHarness();
    h.cf.failNext(
      'listArtifactsNamespaces',
      new CloudflareError(
        'Cloudflare: Authentication error',
        403,
        [10000],
        '/a'
      )
    );
    h.cf.failNext(
      'listContainerApps',
      new CloudflareError('Cloudflare: Unauthorized', 401, [], '/c')
    );
    const s = await run(h);
    expect(s.names.artifacts).toBe('acme-git');
    expect(h.text()).toContain('  artifacts  acme-git (bound, not verified)');
    expect(h.text()).toContain(
      '  containers acme-jobrunner (bound, not verified)'
    );
    // Why, outside the digest: the error text may differ from run to run.
    expect(h.text()).toContain(
      'Note: the Artifacts namespace acme-git could not be confirmed (Cloudflare: Authentication error); its binding on acme is taken as the proof.'
    );
    expect(h.text()).toContain(
      'Note: the containers application acme-jobrunner could not be confirmed (Cloudflare: Unauthorized); its JobRunner binding on acme is taken as the proof.'
    );
    expect(readState(dest(), s.installationId)).toEqual(s);

    // Listed, but not there: also accepted on the binding.
    const absent = workerHarness({
      seed: workerSeed({ artifactsNamespaces: [], containerApps: [] }),
    });
    const p = await plan(absent);
    expect(p.report).toContain('  artifacts  acme-git (bound, not verified)');
    expect(p.report).toContain(
      '  containers acme-jobrunner (bound, not verified)'
    );
    expect(p.notes).toContain(
      'Note: the Artifacts namespace acme-git could not be confirmed (the API does not list it); its binding on acme is taken as the proof.'
    );
  });

  it('a containers application under another name stops', async () => {
    const h = workerHarness({
      seed: workerSeed({
        containerApps: [
          { id: 'ns-job', name: 'acme-runners', namespaceId: 'ns-job' },
        ],
      }),
    });
    await expect(run(h)).rejects.toThrow(
      'The containers application for JobRunner is named acme-runners, but the generated config names it acme-jobrunner; wrangler refuses to deploy over an application with another name. Nothing was changed.'
    );
    expect(existsSync(home)).toBe(false);
  });

  it('existing secrets untouched', async () => {
    const h = workerHarness();
    const s = await run(h);
    expect(h.runner.calls).toHaveLength(0);
    expect(h.cf.calls.filter((c) => WRITES.includes(c.method))).toEqual([]);
    expect(h.text()).toContain(
      'Secrets on the worker (names only): BETTER_AUTH_SECRET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY'
    );
    expect(s.skipped).toEqual([]);
    expect(readdirSync(dest()).sort()).toEqual([
      `${s.installationId}.json`,
      'wrangler.jsonc',
    ]);
  });

  it('no docker call', async () => {
    const h = workerHarness();
    await run(h);
    await plan(h);
    expect(h.runner.calls.map((c) => c.cmd)).not.toContain('docker');
    expect(h.runner.calls).toEqual([]);
  });

  it('bindings the worker lacks get slug-derived names', async () => {
    const h = workerHarness({
      seed: workerSeed(
        {
          doNamespaces: DO_NAMESPACES.filter((n) =>
            ['MergeResolver', 'LiveHub'].includes(n.class)
          ),
        },
        without(
          'ACTIONS_CACHE',
          'ARTIFACTS',
          'JOB_RUNNER',
          'ACTIONS_QUEUE',
          'AGENT_REVIEWER',
          'JOB_RUNNER_NAMESPACE_ID'
        )
      ),
    });
    const s = await run(h);
    expect(s.names.actionsCache).toBe('acme-actions-cache');
    expect(s.names.artifacts).toBe('acme');
    expect(s.resources.some((r) => r.key === 'actionsCache')).toBe(false);
    const text = h.text();
    expect(text).toContain(
      '  r2         acme-actions-cache: not bound; the first upgrade creates it'
    );
    expect(text).toContain(
      '  artifacts  acme: not bound; the first upgrade creates it'
    );
    expect(text).toContain(
      '  containers acme-jobrunner: not bound; the first upgrade creates it'
    );
    expect(text).toContain(
      '  durable objects  MergeResolver, LiveHub; the first upgrade adds JobRunner, ActionsQueue, AgentReviewer'
    );
  });

  it('custom domain sets hostname', async () => {
    const h = workerHarness({
      seed: workerSeed(
        {
          workerDomains: [
            { hostname: 'other.example.com', service: 'other' },
            { hostname: 'git.example.com', service: 'acme' },
          ],
        },
        withVar('BASE_URL', 'https://git.example.com')
      ),
    });
    const s = await run(h);
    expect(s.inputs.hostname).toBe('git.example.com');
    expect(s.inputs.workersDev).toBe(false);
    expect(s.baseUrl).toBe('https://git.example.com');
    expect(s.installationId).toBe(
      installationIdOf(W_ACCOUNT, 'acme', 'git.example.com')
    );
    const config = readFileSync(join(dest(), 'wrangler.jsonc'), 'utf8');
    expect(config).toContain('"pattern": "git.example.com"');
  });

  it('retired and localhost vars are drops', async () => {
    const value = `http://localhost:8080, http://127.0.0.1:8788,http://[::1]:5173`;
    const h = workerHarness({
      seed: workerSeed({}, withVar('TRUSTED_ORIGINS', value)),
    });
    const p = await plan(h);
    expect(p.report).toContain(
      'The first upgrade drops these vars (the worker does not need them):'
    );
    expect(p.report).toContain(
      `  TRUSTED_ORIGINS  ${JSON.stringify(value)} -> removed (drops local development origins)`
    );
    // GitOrange has retired no var yet; the rule is the same as saasmail's.
    expect(
      varChanges(
        { OLD_LOGO: 'x', FEATURE_X: 'on', APP_NAME: 'Mine' },
        { APP_NAME: 'GitOrange' },
        new Set(['OLD_LOGO'])
      )
    ).toEqual({
      stops: [
        '  APP_NAME  "Mine" -> "GitOrange"',
        '  FEATURE_X  "on" -> removed (GitOrange\'s config does not set it)',
      ],
      drops: ['  OLD_LOGO  "x" -> removed (GitOrange no longer reads it)'],
    });
  });

  it('confirm declined writes nothing', async () => {
    const h = workerHarness({ confirm: false });
    await expect(run(h, { yes: false })).rejects.toThrow(
      'Nothing was changed.'
    );
    expect(h.confirms).toEqual(['Adopt this install?']);
    expect(existsSync(home)).toBe(false);
  });

  it('a matching --expect-plan applies without asking; a changed plan stops', async () => {
    const p = await plan(workerHarness());
    const stale = workerHarness();
    await expect(
      run(stale, { yes: false, expectPlan: '000000000000' })
    ).rejects.toThrow('The plan changed since it was reviewed');
    expect(existsSync(home)).toBe(false);

    const h = workerHarness();
    await run(h, { yes: false, expectPlan: p.digest });
    expect(h.confirms).toEqual([]);
    expect(existsSync(join(dest(), 'wrangler.jsonc'))).toBe(true);
  });

  it('a destination holding an install stops before writing', async () => {
    const first = await run(workerHarness());
    const h = workerHarness();
    await expect(run(h)).rejects.toThrow(`${dest()} already has an install`);
    expect(readState(dest(), first.installationId)).toEqual(first);
  });

  it('worker not found stops', async () => {
    const h = workerHarness({ seed: workerSeed({ workers: {} }) });
    await expect(run(h)).rejects.toThrow(
      `No worker named acme on account ${W_ACCOUNT}. Nothing was changed.`
    );
  });
});

describe('adoptWorker: the report and its stops', () => {
  it('the running version and its comparison; custom code is reported, not a stop', async () => {
    const h = workerHarness({
      wellKnown: () =>
        Response.json({ installationId: null, version: '1.2.0' }),
    });
    const p = await plan(h);
    expect(p.state.deployedVersion).toBe('1.2.0');
    expect(p.report).toContain('Running 1.2.0; this package 1.3.0 (upgrade)');

    const unknown = await plan(workerHarness());
    expect(unknown.state.deployedVersion).toBeUndefined();
    expect(unknown.report.split('\n')[0]).toBe(
      'The first upgrade will need --replace-custom-code: the running version is unknown.'
    );
    expect(unknown.report).toContain(
      'Running unknown; this package 1.3.0 (custom: the running version is unknown)'
    );
    expect(unknown.report).toContain(
      'Adopt deploys nothing and changes nothing on Cloudflare; the first upgrade deploys this package.'
    );
  });

  it('GITORANGE_VERSION is the running version when the site does not say', async () => {
    const h = workerHarness({
      seed: workerSeed({}, withVar('GITORANGE_VERSION', '1.3.0')),
    });
    const p = await plan(h);
    expect(p.state.deployedVersion).toBe('1.3.0');
    expect(p.report).toContain('Running 1.3.0; this package 1.3.0 (same)');
  });

  it('inputs: sender from FROM_EMAIL, none when empty', async () => {
    const a = await plan(workerHarness());
    expect(a.report).toContain('  Sender         noreply@acme.dev');
    const b = await plan(
      workerHarness({ seed: workerSeed({}, withVar('FROM_EMAIL', '')) })
    );
    expect(b.state.inputs.fromEmail).toBeNull();
    expect(b.report).toContain('  Sender         (none: email is off)');
  });

  it('BASE_URL on a host that is not the chosen one stops', async () => {
    const h = workerHarness({
      seed: workerSeed({}, withVar('BASE_URL', 'https://x.example.com')),
    });
    await expect(plan(h)).rejects.toThrow(
      'BASE_URL is https://x.example.com, but the worker has no custom domain for it (adopt would record https://acme.me.workers.dev). Routes other than custom domains are not supported by adopt.'
    );
  });

  it('several custom domains with BASE_URL naming none stop', async () => {
    const h = workerHarness({
      seed: workerSeed({
        workerDomains: [
          { hostname: 'a.example.com', service: 'acme' },
          { hostname: 'b.example.com', service: 'acme' },
        ],
      }),
    });
    await expect(plan(h)).rejects.toThrow(
      'serves several custom domains (a.example.com, b.example.com)'
    );
  });

  it('no DB binding stops', async () => {
    await expect(
      plan(workerHarness({ seed: workerSeed({}, without('DB')) }))
    ).rejects.toThrow('The worker has no D1 binding DB');
  });

  it('a worker that already carries GITORANGE_INSTALLATION stops', async () => {
    const h = workerHarness({
      seed: workerSeed(
        {},
        withVar('GITORANGE_INSTALLATION', '{"installationId":"acme-1"}')
      ),
    });
    await expect(plan(h)).rejects.toThrow(
      'Worker acme already carries a gitorange installation (GITORANGE_INSTALLATION): adopt it from its checkout with npx gitorange@1.3.0 adopt --from <checkout>. Nothing was changed.'
    );
  });

  it('a plain var named like a secret stops, value not shown', async () => {
    const h = workerHarness({
      seed: workerSeed({}, [
        ...without('BETTER_AUTH_SECRET'),
        {
          type: 'plain_text',
          name: 'BETTER_AUTH_SECRET',
          text: 'plain-held-key-0123456789',
        },
        { type: 'plain_text', name: 'CF_ANALYTICS_TOKEN', text: 'tok-1234' },
      ]),
    });
    const err = (await plan(h).catch((e: Error) => e)) as Error;
    expect(err.message).toContain(
      'Worker acme has vars the first upgrade would drop or change:'
    );
    expect(err.message).toContain(
      '  BETTER_AUTH_SECRET  (value not shown) -> removed; the upgrade would generate a BETTER_AUTH_SECRET secret in its place'
    );
    expect(err.message).toContain(
      '  CF_ANALYTICS_TOKEN  (value not shown) -> removed; set it as a secret instead'
    );
    expect(err.message).not.toContain('plain-held-key-0123456789');
    expect(err.message).not.toContain('tok-1234');
    expect(err.message).toContain(
      'Change or remove them on the worker, then run adopt again. Nothing was changed.'
    );
  });

  it('a var the generated config sets to another value stops with both values', async () => {
    const h = workerHarness({
      seed: workerSeed({}, withVar('REVIEW_MODEL', '@cf/other/model')),
    });
    await expect(plan(h)).rejects.toThrow(
      '  REVIEW_MODEL  "@cf/other/model" -> "@cf/zai-org/glm-5.3"'
    );
  });

  it('TRUSTED_ORIGINS with an origin that is not local stops', async () => {
    const h = workerHarness({
      seed: workerSeed(
        {},
        withVar(
          'TRUSTED_ORIGINS',
          `http://localhost:8080,https://admin.acme.dev`
        )
      ),
    });
    await expect(plan(h)).rejects.toThrow(
      `  TRUSTED_ORIGINS  "http://localhost:8080,https://admin.acme.dev" -> removed (GitOrange's config does not set it)`
    );
  });

  it('a Durable Object namespace var: empty is filled, another id stops', async () => {
    // LIVE_NAMESPACE_ID is empty on the worker: the upgrade fills it in.
    const ok = await plan(workerHarness());
    expect(ok.state.doNamespaceIds.LIVE_NAMESPACE_ID).toBe('ns-LiveHub');
    const h = workerHarness({
      seed: workerSeed({}, withVar('JOB_RUNNER_NAMESPACE_ID', 'ns-stale')),
    });
    await expect(plan(h)).rejects.toThrow(
      '  JOB_RUNNER_NAMESPACE_ID  "ns-stale" -> "ns-job"'
    );
  });

  it('every such var is listed in one stop, and adopt writes nothing', async () => {
    const h = workerHarness({
      seed: workerSeed({}, [
        ...BINDINGS,
        { type: 'plain_text', name: 'FEATURE_X', text: 'on' },
        { type: 'plain_text', name: 'SETUP_CODE_HASH', text: 'h' },
      ]),
    });
    const err = (await adoptWorker(h.ctx, {
      accountId: W_ACCOUNT,
      worker: 'acme',
      yes: true,
      home,
    }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain('  FEATURE_X ');
    expect(err.message).toContain('  SETUP_CODE_HASH  (value not shown)');
    expect(existsSync(dest())).toBe(false);
    expect(h.cf.calls.filter((c) => WRITES.includes(c.method))).toEqual([]);
  });

  it('no custom domain and no workers.dev subdomain stops', async () => {
    const h = workerHarness({ seed: workerSeed({ subdomain: null }) });
    await expect(plan(h)).rejects.toThrow('no workers.dev subdomain');
  });

  it('the digest is stable across runs and binds the report', async () => {
    const a = await plan(workerHarness());
    const b = await plan(workerHarness());
    expect(a.digest).toMatch(/^[0-9a-f]{12}$/);
    expect(b.digest).toBe(a.digest);
    const c = await plan(
      workerHarness({ seed: workerSeed({}, withVar('FROM_EMAIL', '')) })
    );
    expect(c.digest).not.toBe(a.digest);
  });
});
