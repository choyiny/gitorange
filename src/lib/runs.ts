/** Workflow runs, jobs and steps (Actions): the small decisions the run and job pages make. */
import type { Tone } from './agentLook';
import type { RunConclusion, RunStatus, WorkflowStep } from './uiApi';

/** A log line the page draws in red. */
export const isErrorLine = (line: string): boolean =>
  /^(Error|##\[error\])/.test(line);

/** The step a job opens on its own: the one running, else the first that failed (like GitHub). */
export function focusStep(
  steps: Pick<WorkflowStep, 'number' | 'status' | 'conclusion'>[]
): number | null {
  return (
    steps.find((s) => s.status === 'in_progress')?.number ??
    steps.find((s) => s.conclusion === 'failure')?.number ??
    null
  );
}

/** Tone for a run, job or step chip. */
export function runTone(status: RunStatus, conclusion: RunConclusion): Tone {
  if (status === 'in_progress') return 'info';
  if (status === 'completed' && conclusion === 'success') return 'good';
  if (status === 'completed' && conclusion === 'failure') return 'critical';
  return 'off';
}

/** A run, job or step's state in words (the chip says the same). */
export function runLabel(status: RunStatus, conclusion: RunConclusion): string {
  if (status === 'queued') return 'Queued';
  if (status === 'in_progress') return 'In progress';
  return (
    {
      success: 'Passed',
      failure: 'Failed',
      cancelled: 'Cancelled',
      skipped: 'Skipped',
    }[conclusion ?? 'skipped'] ?? 'Done'
  );
}

/** A step's state in words, for assistive tech and tooltips. */
export function stepLabel(
  status: RunStatus,
  conclusion: RunConclusion
): string {
  if (status === 'queued') return 'Waiting to start';
  if (status === 'in_progress') return 'Running';
  return (
    {
      success: 'Passed',
      failure: 'Failed',
      cancelled: 'Cancelled',
      skipped: 'Skipped',
    }[conclusion ?? 'skipped'] ?? 'Done'
  );
}

/** Whether the run page shows its "Confirm cancel" step: asked for, and the run is still going to be cancelled. */
export const confirmingCancel = (asked: boolean, status: RunStatus): boolean =>
  asked && status !== 'completed';
