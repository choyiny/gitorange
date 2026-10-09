import { describe, expect, it } from 'vitest';
import {
  confirmingCancel,
  focusStep,
  isErrorLine,
  runLabel,
  runTone,
  stepLabel,
} from './runs';

describe('isErrorLine', () => {
  it('marks lines that start with Error or ##[error]', () => {
    expect(isErrorLine('Error: something broke')).toBe(true);
    expect(isErrorLine('##[error]Process completed with exit code 1')).toBe(
      true
    );
  });
  it('leaves everything else plain', () => {
    expect(isErrorLine('  Error in the middle')).toBe(false);
    expect(isErrorLine('error lowercase')).toBe(false);
    expect(isErrorLine('')).toBe(false);
  });
});

describe('focusStep', () => {
  const s = (
    number: number,
    status: 'queued' | 'in_progress' | 'completed',
    conclusion: 'success' | 'failure' | null = null
  ) => ({ number, status, conclusion });
  it('opens the step that is running', () => {
    expect(
      focusStep([
        s(1, 'completed', 'success'),
        s(2, 'in_progress'),
        s(3, 'queued'),
      ])
    ).toBe(2);
  });
  it('else the first step that failed', () => {
    expect(
      focusStep([
        s(1, 'completed', 'success'),
        s(2, 'completed', 'failure'),
        s(3, 'completed', 'failure'),
      ])
    ).toBe(2);
  });
  it('prefers a running step over an earlier failure', () => {
    expect(focusStep([s(1, 'completed', 'failure'), s(2, 'in_progress')])).toBe(
      2
    );
  });
  it('is null when nothing needs attention', () => {
    expect(focusStep([s(1, 'completed', 'success')])).toBeNull();
    expect(focusStep([])).toBeNull();
  });
});

describe('runTone', () => {
  it('maps a run, job or step to a chip tone', () => {
    expect(runTone('queued', null)).toBe('off');
    expect(runTone('in_progress', null)).toBe('info');
    expect(runTone('completed', 'success')).toBe('good');
    expect(runTone('completed', 'failure')).toBe('critical');
    expect(runTone('completed', 'cancelled')).toBe('off');
    expect(runTone('completed', 'skipped')).toBe('off');
    expect(runTone('completed', null)).toBe('off');
  });
});

describe('stepLabel', () => {
  it('words a step the way the log header does', () => {
    expect(stepLabel('queued', null)).toBe('Waiting to start');
    expect(stepLabel('in_progress', null)).toBe('Running');
    expect(stepLabel('completed', 'failure')).toBe('Failed');
    expect(stepLabel('completed', 'success')).toBe('Passed');
    expect(stepLabel('completed', 'skipped')).toBe('Skipped');
    expect(stepLabel('completed', 'cancelled')).toBe('Cancelled');
  });
});

describe('runLabel', () => {
  it('uses plain words for a chip', () => {
    expect(runLabel('queued', null)).toBe('Queued');
    expect(runLabel('in_progress', null)).toBe('In progress');
    expect(runLabel('completed', 'success')).toBe('Passed');
    expect(runLabel('completed', 'failure')).toBe('Failed');
    expect(runLabel('completed', 'cancelled')).toBe('Cancelled');
    expect(runLabel('completed', null)).toBe('Skipped');
  });
});

describe('confirmingCancel', () => {
  it('shows the confirm step only after Cancel was clicked on a run that is still going', () => {
    expect(confirmingCancel(true, 'in_progress')).toBe(true);
    expect(confirmingCancel(true, 'queued')).toBe(true);
    expect(confirmingCancel(false, 'in_progress')).toBe(false);
  });
  it('drops it once the run has completed, so a finished run is never one click from being cancelled', () => {
    expect(confirmingCancel(true, 'completed')).toBe(false);
  });
});
