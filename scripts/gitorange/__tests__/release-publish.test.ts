import { describe, expect, it } from 'vitest';
import { checkTag, preflight, worktreeAddArgs } from '../release-publish.ts';
import type { Runner } from '../runner.ts';

const SHA = 'a'.repeat(40);
function runner(o: { tag?: boolean; onMain?: boolean; revFails?: boolean }) {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const r: Runner = {
    async run(cmd, args, opts) {
      calls.push({ cmd, args, cwd: opts?.cwd });
      const sub = args[2];
      const out = (code: number, stdout = '') => ({
        code,
        stdout,
        stderr: '',
      });
      if (sub === 'ls-remote')
        return out(0, o.tag === false ? '' : `${SHA}\trefs/tags/v1.2.3\n`);
      if (sub === 'merge-base') return out(o.onMain === false ? 1 : 0);
      if (sub === 'rev-parse')
        return o.revFails ? out(128) : out(0, `${SHA}\n`);
      return out(0);
    },
  };
  return { r, calls };
}
const npmStatus = (npm: number) =>
  (async () => new Response('{}', { status: npm })) as unknown as typeof fetch;
const base = { tag: 'v1.2.3', repo: '/repo' };

describe('checkTag', () => {
  it('bad tag shape', () => {
    for (const t of ['1.2.3', 'v1.2', 'v1.2.3-rc.1', 'main', ''])
      expect(() => checkTag(t)).toThrow('Usage: yarn release:publish vX.Y.Z');
  });
  it('returns the version', () => expect(checkTag('v1.2.3')).toBe('1.2.3'));
});

describe('preflight', () => {
  it('tag missing on origin', async () => {
    const { r } = runner({ tag: false });
    await expect(
      preflight({ ...base, runner: r, fetchImpl: npmStatus(404) })
    ).rejects.toThrow('missing on origin');
  });
  it('tag not on main', async () => {
    const { r } = runner({ onMain: false });
    await expect(
      preflight({ ...base, runner: r, fetchImpl: npmStatus(404) })
    ).rejects.toThrow('Tag v1.2.3 is not on main; publish only releases cut');
  });
  it('already on npm', async () => {
    const { r } = runner({});
    await expect(
      preflight({ ...base, runner: r, fetchImpl: npmStatus(200) })
    ).rejects.toThrow('already on npm');
  });
  it('passes when the tag is on main', async () => {
    const { r } = runner({});
    expect(
      await preflight({ ...base, runner: r, fetchImpl: npmStatus(404) })
    ).toEqual({ commit: SHA });
  });
  it('never reads the working copy', async () => {
    const { r, calls } = runner({});
    await preflight({ ...base, runner: r, fetchImpl: npmStatus(404) });
    for (const c of calls) {
      expect(c.cmd).toBe('git');
      expect(c.args.slice(0, 2)).toEqual(['-C', '/repo']);
      expect(c.cwd).toBeUndefined();
      expect(c.args.join(' ')).not.toMatch(/checkout|reset|merge |pull|stash/);
    }
  });
});

describe('worktreeAddArgs', () => {
  it('builds the verified commit, not the tag', () =>
    expect(worktreeAddArgs('/repo', '/tmp/x', SHA)).toEqual([
      '-C',
      '/repo',
      'worktree',
      'add',
      '--detach',
      '/tmp/x',
      SHA,
    ]));
});

describe('preflight rev-parse', () => {
  it('refuses when the commit cannot be resolved', async () => {
    const { r } = runner({ revFails: true });
    await expect(
      preflight({ ...base, runner: r, fetchImpl: npmStatus(404) })
    ).rejects.toThrow('Could not resolve');
  });
});
