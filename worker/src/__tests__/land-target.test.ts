import { describe, expect, it } from 'vitest';
import { landTargetOf } from '../lib/land-target';
import { bootstrapAdmin, call, makeEnv, settle } from './helpers/app';
import { commitPaths } from './helpers/seed';
import { AGENT_MD, invitedAgent } from './helpers/reviews';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import type { StepRunner } from '../merge/resolution';
import { executeSweep } from '../merge/auto';
import { onRefsUpdated } from '../actions/trigger';
import { findRepoById, gitFor } from '../lib/repos';

describe('land target', () => {
  it('is the base a pull request was opened against', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'internal' },
    });
    const repo = [...t.fake.repos.values()][0];
    const main = await commitPaths(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    repo.refs.set('refs/heads/feature', main);
    await commitPaths(repo, 'feature', { 'a.txt': 'b\n' }, 'Change');
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Change', body: '', base: 'main', head: 'feature' },
    });
    await settle(t);
    expect(
      await t.env.DB.prepare(
        'SELECT base_ref AS baseRef, land_target AS landTarget FROM pull_requests'
      ).first()
    ).toEqual({ baseRef: 'main', landTarget: 'main' });
  });

  it('falls back to base_ref for rows written before the column (null)', () => {
    expect(landTargetOf({ landTarget: null, baseRef: 'main' })).toBe('main');
    expect(landTargetOf({ landTarget: 'main', baseRef: 'parent' })).toBe(
      'main'
    );
  });
});

const step = {
  do: async (_name: string, a: unknown, b?: unknown) =>
    ((b ?? a) as () => Promise<unknown>)(),
  sleep: async () => {},
} as unknown as StepRunner;

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

/**
 * PR #1 parent → main and PR #2 child → main, with #2 then stacked by hand on `parent` (as Task 8's retargeting
 * does).
 */
async function stackedByHand(opts: { conflict?: boolean } = {}) {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'internal' },
  });
  const repo = [...t.fake.repos.values()][0];
  // Auto-merge is on where agents review; its review never runs here, so nothing lands on its own.
  await invitedAgent(t, admin, 'secagent', AGENT_MD());
  const base = {
    'a.txt': 'a\n',
    '.github/workflows/ci.yml': CI,
  };
  const main = await commitPaths(repo, 'main', base, 'base');
  repo.refs.set('refs/heads/parent', main);
  const parentFiles = { ...base, 'p.txt': 'p\n' };
  await commitPaths(repo, 'parent', parentFiles, 'Parent');
  repo.refs.set('refs/heads/child', repo.refs.get('refs/heads/parent')!);
  const childFiles = {
    ...parentFiles,
    'c.txt': 'c\n',
    ...(opts.conflict ? { 'a.txt': 'child\n' } : {}),
  };
  await commitPaths(repo, 'child', childFiles, 'Child');
  if (opts.conflict)
    await commitPaths(
      repo,
      'main',
      { ...base, 'a.txt': 'main\n' },
      'Main moves'
    );
  for (const [head, title] of [
    ['parent', 'Parent'],
    ['child', 'Child'],
  ])
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls', {
          cookie: admin,
          json: { title, body: '', base: 'main', head },
        })
      ).status
    ).toBe(201);
  await settle(t);
  await t.env.DB.prepare(
    "UPDATE pull_requests SET base_ref = 'parent' WHERE number = 2"
  ).run();
  const db = drizzle(t.env.DB, { schema });
  const repoId = (await t.env.DB.prepare(
    "SELECT id FROM repositories WHERE name = 'app'"
  ).first<{
    id: string;
  }>())!.id;
  const found = (await findRepoById(db, repoId))!;
  const pr2 = (await t.env.DB.prepare(
    'SELECT id FROM pull_requests WHERE number = 2'
  ).first<{ id: string }>())!.id;
  return {
    t,
    admin,
    repo,
    db,
    repoId,
    found,
    git: gitFor(t.env, found.repo),
    pr2,
    base,
    childFiles,
  };
}

const detail = async (
  s: Awaited<ReturnType<typeof stackedByHand>>,
  n: number
) =>
  (await (
    await call(s.t, `/api/repos/octocat/app/pulls/${n}`, { cookie: s.admin })
  ).json()) as {
    pull: { baseRef: string; landTarget: string };
    rebase: { status: string; onto: string; files: string[] } | null;
    review: { autoMerge: { state: string; reasons: string[] } } | null;
    pullState: { reasons: { kind: string }[] } | null;
  };

/** Every Actions run so far passed (the merge button refuses while checks run). */
const passChecks = (s: Awaited<ReturnType<typeof stackedByHand>>) =>
  s.t.env.DB.prepare(
    "UPDATE workflow_runs SET status = 'completed', conclusion = 'success'"
  ).run();

describe('readers of the land target', () => {
  it('reviews and lands against the land target (review, auto-merge, list, states, sweep)', async () => {
    const s = await stackedByHand();
    const d = await detail(s, 2);
    expect(d.pull).toMatchObject({ baseRef: 'parent', landTarget: 'main' });
    expect(d.review).not.toBeNull();
    expect(d.review!.autoMerge.state).not.toBe('off');
    expect(d.pullState!.reasons.map((r) => r.kind)).toContain(
      'agent_reviewing'
    );
    const list = (await (
      await call(s.t, '/api/repos/octocat/app/pulls', { cookie: s.admin })
    ).json()) as {
      pulls: { number: number; review: unknown }[];
    };
    expect(list.pulls.find((p) => p.number === 2)!.review).not.toBeNull();
    // A new head is reviewed: the sweep starts its agents' review.
    const next = await commitPaths(
      s.repo,
      'child',
      { ...s.childFiles, 'c2.txt': 'x\n' },
      'More'
    );
    await executeSweep(
      { env: s.t.env, db: s.db, step },
      { repositoryId: s.repoId, branches: ['child'] }
    );
    const latest = await s.t.env.DB.prepare(
      'SELECT id FROM pr_classifications WHERE pull_request_id = ? AND head_sha = ?'
    )
      .bind(s.pr2, next)
      .first<{ id: string }>();
    expect(latest?.id).toBe(`${s.pr2}-${next}`);
  });

  it('runs pull_request workflows filtered by the land target', async () => {
    const s = await stackedByHand();
    const old = s.repo.refs.get('refs/heads/child')!;
    await commitPaths(
      s.repo,
      'child',
      { ...s.childFiles, 'c2.txt': 'x\n' },
      'More'
    );
    const next = s.repo.refs.get('refs/heads/child')!;
    const admin = (await s.t.env.DB.prepare(
      "SELECT id FROM users WHERE username = 'octocat'"
    ).first<{
      id: string;
    }>())!.id;
    await onRefsUpdated(
      s.t.env,
      s.db,
      s.found.repo,
      'octocat/app',
      [{ ref: 'refs/heads/child', old, new: next }],
      admin
    );
    expect(
      await s.t.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM workflow_runs WHERE event = 'pull_request' AND ref = 'refs/pull/2/head' AND head_sha = ?"
      )
        .bind(next)
        .first()
    ).toEqual({ n: 1 });
  });

  it('rebases a stacked PR onto its parent’s branch, not the land target', async () => {
    const s = await stackedByHand({ conflict: true });
    const d = await detail(s, 2);
    // #2 already contains its parent, so it is up to date with base_ref even though main moved.
    expect(d.rebase).toMatchObject({ status: 'up_to_date', onto: 'parent' });
  });

  it('sweeps many moved branches in chunks and still reaches a PR by its land target', async () => {
    const s = await stackedByHand();
    await s.t.env.DB.prepare(
      "UPDATE pull_requests SET base_ref = 'main' WHERE number = 2"
    ).run();
    await commitPaths(
      s.repo,
      'main',
      { ...s.base, 'z.txt': 'z\n' },
      'Main again'
    );
    const branches = Array.from({ length: 40 }, (_, i) =>
      i === 35 ? 'main' : `other-${i}`
    );
    await executeSweep(
      { env: s.t.env, db: s.db, step },
      { repositoryId: s.repoId, branches }
    );
    expect(
      s.t.actions.resolutions.filter(
        (r) =>
          (r.params as { rebase?: { pullRequestId: string } }).rebase
            ?.pullRequestId === s.pr2
      )
    ).toHaveLength(1);
  });

  it('rebases onto the land target when the base_ref branch is gone', async () => {
    const s = await stackedByHand({ conflict: true });
    s.repo.refs.delete('refs/heads/parent');
    const d = await detail(s, 2);
    expect(d.rebase).toMatchObject({ onto: 'main' });
    expect(d.rebase!.status).not.toBe('up_to_date');
  });

  it('lands into the land target, never the parent branch', async () => {
    const s = await stackedByHand();
    const parentTip = s.repo.refs.get('refs/heads/parent');
    const mainTip = s.repo.refs.get('refs/heads/main')!;
    await passChecks(s);
    const merge = () =>
      call(s.t, '/api/repos/octocat/app/pulls/2/merge', {
        cookie: s.admin,
        json: { approve: true },
      });
    // While #1 is open, landing #2 would carry #1's commit onto main.
    const refused = await merge();
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(
      /carries a commit of #1/
    );
    // #1 closed (its branch stays #2's base): #2 lands into main, never into its base branch.
    await s.t.env.DB.prepare(
      "UPDATE pull_requests SET state = 'closed' WHERE number = 1"
    ).run();
    const res = await merge();
    expect(res.status).toBe(200);
    expect(s.repo.refs.get('refs/heads/parent')).toBe(parentTip);
    const childHead = s.repo.refs.get('refs/heads/child')!;
    expect(s.repo.refs.get('refs/heads/main')).toBe(childHead); // a fast-forward to the child's head
    expect(s.repo.parseCommit(childHead)!.parents).toEqual([parentTip]);
    expect(s.repo.parseCommit(parentTip!)!.parents).toEqual([mainTip]);
  });

  it('groups the stack tree by land target', async () => {
    const s = await stackedByHand();
    const tree = (await (
      await call(s.t, '/api/repos/octocat/app/pulls/tree', { cookie: s.admin })
    ).json()) as {
      targets: { branch: string; nodes: { number: number }[] }[];
    };
    expect(
      tree.targets.map((t) => [t.branch, t.nodes.map((n) => n.number)])
    ).toEqual([['main', [1, 2]]]);
  });

  it('treats a row with a null land_target as landing into its base, as before', async () => {
    const s = await stackedByHand();
    // As on rows written before the column: no land_target, base_ref is the target.
    await s.t.env.DB.prepare(
      "UPDATE pull_requests SET base_ref = 'main', land_target = NULL"
    ).run();
    const d = await detail(s, 2);
    expect(d.pull).toMatchObject({ baseRef: 'main', landTarget: 'main' });
    expect(d.review).not.toBeNull();
    expect(d.pullState).not.toBeNull();
    const tree = (await (
      await call(s.t, '/api/repos/octocat/app/pulls/tree', { cookie: s.admin })
    ).json()) as { targets: { branch: string; nodes: { number: number }[] }[] };
    expect(
      tree.targets.map((t) => [t.branch, t.nodes.map((n) => n.number)])
    ).toEqual([['main', [1, 2]]]); // SQL filters (landTargetIs) see it too
    const mainTip = s.repo.refs.get('refs/heads/main')!;
    await passChecks(s);
    const res = await call(s.t, '/api/repos/octocat/app/pulls/1/merge', {
      cookie: s.admin,
      json: { approve: true },
    });
    expect(res.status).toBe(200);
    expect(
      s.repo.parseCommit(s.repo.refs.get('refs/heads/main')!)!.parents
    ).toEqual([mainTip]);
  });
});
