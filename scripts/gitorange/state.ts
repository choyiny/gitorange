import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { ResourceNames } from './names.ts';

export type Status =
  | 'planned'
  | 'provisioning'
  | 'deploying'
  | 'verifying'
  | 'installed'
  | 'failed';
export type ResourceKind = 'worker' | 'd1' | 'r2' | 'workflow';

export interface Resource {
  key: string;
  kind: ResourceKind;
  name: string;
  id: string;
  ownership: 'created';
  state: 'ready';
}

export interface InstallState {
  schemaVersion: 1;
  installationId: string;
  ownershipNonce: string;
  accountId: string;
  inputs: {
    name: string;
    hostname: string | null;
    workersDev: boolean;
    fromEmail: string | null;
  };
  names: ResourceNames;
  status: Status;
  resources: Resource[];
  steps: { key: string; at: string }[];
  baseUrl: string;
  skipped: string[];
  /** Durable Object namespace ids by class, stored once known. */
  doNamespaceIds: Record<string, string>;
}

export type NewStateInput = Pick<
  InstallState,
  'installationId' | 'accountId' | 'inputs' | 'names' | 'baseUrl'
>;

export function newState(input: NewStateInput): InstallState {
  return {
    schemaVersion: 1,
    installationId: input.installationId,
    ownershipNonce: randomBytes(32).toString('hex'),
    accountId: input.accountId,
    inputs: input.inputs,
    names: input.names,
    status: 'planned',
    resources: [],
    steps: [],
    baseUrl: input.baseUrl,
    skipped: [],
    doNamespaceIds: {},
  };
}

const ALLOWED: Record<Status, Status[]> = {
  planned: ['provisioning', 'failed'],
  provisioning: ['deploying', 'failed'],
  deploying: ['verifying', 'provisioning', 'failed'],
  verifying: ['installed', 'failed'],
  installed: [],
  failed: ['provisioning', 'deploying', 'verifying'],
};

export function transition(s: InstallState, to: Status): InstallState {
  // A run killed mid-phase leaves that status behind; --resume re-enters it.
  if (to === s.status && s.status !== 'installed') {
    return s;
  }
  if (!ALLOWED[s.status].includes(to)) {
    throw new Error(`Cannot move from ${s.status} to ${to}`);
  }
  return { ...s, status: to };
}

export function hasStep(s: InstallState, key: string): boolean {
  return s.steps.some((x) => x.key === key);
}

export function recordStep(s: InstallState, key: string): InstallState {
  if (hasStep(s, key)) {
    return s;
  }
  return { ...s, steps: [...s.steps, { key, at: new Date().toISOString() }] };
}

export function recordResource(s: InstallState, r: Resource): InstallState {
  const clash = s.resources.find((x) => x.id === r.id && x.key !== r.key);
  if (clash) {
    throw new Error(
      `Resource id ${r.id} is already recorded under "${clash.key}", not "${r.key}"`
    );
  }
  return {
    ...s,
    resources: [...s.resources.filter((x) => x.key !== r.key), r],
  };
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function statePath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

export function readState(dir: string, id: string): InstallState | null {
  const p = statePath(dir, id);
  if (!existsSync(p)) {
    return null;
  }
  return JSON.parse(readFileSync(p, 'utf8')) as InstallState;
}

export function writeState(dir: string, s: InstallState): void {
  ensureDir(dir);
  const p = statePath(dir, s.installationId);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
}

export function listStates(dir: string): InstallState[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as InstallState);
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

export function acquireLock(
  dir: string,
  id: string,
  opts: { pidAlive?: (pid: number) => boolean } = {}
): () => void {
  ensureDir(dir);
  const pidAlive = opts.pidAlive ?? defaultPidAlive;
  const path = join(dir, `${id}.lock`);
  const me = hostname();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      const info: LockInfo = {
        pid: process.pid,
        host: me,
        startedAt: new Date().toISOString(),
      };
      writeFileSync(fd, JSON.stringify(info));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw e;
      }
    }
    let held: LockInfo | null = null;
    try {
      held = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
    } catch {
      // unreadable or vanished: treat as stale on the first pass
    }
    if (held && !(held.host === me && !pidAlive(held.pid))) {
      throw new Error(
        `Another yarn gitorange run is using this installation (pid ${held.pid} on ${held.host}).`
      );
    }
    try {
      unlinkSync(path);
    } catch {
      // raced with another reclaimer; the retry's O_EXCL decides
    }
  }
  throw new Error('Another yarn gitorange run is using this installation.');
}
