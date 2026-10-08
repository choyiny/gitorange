import { describe, expect, it } from 'vitest';
import {
  approvalOverrides,
  listReview,
  reviewVerdict,
  type ReviewReason,
  type GateFlag,
  type GateInput,
  type GateReviewer,
} from '../review/gate';
import type { AgentReview } from '../review/contract';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { landPull } from '../merge/land';
import { findRepoById, gitFor } from '../lib/repos';
import { addMember, call, settle } from './helpers/app';
import { commitPaths } from './helpers/seed';
import {
  AGENT_MD,
  BASE,
  agentModels,
  appRepo,
  flags,
  invitedAgent,
  openPull,
  runReviews,
  startReview,
} from './helpers/reviews';

const input = (o: Partial<GateInput> = {}): GateInput => ({
  agentsInvited: true,
  aiReview: true,
  review: { status: 'done', errorMessage: null },
  reviewers: [],
  flags: [],
  approvedBy: [],
  ...o,
});
const sec = (
  status: GateReviewer['status'],
  o: Partial<GateReviewer> = {}
): GateReviewer => ({
  agentId: 'a1',
  handle: 'secagent',
  status,
  requested: true,
  error: null,
  ...o,
});
const flag = (o: Partial<GateFlag> = {}): GateFlag => ({
  id: 'f1',
  agentId: 'a1',
  kind: 'needs_person',
  title: 'Token',
  detail: 'Hard-codes a token.\n\n| | Before | After |',
  approved: false,
  changesRequested: false,
  ...o,
});

describe('reviewVerdict', () => {
  it('needs a person when no agent is invited, none was requested, or AI is off', () => {
    const needs = { satisfied: false, reasons: [{ kind: 'needs_approval' }] };
    expect(
      reviewVerdict(input({ agentsInvited: false, review: null }))
    ).toEqual(needs);
    expect(
      reviewVerdict(
        input({ reviewers: [sec('not_needed', { requested: false })] })
      )
    ).toEqual(needs);
    expect(reviewVerdict(input({ aiReview: false, review: null }))).toEqual(
      needs
    );
  });

  it("is satisfied by a person's approval over findings for a person and failed reviews", () => {
    expect(
      reviewVerdict(
        input({
          reviewers: [
            sec('flagged'),
            sec('failed', { agentId: 'a2', handle: 'dataagent' }),
          ],
          flags: [flag(), flag({ id: 'f2', changesRequested: true })],
          approvedBy: ['u1'],
        })
      )
    ).toEqual({ satisfied: true, reasons: [] });
    expect(
      reviewVerdict(
        input({ agentsInvited: false, review: null, approvedBy: ['u1'] })
      )
    ).toEqual({ satisfied: true, reasons: [] });
  });

  it("never lets a person's approval stand over an agent's open change request", () => {
    const change = flag({
      kind: 'change_requested',
      title: 'Backfill',
      detail: 'Add a backfill.',
    });
    expect(
      reviewVerdict(
        input({
          reviewers: [sec('changes_requested')],
          flags: [change, flag({ id: 'f2' })],
          approvedBy: ['u1'],
        })
      )
    ).toEqual({
      satisfied: false,
      reasons: [
        {
          kind: 'agent_changes_requested',
          agent: 'secagent',
          changes: [{ id: 'f1', title: 'Backfill', detail: 'Add a backfill.' }],
        },
      ],
    });
    // Dismissed, the approval counts.
    expect(
      reviewVerdict(
        input({
          reviewers: [sec('changes_requested')],
          flags: [{ ...change, approved: true }, flag({ id: 'f2' })],
          approvedBy: ['u1'],
        })
      )
    ).toEqual({ satisfied: true, reasons: [] });
  });

  it('names what an approval stands over', () => {
    expect(
      approvalOverrides(
        input({
          reviewers: [
            sec('changes_requested'),
            sec('failed', {
              agentId: 'a2',
              handle: 'dataagent',
              error: 'down',
            }),
          ],
          flags: [
            flag(),
            flag({ id: 'f2', kind: 'change_requested', title: 'Backfill' }),
          ],
        })
      )
    ).toEqual([
      {
        kind: 'agent_flagged',
        agent: 'secagent',
        flags: [{ id: 'f1', title: 'Token' }],
      },
      { kind: 'agent_review_failed', agent: 'dataagent', error: 'down' },
    ]);
  });

  it('waits while agents review, or before the review has started', () => {
    expect(reviewVerdict(input({ review: null })).reasons).toEqual([
      { kind: 'agent_reviewing', agent: null },
    ]);
    expect(
      reviewVerdict(
        input({ review: { status: 'triggering', errorMessage: null } })
      ).reasons
    ).toEqual([{ kind: 'agent_reviewing', agent: null }]);
    expect(
      reviewVerdict(input({ reviewers: [sec('reviewing')] })).reasons
    ).toEqual([{ kind: 'agent_reviewing', agent: 'secagent' }]);
  });

  it("names a failed review: the agent's, or the whole commit's", () => {
    expect(
      reviewVerdict(
        input({ reviewers: [sec('failed', { error: 'AGENT.md: bad' })] })
      ).reasons
    ).toEqual([
      {
        kind: 'agent_review_failed',
        agent: 'secagent',
        error: 'AGENT.md: bad',
      },
    ]);
    expect(
      reviewVerdict(
        input({ review: { status: 'failed', errorMessage: 'down' } })
      ).reasons
    ).toEqual([{ kind: 'agent_review_failed', agent: null, error: 'down' }]);
  });

  it('is satisfied when every requested agent approved, or a person approved its flags', () => {
    expect(reviewVerdict(input({ reviewers: [sec('approved')] }))).toEqual({
      satisfied: true,
      reasons: [],
    });
    expect(
      reviewVerdict(input({ reviewers: [sec('flagged')], flags: [flag()] }))
        .reasons
    ).toEqual([
      {
        kind: 'agent_flagged',
        agent: 'secagent',
        flags: [{ id: 'f1', title: 'Token' }],
      },
    ]);
    expect(
      reviewVerdict(
        input({
          reviewers: [sec('flagged')],
          flags: [flag({ approved: true })],
        })
      ).satisfied
    ).toBe(true);
  });

  it("sends change requests to the pull request's agent until a person dismisses them", () => {
    const change = flag({
      kind: 'change_requested',
      title: 'Backfill',
      detail: 'Add a backfill.',
    });
    expect(
      reviewVerdict(
        input({ reviewers: [sec('changes_requested')], flags: [change] })
      ).reasons
    ).toEqual([
      {
        kind: 'agent_changes_requested',
        agent: 'secagent',
        changes: [{ id: 'f1', title: 'Backfill', detail: 'Add a backfill.' }],
      },
    ]);
    expect(
      reviewVerdict(
        input({
          reviewers: [sec('changes_requested')],
          flags: [{ ...change, approved: true }],
        })
      ).satisfied
    ).toBe(true);
  });

  it("turns a person's request for changes on a flag into changes_requested", () => {
    expect(
      reviewVerdict(
        input({
          reviewers: [sec('flagged')],
          flags: [flag({ changesRequested: true })],
        })
      ).reasons
    ).toEqual([{ kind: 'changes_requested', flags: 1 }]);
  });
});

const CHANGE = { 'src/auth.ts': 'export const token = "x";\n' };
const NEEDS_PERSON: AgentReview = {
  verdict: 'findings',
  summary: 'Two concerns.',
  findings: ['Token', 'Logging'].map((title) => ({
    kind: 'needs_person' as const,
    title,
    detail: `${title} changed.`,
    changes: [],
    diagram: null,
    snippets: [],
    paths: ['src/auth.ts'],
  })),
};

async function prRow(t: Awaited<ReturnType<typeof appRepo>>['t']) {
  return t.env.DB.prepare(
    `SELECT p.state, p.merged_automatically FROM pull_requests p
       JOIN repositories r ON r.id = p.repository_id WHERE r.name = 'app' AND p.number = 1`
  ).first<{ state: string; merged_automatically: number }>();
}
const merge = (
  t: Awaited<ReturnType<typeof appRepo>>['t'],
  cookie: string,
  json: Record<string, unknown> = {}
) => call(t, '/api/repos/octocat/app/pulls/1/merge', { cookie, json });

describe('listReview', () => {
  const v = (...reasons: ReviewReason[]) => ({
    satisfied: !reasons.length,
    reasons,
  });
  const flagged = (agent: string, n: number): ReviewReason => ({
    kind: 'agent_flagged',
    agent,
    flags: Array.from({ length: n }, (_, i) => ({
      id: `${agent}-${i}`,
      title: 'F',
    })),
  });
  const failed: ReviewReason = {
    kind: 'agent_review_failed',
    agent: 'dataagent',
    error: 'down',
  };
  const agentChanges: ReviewReason = {
    kind: 'agent_changes_requested',
    agent: 'secagent',
    changes: [{ id: 'c', title: 'Rename', detail: null }],
  };
  const reviewing: ReviewReason = { kind: 'agent_reviewing', agent: null };

  it('approved beats everything', () => {
    expect(listReview(v())).toEqual({ state: 'approved', flags: 0 });
    // A satisfied verdict is approved whatever reasons ride along.
    expect(
      listReview({ satisfied: true, reasons: [failed, flagged('a', 2)] })
    ).toEqual({ state: 'approved', flags: 0 });
  });

  it('failed comes before change requests, keeping the flag count', () => {
    expect(listReview(v(agentChanges, failed, flagged('a', 1)))).toEqual({
      state: 'failed',
      flags: 1,
    });
  });

  it("changes requested, by an agent or on a person's request", () => {
    expect(listReview(v(flagged('a', 1), agentChanges, reviewing))).toEqual({
      state: 'changes_requested',
      flags: 1,
    });
    expect(listReview(v({ kind: 'changes_requested', flags: 2 }))).toEqual({
      state: 'changes_requested',
      flags: 0,
    });
  });

  it('sums flags across agents for review required', () => {
    expect(
      listReview(v(flagged('secagent', 2), flagged('dataagent', 1), reviewing))
    ).toEqual({ state: 'review_required', flags: 3 });
  });

  it('reviewing, then needs approval, last', () => {
    expect(
      listReview(v(reviewing, { kind: 'agent_reviewing', agent: 'a' }))
    ).toEqual({ state: 'reviewing', flags: 0 });
    expect(listReview(v({ kind: 'needs_approval' }))).toEqual({
      state: 'needs_approval',
      flags: 0,
    });
  });
});

describe('landing', () => {
  it("needs a person's approval when no agent reviews the repository", async () => {
    const { t, admin, repo } = await appRepo();
    await openPull(t, admin, repo, CHANGE);
    const refused = await merge(t, admin);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('a person needs to approve it');
    const res = await merge(t, admin, { approve: true });
    expect(res.status).toBe(200);
    expect((await prRow(t))!.state).toBe('merged');
    const approval = await t.env.DB.prepare(
      `SELECT u.username FROM pr_approvals a JOIN users u ON u.id = a.user_id`
    ).first<{ username: string }>();
    expect(approval!.username).toBe('octocat');
  });

  it('refuses while checks fail or run, whatever the approvals', async () => {
    const { t, admin, repo } = await appRepo();
    const { head } = await openPull(t, admin, repo, CHANGE);
    const repoId = (await t.env.DB.prepare(
      "SELECT id FROM repositories WHERE name = 'app'"
    ).first<{ id: string }>())!.id;
    await t.env.DB.prepare(
      `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha,
         display_title, status, conclusion, created_at)
       VALUES ('r1', ?, 7, '.github/workflows/ci.yml', 'CI', 'pull_request', 'refs/pull/1/head', ?, 'CI',
         'completed', 'failure', 0)`
    )
      .bind(repoId, head)
      .run();
    const failed = await merge(t, admin, { approve: true });
    expect(failed.status).toBe(409);
    expect(await failed.text()).toContain('Checks failed (run #7)');
    // The refused approve-and-merge keeps its approval (and its timeline entry).
    expect(
      await t.env.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM pr_approvals) AS approvals, (SELECT COUNT(*) FROM pr_events WHERE kind = 'approved') AS events"
      ).first()
    ).toEqual({ approvals: 1, events: 1 });
    await t.env.DB.prepare(
      "UPDATE workflow_runs SET status = 'in_progress', conclusion = NULL"
    ).run();
    const running = await merge(t, admin);
    expect(running.status).toBe(409);
    expect(await running.text()).toContain('Checks are running');
  });

  it("records a person's approve-and-merge as their merge, never as an auto-merge", async () => {
    const { t, admin, repo } = await appRepo();
    // Auto-merge is on here; approving inside the merge must not start it alongside.
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    await openPull(t, admin, repo, CHANGE);
    const res = await merge(t, admin, { approve: true });
    expect(res.status).toBe(200);
    await settle(t);
    const row = await t.env.DB.prepare(
      `SELECT p.state, p.merged_automatically, u.username FROM pull_requests p
         JOIN repositories r ON r.id = p.repository_id JOIN users u ON u.id = p.merged_by_id
        WHERE r.name = 'app' AND p.number = 1`
    ).first();
    expect(row).toEqual({
      state: 'merged',
      merged_automatically: 0,
      username: 'octocat',
    });
  });

  it('refuses members without merge access to approve while merging', async () => {
    const { t, admin, repo } = await appRepo();
    await openPull(t, admin, repo, CHANGE);
    const mona = await addMember(t, admin, 'mona');
    expect((await merge(t, mona, { approve: true })).status).toBe(403);
  });

  it('lands on its own once the requested agent approves, and deletes the branch', async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    await openPull(t, admin, repo, CHANGE);
    await startReview(t);
    await runReviews(t, agentModels().models);
    await settle(t);
    expect(await prRow(t)).toMatchObject({
      state: 'merged',
      merged_automatically: 1,
    });
    expect(repo.refs.has('refs/heads/feature')).toBe(false);
  });

  it('waits for a person on flags, then lands once they approve each one', async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    await openPull(t, admin, repo, CHANGE);
    await startReview(t);
    await runReviews(t, agentModels({ review: () => NEEDS_PERSON }).models);
    expect((await prRow(t))!.state).toBe('open');
    for (const f of await flags(t))
      expect(
        (
          await call(
            t,
            `/api/repos/octocat/app/pulls/1/review/flags/${f.id}/approve`,
            {
              cookie: admin,
              method: 'POST',
            }
          )
        ).status
      ).toBe(200);
    await settle(t);
    expect((await prRow(t))!.state).toBe('merged');
  });

  it('keeps auto-merge off without invited agents, even once approved', async () => {
    const { t, admin, repo } = await appRepo();
    await openPull(t, admin, repo, CHANGE);
    await call(t, '/api/repos/octocat/app/pulls/1/approval', {
      cookie: admin,
      method: 'POST',
    });
    await settle(t);
    expect((await prRow(t))!.state).toBe('open');
  });

  it('a removed agent stops counting; with none left the head needs a person', async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    await openPull(t, admin, repo, CHANGE);
    await startReview(t);
    await runReviews(t, agentModels({ review: () => NEEDS_PERSON }).models);
    const [first] = await flags(t);
    await call(
      t,
      `/api/repos/octocat/app/pulls/1/review/flags/${first.id}/approve`,
      {
        cookie: admin,
        method: 'POST',
      }
    );
    await call(t, '/api/repos/octocat/app/agents/secagent', {
      cookie: admin,
      method: 'DELETE',
    });
    await settle(t);
    expect((await prRow(t))!.state).toBe('open');
    const refused = await merge(t, admin);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('a person needs to approve it');
  });

  it('still merges when deleting the branch fails', async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    await openPull(t, admin, repo, CHANGE);
    const receive = repo.receivePack.bind(repo);
    repo.receivePack = async (body: Uint8Array) => {
      if (
        new TextDecoder()
          .decode(body)
          .includes(`${'0'.repeat(40)} refs/heads/feature`)
      )
        throw new Error('storage down');
      return receive(body);
    };
    await startReview(t);
    await runReviews(t, agentModels().models);
    await settle(t);
    expect(await prRow(t)).toMatchObject({
      state: 'merged',
      merged_automatically: 1,
    });
    expect(repo.refs.has('refs/heads/feature')).toBe(true);
  });

  it('counts a new commit as unreviewed: earlier approvals no longer count', async () => {
    const { t, admin, repo } = await appRepo();
    await openPull(t, admin, repo, CHANGE);
    await call(t, '/api/repos/octocat/app/pulls/1/approval', {
      cookie: admin,
      method: 'POST',
    });
    await commitPaths(
      repo,
      'feature',
      { 'src/app.ts': 'export const a = 1;\n', ...CHANGE, 'b.txt': 'b\n' },
      'More'
    );
    expect((await merge(t, admin)).status).toBe(409);
  });

  it("waits for an agent's change request despite a person's approval, records what the approval overrode, and lands once it is dismissed", async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    await invitedAgent(t, admin, 'dataagent', AGENT_MD());
    await openPull(t, admin, repo, CHANGE);
    await startReview(t);
    await runReviews(
      t,
      agentModels({
        failReview: ['dataagent'],
        review: () => ({
          ...NEEDS_PERSON,
          findings: [
            NEEDS_PERSON.findings[0],
            {
              ...NEEDS_PERSON.findings[0],
              kind: 'change_requested',
              title: 'Rotate it',
              detail: 'Read the token from a secret.',
            },
          ],
        }),
      }).models
    );
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/1/approval', {
          cookie: admin,
          method: 'POST',
        })
      ).status
    ).toBe(200);
    await settle(t);
    expect((await prRow(t))!.state).toBe('open');
    const refused = await merge(t, admin);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('@secagent requested 1 change');
    // The approval is on the record, with what it was given over.
    const event = await t.env.DB.prepare(
      "SELECT data FROM pr_events WHERE kind = 'approved'"
    ).first<{ data: string }>();
    expect(
      (JSON.parse(event!.data).over as { kind: string; agent: string }[]).map(
        (r) => `${r.kind}:${r.agent}`
      )
    ).toEqual(['agent_review_failed:dataagent', 'agent_flagged:secagent']);
    // Dismissing the change request lets the approval count: it lands on its own.
    const change = (await flags(t)).find((f) => f.kind === 'change_requested')!;
    await call(
      t,
      `/api/repos/octocat/app/pulls/1/review/flags/${change.id}/approve`,
      { cookie: admin, method: 'POST' }
    );
    await settle(t);
    expect((await prRow(t))!.state).toBe('merged');
  });
});

describe('approving', () => {
  const approve = (
    t: Awaited<ReturnType<typeof appRepo>>['t'],
    cookie: string,
    json?: Record<string, unknown>
  ) =>
    call(t, '/api/repos/octocat/app/pulls/1/approval', {
      cookie,
      method: 'POST',
      json,
    });
  const counts = (t: Awaited<ReturnType<typeof appRepo>>['t']) =>
    t.env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM pr_approvals) AS approvals, (SELECT COUNT(*) FROM pr_events WHERE kind = 'approved') AS events"
    ).first();

  it('records one approval and one timeline entry per person and commit', async () => {
    const { t, admin, repo } = await appRepo();
    const { head } = await openPull(t, admin, repo, CHANGE);
    expect((await approve(t, admin)).status).toBe(200);
    expect((await approve(t, admin, { headSha: head })).status).toBe(200);
    expect(await counts(t)).toEqual({ approvals: 1, events: 1 });
    const event = await t.env.DB.prepare(
      "SELECT data FROM pr_events WHERE kind = 'approved'"
    ).first<{ data: string }>();
    expect(JSON.parse(event!.data)).toEqual({ head_sha: head, over: [] });
  });

  it('documents 409 for approving, never for withdrawing', async () => {
    const { t, admin } = await appRepo();
    const doc = (await (
      await call(t, '/api/doc', { cookie: admin })
    ).json()) as {
      paths: Record<string, Record<string, { responses: object }>>;
    };
    const route =
      doc.paths['/api/repos/{owner}/{repo}/pulls/{number}/approval'];
    expect(Object.keys(route.post.responses)).toContain('409');
    expect(Object.keys(route.delete.responses)).not.toContain('409');
  });

  it('refuses to approve, or approve and merge, a head the person did not see', async () => {
    const { t, admin, repo } = await appRepo();
    await openPull(t, admin, repo, CHANGE);
    const stale = 'f'.repeat(40);
    const refused = await approve(t, admin, { headSha: stale });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('new commits');
    const merged = await merge(t, admin, { approve: true, headSha: stale });
    expect(merged.status).toBe(409);
    expect(await counts(t)).toEqual({ approvals: 0, events: 0 });
    expect((await prRow(t))!.state).toBe('open');
  });
});

describe('the commit that lands', () => {
  it('lands the commit the gate checked, even if the branch moves after the check', async () => {
    const { t, admin, repo } = await appRepo();
    const { head } = await openPull(t, admin, repo, CHANGE);
    // A person approved this commit: the gate passes for it, and only for it.
    await call(t, '/api/repos/octocat/app/pulls/1/approval', {
      cookie: admin,
      method: 'POST',
    });
    const db = drizzle(t.env.DB, { schema });
    const pr = (await db.query.pullRequests.findFirst({
      where: (p, { eq }) => eq(p.number, 1),
    }))!;
    const found = (await findRepoById(db, pr.repositoryId))!;
    const git = gitFor(t.env, found.repo);
    // The branch moves right after landPull reads the head it gates (as a refs-cache refresh would show).
    const real = git.resolve.bind(git);
    let first = true;
    git.resolve = async (ref: string) => {
      if (ref !== 'feature') return real(ref);
      if (!first) return repo.refs.get('refs/heads/feature') ?? null;
      first = false;
      const gated = await real(ref);
      await commitPaths(
        repo,
        'feature',
        { ...BASE, ...CHANGE, 'late.txt': 'unreviewed\n' },
        'Late'
      );
      return gated;
    };
    const user = (await t.env.DB.prepare(
      "SELECT id, name, email FROM users WHERE username = 'octocat'"
    ).first<{ id: string; name: string; email: string }>())!;
    const result = await landPull({
      env: t.env,
      db,
      repo: found.repo,
      repoFullName: 'octocat/app',
      git,
      pr,
      by: user,
      after: () => {},
    });
    expect(result).toMatchObject({ ok: true, sha: head, headSha: head });
    expect(repo.refs.get('refs/heads/main')).toBe(head); // not the late commit
  });

  it('refuses a plain merge of a head the person did not see', async () => {
    const { t, admin, repo } = await appRepo();
    const { head } = await openPull(t, admin, repo, CHANGE);
    await call(t, '/api/repos/octocat/app/pulls/1/approval', {
      cookie: admin,
      method: 'POST',
    });
    const stale = await merge(t, admin, { headSha: 'f'.repeat(40) });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain('new commits');
    expect((await prRow(t))!.state).toBe('open');
    expect((await merge(t, admin, { headSha: head })).status).toBe(200);
  });
});
