import type { Repository } from '../db/app.schema';
import type { DrizzleDB } from '../db/middleware';
import type { GitService } from '../git/service';
import { listAudit, type AuditEvent } from './audit';
import { mergeQueue, type QueueTarget } from './queue';
import { repoSessions, type SessionSummary } from './sessions';

// The Live page: who is working on the repository right now. The merge queue, the requests "floor" (open pull
// requests grouped by coding session or person, with their states) and the newest audit and timeline events. The page
// refetches it on the repository's live pings (`repo:<id>`).

export const LIVE_EVENTS = 50;

export type LivePayload = {
  queue: QueueTarget[];
  floor: SessionSummary[];
  events: AuditEvent[];
};

/** One read of each: the queue's pull request states are reused for the floor (computed once). */
export async function liveFeed(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  repo: Repository
): Promise<LivePayload> {
  const queue = await mergeQueue(env, db, git, repo);
  const [floor, audit] = await Promise.all([
    repoSessions(env, db, git, repo, { openOnly: true, states: queue.states }),
    listAudit(db, { repositoryId: repo.id, limit: LIVE_EVENTS }),
  ]);
  return { queue: queue.targets, floor, events: audit.events };
}
