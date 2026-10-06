import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { executeSweep, type SweepParams } from './auto';
import { executeResolution, type StepRunner } from './resolution';
import {
  executeHeadReview,
  executeReviewerRetry,
  stopLegacyReview,
} from '../review/head';
import { headReviewId } from '../review/keys';
import { workersAiAgentModels } from '../review/models';
import { getSettings } from '../lib/settings';
import { executeStacking, type StackParams } from '../stack/discover';
import { workersAiStackModels } from '../stack/models';
import { recordAgentRun } from '../agent-runs/record';
import { settleAfterPayload } from '../pulls/settle';
import { executeReconcile, type ReconcileParams } from '../stack/reconcile';

type PayloadKey =
  | 'resolutionId'
  | 'sweep'
  | 'classificationId'
  | 'stack'
  | 'reconcile'
  | 'headReview'
  | 'reviewer';
/** Exactly one payload key is set. */
type Only<K extends PayloadKey, V> = { [P in K]: V } & {
  [P in Exclude<PayloadKey, K>]?: undefined;
};

export type MergeResolutionParams =
  | Only<'resolutionId', string>
  | Only<'sweep', SweepParams>
  /** A review.yml review started before reviewer agents (stopped on arrival). */
  | Only<'classificationId', string>
  | Only<'stack', StackParams>
  | Only<'reconcile', ReconcileParams>
  /** Review one head commit with the repository's agents. */
  | Only<'headReview', { id: string }>
  /** Retry one agent's failed review (pr_reviewers.id). */
  | Only<'reviewer', { id: string }>;

/**
 * MERGE_RESOLUTION: runs an AI resolution attempt, an auto-merge review, a conflict sweep, stacking discovery, or a
 * stack reconcile.
 */
export class MergeResolutionWorkflow extends WorkflowEntrypoint<
  CloudflareBindings,
  MergeResolutionParams
> {
  async run(event: WorkflowEvent<MergeResolutionParams>, step: WorkflowStep) {
    const db = drizzle(this.env.DB, { schema });
    // Every run shows in the Actions tab under Agent, step by step (agent-runs/record.ts).
    await recordAgentRun(
      this.env,
      db,
      event,
      // The executors' results are plain JSON; adapt to WorkflowStep's Serializable typing.
      step as unknown as StepRunner,
      (runner) => this.execute(event, runner)
    );
  }

  private async execute(
    event: WorkflowEvent<MergeResolutionParams>,
    runner: StepRunner
  ) {
    const db = drizzle(this.env.DB, { schema });
    const p = event.payload;
    if (p.headReview || p.reviewer) {
      const ids = await getSettings(db, this.env, [
        'ai.summary_model',
        'ai.review_model',
      ]);
      const reviewer = p.reviewer
        ? await db.query.prReviewers.findFirst({
            where: (x, { eq }) => eq(x.id, p.reviewer!.id),
            columns: { pullRequestId: true, headSha: true },
          })
        : undefined;
      const reviewId =
        p.headReview?.id ??
        (reviewer
          ? headReviewId(reviewer.pullRequestId, reviewer.headSha)
          : undefined);
      const deps = {
        env: this.env,
        db,
        step: runner,
        models: workersAiAgentModels(
          this.env,
          { summary: ids['ai.summary_model'], review: ids['ai.review_model'] },
          { classificationId: reviewId }
        ),
      };
      if (p.headReview) await executeHeadReview(deps, p.headReview.id);
      else await executeReviewerRetry(deps, p.reviewer!.id);
    } else if (p.classificationId) {
      await stopLegacyReview(db, p.classificationId);
    } else if (p.stack) {
      const ids = await getSettings(db, this.env, ['ai.review_model']);
      const pr = p.stack.pullRequestId;
      const row = await db.query.pullRequests.findFirst({
        where: (x, { eq }) => eq(x.id, pr),
        columns: { repositoryId: true },
      });
      if (row)
        await executeStacking(
          {
            env: this.env,
            db,
            step: runner,
            models: workersAiStackModels(
              this.env,
              { review: ids['ai.review_model'] },
              { repositoryId: row.repositoryId, pullRequestId: pr }
            ),
          },
          p.stack
        );
    } else if (p.sweep) {
      await executeSweep({ env: this.env, db, step: runner }, p.sweep);
    } else if (p.reconcile) {
      const ids = await getSettings(db, this.env, ['ai.review_model']);
      await executeReconcile(
        {
          env: this.env,
          db,
          step: runner,
          models: workersAiStackModels(
            this.env,
            { review: ids['ai.review_model'] },
            { repositoryId: p.reconcile.repositoryId, pullRequestId: null }
          ),
        },
        p.reconcile
      );
    } else {
      await executeResolution(
        {
          env: this.env,
          db,
          step: runner,
          resolver: (id) => this.env.MERGE_RESOLVER.getByName(id),
        },
        p.resolutionId!
      );
    }
    // Whatever ran may have moved pull requests to another state: record changes for the timeline.
    await runner.do('states', async () => {
      await settleAfterPayload(this.env, db, p);
      return true;
    });
  }
}
