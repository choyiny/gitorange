/** Display names for agent run steps, from the Workflow step names the executors use. */

const FIXED: Record<string, string> = {
  load: 'Load',
  'save-files': 'Save summaries',
  classify: 'Classify',
  flags: 'Record flags',
  finish: 'Finish',
  'auto-merge': 'Try auto-merge',
  stacking: 'Start stack discovery',
  delegate: 'Let GitOrange AI decide',
  fail: 'Record failure',
  prepare: 'Prepare conflicted files',
  resolve: 'Resolve conflicts',
  commit: 'Commit resolution',
  next: 'Start queued resolutions',
  repo: 'Load repository',
  targets: 'Find pull requests',
  states: 'Record pull request states',
  'current:before-resolve': 'Check the commits are current',
  'current:before-commit': 'Check the commits are still current',
  agents: 'Read invited agents',
  trigger: 'Ask which agents this concerns',
  reviewers: 'Request reviewers',
};

/** Steps named `<kind>:<pull request id>`, about another pull request. */
const ABOUT_PULL: Record<string, string> = {
  pr: 'Check',
  resolve: 'Resolve conflicts of',
  claim: 'Claim pair with',
  conflicts: 'Check conflicts with',
  decide: 'Decide relationship with',
  independent: 'Mark independent of',
  deep: 'Start deep dive with',
  explain: 'Explain relationship with',
  save: 'Save relationship with',
  fail: 'Record failure with',
  recheck: 'Re-check accounting for',
  rechecked: 'Record re-check of',
  'recheck-failed': 'Record failed re-check of',
};

/** A stack run's inline reconcile (`stack-reconcile:<step>`), or a reconcile run's own steps. */
const RECONCILE: Record<string, string> = {
  load: 'Load stacks',
  edges: 'Prune ordering edges',
  'save-orders': 'Save ordering edges',
  retarget: 'Retarget stacked pull requests',
  states: 'Record pull request states',
  order: 'Order prerequisites',
  ready: 'Compare readiness',
};

/** Steps named `<kind>:<index>`. */
const INDEXED: Record<string, string> = {
  summary: 'Summarize file',
  investigate: 'Investigate flag',
};

/** Steps named `<kind>:<agent handle>`. */
const ABOUT_AGENT: Record<string, string> = {
  review: 'Review by',
  'review-failed': 'Record failed review by',
  // A review rate limited after its retries: a durable wait, then the review again (review/head.ts).
  ...Object.fromEntries(
    [1, 2, 3].flatMap((n) => [
      [`rate-limited-${n}`, `Wait out rate limit (${n}) for`],
      [`review-again-${n}`, `Review again (${n}) by`],
    ])
  ),
};

/** The pull request id a step name refers to, if any. */
export function stepPullId(name: string): string | null {
  const i = name.indexOf(':');
  if (i < 0) return null;
  return ABOUT_PULL[name.slice(0, i)] ? name.slice(i + 1) : null;
}

const capitalize = (s: string) =>
  s ? s[0].toUpperCase() + s.slice(1).replace(/[-_]/g, ' ') : s;

export function stepDisplayName(
  name: string,
  /** Pull request id → number, for steps about another pull request. */
  numbers: Map<string, number>
): string {
  if (FIXED[name]) return FIXED[name];
  // `pi:<handle>:<check>`: one look at an agent's running Pi review.
  if (name.startsWith('pi:')) return `Pi review by @${name.split(':')[1]}`;
  const r = name.replace(/^stack-/, '');
  if (r.startsWith('reconcile:')) {
    const kind = r.slice('reconcile:'.length).split(':')[0];
    if (RECONCILE[kind]) return RECONCILE[kind];
  }
  const i = name.indexOf(':');
  if (i < 0) return capitalize(name);
  const [kind, rest] = [name.slice(0, i), name.slice(i + 1)];
  if (INDEXED[kind] && /^\d+$/.test(rest))
    return `${INDEXED[kind]} ${Number(rest) + 1}`;
  if (ABOUT_AGENT[kind]) return `${ABOUT_AGENT[kind]} @${rest}`;
  if (ABOUT_PULL[kind]) {
    const n = numbers.get(rest);
    return `${ABOUT_PULL[kind]} ${n ? `#${n}` : 'another pull request'}`;
  }
  return `${capitalize(kind)} ${rest}`;
}
