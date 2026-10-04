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

export type MergeResolutionParams =
  | { resolutionId: string; sweep?: undefined; classificationId?: undefined }
  | {
      sweep: SweepParams;
      resolutionId?: undefined;
      classificationId?: undefined;
    }
  | { classificationId: string; resolutionId?: undefined; sweep?: undefined };

/** MERGE_RESOLUTION: runs an AI resolution attempt, an auto-merge review, or a conflict sweep. */
export class MergeResolutionWorkflow extends WorkflowEntrypoint<
  CloudflareBindings,
  MergeResolutionParams
> {
  async run(event: WorkflowEvent<MergeResolutionParams>, step: WorkflowStep) {
    const db = drizzle(this.env.DB, { schema });
    // The executors' results are plain JSON; adapt to WorkflowStep's Serializable typing.
    const runner = step as unknown as StepRunner;
    if (event.payload.classificationId) {
      await executeClassification(
        {
          env: this.env,
          db,
          step: runner,
          models: workersAiModels(this.env, {
            classificationId: event.payload.classificationId,
          }),
        },
        event.payload.classificationId
      );
      return;
    }
    if (event.payload.sweep) {
      await executeSweep(
        { env: this.env, db, step: runner },
        event.payload.sweep
      );
      return;
    }
    await executeResolution(
      {
        env: this.env,
        db,
        step: runner,
        resolver: (id) => this.env.MERGE_RESOLVER.getByName(id),
      },
      event.payload.resolutionId!
    );
  }
}
