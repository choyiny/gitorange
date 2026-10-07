import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { decisionFor, describeRun } from '../agent-runs/record';
import { LEARN_STALE_MS } from '../learn/recover';
import { LEARN_MAX_MINUTES } from '../lib/settings';
import {
  PI_EXPIRE_SLACK_MS,
  PI_RECHECK_MS,
  PI_START_SLACK_MS,
} from '../review/pi-contract';
import { eq } from 'drizzle-orm';
import { repositories } from '../db/app.schema';
import { gitFor } from '../lib/repos';
import { LESSON_TRAILER, lessonCommitMessage } from '../learn/commit';
import {
  learnerName,
  learnUserPrompt,
  type LearnStartRequest,
} from '../learn/contract';
import { startNextLesson } from '../learn/lessons';
import { checkLesson, LEARN_NO_PI, LEARN_STOPPED } from '../learn/run';
import { step } from './helpers/reviews';
import { FRONT_MATTER_CHANGED } from '../learn/validate';
import { agentRepo, agentRow } from './helpers/agents';
import { call } from './helpers/app';
import {
  agentModels,
  openPull,
  runReviews,
  startReview,
} from './helpers/reviews';
import {
  CHANGE,
  closedLesson,
  closePull,
  decide,
  fakeLearner,
  findings,
  learnedMd,
  learnRuns,
  lessons,
  FINDINGS,
  runLessons,
  SUMMARY,
} from './helpers/lessons';

const done = (text: string) => () => ({ state: 'done' as const, text });

describe('a lesson', () => {
  it('commits an allowed edit to main as the agent: the summary, the pull request, one trailer per dismissed finding', async () => {
    const { t } = await closedLesson();
    expect(learnRuns(t)).toHaveLength(1);
    const dismissed = (await findings(t)).filter(
      (f) => f.kind === 'change_requested'
    );
    const learner = fakeLearner(done(SUMMARY), {
      files: () => ({
        'AGENT.md': learnedMd('secagent'),
        'knowledge/fixtures.md': 'Fixtures under test/ hold fake tokens.\n',
      }),
    });
    await runLessons(t, learner.api);

    const repo = await agentRepo(t);
    const sha = repo.refs.get('refs/heads/main')!;
    const [lesson] = await lessons(t);
    expect(lesson).toMatchObject({
      status: 'committed',
      commit_sha: sha,
      summary: SUMMARY,
      error: null,
      attempts: 1,
      retryable: 0,
    });
    const agent = (await agentRow(t))!;
    const commit = repo.parseCommit(sha)!;
    expect(commit.author).toEqual({
      name: agent.user_name,
      email: agent.user_email,
    });
    expect(commit.committer).toEqual(commit.author);
    expect(commit.parents).toEqual([lesson.base_sha]);
    expect(commit.message).toBe(
      `${SUMMARY}\n\nLearned from #1 (octocat/app): dismissed "Token logged", "No expiry"\n\n${dismissed
        .map((f) => `${LESSON_TRAILER}: ${f.id}`)
        .join('\n')}`
    );
    // What the learner was given.
    const [request] = [...learner.objects.values()].map((o) => o.request);
    expect(request).toMatchObject({
      handle: 'secagent',
      attempt: 1,
      baseSha: lesson.base_sha,
      input: {
        pull: {
          repository: 'octocat/app',
          number: 1,
          title: 'Change things',
          target: 'main',
          private: false,
        },
      },
    });
    expect(
      request.input.findings.map((f) => [f.id, f.title, f.dismissedBy])
    ).toEqual(dismissed.map((f) => [f.id, f.title, 'octocat']));
    expect(request.input.findings[0].detail).toContain(
      'the token is written to the log'
    );
    expect(learner.starts).toEqual([learnerName(lesson.id, 1)]);
    expect(learner.stopped).toContain(learnerName(lesson.id, 1));
    // The push refreshed the agent, and the pull request's timeline says so.
    expect(agent.config_sha).toBe(sha);
    const event = await t.env.DB.prepare(
      `SELECT data, actor_id FROM pr_events WHERE kind = 'learned'`
    ).first<{ data: string; actor_id: string }>();
    expect(JSON.parse(event!.data)).toEqual({
      handle: 'secagent',
      findings: 2,
      sha,
      repository: 'secagent/secagent',
    });
    expect(event!.actor_id).toBe(agent.user_id);
  });

  it("the next review reads the agent's new instructions", async () => {
    const { t, admin, repo } = await closedLesson();
    await runLessons(
      t,
      fakeLearner(done(SUMMARY), {
        files: () => ({ 'AGENT.md': learnedMd('secagent') }),
      }).api
    );
    const sha = (await agentRepo(t)).refs.get('refs/heads/main')!;
    await openPull(t, admin, repo, CHANGE, { branch: 'feature2' });
    await startReview(t, 2);
    const { models, calls } = agentModels();
    await runReviews(t, models);
    expect(calls.reviewed).toHaveLength(1);
    expect(calls.reviewed[0].agentSha).toBe(sha);
    expect(calls.reviewed[0].instructions).toContain(
      'Tokens in test fixtures are fake'
    );
  });

  it('nothing to learn: commits nothing, and keeps the explanation', async () => {
    const { t } = await closedLesson();
    const main = (await agentRepo(t)).refs.get('refs/heads/main');
    await runLessons(t, fakeLearner(done('Both were one-offs.')).api);
    expect((await lessons(t))[0]).toMatchObject({
      status: 'nothing',
      summary: 'Both were one-offs.',
      commit_sha: null,
    });
    expect((await agentRepo(t)).refs.get('refs/heads/main')).toBe(main);
    expect(
      await t.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM pr_events WHERE kind = 'learned'`
      ).first('n')
    ).toBe(0);
  });

  it('a rejected edit fails, commits nothing, and is not retried', async () => {
    const { t } = await closedLesson();
    const main = (await agentRepo(t)).refs.get('refs/heads/main');
    await runLessons(
      t,
      fakeLearner(done(SUMMARY), {
        files: () => ({
          'AGENT.md': learnedMd('secagent').replace(
            'secagent agent',
            'lenient agent'
          ),
        }),
      }).api
    );
    expect((await lessons(t))[0]).toMatchObject({
      status: 'failed',
      retryable: 0,
      error: FRONT_MATTER_CHANGED,
    });
    expect((await agentRepo(t)).refs.get('refs/heads/main')).toBe(main);
  });

  it('fails, retryable, when Pi gives up, and records what it spent', async () => {
    const { t } = await closedLesson();
    await runLessons(
      t,
      fakeLearner(() => ({ state: 'unanswered', reason: 'model error' })).api
    );
    const [lesson] = await lessons(t);
    expect(lesson).toMatchObject({
      status: 'failed',
      retryable: 1,
      error: 'The learning model failed: Pi did not finish (model error).',
    });
    expect(
      await t.env.DB.prepare(
        'SELECT feature, requests, tokens_in FROM ai_usage WHERE id = ?'
      )
        .bind(`review-agent-learn:${lesson.id}:1`)
        .first()
    ).toEqual({ feature: 'review-agent-learn', requests: 2, tokens_in: 2000 });
  });

  it('stops a lesson past its wall clock: failed, retryable', async () => {
    const { t } = await closedLesson();
    const learner = fakeLearner(() => ({ state: 'running' }), {
      startedAt: Date.now() - 11 * 60_000,
    });
    await runLessons(t, learner.api);
    expect((await lessons(t))[0]).toMatchObject({
      status: 'failed',
      retryable: 1,
      error: 'The lesson ran out of time (10 minutes).',
    });
    expect(learner.stopped).toHaveLength(1);
  });

  it('runs one lesson of an agent at a time: a second waits, and starts when the first ends', async () => {
    const { t, admin, repo } = await closedLesson();
    // #2: another change request of the same agent, dismissed, then closed. (The finding for a person keeps it from
    // auto-merging once its change request is dismissed.)
    await openPull(t, admin, repo, CHANGE, { branch: 'feature2' });
    await startReview(t, 2);
    await runReviews(t, agentModels({ review: () => FINDINGS }).models);
    const [cr] = (await findings(t, 2)).filter(
      (f) => f.kind === 'change_requested'
    );
    await decide(t, admin, cr.id, 2);
    await closePull(t, admin, 'closed', 2);
    const [first, second] = await lessons(t);
    // #1's lesson is learning in another run when both Workflows run: #2's waits, #1's belongs to that run.
    await t.env.DB.prepare(
      `UPDATE agent_lessons SET status = 'learning', run_id = 'elsewhere', attempts = 1 WHERE id = ?`
    )
      .bind(first.id)
      .run();
    const learner = fakeLearner(done('Nothing general.'));
    await runLessons(t, learner.api);
    expect(learner.starts).toEqual([]);
    expect((await lessons(t)).map((l) => l.status)).toEqual([
      'learning',
      'pending',
    ]);
    // #1's lesson ends: the agent's next lesson starts.
    await t.env.DB.prepare(
      `UPDATE agent_lessons SET status = 'nothing', run_id = NULL WHERE id = ?`
    )
      .bind(first.id)
      .run();
    const db = drizzle(t.env.DB, { schema });
    expect(await startNextLesson(t.env, db, first.agent_id)).toBe(second.id);
    await runLessons(t, learner.api);
    expect((await lessons(t)).map((l) => l.status)).toEqual([
      'nothing',
      'nothing',
    ]);
    expect(learner.starts).toEqual([learnerName(second.id, 1)]);
  });

  it('is dropped when its agent was deleted before it ran', async () => {
    const { t, admin } = await closedLesson();
    await call(t, '/api/admin/agents/secagent', {
      cookie: admin,
      method: 'DELETE',
    });
    const learner = fakeLearner();
    await runLessons(t, learner.api);
    expect(await lessons(t)).toEqual([]);
    expect(learner.starts).toEqual([]);
  });

  it("fails without Pi (no AGENT_REVIEWER binding), and isn't retried", async () => {
    const { t } = await closedLesson();
    await runLessons(t);
    expect((await lessons(t))[0]).toMatchObject({
      status: 'failed',
      retryable: 0,
      error: LEARN_NO_PI,
    });
  });

  it('reads its own, smaller limits from Site admin when it starts', async () => {
    const { t, admin } = await closedLesson();
    const put = (key: string, value: unknown) =>
      call(t, `/api/admin/settings/${key}`, {
        cookie: admin,
        method: 'PUT',
        json: { value },
      });
    expect((await put('review.learn_minutes', 31)).status).toBe(400);
    expect((await put('review.learn_minutes', 5)).status).toBe(200);
    const learner = fakeLearner();
    await runLessons(t, learner.api);
    const [o] = [...learner.objects.values()];
    expect(o.request.limits).toEqual({
      wallClockMs: 5 * 60_000,
      maxToolCalls: 30,
      maxModelCalls: 30,
      maxInputTokens: 1_000_000,
    });
  });

  it('is an agent run of the pull request, its steps said in words', async () => {
    const { t } = await closedLesson();
    const [lesson] = await lessons(t);
    const db = drizzle(t.env.DB, { schema });
    expect(await describeRun(db, { learn: { lessonId: lesson.id } })).toEqual({
      kind: 'learning',
      repositoryId: lesson.repository_id,
      pullRequestId: lesson.pull_request_id,
      title: '@secagent learns from #1',
    });
    expect(decisionFor('lesson', { handle: 'secagent', agentId: 'a' })).toBe(
      '@secagent'
    );
    expect(decisionFor('learn:secagent', { verdict: 'started' })).toBe(
      'Started learning'
    );
    expect(decisionFor('learn:secagent', { verdict: 'waiting' })).toBe(
      "Waiting: another of the agent's lessons is running"
    );
    expect(
      decisionFor('learn-check:secagent:1', {
        state: 'running',
        turns: 2,
        toolCalls: 4,
        durationMs: 60_000,
      })
    ).toBe('Running: 2 turns, 4 tool calls, 1 min');
    expect(
      decisionFor('learn-check:secagent:2', {
        state: 'finished',
        outcome: { verdict: 'committed', sha: 'a'.repeat(40) },
      })
    ).toBe('Committed aaaaaaa');
    expect(
      decisionFor('learn-check:secagent:2', {
        state: 'finished',
        outcome: { verdict: 'nothing' },
      })
    ).toBe('Nothing to learn');
    expect(decisionFor('next:secagent', 'l2')).toBe(
      "Started the agent's next lesson"
    );
  });

  it('resumes its own claim after a retried start step, reading the tip when no base commit was recorded', async () => {
    const { t } = await closedLesson();
    const [run] = learnRuns(t);
    const [lesson] = await lessons(t);
    // An earlier try of `learn:secagent` claimed the lesson for this run, then failed before recording base_sha.
    await t.env.DB.prepare(
      `UPDATE agent_lessons SET status = 'learning', run_id = ?, attempts = 1 WHERE id = ?`
    )
      .bind(run.id, lesson.id)
      .run();
    const learner = fakeLearner(done(SUMMARY), {
      files: () => ({ 'AGENT.md': learnedMd('secagent') }),
    });
    await runLessons(t, learner.api);
    const tip = (await agentRepo(t)).refs.get('refs/heads/main')!;
    expect(learner.starts).toEqual([learnerName(lesson.id, 1)]);
    expect((await lessons(t))[0]).toMatchObject({
      status: 'committed',
      attempts: 1,
      commit_sha: tip,
    });
    expect((await agentRepo(t)).parseCommit(tip)!.parents).toEqual([
      (await lessons(t))[0].base_sha,
    ]);
  });

  it("records a pushed commit even when the lesson stopped being this run's meanwhile, so it is never learned again", async () => {
    const { t } = await closedLesson();
    const [lesson] = await lessons(t);
    // A requeue lands between the push and the commit being recorded.
    const repo = await agentRepo(t);
    const receivePack = repo.receivePack.bind(repo);
    repo.receivePack = async (body) => {
      const out = await receivePack(body);
      await t.env.DB.prepare(
        `UPDATE agent_lessons SET status = 'pending', run_id = NULL WHERE id = ?`
      )
        .bind(lesson.id)
        .run();
      return out;
    };
    await runLessons(
      t,
      fakeLearner(done(SUMMARY), {
        files: () => ({ 'AGENT.md': learnedMd('secagent') }),
      }).api
    );
    const sha = repo.refs.get('refs/heads/main')!;
    expect(sha).not.toBe(lesson.base_sha);
    expect((await lessons(t))[0]).toMatchObject({
      status: 'committed',
      commit_sha: sha,
    });
    // The agent's next lesson run finds nothing pending.
    const db = drizzle(t.env.DB, { schema });
    expect(await startNextLesson(t.env, db, lesson.agent_id)).toBeNull();
  });

  it("pushes nothing once the lesson was requeued and another run claimed it before this run's commit", async () => {
    const { t } = await closedLesson();
    const [lesson] = await lessons(t);
    const main = (await agentRepo(t)).refs.get('refs/heads/main');
    const inner = fakeLearner(done(SUMMARY), {
      files: () => ({ 'AGENT.md': learnedMd('secagent') }),
    });
    // Requeued and reclaimed by run r2 between the learner answering and the stale run's commit step.
    const api = (name: string) => {
      const l = inner.api(name);
      return {
        ...l,
        async learned() {
          await t.env.DB.prepare(
            `UPDATE agent_lessons SET status = 'learning', run_id = 'r2' WHERE id = ?`
          )
            .bind(lesson.id)
            .run();
          return l.learned();
        },
      };
    };
    await runLessons(t, api);
    expect((await agentRepo(t)).refs.get('refs/heads/main')).toBe(main);
    expect((await lessons(t))[0]).toMatchObject({
      status: 'learning',
      run_id: 'r2',
      commit_sha: null,
      summary: null,
    });
    expect(
      await t.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM pr_events WHERE kind = 'learned'`
      ).first('n')
    ).toBe(0);
  });

  it('from a private repository, commits only the summary and the trailers, and tells the learner to stay general', async () => {
    const { t } = await closedLesson();
    await t.env.DB.prepare(
      `UPDATE repositories SET visibility = 'private' WHERE name = 'app'`
    ).run();
    const dismissed = (await findings(t)).filter(
      (f) => f.kind === 'change_requested'
    );
    const learner = fakeLearner(done(SUMMARY), {
      files: () => ({ 'AGENT.md': learnedMd('secagent') }),
    });
    await runLessons(t, learner.api);
    const repo = await agentRepo(t);
    const sha = repo.refs.get('refs/heads/main')!;
    expect((await lessons(t))[0]).toMatchObject({
      status: 'committed',
      commit_sha: sha,
    });
    const message = repo.parseCommit(sha)!.message;
    expect(message).toBe(
      `${SUMMARY}\n\n${dismissed.map((f) => `${LESSON_TRAILER}: ${f.id}`).join('\n')}`
    );
    for (const leak of ['octocat/app', '#1', 'Token logged', 'No expiry'])
      expect(message).not.toContain(leak);
    const [request] = [...learner.objects.values()].map((o) => o.request);
    expect(request.input.pull.private).toBe(true);
    // The learner never receives the private pull request's name, number, title or target.
    expect(request.input.pull).toEqual({
      repository: 'a private repository',
      number: 0,
      title: '',
      target: '',
      private: true,
    });
    expect(
      learnUserPrompt(request.input, 'f'.repeat(24), {
        baseSha: request.baseSha,
        files: 1,
        skipped: 0,
      })
    ).toContain('# The pull request is private');
  });

  it('ends, at the longest allowed limits, before the stale window could requeue it', () => {
    // From the claim (started_at): the start step's worst case, the longest lesson, its last check and the
    // learner's own expiry all end inside the 2-hour window after which a learning lesson counts as stuck.
    expect(
      PI_START_SLACK_MS +
        LEARN_MAX_MINUTES * 60_000 +
        PI_RECHECK_MS +
        PI_EXPIRE_SLACK_MS
    ).toBeLessThan(LEARN_STALE_MS);
    expect(LEARN_STALE_MS).toBe(2 * 3600_000);
  });

  it('records the commit an earlier try already pushed, instead of failing over its own change', async () => {
    const { t } = await closedLesson();
    const [lesson] = await lessons(t);
    const db = drizzle(t.env.DB, { schema });
    const agent = (await agentRow(t))!;
    const repoRow = (await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, agent.repository_id!))
      .get())!;
    const base = (await agentRepo(t)).refs.get('refs/heads/main')!;
    await t.env.DB.prepare(
      `UPDATE agent_lessons SET status = 'learning', run_id = 'r1', attempts = 1, base_sha = ? WHERE id = ?`
    )
      .bind(base, lesson.id)
      .run();
    // The earlier try pushed, then its step died before recording it.
    const pushed = await gitFor(t.env, repoRow).commitFiles({
      branch: 'main',
      parent: base,
      files: { 'AGENT.md': learnedMd('secagent') },
      author: {
        name: agent.user_name,
        email: agent.user_email,
        timestamp: Math.floor(Date.now() / 1000),
      },
      message: lessonCommitMessage({
        summary: SUMMARY,
        number: 1,
        repository: 'octocat/app',
        titles: ['Token logged', 'No expiry'],
        findingIds: JSON.parse(lesson.finding_ids) as string[],
        private: false,
      }),
    });
    expect((await agentRow(t))!.config_sha).not.toBe(pushed);
    const learner = fakeLearner(done(SUMMARY), {
      files: () => ({ 'AGENT.md': learnedMd('secagent') }),
    });
    const limits = {
      wallClockMs: 600_000,
      maxToolCalls: 30,
      maxModelCalls: 30,
      maxInputTokens: 1_000_000,
    };
    await learner
      .api(learnerName(lesson.id, 1))
      .startLearning({ model: 'm', limits } as LearnStartRequest);
    const check = await checkLesson(
      { env: t.env, db, step, learner: learner.api, instanceId: 'r1' },
      lesson.id,
      { attempt: 1, startedAt: Date.now(), model: 'm', limits },
      false
    );
    expect(check).toEqual({
      state: 'finished',
      outcome: { verdict: 'committed', sha: pushed },
    });
    expect((await agentRepo(t)).refs.get('refs/heads/main')).toBe(pushed);
    expect((await lessons(t))[0]).toMatchObject({
      status: 'committed',
      commit_sha: pushed,
      error: null,
    });
    expect((await agentRow(t))!.config_sha).toBe(pushed);
    expect(
      await t.env.DB.prepare(
        `SELECT json_extract(data, '$.sha') AS sha FROM pr_events WHERE kind = 'learned'`
      ).first('sha')
    ).toBe(pushed);
  });

  it("fails its own claim, retryable, when the learner reports stopped at the start, so the agent's next lesson can start", async () => {
    const { t } = await closedLesson();
    const [lesson] = await lessons(t);
    const inner = fakeLearner();
    const api = (name: string) => ({
      ...inner.api(name),
      startLearning: async () => ({ stopped: true as const }),
    });
    await runLessons(t, api);
    expect((await lessons(t))[0]).toMatchObject({
      status: 'failed',
      retryable: 1,
      error: LEARN_STOPPED,
      run_id: learnRuns(t)[0].id,
    });
    const db = drizzle(t.env.DB, { schema });
    // Nothing of the agent is learning any more: a pending lesson of it could start now.
    await t.env.DB.prepare(
      `UPDATE agent_lessons SET status = 'pending' WHERE id = ?`
    )
      .bind(lesson.id)
      .run();
    expect(await startNextLesson(t.env, db, lesson.agent_id)).toBe(lesson.id);
  });
});
