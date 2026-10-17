import { describe, expect, it } from 'vitest';
import { CloudflareError, restCloudflare } from '../cloudflare.ts';
import { fakeCloudflare } from './fakes.ts';

type Call = { method: string; url: URL; body?: string };

function fakeFetch(respond: (call: Call, n: number) => Response): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const call = {
      method: init?.method ?? 'GET',
      url: new URL(url),
      body: init?.body as string | undefined,
    };
    calls.push(call);
    return respond(call, calls.length);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const ok = (result: unknown, info?: object) =>
  Response.json({ success: true, errors: [], result, result_info: info });
const noSleep = { sleep: async () => {} };

describe('restCloudflare', () => {
  it('turns an error envelope into CloudflareError', async () => {
    const { fetch } = fakeFetch(() =>
      Response.json(
        { success: false, errors: [{ code: 10000, message: 'Auth' }] },
        { status: 403 }
      )
    );
    const err = await restCloudflare('t', fetch, noSleep)
      .listD1('a')
      .catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareError);
    expect(err.status).toBe(403);
    expect(err.codes).toEqual([10000]);
    expect(err.path).toContain('/d1/database');
    expect(err.message).not.toContain('Bearer');
  });

  it('listAccounts sends per_page=50; Artifacts and workers/domains send none', async () => {
    const acc = fakeFetch(() => ok([]));
    await restCloudflare('t', acc.fetch, noSleep).listAccounts();
    expect(acc.calls[0]!.url.searchParams.get('per_page')).toBe('50');
    const art = fakeFetch(() => ok([]));
    const cf = restCloudflare('t', art.fetch, noSleep);
    await cf.listArtifactsNamespaces('a');
    await cf.workerDomains('a');
    expect(art.calls.map((c) => c.url.searchParams.has('per_page'))).toEqual([
      false,
      false,
    ]);
  });

  it('listR2 follows result_info.cursor across two pages', async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.searchParams.get('cursor') === 'c1'
        ? ok({ buckets: [{ name: 'b2' }] }, {})
        : ok({ buckets: [{ name: 'b1' }] }, { cursor: 'c1' })
    );
    expect(await restCloudflare('t', fetch, noSleep).listR2('a')).toEqual([
      'b1',
      'b2',
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.searchParams.get('per_page')).toBe('1000');
  });

  it('stops when the cursor repeats', async () => {
    const { fetch, calls } = fakeFetch(() =>
      ok({ buckets: [{ name: 'b' }] }, { cursor: 'same' })
    );
    await restCloudflare('t', fetch, noSleep).listR2('a');
    expect(calls).toHaveLength(2);
  });

  it('concatenates pages', async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.searchParams.get('page') === null
        ? ok([{ uuid: '1', name: 'a' }], { total_pages: 2 })
        : ok([{ uuid: '2', name: 'b' }], { total_pages: 2 })
    );
    const rows = await restCloudflare('t', fetch, noSleep).listD1('acc');
    expect(rows.map((r) => r.uuid)).toEqual(['1', '2']);
    expect(calls).toHaveLength(2);
  });

  it('retries a GET once on 429, honouring Retry-After (capped)', async () => {
    const waits: number[] = [];
    const { fetch, calls } = fakeFetch((_, n) =>
      n === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '99' } })
        : ok([{ id: 'x', name: 'X' }])
    );
    const rows = await restCloudflare('t', fetch, {
      sleep: async (ms) => void waits.push(ms),
    }).listAccounts();
    expect(rows).toEqual([{ id: 'x', name: 'X' }]);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([10_000]);
  });

  it('does not retry a POST on 500', async () => {
    const { fetch, calls } = fakeFetch(() =>
      Response.json(
        { success: false, errors: [{ code: 1, message: 'boom' }] },
        { status: 500 }
      )
    );
    await expect(
      restCloudflare('t', fetch, noSleep).createD1('a', 'db')
    ).rejects.toBeInstanceOf(CloudflareError);
    expect(calls).toHaveLength(1);
  });

  it('workersSubdomain: 404 -> null, else the subdomain', async () => {
    const miss = fakeFetch(() =>
      Response.json({ success: false, errors: [] }, { status: 404 })
    );
    expect(
      await restCloudflare('t', miss.fetch, noSleep).workersSubdomain('a')
    ).toBeNull();
    const hit = fakeFetch(() => ok({ subdomain: 'me' }));
    expect(
      await restCloudflare('t', hit.fetch, noSleep).workersSubdomain('a')
    ).toBe('me');
  });

  it('findZone walks labels upward and returns the first hit', async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.searchParams.get('name') === 'example.com'
        ? ok([{ id: 'z', name: 'example.com', status: 'active' }])
        : ok([])
    );
    const z = await restCloudflare('t', fetch, noSleep).findZone(
      'a',
      'git.a.example.com'
    );
    expect(z).toEqual({ id: 'z', name: 'example.com', status: 'active' });
    expect(calls.map((c) => c.url.searchParams.get('name'))).toEqual([
      'git.a.example.com',
      'a.example.com',
      'example.com',
    ]);
  });

  it('queryD1 sends sql and params and returns the first result set', async () => {
    const { fetch, calls } = fakeFetch(() =>
      ok([{ results: [{ n: 1 }] }, { results: [{ n: 2 }] }])
    );
    const rows = await restCloudflare('t', fetch, noSleep).queryD1(
      'a',
      'db',
      'select ?',
      [1]
    );
    expect(rows).toEqual([{ n: 1 }]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      sql: 'select ?',
      params: [1],
    });
  });

  it('putR2Lifecycle translates rules to the API shape', async () => {
    const { fetch, calls } = fakeFetch(() => ok({}));
    await restCloudflare('t', fetch, noSleep).putR2Lifecycle('a', 'b', [
      { id: 'expire-7d', prefix: 'actions-cache/', days: 7 },
    ]);
    expect(calls[0]!.method).toBe('PUT');
    expect(JSON.parse(calls[0]!.body!).rules[0]).toEqual({
      id: 'expire-7d',
      enabled: true,
      conditions: { prefix: 'actions-cache/' },
      deleteObjectsTransition: { condition: { type: 'Age', maxAge: 604800 } },
    });
  });

  it('R2 objects are raw bodies; 404 -> null', async () => {
    const miss = fakeFetch(() => new Response('', { status: 404 }));
    expect(
      await restCloudflare('t', miss.fetch, noSleep).getR2Object(
        'a',
        'b',
        'k/x'
      )
    ).toBeNull();
    const hit = fakeFetch(() => new Response('hello'));
    expect(
      await restCloudflare('t', hit.fetch, noSleep).getR2Object('a', 'b', 'k/x')
    ).toBe('hello');
    expect(hit.calls[0]!.url.pathname).toMatch(/\/objects\/k\/x$/);
  });

  it('workerVars keeps only plain_text bindings; 404 -> null', async () => {
    const { fetch } = fakeFetch(() =>
      ok({
        bindings: [
          { type: 'plain_text', name: 'A', text: '1' },
          { type: 'd1', name: 'DB' },
        ],
      })
    );
    expect(
      await restCloudflare('t', fetch, noSleep).workerVars('a', 's')
    ).toEqual({ A: '1' });
    const miss = fakeFetch(() =>
      Response.json({ success: false, errors: [] }, { status: 404 })
    );
    expect(
      await restCloudflare('t', miss.fetch, noSleep).workerVars('a', 's')
    ).toBeNull();
  });
});

describe('fakeCloudflare', () => {
  it('seeds state, logs calls and supports failNext', async () => {
    const cf = fakeCloudflare({
      r2: { b: { k: 'v' } },
      d1: [{ uuid: 'u', name: 'db' }],
    });
    expect(await cf.getR2Object('a', 'b', 'k')).toBe('v');
    await cf.putR2Object('a', 'b', 'k2', 'w');
    expect(await cf.getR2Object('a', 'b', 'k2')).toBe('w');
    expect(await cf.listR2('a')).toEqual(['b']);
    cf.failNext('createD1', new CloudflareError('x', 500, [], '/p'));
    await expect(cf.createD1('a', 'n')).rejects.toBeInstanceOf(CloudflareError);
    expect((await cf.createD1('a', 'n')).uuid).toBeTruthy();
    expect(cf.calls.map((c) => c.method)).toContain('putR2Object');
    expect((await cf.listD1('a')).map((d) => d.name)).toEqual(['db', 'n']);
  });
});
