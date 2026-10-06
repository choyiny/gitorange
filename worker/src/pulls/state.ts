import type { TreeNode } from '../stack/tree';

/** Whose move it is on an open pull request, most urgent first. */
export const PULL_STATES = [
  'agent_followup',
  'human_review',
  'waiting',
  'ready',
] as const;
export type PullStateName = (typeof PULL_STATES)[number];

/** 0 is the most urgent. Also orders prerequisites by how close to Ready they are (milestone 2b). */
export const STATE_RANK: Record<PullStateName, number> = {
  agent_followup: 0,
  human_review: 1,
  waiting: 2,
  ready: 3,
};

/** Why a pull request is in its state. Data is snake_case so agents can act on it as returned. */
export type Reason =
  | { kind: 'check_failed'; run_number: number; check: string | null }
  | { kind: 'changes_requested'; flags: number }
  | { kind: 'conflicts_unresolved'; files: string[]; error: string | null }
  | {
      kind: 'must_account_for';
      pr: number;
      landed: boolean;
      instructions: string | null;
      /** Rebase onto it first when the prerequisite is open. */
      branch: string | null;
    }
  | { kind: 'rebase_onto'; pr: number; branch: string; why: string }
  | { kind: 'cycle'; prs: number[] }
  | {
      kind: 'checks_running';
      /** The check waited on, when one is named. */
      check: string | null;
      /** False while no run (or no run of that check) exists yet. */
      started: boolean;
    }
  | { kind: 'resolution_running' }
  | { kind: 'stack_checking'; prs: number[] }
  | { kind: 'stacked_on'; pr: number }
  | { kind: 'waits_on'; pr: number }
  /** An agent (null: the review of this commit) hasn't finished. */
  | { kind: 'agent_reviewing'; agent: string | null }
  /** An agent's needs_person findings wait for a person. */
  | {
      kind: 'agent_flagged';
      agent: string;
      flags: { id: string; title: string }[];
    }
  /** An agent asked the author for these changes (resolved by a new push, or dismissed by a person). */
  | {
      kind: 'agent_changes_requested';
      agent: string;
      changes: { id: string; title: string; detail: string | null }[];
    }
  /** An agent's review (null: the review of this commit) failed: fix the agent, retry, or remove it. */
  | { kind: 'agent_review_failed'; agent: string | null; error: string | null }
  /** No agent was requested: a person approves the commit. */
  | { kind: 'needs_approval' };
export type ReasonKind = Reason['kind'];

// Adding a kind to Reason without listing it here is a type error.
const KINDS: Record<ReasonKind, true> = {
  check_failed: true,
  changes_requested: true,
  conflicts_unresolved: true,
  must_account_for: true,
  rebase_onto: true,
  cycle: true,
  checks_running: true,
  resolution_running: true,
  stack_checking: true,
  stacked_on: true,
  waits_on: true,
  agent_reviewing: true,
  agent_flagged: true,
  agent_changes_requested: true,
  agent_review_failed: true,
  needs_approval: true,
};
export const REASON_KINDS = Object.keys(KINDS) as [ReasonKind, ...ReasonKind[]];

export type PullState = { state: PullStateName; reasons: Reason[] };

/** Whose move a reason makes it; null when it only informs. Exhaustive: a new kind needs a case. */
export function reasonState(r: Reason): PullStateName | null {
  switch (r.kind) {
    case 'check_failed':
    case 'changes_requested':
    case 'conflicts_unresolved':
    // Not accounted for and not dismissed: stackReasons emits it only then.
    case 'must_account_for':
    case 'rebase_onto':
    case 'agent_changes_requested':
      return 'agent_followup';
    case 'cycle':
    case 'agent_flagged':
    case 'agent_review_failed':
    case 'needs_approval':
      return 'human_review';
    case 'checks_running':
    case 'resolution_running':
    case 'stack_checking':
    case 'agent_reviewing':
      return 'waiting';
    case 'stacked_on':
    case 'waits_on':
      return null;
  }
}

/** The most urgent state any reason calls for; reasons sorted most urgent first, stable otherwise. */
export function decideState(reasons: Reason[]): PullState {
  const ranked = reasons.map((r, i) => {
    const s = reasonState(r);
    return { r, i, rank: s ? STATE_RANK[s] : STATE_RANK.ready };
  });
  ranked.sort((x, y) => x.rank - y.rank || x.i - y.i);
  const top = ranked[0]?.rank ?? STATE_RANK.ready;
  return {
    state: PULL_STATES[top],
    reasons: ranked.map((x) => x.r),
  };
}

export type StackReasonContext = {
  /** Head branch of an open PR in the tree (rebase targets). */
  branchOf?: (pr: number) => string | null;
  /** This PR's head doesn't contain its open parent's head, and the parent's own chain is in order. */
  needsRebase?: boolean;
};

/**
 * Reasons from a PR's place in its target's stack tree. The one place stack
 * signals become reasons: milestone 2b extends it with accounting and `rebase_onto`.
 */
export function stackReasons(
  node: TreeNode,
  ctx: StackReasonContext = {}
): Reason[] {
  const out: Reason[] = [];
  if (node.cycleWith.length) out.push({ kind: 'cycle', prs: node.cycleWith });
  if (node.checking || node.pending.length)
    out.push({ kind: 'stack_checking', prs: [...node.pending] });
  for (const d of node.mustAccountFor)
    if (!d.accounted)
      out.push({
        kind: 'must_account_for',
        pr: d.number,
        landed: d.landed,
        instructions: d.instructions,
        branch: d.landed ? null : (ctx.branchOf?.(d.number) ?? null),
      });
  if (node.parent && ctx.needsRebase) {
    const branch = ctx.branchOf?.(node.parent.number);
    if (branch)
      out.push({
        kind: 'rebase_onto',
        pr: node.parent.number,
        branch,
        why: node.parent.reason,
      });
  }
  if (node.parent) out.push({ kind: 'stacked_on', pr: node.parent.number });
  for (const d of node.waitsOn) out.push({ kind: 'waits_on', pr: d.number });
  return out;
}
