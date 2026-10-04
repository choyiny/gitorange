import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { executeRun, type StepRunner } from './executor';

export type ActionsRunParams = { runId: string };

/** One Actions run; each job step is a durable Workflow step, commands run in a JobRunner. */
export class ActionsRun extends WorkflowEntrypoint<
  CloudflareBindings,
  ActionsRunParams
> {
  async run(event: WorkflowEvent<ActionsRunParams>, step: WorkflowStep) {
    await executeRun(
      {
        env: this.env,
        db: drizzle(this.env.DB, { schema }),
        // Results are plain JSON; adapts to WorkflowStep's Serializable typing.
        step: step as unknown as StepRunner,
        runner: (jobId) => this.env.JOB_RUNNER.getByName(jobId),
      },
      event.payload.runId
    );
  }
}
