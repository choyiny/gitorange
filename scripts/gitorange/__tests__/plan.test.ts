import { describe, expect, it } from 'vitest';
import { resourceNames } from '../names.ts';
import { observe, type Observed } from '../observe.ts';
import {
  computePlan,
  formatPlan,
  planDigest,
  PlanStop,
  type Plan,
} from '../plan.ts';
import { newState, recordStep, type InstallState } from '../state.ts';
import { fakeCloudflare } from './fakes.ts';

const names = resourceNames('gitorange');
const installationId = 'gitorange-1a2b3c4d5e6f';
const ownershipNonce = 'n'.repeat(64);
const desired = { installationId, ownershipNonce, names };

const MARKER_KEY = '.gitorange/ownership.json';

function empty(): Observed {
  return {
    worker: { exists: false, vars: null },
    d1: [],
    d1Tables: {},
    d1InstallRow: {},
    r2: [],
    r2Markers: {},
    workflows: [],
    artifactsNamespaces: [],
  };
}

function state(): InstallState {
  return {
    ...newState({
      installationId,
      accountId: 'acc',
      inputs: {
        name: 'gitorange',
        hostname: 'git.example.com',
        workersDev: false,
        fromEmail: 'noreply@example.com',
      },
      names,
      baseUrl: 'https://git.example.com',
    }),
    ownershipNonce,
  };
}

function marker(key: string, nonce = ownershipNonce): string {
  return JSON.stringify({ installationId, ownershipNonce: nonce, key });
}

function tuples(plan: Plan) {
  return plan.actions.map((a) => [a.action, a.kind, a.name]);
}

function stopMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PlanStop);
    return (e as Error).message;
  }
  throw new Error('expected a PlanStop');
}

const notOurs = (n: string) =>
  `\`${n}\` already exists and was not created by this installation. Nothing was changed.`;

describe('computePlan', () => {
  it('fresh account: everything is created, in the fixed order', () => {
    const plan = computePlan(desired, empty(), null);
    expect(plan.installationId).toBe(installationId);
    expect(tuples(plan)).toEqual([
      ['create', 'd1', 'gitorange-db'],
      ['create', 'r2', 'gitorange-lfs'],
      ['create', 'r2', 'gitorange-actions-logs'],
      ['create', 'r2', 'gitorange-actions-cache'],
      ['create', 'workflow', 'gitorange-actions-run'],
      ['create', 'workflow', 'gitorange-merge-resolution'],
      ['create', 'worker', 'gitorange'],
    ]);
    expect(plan.actions.map((a) => a.key)).toEqual([
      'd1',
      'lfs',
      'actionsLogs',
      'actionsCache',
      'actionsWorkflow',
      'mergeWorkflow',
      'worker',
    ]);
    expect(plan.info).toEqual([]);
    expect(plan.digest).toMatch(/^[0-9a-f]{12}$/);
  });

  it('same inputs give the same digest', () => {
    const a = computePlan(desired, empty(), null);
    const b = computePlan(desired, empty(), null);
    expect(a.digest).toBe(b.digest);
    expect(planDigest(installationId, a.actions)).toBe(a.digest);
  });

  it('a changed action changes the digest', () => {
    const a = computePlan(desired, empty(), null);
    const changed = a.actions.map((x, i) =>
      i === 0 ? { ...x, action: 'reuse' as const } : x
    );
    expect(planDigest(installationId, changed)).not.toBe(a.digest);
    expect(planDigest('other-1a2b3c4d5e6f', a.actions)).not.toBe(a.digest);
  });

  it('stops on a bucket that exists without our marker', () => {
    const o = {
      ...empty(),
      r2: ['gitorange-lfs'],
      r2Markers: { 'gitorange-lfs': null },
    };
    expect(stopMessage(() => computePlan(desired, o, null))).toBe(
      notOurs('gitorange-lfs')
    );
  });

  it('reuses a bucket whose marker matches', () => {
    const o = {
      ...empty(),
      r2: ['gitorange-lfs'],
      r2Markers: { 'gitorange-lfs': marker('lfs') },
    };
    const plan = computePlan(desired, o, null);
    expect(plan.actions[1]).toEqual({
      action: 'reuse',
      kind: 'r2',
      key: 'lfs',
      name: 'gitorange-lfs',
    });
  });

  it('compares marker values, not raw text', () => {
    const reordered = JSON.stringify({
      key: 'lfs',
      ownershipNonce,
      installationId,
    });
    const o = {
      ...empty(),
      r2: ['gitorange-lfs'],
      r2Markers: { 'gitorange-lfs': ` ${reordered}\n` },
    };
    expect(computePlan(desired, o, null).actions[1].action).toBe('reuse');
  });

  it('stops on a bucket whose marker has another nonce, key, or is not JSON', () => {
    for (const body of [
      marker('lfs', 'x'.repeat(64)),
      marker('actionsLogs'),
      'not json',
      'null',
    ]) {
      const o = {
        ...empty(),
        r2: ['gitorange-lfs'],
        r2Markers: { 'gitorange-lfs': body },
      };
      expect(stopMessage(() => computePlan(desired, o, null))).toBe(
        notOurs('gitorange-lfs')
      );
    }
  });

  it('reuses a bucket recorded in the state file', () => {
    const s = state();
    s.resources.push({
      key: 'actionsCache',
      kind: 'r2',
      name: 'gitorange-actions-cache',
      id: 'gitorange-actions-cache',
      ownership: 'created',
      state: 'ready',
    });
    const o = {
      ...empty(),
      r2: ['gitorange-actions-cache'],
      r2Markers: { 'gitorange-actions-cache': null },
    };
    expect(computePlan(desired, o, s).actions[3].action).toBe('reuse');
  });

  it('stops on a workflow bound to another script', () => {
    const o = {
      ...empty(),
      workflows: [
        { name: 'gitorange-actions-run', scriptName: 'someone-else' },
      ],
    };
    expect(stopMessage(() => computePlan(desired, o, null))).toBe(
      notOurs('gitorange-actions-run')
    );
  });

  it('reuses a workflow bound to our worker', () => {
    const o = {
      ...empty(),
      workflows: [
        { name: 'gitorange-merge-resolution', scriptName: 'gitorange' },
        { name: 'unrelated', scriptName: 'other' },
      ],
    };
    const plan = computePlan(desired, o, null);
    expect(plan.actions[5]).toEqual({
      action: 'reuse',
      kind: 'workflow',
      key: 'mergeWorkflow',
      name: 'gitorange-merge-resolution',
    });
    expect(plan.actions[4].action).toBe('create');
  });

  it('stops when a recorded resource is missing', () => {
    const s = state();
    s.resources.push({
      key: 'lfs',
      kind: 'r2',
      name: 'gitorange-lfs',
      id: 'gitorange-lfs',
      ownership: 'created',
      state: 'ready',
    });
    const msg = stopMessage(() => computePlan(desired, empty(), s));
    expect(msg).toContain('recorded but missing');
    expect(msg).toContain('gitorange-lfs');
  });

  it('stops when a recorded D1 database was replaced by another with the same name', () => {
    const s = state();
    s.resources.push({
      key: 'd1',
      kind: 'd1',
      name: 'gitorange-db',
      id: 'uuid-old',
      ownership: 'created',
      state: 'ready',
    });
    const o = {
      ...empty(),
      d1: [{ uuid: 'uuid-new', name: 'gitorange-db' }],
      d1Tables: { 'uuid-new': [] },
      d1InstallRow: { 'uuid-new': null },
    };
    expect(stopMessage(() => computePlan(desired, o, s))).toContain(
      'recorded but missing'
    );
  });

  it('reuses a D1 database recorded with the same uuid', () => {
    const s = state();
    s.resources.push({
      key: 'd1',
      kind: 'd1',
      name: 'gitorange-db',
      id: 'uuid-1',
      ownership: 'created',
      state: 'ready',
    });
    const o = {
      ...empty(),
      d1: [{ uuid: 'uuid-1', name: 'gitorange-db' }],
      d1Tables: { 'uuid-1': ['users'] },
      d1InstallRow: { 'uuid-1': null },
    };
    expect(computePlan(desired, o, s).actions[0].action).toBe('reuse');
  });

  it('stops when two D1 databases have our name', () => {
    const o = {
      ...empty(),
      d1: [
        { uuid: 'uuid-1', name: 'gitorange-db' },
        { uuid: 'uuid-2', name: 'gitorange-db' },
      ],
      d1Tables: { 'uuid-1': [], 'uuid-2': [] },
      d1InstallRow: { 'uuid-1': null, 'uuid-2': null },
    };
    const s = recordStep(state(), 'provision-intent:d1');
    const msg = stopMessage(() => computePlan(desired, o, s));
    expect(msg).toContain('gitorange-db');
    expect(msg).toContain('Nothing was changed.');
  });

  it('accepts a same-name empty D1 database after a provision intent', () => {
    const o = {
      ...empty(),
      d1: [{ uuid: 'uuid-1', name: 'gitorange-db' }],
      d1Tables: { 'uuid-1': [] },
      d1InstallRow: { 'uuid-1': null },
    };
    const s = recordStep(state(), 'provision-intent:d1');
    expect(computePlan(desired, o, s).actions[0]).toEqual({
      action: 'reuse',
      kind: 'd1',
      key: 'd1',
      name: 'gitorange-db',
    });
  });

  it('stops on a same-name empty D1 database without a provision intent', () => {
    const o = {
      ...empty(),
      d1: [{ uuid: 'uuid-1', name: 'gitorange-db' }],
      d1Tables: { 'uuid-1': [] },
      d1InstallRow: { 'uuid-1': null },
    };
    expect(stopMessage(() => computePlan(desired, o, state()))).toBe(
      notOurs('gitorange-db')
    );
    expect(stopMessage(() => computePlan(desired, o, null))).toBe(
      notOurs('gitorange-db')
    );
  });

  it('stops on a same-name D1 with tables and no matching install_state row', () => {
    const s = recordStep(state(), 'provision-intent:d1');
    for (const row of [
      null,
      { installation_id: installationId, ownership_nonce: 'x'.repeat(64) },
      {
        installation_id: 'other-1a2b3c4d5e6f',
        ownership_nonce: ownershipNonce,
      },
    ]) {
      const o = {
        ...empty(),
        d1: [{ uuid: 'uuid-1', name: 'gitorange-db' }],
        d1Tables: { 'uuid-1': ['users', 'install_state'] },
        d1InstallRow: { 'uuid-1': row },
      };
      expect(stopMessage(() => computePlan(desired, o, s))).toBe(
        notOurs('gitorange-db')
      );
    }
  });

  it('reuses a same-name D1 whose install_state row matches', () => {
    const o = {
      ...empty(),
      d1: [{ uuid: 'uuid-1', name: 'gitorange-db' }],
      d1Tables: { 'uuid-1': ['users', 'install_state'] },
      d1InstallRow: {
        'uuid-1': {
          installation_id: installationId,
          ownership_nonce: ownershipNonce,
        },
      },
    };
    expect(computePlan(desired, o, null).actions[0].action).toBe('reuse');
  });

  it('existing worker with our marker → deploy', () => {
    const o = {
      ...empty(),
      worker: {
        exists: true,
        vars: {
          GITORANGE_INSTALLATION: JSON.stringify({
            ownershipNonce,
            installationId,
          }),
        },
      },
    };
    expect(computePlan(desired, o, null).actions[6]).toEqual({
      action: 'deploy',
      kind: 'worker',
      key: 'worker',
      name: 'gitorange',
    });
  });

  it('existing worker without our marker → stop', () => {
    for (const vars of [
      {} as Record<string, string>,
      { GITORANGE_INSTALLATION: '' },
      { GITORANGE_INSTALLATION: 'not json' },
      {
        GITORANGE_INSTALLATION: JSON.stringify({
          installationId,
          ownershipNonce: 'x'.repeat(64),
        }),
      },
    ]) {
      const o = { ...empty(), worker: { exists: true, vars } };
      expect(stopMessage(() => computePlan(desired, o, null))).toBe(
        notOurs('gitorange')
      );
    }
  });

  it('notes an existing Artifacts namespace', () => {
    const o = { ...empty(), artifactsNamespaces: ['other', 'gitorange'] };
    expect(computePlan(desired, o, null).info).toEqual([
      'existing Artifacts namespace gitorange reused',
    ]);
  });
});

describe('formatPlan', () => {
  it('formatPlan ends with the no-change line', () => {
    const s = state();
    const plan = computePlan(
      desired,
      { ...empty(), artifactsNamespaces: ['gitorange'] },
      null
    );
    const out = formatPlan(plan, s.inputs, s.baseUrl);
    const lines = out.split('\n');
    expect(lines.at(-1)).toBe(
      'No Cloudflare resource or local file was changed.'
    );
    expect(lines).toContain('create  d1        gitorange-db');
    expect(lines).toContain('create  worker    gitorange');
    expect(out).toContain('git.example.com');
    expect(out).toContain('https://git.example.com');
    expect(out).toContain('noreply@example.com');
    expect(out).toContain('existing Artifacts namespace gitorange reused');
  });

  it('formats a workers.dev install without a sender', () => {
    const plan = computePlan(desired, empty(), null);
    const out = formatPlan(
      plan,
      { name: 'gitorange', hostname: null, workersDev: true, fromEmail: null },
      'https://gitorange.acme.workers.dev'
    );
    expect(out).toContain('workers.dev');
    expect(out).toContain('https://gitorange.acme.workers.dev');
    expect(out.split('\n').at(-1)).toBe(
      'No Cloudflare resource or local file was changed.'
    );
  });
});

describe('observe', () => {
  it('reads only our resources and markers', async () => {
    const cf = fakeCloudflare({
      d1: [
        { uuid: 'uuid-1', name: 'gitorange-db' },
        { uuid: 'uuid-2', name: 'other-db' },
      ],
      r2: {
        'gitorange-lfs': { [MARKER_KEY]: marker('lfs') },
        'other-bucket': { [MARKER_KEY]: 'x' },
      },
      workflows: [{ name: 'gitorange-actions-run', scriptName: 'gitorange' }],
      workerVars: { gitorange: { GITORANGE_INSTALLATION: 'v' } },
      artifactsNamespaces: ['gitorange'],
    });
    const o = await observe(cf, 'acc', names);
    expect(o.worker).toEqual({
      exists: true,
      vars: { GITORANGE_INSTALLATION: 'v' },
    });
    expect(o.d1).toHaveLength(2);
    expect(o.d1Tables).toEqual({ 'uuid-1': [] });
    expect(o.d1InstallRow).toEqual({ 'uuid-1': null });
    expect(o.r2Markers).toEqual({ 'gitorange-lfs': marker('lfs') });
    expect(o.workflows).toEqual([
      { name: 'gitorange-actions-run', scriptName: 'gitorange' },
    ]);
    expect(o.artifactsNamespaces).toEqual(['gitorange']);
    const queried = cf.calls.filter((c) => c.method === 'queryD1');
    expect(queried.map((c) => c.args[1])).toEqual(['uuid-1']);
    // No install_state table, so no row query.
    expect(String(queried[0].args[2])).toContain('sqlite_master');
    const markers = cf.calls.filter((c) => c.method === 'getR2Object');
    expect(markers.map((c) => c.args.slice(1))).toEqual([
      ['gitorange-lfs', MARKER_KEY],
    ]);
  });

  it('reads the install_state row when that table exists', async () => {
    const cf = fakeCloudflare({
      d1: [{ uuid: 'uuid-1', name: 'gitorange-db' }],
    });
    const row = {
      installation_id: installationId,
      ownership_nonce: ownershipNonce,
    };
    cf.queryD1 = async (_a, _id, sql) =>
      sql.includes('sqlite_master')
        ? [{ name: 'users' }, { name: 'install_state' }]
        : [row];
    const o = await observe(cf, 'acc', names);
    expect(o.d1Tables).toEqual({ 'uuid-1': ['users', 'install_state'] });
    expect(o.d1InstallRow).toEqual({ 'uuid-1': row });
  });

  it('reports a missing worker', async () => {
    const o = await observe(fakeCloudflare(), 'acc', names);
    expect(o.worker).toEqual({ exists: false, vars: null });
  });
});
