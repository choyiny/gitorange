import {
  mkdtempSync,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { resourceNames } from '../names.ts';
import {
  acquireLock,
  hasStep,
  listStates,
  newState,
  readState,
  recordResource,
  recordStep,
  statePath,
  transition,
  writeState,
  type Status,
} from '../state.ts';

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'go-state-')), '.gitorange');
});

function fresh() {
  return newState({
    installationId: 'demo-abc123',
    accountId: 'acc',
    inputs: { name: 'demo', hostname: null, workersDev: true, fromEmail: null },
    names: resourceNames('demo'),
    baseUrl: 'https://demo.workers.dev',
  });
}

describe('newState', () => {
  it('fills defaults', () => {
    const s = fresh();
    expect(s).toMatchObject({
      schemaVersion: 1,
      status: 'planned',
      resources: [],
      steps: [],
      skipped: [],
      doNamespaceIds: {},
    });
    expect(s.ownershipNonce).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh().ownershipNonce).not.toBe(s.ownershipNonce);
  });
});

describe('transition', () => {
  const allowed: [Status, Status][] = [
    ['planned', 'provisioning'],
    ['provisioning', 'deploying'],
    ['deploying', 'verifying'],
    ['verifying', 'installed'],
    ['planned', 'failed'],
    ['provisioning', 'failed'],
    ['deploying', 'failed'],
    ['verifying', 'failed'],
    ['failed', 'provisioning'],
    ['failed', 'deploying'],
    ['failed', 'verifying'],
    ['deploying', 'provisioning'],
    ['provisioning', 'provisioning'],
    ['deploying', 'deploying'],
    ['verifying', 'verifying'],
  ];
  for (const [from, to] of allowed) {
    it(`${from} -> ${to}`, () => {
      const s = { ...fresh(), status: from };
      expect(transition(s, to).status).toBe(to);
    });
  }
  it('same-status is a no-op returning the state unchanged', () => {
    const s = { ...fresh(), status: 'provisioning' as const };
    expect(transition(s, 'provisioning')).toBe(s);
  });
  const denied: [Status, Status][] = [
    ['installed', 'provisioning'],
    ['installed', 'installed'],
    ['installed', 'failed'],
    ['planned', 'installed'],
    ['planned', 'deploying'],
    ['failed', 'installed'],
  ];
  for (const [from, to] of denied) {
    it(`${from} -> ${to} throws`, () => {
      const s = { ...fresh(), status: from };
      expect(() => transition(s, to)).toThrow(
        `Cannot move from ${from} to ${to}`
      );
    });
  }
});

describe('steps and resources', () => {
  it('recordStep is idempotent', () => {
    const a = recordStep(fresh(), 'k');
    const b = recordStep(a, 'k');
    expect(hasStep(a, 'k')).toBe(true);
    expect(hasStep(a, 'other')).toBe(false);
    expect(b.steps).toHaveLength(1);
    expect(Date.parse(a.steps[0].at)).not.toBeNaN();
  });
  it('recordResource rejects the same id under another key', () => {
    const r = {
      kind: 'd1',
      name: 'x',
      id: 'id1',
      ownership: 'created',
      state: 'ready',
    } as const;
    const s = recordResource(fresh(), { key: 'a', ...r });
    expect(() => recordResource(s, { key: 'b', ...r })).toThrow();
    expect(recordResource(s, { key: 'a', ...r }).resources).toHaveLength(1);
  });
});

describe('files', () => {
  it('round-trips with mode 0600 and no tmp left', () => {
    const s = fresh();
    writeState(dir, s);
    expect(readState(dir, s.installationId)).toEqual(s);
    expect(statSync(statePath(dir, s.installationId)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([`${s.installationId}.json`]);
    expect(listStates(dir)).toEqual([s]);
  });
  it('missing state reads as null, missing dir lists empty', () => {
    expect(readState(dir, 'nope')).toBeNull();
    expect(listStates(dir)).toEqual([]);
  });
});

describe('lock', () => {
  it('second acquire throws; release removes the file', () => {
    const release = acquireLock(dir, 'id', { pidAlive: () => true });
    expect(() => acquireLock(dir, 'id', { pidAlive: () => true })).toThrow(
      `Another yarn gitorange run is using this installation (pid ${process.pid} on ${hostname()}).`
    );
    release();
    expect(existsSync(join(dir, 'id.lock'))).toBe(false);
    acquireLock(dir, 'id', { pidAlive: () => true })();
  });
  it('stale lock from a dead pid is reclaimed', () => {
    require_dir();
    writeFileSync(
      join(dir, 'id.lock'),
      JSON.stringify({ pid: 999999, host: hostname(), startedAt: 'x' })
    );
    const release = acquireLock(dir, 'id', { pidAlive: () => false });
    release();
    expect(existsSync(join(dir, 'id.lock'))).toBe(false);
  });
  it('a lock from another host is never reclaimed', () => {
    require_dir();
    writeFileSync(
      join(dir, 'id.lock'),
      JSON.stringify({ pid: 1, host: 'elsewhere', startedAt: 'x' })
    );
    expect(() => acquireLock(dir, 'id', { pidAlive: () => false })).toThrow(
      /pid 1 on elsewhere/
    );
  });
});

import { mkdirSync } from 'node:fs';
function require_dir() {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
