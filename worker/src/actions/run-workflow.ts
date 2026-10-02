import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { executeRun, type StepRunner } from './executor';

export type ActionsRunParams = { runId: string };

/**
 * One GitOrange Actions run. Each job step is a durable Workflow step, so a run survives
 * worker restarts and resumes where it left off; the commands themselves run in a JobRunner
 * container per job.
 */
export class ActionsRun extends WorkflowEntrypoint<
  CloudflareBindings,
  ActionsRunParams
> {
  async run(event: WorkflowEvent<ActionsRunParams>, step: WorkflowStep) {
    await executeRun(
      {
        env: this.env,
        db: drizzle(this.env.DB, { schema }),
        // The executor's results are plain JSON; adapt to WorkflowStep's Serializable typing.
        step: step as unknown as StepRunner,
        runner: (jobId) => this.env.JOB_RUNNER.getByName(jobId),
      },
      event.payload.runId
    );
  }
}
