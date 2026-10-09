/**
 * The compare page (`/:o/:r/compare/<base>...<head>` or `compare/<head>`, which compares against the default
 * branch): reading its address, the title it pre-fills, and what a comparison means for opening a pull request.
 */
import { firstLine } from './format';
import type { Commit, Compare } from './uiApi';

/** Base and head from the path after `compare/`; a lone branch is the head, a missing base the default branch. */
export function parseRange(
  range: string,
  defaultBranch: string
): { base: string; head: string } {
  const [base, head] = range.includes('...')
    ? range.split('...')
    : [defaultBranch, range];
  return { base: base || defaultBranch, head: head || '' };
}

/** The compare page's address for two branches. */
export function compareHref(base: string, from: string, head: string): string {
  return `${base}/compare/${from}...${head}`;
}

/**
 * The title the form starts with: the commit's message when there is one commit, otherwise the branch name as
 * words ("claude/s4-usd_invoices" becomes "Claude s4 usd invoices").
 */
export function prefillTitle(commits: Commit[], head: string): string {
  if (commits.length === 1) return firstLine(commits[0].message);
  return head.replace(/[-_/]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export interface ComparisonView {
  /** There is something to open a pull request for: commits, and the head is not behind the base. */
  ready: boolean;
  /** "Able to merge": it is mergeable or only ahead, so GitOrange can rebase it cleanly. */
  canRebase: boolean;
  /** "Can't rebase automatically": there are conflicts (a pull request can still be opened). */
  conflicts: boolean;
}

export function comparison(c: Compare): ComparisonView {
  const canRebase = c.mergeable || c.status === 'ahead';
  return {
    ready: c.commits.length > 0 && c.status !== 'behind',
    canRebase,
    conflicts: !canRebase && c.conflicts.length > 0,
  };
}
