import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { prClassifications } from '../db/app.schema';
import type { StepRunner } from '../merge/resolution';
import { executeSweep } from '../merge/auto';
import {
  executeHeadReview,
  loadHead,
  MAX_REVIEW_FILES,
  runAgentReview,
  TOO_MANY_FILES,
  type HeadContext,
} from '../review/head';
import { decisionFor } from '../agent-runs/record';
import { stepDisplayName } from '../agent-runs/names';
import type { AgentReview } from '../review/contract';
import { addMember, call, settle, type TestEnv } from './helpers/app';
import { commitPaths } from './helpers/seed';
import {
  AGENT_MD,
  agentModels,
  appRepo,
  BASE,
  flags,
  invitedAgent,
  openPull,
  reviewers,
  runReviews,
  startReview,
  step,
} from './helpers/reviews';

const SCHEMA_CHANGE = {
  'migrations/0001.sql': 'ALTER TABLE users ADD plan text;\n',
};

const FINDINGS: AgentReview = {
  verdict: 'findings',
  summary: 'Two concerns.',
  findings: [
    {
      kind: 'needs_person',
      title: 'New column',
      detail: 'Adds users.plan with no default.',
      changes: [{ what: 'users.plan', before: 'none', after: 'text' }],
      diagram: 'erDiagram\n  users {\n    text plan "NEW"\n  }',
      snippets: [
        { path: 'migrations/0001.sql', start: 1, end: 1, why: 'the column' },
      ],
      paths: ['migrations/0001.sql'],
    },
    {
      kind: 'change_requested',
      title: 'Backfill',
      detail: 'Add a backfill for existing users.',
      changes: [],
      diagram: null,
      snippets: [],
      paths: ['migrations/0001.sql'],
    },
  ],
};

/** octocat/app with the given agents invited and pull request #1 adding `changes`, its review started. */
async function reviewed(
  agents: [string, string][],
  changes: Record<string, string> = SCHEMA_CHANGE
) {
  const { t, admin, repo } = await appRepo();
  const shas: Record<string, string> = {};
  for (const [handle, md] of agents)
    shas[handle] = (await invitedAgent(t, admin, handle, md)).sha;
  const pull = await openPull(t, admin, repo, changes);
  await startReview(t);
  return { t, admin, repo, shas, ...pull };
}

describe('who reviews a pull request commit', () => {
  it('reviews nothing in a repository without invited agents', async () => {
    const { t, admin, repo } = await appRepo();
    await openPull(t, admin, repo, SCHEMA_CHANGE);
    expect(await startReview(t)).toBeNull();
    expect(
      t.actions.resolutions.filter(
        (r) => (r.params as { headReview?: unknown }).headReview
      )
    ).toEqual([]);
  });

  it("asks Clef once, with every agent's question, over the one-liners and never the diff", async () => {
    const { t } = await reviewed([
      ['secagent', AGENT_MD({ ask: 'Auth?' })],
      ['dataagent', AGENT_MD({ ask: 'Data?' })],
    ]);
    const { models, calls } = agentModels();
    await runReviews(t, models);
    expect(calls.triggered).toHaveLength(1);
    expect(calls.triggered[0].questions).toEqual({
      dataagent: 'Data?',
      secagent: 'Auth?',
    });
    const state = JSON.stringify(calls.triggered[0].state);
    expect(state).toContain('Changes migrations/0001.sql.');
    expect(state).not.toContain('ALTER TABLE');
  });

  it("gives Clef the title on one line and the description clipped to 8 KB, as the reviewer's prompt does", async () => {
    const { t } = await reviewed([['secagent', AGENT_MD()]]);
    await t.env.DB.prepare('UPDATE pull_requests SET title = ?, body = ?')
      .bind('Two\nlines', 'x'.repeat(20 * 1024))
      .run();
    const { models, calls } = agentModels();
    await runReviews(t, models);
    const { pull_request } = calls.triggered[0].state as {
      pull_request: { title: string; description: string };
    };
    expect(pull_request.title).toBe('Two lines');
    expect(pull_request.description).toBe(
      `${'x'.repeat(8 * 1024)}\n(description truncated at 8 KB)`
    );
  });

  it('requests an agent at or above its threshold and records the others as not needed', async () => {
    const { t } = await reviewed([
      ['secagent', AGENT_MD({ above: 0.5 })],
      ['dataagent', AGENT_MD({ above: 0.5 })],
    ]);
    const { models, calls } = agentModels({
      probabilities: { secagent: 0.5, dataagent: 0.49 },
    });
    await runReviews(t, models);
    expect(await reviewers(t)).toMatchObject([
      {
        agent: 'dataagent',
        status: 'not_needed',
        requested: 0,
        probability: 0.49,
      },
      { agent: 'secagent', status: 'approved', requested: 1, probability: 0.5 },
    ]);
    expect(calls.reviewed.map((r) => r.handle)).toEqual(['secagent']);
  });

  it('requests every agent when Clef fails', async () => {
    const { t } = await reviewed([
      ['secagent', AGENT_MD({ above: 0.9 })],
      ['dataagent', AGENT_MD({ above: 0.9 })],
    ]);
    const { models, calls } = agentModels({ failTrigger: true });
    await runReviews(t, models);
    expect(calls.reviewed.map((r) => r.handle).sort()).toEqual([
      'dataagent',
      'secagent',
    ]);
    for (const r of await reviewers(t))
      expect(r).toMatchObject({ requested: 1, probability: null });
  });

  it('requests an agent Clef gave no answer for', async () => {
    const { t } = await reviewed([['secagent', AGENT_MD({ above: 0.9 })]]);
    const { models, calls } = agentModels({ omit: ['secagent'] });
    await runReviews(t, models);
    expect(calls.reviewed).toHaveLength(1);
    expect((await reviewers(t))[0]).toMatchObject({
      requested: 1,
      probability: null,
    });
  });

  it('fails an agent whose AGENT.md is invalid, with the parse error, without asking Clef about it', async () => {
    const { t } = await reviewed([
      ['secagent', AGENT_MD({ above: 1 })],
      ['dataagent', AGENT_MD()],
    ]);
    const { models, calls } = agentModels();
    await runReviews(t, models);
    expect(Object.keys(calls.triggered[0].questions)).toEqual(['dataagent']);
    expect(calls.reviewed.map((r) => r.handle)).toEqual(['dataagent']);
    const sec = (await reviewers(t)).find((r) => r.agent === 'secagent')!;
    expect(sec).toMatchObject({ status: 'failed', requested: 1 });
    expect(sec.error).toContain('trigger.above');
  });

  it('summarizes at most 300 files and still triggers', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 301; i++)
      many[`f/${String(i).padStart(3, '0')}.txt`] = `${i}\n`;
    const { t } = await reviewed([['secagent', AGENT_MD()]], many);
    const { models, calls } = agentModels();
    await runReviews(t, models);
    expect(calls.summarized).toHaveLength(300);
    expect(calls.triggered).toHaveLength(1);
    const row = await t.env.DB.prepare(
      'SELECT files FROM pr_classifications'
    ).first<{ files: string }>();
    const files = JSON.parse(row!.files) as { path: string; summary: string }[];
    expect(files).toHaveLength(301);
    expect(files[300]).toMatchObject({
      path: 'f/300.txt',
      summary: 'Not summarized: more than 300 files changed.',
    });
  });

  it('reuses the review when the branch returns to a reviewed commit', async () => {
    const { t, repo, head } = await reviewed([['secagent', AGENT_MD()]]);
    // Keep it open: an approving review would otherwise auto-merge it.
    await t.env.DB.prepare(
      'UPDATE pull_requests SET auto_merge_disabled_at = 1'
    ).run();
    const { models } = agentModels();
    await runReviews(t, models);
    await commitPaths(repo, 'feature', { ...BASE, 'b.txt': 'b\n' }, 'More');
    await startReview(t);
    await runReviews(t, models);
    repo.refs.set('refs/heads/feature', head);
    const again = await startReview(t);
    expect(again).toMatchObject({ headSha: head, status: 'done' });
    expect(
      t.actions.resolutions.filter(
        (r) => (r.params as { headReview?: unknown }).headReview
      )
    ).toHaveLength(2);
  });

  it("writes neutral values to review.yml's columns, kept until a later migration drops them", async () => {
    const { t } = await reviewed([['secagent', AGENT_MD()]]);
    expect(
      await t.env.DB.prepare(
        'SELECT policy_sha, answers, verdict FROM pr_classifications'
      ).first()
    ).toEqual({ policy_sha: '', answers: null, verdict: null });
  });

  it('ignores .gitorange/review.yml', async () => {
    const { t, admin, repo } = await appRepo();
    const reviewYml =
      'human_review:\n  questions:\n    anything:\n      ask: Anything at all?\n      above: 0\n';
    await openPull(
      t,
      admin,
      repo,
      { 'src/b.ts': 'b\n' },
      {
        base: { ...BASE, '.gitorange/review.yml': reviewYml },
      }
    );
    // No agents: nothing reviews it, and a person approves.
    expect(
      t.actions.resolutions.filter(
        (r) => (r.params as { headReview?: unknown }).headReview
      )
    ).toEqual([]);
    const d = (await (
      await call(t, '/api/repos/octocat/app/pulls/1', { cookie: admin })
    ).json()) as {
      pullState: { reasons: { kind: string }[] };
    };
    expect(d.pullState.reasons).toEqual([{ kind: 'needs_approval' }]);
    // With an agent, Clef is asked the agent's question only.
    await invitedAgent(t, admin, 'secagent', AGENT_MD({ ask: 'Auth?' }));
    await startReview(t);
    const { models, calls } = agentModels();
    await runReviews(t, models);
    expect(calls.triggered[0].questions).toEqual({ secagent: 'Auth?' });
  });
});

describe("an agent's review", () => {
  it('approves: the reviewer is approved and raises no flag', async () => {
    const { t } = await reviewed([['secagent', AGENT_MD()]]);
    await runReviews(t, agentModels().models);
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'approved',
      summary: 'Nothing for me here.',
    });
    expect(await flags(t)).toEqual([]);
    const review = await t.env.DB.prepare(
      'SELECT status FROM pr_classifications'
    ).first<{ status: string }>();
    expect(review!.status).toBe('done');
  });

  it('raises findings as flags owned by the agent, with kind, agent_sha and excerpts from the real diff', async () => {
    const { t, shas } = await reviewed([['secagent', AGENT_MD()]]);
    await runReviews(t, agentModels({ review: () => FINDINGS }).models);
    expect((await reviewers(t))[0].status).toBe('changes_requested');
    const [person, change] = await flags(t);
    expect(person).toMatchObject({
      agent: 'secagent',
      source: 'agent',
      kind: 'needs_person',
      agent_sha: shas.secagent,
    });
    expect(JSON.parse(person.value!)).toEqual({ title: 'New column' });
    expect(JSON.parse(person.paths)).toEqual(['migrations/0001.sql']);
    expect(person.detail).toContain('Adds users.plan with no default.');
    expect(person.detail).toContain('| **users.plan** | none | text |');
    expect(person.detail).toContain('```mermaid');
    expect(person.detail).toContain('+ALTER TABLE users ADD plan text;');
    expect(change).toMatchObject({
      kind: 'change_requested',
      agent: 'secagent',
    });
  });

  it('is flagged when every finding needs a person', async () => {
    const { t } = await reviewed([['secagent', AGENT_MD()]]);
    await runReviews(
      t,
      agentModels({
        review: () => ({ ...FINDINGS, findings: [FINDINGS.findings[0]] }),
      }).models
    );
    expect((await reviewers(t))[0].status).toBe('flagged');
  });

  it('writes no findings for a reviewer cancelled mid-review', async () => {
    const { t } = await reviewed([['secagent', AGENT_MD()]]);
    await runReviews(
      t,
      agentModels({
        review: async () => {
          await t.env.DB.prepare(
            `UPDATE pr_reviewers SET status = 'not_needed', summary = 'Removed from the repository.'`
          ).run();
          return FINDINGS;
        },
      }).models
    );
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'not_needed',
      summary: 'Removed from the repository.',
    });
    expect(await flags(t)).toEqual([]);
  });

  it('reads its AGENT.md body and knowledge at its commit, with the one-liners and the diff', async () => {
    const { t, admin, repo } = await appRepo();
    const { sha } = await invitedAgent(
      t,
      admin,
      'dataagent',
      AGENT_MD({ body: 'Check data.' }),
      { 'knowledge/db.md': 'users.plan is billing.' }
    );
    await openPull(t, admin, repo, SCHEMA_CHANGE);
    await startReview(t);
    const { models, calls } = agentModels();
    await runReviews(t, models);
    expect(calls.reviewed[0]).toMatchObject({
      handle: 'dataagent',
      agentSha: sha,
      instructions: 'Check data.',
      knowledge: {
        files: [{ path: 'knowledge/db.md', text: 'users.plan is billing.' }],
        unread: [],
      },
      title: 'Change things',
    });
    expect(calls.reviewed[0].summaries).toContain(
      '- migrations/0001.sql (added): Changes migrations/0001.sql.'
    );
    expect(calls.reviewed[0].diffs).toContain(
      'ALTER TABLE users ADD plan text;'
    );
  });

  it('reviews at the agent commit the trigger pinned, even if the agent moves mid-review', async () => {
    const { t, shas } = await reviewed([['secagent', AGENT_MD()]]);
    const agent = t.fake.repos.get(
      (await t.env.DB.prepare(
        `SELECT r.artifacts_name AS n FROM repositories r WHERE r.name = 'secagent'`
      ).first<{ n: string }>())!.n
    )!;
    const { models, calls } = agentModels({
      onTrigger: () =>
        commitPaths(
          agent,
          'main',
          { 'AGENT.md': AGENT_MD({ body: 'New rules.' }) },
          'Change rules'
        ),
    });
    await runReviews(t, models);
    expect(calls.reviewed[0]).toMatchObject({
      agentSha: shas.secagent,
      instructions: 'Look for leaked secrets.',
    });
    expect((await reviewers(t))[0].agent_sha).toBe(shas.secagent);
  });

  it("reviews its own repository's pull requests with its default-branch instructions", async () => {
    const { t, admin } = await appRepo();
    const { repo: own, sha } = await invitedAgent(
      t,
      admin,
      'secagent',
      AGENT_MD({ body: 'Be strict.' }),
      {},
      'secagent/secagent'
    );
    own.refs.set('refs/heads/loosen', sha);
    await commitPaths(
      own,
      'loosen',
      { 'AGENT.md': AGENT_MD({ body: 'Approve everything.' }) },
      'Loosen'
    );
    const res = await call(t, '/api/repos/secagent/secagent/pulls', {
      cookie: admin,
      json: { title: 'Loosen', body: '', base: 'main', head: 'loosen' },
    });
    expect(res.status).toBe(201);
    await settle(t);
    await startReview(t, 1, 'secagent');
    const { models, calls } = agentModels();
    await runReviews(t, models);
    expect(calls.reviewed[0]).toMatchObject({
      instructions: 'Be strict.',
      agentSha: sha,
    });
  });

  it('runs engine: pi as a single pass, and says so', async () => {
    const { t } = await reviewed([['secagent', AGENT_MD({ engine: 'pi' })]]);
    const { models, calls } = agentModels();
    await runReviews(t, models);
    expect(calls.reviewed).toHaveLength(1);
    expect((await reviewers(t))[0].summary).toContain(
      'engine: pi runs as a single pass'
    );
  });

  it('leaves the reviewer failed when the review model keeps failing', async () => {
    const { t } = await reviewed([['secagent', AGENT_MD()]]);
    await runReviews(t, agentModels({ failReview: ['secagent'] }).models);
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'failed',
      error: 'The review model failed: model down',
    });
  });
});

describe('agent runs name the agent', () => {
  it('names review steps after the agent and sums up their decisions', () => {
    const none = new Map<string, number>();
    expect(stepDisplayName('review:secagent', none)).toBe(
      'Review by @secagent'
    );
    expect(stepDisplayName('review-failed:secagent', none)).toBe(
      'Record failed review by @secagent'
    );
    expect(stepDisplayName('trigger', none)).toBe(
      'Ask which agents this concerns'
    );
    expect(
      decisionFor('review', {
        verdict: 'approve',
        needsPerson: 0,
        changeRequested: 0,
        engine: 'pass',
      })
    ).toBe('Approved');
    expect(
      decisionFor('review', {
        verdict: 'findings',
        needsPerson: 1,
        changeRequested: 1,
        engine: 'pi',
      })
    ).toBe(
      '2 findings: 1 needs a person, 1 change requested (engine: pi ran as a single pass)'
    );
    expect(decisionFor('trigger', { secagent: 0.82, docsagent: 0.05 })).toBe(
      '@secagent 0.82, @docsagent 0.05'
    );
  });
});

describe('a review that cannot finish', () => {
  const reviewRow = (t: TestEnv) =>
    t.env.DB.prepare(
      'SELECT status, error_message AS error FROM pr_classifications'
    ).first<{ status: string; error: string | null }>();
  /** Whether a stack run was started for `head` (stack instance ids carry the head). */
  const stackStartedFor = (t: TestEnv, head: string) =>
    t.actions.resolutions.some(
      (r) =>
        (r.params as { stack?: unknown }).stack &&
        r.id.includes(`-${head.slice(0, 12)}-`)
    );

  it('still starts stacking when reading the changes fails', async () => {
    const { t, repo, head } = await reviewed([['secagent', AGENT_MD()]]);
    repo.parseTree = () => {
      throw new Error('tree unreadable');
    };
    await runReviews(t, agentModels().models);
    expect(await reviewRow(t)).toMatchObject({
      status: 'failed',
      error: 'The pull request could not be read: tree unreadable',
    });
    expect(stackStartedFor(t, head)).toBe(true);
  });

  it('still starts stacking when the review Workflow cannot be created', async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    await openPull(t, admin, repo, SCHEMA_CHANGE);
    const binding = (
      t.env as unknown as {
        MERGE_RESOLUTION: {
          create: (o: { params: unknown }) => Promise<unknown>;
        };
      }
    ).MERGE_RESOLUTION;
    const create = binding.create.bind(binding);
    binding.create = async (o) => {
      if ((o.params as { headReview?: unknown }).headReview)
        throw new Error('Workflows down');
      return create(o);
    };
    const next = await commitPaths(
      repo,
      'feature',
      { ...BASE, ...SCHEMA_CHANGE, 'b.txt': 'b\n' },
      'More'
    );
    expect((await startReview(t))!.status).toBe('failed');
    expect(stackStartedFor(t, next)).toBe(true);
  });

  it('fails when the pull request cannot be read', async () => {
    const { t, repo } = await reviewed([['secagent', AGENT_MD()]]);
    t.fake.repos.delete(repo.name);
    await runReviews(t, agentModels().models);
    expect(await reviewRow(t)).toMatchObject({
      status: 'failed',
      error: 'The pull request could not be read: NOT_FOUND',
    });
  });

  it('fails, instead of staying in progress, when a later step throws', async () => {
    const { t, head } = await reviewed([['secagent', AGENT_MD()]]);
    const review = await startReview(t);
    const db = drizzle(t.env.DB, { schema });
    const throwing = {
      do: async (name: string, a: unknown, b?: unknown) => {
        if (name === 'save-files') throw new Error('D1 down');
        return ((b ?? a) as () => Promise<unknown>)();
      },
      sleep: async () => {},
    } as unknown as StepRunner;
    await executeHeadReview(
      { env: t.env, db, step: throwing, models: agentModels().models },
      review!.id
    );
    expect(await reviewRow(t)).toMatchObject({
      status: 'failed',
      error: 'The review stopped unexpectedly. Try again.',
    });
    expect(stackStartedFor(t, head)).toBe(true);
  });

  it('fails with a clear message when too many files changed', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= MAX_REVIEW_FILES; i++) many[`f/${i}.txt`] = `${i}\n`;
    const { t, head } = await reviewed([['secagent', AGENT_MD()]], many);
    const { models, calls } = agentModels();
    await runReviews(t, models);
    expect(calls.summarized).toEqual([]);
    expect(await reviewRow(t)).toMatchObject({
      status: 'failed',
      error: 'Too many files to review automatically — a person must approve.',
    });
    // Stacking doesn't wait on a review that will never finish.
    expect(stackStartedFor(t, head)).toBe(true);
  }, 60_000);

  it('fails, and still starts stacking, when the load step itself fails', async () => {
    const { t, head } = await reviewed([['secagent', AGENT_MD()]]);
    const review = await startReview(t);
    const db = drizzle(t.env.DB, { schema });
    const throwing = {
      do: async (name: string, a: unknown, b?: unknown) => {
        if (name === 'load') throw new Error('D1 down');
        return ((b ?? a) as () => Promise<unknown>)();
      },
      sleep: async () => {},
    } as unknown as StepRunner;
    await executeHeadReview(
      { env: t.env, db, step: throwing, models: agentModels().models },
      review!.id
    );
    expect(await reviewRow(t)).toMatchObject({
      status: 'failed',
      error: 'The review stopped unexpectedly. Try again.',
    });
    expect(stackStartedFor(t, head)).toBe(true);
  });

  it('fails with a clear message when the paths not summarized are too long to carry', async () => {
    // 830 files, each path ~1 KB: under MAX_REVIEW_FILES, but the 530 beyond the first 300 are > 512 KB of paths.
    const dir = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(200)).join('/');
    const many: Record<string, string> = {};
    for (let i = 0; i < 830; i++) many[`${dir}/${i}.txt`] = `${i}\n`;
    const { t, head } = await reviewed([['secagent', AGENT_MD()]], many);
    const { models, calls } = agentModels();
    await runReviews(t, models);
    expect(calls.summarized).toEqual([]);
    expect(await reviewRow(t)).toMatchObject({
      status: 'failed',
      error: TOO_MANY_FILES,
    });
    expect(stackStartedFor(t, head)).toBe(true);
  }, 60_000);

  it("fails an agent's review with what went wrong when it isn't the model", async () => {
    const { t } = await reviewed([['secagent', AGENT_MD()]]);
    const { models } = agentModels({
      onTrigger: async () => {
        const n = (await t.env.DB.prepare(
          `SELECT artifacts_name AS n FROM repositories WHERE name = 'secagent'`
        ).first<{ n: string }>())!.n;
        t.fake.repos.delete(n);
      },
    });
    await runReviews(t, models);
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'failed',
      error: 'The review failed: NOT_FOUND',
    });
  });

  it('a replayed review step returns the outcome already recorded', async () => {
    const { t } = await reviewed([['secagent', AGENT_MD()]]);
    const { models } = agentModels({ review: () => FINDINGS });
    await runReviews(t, models);
    const db = drizzle(t.env.DB, { schema });
    const review = (await db.select().from(prClassifications).get())!;
    const loaded = await loadHead(
      t.env,
      db,
      review.pullRequestId,
      review.headSha
    );
    const [r] = await reviewers(t);
    const outcome = await runAgentReview(t.env, db, models, {
      ...(loaded as { ok: true; value: HeadContext }).value,
      reviewId: review.id,
      summaries: '',
      reviewer: { reviewerId: r.id, handle: 'secagent' },
    });
    expect(outcome).toEqual({
      verdict: 'findings',
      needsPerson: 1,
      changeRequested: 1,
      engine: 'pass',
    });
  });
});

type View = {
  review: {
    agentsInvited: boolean;
    status: string | null;
    reviewers: {
      agent: { username: string };
      agentRepository: string | null;
      status: string;
      requested: boolean;
      probability: number | null;
      agentSha: string | null;
      flags: {
        id: string;
        kind: string;
        title: string;
        approvedAt: string | null;
      }[];
    }[];
    legacy: { flags: { title: string }[] } | null;
    verdict: { satisfied: boolean; reasons: { kind: string }[] } | null;
    autoMerge: { state: string };
  };
};
const view = async (
  t: Awaited<ReturnType<typeof appRepo>>['t'],
  cookie: string
) =>
  (await (
    await call(t, '/api/repos/octocat/app/pulls/1', { cookie })
  ).json()) as View;

describe('the pull request page', () => {
  it('shows each agent with its status, probability, commit and findings, and the verdict', async () => {
    const { t, admin, shas } = await reviewed([
      ['secagent', AGENT_MD()],
      ['docsagent', AGENT_MD()],
    ]);
    await runReviews(
      t,
      agentModels({
        probabilities: { docsagent: 0.1 },
        review: () => FINDINGS,
      }).models
    );
    const { review } = await view(t, admin);
    expect(review.agentsInvited).toBe(true);
    expect(review.status).toBe('done');
    expect(review.reviewers).toMatchObject([
      {
        agent: { username: 'docsagent' },
        status: 'not_needed',
        requested: false,
        probability: 0.1,
      },
      {
        agent: { username: 'secagent' },
        agentRepository: 'secagent/secagent',
        agentSha: shas.secagent,
        status: 'changes_requested',
        flags: [
          { kind: 'needs_person', title: 'New column' },
          { kind: 'change_requested', title: 'Backfill' },
        ],
      },
    ]);
    expect(review.verdict!.reasons.map((r) => r.kind)).toEqual([
      'agent_changes_requested',
      'agent_flagged',
    ]);
    expect(review.autoMerge.state).toBe('waiting');
  });

  it('needs merge permission to approve a finding or request changes on one', async () => {
    const { t, admin } = await reviewed([['secagent', AGENT_MD()]]);
    await runReviews(t, agentModels({ review: () => FINDINGS }).models);
    const [person, change] = (await view(t, admin)).review.reviewers[0].flags;
    const reader = await addMember(t, admin, 'reader');
    const url = (id: string, action: string) =>
      `/api/repos/octocat/app/pulls/1/review/flags/${id}/${action}`;
    for (const id of [person.id, change.id])
      expect(
        (await call(t, url(id, 'approve'), { cookie: reader, method: 'POST' }))
          .status
      ).toBe(403);
    expect(
      (
        await call(t, url(person.id, 'request-changes'), {
          cookie: reader,
          json: { note: 'no' },
        })
      ).status
    ).toBe(403);
    // Nothing changed.
    const { review } = await view(t, admin);
    for (const f of review.reviewers[0].flags) expect(f.approvedAt).toBeNull();
  });

  it('dismisses a change request, and refuses to request changes on one', async () => {
    const { t, admin } = await reviewed([['secagent', AGENT_MD()]]);
    await runReviews(t, agentModels({ review: () => FINDINGS }).models);
    const change = (await view(t, admin)).review.reviewers[0].flags[1];
    const refused = await call(
      t,
      `/api/repos/octocat/app/pulls/1/review/flags/${change.id}/request-changes`,
      { cookie: admin, json: { note: 'no' } }
    );
    expect(refused.status).toBe(400);
    const dismissed = await call(
      t,
      `/api/repos/octocat/app/pulls/1/review/flags/${change.id}/approve`,
      { cookie: admin, method: 'POST' }
    );
    expect(dismissed.status).toBe(200);
    const { review } = await view(t, admin);
    expect(review.reviewers[0].flags[1].approvedAt).not.toBeNull();
    expect(review.verdict!.reasons.map((r) => r.kind)).toEqual([
      'agent_flagged',
    ]);
  });

  it("shows an old commit's review.yml review as history", async () => {
    const { t, admin, repo } = await appRepo();
    const { head } = await openPull(t, admin, repo, SCHEMA_CHANGE);
    const pr = (await t.env.DB.prepare('SELECT id FROM pull_requests').first<{
      id: string;
    }>())!.id;
    await t.env.DB.prepare(
      `INSERT INTO pr_classifications (id, pull_request_id, head_sha, policy_sha, status, summary_model, classifier_model, verdict, created_at)
       VALUES ('legacy', ?, ?, 'p0', 'done', 's', 'c', 'human', 0)`
    )
      .bind(pr, head)
      .run();
    await t.env.DB.prepare(
      `INSERT INTO pr_review_flags (id, classification_id, source, key, paths, created_at)
       VALUES ('lf', 'legacy', 'question', 'data_model', '[]', 0)`
    ).run();
    const { review } = await view(t, admin);
    expect(review.reviewers).toEqual([]);
    expect(review.legacy!.flags).toMatchObject([{ title: 'data_model' }]);
  });

  it('starts the review of a head that has none when the page is viewed', async () => {
    const { t, admin, repo } = await appRepo();
    await openPull(t, admin, repo, SCHEMA_CHANGE);
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    await view(t, admin);
    await settle(t);
    expect(
      t.actions.resolutions.filter(
        (r) => (r.params as { headReview?: unknown }).headReview
      )
    ).toHaveLength(1);
  });
});

describe('when reviews start', () => {
  it('starts when a pull request opens, and for each new head a push brings', async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    await openPull(t, admin, repo, SCHEMA_CHANGE);
    const started = () =>
      t.actions.resolutions.filter(
        (r) => (r.params as { headReview?: unknown }).headReview
      ).length;
    expect(started()).toBe(1);
    await commitPaths(
      repo,
      'feature',
      { ...BASE, ...SCHEMA_CHANGE, 'b.txt': 'b\n' },
      'More'
    );
    const repositoryId = (await t.env.DB.prepare(
      "SELECT id FROM repositories WHERE name = 'app'"
    ).first<{ id: string }>())!.id;
    await executeSweep(
      { env: t.env, db: drizzle(t.env.DB, { schema }), step },
      { repositoryId, branches: ['feature'] }
    );
    expect(started()).toBe(2);
  });

  it('the sweep still starts discovery when starting a review fails', async () => {
    const { t, admin, repo } = await appRepo();
    await openPull(t, admin, repo, SCHEMA_CHANGE);
    const next = await commitPaths(
      repo,
      'feature',
      { ...BASE, ...SCHEMA_CHANGE, 'b.txt': 'b\n' },
      'More'
    );
    const repositoryId = (await t.env.DB.prepare(
      "SELECT id FROM repositories WHERE name = 'app'"
    ).first<{ id: string }>())!.id;
    // Reviews can't be read; discovery (no agents here, so it waits on none) doesn't need them.
    const DB = t.env.DB;
    const failing = new Proxy(DB, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            if (/pr_classifications/.test(sql)) throw new Error('D1 down');
            return target.prepare(sql);
          };
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await executeSweep(
      { env: t.env, db: drizzle(failing, { schema }), step },
      { repositoryId, branches: ['feature'] }
    );
    expect(
      t.actions.resolutions.some(
        (r) =>
          (r.params as { stack?: unknown }).stack &&
          r.id.includes(`-${next.slice(0, 12)}-`)
      )
    ).toBe(true);
  });

  it("keeps lockfiles and .orangeignore matches out of the summaries and the agent's diff", async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    await openPull(
      t,
      admin,
      repo,
      { 'yarn.lock': 'lock\n', 'gen/out.js': 'x\n', 'src/b.ts': 'b\n' },
      { base: { ...BASE, '.orangeignore': 'gen/\n' } }
    );
    const { models, calls } = agentModels();
    await runReviews(t, models);
    expect(calls.summarized).toEqual(['src/b.ts']);
    expect(calls.reviewed[0].diffs).toContain('--- src/b.ts (added)');
    expect(calls.reviewed[0].diffs).toContain(
      'Ignored (lockfiles and .orangeignore), not shown: gen/out.js, yarn.lock'
    );
  });

  it(".orangeignore comes from the land target: a pull request can't hide its own files", async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    await openPull(
      t,
      admin,
      repo,
      {
        'src/gen.d.ts': 'export type X = 1;\n',
        'src/vendor.js': 'var v;\n',
        // The branch's own .orangeignore doesn't count.
        '.orangeignore': 'src/gen.d.ts\nsrc/vendor.js\n',
      },
      { base: { ...BASE, '.orangeignore': 'src/gen.d.ts\n' } }
    );
    const { models, calls } = agentModels();
    await runReviews(t, models);
    expect(calls.summarized).not.toContain('src/gen.d.ts');
    expect(calls.summarized).toContain('src/vendor.js');
    const row = (await t.env.DB.prepare(
      'SELECT files FROM pr_classifications'
    ).first<{ files: string }>())!;
    const files = JSON.parse(row.files) as { path: string; summary: string }[];
    expect(files.find((f) => f.path === 'src/gen.d.ts')?.summary).toBe(
      'Changed; ignored by .orangeignore.'
    );
  });
});
