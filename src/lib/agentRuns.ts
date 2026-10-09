/**
 * Agent runs (Actions → Agent runs): the six kinds, which agent did the work, how a run's state looks and how its
 * numbers read. The API records a run's kind and title only; the agent is read from them: Clef routes reviews and
 * stacks pull requests, Fixer rebases and resolves conflicts, and a reviewer agent's own reviews and lessons name
 * it in the title (`Review by @handle of …`, `@handle learns from #n`).
 */
import type { AgentStatus, Tone } from './agentLook';
import type {
  AgentRun,
  AgentRunKind,
  AgentRunStatus,
  AgentStep,
} from './uiApi';

export const AGENT_RUN_KINDS: { kind: AgentRunKind; label: string }[] = [
  { kind: 'review', label: 'Review' },
  { kind: 'rebase', label: 'Rebase' },
  { kind: 'conflict_resolution', label: 'Conflict resolution (squash-era)' },
  { kind: 'stack_discovery', label: 'Stack discovery' },
  { kind: 'sweep', label: 'Sweep' },
  { kind: 'learning', label: 'Learning' },
];

export const agentKindLabel = (kind: AgentRunKind): string =>
  AGENT_RUN_KINDS.find((k) => k.kind === kind)?.label ?? kind;

export const isAgentKind = (k: string | null): k is AgentRunKind =>
  AGENT_RUN_KINDS.some((x) => x.kind === k);

/** What `/actions` shows, from its query string: workflow runs (filter and page), or Agent runs (a kind, or all). */
export type ActionsView =
  | { mode: 'workflows'; workflow: string; page: number }
  | { mode: 'agents'; kind: AgentRunKind | null };

export function parseActionsView(params: URLSearchParams): ActionsView {
  const agent = params.get('agent');
  if (agent === 'all') return { mode: 'agents', kind: null };
  if (isAgentKind(agent)) return { mode: 'agents', kind: agent };
  return {
    mode: 'workflows',
    workflow: params.get('workflow') ?? '',
    page: Math.max(1, Math.floor(Number(params.get('page') ?? 1)) || 1),
  };
}

/** The agent that did a run's work. Built-ins have fixed handles; reviewers come from the run's title. */
export interface RunActor {
  id: 'clef' | 'fixer' | 'reviewer';
  handle: string;
  builtin: boolean;
}

const REVIEW_BY = /^Review by @([\w-]+)/;
const LEARNS = /^@([\w-]+) learns/;

export function runActor(
  run: Pick<AgentRun, 'kind' | 'title'>
): RunActor | null {
  switch (run.kind) {
    case 'rebase':
    case 'conflict_resolution':
      return { id: 'fixer', handle: 'fixer', builtin: true };
    case 'stack_discovery':
    case 'sweep':
      return { id: 'clef', handle: 'clef', builtin: true };
    case 'review': {
      const handle = REVIEW_BY.exec(run.title)?.[1];
      return handle
        ? { id: 'reviewer', handle, builtin: false }
        : { id: 'clef', handle: 'clef', builtin: true };
    }
    case 'learning': {
      const handle = LEARNS.exec(run.title)?.[1];
      return handle ? { id: 'reviewer', handle, builtin: false } : null;
    }
  }
}

/** What the agent did, in a few plain words. */
export function actorRole(run: Pick<AgentRun, 'kind' | 'title'>): string {
  switch (run.kind) {
    case 'review':
      return runActor(run)?.builtin
        ? 'Decides which reviewers to ask'
        : 'Reviews the change';
    case 'rebase':
      return 'Rebases the branch';
    case 'conflict_resolution':
      return 'Resolves conflicts';
    case 'stack_discovery':
      return 'Works out how pull requests fit together';
    case 'sweep':
      return 'Re-checks open pull requests';
    case 'learning':
      return 'Learns from dismissed requests';
  }
}

/** The avatar's status for a run: working, a clear pass, or the failure face. */
export function runAvatarStatus(status: AgentRunStatus): AgentStatus {
  return status === 'running'
    ? 'running'
    : status === 'failed'
      ? 'failed'
      : 'approved';
}

/** The chip's tone and words; colour is never the only signal. */
export function runStatusLook(status: AgentRunStatus): {
  tone: Tone;
  label: string;
} {
  return status === 'running'
    ? { tone: 'info', label: 'Running' }
    : status === 'failed'
      ? { tone: 'critical', label: 'Failed' }
      : { tone: 'good', label: 'Finished' };
}

/**
 * The run's outcome in a sentence: why it failed, else the last decision a step recorded. Null when a finished
 * run recorded none.
 */
export function runOutcome(
  run: Pick<AgentRun, 'status' | 'error'>,
  steps: Pick<AgentStep, 'decision' | 'error'>[]
): string | null {
  if (run.status === 'running') return 'Still working.';
  if (run.status === 'failed') {
    if (run.error) return run.error;
    for (let i = steps.length - 1; i >= 0; i--)
      if (steps[i].error) return steps[i].error;
    return 'The run failed.';
  }
  for (let i = steps.length - 1; i >= 0; i--)
    if (steps[i].decision) return steps[i].decision;
  return null;
}

/** Dollars, with enough places to show fractions of a cent. */
export function formatCost(c: number | null): string {
  if (c === null) return '';
  if (c === 0) return '$0';
  if (c < 0.0001) return '<$0.0001';
  return `$${c.toFixed(c < 0.01 ? 4 : c < 1 ? 3 : 2)}`;
}

export const formatTokens = (n: number): string => n.toLocaleString('en-US');

/** Each model a run used once, without the Workers AI `@cf/` prefix. */
export function modelsOf(steps: Pick<AgentStep, 'model'>[]): string[] {
  return [
    ...new Set(
      steps.flatMap((s) =>
        s.model ? s.model.split(', ').map((m) => m.replace(/^@cf\//, '')) : []
      )
    ),
  ];
}
