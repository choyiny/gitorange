import type { Cloudflare } from '../cloudflare.ts';
import type { RunResult, Runner } from '../runner.ts';

type Handler = (args: string[]) => RunResult | Promise<RunResult>;

/**
 * A Runner driven by a script keyed by `cmd` or `cmd arg0` (the more specific key wins).
 * Unscripted commands fail loudly.
 */
export function fakeRunner(
  script: Record<string, Handler>
): Runner & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return {
    calls,
    async run(cmd, args) {
      calls.push({ cmd, args });
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
