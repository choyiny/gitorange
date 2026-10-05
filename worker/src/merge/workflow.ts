import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { executeSweep, type SweepParams } from './auto';
import { executeResolution, type StepRunner } from './resolution';
import { executeClassification } from '../review/classify';
import { workersAiModels } from '../review/models';
import { getSettings } from '../lib/settings';
import { executeStacking, type StackParams } from '../stack/discover';
import { workersAiStackModels } from '../stack/models';
import { recordAgentRun } from '../agent-runs/record';
import { settleAfterPayload } from '../pulls/settle';

export type MergeResolutionParams =
  | {
      resolutionId: string;
      sweep?: undefined;
      classificationId?: undefined;
      stack?: undefined;
    }
  | {
      sweep: SweepParams;
      resolutionId?: undefined;
      classificationId?: undefined;
      stack?: undefined;
    }
  | {
      classificationId: string;
      resolutionId?: undefined;
      sweep?: undefined;
      stack?: undefined;
    }
  | {
      stack: StackParams;
      resolutionId?: undefined;
      sweep?: undefined;
      classificationId?: undefined;
    };

/** MERGE_RESOLUTION: runs an AI resolution attempt, an auto-merge review, a conflict sweep, or stacking discovery. */
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
    if (p.classificationId) {
      const ids = await getSettings(db, this.env, [
        'ai.summary_model',
        'ai.review_model',
      ]);
      const models = workersAiModels(
        this.env,
        { summary: ids['ai.summary_model'], review: ids['ai.review_model'] },
        { classificationId: p.classificationId }
      );
      await executeClassification(
        { env: this.env, db, step: runner, models },
        p.classificationId
      );
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
