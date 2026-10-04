import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { handleGitRequest } from '../git-http';
import { concat } from '../git/bytes';
import { FLUSH, pktLine } from '../git/pktline';
import { buildPack } from '../git/pack';
import { schema } from '../db/schema';
import { executeRun, type StepRunner } from '../actions/executor';
import type {
  JobRunnerApi,
  StepRequest,
  StepResult,
} from '../actions/job-runner';
import {
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
  addMember,
  type TestEnv,
} from './helpers/app';
import { commitPaths } from './helpers/seed';

const CI = `name: CI
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

type Run = {
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
type Job = {
  id: string;
  name: string;
  status: string;
  conclusion: string | null;
  steps: {
    number: number;
    name: string;
    status: string;
    conclusion: string | null;
  }[];
};

async function pat(t: TestEnv, cookie: string) {
  const res = await call(t, '/api/tokens', {
    cookie,
    json: { name: 'cli', expiresInDays: 30 },
  });
  return ((await res.json()) as { plaintext: string }).plaintext;
}

/**
 * A real `git push` through the proxy: the objects are put in the fake repo first, then the
 * receive-pack request moves the ref, exactly as git would after uploading the pack.
 */
async function push(
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

async function setup() {
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

/** Commits `files` on `branch` and pushes it through the proxy. Returns the new sha. */
async function pushFiles(
  s: Awaited<ReturnType<typeof setup>>,
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

async function runs(t: TestEnv, cookie: string) {
  const res = await call(t, '/api/repos/octocat/app/actions/runs', { cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    configured: boolean;
    totalCount: number;
    workflows: { path: string; name: string }[];
    runs: Run[];
  };
}

async function runDetail(t: TestEnv, cookie: string, n: number) {
  const res = await call(t, `/api/repos/octocat/app/actions/runs/${n}`, {
    cookie,
  });
  return (await res.json()) as { run: Run; jobs: Job[] };
}

/** Drives executeRun with a direct-call step and a scripted container. */
function harness(
  t: TestEnv,
  onStep: (req: StepRequest) => Partial<StepResult> = () => ({})
) {
  const requests: StepRequest[] = [];
  const destroyed: string[] = [];
  const step = {
    do: async (_name: string, a: unknown, b?: unknown) =>
      ((b ?? a) as () => Promise<unknown>)(),
  } as unknown as StepRunner;
  const runner = (jobId: string): JobRunnerApi => ({
    boot: async () => ({ ms: 420 }),
    runStep: async (req) => {
      requests.push(req);
      return {
        exitCode: 0,
        timedOut: false,
        log: `ran ${req.argv[req.argv.length - 1].split('\n')[0]}`,
        outputs: {},
        envAdds: {},
        pathAdds: [],
        ...onStep(req),
      };
    },
    destroy: async () => void destroyed.push(jobId),
  });
  const run = (runId: string) =>
    executeRun(
      { env: t.env, db: drizzle(t.env.DB, { schema }), step, runner },
      runId
    );
  return { run, requests, destroyed };
}

const script = (r: StepRequest) => r.argv[r.argv.length - 1];

describe('Actions triggers', () => {
  it('queues a run when a push adds a workflow, and starts its Workflow', async () => {
    const s = await setup();
    const sha = await pushFiles(s, 'main', {
      '.github/workflows/ci.yml': CI,
      'README.md': '# app',
    });
    const list = await runs(s.t, s.admin);
    expect(list.configured).toBe(true);
    expect(list.workflows).toEqual([
      { path: '.github/workflows/ci.yml', name: 'CI' },
    ]);
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]).toMatchObject({
      runNumber: 1,
      name: 'CI',
      event: 'push',
      refName: 'main',
      headSha: sha,
      displayTitle: 'Add CI',
      actor: { username: 'octocat' },
      status: 'queued',
    });
    expect(s.t.actions.started).toEqual([
      { id: list.runs[0].id, params: { runId: list.runs[0].id } },
    ]);

    const { jobs } = await runDetail(s.t, s.admin, 1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].steps.map((x) => x.name)).toEqual([
      'Set up job',
      'Run actions/checkout@v4',
      'Run echo building',
      'Run npm test',
      'Complete job',
    ]);
  });

  it('respects branch filters and ignores pushes without workflows', async () => {
    const s = await setup();
    await pushFiles(s, 'main', { 'README.md': 'no workflows' });
    await pushFiles(s, 'feature', { '.github/workflows/ci.yml': CI });
    expect((await runs(s.t, s.admin)).totalCount).toBe(0);
    expect(s.t.actions.started).toHaveLength(0);
  });

  it('records an invalid workflow file as a failed run without starting it', async () => {
    const s = await setup();
    await pushFiles(s, 'main', {
      '.github/workflows/bad.yml': 'on: push\njobs:\n  a:\n    steps: []\n',
    });
    const [run] = (await runs(s.t, s.admin)).runs;
    expect(run).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect(run.errorMessage).toContain(
      'Invalid workflow file: .github/workflows/bad.yml'
    );
    expect(s.t.actions.started).toHaveLength(0);
  });

  it('runs pull_request workflows when a PR opens and when its branch moves', async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    await pushFiles(s, 'feature', {
      '.github/workflows/ci.yml': CI,
      'a.txt': 'one',
    });
    const pr = await call(s.t, '/api/repos/octocat/app/pulls', {
      cookie: s.admin,
      json: { title: 'Add a', base: 'main', head: 'feature' },
    });
    expect(pr.status).toBe(201);
    await settle(s.t);
    let list = await runs(s.t, s.admin);
    expect(list.runs[0]).toMatchObject({
      event: 'pull_request',
      pullRequestNumber: 1,
      displayTitle: 'Add a',
    });

    const head = await pushFiles(s, 'feature', {
      '.github/workflows/ci.yml': CI,
      'a.txt': 'two',
    });
    list = await runs(s.t, s.admin);
    // The feature push itself does not match `branches: [main]`; the PR sync does.
    expect(list.runs.map((r) => [r.event, r.headSha])).toEqual([
      ['pull_request', head],
      ['pull_request', expect.any(String)],
      ['push', expect.any(String)],
    ]);
  });

  it('runs push workflows for the base branch after a merge', async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    await pushFiles(s, 'feature', {
      '.github/workflows/ci.yml': CI,
      'b.txt': 'b',
    });
    await call(s.t, '/api/repos/octocat/app/pulls', {
      cookie: s.admin,
      json: { title: 'Add b', base: 'main', head: 'feature' },
    });
    await settle(s.t);
    const merged = await call(s.t, '/api/repos/octocat/app/pulls/1/merge', {
      cookie: s.admin,
      json: { method: 'rebase' },
    });
    expect(merged.status).toBe(200);
    const { sha } = (await merged.json()) as { sha: string };
    await settle(s.t);
    const [latest] = (await runs(s.t, s.admin)).runs;
    expect(latest).toMatchObject({
      event: 'push',
      refName: 'main',
      headSha: sha,
    });
  });

  it('does nothing when Actions is not configured', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', addReadme: true },
    });
    const repo = [...t.fake.repos.values()][0];
    const old = repo.refs.get('refs/heads/main')!;
    const sha = await commitPaths(
      repo,
      'main',
      { '.github/workflows/ci.yml': CI },
      'CI',
      { moveRef: false }
    );
    await push(
      t,
      await pat(t, admin),
      '/octocat/app.git',
      'refs/heads/main',
      old,
      sha
    );
    const list = await runs(t, admin);
    expect(list).toMatchObject({ configured: false, totalCount: 0 });
  });
});

describe('Actions execution', () => {
  it('runs steps in order, checks out with a masked token, and stores logs', async () => {
    const s = await setup();
    const sha = await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const h = harness(s.t);
    expect(await h.run(queued.id)).toBe('success');

    const checkout = h.requests[0];
    expect(script(checkout)).toContain('git -c http.extraHeader');
    expect(checkout.env.TARGET).toBe(sha);
    expect(checkout.env.PUBLIC_URL).toBe('http://test.local/octocat/app.git');
    expect(checkout.masks).toEqual([checkout.env.GITORANGE_TOKEN]);
    expect(h.requests.slice(1).map(script)).toEqual([
      'echo building',
      'npm test',
    ]);
    expect(h.requests[1]).toMatchObject({ cwd: '/workspace' });
    expect(h.requests[1].env).toMatchObject({
      CI: 'true',
      GITHUB_SHA: sha,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'octocat/app',
      GITHUB_ACTOR: 'octocat',
    });

    const { run, jobs } = await runDetail(s.t, s.admin, 1);
    expect(run).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect(jobs[0]).toMatchObject({
      status: 'completed',
      conclusion: 'success',
    });
    expect(jobs[0].steps.every((x) => x.conclusion === 'success')).toBe(true);
    expect(h.destroyed).toEqual([jobs[0].id]);

    const log = await call(
      s.t,
      `/api/repos/octocat/app/actions/runs/1/jobs/${jobs[0].id}/steps/3/logs`,
      { cookie: s.admin }
    );
    expect(await log.text()).toBe('ran echo building');
    const setupLog = await call(
      s.t,
      `/api/repos/octocat/app/actions/runs/1/jobs/${jobs[0].id}/steps/1/logs`,
      { cookie: s.admin }
    );
    expect(await setupLog.text()).toContain('standard-2');
  });

  it('skips later steps after a failure but runs if: always() steps', async () => {
    const s = await setup();
    await pushFiles(s, 'main', {
      '.github/workflows/ci.yml': `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: exit 1
      - run: echo never
      - if: always()
        run: echo cleanup
      - if: failure()
        run: echo report
`,
    });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const h = harness(s.t, (r) =>
      script(r) === 'exit 1' ? { exitCode: 1, log: 'boom' } : {}
    );
    expect(await h.run(queued.id)).toBe('failure');
    expect(h.requests.map(script)).toEqual([
      'exit 1',
      'echo cleanup',
      'echo report',
    ]);
    const { run, jobs } = await runDetail(s.t, s.admin, 1);
    expect(run.conclusion).toBe('failure');
    expect(jobs[0].steps.map((x) => x.conclusion)).toEqual([
      'success',
      'failure',
      'skipped',
      'success',
      'success',
      'success',
    ]);
    const log = await call(
      s.t,
      `/api/repos/octocat/app/actions/runs/1/jobs/${jobs[0].id}/steps/2/logs`,
      { cookie: s.admin }
    );
    expect(await log.text()).toContain('Process completed with exit code 1');
  });

  it('passes outputs, GITHUB_ENV, and needs between steps and jobs', async () => {
    const s = await setup();
    await pushFiles(s, 'main', {
      '.github/workflows/ci.yml': `on: push
env:
  GREETING: hello
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.v.outputs.version }}
    steps:
      - id: v
        run: echo "version=1.2.3" >> "$GITHUB_OUTPUT"
      - run: echo "\${{ steps.v.outputs.version }} \${{ env.GREETING }} $FROM_ENV"
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo "deploying \${{ needs.build.outputs.version }}"
`,
    });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const h = harness(s.t, (r) =>
      script(r).includes('GITHUB_OUTPUT')
        ? { outputs: { version: '1.2.3' }, envAdds: { FROM_ENV: 'set' } }
        : {}
    );
    expect(await h.run(queued.id)).toBe('success');
    expect(h.requests.map(script)).toEqual([
      'echo "version=1.2.3" >> "$GITHUB_OUTPUT"',
      'echo "1.2.3 hello $FROM_ENV"',
      'echo "deploying 1.2.3"',
    ]);
    expect(h.requests[1].env.FROM_ENV).toBe('set');
    expect(h.requests[1].env.GREETING).toBe('hello');
  });

  it('skips jobs whose needs failed and runs matrix jobs separately', async () => {
    const s = await setup();
    await pushFiles(s, 'main', {
      '.github/workflows/ci.yml': `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - run: test-\${{ matrix.node }}
  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: deploy
`,
    });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const h = harness(s.t, (r) =>
      script(r) === 'test-22' ? { exitCode: 1 } : {}
    );
    expect(await h.run(queued.id)).toBe('failure');
    expect(h.requests.map(script).sort()).toEqual(['test-20', 'test-22']);
    const { jobs } = await runDetail(s.t, s.admin, 1);
    const byName = Object.fromEntries(jobs.map((j) => [j.name, j.conclusion]));
    expect(byName).toEqual({
      'test (20)': 'success',
      'test (22)': 'failure',
      deploy: 'skipped',
    });
  });

  it('fails clearly on actions it cannot run, unless continue-on-error', async () => {
    const s = await setup();
    await pushFiles(s, 'main', {
      '.github/workflows/ci.yml': `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        continue-on-error: true
      - uses: some/action@v1
      - run: echo after
`,
    });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const h = harness(s.t);
    expect(await h.run(queued.id)).toBe('failure');
    expect(h.requests).toHaveLength(0);
    const { jobs } = await runDetail(s.t, s.admin, 1);
    expect(jobs[0].steps.map((x) => x.conclusion)).toEqual([
      'success',
      'success',
      'failure',
      'skipped',
      'success',
    ]);
    const log = await call(
      s.t,
      `/api/repos/octocat/app/actions/runs/1/jobs/${jobs[0].id}/steps/3/logs`,
      { cookie: s.admin }
    );
    expect(await log.text()).toContain("doesn't run `uses: some/action@v1`");
  });
});

describe('Actions API', () => {
  it('cancels a run, terminating its Workflow and containers', async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [run] = (await runs(s.t, s.admin)).runs;
    const bob = await addMember(s.t, s.admin, 'bob');
    const denied = await call(
      s.t,
      '/api/repos/octocat/app/actions/runs/1/cancel',
      { cookie: bob, method: 'POST' }
    );
    expect(denied.status).toBe(403);
    const res = await call(
      s.t,
      '/api/repos/octocat/app/actions/runs/1/cancel',
      {
        cookie: s.admin,
        method: 'POST',
      }
    );
    expect(res.status).toBe(200);
    await settle(s.t);
    expect(s.t.actions.terminated).toEqual([run.id]);
    const { run: after, jobs } = await runDetail(s.t, s.admin, 1);
    expect(after).toMatchObject({
      status: 'completed',
      conclusion: 'cancelled',
    });
    expect(s.t.actions.destroyed).toEqual([jobs[0].id]);
    expect(jobs[0].steps.every((x) => x.status === 'completed')).toBe(true);
  });

  it('re-runs a workflow at the same commit as a new run', async () => {
    const s = await setup();
    const sha = await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const res = await call(s.t, '/api/repos/octocat/app/actions/runs/1/rerun', {
      cookie: s.admin,
      method: 'POST',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ runNumber: 2 });
    const list = await runs(s.t, s.admin);
    expect(list.runs[0]).toMatchObject({
      runNumber: 2,
      headSha: sha,
      status: 'queued',
    });
    expect(s.t.actions.started).toHaveLength(2);
  });

  it('reports a commit status from the latest run of each workflow', async () => {
    const s = await setup();
    const sha = await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const status = async () =>
      (await (
        await call(s.t, `/api/repos/octocat/app/commits/${sha}/runs`, {
          cookie: s.admin,
        })
      ).json()) as { state: string | null; runs: Run[] };
    expect((await status()).state).toBe('pending');
    const [queued] = (await runs(s.t, s.admin)).runs;
    await harness(s.t, () => ({ exitCode: 1 })).run(queued.id);
    expect((await status()).state).toBe('failure');
    await call(s.t, '/api/repos/octocat/app/actions/runs/1/rerun', {
      cookie: s.admin,
      method: 'POST',
    });
    const [rerun] = (await runs(s.t, s.admin)).runs;
    await harness(s.t).run(rerun.id);
    const after = await status();
    expect(after.state).toBe('success');
    expect(after.runs.map((r) => r.runNumber)).toEqual([2]);
  });

  it('marks a run whose Workflow crashed as failed when viewed', async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [run] = (await runs(s.t, s.admin)).runs;
    await s.t.env.DB.prepare(
      'UPDATE workflow_runs SET created_at = created_at - 600'
    ).run();
    s.t.actions.instanceStatus.set(run.id, 'errored');
    const { run: after } = await runDetail(s.t, s.admin, 1);
    expect(after).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect(after.errorMessage).toContain('stopped unexpectedly');
  });

  it('serves the live log of a running step from its runner', async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const { jobs } = await runDetail(s.t, s.admin, 1);
    await s.t.env.DB.prepare(
      "UPDATE workflow_steps SET status = 'in_progress' WHERE number = 2"
    ).run();
    s.t.actions.live.set(`${jobs[0].id}:2`, 'Fetching…');
    const res = await call(
      s.t,
      `/api/repos/octocat/app/actions/runs/1/jobs/${jobs[0].id}/steps/2/logs`,
      { cookie: s.admin }
    );
    expect(await res.text()).toBe('Fetching…');
  });

  it('deletes step logs with the repository', async () => {
    const s = await setup();
    await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
    const [queued] = (await runs(s.t, s.admin)).runs;
    await harness(s.t).run(queued.id);
    const { id } = (await (
      await call(s.t, '/api/repos/octocat/app', { cookie: s.admin })
    ).json()) as { id: string };
    // R2 is shared by the tests in this file, so count only this repository's logs.
    const listed = async () =>
      (await s.t.env.ACTIONS_LOGS.list({ prefix: `actions/${id}/` })).objects
        .length;
    expect(await listed()).toBeGreaterThan(0);
    const del = await call(s.t, '/api/repos/octocat/app', {
      cookie: s.admin,
      method: 'DELETE',
    });
    expect(del.ok).toBe(true);
    expect(await listed()).toBe(0);
  });
});

describe('Actions cache', () => {
  const NODE_CI = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: yarn
      - run: yarn install --frozen-lockfile
`;
  const files = {
    '.github/workflows/ci.yml': NODE_CI,
    'package.json': '{"name":"app"}\n',
    'yarn.lock': '# yarn lockfile v1\n',
  };
  const repoId = async (t: TestEnv) =>
    (await t.env.DB.prepare('SELECT id FROM repositories').first<{
      id: string;
    }>())!.id;

  it('caches node_modules for setup-node: a miss saves after the job, the next run restores', async () => {
    const s = await setup();
    await pushFiles(s, 'main', files);
    let [queued] = (await runs(s.t, s.admin)).runs;
    let h = harness(s.t);
    expect(await h.run(queued.id)).toBe('success');

    const { jobs } = await runDetail(s.t, s.admin, 1);
    expect(jobs[0].steps.map((x) => [x.name, x.conclusion])).toEqual([
      ['Set up job', 'success'],
      ['Run actions/checkout@v4', 'success'],
      ['Run actions/setup-node@v4', 'success'],
      ['Run yarn install --frozen-lockfile', 'success'],
      ['Post Run actions/setup-node@v4', 'success'],
      ['Complete job', 'success'],
    ]);
    // setup-node uses the preinstalled Node.js: no download, a note about the request.
    const setupNode = script(h.requests[1]);
    expect(setupNode).not.toMatch(/\bn -q\b|npm install -g/);
    expect(setupNode).toContain('node-version 22 was requested');
    expect(setupNode).toMatch(
      /Cache not found for node-modules-yarn-linux-x64-node24-[0-9a-f]{32}/
    );
    // The post step uploads node_modules straight to R2 with a masked, pre-signed URL.
    const save = h.requests[3];
    expect(script(save)).toContain("'/workspace/node_modules'");
    const url = save.env.CACHE_URL;
    expect(url).toContain(
      `/gitorange-actions-cache-test/actions-cache/${await repoId(s.t)}/refs~2fheads~2fmain/node-modules-yarn-`
    );
    expect(url).toContain('X-Amz-Signature=');
    expect(save.masks).toEqual([url]);

    // Pretend the upload landed, then run again on a new commit with the same lockfile.
    // The URL's path is exactly the object key: nothing for S3 to decode differently.
    const objectKey = new URL(url).pathname.split(
      '/gitorange-actions-cache-test/'
    )[1];
    expect(objectKey).not.toContain('%');
    await s.t.env.ACTIONS_CACHE.put(objectKey, 'tarball');
    await pushFiles(s, 'main', { ...files, 'README.md': 'v2\n' }, 'Docs');
    [queued] = (await runs(s.t, s.admin)).runs;
    h = harness(s.t);
    expect(await h.run(queued.id)).toBe('success');
    const restore = h.requests[1];
    expect(script(restore)).toContain('Restoring cache: node-modules-yarn-');
    expect(script(restore)).toContain('cache-hit=true');
    expect(restore.env.CACHE_URL).toContain('X-Amz-Signature=');
    expect(restore.masks).toEqual([restore.env.CACHE_URL]);
    // Exact hit: nothing to save, so the post step never reaches the runner.
    expect(h.requests).toHaveLength(3);
    const second = await runDetail(s.t, s.admin, 2);
    expect(second.jobs[0].steps[4]).toMatchObject({
      name: 'Post Run actions/setup-node@v4',
      conclusion: 'skipped',
    });
  });

  it('lets a branch restore from the default branch, but saves only to its own', async () => {
    const s = await setup();
    const id = await repoId(s.t);
    await s.t.env.ACTIONS_CACHE.put(
      `actions-cache/${id}/refs~2fheads~2fmain/deps-old.tar.zst`,
      'tarball'
    );
    await pushFiles(s, 'feature', {
      '.github/workflows/ci.yml': `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
        id: deps
        with:
          path: |
            node_modules
            ~/.cache/tool
          key: deps-new
          restore-keys: deps-
      - run: echo "hit=\${{ steps.deps.outputs.cache-hit }}"
`,
    });
    const [queued] = (await runs(s.t, s.admin)).runs;
    const h = harness(s.t);
    expect(await h.run(queued.id)).toBe('success');
    const restore = script(h.requests[0]);
    expect(restore).toContain('Restoring cache: deps-old');
    expect(restore).toContain('cache-hit=false'); // a restore key, not the exact key
    // The post step saves under the branch, never under main.
    const saveUrl = h.requests[2].env.CACHE_URL;
    expect(saveUrl).toContain(`/${id}/refs~2fheads~2ffeature/deps-new.tar.zst`);
    expect(script(h.requests[2])).toContain("'/root/.cache/tool'");
  });

  it('does not save after a failed job', async () => {
    const s = await setup();
    await pushFiles(s, 'main', files);
    const [queued] = (await runs(s.t, s.admin)).runs;
    const h = harness(s.t, (req) =>
      script(req).startsWith('yarn install') ? { exitCode: 1 } : {}
    );
    expect(await h.run(queued.id)).toBe('failure');
    expect(h.requests).toHaveLength(3); // checkout, setup-node, install; no save
    const { jobs } = await runDetail(s.t, s.admin, 1);
    expect(jobs[0].steps[4]).toMatchObject({ conclusion: 'skipped' });
  });

  it('runs without a cache when the server has none set up', async () => {
    const s = await setup();
    (
      s.t.env as { ACTIONS_CACHE_BUCKET_NAME?: string }
    ).ACTIONS_CACHE_BUCKET_NAME = '';
    await pushFiles(s, 'main', files);
    const [queued] = (await runs(s.t, s.admin)).runs;
    const h = harness(s.t);
    expect(await h.run(queued.id)).toBe('success');
    expect(script(h.requests[1])).toContain('The Actions cache isn');
    expect(h.requests).toHaveLength(3);
  });

  it('evicts the oldest entries past the per-repository cap, and deletes with the repository', async () => {
    const { enforceCacheLimit, deleteRepositoryCache } =
      await import('../actions/cache');
    const s = await setup();
    const id = await repoId(s.t);
    for (const k of ['a', 'b', 'c']) {
      await s.t.env.ACTIONS_CACHE.put(
        `actions-cache/${id}/r/${k}.tar.zst`,
        'x'.repeat(10)
      );
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await enforceCacheLimit(s.t.env, id, 20)).toEqual([
      `actions-cache/${id}/r/a.tar.zst`,
    ]);
    await deleteRepositoryCache(s.t.env, id);
    expect(
      (await s.t.env.ACTIONS_CACHE.list({ prefix: `actions-cache/${id}/` }))
        .objects
    ).toEqual([]);
  });
});
