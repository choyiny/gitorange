/**
 * Scheduled jobs, dispatched on the cron expression that fired. Each expression must also be in
 * `triggers.crons` in every wrangler template; add a job by adding an entry here and there.
 */
import { drizzle } from 'drizzle-orm/d1';
import { runActionsRetention } from './actions/retention';
import { schema } from './db/schema';
import { syncUsageCron } from './usage/sync';

/** Usage & cost: pulls the previous days' Cloudflare analytics (02:30 UTC). */
export const USAGE_SYNC_CRON = '30 2 * * *';
/** Deletes Actions runs past their retention (04:17 UTC). */
export const ACTIONS_RETENTION_CRON = '17 4 * * *';

export const CRON_JOBS: Record<
  string,
  (env: CloudflareBindings) => Promise<unknown>
> = {
  [USAGE_SYNC_CRON]: syncUsageCron,
  [ACTIONS_RETENTION_CRON]: (env) =>
    runActionsRetention(env, drizzle(env.DB, { schema })),
};

export async function runScheduled(
  controller: Pick<ScheduledController, 'cron'>,
  env: CloudflareBindings
) {
  const job = CRON_JOBS[controller.cron];
  if (!job) {
    console.warn('[cron] no job for', controller.cron);
    return;
  }
  await job(env);
}
