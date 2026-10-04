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

/**
 * The durable runner behind merge automation (binding MERGE_RESOLUTION): one AI conflict
 * resolution attempt, one auto-merge review of a pull request commit, or a sweep that checks the
 * open pull requests a push or merge affected.
 */
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
        { env: this.env, db, step: runner, models: workersAiModels(this.env) },
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
