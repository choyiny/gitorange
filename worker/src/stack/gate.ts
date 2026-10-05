import type { DrizzleDB } from '../db/middleware';
import type { PullRequest } from '../db/app.schema';
import type { GitService } from '../git/service';
import type { TreeNode } from './tree';
import { stackViewFor } from './view';

export type StackBlock = {
  kind: 'must_account_for' | 'stacked_on' | 'waits_on';
  pr: number;
  message: string;
};
export type StackGate = {
  /** Discovery hasn't finished checking this head: auto-merge waits. */
  checking: boolean;
  /** Edges that keep it from landing (dismissed ones never appear in the tree). */
  blocks: StackBlock[];
  /** The tree couldn't be read: reads wait, landing refuses (fails closed). */
  error?: string;
};

/** What holds a PR back in its stack tree. */
export function gateFor(node: TreeNode | null): StackGate {
  if (!node) return { checking: false, blocks: [] };
  const blocks: StackBlock[] = [];
  for (const d of node.mustAccountFor)
    if (!d.accounted)
      blocks.push({
        kind: 'must_account_for',
        pr: d.number,
        message: `Must account for #${d.number} first: ${d.reason}`,
      });
  if (node.parent)
    blocks.push({
      kind: 'stacked_on',
      pr: node.parent.number,
      message: `Stacked on #${node.parent.number}: it lands after #${node.parent.number}`,
    });
  for (const d of node.waitsOn)
    blocks.push({
      kind: 'waits_on',
      pr: d.number,
      message: `Waits on #${d.number} to land first`,
    });
  return {
    checking: node.checking || node.pending.length > 0,
    blocks,
  };
}

export async function stackGate(
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest
): Promise<StackGate> {
  try {
    return gateFor(await stackViewFor(db, git, pr));
  } catch (e) {
    console.error('[stack] gate failed', pr.id, e);
    return {
      checking: false,
      blocks: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
