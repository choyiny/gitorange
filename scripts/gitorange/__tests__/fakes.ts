import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cloudflare } from '../cloudflare.ts';
import type { RunOptions, RunResult, Runner } from '../runner.ts';

type Handler = (args: string[]) => RunResult | Promise<RunResult>;

/**
 * A Runner driven by a script keyed by `cmd` or `cmd arg0` (the more specific key wins).
 * Unscripted commands fail loudly.
 */
export function fakeRunner(script: Record<string, Handler>): Runner & {
  calls: Array<{ cmd: string; args: string[]; opts?: RunOptions }>;
} {
  const calls: Array<{ cmd: string; args: string[]; opts?: RunOptions }> = [];
  return {
    calls,
    async run(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      const handler = script[`${cmd} ${args[0] ?? ''}`.trim()] ?? script[cmd];
      if (!handler)
        throw new Error(`fakeRunner: unscripted ${cmd} ${args.join(' ')}`);
      return handler(args);
    },
  };
}

export interface FakeCloudflareSeed {
  accounts?: { id: string; name: string }[];
  d1?: { uuid: string; name: string }[];
  /** bucket name -> objects (key -> body) */
  r2?: Record<string, Record<string, string>>;
  workflows?: { name: string; scriptName: string }[];
  /** script name -> plain_text vars; absent script = 404 */
  workerVars?: Record<string, Record<string, string>>;
  zones?: { id: string; name: string; status: string }[];
  subdomain?: string | null;
  doNamespaces?: { id: string; script: string; class: string }[];
  workerDomains?: { hostname: string; service: string }[];
  artifactsNamespaces?: string[];
  /** zone id -> DNS records */
  dnsRecords?: Record<
    string,
    { name: string; type: string; content: string }[]
  >;
  /** zone id -> Workers routes */
  routes?: Record<string, { pattern: string; script: string | null }[]>;
  /**
   * D1 uuid -> names in its `d1_migrations` table, answered to `SELECT name FROM d1_migrations`;
   * a uuid without an entry has no such table (the query fails like D1's).
   */
  d1Migrations?: Record<string, string[]>;
  /** D1 uuid -> its other table names, answered to `SELECT name FROM sqlite_master …`. */
  d1Tables?: Record<string, string[]>;
}

export type FakeCloudflare = Cloudflare & {
  calls: Array<{ method: string; args: unknown[] }>;
  /** Make the next call to `method` reject with `error`. */
  failNext(method: keyof Cloudflare, error: Error): void;
  /** Mutable state, for assertions. */
  state: {
    d1: { uuid: string; name: string; queries: string[] }[];
    r2: Record<string, Record<string, string>>;
    lifecycle: Record<string, unknown[]>;
  };
};

/** In-memory Cloudflare REST fake with seedable state, a call log and one-shot failures. */
export function fakeCloudflare(seed: FakeCloudflareSeed = {}): FakeCloudflare {
  const calls: FakeCloudflare['calls'] = [];
  const failures = new Map<string, Error[]>();
  const state: FakeCloudflare['state'] = {
    d1: (seed.d1 ?? []).map((d) => ({ ...d, queries: [] })),
    r2: structuredClone(seed.r2 ?? {}),
    lifecycle: {},
  };
  let nextId = 1;

  async function enter(method: keyof Cloudflare, args: unknown[]) {
    calls.push({ method, args });
    const err = failures.get(method)?.shift();
    if (err) throw err;
  }

  const fake: FakeCloudflare = {
    calls,
    state,
    failNext(method, error) {
      failures.set(method, [...(failures.get(method) ?? []), error]);
    },
    async listAccounts() {
      await enter('listAccounts', []);
      return seed.accounts ?? [];
    },
    async workersSubdomain(a) {
      await enter('workersSubdomain', [a]);
      return seed.subdomain ?? null;
    },
    async findZone(a, hostname) {
      await enter('findZone', [a, hostname]);
      const labels = hostname.split('.');
      for (let i = 0; i <= labels.length - 2; i++) {
        const name = labels.slice(i).join('.');
        const z = (seed.zones ?? []).find((x) => x.name === name);
        if (z) return z;
      }
      return null;
    },
    async workerDomains(a) {
      await enter('workerDomains', [a]);
      return seed.workerDomains ?? [];
    },
    async dnsRecords(zoneId, name) {
      await enter('dnsRecords', [zoneId, name]);
      return (seed.dnsRecords?.[zoneId] ?? [])
        .filter((r) => r.name.toLowerCase() === name.toLowerCase())
        .map(({ type, content }) => ({ type, content }));
    },
    async workerRoutes(zoneId) {
      await enter('workerRoutes', [zoneId]);
      return seed.routes?.[zoneId] ?? [];
    },
    async r2IsEmpty(a, bucket) {
      await enter('r2IsEmpty', [a, bucket]);
      const b = state.r2[bucket];
      if (!b) throw new Error(`fakeCloudflare: no bucket ${bucket}`);
      return Object.keys(b).length === 0;
    },
    async listArtifactsNamespaces(a) {
      await enter('listArtifactsNamespaces', [a]);
      return seed.artifactsNamespaces ?? [];
    },
    async listD1(a) {
      await enter('listD1', [a]);
      return state.d1.map(({ uuid, name }) => ({ uuid, name }));
    },
    async createD1(a, name) {
      await enter('createD1', [a, name]);
      const uuid = `d1-${nextId++}`;
      state.d1.push({ uuid, name, queries: [] });
      return { uuid };
    },
    async queryD1(a, id, sql, params) {
      await enter('queryD1', [a, id, sql, params]);
      const db = state.d1.find((d) => d.uuid === id);
      if (!db) throw new Error(`fakeCloudflare: no D1 ${id}`);
      db.queries.push(sql);
      if (/^SELECT name FROM d1_migrations/.test(sql)) {
        const names = seed.d1Migrations?.[id];
        if (!names)
          throw new Error('no such table: d1_migrations: SQLITE_ERROR');
        return names.map((name) => ({ name }));
      }
      if (/^SELECT name FROM sqlite_master/.test(sql)) {
        return (seed.d1Tables?.[id] ?? []).map((name) => ({ name }));
      }
      return [];
    },
    async listR2(a) {
      await enter('listR2', [a]);
      return Object.keys(state.r2);
    },
    async createR2(a, name) {
      await enter('createR2', [a, name]);
      state.r2[name] ??= {};
    },
    async putR2Lifecycle(a, bucket, rules) {
      await enter('putR2Lifecycle', [a, bucket, rules]);
      state.lifecycle[bucket] = rules;
    },
    async getR2Object(a, bucket, key) {
      await enter('getR2Object', [a, bucket, key]);
      return state.r2[bucket]?.[key] ?? null;
    },
    async putR2Object(a, bucket, key, body) {
      await enter('putR2Object', [a, bucket, key, body]);
      const b = state.r2[bucket];
      if (!b) throw new Error(`fakeCloudflare: no bucket ${bucket}`);
      b[key] = body;
    },
    async listWorkflows(a) {
      await enter('listWorkflows', [a]);
      return seed.workflows ?? [];
    },
    async workerVars(a, script) {
      await enter('workerVars', [a, script]);
      return seed.workerVars?.[script] ?? null;
    },
    async durableObjectNamespaces(a) {
      await enter('durableObjectNamespaces', [a]);
      return seed.doNamespaces ?? [];
    },
  };
  return fake;
}

/**
 * A temp gitorange package under `dir` (package.json, worker/build.json, a wrangler package with a bin).
 * "nested": wrangler under <root>/node_modules; "hoisted": beside the package, as npx installs it.
 * Returns the package root.
 */
export function fakePackage(
  dir: string,
  o: {
    version: string;
    commit: string;
    wranglerLayout?: 'nested' | 'hoisted';
  }
): string {
  const hoisted = o.wranglerLayout === 'hoisted';
  const root = hoisted
    ? join(dir, 'node_modules', 'gitorange')
    : join(dir, 'gitorange');
  const wranglerDir = hoisted
    ? join(dir, 'node_modules', 'wrangler')
    : join(root, 'node_modules', 'wrangler');
  const put = (p: string, text: string) => {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  };
  put(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'gitorange',
      version: o.version,
      gitorangeCommit: o.commit,
    })
  );
  put(
    join(root, 'worker', 'build.json'),
    JSON.stringify({
      no_bundle: true,
      rules: [{ type: 'ESModule', globs: ['**/*.js'] }],
    })
  );
  put(
    join(wranglerDir, 'package.json'),
    JSON.stringify({
      name: 'wrangler',
      version: '4.127.0',
      bin: { wrangler: './bin/wrangler.js' },
    })
  );
  put(join(wranglerDir, 'bin', 'wrangler.js'), '');
  return root;
}
