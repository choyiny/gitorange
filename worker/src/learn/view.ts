/** Lessons as people see them: on an agent's profile and over MCP, only for pull requests the viewer can read. */
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import {
  agentLessons,
  prReviewFlags,
  pullRequests,
  repositories,
  type AgentLesson,
  type LessonStatus,
} from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import { findReposByIds, visibleTo } from '../lib/repos';
import { flagTitleOf } from '../review/gate';
import { chunks } from '../stack/view';
import type { SessionUser } from '../variables';

export type LessonView = {
  id: string;
  /** The pull request's repository, `owner/name`. */
  repository: string;
  number: number;
  title: string;
  /** The dismissed findings' titles. */
  findings: string[];
  status: LessonStatus;
  commitSha: string | null;
  summary: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

type Row = { lesson: AgentLesson; number: number; title: string };

async function views(
  db: DrizzleDB,
  rows: Row[]
): Promise<{ agentId: string; view: LessonView }[]> {
  const repos = await findReposByIds(
    db,
    rows.map((r) => r.lesson.repositoryId)
  );
  const titles = new Map<string, string>();
  for (const part of chunks(
    [...new Set(rows.flatMap((r) => r.lesson.findingIds))],
    90
  ))
    for (const f of await db
      .select({ id: prReviewFlags.id, value: prReviewFlags.value })
      .from(prReviewFlags)
      .where(inArray(prReviewFlags.id, part))
      .all())
      titles.set(f.id, flagTitleOf({ value: f.value }));
  return rows.flatMap(({ lesson, number, title }) => {
    const found = repos.get(lesson.repositoryId);
    if (!found) return [];
    return [
      {
        agentId: lesson.agentId,
        view: {
          id: lesson.id,
          repository: `${found.namespace.username}/${found.repo.name}`,
          number,
          title,
          findings: lesson.findingIds.flatMap((id) => {
            const t = titles.get(id);
            return t ? [t] : [];
          }),
          status: lesson.status,
          commitSha: lesson.commitSha,
          summary: lesson.summary,
          error: lesson.error,
          createdAt: lesson.createdAt.toISOString(),
          finishedAt: lesson.finishedAt?.toISOString() ?? null,
        },
      },
    ];
  });
}

/** An agent's latest lessons in repositories `viewer` can see, newest first (its profile). */
export async function recentLessons(
  db: DrizzleDB,
  agentId: string,
  viewer: SessionUser,
  limit = 10
): Promise<LessonView[]> {
  const visible = visibleTo(viewer);
  const rows = await db
    .select({
      lesson: agentLessons,
      number: pullRequests.number,
      title: pullRequests.title,
    })
    .from(agentLessons)
    .innerJoin(pullRequests, eq(pullRequests.id, agentLessons.pullRequestId))
    .innerJoin(repositories, eq(repositories.id, agentLessons.repositoryId))
    .where(
      and(eq(agentLessons.agentId, agentId), ...(visible ? [visible] : []))
    )
    .orderBy(desc(agentLessons.createdAt), desc(sql`${agentLessons}.rowid`))
    .limit(limit)
    .all();
  return (await views(db, rows)).map((v) => v.view);
}

/** Each agent's latest `perAgent` lessons that `viewer` can see, newest first, batched (gitorange_list_agents). */
export async function latestLessons(
  db: DrizzleDB,
  agentIds: string[],
  viewer: SessionUser,
  perAgent = 3
): Promise<Map<string, LessonView[]>> {
  const visible = visibleTo(viewer);
  const out = new Map<string, LessonView[]>();
  for (const part of chunks(agentIds, 90)) {
    const ranked = db
      .select({
        id: agentLessons.id,
        rank: sql<number>`row_number() OVER (PARTITION BY ${agentLessons.agentId} ORDER BY ${agentLessons.createdAt} DESC, ${agentLessons.id})`.as(
          'rank'
        ),
      })
      .from(agentLessons)
      .innerJoin(repositories, eq(repositories.id, agentLessons.repositoryId))
      .where(
        and(inArray(agentLessons.agentId, part), ...(visible ? [visible] : []))
      )
      .as('ranked');
    const rows = await db
      .select({
        lesson: agentLessons,
        number: pullRequests.number,
        title: pullRequests.title,
      })
      .from(ranked)
      .innerJoin(agentLessons, eq(agentLessons.id, ranked.id))
      .innerJoin(pullRequests, eq(pullRequests.id, agentLessons.pullRequestId))
      .where(lte(ranked.rank, perAgent))
      .orderBy(desc(agentLessons.createdAt))
      .all();
    for (const { agentId, view } of await views(db, rows))
      out.set(agentId, [...(out.get(agentId) ?? []), view]);
  }
  return out;
}
