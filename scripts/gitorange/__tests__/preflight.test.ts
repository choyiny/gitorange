import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CloudflareError } from '../cloudflare.ts';
import { preflight } from '../preflight.ts';
import { checkoutSource, packageSource } from '../source.ts';
import { fakeCloudflare, fakePackage, fakeRunner } from './fakes.ts';

const table = (rows: [string, string, string][]) =>
  [
    '┌──────────────┬──────────────────┬─────────┬──────────┐',
    '│ zone         │ name             │ enabled │ tag      │',
    ...rows.flatMap(([z, n, e]) => [
      '├──────────────┼──────────────────┼─────────┼──────────┤',
      `│ ${z} │ ${n} │ ${e} │ abc123   │`,
    ]),
    '└──────────────┴──────────────────┴─────────┴──────────┘',
  ].join('\n');

const okRunner = (
  emailOut = table([['example.com', 'mail.example.com', 'yes']])
) =>
  fakeRunner({
    docker: () => ({ code: 0, stdout: '27.0\n', stderr: '' }),
    yarn: () => ({ code: 0, stdout: emailOut, stderr: '' }),
  });

const input = {
  accountId: 'acc',
  hostname: null,
  workersDev: true,
  fromEmail: 'noreply@mail.example.com',
  workerName: 'gitorange',
  source: checkoutSource('/repo'),
};

describe('preflight', () => {
  it('passes and computes the workers.dev base URL', async () => {
    const r = await preflight(
      fakeCloudflare({ subdomain: 'me' }),
      okRunner(),
      input
    );
    expect(r.failures).toEqual([]);
    expect(r.baseUrl).toBe('https://gitorange.me.workers.dev');
    expect(r.zoneId).toBeNull();
  });

  it('reports Artifacts 10004 as one artifacts failure', async () => {
    const cf = fakeCloudflare({ subdomain: 'me' });
    cf.failNext(
      'listArtifactsNamespaces',
      new CloudflareError('no', 400, [10004], '/x')
    );
    const r = await preflight(cf, okRunner(), input);
    expect(r.failures.map((f) => f.check)).toEqual(['artifacts']);
    expect(r.failures[0].fix).toContain('Workers Paid');
    expect(r.failures[0].fix).toContain(
      'https://dash.cloudflare.com/?to=/:account/workers/plans'
    );
  });

  it('reports a missing workers.dev subdomain', async () => {
    const r = await preflight(fakeCloudflare(), okRunner(), input);
    expect(r.failures.map((f) => f.check)).toEqual(['workers-dev']);
    expect(r.baseUrl).toBeNull();
  });

  it('reports a hostname served by another worker, and resolves the zone', async () => {
    const cf = fakeCloudflare({
      subdomain: 'me',
      zones: [{ id: 'z1', name: 'example.com', status: 'active' }],
      workerDomains: [{ hostname: 'GIT.example.com', service: 'other' }],
    });
    const r = await preflight(cf, okRunner(), {
      ...input,
      workersDev: false,
      hostname: 'git.example.com',
    });
    expect(r.failures.map((f) => f.check)).toEqual(['zone']);
    expect(r.failures[0].message).toContain('other');
    expect(r.zoneId).toBe('z1');
    expect(r.baseUrl).toBe('https://git.example.com');
  });

  it('accepts a hostname already owned by this worker, rejects missing or inactive zones', async () => {
    const own = fakeCloudflare({
      zones: [{ id: 'z1', name: 'example.com', status: 'active' }],
      workerDomains: [{ hostname: 'git.example.com', service: 'gitorange' }],
    });
    const custom = { ...input, workersDev: false, hostname: 'git.example.com' };
    expect((await preflight(own, okRunner(), custom)).failures).toEqual([]);
    const none = await preflight(fakeCloudflare(), okRunner(), custom);
    expect(none.failures.map((f) => f.check)).toEqual(['zone']);
    const pending = await preflight(
      fakeCloudflare({
        zones: [{ id: 'z1', name: 'example.com', status: 'pending' }],
      }),
      okRunner(),
      custom
    );
    expect(pending.failures.map((f) => f.check)).toEqual(['zone']);
  });

  describe('existing DNS records and routes on the hostname', () => {
    const custom = { ...input, workersDev: false, hostname: 'git.example.com' };
    const zones = [{ id: 'z1', name: 'example.com', status: 'active' }];

    it('stops on an existing DNS record', async () => {
      const cf = fakeCloudflare({
        zones,
        dnsRecords: {
          z1: [{ name: 'git.example.com', type: 'A', content: '192.0.2.1' }],
        },
      });
      const r = await preflight(cf, okRunner(), custom);
      expect(r.failures.map((f) => f.check)).toEqual(['zone']);
      expect(r.failures[0].message).toBe(
        '`git.example.com` already has DNS records (A 192.0.2.1). Nothing was changed.'
      );
      expect(cf.calls.find((c) => c.method === 'dnsRecords')?.args).toEqual([
        'z1',
        'git.example.com',
      ]);
    });

    it("stops on another worker's route covering the hostname", async () => {
      for (const pattern of [
        'git.example.com/*',
        '*.example.com/*',
        'https://git.example.com/api/*',
      ]) {
        const cf = fakeCloudflare({
          zones,
          routes: { z1: [{ pattern, script: 'other' }] },
        });
        const r = await preflight(cf, okRunner(), custom);
        expect(r.failures.map((f) => f.message)).toEqual([
          '`git.example.com` is routed to `other`. Nothing was changed.',
        ]);
      }
    });

    it('ignores routes on other hostnames and routes without a worker', async () => {
      const cf = fakeCloudflare({
        zones,
        routes: {
          z1: [
            { pattern: 'www.example.com/*', script: 'other' },
            { pattern: 'git.example.com/static/*', script: null },
          ],
        },
      });
      expect((await preflight(cf, okRunner(), custom)).failures).toEqual([]);
    });

    it("passes on this worker's own custom domain and its record (a resume)", async () => {
      const cf = fakeCloudflare({
        zones,
        workerDomains: [{ hostname: 'git.example.com', service: 'gitorange' }],
        dnsRecords: {
          z1: [{ name: 'git.example.com', type: 'AAAA', content: '100::' }],
        },
        routes: { z1: [{ pattern: 'git.example.com/*', script: 'gitorange' }] },
      });
      expect((await preflight(cf, okRunner(), custom)).failures).toEqual([]);
    });
  });

  it('runs wrangler with the chosen account', async () => {
    const runner = okRunner();
    await preflight(fakeCloudflare({ subdomain: 'me' }), runner, input);
    const email = runner.calls.find((c) => c.cmd === 'yarn');
    expect(email?.args).toEqual(['-s', 'wrangler', 'email', 'sending', 'list']);
    expect(email?.opts?.env).toEqual({ CLOUDFLARE_ACCOUNT_ID: 'acc' });
  });

  it('a package lists Email Sending with its own wrangler, without --config', async () => {
    const source = packageSource(
      fakePackage(mkdtempSync(join(tmpdir(), 'pre-')), {
        version: '1.2.0',
        commit: 'abc123def456',
      })
    );
    const out = table([['example.com', 'mail.example.com', 'yes']]);
    const runner = fakeRunner({
      docker: () => ({ code: 0, stdout: '27.0\n', stderr: '' }),
      [process.execPath]: () => ({ code: 0, stdout: out, stderr: '' }),
    });
    const r = await preflight(fakeCloudflare({ subdomain: 'me' }), runner, {
      ...input,
      source,
    });
    expect(r.failures).toEqual([]);
    const email = runner.calls.find((c) => c.cmd === process.execPath);
    expect(email?.args.slice(1)).toEqual(['email', 'sending', 'list']);
    expect(runner.calls.some((c) => c.cmd === 'yarn')).toBe(false);
  });

  it('matches the sender domain as a whole entry, not a substring', async () => {
    const cf = fakeCloudflare({ subdomain: 'me' });
    const r = await preflight(
      cf,
      okRunner(table([['example.com', 'notmail.example.com', 'yes']])),
      input
    );
    expect(r.failures.map((f) => f.check)).toEqual(['email']);
    expect(r.failures[0].fix).toContain('Email Service');
    const hit = await preflight(
      cf,
      okRunner(table([['example.com', 'MAIL.Example.com', 'yes']])),
      input
    );
    expect(hit.failures).toEqual([]);
  });

  it('does not pass on a zone-column match, a disabled row or unreadable output', async () => {
    const cf = fakeCloudflare({ subdomain: 'me' });
    const bare = { ...input, fromEmail: 'noreply@example.com' };
    const zoneOnly = await preflight(
      cf,
      okRunner(table([['example.com', 'mail.example.com', 'yes']])),
      bare
    );
    expect(zoneOnly.failures.map((f) => f.check)).toEqual(['email']);
    const disabled = await preflight(
      cf,
      okRunner(table([['example.com', 'mail.example.com', 'no']])),
      input
    );
    expect(disabled.failures.map((f) => f.check)).toEqual(['email']);
    const junk = await preflight(cf, okRunner('mail.example.com\n'), input);
    expect(junk.failures[0].message).toContain('Could not read');
    expect(junk.failures[0].message).toContain('mail.example.com');
  });

  it('reports a failing email list command with stderr', async () => {
    const runner = fakeRunner({
      docker: () => ({ code: 0, stdout: '', stderr: '' }),
      yarn: () => ({ code: 1, stdout: '', stderr: 'boom\nmore' }),
    });
    const r = await preflight(
      fakeCloudflare({ subdomain: 'me' }),
      runner,
      input
    );
    expect(r.failures[0].check).toBe('email');
    expect(r.failures[0].message).toContain('boom');
    expect(r.failures[0].message).not.toContain('more');
  });

  it('skips the email check when there is no sender', async () => {
    const runner = fakeRunner({
      docker: () => ({ code: 0, stdout: '', stderr: '' }),
    });
    const r = await preflight(fakeCloudflare({ subdomain: 'me' }), runner, {
      ...input,
      fromEmail: null,
    });
    expect(r.failures).toEqual([]);
  });

  it('names the two docker failures apart', async () => {
    const yarn = () => ({
      code: 0,
      stdout: table([['example.com', 'mail.example.com', 'yes']]),
      stderr: '',
    });
    const ok = { code: 0, stdout: '27.0\n', stderr: '' };
    const run = (script: Parameters<typeof fakeRunner>[0]) =>
      preflight(fakeCloudflare({ subdomain: 'me' }), fakeRunner(script), input);

    const down = await run({
      'docker --version': () => ok,
      'docker info': () => ({ code: 1, stdout: '', stderr: 'nope' }),
      yarn,
    });
    expect(down.failures.map((f) => f.check)).toEqual(['docker']);
    expect(down.failures[0]!.message).toMatch(
      /^Docker is installed but not running\./
    );

    const unreachable = await run({
      'docker --version': () => ok,
      'docker info': () => Promise.reject(new Error('boom')),
      yarn,
    });
    expect(unreachable.failures[0]!.message).toMatch(/not running/);

    for (const docker of [
      () => Promise.reject(new Error('spawn docker ENOENT')),
      () => ({ code: 127, stdout: '', stderr: '' }),
    ]) {
      const r = await run({ docker, yarn });
      expect(r.failures.map((f) => f.check)).toEqual(['docker']);
      expect(r.failures[0]!.message).toMatch(/^Docker is not installed\./);
    }
  });

  it('reports every failure at once', async () => {
    const cf = fakeCloudflare();
    cf.failNext('listR2', new CloudflareError('x', 403, [], '/r2'));
    cf.failNext('listArtifactsNamespaces', new Error('weird'));
    const runner = fakeRunner({
      docker: () => ({ code: 1, stdout: '', stderr: '' }),
      yarn: () => ({ code: 0, stdout: '', stderr: '' }),
    });
    const r = await preflight(cf, runner, input);
    expect(r.failures.map((f) => f.check).sort()).toEqual(
      ['artifacts', 'docker', 'email', 'token', 'workers-dev'].sort()
    );
    expect(r.failures.find((f) => f.check === 'artifacts')?.message).toContain(
      'weird'
    );
  });

  it('maps an R2-not-enabled error to the r2 check', async () => {
    const cf = fakeCloudflare({ subdomain: 'me' });
    cf.failNext(
      'listR2',
      new CloudflareError('enable R2', 400, [10042], '/r2')
    );
    const r = await preflight(cf, okRunner(), input);
    expect(r.failures.map((f) => f.check)).toEqual(['r2']);
  });
});
