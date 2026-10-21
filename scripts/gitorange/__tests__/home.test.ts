import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  gitorangeHome,
  installDir,
  listInstalls,
  pickInstall,
} from '../home.ts';
import { installationIdOf, resourceNames } from '../names.ts';
import { UsageError } from '../status.ts';
import { newState, statePath, writeState } from '../state.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitorange-home-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const put = (name: string) => {
  const id = installationIdOf('a'.repeat(32), name, 'workers.dev');
  const dir = installDir(home, name);
  mkdirSync(dir, { recursive: true });
  writeState(
    dir,
    newState({
      installationId: id,
      accountId: 'a'.repeat(32),
      inputs: { name, hostname: null, workersDev: true, fromEmail: null },
      names: resourceNames(name),
      baseUrl: '',
    })
  );
  return statePath(dir, id);
};

describe('gitorangeHome', () => {
  it('GITORANGE_HOME overrides, else ~/.gitorange', () => {
    expect(gitorangeHome({ GITORANGE_HOME: '/x/y' })).toBe('/x/y');
    expect(gitorangeHome({})).toBe(join(homedir(), '.gitorange'));
  });
});

describe('pickInstall', () => {
  it('several installs need --name', () => {
    const a = put('acme');
    const b = put('beta');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(a, old, old);
    utimesSync(b, old, old);
    expect(() => pickInstall(home, undefined)).toThrow(UsageError);
    expect(() => pickInstall(home, undefined)).toThrow(
      'Several installs: acme, beta. Pass --name.'
    );
    expect(statSync(a).mtimeMs).toBe(old.getTime());
    expect(statSync(b).mtimeMs).toBe(old.getTime());
    expect(pickInstall(home, 'beta').slug).toBe('beta');
  });

  it('one install is picked', () => {
    put('acme');
    expect(pickInstall(home, undefined).slug).toBe('acme');
    expect(listInstalls(home).map((i) => i.slug)).toEqual(['acme']);
  });

  it('empty home', () => {
    expect(() => pickInstall(home, undefined)).toThrow(
      `No GitOrange install in ${home}.`
    );
    expect(() => pickInstall(join(home, 'missing'), undefined)).toThrow(
      UsageError
    );
  });
});

describe('listInstalls', () => {
  it('skips files and dangling symlinks', () => {
    put('acme');
    writeFileSync(join(home, 'note.txt'), 'x');
    symlinkSync(join(home, 'nowhere'), join(home, 'dangling'));
    expect(listInstalls(home).map((i) => i.slug)).toEqual(['acme']);
  });
});
