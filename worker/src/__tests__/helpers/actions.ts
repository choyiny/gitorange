import { expect } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { handleGitRequest } from '../../git-http';
import { concat } from '../../git/bytes';
import { FLUSH, pktLine } from '../../git/pktline';
import { buildPack } from '../../git/pack';
import { schema } from '../../db/schema';
import { executeRun, type StepRunner } from '../../actions/executor';
import type {
  JobRunnerApi,
  StepRequest,
  StepResult,
} from '../../actions/job-runner';
import type { RelevanceModelFor } from '../../actions/relevance';
import { bootstrapAdmin, call, makeEnv, settle, type TestEnv } from './app';
import { commitPaths } from './seed';

export const CI = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: build
        run: echo building
      - run: npm test
`;

export type Run = {
  id: string;
  runNumber: number;
  name: string;
  event: string;
  ref: string;
  refName: string;
  pullRequestNumber: number | null;
  headSha: string;
  displayTitle: string;
  actor: { username: string } | null;
  status: string;
  conclusion: string | null;
  errorMessage: string | null;
};
export type Job = {
  id: string;
  name: string;
  status: string;
  conclusion: string | null;
  /** Jobs ahead of this one in the instance's queue; null when it isn't waiting for a slot. */
  queuedAhead: number | null;
  steps: {
    number: number;
    name: string;
    status: string;
    conclusion: string | null;
  }[];
};

export async function pat(t: TestEnv, cookie: string) {
  const res = await call(t, '/api/tokens', {
    cookie,
    json: { name: 'cli', expiresInDays: 30 },
  });
  return ((await res.json()) as { plaintext: string }).plaintext;
}

/** A `git push` through the proxy: objects go into the fake repo, receive-pack moves the ref. */
export async function push(
  t: TestEnv,
  token: string,
  path: string,
  ref: string,
  oldSha: string,
  newSha: string
) {
  const body = concat([
    pktLine(`${oldSha} ${newSha} ${ref}\0report-status\n`),
    FLUSH,
    await buildPack([]),
  ]);
  const res = await handleGitRequest(
    new Request(`http://test.local${path}/git-receive-pack`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`u:${token}`)}`,
        'Content-Type': 'application/x-git-receive-pack-request',
      },
      body,
    }),
    t.env,
    t.ctx
  );
  expect(res.status).toBe(200);
  await settle(t);
}

export async function setup() {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', addReadme: true, visibility: 'internal' },
  });
  const repo = [...t.fake.repos.values()][0];
  const token = await pat(t, admin);
  return { t, admin, repo, token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

/** Commits `files` on `branch` and pushes it through the proxy. Returns the new sha. */
export async function pushFiles(
  s: Setup,
  branch: string,
  files: Record<string, string>,
  message = 'Add CI'
) {
  const old = s.repo.refs.get(`refs/heads/${branch}`) ?? '0'.repeat(40);
  // Build on the branch's tip without moving it; the push moves it.
  const sha = await commitPaths(s.repo, branch, files, message, {
    moveRef: false,
  });
  await push(
    s.t,
    s.token,
    '/octocat/app.git',
    `refs/heads/${branch}`,
    old,
    sha
  );
  return sha;
}

export async function runs(t: TestEnv, cookie: string) {
  const res = await call(t, '/api/repos/octocat/app/actions/runs', { cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    configured: boolean;
    totalCount: number;
    workflows: { path: string; name: string }[];
    runs: Run[];
  };
}

export async function runDetail(t: TestEnv, cookie: string, n: number) {
  const res = await call(t, `/api/repos/octocat/app/actions/runs/${n}`, {
    cookie,
  });
  return (await res.json()) as { run: Run; jobs: Job[] };
}

/**
 * Drives executeRun with a direct-call step and a scripted container. `waitForEvent` polls the
 * events the fake ACTIONS_RUN received (briefly, then times out like a real wait); with
 * `loseEvents` it never sees one, so only rechecks start waiting jobs. With `retrySteps`, a step
 * that throws runs again up to its config's `retries.limit`, like a real Workflow.
 */
export function harness(
  t: TestEnv,
  onStep: (
    req: StepRequest
  ) => Partial<StepResult> | Promise<Partial<StepResult>> = () => ({}),
  opts: {
    loseEvents?: boolean;
    retrySteps?: boolean;
    relevance?: RelevanceModelFor;
  } = {}
) {
  const requests: StepRequest[] = [];
  const destroyed: string[] = [];
  const boots: string[] = [];
  const stepNames: string[] = [];
  const alive = new Set<string>();
  let peak = 0;
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      stepNames.push(name);
      const fn = (b ?? a) as () => Promise<unknown>;
      const retries = opts.retrySteps
        ? ((b ? (a as { retries?: { limit?: number } }) : {}).retries?.limit ??
          0)
        : 0;
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn();
        } catch (e) {
          if (attempt >= retries) throw e;
        }
      }
    },
    waitForEvent: async (name: string, o: { type: string }) => {
      stepNames.push(name);
      for (let i = 0; i < 100; i++) {
        const k = opts.loseEvents
          ? -1
          : t.actions.events.findIndex((e) => e.type === o.type);
        if (k >= 0)
          return { payload: t.actions.events.splice(k, 1)[0].payload };
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`${name}: timed out`);
    },
  } as unknown as StepRunner;
  const runner = (jobId: string): JobRunnerApi => ({
    boot: async () => {
      boots.push(jobId);
      alive.add(jobId);
      peak = Math.max(peak, alive.size);
      return { ms: 420 };
    },
    runStep: async (req) => {
      requests.push(req);
      const scripted = await onStep(req);
      return {
        exitCode: 0,
        timedOut: false,
        log: `ran ${req.argv[req.argv.length - 1].split('\n')[0]}`,
        outputs: {},
        envAdds: {},
        pathAdds: [],
        ...scripted,
      };
    },
    destroy: async () => {
      destroyed.push(jobId);
      alive.delete(jobId);
    },
  });
  const run = (runId: string) =>
    executeRun(
      {
        env: t.env,
        db: drizzle(t.env.DB, { schema }),
        step,
        runner,
        restartDelayMs: 0,
        relevance: opts.relevance,
      },
      runId
    );
  return { run, requests, destroyed, boots, stepNames, peak: () => peak };
}

export const script = (r: StepRequest) => r.argv[r.argv.length - 1];

/** The outputs a gitorange/relevance step writes to $GITHUB_OUTPUT, as the real runner reports them. */
export function scriptOutputs(r: StepRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of script(r).matchAll(
    /^echo '([A-Za-z0-9_-]+)=(true|false)' >> "\$GITHUB_OUTPUT"$/gm
  ))
    out[m[1]] = m[2];
  return out;
}

/** What a gitorange/relevance step prints: its `echo '…'` lines, as the real runner logs them. */
export function scriptLog(r: StepRequest): string {
  return [...script(r).matchAll(/^echo '((?:[^']|'\\'')*)'$/gm)]
    .map((m) => m[1].replace(/'\\''/g, "'"))
    .join('\n');
}
