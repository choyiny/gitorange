import {
  CheckCircleFillIcon,
  CircleIcon,
  SkipIcon,
  StopIcon,
  XCircleFillIcon,
} from '@primer/octicons-react';
import type { RunConclusion, RunStatus } from '@/lib/uiApi';

/** The status glyph GitHub uses for runs, jobs, and steps. */
export function RunStatusIcon({
  status,
  conclusion,
  size = 16,
}: {
  status: RunStatus;
  conclusion: RunConclusion;
  size?: number;
}) {
  if (status === 'queued')
    return (
      <span className="color-fg-attention" aria-label="Queued">
        <CircleIcon size={size} />
      </span>
    );
  if (status === 'in_progress')
    return (
      <span
        className="run-spinner color-fg-attention"
        style={{ width: size, height: size }}
        aria-label="In progress"
      />
    );
  if (conclusion === 'success')
    return (
      <span className="color-fg-success" aria-label="Success">
        <CheckCircleFillIcon size={size} />
      </span>
    );
  if (conclusion === 'failure')
    return (
      <span className="color-fg-danger" aria-label="Failure">
        <XCircleFillIcon size={size} />
      </span>
    );
  if (conclusion === 'cancelled')
    return (
      <span className="color-fg-muted" aria-label="Cancelled">
        <StopIcon size={size} />
      </span>
    );
  return (
    <span className="color-fg-muted" aria-label="Skipped">
      <SkipIcon size={size} />
    </span>
  );
}

export function runStatusLabel(status: RunStatus, conclusion: RunConclusion) {
  if (status === 'queued') return 'Queued';
  if (status === 'in_progress') return 'In progress';
  return (
    {
      success: 'Success',
      failure: 'Failure',
      cancelled: 'Cancelled',
      skipped: 'Skipped',
    }[conclusion ?? 'skipped'] ?? 'Completed'
  );
}
