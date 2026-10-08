import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { executeSweep, type SweepParams } from './auto';
import type { StepRunner } from './resolution';
import { executeRebase, type RebaseParams } from './rebase';
import { executeHeadReview, executeReviewerRetry } from '../review/head';
import { headReviewId } from '../review/keys';
import { workersAiAgentModels } from '../review/models';
import type { PiReviewerApi } from '../review/pi-contract';
import { getSettings } from '../lib/settings';
import { executeStacking, type StackParams } from '../stack/discover';
import { workersAiStackModels } from '../stack/models';
import { recordAgentRun } from '../agent-runs/record';
import { settleAfterPayload } from '../pulls/settle';
import { executeReconcile, type ReconcileParams } from '../stack/reconcile';
import type { LearnerApi } from '../learn/contract';
import { executeLearn } from '../learn/run';

type PayloadKey =
  | 'resolutionId'
  | 'rebase'
  | 'sweep'
  | 'stack'
  | 'reconcile'
  | 'headReview'
  | 'reviewer'
  | 'learn';
/** Exactly one payload key is set. */
type Only<K extends PayloadKey, V> = { [P in K]: V } & {
  [P in Exclude<PayloadKey, K>]?: undefined;
};

export type MergeResolutionParams =
  /** Squash-era AI resolution: instances started before rebase merging do nothing. */
  | Only<'resolutionId', string>
  /** Rebase one pull request onto its base (merge/rebase.ts). */
  | Only<'rebase', RebaseParams>
  | Only<'sweep', SweepParams>
  | Only<'stack', StackParams>
  | Only<'reconcile', ReconcileParams>
  /** Review one head commit with the repository's agents. */
  | Only<'headReview', { id: string }>
  /** Retry one agent's failed review (pr_reviewers.id). */
  | Only<'reviewer', { id: string }>
  /** Learn from one lesson: an agent's dismissed change requests on a closed pull request (agent_lessons.id). */
  | Only<'learn', { lessonId: string }>;

/** MERGE_RESOLUTION: runs a rebase, an agents' review, a sweep, stacking discovery, a stack reconcile, or a lesson. */
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
      const piBinding = (this.env as Partial<CloudflareBindings>)
        .AGENT_REVIEWER;
      const deps = {
        env: this.env,
        db,
        step: runner,
        models: workersAiAgentModels(
          this.env,
          { summary: ids['ai.summary_model'], review: ids['ai.review_model'] },
          { classificationId: reviewId }
        ),
        // Without the binding, engine: pi agents review as a single pass and say so.
        pi: piBinding
          ? (name: string) =>
              piBinding.getByName(name) as unknown as PiReviewerApi
          : undefined,
        instanceId: event.instanceId,
      };
      if (p.headReview) await executeHeadReview(deps, p.headReview.id);
      else await executeReviewerRetry(deps, p.reviewer!.id);
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
    } else if (p.learn) {
      const binding = (this.env as Partial<CloudflareBindings>).AGENT_REVIEWER;
      await executeLearn(
        {
          env: this.env,
          db,
          step: runner,
          learner: binding
            ? (name: string) => binding.getByName(name) as unknown as LearnerApi
            : undefined,
          instanceId: event.instanceId,
        },
        p.learn.lessonId
      );
    } else if (p.rebase) {
      const resolver = (this.env as Partial<CloudflareBindings>).MERGE_RESOLVER;
      await executeRebase(
        {
          env: this.env,
          db,
          step: runner,
          resolver: resolver
            ? (id: string) => resolver.getByName(id)
            : undefined,
          instanceId: event.instanceId,
        },
        p.rebase
      );
    }
    // p.resolutionId: squash-era, cancelled by migration 0025; nothing to do.
    // Whatever ran may have moved pull requests to another state: record changes for the timeline.
    await runner.do('states', async () => {
      await settleAfterPayload(this.env, db, p);
      return true;
    });
  }
}
