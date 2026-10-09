import {
  CheckIcon,
  CircleIcon,
  SkipIcon,
  StopIcon,
  XIcon,
} from '@primer/octicons-react';
import { Chip } from '@/components/ui/Chip';
import { runLabel, runTone } from '@/lib/runs';
import type { RunConclusion, RunStatus } from '@/lib/uiApi';

/** A workflow run, job or step as a pill: an icon and words, so colour is never the only signal. */
export function RunChip({
  status,
  conclusion,
}: {
  status: RunStatus;
  conclusion: RunConclusion;
}) {
  const icon =
    status === 'queued' ? (
      <CircleIcon size={12} />
    ) : status === 'in_progress' ? (
      <span className="spinner" aria-hidden="true" />
    ) : conclusion === 'success' ? (
      <CheckIcon size={12} />
    ) : conclusion === 'failure' ? (
      <XIcon size={12} />
    ) : conclusion === 'cancelled' ? (
      <StopIcon size={12} />
    ) : (
      <SkipIcon size={12} />
    );
  return (
    <Chip tone={runTone(status, conclusion)} icon={icon}>
      {runLabel(status, conclusion)}
    </Chip>
  );
}
