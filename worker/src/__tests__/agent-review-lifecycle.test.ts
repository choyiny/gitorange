import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { schema } from '../db/schema';
import { prClassifications, pullRequests } from '../db/app.schema';
import { executeHeadReview, retryHeadReview } from '../review/head';
import { retryReviewer } from '../review/reviewers';
import { MergeResolutionWorkflow } from '../merge/workflow';
import { runActionsRetention } from '../actions/retention';
import { headReviewId } from '../review/keys';
import { step } from './helpers/reviews';
import { addMember, call } from './helpers/app';
import { newAgent } from './helpers/agents';
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
} from './helpers/reviews';

const CHANGE = { 'src/auth.ts': 'export const token = "x";\n' };

async function failedReview(md = AGENT_MD({ above: 1 })) {
  const { t, admin, repo } = await appRepo();
  const { repo: agent } = await invitedAgent(t, admin, 'secagent', md);
  const pull = await openPull(t, admin, repo, CHANGE);
  await startReview(t);
  return { t, admin, repo, agent, ...pull };
}

const FINDING = {
  verdict: 'findings' as const,
  summary: '',
  findings: [
    {
      kind: 'needs_person' as const,
      title: 'Token',
      detail: 'Hard-codes a token.',
      changes: [],
      diagram: null,
      snippets: [],
      paths: ['src/auth.ts'],
    },
  ],
};

type T = Awaited<ReturnType<typeof appRepo>>['t'];

function workflows(t: T) {
  return (
    t.env as unknown as {
      MERGE_RESOLUTION: { create: (o: unknown) => Promise<unknown> };
    }
  ).MERGE_RESOLUTION;
}

async function pullOne(t: T) {
  const db = drizzle(t.env.DB, { schema });
  const pr = (await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.number, 1))
    .get())!;
  return { db, pr };
}

async function headReviewStatus(t: T) {
  return (await t.env.DB.prepare(
    'SELECT status FROM pr_classifications'
  ).first<{ status: string }>())!.status;
}

const retry = (
  t: Awaited<ReturnType<typeof appRepo>>['t'],
  cookie: string,
  id: string
) =>
  call(t, `/api/repos/octocat/app/pulls/1/reviewers/${id}/retry`, {
    cookie,
    method: 'POST',
  });

describe('Retry on a reviewer', () => {
  it("re-reviews a failed agent at its repository's current AGENT.md", async () => {
    const { t, admin, agent } = await failedReview();
    const { models, calls } = agentModels();
    await runReviews(t, models);
    const [failed] = await reviewers(t);
    expect(failed.status).toBe('failed');
    const fixed = await commitPaths(
      agent,
      'main',
      { 'AGENT.md': AGENT_MD({ body: 'Fixed.' }) },
      'Fix'
    );
    expect((await retry(t, admin, failed.id)).status).toBe(200);
    await runReviews(t, models);
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'approved',
      agent_sha: fixed,
      error: null,
    });
    expect(calls.reviewed[0].instructions).toBe('Fixed.');
  });

  it('stays failed, with the current error, while AGENT.md is still invalid', async () => {
    const { t, admin } = await failedReview();
    await runReviews(t, agentModels().models);
    const [failed] = await reviewers(t);
    const before = t.actions.resolutions.length;
    expect((await retry(t, admin, failed.id)).status).toBe(200);
    expect(t.actions.resolutions).toHaveLength(before);
    expect((await reviewers(t))[0].status).toBe('failed');
    expect((await reviewers(t))[0].error).toContain('trigger.above');
  });

  it('reviews again after the review model failed', async () => {
    const { t, admin } = await failedReview(AGENT_MD());
    await runReviews(t, agentModels({ failReview: ['secagent'] }).models);
    const [failed] = await reviewers(t);
    expect(failed.status).toBe('failed');
    expect((await retry(t, admin, failed.id)).status).toBe(200);
    await runReviews(t, agentModels().models);
    expect((await reviewers(t))[0].status).toBe('approved');
  });

  it('refuses reviews that did not fail, reviews of older commits, and people without merge access', async () => {
    const { t, admin, repo } = await failedReview();
    await runReviews(t, agentModels().models);
    const [failed] = await reviewers(t);
    const mona = await addMember(t, admin, 'mona');
    expect((await retry(t, mona, failed.id)).status).toBe(403);
    expect((await retry(t, admin, 'nope')).status).toBe(404);
    await commitPaths(repo, 'feature', { ...BASE, 'b.txt': 'b\n' }, 'More');
    const old = await retry(t, admin, failed.id);
    expect(old.status).toBe(400);
    expect(await old.text()).toContain('older commit');
  });
});

describe('Retry on a reviewer, when things go wrong', () => {
  it('leaves the review failed, not running, when its Workflow cannot start', async () => {
    const { t, admin } = await failedReview(AGENT_MD());
    await runReviews(t, agentModels({ failReview: ['secagent'] }).models);
    const [failed] = await reviewers(t);
    expect(await headReviewStatus(t)).toBe('done');
    workflows(t).create = async () => {
      throw new Error('Workflows down');
    };
    expect((await retry(t, admin, failed.id)).status).toBe(503);
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'failed',
      error: 'The review could not be started. Try again.',
    });
    expect(await headReviewStatus(t)).toBe('done');
  });

  it("a retry that lost the race keeps the winner's findings", async () => {
    const { t, admin, head } = await failedReview(AGENT_MD());
    await runReviews(t, agentModels({ failReview: ['secagent'] }).models);
    const [failed] = await reviewers(t);
    const { db, pr } = await pullOne(t);
    // The losing retry reads the row as failed, then waits on git while the winner retries and reviews.
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let reached!: () => void;
    const waiting = new Promise<void>((r) => (reached = r));
    const artifacts = t.env.ARTIFACTS as unknown as Record<string, unknown>;
    const slow = new Proxy(artifacts, {
      get(target, prop) {
        const v = target[prop as string];
        if (typeof v !== 'function') return v;
        return async (...args: unknown[]) => {
          reached();
          await gate;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const loser = retryReviewer(
      { ...t.env, ARTIFACTS: slow } as unknown as typeof t.env,
      db,
      pr,
      failed.id,
      head,
      () => {}
    );
    await waiting;
    expect((await retry(t, admin, failed.id)).status).toBe(200);
    await runReviews(t, agentModels({ review: () => FINDING }).models);
    expect((await reviewers(t))[0].status).toBe('flagged');
    expect(await flags(t)).toHaveLength(1);
    open();
    expect(await loser).toMatchObject({ ok: false, status: 400 });
    expect(await flags(t)).toHaveLength(1);
    expect((await reviewers(t))[0].status).toBe('flagged');
  });
});

describe('the reviewer Workflow', () => {
  it("runs a retry with Workers AI, its usage counted against the commit's review", async () => {
    const { t, admin, head } = await failedReview(AGENT_MD());
    await runReviews(t, agentModels({ failReview: ['secagent'] }).models);
    const [failed] = await reviewers(t);
    expect((await retry(t, admin, failed.id)).status).toBe(200);
    const started = t.actions.resolutions.at(-1)!;
    expect(started.params).toEqual({ reviewer: { id: failed.id } });
    const AI = {
      run: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: 'approve',
                summary: 'Fine.',
                findings: [],
              }),
            },
          },
        ],
      }),
    };
    const env = { ...t.env, AI } as unknown as typeof t.env;
    // workerd's WorkflowEntrypoint constructor wants a real ExecutionContext; run() only reads this.env.
    const workflow = Object.assign(
      Object.create(MergeResolutionWorkflow.prototype),
      { env }
    ) as MergeResolutionWorkflow;
    await workflow.run(
      {
        payload: started.params,
        instanceId: started.id,
        timestamp: new Date(),
      } as never,
      step as never
    );
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'approved',
      summary: 'Fine.',
    });
    const { pr } = await pullOne(t);
    const usage = await t.env.DB.prepare(
      "SELECT classification_id FROM ai_usage WHERE feature = 'review-agent'"
    ).all<{ classification_id: string }>();
    expect(usage.results).toEqual([
      { classification_id: headReviewId(pr.id, head) },
    ]);
  });
  it('stops a review.yml review a Workflow started before reviewer agents', async () => {
    const { t, admin, repo } = await appRepo();
    const { head } = await openPull(t, admin, repo, CHANGE);
    const { db, pr } = await pullOne(t);
    await db.insert(prClassifications).values({
      id: 'legacy',
      pullRequestId: pr.id,
      headSha: head,
      policySha: 'p',
      status: 'summarizing',
      summaryModel: 'm',
      classifierModel: 'clef',
      createdAt: new Date(),
    });
    const workflow = Object.assign(
      Object.create(MergeResolutionWorkflow.prototype),
      { env: t.env }
    ) as MergeResolutionWorkflow;
    await workflow.run(
      {
        payload: { classificationId: 'legacy' },
        instanceId: 'review-legacy',
        timestamp: new Date(),
      } as never,
      step as never
    );
    expect(
      await t.env.DB.prepare(
        "SELECT status, error_message AS error FROM pr_classifications WHERE id = 'legacy'"
      ).first()
    ).toEqual({
      status: 'failed',
      error: 'Reviews moved to reviewer agents.',
    });
  });
});

describe('a failed review of the whole commit', () => {
  it('starts again on retry', async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    const binding = (
      t.env as unknown as {
        MERGE_RESOLUTION: { create: (o: unknown) => Promise<unknown> };
      }
    ).MERGE_RESOLUTION;
    const create = binding.create;
    // Workflows is down while the review starts (from the opening, once task 9 wires it, or from startReview).
    binding.create = async () => {
      throw new Error('Workflows down');
    };
    const { head } = await openPull(t, admin, repo, CHANGE);
    expect((await startReview(t))!.status).toBe('failed');
    binding.create = create;
    const db = drizzle(t.env.DB, { schema });
    const pr = (await db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.number, 1))
      .get())!;
    expect(await retryHeadReview(t.env, db, pr, { head })).toEqual({
      ok: true,
    });
    await runReviews(t, agentModels().models);
    expect((await reviewers(t))[0].status).toBe('approved');
  });

  it('starts again from the review Retry button', async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    const binding = workflows(t);
    const create = binding.create;
    binding.create = async () => {
      throw new Error('Workflows down');
    };
    await openPull(t, admin, repo, CHANGE);
    expect((await startReview(t))!.status).toBe('failed');
    binding.create = create;
    const res = await call(t, '/api/repos/octocat/app/pulls/1/review/retry', {
      cookie: admin,
      method: 'POST',
    });
    expect(res.status).toBe(200);
    await runReviews(t, agentModels().models);
    expect(await headReviewStatus(t)).toBe('done');
    expect((await reviewers(t))[0].status).toBe('approved');
  });
});

describe('a review that stopped without finishing (its Workflow died)', () => {
  const STOPPED = 'The review stopped unexpectedly. Try again.';
  const HOURS = 3600;
  /** Moves every head review's and reviewer's created_at `hours` into the past. */
  async function age(t: T, hours: number) {
    const s = Math.floor(Date.now() / 1000) - hours * HOURS;
    await t.env.DB.batch([
      t.env.DB.prepare('UPDATE pr_classifications SET created_at = ?').bind(s),
      t.env.DB.prepare('UPDATE pr_reviewers SET created_at = ?').bind(s),
    ]);
  }
  const reviewRow = (t: T) =>
    t.env.DB.prepare(
      'SELECT status, error_message AS error FROM pr_classifications'
    ).first<{ status: string; error: string | null }>();
  const retention = (t: T) =>
    runActionsRetention(t.env, drizzle(t.env.DB, { schema }));
  /** A finished review, its rows then put back in progress as a Workflow that died would leave them. */
  async function stuck(review = 'reviewing', reviewer = 'reviewing') {
    const { t, admin } = await failedReview(AGENT_MD());
    // A finding keeps the pull request open (an approval would auto-merge it).
    await runReviews(t, agentModels({ review: () => FINDING }).models);
    await t.env.DB.batch([
      t.env.DB.prepare(
        'UPDATE pr_classifications SET status = ?, finished_at = NULL'
      ).bind(review),
      t.env.DB.prepare(
        'UPDATE pr_reviewers SET status = ?, finished_at = NULL'
      ).bind(reviewer),
    ]);
    return { t, admin };
  }

  it('is stopped when the commit is next looked at, after 2 hours, and Retry starts it again', async () => {
    const { t, admin } = await failedReview(AGENT_MD());
    // Never run: its Workflow died. Under 2 hours it's still reused as running.
    expect((await startReview(t))!.status).toBe('summarizing');
    await age(t, 1);
    expect((await startReview(t))!.status).toBe('summarizing');
    await age(t, 3);
    expect(await startReview(t)).toMatchObject({
      status: 'failed',
      errorMessage: STOPPED,
    });
    const res = await call(t, '/api/repos/octocat/app/pulls/1/review/retry', {
      cookie: admin,
      method: 'POST',
    });
    expect(res.status).toBe(200);
    await runReviews(t, agentModels().models);
    expect(await headReviewStatus(t)).toBe('done');
    expect((await reviewers(t))[0].status).toBe('approved');
  });

  it('is stopped by the daily retention after 2 hours, with its reviewers, and Retry starts it again', async () => {
    const { t, admin } = await stuck();
    await age(t, 1);
    await retention(t);
    expect((await reviewRow(t))!.status).toBe('reviewing');
    await age(t, 3);
    const status = await retention(t);
    expect(status.stoppedReviews).toBe(1);
    expect(await reviewRow(t)).toEqual({ status: 'failed', error: STOPPED });
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'failed',
      error: STOPPED,
    });
    const res = await call(t, '/api/repos/octocat/app/pulls/1/review/retry', {
      cookie: admin,
      method: 'POST',
    });
    expect(res.status).toBe(200);
    await runReviews(t, agentModels().models);
    expect(await headReviewStatus(t)).toBe('done');
  });

  it("stops a reviewer's retry left reviewing for 2 hours, and Retry on it works", async () => {
    const { t, admin } = await stuck('done', 'reviewing');
    await age(t, 3);
    const status = await retention(t);
    expect(status.stoppedReviewers).toBe(1);
    const [row] = await reviewers(t);
    expect(row).toMatchObject({ status: 'failed', error: STOPPED });
    expect((await reviewRow(t))!.status).toBe('done');
    expect((await retry(t, admin, row.id)).status).toBe(200);
    await runReviews(t, agentModels().models);
    expect((await reviewers(t))[0].status).toBe('approved');
  });

  /** Runs the commit's review Workflow inline; `meanwhile` runs during its first summary (the Workflow is slow). */
  async function slowRun(t: T, meanwhile: () => Promise<void>) {
    const review = (await startReview(t))!;
    // Started 3 hours ago: stale once something stops it, and a Retry's row is a new generation.
    await age(t, 3);
    const { models, calls } = agentModels();
    const summarize = models.summarize.bind(models);
    let first = true;
    models.summarize = async (...args: Parameters<typeof summarize>) => {
      if (first) {
        first = false;
        await meanwhile();
      }
      return summarize(...args);
    };
    await executeHeadReview(
      { env: t.env, db: drizzle(t.env.DB, { schema }), step, models },
      review.id
    );
    return calls;
  }

  it('an old run that is still going never revives the review once stopped, and makes no more model calls', async () => {
    const { t } = await failedReview(AGENT_MD());
    const calls = await slowRun(t, async () => {
      await retention(t);
    });
    expect(await reviewRow(t)).toEqual({ status: 'failed', error: STOPPED });
    expect(calls.triggered).toEqual([]);
    expect(calls.reviewed).toEqual([]);
    expect(await reviewers(t)).toEqual([]);
  });

  it('an old run that is still going never writes onto the review Retry started again', async () => {
    const { t, admin } = await failedReview(AGENT_MD());
    const calls = await slowRun(t, async () => {
      await retention(t);
      const res = await call(t, '/api/repos/octocat/app/pulls/1/review/retry', {
        cookie: admin,
        method: 'POST',
      });
      expect(res.status).toBe(200);
    });
    // The new review is untouched: still waiting for its own run.
    expect(
      await t.env.DB.prepare(
        'SELECT status, files FROM pr_classifications'
      ).first()
    ).toEqual({ status: 'summarizing', files: null });
    expect(calls.triggered).toEqual([]);
    expect(await reviewers(t)).toEqual([]);
  });

  it('counts 2 hours from the retry, not from when the commit was first reviewed', async () => {
    const { t, admin } = await failedReview(AGENT_MD());
    await runReviews(t, agentModels({ failReview: ['secagent'] }).models);
    await age(t, 3);
    const [failed] = await reviewers(t);
    expect((await retry(t, admin, failed.id)).status).toBe(200);
    // The retry's Workflow hasn't run yet: neither the reviewer nor its commit's review is stale.
    await retention(t);
    expect((await reviewers(t))[0].status).toBe('reviewing');
    expect((await reviewRow(t))!.status).toBe('reviewing');
    expect((await startReview(t))!.status).toBe('reviewing');
  });
});

describe('removing and deleting agents', () => {
  it('cancels a review in flight when the agent is removed from the repository', async () => {
    const { t, admin } = await failedReview(AGENT_MD());
    await runReviews(
      t,
      agentModels({
        review: async () => {
          const res = await call(t, '/api/repos/octocat/app/agents/secagent', {
            cookie: admin,
            method: 'DELETE',
          });
          expect(res.status).toBe(200);
          return {
            verdict: 'findings',
            summary: '',
            findings: [
              {
                kind: 'needs_person',
                title: 'Token',
                detail: 'Hard-codes a token.',
                changes: [],
                diagram: null,
                snippets: [],
                paths: ['src/auth.ts'],
              },
            ],
          };
        },
      }).models
    );
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'not_needed',
      requested: 0,
      summary: 'Removed from the repository.',
    });
    // Its finding, returned after the removal, was never written.
    expect(await flags(t)).toEqual([]);
  });

  it('cancels its reviews everywhere when the agent is deleted', async () => {
    const { t, admin } = await failedReview(AGENT_MD());
    await runReviews(
      t,
      agentModels({
        review: async (i) => {
          await call(t, '/api/admin/agents/secagent', {
            cookie: admin,
            method: 'DELETE',
          });
          return { verdict: 'approve', summary: i.handle, findings: [] };
        },
      }).models
    );
    expect((await reviewers(t))[0]).toMatchObject({
      status: 'not_needed',
      summary: 'Removed from the repository.',
    });
  });

  it('never invites more than 10, even when invitations race', async () => {
    const { t, admin } = await appRepo();
    for (let i = 0; i < 9; i++)
      await invitedAgent(t, admin, `agent${i}`, AGENT_MD());
    await newAgent(t, admin, 'agent9', 'Agent 9');
    await newAgent(t, admin, 'agent10', 'Agent 10');
    const statuses = (
      await Promise.all(
        ['agent9', 'agent10'].map((h) =>
          call(t, `/api/repos/octocat/app/agents/${h}`, {
            cookie: admin,
            method: 'PUT',
          })
        )
      )
    )
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([200, 400]);
    const { n } = (await t.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM repository_agents'
    ).first<{ n: number }>())!;
    expect(n).toBe(10);
  });

  it('invites at most 10 agents to a repository', async () => {
    const { t, admin } = await appRepo();
    for (let i = 0; i < 10; i++)
      await invitedAgent(t, admin, `agent${i}`, AGENT_MD());
    await newAgent(t, admin, 'agent10', 'Agent 10');
    const refused = await call(t, '/api/repos/octocat/app/agents/agent10', {
      cookie: admin,
      method: 'PUT',
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('at most 10 agents');
    const again = await call(t, '/api/repos/octocat/app/agents/agent3', {
      cookie: admin,
      method: 'PUT',
    });
    expect(again.status).toBe(200);
  });
});
