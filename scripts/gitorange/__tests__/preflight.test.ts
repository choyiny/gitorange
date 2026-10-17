import { describe, expect, it } from 'vitest';
import { CloudflareError } from '../cloudflare.ts';
import { preflight } from '../preflight.ts';
import { fakeCloudflare, fakeRunner } from './fakes.ts';

const okRunner = (emailOut = 'mail.example.com\n') =>
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

  it('matches the sender domain as a whole entry, not a substring', async () => {
    const cf = fakeCloudflare({ subdomain: 'me' });
    const r = await preflight(cf, okRunner('notmail.example.com\n'), input);
    expect(r.failures.map((f) => f.check)).toEqual(['email']);
    expect(r.failures[0].fix).toContain('Email Service');
    const hit = await preflight(
      cf,
      okRunner('| MAIL.Example.com | verified |\n'),
      input
    );
    expect(hit.failures).toEqual([]);
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

  it('reports docker exit 1 and a docker that cannot start', async () => {
    const down = fakeRunner({
      docker: () => ({ code: 1, stdout: '', stderr: 'nope' }),
      yarn: () => ({ code: 0, stdout: 'mail.example.com', stderr: '' }),
    });
    const a = await preflight(fakeCloudflare({ subdomain: 'me' }), down, input);
    expect(a.failures.map((f) => f.check)).toEqual(['docker']);
    const missing = fakeRunner({
      docker: () => Promise.reject(new Error('spawn docker ENOENT')),
      yarn: () => ({ code: 0, stdout: 'mail.example.com', stderr: '' }),
    });
    const b = await preflight(
      fakeCloudflare({ subdomain: 'me' }),
      missing,
      input
    );
    expect(b.failures.map((f) => f.check)).toEqual(['docker']);
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
