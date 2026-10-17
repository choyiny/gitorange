// Typed Cloudflare REST client for the installer. Never logs or echoes the token.

export class CloudflareError extends Error {
  status: number;
  codes: number[];
  path: string;
  constructor(message: string, status: number, codes: number[], path: string) {
    super(message);
    this.name = 'CloudflareError';
    this.status = status;
    this.codes = codes;
    this.path = path;
  }
}

export interface LifecycleRule {
  id: string;
  prefix: string;
  days: number;
}

export interface Cloudflare {
  listAccounts(): Promise<{ id: string; name: string }[]>;
  workersSubdomain(a: string): Promise<string | null>;
  findZone(
    a: string,
    hostname: string
  ): Promise<{ id: string; name: string; status: string } | null>;
  workerDomains(a: string): Promise<{ hostname: string; service: string }[]>;
  listArtifactsNamespaces(a: string): Promise<string[]>;
  listD1(a: string): Promise<{ uuid: string; name: string }[]>;
  createD1(a: string, name: string): Promise<{ uuid: string }>;
  queryD1(
    a: string,
    id: string,
    sql: string,
    params?: unknown[]
  ): Promise<Record<string, unknown>[]>;
  listR2(a: string): Promise<string[]>;
  createR2(a: string, name: string): Promise<void>;
  putR2Lifecycle(
    a: string,
    bucket: string,
    rules: LifecycleRule[]
  ): Promise<void>;
  getR2Object(a: string, bucket: string, key: string): Promise<string | null>;
  putR2Object(
    a: string,
    bucket: string,
    key: string,
    body: string
  ): Promise<void>;
  listWorkflows(a: string): Promise<{ name: string; scriptName: string }[]>;
  workerVars(a: string, script: string): Promise<Record<string, string> | null>;
  durableObjectNamespaces(
    a: string
  ): Promise<{ id: string; script: string; class: string }[]>;
}

export interface RestOptions {
  /** Injectable so tests never wait. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

interface Envelope {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: unknown;
  result_info?: {
    page?: number;
    total_pages?: number;
    cursor?: string;
  };
}

const BASE = 'https://api.cloudflare.com/client/v4';
const enc = encodeURIComponent;

export function restCloudflare(
  token: string,
  fetchImpl: typeof fetch = fetch,
  options: RestOptions = {}
): Cloudflare {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? 30_000;

  /** One HTTP exchange. GETs retry up to 3 times on 429/5xx; everything else is sent once. */
  async function send(
    method: string,
    path: string,
    init: { query?: Record<string, string>; body?: string; json?: unknown }
  ): Promise<Response> {
    const qs = init.query ? `?${new URLSearchParams(init.query)}` : '';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    let body = init.body;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    const retries = method === 'GET' ? 3 : 0;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(`${BASE}${path}${qs}`, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new CloudflareError(
          `Cloudflare request failed: ${e instanceof Error ? e.message : String(e)}`,
          0,
          [],
          path
        );
      }
      if (attempt < retries && (res.status === 429 || res.status >= 500)) {
        const ra = Number(res.headers.get('Retry-After'));
        const wait =
          Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt;
        await sleep(Math.min(wait, 10_000));
        continue;
      }
      return res;
    }
  }

  async function envelope(res: Response, path: string): Promise<Envelope> {
    let env: Envelope | null = null;
    try {
      env = (await res.json()) as Envelope;
    } catch {
      env = null;
    }
    if (!res.ok || !env || env.success !== true) {
      const errors = env?.errors ?? [];
      const msg =
        errors
          .map((e) => e.message)
          .filter(Boolean)
          .join('; ') || `HTTP ${res.status}`;
      throw new CloudflareError(
        `Cloudflare ${path}: ${msg}`,
        res.status,
        errors.map((e) => e.code).filter((c): c is number => c !== undefined),
        path
      );
    }
    return env;
  }

  async function call<T>(
    method: string,
    path: string,
    init: { query?: Record<string, string>; json?: unknown } = {}
  ): Promise<T> {
    const res = await send(method, path, init);
    return (await envelope(res, path)).result as T;
  }

  /**
   * GET a list, following result_info pages (page/total_pages) or cursor. `perPage` is sent only
   * where the endpoint documents it; the first request carries no page parameter.
   */
  async function list<T>(
    path: string,
    opts: { perPage?: number; pick?: (result: unknown) => T[] } = {}
  ): Promise<T[]> {
    const pick = opts.pick ?? ((r: unknown) => r as T[]);
    const out: T[] = [];
    let page = 1;
    let cursor: string | undefined;
    for (;;) {
      const q: Record<string, string> = {};
      if (opts.perPage) q.per_page = String(opts.perPage);
      if (cursor) q.cursor = cursor;
      else if (page > 1) q.page = String(page);
      const res = await send('GET', path, { query: q });
      const env = await envelope(res, path);
      out.push(...pick(env.result));
      const info = env.result_info;
      // A repeated cursor means the server is not advancing; stop rather than loop forever.
      if (info?.cursor && info.cursor !== cursor) {
        cursor = info.cursor;
        continue;
      }
      if (!info?.cursor && info?.total_pages && page < info.total_pages) {
        page++;
        continue;
      }
      return out;
    }
  }

  /** Like call(), but a 404 resolves to null. */
  async function orNull<T>(path: string): Promise<T | null> {
    try {
      return await call<T>('GET', path);
    } catch (e) {
      if (e instanceof CloudflareError && e.status === 404) return null;
      throw e;
    }
  }

  const objectPath = (a: string, bucket: string, key: string) =>
    `/accounts/${a}/r2/buckets/${enc(bucket)}/objects/${key.split('/').map(enc).join('/')}`;

  return {
    // GET /accounts (Cloudflare API docs; per_page max 50).
    async listAccounts() {
      const rows = await list<{ id: string; name: string }>('/accounts', {
        perPage: 50,
      });
      return rows.map((r) => ({ id: r.id, name: r.name }));
    },

    // GET /accounts/{a}/workers/subdomain (wrangler cloudflare@5.2 resources/workers/subdomains); 404 = none registered.
    async workersSubdomain(a) {
      const r = await orNull<{ subdomain?: string }>(
        `/accounts/${a}/workers/subdomain`
      );
      return r?.subdomain ?? null;
    },

    // GET /zones?account.id=&name= (Cloudflare API docs; spec §4). Walks labels upward, first hit wins.
    async findZone(a, hostname) {
      const labels = hostname.toLowerCase().split('.');
      for (let i = 0; i <= labels.length - 2; i++) {
        const name = labels.slice(i).join('.');
        const zones = await call<
          { id: string; name: string; status: string }[]
        >('GET', '/zones', { query: { 'account.id': a, name } });
        const z = zones[0];
        if (z) return { id: z.id, name: z.name, status: z.status };
      }
      return null;
    },

    // GET /accounts/{a}/workers/domains (wrangler cloudflare@5.2 resources/workers/domains).
    async workerDomains(a) {
      const rows = await list<{ hostname: string; service: string }>(
        `/accounts/${a}/workers/domains`
      );
      return rows.map((r) => ({ hostname: r.hostname, service: r.service }));
    },

    // GET /accounts/{a}/artifacts/namespaces (wrangler src/artifacts/client.ts getArtifactsNamespacesPath; item shape `namespace` per formatNamespaceDetails).
    async listArtifactsNamespaces(a) {
      const rows = await list<{ namespace: string }>(
        `/accounts/${a}/artifacts/namespaces`
      );
      return rows.map((r) => r.namespace);
    },

    // GET /accounts/{a}/d1/database (wrangler cloudflare@5.2 resources/d1/database).
    async listD1(a) {
      const rows = await list<{ uuid: string; name: string }>(
        `/accounts/${a}/d1/database`,
        { perPage: 100 }
      );
      return rows.map((r) => ({ uuid: r.uuid, name: r.name }));
    },

    // POST /accounts/{a}/d1/database {name} (wrangler cloudflare@5.2 resources/d1/database create). Not retried.
    async createD1(a, name) {
      const r = await call<{ uuid: string }>(
        'POST',
        `/accounts/${a}/d1/database`,
        { json: { name } }
      );
      return { uuid: r.uuid };
    },

    // POST /accounts/{a}/d1/database/{id}/query {sql, params}; result is one entry per statement, `results` holds rows (wrangler cloudflare@5.2 resources/d1/database query).
    async queryD1(a, id, sql, params) {
      const r = await call<{ results?: Record<string, unknown>[] }[]>(
        'POST',
        `/accounts/${a}/d1/database/${enc(id)}/query`,
        { json: { sql, params: params ?? [] } }
      );
      return r[0]?.results ?? [];
    },

    // GET /accounts/{a}/r2/buckets -> { buckets: [{ name }] } (wrangler src/r2/helpers/bucket.ts listR2Buckets).
    async listR2(a) {
      const rows = await list<{ name: string }>(`/accounts/${a}/r2/buckets`, {
        perPage: 1000,
        pick: (r) => (r as { buckets?: { name: string }[] }).buckets ?? [],
      });
      return rows.map((b) => b.name);
    },

    // POST /accounts/{a}/r2/buckets {name} (wrangler src/r2/helpers/bucket.ts createR2Bucket). Not retried.
    async createR2(a, name) {
      await call('POST', `/accounts/${a}/r2/buckets`, { json: { name } });
    },

    // PUT /accounts/{a}/r2/buckets/{b}/lifecycle {rules} (wrangler putLifecycleRules; rule shape from `r2 bucket lifecycle add`: Age maxAge is seconds). Not retried. REPLACES the bucket's whole rule set: use on installer-owned buckets only.
    async putR2Lifecycle(a, bucket, rules) {
      await call('PUT', `/accounts/${a}/r2/buckets/${enc(bucket)}/lifecycle`, {
        json: {
          rules: rules.map((r) => ({
            id: r.id,
            enabled: true,
            conditions: { prefix: r.prefix },
            deleteObjectsTransition: {
              condition: { type: 'Age', maxAge: r.days * 86400 },
            },
          })),
        },
      });
    },

    // GET /accounts/{a}/r2/buckets/{b}/objects/{key} returns the raw object, not an envelope; 404 -> null (wrangler getR2Object).
    async getR2Object(a, bucket, key) {
      const path = objectPath(a, bucket, key);
      const res = await send('GET', path, {});
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new CloudflareError(
          `Cloudflare ${path}: HTTP ${res.status}`,
          res.status,
          [],
          path
        );
      }
      return res.text();
    },

    // PUT /accounts/{a}/r2/buckets/{b}/objects/{key} with the raw body (wrangler putR2Object). Not retried.
    async putR2Object(a, bucket, key, body) {
      const path = objectPath(a, bucket, key);
      const res = await send('PUT', path, { body });
      if (!res.ok) {
        throw new CloudflareError(
          `Cloudflare ${path}: HTTP ${res.status}`,
          res.status,
          [],
          path
        );
      }
    },

    // GET /accounts/{a}/workflows (wrangler `workflows list`, src/workflows/commands/list.ts; fields name, script_name).
    async listWorkflows(a) {
      const rows = await list<{ name: string; script_name: string }>(
        `/accounts/${a}/workflows`,
        { perPage: 100 }
      );
      return rows.map((r) => ({ name: r.name, scriptName: r.script_name }));
    },

    // GET /accounts/{a}/workers/scripts/{s}/settings -> { bindings: [{ type: 'plain_text', name, text }] } (wrangler cloudflare@5.2 resources/workers/scripts/settings); 404 -> null. Only plain_text vars are returned, so GITORANGE_INSTALLATION must be written as a string var.
    async workerVars(a, script) {
      const r = await orNull<{
        bindings?: { type: string; name: string; text?: string }[];
      }>(`/accounts/${a}/workers/scripts/${enc(script)}/settings`);
      if (!r) return null;
      const vars: Record<string, string> = {};
      for (const b of r.bindings ?? []) {
        if (b.type === 'plain_text' && typeof b.text === 'string')
          vars[b.name] = b.text;
      }
      return vars;
    },

    // GET /accounts/{a}/workers/durable_objects/namespaces (wrangler listDurableObjects; mapped to vars in apply-steps.ts DO_VARS).
    async durableObjectNamespaces(a) {
      const rows = await list<{ id: string; script: string; class: string }>(
        `/accounts/${a}/workers/durable_objects/namespaces`,
        { perPage: 1000 }
      );
      return rows.map((r) => ({ id: r.id, script: r.script, class: r.class }));
    },
  };
}
