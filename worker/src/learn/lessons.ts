import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import {
  agentLessons,
  agents,
  prClassifications,
  prReviewFlags,
  pullRequests,
  repositories,
  type Agent,
  type AgentLesson,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import { landTargetOf } from '../lib/land-target';
import { findRepoById, readableByMembers } from '../lib/repos';
import type { MergeResolutionParams } from '../merge/workflow';
import { flagTitleOf } from '../review/gate';
import { chunks } from '../stack/view';
import type { LessonFinding, LessonInput } from './contract';

/**
 * What a pull request taught its agents, on any of its commits, per live agent (not deleted, still with its
 * repository), oldest first: the agent change requests a person (or a moderator app acting for one) dismissed, and the
 * findings a person decided with a teach note (approved, dismissed, or with changes requested). Dismissing is
 * approving a `change_requested` finding (`decideFlag`): `approved_at` is set; agents never approve, and approving a
 * needs-person finding is not a dismissal. Undoing a decision clears its teach note, so it teaches nothing.
 */
export async function lessonFindingsByAgent(
  db: DrizzleDB,
  pullRequestId: string
): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ id: prReviewFlags.id, agentId: prReviewFlags.agentId })
    .from(prReviewFlags)
    .innerJoin(
      prClassifications,
      eq(prClassifications.id, prReviewFlags.classificationId)
    )
    .innerJoin(agents, eq(agents.userId, prReviewFlags.agentId))
    .where(
      and(
        eq(prClassifications.pullRequestId, pullRequestId),
        or(
          and(
            eq(prReviewFlags.kind, 'change_requested'),
            isNotNull(prReviewFlags.approvedAt)
          ),
          isNotNull(prReviewFlags.teachNote)
        ),
        isNull(agents.deletedAt),
        isNotNull(agents.repositoryId)
      )
    )
    .orderBy(
      asc(prClassifications.createdAt),
      asc(prReviewFlags.createdAt),
      asc(prReviewFlags.key)
    )
    .all();
  const out = new Map<string, string[]>();
  for (const r of rows)
    if (r.agentId) out.set(r.agentId, [...(out.get(r.agentId) ?? []), r.id]);
  return out;
}

/**
 * When a pull request closes (landed by landPull, or closed unmerged): one lesson per agent whose change requests on
 * it were dismissed, or whose findings a person decided with a teach note. Unique per (agent, pull request) and
 * written before anything runs, so a second close (after a reopen) or a repeated call never queues twice. Returns the
 * ids queued now. Never throws: closing never fails over learning.
 */
export async function queueLessons(
  env: CloudflareBindings,
  db: DrizzleDB,
  pr: Pick<PullRequest, 'id' | 'repositoryId'>
): Promise<string[]> {
  try {
    const queued: string[] = [];
    const now = new Date();
    for (const [agentId, findingIds] of await lessonFindingsByAgent(
      db,
      pr.id
    )) {
      const [row] = await db
        .insert(agentLessons)
        .values({
          id: crypto.randomUUID(),
          agentId,
          pullRequestId: pr.id,
          repositoryId: pr.repositoryId,
          findingIds,
          status: 'pending',
          attempts: 0,
          retryable: false,
          createdAt: now,
        })
        .onConflictDoNothing({
          target: [agentLessons.agentId, agentLessons.pullRequestId],
        })
        .returning({ id: agentLessons.id });
      if (row) {
        queued.push(row.id);
        // A lesson of an agent already learning waits: that run starts the next one when it ends.
        await startLessonRun(env, row.id);
      }
    }
    return queued;
  } catch (e) {
    console.error('[learn] could not queue lessons', pr.id, e);
    return [];
  }
}

/** The lesson is still this run's: learning, claimed by `runId`. Every write of a learn run is fenced on it. */
export const lessonAttempt = (lessonId: string, runId: string) =>
  and(
    eq(agentLessons.id, lessonId),
    eq(agentLessons.status, 'learning'),
    eq(agentLessons.runId, runId)
  );

/** Starts a learn Workflow for a lesson. Never throws: a lost start is picked up by the daily sweep. */
export async function startLessonRun(
  env: CloudflareBindings,
  lessonId: string
): Promise<boolean> {
  const workflow = (env as Partial<CloudflareBindings>).MERGE_RESOLUTION;
  if (!workflow) return false;
  try {
    const params: MergeResolutionParams = { learn: { lessonId } };
    await workflow.create({ id: `learn-${crypto.randomUUID()}`, params });
    return true;
  } catch (e) {
    console.error('[learn] could not start a lesson', lessonId, e);
    return false;
  }
}

/** The agent's oldest pending lesson, started when none of its lessons is learning. Returns its id, or null. */
export async function startNextLesson(
  env: CloudflareBindings,
  db: DrizzleDB,
  agentId: string
): Promise<string | null> {
  const busy = await db
    .select({ id: agentLessons.id })
    .from(agentLessons)
    .where(
      and(
        eq(agentLessons.agentId, agentId),
        eq(agentLessons.status, 'learning')
      )
    )
    .get();
  if (busy) return null;
  const next = await db
    .select({ id: agentLessons.id })
    .from(agentLessons)
    .where(
      and(eq(agentLessons.agentId, agentId), eq(agentLessons.status, 'pending'))
    )
    .orderBy(asc(agentLessons.createdAt), sql`rowid`)
    .get();
  if (!next) return null;
  return (await startLessonRun(env, next.id)) ? next.id : null;
}

/**
 * Claims a pending lesson for run `runId` (pending → learning, attempts + 1), only while no other lesson of its agent
 * is learning. `busy`: another one is; `taken`: it isn't pending any more (another run has it, or it ended).
 */
export async function claimLesson(
  db: DrizzleDB,
  lesson: Pick<AgentLesson, 'id' | 'agentId'>,
  runId: string
): Promise<{ attempt: number } | 'busy' | 'taken'> {
  const other = alias(agentLessons, 'other');
  const [row] = await db
    .update(agentLessons)
    .set({
      status: 'learning',
      runId,
      attempts: sql`${agentLessons.attempts} + 1`,
      baseSha: null,
      startedAt: new Date(),
      finishedAt: null,
      retryable: false,
      error: null,
    })
    .where(
      and(
        eq(agentLessons.id, lesson.id),
        eq(agentLessons.status, 'pending'),
        notExists(
          db
            .select({ id: other.id })
            .from(other)
            .where(
              and(
                eq(other.agentId, lesson.agentId),
                eq(other.status, 'learning')
              )
            )
        )
      )
    )
    .returning({ attempts: agentLessons.attempts });
  if (row) return { attempt: row.attempts };
  const busy = await db
    .select({ id: agentLessons.id })
    .from(agentLessons)
    .where(
      and(
        eq(agentLessons.agentId, lesson.agentId),
        eq(agentLessons.status, 'learning')
      )
    )
    .get();
  return busy ? 'busy' : 'taken';
}

/** Deletes a lesson whose agent is gone, unless it was committed (history). */
export async function dropLesson(db: DrizzleDB, lessonId: string) {
  await db
    .delete(agentLessons)
    .where(
      and(eq(agentLessons.id, lessonId), ne(agentLessons.status, 'committed'))
    );
}

export type LoadedLesson = {
  lesson: AgentLesson;
  agent: Agent;
  handle: string;
  /** The agent's account: the learned commit's author and committer. */
  author: { name: string; email: string };
  /** The agent's own repository; null once deleted. */
  agentRepo: Repository | null;
  pr: PullRequest;
};

/** A lesson with its agent, the agent's account and repository, and its pull request. */
export async function loadLesson(
  db: DrizzleDB,
  lessonId: string
): Promise<LoadedLesson | null> {
  const row = await db
    .select({
      lesson: agentLessons,
      agent: agents,
      user: users,
      agentRepo: repositories,
      pr: pullRequests,
    })
    .from(agentLessons)
    .innerJoin(agents, eq(agents.userId, agentLessons.agentId))
    .innerJoin(users, eq(users.id, agentLessons.agentId))
    .innerJoin(pullRequests, eq(pullRequests.id, agentLessons.pullRequestId))
    .leftJoin(repositories, eq(repositories.id, agents.repositoryId))
    .where(eq(agentLessons.id, lessonId))
    .get();
  if (!row) return null;
  return {
    lesson: row.lesson,
    agent: row.agent,
    handle: row.user.username ?? row.user.id,
    author: { name: row.user.name, email: row.user.email },
    agentRepo: row.agentRepo,
    pr: row.pr,
  };
}

/**
 * What the learner is given: the pull request, and each finding as recorded (in the lesson's order) with how a person
 * decided it and, when they taught one, their rule in their own words.
 */
export async function lessonInput(
  db: DrizzleDB,
  l: LoadedLesson
): Promise<LessonInput> {
  const ids = l.lesson.findingIds;
  const teacher = alias(users, 'teacher');
  const rows = [];
  for (const part of chunks(ids, 90))
    rows.push(
      ...(await db
        .select({
          id: prReviewFlags.id,
          kind: prReviewFlags.kind,
          value: prReviewFlags.value,
          detail: prReviewFlags.detail,
          paths: prReviewFlags.paths,
          headSha: prClassifications.headSha,
          approvedAt: prReviewFlags.approvedAt,
          changesRequestedAt: prReviewFlags.changesRequestedAt,
          via: prReviewFlags.approvedVia,
          by: users.username,
          rule: prReviewFlags.teachNote,
          taughtBy: teacher.username,
        })
        .from(prReviewFlags)
        .innerJoin(
          prClassifications,
          eq(prClassifications.id, prReviewFlags.classificationId)
        )
        // Whoever made the decision: the approval (or dismissal), else the request for changes.
        .leftJoin(
          users,
          eq(
            users.id,
            sql`coalesce(${prReviewFlags.approvedById}, ${prReviewFlags.changesRequestedById})`
          )
        )
        .leftJoin(teacher, eq(teacher.id, prReviewFlags.teachById))
        .where(inArray(prReviewFlags.id, part))
        .all())
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const found = await findRepoById(db, l.pr.repositoryId);
  return {
    handle: l.handle,
    pull: {
      repository: found
        ? `${found.namespace.username}/${found.repo.name}`
        : 'a deleted repository',
      number: l.pr.number,
      title: l.pr.title,
      target: landTargetOf(l.pr),
      // Agent repositories are internal: what a private repository taught is kept out of them.
      private: !found || !readableByMembers(found.repo),
    },
    findings: ids.flatMap((id) => {
      const r = byId.get(id);
      if (!r) return [];
      const decision: LessonFinding['decision'] = r.approvedAt
        ? r.kind === 'change_requested'
          ? 'dismissed'
          : 'approved'
        : 'changes_requested';
      return [
        {
          id,
          title: flagTitleOf({ value: r.value }),
          detail: r.detail,
          paths: r.paths,
          headSha: r.headSha,
          decision,
          dismissedBy: r.by ?? null,
          via: r.via,
          dismissedAt: (
            r.approvedAt ??
            r.changesRequestedAt ??
            new Date(0)
          ).toISOString(),
          rule: r.rule,
          taughtBy: r.rule ? (r.taughtBy ?? null) : null,
        },
      ];
    }),
  };
}
