/** How a learn run ends a lesson: failed, or its edit validated and committed (or nothing), fenced on the run. */
import { eq } from 'drizzle-orm';
import { agentLessons, type AgentLesson } from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import { refreshAgentConfig } from '../agents/refresh';
import { gitFor } from '../lib/repos';
import { publishChange } from '../live/publish';
import { recordEvent } from '../pulls/events';
import type { PiStatus } from '../review/pi-contract';
import { recordAiUsage } from '../usage/record';
import {
  commitLearned,
  findLessonCommit,
  lessonCommitMessage,
  type LearnedCommit,
} from './commit';
import type { LearnedFiles } from './contract';
import { dropLesson, lessonAttempt, lessonInput, loadLesson } from './lessons';

export type LearnOutcome =
  | { verdict: 'committed'; sha: string }
  | { verdict: 'nothing' }
  | { verdict: 'failed'; error: string }
  | { verdict: 'skipped' };

/** The outcome a lesson already records (a check re-run after its write landed). */
export function outcomeOf(lesson: AgentLesson): LearnOutcome {
  if (lesson.status === 'committed' && lesson.commitSha)
    return { verdict: 'committed', sha: lesson.commitSha };
  if (lesson.status === 'nothing') return { verdict: 'nothing' };
  if (lesson.status === 'failed')
    return { verdict: 'failed', error: lesson.error ?? 'The lesson failed.' };
  return { verdict: 'skipped' };
}

/** The learner's summary as stored: trimmed, at most 1,000 characters. */
export const clipSummary = (text: string) => text.trim().slice(0, 1000);

/** Fails the lesson, only while it is still this run's. `retryable`: the daily sweep may try once more. */
export async function failLesson(
  db: DrizzleDB,
  lessonId: string,
  runId: string,
  error: string,
  retryable: boolean
): Promise<LearnOutcome> {
  await db
    .update(agentLessons)
    .set({ status: 'failed', error, retryable, finishedAt: new Date() })
    .where(lessonAttempt(lessonId, runId));
  return { verdict: 'failed', error };
}

/** One attempt's spend, as one ai_usage row under a stable id (a later record replaces it). */
export async function recordLearnUsage(
  env: CloudflareBindings,
  lesson: Pick<AgentLesson, 'id' | 'repositoryId' | 'pullRequestId'>,
  started: { attempt: number; model: string },
  s: PiStatus
) {
  await recordAiUsage(env, {
    id: `review-agent-learn:${lesson.id}:${started.attempt}`,
    feature: 'review-agent-learn',
    model: started.model,
    requests: Math.max(1, s.turns),
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    tokensCached: s.tokensCached,
    repositoryId: lesson.repositoryId,
    pullRequestId: lesson.pullRequestId,
  });
}

/**
 * The learner answered: validates its changed files and commits them as the agent (commitLearned, the only way a
 * lesson writes to the agent's repository), then records the lesson. A commit an earlier try already pushed
 * (findLessonCommit) is recorded instead of pushing again; otherwise nothing is pushed unless the lesson is still this
 * run's (lessonAttempt, checked just before the push: a requeued lesson is skipped). `failed` and `nothing` are fenced
 * on the run;
 * `committed` only on the lesson (the push already happened, so whichever run holds the row now, it must never learn
 * this again). A commit refreshes the agent's cached AGENT.md (the next review reads it) and adds a `learned` event
 * to the pull request's timeline. An agent deleted meanwhile drops the lesson.
 */
export async function commitLesson(
  env: CloudflareBindings,
  db: DrizzleDB,
  lesson: AgentLesson,
  runId: string,
  files: LearnedFiles['files'],
  answer: string
): Promise<LearnOutcome> {
  const loaded = await loadLesson(db, lesson.id);
  if (!loaded?.agentRepo || loaded.agent.deletedAt) {
    await dropLesson(db, lesson.id);
    return { verdict: 'skipped' };
  }
  if (!lesson.baseSha)
    return failLesson(
      db,
      lesson.id,
      runId,
      'The lesson has no base commit.',
      false
    );
  const { agentRepo } = loaded;
  const summary = clipSummary(answer);
  const input = await lessonInput(db, loaded);
  // An earlier try of this check pushed the commit, then died before recording it: record that one, push nothing.
  const pushed = await findLessonCommit(
    gitFor(env, agentRepo),
    agentRepo.defaultBranch,
    lesson.baseSha,
    loaded.author,
    lesson.findingIds
  );
  if (!pushed) {
    // Requeued or reclaimed meanwhile: another run owns the lesson, so this one pushes nothing.
    const ours = await db
      .select({ id: agentLessons.id })
      .from(agentLessons)
      .where(lessonAttempt(lesson.id, runId))
      .get();
    if (!ours) return { verdict: 'skipped' };
  }
  const result: LearnedCommit = pushed
    ? { status: 'committed', sha: pushed }
    : await commitLearned({
        git: gitFor(env, agentRepo),
        fresh: () => gitFor(env, agentRepo),
        branch: agentRepo.defaultBranch,
        baseSha: lesson.baseSha,
        files,
        author: { ...loaded.author, timestamp: Math.floor(Date.now() / 1000) },
        message: lessonCommitMessage({
          summary,
          number: loaded.pr.number,
          repository: input.pull.repository,
          pullTitle: loaded.pr.title,
          titles: input.findings.map((f) => f.title),
          findingIds: lesson.findingIds,
          private: input.pull.private,
        }),
      });
  const finishedAt = new Date();
  const fence = lessonAttempt(lesson.id, runId);
  if (result.status === 'failed') {
    await db
      .update(agentLessons)
      .set({
        status: 'failed',
        summary,
        error: result.error,
        retryable: false,
        finishedAt,
      })
      .where(fence);
    await publishChange(env, lesson.repositoryId);
    return { verdict: 'failed', error: result.error };
  }
  if (result.status === 'nothing') {
    await db
      .update(agentLessons)
      .set({ status: 'nothing', summary, error: null, finishedAt })
      .where(fence);
    await publishChange(env, lesson.repositoryId);
    return { verdict: 'nothing' };
  }
  // The push is the commit point: whatever run holds the row now (a requeue may have reclaimed it), it is committed.
  const written = await db
    .update(agentLessons)
    .set({
      status: 'committed',
      commitSha: result.sha,
      summary,
      error: null,
      retryable: false,
      finishedAt,
    })
    .where(eq(agentLessons.id, lesson.id))
    .returning({ id: agentLessons.id });
  await refreshAgentConfig(env, db, agentRepo.id);
  if (written.length)
    await recordEvent(db, {
      id: `learned:${lesson.id}`,
      repositoryId: lesson.repositoryId,
      pullRequestId: lesson.pullRequestId,
      kind: 'learned',
      actorId: lesson.agentId,
      data: {
        handle: loaded.handle,
        findings: lesson.findingIds.length,
        sha: result.sha,
        repository: `${loaded.handle}/${agentRepo.name}`,
      },
    });
  await publishChange(env, agentRepo.id);
  await publishChange(env, lesson.repositoryId);
  return { verdict: 'committed', sha: result.sha };
}
