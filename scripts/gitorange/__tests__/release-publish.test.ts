import { describe, expect, it } from 'vitest';
import { checkTag, preflight } from '../release-publish.ts';
import type { Runner } from '../runner.ts';

const SHA = 'a'.repeat(40);
function runner(stdout: string) {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const r: Runner = {
    async run(cmd, args, opts) {
      calls.push({ cmd, args, cwd: opts?.cwd });
      return { code: 0, stdout, stderr: '' };
    },
  };
  return { r, calls };
}
const fetchWith = (release: number, npm: number) =>
  (async (url: string) =>
    new Response('{}', {
      status: String(url).includes('npmjs') ? npm : release,
    })) as unknown as typeof fetch;
const base = { tag: 'v1.2.3', repo: '/repo', token: 'pat' };

describe('checkTag', () => {
  it('bad tag shape', () => {
    for (const t of ['1.2.3', 'v1.2', 'v1.2.3-rc.1', 'main', ''])
      expect(() => checkTag(t)).toThrow('Usage: yarn release:publish vX.Y.Z');
  });
  it('returns the version', () => expect(checkTag('v1.2.3')).toBe('1.2.3'));
});

describe('preflight', () => {
  it('tag missing on origin', async () => {
    const { r } = runner('');
    await expect(
      preflight({ ...base, runner: r, fetchImpl: fetchWith(200, 404) })
    ).rejects.toThrow('missing on origin');
  });
  it('refuses without a token', async () => {
    const { r } = runner(`${SHA}\trefs/tags/v1.2.3\n`);
    await expect(
      preflight({
        ...base,
        token: undefined,
        runner: r,
        fetchImpl: fetchWith(200, 404),
      })
    ).rejects.toThrow('GITORANGE_TOKEN');
  });
  it('not a release', async () => {
    const { r } = runner(`${SHA}\trefs/tags/v1.2.3\n`);
    await expect(
      preflight({ ...base, runner: r, fetchImpl: fetchWith(404, 404) })
    ).rejects.toThrow('not a GitOrange release');
  });
  it('already on npm', async () => {
    const { r } = runner(`${SHA}\trefs/tags/v1.2.3\n`);
    await expect(
      preflight({ ...base, runner: r, fetchImpl: fetchWith(200, 200) })
    ).rejects.toThrow('already on npm');
  });
  it('passes returns the tag commit', async () => {
    const peeled = 'b'.repeat(40);
    const { r } = runner(
      `${SHA}\trefs/tags/v1.2.3\n${peeled}\trefs/tags/v1.2.3^{}\n`
    );
    expect(
      await preflight({ ...base, runner: r, fetchImpl: fetchWith(200, 404) })
    ).toEqual({ commit: peeled });
  });
  it('never reads the working copy', async () => {
    const { r, calls } = runner(`${SHA}\trefs/tags/v1.2.3\n`);
    await preflight({ ...base, runner: r, fetchImpl: fetchWith(200, 404) });
    for (const c of calls) {
      expect(c.cmd).toBe('git');
      expect(c.args.slice(0, 2)).toEqual(['-C', '/repo']);
      expect(c.args).toContain('ls-remote');
      expect(c.cwd).toBeUndefined();
    }
  });
});
