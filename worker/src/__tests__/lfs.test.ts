import { describe, expect, it } from 'vitest';
import { handleLfsRequest } from '../lfs-http';
import { sha256Hex } from '../git/bytes';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  type TestEnv,
} from './helpers/app';
import { commitFiles } from './helpers/seed';

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;
const PATH = '/octocat/app.git/info/lfs';

async function pat(t: TestEnv, cookie: string) {
  const res = await call(t, '/api/tokens', {
    cookie,
    json: { name: 'lfs', expiresInDays: 30 },
  });
  return ((await res.json()) as { plaintext: string }).plaintext;
}

async function lfs(
  t: TestEnv,
  path: string,
  opts: {
    token?: string;
    method?: string;
    json?: unknown;
    env?: Partial<CloudflareBindings>;
  } = {}
) {
  const headers = new Headers({ Accept: 'application/vnd.git-lfs+json' });
  if (opts.token)
    headers.set('Authorization', `Basic ${btoa(`user:${opts.token}`)}`);
  if (opts.json !== undefined)
    headers.set('Content-Type', 'application/vnd.git-lfs+json');
  const req = new Request(`http://test.local${PATH}${path}`, {
    method: opts.method ?? (opts.json !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  return handleLfsRequest(
    req,
    { ...t.env, ...opts.env } as CloudflareBindings,
    ctx
  );
}

/** A file's LFS identity: oid is the SHA-256 of its content. */
async function blob(content: string) {
  return {
    content,
    oid: await sha256Hex(content),
    size: new TextEncoder().encode(content).length,
  };
}

async function setup() {
  const t = makeEnv();
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', addReadme: true, visibility: 'internal' },
  });
  const repoId = [...t.fake.repos.values()][0].name.slice(2);
  return { t, admin, token: await pat(t, admin), repoId };
}

type Batch = {
  objects: {
    oid: string;
    size: number;
    actions?: Record<string, { href: string; header?: Record<string, string> }>;
    error?: { code: number };
  }[];
};

describe('Git LFS batch API', () => {
  it('challenges unauthenticated clients with a JSON body', async () => {
    const { t } = await setup();
    const res = await lfs(t, '/objects/batch', {
      json: { operation: 'download', objects: [] },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
    expect(res.headers.get('Content-Type')).toBe(
      'application/vnd.git-lfs+json'
    );
  });

  it('hands out a pre-signed, checksum-bound upload URL plus a verify action', async () => {
    const { t, token, repoId } = await setup();
    const f = await blob('big binary file');
    const res = await lfs(t, '/objects/batch', {
      token,
      json: {
        operation: 'upload',
        transfers: ['basic'],
        objects: [{ oid: f.oid, size: f.size }],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Batch & { transfer: string };
    expect(body.transfer).toBe('basic');
    const { upload, verify } = body.objects[0].actions!;
    const href = new URL(upload.href);
    expect(href.host).toBe(
      '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com'
    );
    expect(href.pathname).toBe(`/gitorange-lfs-test/lfs/${repoId}/${f.oid}`);
    expect(href.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(href.searchParams.get('X-Amz-SignedHeaders')).toContain(
      'x-amz-checksum-sha256'
    );
    expect(upload.header!['x-amz-checksum-sha256']).toBe(
      btoa(
        String.fromCharCode(...f.oid.match(/../g)!.map((h) => parseInt(h, 16)))
      )
    );
    expect(verify.href).toBe(`http://test.local${PATH}/objects/verify`);
  });

  it('records an object only once verify confirms it is in storage', async () => {
    const { t, token, repoId } = await setup();
    const f = await blob('hello lfs');
    const verify = () =>
      lfs(t, '/objects/verify', { token, json: { oid: f.oid, size: f.size } });
    expect((await verify()).status).toBe(422);

    await t.env.LFS.put(`lfs/${repoId}/${f.oid}`, f.content, { sha256: f.oid });
    expect((await verify()).status).toBe(200);

    const again = (await (
      await lfs(t, '/objects/batch', {
        token,
        json: { operation: 'upload', objects: [{ oid: f.oid, size: f.size }] },
      })
    ).json()) as Batch;
    expect(again.objects[0].actions).toBeUndefined(); // already stored: nothing to upload

    const down = (await (
      await lfs(t, '/objects/batch', {
        token,
        json: {
          operation: 'download',
          objects: [{ oid: f.oid, size: f.size }],
        },
      })
    ).json()) as Batch;
    expect(new URL(down.objects[0].actions!.download.href).pathname).toBe(
      `/gitorange-lfs-test/lfs/${repoId}/${f.oid}`
    );
  });

  it('rejects verify when the stored object does not match the declared size', async () => {
    const { t, token, repoId } = await setup();
    const f = await blob('size matters');
    await t.env.LFS.put(`lfs/${repoId}/${f.oid}`, f.content);
    const res = await lfs(t, '/objects/verify', {
      token,
      json: { oid: f.oid, size: f.size + 1 },
    });
    expect(res.status).toBe(422);
  });

  it('reports missing and malformed objects per object', async () => {
    const { t, token } = await setup();
    const f = await blob('never uploaded');
    const res = await lfs(t, '/objects/batch', {
      token,
      json: {
        operation: 'download',
        objects: [
          { oid: f.oid, size: f.size },
          { oid: 'nope', size: 1 },
        ],
      },
    });
    const body = (await res.json()) as Batch;
    expect(body.objects.map((o) => o.error?.code)).toEqual([404, 422]);
  });

  it('lets any member download but only writers upload', async () => {
    const { t, admin, repoId } = await setup();
    const bob = await pat(t, await addMember(t, admin, 'bob'));
    const f = await blob('shared asset');
    await t.env.LFS.put(`lfs/${repoId}/${f.oid}`, f.content, { sha256: f.oid });
    const up = await lfs(t, '/objects/batch', {
      token: bob,
      json: { operation: 'upload', objects: [{ oid: f.oid, size: f.size }] },
    });
    expect(up.status).toBe(403);
    expect(
      (
        await lfs(t, '/objects/verify', {
          token: bob,
          json: { oid: f.oid, size: f.size },
        })
      ).status
    ).toBe(403);
    const down = (await (
      await lfs(t, '/objects/batch', {
        token: bob,
        json: {
          operation: 'download',
          objects: [{ oid: f.oid, size: f.size }],
        },
      })
    ).json()) as Batch;
    expect(down.objects[0].actions?.download).toBeDefined();
  });

  it('says LFS is not configured when the R2 secrets are missing', async () => {
    const { t, token } = await setup();
    const res = await lfs(t, '/objects/batch', {
      token,
      json: { operation: 'download', objects: [] },
      env: { R2_ACCESS_KEY_ID: '' },
    });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { message: string }).message).toContain(
      'R2_ACCESS_KEY_ID'
    );
  });

  it('reports no locks and declines to create one', async () => {
    const { t, token } = await setup();
    expect(await (await lfs(t, '/locks', { token })).json()).toEqual({
      locks: [],
    });
    expect(
      await (await lfs(t, '/locks/verify', { token, json: {} })).json()
    ).toEqual({ ours: [], theirs: [] });
    expect(
      (await lfs(t, '/locks', { token, json: { path: 'a.bin' } })).status
    ).toBe(501);
  });
});

describe('Git LFS in the web UI', () => {
  it('detects pointer files, redirects downloads to R2, and deletes objects with the repository', async () => {
    const { t, admin, token, repoId } = await setup();
    const f = await blob('PNG bytes');
    const repo = [...t.fake.repos.values()][0];
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${f.oid}\nsize ${f.size}\n`;
    await commitFiles(
      repo,
      'main',
      { 'logo.png': pointer },
      'Add logo via LFS'
    );

    const before = (await (
      await call(t, '/api/repos/octocat/app/contents?refPath=main/logo.png', {
        cookie: admin,
      })
    ).json()) as { file: { lfs: unknown } };
    expect(before.file.lfs).toEqual({
      oid: f.oid,
      size: f.size,
      stored: false,
    });

    await t.env.LFS.put(`lfs/${repoId}/${f.oid}`, f.content, { sha256: f.oid });
    await lfs(t, '/objects/verify', {
      token,
      json: { oid: f.oid, size: f.size },
    });
    const after = (await (
      await call(t, '/api/repos/octocat/app/contents?refPath=main/logo.png', {
        cookie: admin,
      })
    ).json()) as { file: { lfs: { stored: boolean } } };
    expect(after.file.lfs.stored).toBe(true);

    const dl = await call(
      t,
      `/api/repos/octocat/app/lfs/${f.oid}?filename=logo.png`,
      { cookie: admin }
    );
    expect(dl.status).toBe(302);
    const location = new URL(dl.headers.get('Location')!);
    expect(location.pathname).toBe(
      `/gitorange-lfs-test/lfs/${repoId}/${f.oid}`
    );
    expect(location.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="logo.png"'
    );

    expect(
      (
        await call(t, '/api/repos/octocat/app', {
          cookie: admin,
          method: 'DELETE',
        })
      ).status
    ).toBe(200);
    expect(await t.env.LFS.head(`lfs/${repoId}/${f.oid}`)).toBeNull();
  });
});
