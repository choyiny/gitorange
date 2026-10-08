import type { WorkflowStepConfig } from 'cloudflare:workers';
import { and, desc, eq, isNull, notLike, or, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import { mergeResolutions, type MergeResolution } from '../db/app.schema';
import { getSetting } from '../lib/settings';

/** R2 key of a resolution's transcript. */
export const transcriptKey = (repoId: string, id: string) =>
  `merge-resolutions/${repoId}/${id}.json`;

/** The error a row gets when newer commits replaced the ones it was for. */
export const SUPERSEDED = 'Superseded by newer commits.';
/** The model of a failed row recording a stop AI never attempted (binary, delete/edit, generated, too many). */
export const NO_MODEL = 'none';
/**
 * The error of the row a rebase run records when replaying left nothing (the base already has every change): the
 * branch is left alone, and the pull request shows nothing to merge. Not a conflict.
 */
export const NOTHING_TO_MERGE =
  'Nothing to merge: the base already has every change on this branch.';

/**
 * How every "not rebased" stop message starts (merge/rebase.ts rebaseBlocked). Such a row only shows a block while it
 * applies (checked live): it is never a pull request's outcome at its tips, so it never shadows a real stop.
 */
export const NOT_REBASED = 'Not rebased:';
export const isNotRebased = (error: string | null) =>
  !!error?.startsWith(NOT_REBASED);

/**
 * How long a sweep waits before it starts rebases, so a burst of landings on the target wakes to the same tip and ends
 * in one rebase per pull request instead of one per landing.
 */
export const SETTLE_MS = 45_000;

/** The model conflict resolution uses: Site admin's setting, else `RESOLVER_MODEL`. */
export const resolverModel = (db: DrizzleDB, env: CloudflareBindings) =>
  getSetting(db, env, 'ai.resolver_model');

/** Whether the MERGE_RESOLUTION Workflow (rebases, reviews, stacking, lessons) runs here. */
export function resolutionConfigured(env: CloudflareBindings): boolean {
  return Boolean((env as Partial<CloudflareBindings>).MERGE_RESOLUTION);
}

/**
 * SQL: the merge_resolutions row (table or alias `t`) was written by a rebase: a commit's row, or a stop of the rebase
 * as a whole (its id ends `-all`, or `-all-not-rebased`: see rebase.ts resolutionId). A squash-era row (commit_sha
 * NULL, a random id) is never one; such rows may still be written after the migration by the code it replaces, until
 * this deploys, and must not read as a rebase stop at the same tips.
 */
export const rebaseRow = (t: string) =>
  sql.raw(
    `(${t}.commit_sha IS NOT NULL OR ${t}.id LIKE '%-all' OR ${t}.id LIKE '%-all-not-rebased')`
  );

/**
 * The latest merge_resolutions row of a pull request that is an outcome of its rebase (a run writes its rows in replay
 * order: rowid breaks a tie). "Not rebased" rows are left out: a lifted block must never hide a real stop. So are
 * squash-era rows (rebaseRow).
 */
export async function latestResolution(
  db: DrizzleDB,
  pullRequestId: string
): Promise<MergeResolution | undefined> {
  return db
    .select()
    .from(mergeResolutions)
    .where(
      and(
        eq(mergeResolutions.pullRequestId, pullRequestId),
        rebaseRow('merge_resolutions'),
        or(
          isNull(mergeResolutions.errorMessage),
          notLike(mergeResolutions.errorMessage, `${NOT_REBASED}%`)
        )
      )
    )
    .orderBy(desc(mergeResolutions.createdAt), sql`rowid DESC`)
    .limit(1)
    .get();
}

/** The part of WorkflowStep the executors use; tests pass a direct-call fake. */
export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    fn: () => Promise<T>
  ): Promise<T>;
  /** A durable sleep (milliseconds). */
  sleep(name: string, duration: number): Promise<void>;
  /**
   * Waits for `instance.sendEvent({ type })`; throws when `timeout` passes first. Optional: callers fall back to a
   * sleep where a runner lacks it.
   */
  waitForEvent?<T = unknown>(
    name: string,
    options: { type: string; timeout?: string }
  ): Promise<{ payload: T }>;
}
