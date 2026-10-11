import { describe, expect, it, vi } from 'vitest';
import {
  decideState,
  reasonState,
  REASON_KINDS,
  stackReasons,
  type PullState,
  type Reason,
} from '../pulls/state';
import { buildTree, type EdgeInput, type TreeNode } from '../stack/tree';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { checkVerdict } from '../review/checks';
import { findRepoById, gitFor } from '../lib/repos';
import type { PullRequest } from '../db/app.schema';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
} from './helpers/app';
import { commitPaths } from './helpers/seed';
import {
  AGENT_MD,
  agentModels,
  appRepo,
  invitedAgent,
  openPull,
  runReviews,
  startReview,
} from './helpers/reviews';
import { pullStates } from '../pulls/signals';
import { recordStates, eventsFor, latestStates } from '../pulls/events';
import {
  repositoryForPayload,
  settleAfterPayload,
  settleStates,
} from '../pulls/settle';
import type { DrizzleDB } from '../db/middleware';

const node = (over: Partial<TreeNode> = {}): TreeNode => ({
  number: 3,
  parent: null,
  children: [],
  waitsOn: [],
  mustAccountFor: [],
  landedRelations: [],
  cycleWith: [],
  unchecked: [],
  pending: [],
  checking: false,
  ...over,
});
const dep = (number: number, kind: 'builds_on' | 'must_account_for') => ({
  number,
  kind,
  reason: 'Because.',
  instructions: kind === 'must_account_for' ? 'Add a check.' : null,
  landed: false,
  files: [],
  accounted: false,
  forPr: null,
});

describe('pull request state rules', () => {
  it('is ready with nothing left', () => {
    expect(decideState([])).toEqual({ state: 'ready', reasons: [] });
  });

  it('puts agent work before human review before waiting', () => {
    const reasons: Reason[] = [
      { kind: 'checks_running', check: null, started: true },
      { kind: 'needs_approval' },
      { kind: 'check_failed', run_number: 7, check: null },
    ];
    expect(decideState(reasons)).toEqual({
      state: 'agent_followup',
      reasons: [reasons[2], reasons[1], reasons[0]],
    });
    expect(decideState(reasons.slice(0, 2)).state).toBe('human_review');
    expect(decideState(reasons.slice(0, 1)).state).toBe('waiting');
  });

  it('keeps informational reasons without changing the state', () => {
    expect(decideState([{ kind: 'stacked_on', pr: 28 }])).toEqual({
      state: 'ready',
      reasons: [{ kind: 'stacked_on', pr: 28 }],
    });
  });

  it('must account for needs the agent', () => {
    const must: Reason = {
      kind: 'must_account_for',
      pr: 28,
      landed: false,
      instructions: 'Add a check.',
      branch: null,
    };
    expect(reasonState(must)).toBe('agent_followup');
    expect(decideState([must]).state).toBe('agent_followup');
    expect(
      decideState([must, { kind: 'agent_reviewing', agent: null }]).state
    ).toBe('agent_followup');
  });

  it('lists every reason kind', () => {
    expect([...REASON_KINDS].sort()).toEqual(
      [
        'check_failed',
        'changes_requested',
        'checks_running',
        'rebase_conflict',
        'cycle',
        'must_account_for',
        'rebase_onto',
        'resolution_running',
        'stack_checking',
        'stacked_on',
        'waits_on',
        'agent_reviewing',
        'agent_flagged',
        'agent_changes_requested',
        'agent_review_failed',
        'needs_approval',
        'merging_paused',
      ].sort()
    );
  });

  it('waits while merging is paused, behind whatever needs someone', () => {
    expect(reasonState({ kind: 'merging_paused' })).toBe('waiting');
    expect(decideState([{ kind: 'merging_paused' }]).state).toBe('waiting');
    expect(
      decideState([{ kind: 'merging_paused' }, { kind: 'needs_approval' }])
        .state
    ).toBe('human_review');
  });

  it("puts agents' review reasons in whose move they make", () => {
    expect(
      reasonState({ kind: 'agent_changes_requested', agent: 'a', changes: [] })
    ).toBe('agent_followup');
    expect(reasonState({ kind: 'agent_flagged', agent: 'a', flags: [] })).toBe(
      'human_review'
    );
    expect(
      reasonState({ kind: 'agent_review_failed', agent: null, error: null })
    ).toBe('human_review');
    expect(reasonState({ kind: 'needs_approval' })).toBe('human_review');
    expect(reasonState({ kind: 'agent_reviewing', agent: null })).toBe(
      'waiting'
    );
  });

  it('reads the stack tree: cycles, checks still running, must account for, parent, waits on', () => {
    expect(
      stackReasons(
        node({
          parent: dep(28, 'builds_on'),
          waitsOn: [dep(30, 'builds_on')],
          mustAccountFor: [dep(29, 'must_account_for')],
          cycleWith: [12],
          pending: [31],
        })
      )
    ).toEqual([
      { kind: 'cycle', prs: [12] },
      { kind: 'stack_checking', prs: [31] },
      {
        kind: 'must_account_for',
        pr: 29,
        landed: false,
        instructions: 'Add a check.',
        branch: null,
      },
      { kind: 'stacked_on', pr: 28 },
      { kind: 'waits_on', pr: 30 },
    ]);
    expect(stackReasons(node({ checking: true }))).toEqual([
      { kind: 'stack_checking', prs: [] },
    ]);
  });
});

describe('check verdict', () => {
  const run = (
    runNumber: number,
    status: string,
    conclusion: string | null,
    workflowPath = 'ci.yml',
    event = 'pull_request'
  ) => ({
    runNumber,
    status,
    conclusion,
    workflowPath,
    event,
  });
  it('by default: a failed run fails, a running one waits, none is fine', () => {
    expect(checkVerdict([], [], 'any')).toBeNull();
    expect(
      checkVerdict([run(3, 'in_progress', null)], [], 'any')
    ).toMatchObject({
      kind: 'waiting',
      started: true,
    });
    expect(
      checkVerdict(
        [run(3, 'completed', 'success'), run(4, 'completed', 'failure')],
        [],
        'any'
      )
    ).toMatchObject({ kind: 'failed', runNumber: 4, check: null });
  });

  it('require all waits for a first run; a list names the failed check and its run', () => {
    expect(checkVerdict([], [], 'all')).toMatchObject({
      kind: 'waiting',
      started: false,
      reason: 'No checks have run for this commit yet',
    });
    expect(
      checkVerdict([run(1, 'completed', 'failure')], [], 'none')
    ).toBeNull();
    const jobs = [
      {
        key: 'lint',
        name: 'lint',
        status: 'completed',
        conclusion: 'success',
        runNumber: 5,
      },
      {
        key: 'test',
        name: 'test',
        status: 'completed',
        conclusion: 'failure',
        runNumber: 6,
      },
    ];
    expect(checkVerdict([], jobs, ['lint', 'test'])).toEqual({
      kind: 'failed',
      reason: 'The "test" check failed',
      runNumber: 6,
      check: 'test',
    });
    expect(checkVerdict([], jobs, ['build'])).toMatchObject({
      kind: 'waiting',
      check: 'build',
      started: false,
    });
  });

  it('a successful re-run clears a failure; other workflows still count', () => {
    expect(
      checkVerdict(
        [run(4, 'completed', 'failure'), run(7, 'completed', 'success')],
        [],
        'any'
      )
    ).toBeNull();
    expect(
      checkVerdict(
        [run(4, 'completed', 'failure'), run(7, 'in_progress', null)],
        [],
        'all'
      )
    ).toMatchObject({ kind: 'waiting', started: true });
    expect(
      checkVerdict(
        [
          run(4, 'completed', 'failure', 'lint.yml'),
          run(7, 'completed', 'success'),
        ],
        [],
        'any'
      )
    ).toMatchObject({ kind: 'failed', runNumber: 4 });
    const job = (runNumber: number, conclusion: string) => ({
      key: 'test',
      name: 'test',
      status: 'completed',
      conclusion,
      runNumber,
    });
    expect(
      checkVerdict(
        [run(4, 'completed', 'failure'), run(7, 'completed', 'success')],
        [job(4, 'failure'), job(7, 'success')],
        ['test']
      )
    ).toBeNull();
  });

  it("a skipped run or job isn't a failure", () => {
    expect(
      checkVerdict([run(2, 'completed', 'skipped')], [], 'all')
    ).toBeNull();
    expect(
      checkVerdict(
        [run(2, 'completed', 'success')],
        [
          {
            key: 'deploy',
            name: 'deploy',
            status: 'completed',
            conclusion: 'skipped',
            runNumber: 2,
          },
        ],
        ['deploy']
      )
    ).toBeNull();
    expect(
      checkVerdict([run(2, 'completed', 'cancelled')], [], 'any')
    ).toMatchObject({ kind: 'failed' });
  });

  it('a required job skipped because its run failed (a needed job failed) fails', () => {
    const jobs = [
      {
        key: 'test',
        name: 'test',
        status: 'completed',
        conclusion: 'failure',
        runNumber: 3,
      },
      {
        key: 'deploy',
        name: 'deploy',
        status: 'completed',
        conclusion: 'skipped',
        runNumber: 3,
      },
    ];
    expect(
      checkVerdict([run(3, 'completed', 'failure')], jobs, ['deploy'])
    ).toEqual({
      kind: 'failed',
      reason: 'The "deploy" check failed',
      runNumber: 3,
      check: 'deploy',
    });
    expect(
      checkVerdict([run(3, 'completed', 'cancelled')], jobs.slice(1), [
        'deploy',
      ])
    ).toMatchObject({ kind: 'failed', check: 'deploy' });
  });

  it('a required job skipped while its run is still going waits for the run', () => {
    const deploy = {
      key: 'deploy',
      name: 'deploy',
      status: 'completed',
      conclusion: 'skipped',
      runNumber: 3,
    };
    expect(
      checkVerdict([run(3, 'in_progress', null)], [deploy], ['deploy'])
    ).toEqual({
      kind: 'waiting',
      reason: 'The "deploy" check is running',
      check: 'deploy',
      started: true,
    });
    expect(
      checkVerdict([run(3, 'completed', 'success')], [deploy], ['deploy'])
    ).toBeNull();
  });
});

/** A repository with helpers to open PRs, approve their heads, and read their states. */
async function statesRepo() {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'private' },
  });
  const repo = [...t.fake.repos.values()][0];
  const files = { 'src/app.ts': 'export const a = 1;\n' };
  const main = await commitPaths(repo, 'main', files, 'base');
  const db = drizzle(t.env.DB, { schema });
  const repoId = (await t.env.DB.prepare('SELECT id FROM repositories').first<{
    id: string;
  }>())!.id;
  async function open(
    branch: string,
    changes: Record<string, string>,
    title = branch
  ) {
    repo.refs.set(`refs/heads/${branch}`, main);
    await commitPaths(repo, branch, { ...files, ...changes }, title);
    const res = await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title, body: '', base: 'main', head: branch },
    });
    expect(res.status).toBe(201);
    await settle(t);
    return ((await res.json()) as { number: number }).number;
  }
  async function states() {
    const found = await findRepoById(db, repoId);
    const prs = await db.query.pullRequests.findMany();
    const map = await pullStates(
      db,
      gitFor(t.env, found!.repo),
      repoId,
      prs as PullRequest[]
    );
    return Object.fromEntries(
      prs.map((p) => [p.number, map.get(p.id) ?? null])
    ) as Record<number, { state: string; reasons: { kind: string }[] } | null>;
  }
  /** A person approves pull request `n`'s current head (without agents, a PR needs it to be Ready). */
  async function approve(n: number) {
    const res = await call(t, `/api/repos/octocat/app/pulls/${n}/approval`, {
      cookie: admin,
      method: 'POST',
    });
    expect(res.status).toBe(200);
    await settle(t);
  }
  const head = (branch: string) => repo.refs.get(`refs/heads/${branch}`)!;
  async function run(
    n: number,
    branch: string,
    status: string,
    conclusion: string | null
  ) {
    await t.env.DB.prepare(
      `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title, status, conclusion, created_at)
       VALUES (?, ?, ?, '.github/workflows/ci.yml', 'CI', 'pull_request', 'x', ?, 'x', ?, ?, 0)`
    )
      .bind(crypto.randomUUID(), repoId, n, head(branch), status, conclusion)
      .run();
  }
  return {
    t,
    admin,
    repo,
    db,
    repoId,
    open,
    states,
    approve,
    head,
    run,
    files,
  };
}

describe('pullStates', () => {
  it('without agents: failed checks need the agent, running ones wait, none is ready', async () => {
    const s = await statesRepo();
    await s.open('one', { 'a.txt': 'a\n' });
    await s.approve(1);
    expect((await s.states())[1]).toEqual({ state: 'ready', reasons: [] });
    await s.run(1, 'one', 'in_progress', null);
    expect((await s.states())[1]).toEqual({
      state: 'waiting',
      reasons: [{ kind: 'checks_running', check: null, started: true }],
    });
    await s.run(2, 'one', 'completed', 'failure');
    expect((await s.states())[1]).toMatchObject({
      state: 'agent_followup',
      reasons: [{ kind: 'check_failed', run_number: 2, check: null }],
    });
  });

  it('a successful re-run clears check_failed', async () => {
    const s = await statesRepo();
    await s.open('one', { 'a.txt': 'a\n' });
    await s.approve(1);
    await s.run(1, 'one', 'completed', 'failure');
    expect((await s.states())[1]?.state).toBe('agent_followup');
    // Re-running a run inserts a new run for the same commit, workflow and event.
    await s.run(2, 'one', 'completed', 'success');
    expect((await s.states())[1]).toEqual({ state: 'ready', reasons: [] });
  });

  it('reads AI resolution at the current commits: running waits, failed needs the agent', async () => {
    const s = await statesRepo();
    await s.open('one', { 'a.txt': 'a\n' });
    await s.approve(1);
    const pr = (await s.t.env.DB.prepare('SELECT id FROM pull_requests').first<{
      id: string;
    }>())!;
    const insert = (
      status: string,
      base: string,
      error: string | null,
      at: number
    ) =>
      s.t.env.DB.prepare(
        `INSERT INTO merge_resolutions (id, pull_request_id, base_sha, head_sha, commit_sha, status, model, conflicted_paths, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'm', '["a.txt"]', ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          pr.id,
          base,
          s.head('one'),
          s.head('one'),
          status,
          error,
          at
        )
        .run();
    await insert('running', s.head('main'), null, 100);
    expect((await s.states())[1]?.reasons).toEqual([
      { kind: 'resolution_running' },
    ]);
    await insert('failed', s.head('main'), 'Gave up.', 200);
    expect((await s.states())[1]).toEqual({
      state: 'agent_followup',
      reasons: [
        {
          kind: 'rebase_conflict',
          commit: s.head('one'),
          files: ['a.txt'],
          error: 'Gave up.',
        },
      ],
    });
  });

  it('ignores resolutions for other commits and superseded ones', async () => {
    const s = await statesRepo();
    await s.open('one', { 'a.txt': 'a\n' });
    await s.approve(1);
    const pr = (await s.t.env.DB.prepare('SELECT id FROM pull_requests').first<{
      id: string;
    }>())!;
    await s.t.env.DB.prepare(
      `INSERT INTO merge_resolutions (id, pull_request_id, base_sha, head_sha, status, model, conflicted_paths, error_message, created_at)
       VALUES ('old', ?, ?, ?, 'failed', 'm', '[]', 'Gave up.', 1), ('sup', ?, ?, ?, 'failed', 'm', '[]', 'Superseded by newer commits.', 2)`
    )
      .bind(
        pr.id,
        'f'.repeat(40),
        s.head('one'),
        pr.id,
        s.head('main'),
        s.head('one')
      )
      .run();
    expect((await s.states())[1]).toEqual({ state: 'ready', reasons: [] });
  });

  it('must account for needs the agent', async () => {
    const s = await statesRepo();
    await s.open('one', { 'a.txt': 'a\n' });
    await s.open('two', { 'b.txt': 'b\n' });
    await s.approve(1);
    await s.approve(2);
    // Checks are still running on both.
    await s.run(1, 'one', 'in_progress', null);
    await s.run(2, 'two', 'in_progress', null);
    const ids = (
      await s.t.env.DB.prepare(
        'SELECT id FROM pull_requests ORDER BY number'
      ).all<{ id: string }>()
    ).results;
    await s.t.env.DB.prepare(
      `INSERT INTO pr_edges (id, repository_id, land_target, pr_a_id, pr_b_id, a_head, b_head, stage, kind, prerequisite, reason, instructions, created_at, updated_at)
       VALUES ('e', ?, 'main', ?, ?, ?, ?, 'done', 'must_account_for', 'a', 'Needs a check.', 'Add a setup check.', 0, 0)`
    )
      .bind(s.repoId, ids[0].id, ids[1].id, s.head('one'), s.head('two'))
      .run();
    const st = await s.states();
    // The agent has to account for #1, whatever the checks are doing; GitOrange rebases it onto #1 (waiting).
    expect(st[2]).toEqual({
      state: 'agent_followup',
      reasons: [
        {
          kind: 'must_account_for',
          pr: 1,
          landed: false,
          instructions: 'Add a setup check.',
          branch: 'one',
        },
        { kind: 'checks_running', check: null, started: true },
        {
          kind: 'rebase_onto',
          pr: 1,
          branch: 'one',
          why: 'Needs a check.',
        },
        { kind: 'stacked_on', pr: 1 },
      ],
    });
    expect(st[1]).toEqual({
      state: 'waiting',
      reasons: [{ kind: 'checks_running', check: null, started: true }],
    });
  });

  it("without AI review configured, doesn't wait on a review or stack check that never runs", async () => {
    const s = await statesRepo();
    await s.open('one', { 'a.txt': 'a\n' });
    await s.open('two', { 'b.txt': 'b\n' });
    const prs = (await s.db.query.pullRequests.findMany({
      orderBy: (p, { asc }) => [asc(p.number)],
    })) as PullRequest[];
    await s.approve(1);
    // A pair whose stacking check hasn't run.
    await s.t.env.DB.prepare(
      `INSERT INTO pr_edges (id, repository_id, land_target, pr_a_id, pr_b_id, a_head, b_head, stage, created_at, updated_at)
       VALUES ('e', ?, 'main', ?, ?, ?, ?, 'triage', 0, 0)`
    )
      .bind(s.repoId, prs[0].id, prs[1].id, s.head('one'), s.head('two'))
      .run();
    const found = await findRepoById(s.db, s.repoId);
    const git = gitFor(s.t.env, found!.repo);
    const on = (await pullStates(s.db, git, s.repoId, prs)).get(prs[0].id);
    expect(on?.reasons.map((r) => r.kind)).toEqual(['stack_checking']);
    const off = (
      await pullStates(s.db, git, s.repoId, prs, { reviewConfigured: false })
    ).get(prs[0].id);
    expect(off).toEqual({ state: 'ready', reasons: [] });
  });

  it("reads git only for the asked PR's stack chain, not for every PR in the target", async () => {
    const s = await statesRepo();
    for (const b of ['one', 'two', 'three', 'four', 'five'])
      await s.open(b, { [`${b}.txt`]: `${b}\n` });
    const prs = (await s.db.query.pullRequests.findMany({
      orderBy: (p, { asc }) => [asc(p.number)],
    })) as PullRequest[];
    // A chain: each builds on the one before it.
    for (const [i, pr] of prs.slice(1).entries())
      await s.t.env.DB.prepare(
        `INSERT INTO pr_edges (id, repository_id, land_target, pr_a_id, pr_b_id, a_head, b_head, stage, kind, prerequisite, reason, created_at, updated_at)
         VALUES (?, ?, 'main', ?, ?, ?, ?, 'done', 'builds_on', 'a', 'Builds on it.', 0, 0)`
      )
        .bind(
          `e${i}`,
          s.repoId,
          prs[i].id,
          pr.id,
          s.head(prs[i].headRef),
          s.head(pr.headRef)
        )
        .run();
    const found = await findRepoById(s.db, s.repoId);
    const git = gitFor(s.t.env, found!.repo);
    const walks = vi.spyOn(git, 'mergeBase');
    const time = async (asked: PullRequest[]) => {
      walks.mockClear();
      const at = performance.now();
      await pullStates(s.db, git, s.repoId, asked);
      return {
        walks: walks.mock.calls.length,
        ms: Math.round(performance.now() - at),
      };
    };
    // The root builds on nothing, so asking for it walks nothing (before: one walk per stacked PR).
    const root = await time([prs[0]]);
    const all = await time(prs);
    console.log('[timing] pullStates for #1 only', root, 'for all five', all);
    expect(root.walks).toBe(0);
  });

  it('has no state for a PR whose branch is gone, nor for closed PRs', async () => {
    const s = await statesRepo();
    await s.open('one', { 'a.txt': 'a\n' });
    s.repo.refs.delete('refs/heads/one');
    expect((await s.states())[1]).toBeNull();
  });
});

describe('recording state changes', () => {
  async function onePr() {
    const s = await statesRepo();
    await s.open('one', { 'a.txt': 'a\n' });
    const pr = (await s.db.query.pullRequests.findFirst())!;
    return { ...s, pr };
  }
  const ready = { state: 'ready' as const, reasons: [] };
  const waiting = {
    state: 'waiting' as const,
    reasons: [{ kind: 'agent_reviewing' as const, agent: null }],
  };

  it('records a change once, and nothing when unchanged', async () => {
    const s = await onePr();
    await s.t.env.DB.prepare('DELETE FROM pr_events').run();
    expect(
      await recordStates(s.db, [s.pr], new Map([[s.pr.id, ready]]), 1000)
    ).toBe(1);
    expect(
      await recordStates(s.db, [s.pr], new Map([[s.pr.id, ready]]), 2000)
    ).toBe(0);
    expect(
      await recordStates(s.db, [s.pr], new Map([[s.pr.id, waiting]]), 3000)
    ).toBe(1);
    expect(
      (await eventsFor(s.db, s.pr.id)).map((e) => [e.kind, e.state])
    ).toEqual([
      ['state_changed', 'ready'],
      ['state_changed', 'waiting'],
    ]);
    expect((await latestStates(s.db, [s.pr.id])).get(s.pr.id)).toEqual(waiting);
  });

  it('never records a stale computation over a newer one', async () => {
    const s = await onePr();
    await s.t.env.DB.prepare('DELETE FROM pr_events').run();
    expect(
      await recordStates(s.db, [s.pr], new Map([[s.pr.id, waiting]]), 5000)
    ).toBe(1);
    // Computed earlier (before the change above), finishing later: dropped.
    expect(
      await recordStates(s.db, [s.pr], new Map([[s.pr.id, ready]]), 4000)
    ).toBe(0);
    expect((await latestStates(s.db, [s.pr.id])).get(s.pr.id)).toEqual(waiting);
  });

  it('never records an older computation over a newer unchanged one', async () => {
    const s = await onePr();
    await s.t.env.DB.prepare('DELETE FROM pr_events').run();
    expect(
      await recordStates(s.db, [s.pr], new Map([[s.pr.id, ready]]), 1000)
    ).toBe(1);
    // Settle Y (started at 3000) finds the state unchanged and finishes first...
    expect(
      await recordStates(s.db, [s.pr], new Map([[s.pr.id, ready]]), 3000)
    ).toBe(0);
    // ...then settle X (started at 2000, computed a different state) finishes: dropped.
    expect(
      await recordStates(s.db, [s.pr], new Map([[s.pr.id, waiting]]), 2000)
    ).toBe(0);
    expect((await latestStates(s.db, [s.pr.id])).get(s.pr.id)).toEqual(ready);
    expect(await eventsFor(s.db, s.pr.id)).toHaveLength(1);
  });

  it("reads each PR's own latest state", async () => {
    const s = await onePr();
    await s.open('two', { 'b.txt': 'b\n' });
    const [p1, p2] = await s.db.query.pullRequests.findMany({
      orderBy: (p, { asc }) => [asc(p.number)],
    });
    await s.t.env.DB.prepare('DELETE FROM pr_events').run();
    expect(
      await recordStates(
        s.db,
        [p1, p2],
        new Map<string, PullState>([
          [p1.id, ready],
          [p2.id, waiting],
        ]),
        1000
      )
    ).toBe(2);
    expect(
      await recordStates(s.db, [p1], new Map([[p1.id, waiting]]), 2000)
    ).toBe(1);
    expect(
      await recordStates(s.db, [p2], new Map([[p2.id, ready]]), 3000)
    ).toBe(1);
    const latest = await latestStates(s.db, [p1.id, p2.id]);
    expect(latest.get(p1.id)).toEqual(waiting);
    expect(latest.get(p2.id)).toEqual(ready);
    expect((await eventsFor(s.db, p2.id)).map((e) => e.state)).toEqual([
      'waiting',
      'ready',
    ]);
  });

  it('lists the newest events, oldest first', async () => {
    const s = await onePr();
    await s.t.env.DB.prepare('DELETE FROM pr_events').run();
    for (const [i, st] of [ready, waiting, ready].entries())
      await recordStates(
        s.db,
        [s.pr],
        new Map([[s.pr.id, st]]),
        1000 * (i + 1)
      );
    expect(
      (await eventsFor(s.db, s.pr.id, 2)).map((e) => [e.state, e.computedAt])
    ).toEqual([
      ['waiting', expect.anything()],
      ['ready', expect.anything()],
    ]);
  });

  it('records once under concurrent settles', async () => {
    const s = await onePr();
    await s.t.env.DB.prepare('DELETE FROM pr_events').run();
    const [a, b] = await Promise.all([
      settleStates(s.t.env, s.db, s.repoId),
      settleStates(s.t.env, s.db, s.repoId),
    ]);
    expect(a + b).toBe(1);
    expect(await eventsFor(s.db, s.pr.id)).toHaveLength(1);
  });

  it('finds the repository of every MERGE_RESOLUTION payload', async () => {
    const s = await onePr();
    expect(
      await repositoryForPayload(s.db, { sweep: { repositoryId: s.repoId } })
    ).toEqual({ repositoryId: s.repoId });
    expect(
      await repositoryForPayload(s.db, { stack: { pullRequestId: s.pr.id } })
    ).toEqual({ repositoryId: s.repoId, branch: 'main' });
    expect(
      await repositoryForPayload(s.db, { rebase: { pullRequestId: s.pr.id } })
    ).toEqual({ repositoryId: s.repoId, branch: 'main' });
    expect(
      await repositoryForPayload(s.db, { headReview: { id: 'nope' } })
    ).toBeNull();
  });
});

describe('settling after a MERGE_RESOLUTION Workflow', () => {
  it('never throws when the payload lookup fails', async () => {
    const s = await statesRepo();
    const broken = new Proxy(s.db, {
      get: (target, key) =>
        key === 'select'
          ? () => {
              throw new Error('D1 is down');
            }
          : Reflect.get(target, key),
    }) as DrizzleDB;
    await expect(
      settleAfterPayload(s.t.env, broken, { headReview: { id: 'c' } })
    ).resolves.toBe(0);
  });

  it("settles the payload PR's target branch only", async () => {
    const s = await statesRepo();
    await s.open('one', { 'a.txt': 'a\n' });
    // A second target branch with its own PR.
    s.repo.refs.set('refs/heads/release', s.head('main'));
    s.repo.refs.set('refs/heads/fix', s.head('one'));
    const res = await call(s.t, '/api/repos/octocat/app/pulls', {
      cookie: s.admin,
      json: { title: 'fix', body: '', base: 'release', head: 'fix' },
    });
    expect(res.status).toBe(201);
    await settle(s.t);
    await s.approve(2);
    const [one, fix] = await s.db.query.pullRequests.findMany({
      orderBy: (p, { asc }) => [asc(p.number)],
    });
    await s.run(1, 'one', 'completed', 'failure');
    await s.run(2, 'fix', 'completed', 'failure');
    const before = await s.t.env.DB.prepare(
      'SELECT id, computed_at FROM pr_events WHERE pull_request_id = ?'
    )
      .bind(fix.id)
      .all();
    expect(
      await settleAfterPayload(s.t.env, s.db, {
        stack: { pullRequestId: one.id },
      })
    ).toBe(1);
    expect((await latestStates(s.db, [one.id])).get(one.id)?.state).toBe(
      'agent_followup'
    );
    // The PR into release is neither recorded nor bumped.
    expect((await latestStates(s.db, [fix.id])).get(fix.id)?.state).toBe(
      'ready'
    );
    expect(
      (
        await s.t.env.DB.prepare(
          'SELECT id, computed_at FROM pr_events WHERE pull_request_id = ?'
        )
          .bind(fix.id)
          .all()
      ).results
    ).toEqual(before.results);
  });
});

describe('state changes on the timeline', () => {
  it('records the opened PR’s state, and a change after an API mutation, once', async () => {
    const s = await statesRepo();
    await s.open('one', { 'a.txt': 'a\n' });
    const kinds = async () =>
      (
        await s.t.env.DB.prepare(
          "SELECT state FROM pr_events WHERE kind = 'state_changed' ORDER BY computed_at"
        ).all<{ state: string }>()
      ).results.map((r) => r.state);
    expect(await kinds()).toEqual(['human_review']);
    await s.approve(1);
    expect(await kinds()).toEqual(['human_review', 'ready']);
    await s.run(1, 'one', 'completed', 'failure');
    await call(s.t, '/api/repos/octocat/app/pulls/1/comments', {
      cookie: s.admin,
      json: { body: 'CI is red.' },
    });
    await settle(s.t);
    expect(await kinds()).toEqual(['human_review', 'ready', 'agent_followup']);
    await call(s.t, '/api/repos/octocat/app/pulls/1/comments', {
      cookie: s.admin,
      json: { body: 'Still red.' },
    });
    await settle(s.t);
    expect(await kinds()).toEqual(['human_review', 'ready', 'agent_followup']);
  });
});

/** Stacking always runs: record the two PRs' pair as checked and independent, as discovery would. */
async function independentPair(s: Awaited<ReturnType<typeof statesRepo>>) {
  const ids = (
    await s.t.env.DB.prepare(
      'SELECT id FROM pull_requests ORDER BY number'
    ).all<{ id: string }>()
  ).results;
  await s.t.env.DB.prepare(
    `INSERT INTO pr_edges (id, repository_id, land_target, pr_a_id, pr_b_id, a_head, b_head, stage, kind, created_at, updated_at)
     VALUES ('independent', ?, 'main', ?, ?, ?, ?, 'done', 'independent', 0, 0)`
  )
    .bind(s.repoId, ids[0].id, ids[1].id, s.head('one'), s.head('two'))
    .run();
}

describe('pull request states over the API', () => {
  it('shows each open PR’s state in the list, and its events on the PR', async () => {
    const s = await statesRepo();
    await s.open('one', { 'a.txt': 'a\n' });
    await s.open('two', { 'b.txt': 'b\n' });
    await s.approve(1);
    await s.approve(2);
    await independentPair(s);
    await s.run(1, 'one', 'completed', 'failure');
    const list = (await (
      await call(s.t, '/api/repos/octocat/app/pulls', { cookie: s.admin })
    ).json()) as {
      pulls: { number: number; pullState: { state: string } | null }[];
    };
    expect(list.pulls.map((p) => [p.number, p.pullState?.state])).toEqual([
      [2, 'ready'],
      [1, 'agent_followup'],
    ]);
    const detail = (await (
      await call(s.t, '/api/repos/octocat/app/pulls/2', { cookie: s.admin })
    ).json()) as {
      pullState: { state: string; reasons: unknown[] };
      events: { kind: string; state: string; data: unknown }[];
    };
    expect(detail.pullState).toEqual({ state: 'ready', reasons: [] });
    // Recorded when it opened and when it was approved, before stacking had compared it with #1.
    expect(detail.events).toMatchObject([
      {
        kind: 'state_changed',
        state: 'human_review',
        data: {
          reasons: [
            { kind: 'needs_approval' },
            { kind: 'stack_checking', prs: [] },
          ],
        },
      },
      { kind: 'approved' },
      {
        kind: 'state_changed',
        state: 'waiting',
        data: { reasons: [{ kind: 'stack_checking', prs: [] }] },
      },
    ]);
  });

  it('filters by pull state, open PRs only, and rejects unknown values', async () => {
    const s = await statesRepo();
    await s.open('one', { 'a.txt': 'a\n' });
    await s.open('two', { 'b.txt': 'b\n' });
    await s.approve(1);
    await s.approve(2);
    await independentPair(s);
    await s.run(1, 'one', 'completed', 'failure');
    const numbers = async (q: string) =>
      (
        (await (
          await call(s.t, `/api/repos/octocat/app/pulls?state=${q}`, {
            cookie: s.admin,
          })
        ).json()) as {
          pulls: { number: number }[];
        }
      ).pulls.map((p) => p.number);
    expect(await numbers('agent_followup')).toEqual([1]);
    expect(await numbers('ready')).toEqual([2]);
    await call(s.t, '/api/repos/octocat/app/pulls/2', {
      cookie: s.admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    expect(await numbers('ready')).toEqual([]);
    expect(
      (
        await call(s.t, '/api/repos/octocat/app/pulls?state=sleepy', {
          cookie: s.admin,
        })
      ).status
    ).toBe(400);
  });

  it('labels tree nodes with their state', async () => {
    const s = await statesRepo();
    await s.open('one', { 'a.txt': 'a\n' });
    await s.approve(1);
    await s.run(1, 'one', 'in_progress', null);
    const tree = (await (
      await call(s.t, '/api/repos/octocat/app/pulls/tree', { cookie: s.admin })
    ).json()) as {
      targets: {
        nodes: { number: number; pullState: { state: string } | null }[];
      }[];
    };
    expect(tree.targets[0].nodes[0].pullState?.state).toBe('waiting'); // checks still running
  });

  it('hides a private repository’s states', async () => {
    const s = await statesRepo();
    await s.open('one', { 'a.txt': 'a\n' });
    const bob = await addMember(s.t, s.admin, 'bob');
    expect(
      (
        await call(s.t, '/api/repos/octocat/app/pulls?state=ready', {
          cookie: bob,
        })
      ).status
    ).toBe(404);
  });
});

describe('Approvals', () => {
  it('lists human_review PRs only to people who can merge', async () => {
    const s = await statesRepo();
    await s.open('one', { 'a.txt': 'a\n' });
    await s.approve(1);
    const pr = (await s.db.query.pullRequests.findFirst())!;
    await recordStates(
      s.db,
      [pr],
      new Map([
        [
          pr.id,
          { state: 'human_review', reasons: [{ kind: 'cycle', prs: [2] }] },
        ],
      ]),
      Date.now() + 60_000
    );
    const { items, count } = (await (
      await call(s.t, '/api/approvals', { cookie: s.admin })
    ).json()) as {
      items: {
        pull: { number: number };
        pullState: { state: string; reasons: unknown[] } | null;
        agents: unknown[];
      }[];
      count: number;
    };
    expect(count).toBe(1);
    expect(items).toMatchObject([
      {
        pull: { number: 1 },
        agents: [],
        pullState: {
          state: 'human_review',
          reasons: [{ kind: 'cycle', prs: [2] }],
        },
      },
    ]);
    const bob = await addMember(s.t, s.admin, 'bob');
    expect(
      await (await call(s.t, '/api/approvals', { cookie: bob })).json()
    ).toEqual({ items: [], count: 0, assignedToMe: 0, nextCursor: null });
  });

  it("doesn't list conflicts AI can't resolve (the agent's job), only failed AI resolutions", async () => {
    const s = await statesRepo();
    await s.open('one', { 'a.txt': 'a\n' });
    await s.approve(1);
    const pr = (await s.db.query.pullRequests.findFirst())!;
    const insert = (model: string, at: number) =>
      s.t.env.DB.prepare(
        `INSERT INTO merge_resolutions (id, pull_request_id, base_sha, head_sha, status, model, conflicted_paths, error_message, created_at)
         VALUES (?, ?, ?, ?, 'failed', ?, '["a.bin"]', 'Resolve them locally.', ?)`
      )
        .bind(
          crypto.randomUUID(),
          pr.id,
          s.head('main'),
          s.head('one'),
          model,
          at
        )
        .run();
    const listed = async () =>
      (
        (await (
          await call(s.t, '/api/approvals', { cookie: s.admin })
        ).json()) as { items: { pull: { number: number } }[] }
      ).items.map((i) => i.pull.number);
    await insert('none', 100);
    expect(await listed()).toEqual([]);
    await insert('m', 200);
    expect(await listed()).toEqual([1]);
    // A rebase conflict AI failed on (a per-commit row) is the agent's too: it shows as rebase_conflict.
    await s.t.env.DB.prepare(
      `INSERT INTO merge_resolutions (id, pull_request_id, base_sha, head_sha, commit_sha, status, model, conflicted_paths, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, 'failed', 'm', '["a.txt"]', 'Gave up.', 300)`
    )
      .bind(
        crypto.randomUUID(),
        pr.id,
        s.head('main'),
        s.head('one'),
        s.head('one')
      )
      .run();
    expect(await listed()).toEqual([]);
  });
});

describe('must account for drives agent followup (milestone 2b)', () => {
  const must = (over: Partial<EdgeInput> = {}): EdgeInput => ({
    a: 1,
    b: 2,
    stage: 'done',
    kind: 'must_account_for',
    prerequisite: 'a',
    reason: 'Needs a check.',
    instructions: 'Add it.',
    files: [],
    ...over,
  });
  const stateOf = (e: EdgeInput) =>
    decideState(
      stackReasons(buildTree([1, 2], [e]).get(2)!, { branchOf: () => 'one' })
    ).state;

  it('only while the edge is neither accounted for nor dismissed', () => {
    expect(stateOf(must())).toBe('agent_followup');
    expect(stateOf(must({ accounted: true }))).toBe('ready'); // still stacked on #1: informational
    expect(stateOf(must({ dismissed: true }))).toBe('ready');
  });
});

describe('review reasons', () => {
  it('waits on agents, then names their flags, change requests and failures', async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    await invitedAgent(t, admin, 'dataagent', AGENT_MD());
    await openPull(t, admin, repo, { 'src/b.ts': 'b\n' });
    const state = async () =>
      (
        (await (
          await call(t, '/api/repos/octocat/app/pulls/1', { cookie: admin })
        ).json()) as {
          pullState: { state: string; reasons: Record<string, unknown>[] };
        }
      ).pullState;
    expect(await state()).toMatchObject({
      state: 'waiting',
      reasons: [{ kind: 'agent_reviewing', agent: null }],
    });
    await startReview(t);
    await runReviews(
      t,
      agentModels({
        failReview: ['dataagent'],
        review: () => ({
          verdict: 'findings',
          summary: '',
          findings: [
            {
              kind: 'change_requested',
              title: 'Name it',
              detail: 'Rename b.',
              changes: [],
              diagram: null,
              snippets: [],
              paths: [],
            },
            {
              kind: 'needs_person',
              title: 'Export',
              detail: 'Exports b.',
              changes: [],
              diagram: null,
              snippets: [],
              paths: [],
            },
          ],
        }),
      }).models
    );
    const s = await state();
    expect(s.state).toBe('agent_followup');
    expect(s.reasons).toEqual(
      expect.arrayContaining([
        {
          kind: 'agent_changes_requested',
          agent: 'secagent',
          changes: [
            { id: expect.any(String), title: 'Name it', detail: 'Rename b.' },
          ],
        },
        {
          kind: 'agent_flagged',
          agent: 'secagent',
          flags: [{ id: expect.any(String), title: 'Export' }],
        },
        {
          kind: 'agent_review_failed',
          agent: 'dataagent',
          error: 'The review model failed: model down',
        },
      ])
    );
    const summary = async () =>
      (
        (await (
          await call(t, '/api/repos/octocat/app/pulls', { cookie: admin })
        ).json()) as {
          pulls: { review: { state: string; flags: number } | null }[];
        }
      ).pulls[0].review;
    expect(await summary()).toEqual({ state: 'failed', flags: 1 });
    // A new head commit hasn't been reviewed: the summary follows it.
    await commitPaths(
      repo,
      'feature',
      { 'src/app.ts': 'export const a = 1;\n', 'src/b.ts': 'b2\n' },
      'Again'
    );
    expect(await summary()).toEqual({ state: 'reviewing', flags: 0 });
  });

  it('needs a person when no agent is invited, and is ready once they approve', async () => {
    const { t, admin, repo } = await appRepo();
    await openPull(t, admin, repo, { 'src/b.ts': 'b\n' });
    const state = async () =>
      (
        (await (
          await call(t, '/api/repos/octocat/app/pulls/1', { cookie: admin })
        ).json()) as {
          pullState: { state: string; reasons: { kind: string }[] };
        }
      ).pullState;
    expect(await state()).toEqual({
      state: 'human_review',
      reasons: [{ kind: 'needs_approval' }],
    });
    await call(t, '/api/repos/octocat/app/pulls/1/approval', {
      cookie: admin,
      method: 'POST',
    });
    expect(await state()).toEqual({ state: 'ready', reasons: [] });
  });

  it('lists the review summary per pull request', async () => {
    const { t, admin, repo } = await appRepo();
    await openPull(t, admin, repo, { 'src/b.ts': 'b\n' });
    const list = (await (
      await call(t, '/api/repos/octocat/app/pulls', { cookie: admin })
    ).json()) as {
      pulls: { review: { state: string; flags: number } | null }[];
    };
    expect(list.pulls[0].review).toEqual({ state: 'needs_approval', flags: 0 });
  });

  it('reads the gate itself for a PR missing from the given inputs', async () => {
    const { t, admin, repo } = await appRepo();
    await openPull(t, admin, repo, { 'src/b.ts': 'b\n' });
    const db = drizzle(t.env.DB, { schema });
    const prs = (await db.query.pullRequests.findMany()) as PullRequest[];
    const found = await findRepoById(db, prs[0].repositoryId);
    const states = await pullStates(
      db,
      gitFor(t.env, found!.repo),
      prs[0].repositoryId,
      prs,
      { reviews: new Map() }
    );
    expect(states.get(prs[0].id)?.reasons).toContainEqual({
      kind: 'needs_approval',
    });
  });
});
