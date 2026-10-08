import { describe, expect, it } from 'vitest';
import {
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
  type TestEnv,
} from './helpers/app';
import { commitFiles, commitPaths } from './helpers/seed';
import { events } from './helpers/stacking';
import { moved, runRebases } from './helpers/rebase';

const CI = `name: CI
on:
  pull_request:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`;

/** octocat/app; PR #1 from `feature` (Add b, then Add c) into main; `ci` adds a pull_request workflow. */
async function landing(opts: { ci?: boolean } = {}) {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'internal' },
  });
  const repo = [...t.fake.repos.values()][0];
  const base: Record<string, string> = {
    'a.txt': 'a\n',
    ...(opts.ci ? { '.github/workflows/ci.yml': CI } : {}),
  };
  const root = await commitPaths(repo, 'main', base, 'base');
  repo.refs.set('refs/heads/feature', root);
  const f1 = await commitPaths(
    repo,
    'feature',
    { ...base, 'b.txt': 'b\n' },
    'Add b'
  );
  const f2 = await commitPaths(
    repo,
    'feature',
    { ...base, 'b.txt': 'b\n', 'c.txt': 'c\n' },
    'Add c'
  );
  const res = await call(t, '/api/repos/octocat/app/pulls', {
    cookie: admin,
    json: { title: 'B and c', body: '', base: 'main', head: 'feature' },
  });
  expect(res.status).toBe(201);
  await settle(t);
  return {
    t,
    admin,
    repo,
    base,
    root,
    f1,
    f2,
    passChecks: () =>
      t.env.DB.prepare(
        "UPDATE workflow_runs SET status = 'completed', conclusion = 'success'"
      ).run(),
    merge: () =>
      call(t, '/api/repos/octocat/app/pulls/1/merge', {
        cookie: admin,
        json: { approve: true },
      }),
    moveMain: (files: Record<string, string> = { ...base, 'z.txt': 'z\n' }) =>
      commitPaths(repo, 'main', files, 'Main moves'),
  };
}

/**
 * Runs `fn` while every `rebased` timeline insert fails: the work after a written rebase throws partway. The database
 * outlives the test, so the trigger is dropped after.
 */
async function failingRebasedEvents(t: TestEnv, fn: () => Promise<void>) {
  await t.env.DB.prepare(
    "CREATE TRIGGER fail_rebased BEFORE INSERT ON pr_events WHEN NEW.kind = 'rebased' BEGIN SELECT RAISE(ABORT, 'boom'); END"
  ).run();
  try {
    await fn();
  } finally {
    await t.env.DB.prepare('DROP TRIGGER fail_rebased').run();
  }
}

/** Pull request runs on `sha` not yet completed. */
const pendingRuns = (t: TestEnv, sha: string) =>
  t.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM workflow_runs WHERE event = 'pull_request' AND head_sha = ? AND status != 'completed'"
  )
    .bind(sha)
    .first<{ n: number }>();

const row = (t: TestEnv) =>
  t.env.DB.prepare(
    'SELECT state, merge_commit_sha AS sha, landed_commits AS landed FROM pull_requests WHERE number = 1'
  ).first();

describe('landing by fast-forward', () => {
  it('moves the target to the head: no new commit, every SHA and message kept', async () => {
    const { t, repo, root, f1, f2, merge } = await landing();
    const res = await merge();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sha: f2 });
    expect(repo.refs.get('refs/heads/main')).toBe(f2);
    expect(repo.parseCommit(f2)!.parents).toEqual([f1]);
    expect(repo.parseCommit(f1)!.parents).toEqual([root]);
    expect(repo.refs.get('refs/pull/1/head')).toBe(f2);
    expect(await row(t)).toEqual({ state: 'merged', sha: f2, landed: 2 });
  });

  it('shows a landed pull request’s own commits and files, even after the target moves on', async () => {
    const { t, admin, merge, moveMain } = await landing();
    expect((await merge()).status).toBe(200);
    await moveMain();
    const commits = (await (
      await call(t, '/api/repos/octocat/app/pulls/1/commits', { cookie: admin })
    ).json()) as { message: string }[];
    expect(commits.map((c) => c.message)).toEqual(['Add b', 'Add c']);
    const files = (await (
      await call(t, '/api/repos/octocat/app/pulls/1/files', { cookie: admin })
    ).json()) as { path: string }[];
    expect(files.map((f) => f.path)).toEqual(['b.txt', 'c.txt']);
  });

  it('rebases first when the target moved, and lands at once when nothing needs checks', async () => {
    const { t, repo, f2, merge, moveMain } = await landing();
    const tip = await moveMain();
    const res = await merge();
    expect(res.status).toBe(200);
    const head = repo.refs.get('refs/heads/feature')!;
    expect(head).not.toBe(f2);
    expect(repo.refs.get('refs/heads/main')).toBe(head);
    const top = repo.parseCommit(head)!;
    expect(top.message).toBe('Add c');
    expect(repo.parseCommit(top.parents[0])!.parents).toEqual([tip]);
    expect(repo.refs.get(`refs/pull/1/pre-rebase/${f2.slice(0, 7)}`)).toBe(f2);
    expect(await row(t)).toEqual({ state: 'merged', sha: head, landed: 2 });
    expect((await events(t, 1)).map((e) => e.kind)).toContain('rebased');
  });

  it('rebases first, then waits for checks on the new head; merging again lands it', async () => {
    const { t, repo, base, merge, moveMain, passChecks } = await landing({
      ci: true,
    });
    await passChecks();
    await moveMain({ ...base, 'z.txt': 'z\n' });
    const res = await merge();
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      reason?: string;
      rebased?: string;
    };
    expect(body.error).toMatch(
      /Rebased onto main as [0-9a-f]{7} — waiting for checks/
    );
    const head = repo.refs.get('refs/heads/feature')!;
    // A normal outcome the page shows as such: which gate, and the head landing pushed.
    expect(body.reason).toBe('checks');
    expect(body.rebased).toBe(head);
    expect(repo.refs.get('refs/heads/main')).not.toBe(head);
    expect(
      await t.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM workflow_runs WHERE event = 'pull_request' AND head_sha = ? AND status != 'completed'"
      )
        .bind(head)
        .first()
    ).toEqual({ n: 1 });
    await passChecks();
    expect((await merge()).status).toBe(200);
    expect(repo.refs.get('refs/heads/main')).toBe(head);
  });

  it('says which gate refused a merge, with no rebased head when nothing was rebased', async () => {
    const { merge } = await landing({ ci: true });
    const res = await merge();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reason?: string; rebased?: string };
    expect(body.reason).toBe('checks');
    expect(body.rebased).toBeUndefined();
  });

  it('refuses a rebase conflict, naming the commit, and leaves it to a rebase run', async () => {
    const { t, repo, base, f2, merge, moveMain } = await landing();
    await moveMain({ ...base, 'c.txt': 'main c\n' });
    const res = await merge();
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(
      `stops at commit ${f2.slice(0, 7)}, which conflicts in c.txt. GitOrange is resolving it`
    );
    expect(repo.refs.get('refs/heads/feature')).toBe(f2);
    await settle(t);
    expect(
      t.actions.resolutions.some(
        (r) => (r.params as { rebase?: unknown }).rebase
      )
    ).toBe(true);
  });

  it('refuses when there is nothing to merge', async () => {
    const { repo, f2, merge } = await landing();
    repo.refs.set('refs/heads/main', f2);
    const res = await merge();
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Nothing to merge');
  });

  it('keeps the squash rule for pull requests merged before rebase merging', async () => {
    const { t, admin, repo, f2 } = await landing();
    const squash = await commitPaths(
      repo,
      'main',
      { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' },
      'B and c (#1)'
    );
    repo.refs.set('refs/pull/1/head', f2);
    await t.env.DB.prepare(
      "UPDATE pull_requests SET state = 'merged', merge_commit_sha = ?, landed_commits = NULL, merged_at = 1, closed_at = 1"
    )
      .bind(squash)
      .run();
    const files = (await (
      await call(t, '/api/repos/octocat/app/pulls/1/files', { cookie: admin })
    ).json()) as { path: string }[];
    expect(files.map((f) => f.path)).toEqual(['b.txt', 'c.txt']);
  });

  it('never rewrites a head another open pull request shares, to land it', async () => {
    const { t, admin, repo, root, f2, merge, moveMain } = await landing();
    repo.refs.set('refs/heads/release', root);
    const other = await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Backport', body: '', base: 'release', head: 'feature' },
    });
    expect(other.status).toBe(201);
    await settle(t);
    const tip = await moveMain();
    const res = await merge();
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(
      'feature is the head of another open pull request (#2)'
    );
    expect(repo.refs.get('refs/heads/feature')).toBe(f2);
    expect(repo.refs.get('refs/heads/main')).toBe(tip);
  });

  it('counts a merged-in branch as one landed commit, as a first-parent log shows it', async () => {
    const { t, admin, repo, base, root, f2, merge } = await landing();
    const side = await commitFiles(
      repo,
      'side',
      { ...base, 's.txt': 's\n' },
      'Add s',
      [root]
    );
    const head = await commitFiles(
      repo,
      'feature',
      { ...base, 'b.txt': 'b\n', 'c.txt': 'c\n', 's.txt': 's\n' },
      'Merge side',
      [f2, side]
    );
    expect((await merge()).status).toBe(200);
    expect(repo.refs.get('refs/heads/main')).toBe(head);
    expect(await row(t)).toEqual({ state: 'merged', sha: head, landed: 3 });
    const files = (await (
      await call(t, '/api/repos/octocat/app/pulls/1/files', { cookie: admin })
    ).json()) as { path: string }[];
    expect(files.map((f) => f.path)).toEqual(['b.txt', 'c.txt', 's.txt']);
  });
});

describe('Actions on a rebased head', () => {
  it('a rebase run queues them before anything else can fail, so the head can’t land untested', async () => {
    const { t, repo, root, f2, merge, moveMain, passChecks } = await landing({
      ci: true,
    });
    await passChecks();
    await moveMain();
    await failingRebasedEvents(t, async () => {
      await moved(t, 'main', root);
      await expect(runRebases(t)).rejects.toThrow();
    });
    const head = repo.refs.get('refs/heads/feature')!;
    expect(head).not.toBe(f2);
    expect(await pendingRuns(t, head)).toEqual({ n: 1 });
    const res = await merge();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason?: string }).reason).toBe('checks');
    expect(repo.refs.get('refs/heads/main')).not.toBe(head);
    await passChecks();
    expect((await merge()).status).toBe(200);
    expect(repo.refs.get('refs/heads/main')).toBe(head);
  });

  it('landing’s own rebase queues them first too, and waits for them when the rest fails', async () => {
    const { t, repo, f2, merge, moveMain, passChecks } = await landing({
      ci: true,
    });
    await passChecks();
    await moveMain();
    let res!: Response;
    await failingRebasedEvents(t, async () => {
      res = await merge();
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reason?: string; rebased?: string };
    const head = repo.refs.get('refs/heads/feature')!;
    expect(head).not.toBe(f2);
    expect(body).toMatchObject({ reason: 'checks', rebased: head });
    expect(await pendingRuns(t, head)).toEqual({ n: 1 });
    await passChecks();
    expect((await merge()).status).toBe(200);
    expect(repo.refs.get('refs/heads/main')).toBe(head);
  });
});

describe('a target that moves again while landing rebases', () => {
  it('says the branch was rebased, with the new head, in the "Base branch was modified" refusal', async () => {
    const { repo, base, f2, merge, moveMain } = await landing();
    await moveMain();
    // Main moves once more right after landing pushes the rebased branch, before it fast-forwards main.
    const push = repo.receivePack.bind(repo);
    let again = false;
    repo.receivePack = async (body) => {
      const out = await push(body);
      if (!again && repo.refs.get('refs/heads/feature') !== f2) {
        again = true;
        await commitPaths(
          repo,
          'main',
          { ...base, 'z.txt': 'z\n', 'y.txt': 'y\n' },
          'Main moves again'
        );
      }
      return out;
    };
    const res = await merge();
    expect(res.status).toBe(409);
    const head = repo.refs.get('refs/heads/feature')!;
    expect(head).not.toBe(f2);
    expect(await res.json()).toMatchObject({
      error: 'Base branch was modified. Review and try the merge again.',
      rebased: head,
    });
  });
});
