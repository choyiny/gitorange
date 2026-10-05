# Stack Tree — Milestone 2a (Pull Request States) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every open pull request gets exactly one computed state saying whose move it is (`agent_followup`,
`human_review`, `waiting`, `ready`) with structured reasons, shown in the Pull requests list, the tree, the merge
box, the timeline, PR detail, MCP, and the Approvals page, with a `state` filter for agents asking "what needs me?".

**Architecture:** A pure rules module (`worker/src/pulls/state.ts`) maps structured reasons to states by priority.
A batch loader (`pullStates`) gathers the signals that already exist (Actions runs, the auto-merge review and its
flags, AI conflict resolution rows, the stack tree) for all of a repository's open PRs in a constant number of D1
queries and returns one `PullState` per PR. Nothing is stored except changes: `settleStates` recomputes a
repository's states at the points that already ping live pages (API mutations, pushes, opening and landing PRs,
flag decisions, the end of each MERGE_RESOLUTION and Actions Workflow) and records a `pr_events` row when a PR's
state changed, with one atomic conditional INSERT so concurrent triggers never double-record.

**Tech Stack:** Cloudflare Workers, Hono + Zod OpenAPI (zod v4), Drizzle/D1, Cloudflare Workflows, Durable
Objects (live pings), React + TanStack Query + Primer CSS, Vitest (`@cloudflare/vitest-pool-workers`).

**Spec:** `docs/superpowers/specs/2026-10-04-stack-tree-design.md` (section 2b "Pull request states"; milestone 2
line, including "tree-node state labels"). Milestone 1's plan
(`docs/superpowers/plans/2026-10-04-stack-tree-m1-discovery.md`) is the model for conventions. Plan 2b
(`docs/superpowers/plans/2026-10-04-stack-tree-m2b-retarget.md`) runs after this one and extends it.

## Global Constraints

- States: `agent_followup` (**Ready for Agent Followup**), `human_review` (**Requires Human Review**), `waiting` (**Waiting for Checks**), `ready` (**Ready**, optionally _stacked on #N_).
- Priority when several apply: `agent_followup` > `human_review` > `waiting` > `ready`.
- States are **computed** on read, never stored as a second copy; only changes are recorded, for the timeline.
- `pullState(pr)` returns `{ state, reasons[] }`; each reason has a `kind` and its data in snake_case (e.g. `{ kind: 'check_failed', run_number }`), so agents act on them without parsing prose.
- States are computed for every open PR whether or not stacking or auto-merge is on; reasons that need stacking appear only when it is on.
- No model call in a request; no per-request recomputation beyond a constant number of queries per page (batch every signal).
- Pings as today; GitOrange never pushes to anyone's branch.
- Always `yarn` (never `npm`/`npx`). Never hand-write migrations: change `worker/src/db/app.schema.ts`, run `yarn db:generate`, review the SQL.
- Never mock `env.DB`; tests use real D1 plus the Artifacts fake (`worker/src/__tests__/helpers/`).
- Definition of done: `yarn test` passes, `yarn typecheck` clean, `yarn format` run.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9
  ```

## Deviations and decisions (made while planning; Task 0 records them in the spec)

1. **Reason → state.** `agent_followup`: `check_failed`, `changes_requested`, `conflicts_unresolved`,
   and `review_policy_invalid` when the PR's own `review.yml` is invalid. `human_review`:
   `flags_pending`, `cycle`, `review_failed` (the review failed for a reason other than review.yml: a person with
   merge permission retries it; this is the spec's "maintainer override"), and `review_policy_invalid` when the
   **target's** review.yml is invalid (the PR's author can't fix that). `waiting`: `checks_running`,
   `review_running`, `resolution_running`, `stack_checking`. Informational (never change the state):
   `stacked_on`, `waits_on`, and in 2a `must_account_for` (see 11); until 2b they don't block, matching "Ready,
   stacked on #N".
2. **Checks.** Under a review.yml, `checks.require` decides, with exactly `autoMergeStatus`'s semantics (the
   logic is extracted into one pure `checkVerdict` used by both): `none` → no check reasons; `all` → any failed run
   at the head is `check_failed` (with its run number), any unfinished run or no run yet is `checks_running`; a list
   → per named job. Without review.yml (or with an invalid one): any failed run at the head is `check_failed`, any
   unfinished run is `checks_running`, no runs is fine.
3. **Conflicts** come from AI resolution rows at the PR's current target and head commits (no `planMerge` per PR
   on list pages): `queued`/`running` → `resolution_running`; `failed` (not superseded) or `rejected` →
   `conflicts_unresolved`. To make non-text conflicts (binary, delete/edit) visible the same way,
   `ensureResolution` now records them as a `failed` resolution row with the existing "can't be resolved
   automatically" message instead of returning silently. Without the `MERGE_RESOLUTION` binding there are no
   resolution rows, so no conflict reason (the merge box still shows conflicts from its own `planMerge`).
4. **One place to extend.** `worker/src/pulls/state.ts` holds the `Reason` union, the `REASON_KINDS` registry
   (compiler-checked), `reasonState` (an exhaustive `switch`, so a new kind without a state is a type error) and
   `stackReasons(node, ctx)`. Plan 2b adds `rebase_onto` and accounting there and nowhere else in the rules.
5. **Naming.** `state` already means open/closed/merged on the REST pull object and in MCP, so the computed state
   is `pullState` (REST) and `pull_state` + `reasons` (MCP). The list filter reuses the existing `state` parameter:
   it now also accepts `agent_followup`, `human_review`, `waiting` and `ready` (open PRs only), on both
   `GET /pulls` and `gitorange_list_pull_requests`.
6. **Timeline storage.** A general `pr_events` table (2b reuses it for stacked/unstacked/ordered/…); 2a writes
   only `state_changed`. Recording happens in `settleStates(env, db, repositoryId)`, called at the API mutation
   middleware, after a push, from `openPull`, `landPull` and `decideFlag` (covering MCP, which bypasses the
   middleware), at the end of every MERGE_RESOLUTION Workflow run (one `states` step in the entrypoint, covering
   reviews, sweeps, resolutions and stack runs), and at the end of every Actions run. Not after every Workflow step:
   that would recompute a repository's states dozens of times per run.
7. **No double recording.** Each PR's record is one `INSERT … SELECT … WHERE` statement: insert only if the PR's
   latest recorded state differs **and** no recorded state was computed later than this computation started
   (`computed_at`, milliseconds). Concurrent identical settles insert once; a slow, stale settle never overwrites a
   newer one.
8. **Bounded cost.** `pullStates` runs one ref listing, one review.yml read per target tip, the stack view (only
   for targets with stacking on), and a fixed set of D1 queries chunked at 90 ids. The only per-PR git read is the
   PR's own review.yml, and only when its review shows it changed that file.
9. **Approvals** lists `human_review` PRs from the latest **recorded** state (one query across repositories), not
   by recomputing every repository's states per inbox load.
10. **No state** (null) for a PR whose head or target branch no longer exists.
11. **Must account for is informational in 2a.** Nothing can mark an edge accounted for until 2b's re-check, so
    counting it would trap a PR in `agent_followup` with no way out. 2a reports `must_account_for` (with its
    instructions) without letting it change the state; plan 2b's Task 9 promotes it, in `reasonState` in
    `worker/src/pulls/state.ts`, to drive `agent_followup` while the edge is neither accounted for nor dismissed.

## Review Focus

1. **`checks.require: none` with a failing run**: checks aren't required, so no `check_failed`; the PR can be
   `ready`. → Task 3 test "ignores checks that review.yml doesn't require".
2. **Two settles at once, or a slow stale one**: one event per real change, never an older state after a newer one.
   → Task 4 tests "records once under concurrent settles" and "never records a stale computation over a newer one".
3. **A resolution superseded by newer commits, or one for older commits**: no conflict reason. → Task 3 test
   "ignores resolutions for other commits and superseded ones".
4. **Unknown `state` filter values, or a pull-state filter with closed PRs**: 400 for unknown values; pull-state
   filters return open PRs only. → Task 6 test "filters by pull state, open PRs only, and rejects unknown values".
5. **A PR that must account for another, before 2b can mark it accounted for**: the reason is reported but the
   PR is not trapped in `agent_followup` (its state comes from its other reasons). → Task 1 test "reports must
   account for without letting it decide the state (until 2b)"; Task 3 test "with stacking on: must account for is
   reported; the state comes from the rest". (Approvals visibility is pinned by Task 8's "lists human_review PRs
   only to people who can merge".)

---

## File Structure

**Create**

- `worker/src/pulls/state.ts`: pure rules: `PULL_STATES`, `Reason`, `REASON_KINDS`, `reasonState`, `decideState`, `stackReasons`, `STATE_RANK`.
- `worker/src/review/checks.ts`: pure `checkVerdict` shared by `autoMergeStatus` and `pullStates`.
- `worker/src/pulls/signals.ts`: `pullStates` (batch loader) and `pullStateFor`.
- `worker/src/pulls/events.ts`: `stateEventStatement`, `recordStates`, `eventsFor`, `latestStates`.
- `worker/src/pulls/settle.ts`: `settleStates`, `repositoryForPayload`.
- `worker/src/__tests__/pull-states.test.ts`: rules, signals, recording, API, Approvals.
- `src/lib/pullState.ts` + `src/lib/pullState.test.ts`: labels and reason text.
- `src/components/PullStateLabel.tsx`, `src/components/PullEvents.tsx`.

**Modify**

- `worker/src/db/app.schema.ts` (+ generated migration): `pr_events`.
- `worker/src/review/auto-merge.ts`: `checkProblem` uses `checkVerdict`.
- `worker/src/merge/resolution.ts`: export `SUPERSEDED`. `worker/src/merge/auto.ts`: record non-text conflicts.
- `worker/src/stack/view.ts`: export `chunks`.
- Hooks: `worker/src/index.ts`, `worker/src/git-http.ts`, `worker/src/lib/pulls.ts`, `worker/src/merge/land.ts`, `worker/src/review/flags.ts`, `worker/src/merge/workflow.ts`, `worker/src/actions/executor.ts`.
- `worker/src/routers/schemas.ts`, `worker/src/routers/pulls-router.ts`, `worker/src/routers/approvals-router.ts`, `worker/src/review/inbox.ts`, `worker/src/mcp/pull-tools.ts`.
- `src/lib/uiApi.ts`, `src/lib/approvals.ts`, `src/pages/Pulls.tsx`, `src/pages/PullView.tsx`, `src/pages/Approvals.tsx`, `src/components/StackTree.tsx`.
- Docs: `docs/auto-merge.md`, `docs/architecture.md`, `README.md`, `CLAUDE.md`, the spec.

---

### Task 0: Branch and spec alignment

**Files:**

- Modify: `docs/superpowers/specs/2026-10-04-stack-tree-design.md` (section 2b)

- [ ] **Step 1: Confirm the branch**

Run: `git -C /Users/choyiny/workspace/gitorange branch --show-current`
Expected: `stack-tree-m2`

- [ ] **Step 2: Update section 2b of the spec** to match "Deviations and decisions" above. Append to the end of
      section 2b (before "### Things that change because `base_ref` can be a PR branch"):

```markdown
**Decided while planning (milestone 2a).** Reason kinds and whose move each makes it: `check_failed`,
`changes_requested`, `conflicts_unresolved`, `rebase_onto` (2b), `must_account_for` (2b, while neither accounted for
nor dismissed; informational in 2a), `review_policy_invalid` (the PR's own review.yml) → agent followup; `flags_pending`, `cycle`, `review_failed`, `review_policy_invalid` (the target's
review.yml) → human review; `checks_running`, `review_running`, `resolution_running`, `stack_checking` → waiting;
`stacked_on`, `waits_on` → informational. Checks follow `checks.require` exactly as auto-merge does; without
review.yml any failed run on the head counts. Conflicts are read from AI resolution rows at the current commits
(non-text conflicts are recorded as a failed resolution). The computed state is `pullState` on the REST API and
`pull_state` (+ `reasons`) over MCP, since `state` already means open/closed/merged there; the `state` list filter
also accepts the four states. Changes are recorded as `pr_events` rows (`state_changed`) by `settleStates`, called
where pings already happen (API mutations, pushes, opening/landing PRs, flag decisions, the end of each
MERGE_RESOLUTION and Actions Workflow run), with one conditional insert so concurrent triggers record once. The
Approvals page reads the latest recorded state.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-04-stack-tree-design.md
git commit -m "Spec: pull request state decisions from planning milestone 2a

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 1: State rules (pure)

**Files:**

- Create: `worker/src/pulls/state.ts`
- Test: `worker/src/__tests__/pull-states.test.ts` (create)

**Interfaces:**

- Consumes: `TreeNode` from `worker/src/stack/tree.ts` (fields `parent`, `waitsOn`, `mustAccountFor`, `cycleWith`, `pending`, `checking`).
- Produces:
  - `PULL_STATES: readonly ['agent_followup', 'human_review', 'waiting', 'ready']`, `type PullStateName`.
  - `type Reason` (union below), `type ReasonKind`, `REASON_KINDS: [ReasonKind, ...ReasonKind[]]`.
  - `type PullState = { state: PullStateName; reasons: Reason[] }`.
  - `reasonState(r: Reason): PullStateName | null`, `decideState(reasons: Reason[]): PullState`.
  - `STATE_RANK: Record<PullStateName, number>` (0 = agent_followup … 3 = ready).
  - `type StackReasonContext = Record<string, never>` (2b widens it), `stackReasons(node: TreeNode, ctx?: StackReasonContext): Reason[]`.

- [ ] **Step 1: Write the failing test**

Create `worker/src/__tests__/pull-states.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  decideState,
  reasonState,
  REASON_KINDS,
  stackReasons,
  type Reason,
} from '../pulls/state';
import type { TreeNode } from '../stack/tree';

const node = (over: Partial<TreeNode> = {}): TreeNode => ({
  number: 3,
  parent: null,
  children: [],
  waitsOn: [],
  mustAccountFor: [],
  cycleWith: [],
  unchecked: [],
  pending: [],
  checking: false,
  ...over,
});
const dep = (number: number, kind: 'builds_on' | 'must_account_for') => ({
  number,
  kind,
  reason: 'Because.',
  instructions: kind === 'must_account_for' ? 'Add a check.' : null,
  landed: false,
  files: [],
});

describe('pull request state rules', () => {
  it('is ready with nothing left', () => {
    expect(decideState([])).toEqual({ state: 'ready', reasons: [] });
  });

  it('puts agent work before human review before waiting', () => {
    const reasons: Reason[] = [
      { kind: 'checks_running', check: null, started: true },
      { kind: 'flags_pending', count: 2 },
      { kind: 'check_failed', run_number: 7, check: null },
    ];
    expect(decideState(reasons)).toEqual({
      state: 'agent_followup',
      reasons: [reasons[2], reasons[1], reasons[0]],
    });
    expect(decideState(reasons.slice(0, 2)).state).toBe('human_review');
    expect(decideState(reasons.slice(0, 1)).state).toBe('waiting');
  });

  it('keeps informational reasons without changing the state', () => {
    expect(decideState([{ kind: 'stacked_on', pr: 28 }])).toEqual({
      state: 'ready',
      reasons: [{ kind: 'stacked_on', pr: 28 }],
    });
  });

  it('reports must account for without letting it decide the state (until 2b)', () => {
    const must: Reason = {
      kind: 'must_account_for',
      pr: 28,
      landed: false,
      instructions: 'Add a check.',
    };
    expect(reasonState(must)).toBeNull();
    expect(decideState([must])).toEqual({ state: 'ready', reasons: [must] });
    expect(decideState([must, { kind: 'review_running' }]).state).toBe(
      'waiting'
    );
  });

  it('asks the author to fix their own review.yml, and a person to fix the target’s', () => {
    expect(
      reasonState({
        kind: 'review_policy_invalid',
        where: 'pull_request',
        error: 'x',
      })
    ).toBe('agent_followup');
    expect(
      reasonState({
        kind: 'review_policy_invalid',
        where: 'target',
        error: 'x',
      })
    ).toBe('human_review');
  });

  it('lists every reason kind', () => {
    expect([...REASON_KINDS].sort()).toEqual(
      [
        'check_failed',
        'changes_requested',
        'checks_running',
        'conflicts_unresolved',
        'cycle',
        'flags_pending',
        'must_account_for',
        'resolution_running',
        'review_failed',
        'review_policy_invalid',
        'review_running',
        'stack_checking',
        'stacked_on',
        'waits_on',
      ].sort()
    );
  });

  it('reads the stack tree: cycles, checks still running, must account for, parent, waits on', () => {
    expect(
      stackReasons(
        node({
          parent: dep(28, 'builds_on'),
          waitsOn: [dep(30, 'builds_on')],
          mustAccountFor: [dep(29, 'must_account_for')],
          cycleWith: [12],
          pending: [31],
        })
      )
    ).toEqual([
      { kind: 'cycle', prs: [12] },
      { kind: 'stack_checking', prs: [31] },
      {
        kind: 'must_account_for',
        pr: 29,
        landed: false,
        instructions: 'Add a check.',
      },
      { kind: 'stacked_on', pr: 28 },
      { kind: 'waits_on', pr: 30 },
    ]);
    expect(stackReasons(node({ checking: true }))).toEqual([
      { kind: 'stack_checking', prs: [] },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test worker/src/__tests__/pull-states.test.ts`
Expected: FAIL: cannot resolve `../pulls/state`.

- [ ] **Step 3: Write `worker/src/pulls/state.ts`**

```ts
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
      kind: 'review_policy_invalid';
      /** pull_request: this PR's own review.yml; target: the target branch's. */
      where: 'pull_request' | 'target';
      error: string;
    }
  | {
      kind: 'must_account_for';
      pr: number;
      landed: boolean;
      instructions: string | null;
    }
  | { kind: 'review_failed'; error: string | null }
  | { kind: 'flags_pending'; count: number }
  | { kind: 'cycle'; prs: number[] }
  | {
      kind: 'checks_running';
      /** The required check waited on, when review.yml names them. */
      check: string | null;
      /** False while no run (or no run of that check) exists yet. */
      started: boolean;
    }
  | { kind: 'review_running' }
  | { kind: 'resolution_running' }
  | { kind: 'stack_checking'; prs: number[] }
  | { kind: 'stacked_on'; pr: number }
  | { kind: 'waits_on'; pr: number };
export type ReasonKind = Reason['kind'];

// Adding a kind to Reason without listing it here is a type error.
const KINDS: Record<ReasonKind, true> = {
  check_failed: true,
  changes_requested: true,
  conflicts_unresolved: true,
  review_policy_invalid: true,
  must_account_for: true,
  review_failed: true,
  flags_pending: true,
  cycle: true,
  checks_running: true,
  review_running: true,
  resolution_running: true,
  stack_checking: true,
  stacked_on: true,
  waits_on: true,
};
export const REASON_KINDS = Object.keys(KINDS) as [ReasonKind, ...ReasonKind[]];

export type PullState = { state: PullStateName; reasons: Reason[] };

/** Whose move a reason makes it; null when it only informs. Exhaustive: a new kind needs a case. */
export function reasonState(r: Reason): PullStateName | null {
  switch (r.kind) {
    case 'check_failed':
    case 'changes_requested':
    case 'conflicts_unresolved':
      return 'agent_followup';
    case 'review_policy_invalid':
      return r.where === 'pull_request' ? 'agent_followup' : 'human_review';
    case 'review_failed':
    case 'flags_pending':
    case 'cycle':
      return 'human_review';
    case 'checks_running':
    case 'review_running':
    case 'resolution_running':
    case 'stack_checking':
      return 'waiting';
    // must_account_for informs only until plan 2b can mark edges accounted for (then it drives agent_followup).
    case 'must_account_for':
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

/** What the stack reasons need beyond the node; milestone 2b adds fields. */
export type StackReasonContext = Record<string, never>;

/**
 * Reasons from a PR's place in its target's stack tree (only when stacking is on there). The one place stack
 * signals become reasons: milestone 2b extends it with accounting and `rebase_onto`.
 */
export function stackReasons(
  node: TreeNode,
  _ctx: StackReasonContext = {}
): Reason[] {
  const out: Reason[] = [];
  if (node.cycleWith.length) out.push({ kind: 'cycle', prs: node.cycleWith });
  if (node.checking || node.pending.length)
    out.push({ kind: 'stack_checking', prs: [...node.pending] });
  for (const d of node.mustAccountFor)
    out.push({
      kind: 'must_account_for',
      pr: d.number,
      landed: d.landed,
      instructions: d.instructions,
    });
  if (node.parent) out.push({ kind: 'stacked_on', pr: node.parent.number });
  for (const d of node.waitsOn) out.push({ kind: 'waits_on', pr: d.number });
  return out;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `yarn test worker/src/__tests__/pull-states.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/pulls/state.ts worker/src/__tests__/pull-states.test.ts
git commit -m "Pull request states: reasons, priority, and stack reasons

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 2: Shared check verdict, and non-text conflicts recorded

**Files:**

- Create: `worker/src/review/checks.ts`
- Modify: `worker/src/review/auto-merge.ts` (`checkProblem`, lines ~32-96)
- Modify: `worker/src/merge/resolution.ts` (export `SUPERSEDED`)
- Modify: `worker/src/merge/auto.ts` (`ensureResolution`)
- Test: `worker/src/__tests__/pull-states.test.ts`

**Interfaces:**

- Produces:
  - `type CheckRun = { runNumber: number; status: string; conclusion: string | null }`
  - `type CheckJob = { key: string; name: string; status: string; conclusion: string | null; runNumber: number }`
  - `type CheckRequirement = ReviewPolicy['checks']['require'] | 'any'` (`any`: no review.yml)
  - `type CheckVerdict = { kind: 'failed'; reason: string; runNumber: number; check: string | null } | { kind: 'waiting'; reason: string; check: string | null; started: boolean }`
  - `checkVerdict(runs: CheckRun[], jobs: CheckJob[], require: CheckRequirement): CheckVerdict | null`
  - `SUPERSEDED = 'Superseded by newer commits.'` from `worker/src/merge/resolution.ts`.
  - `ensureResolution` now inserts a `failed` `merge_resolutions` row (model `'none'`) for non-text conflicts.

- [ ] **Step 1: Write the failing tests**

Append to `worker/src/__tests__/pull-states.test.ts` (merge the new imports into the file's import block):

```ts
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { checkVerdict } from '../review/checks';
import { ensureResolution } from '../merge/auto';
import { findRepoById, gitFor } from '../lib/repos';
import type { PullRequest } from '../db/app.schema';
import { bootstrapAdmin, call, makeEnv, settle } from './helpers/app';
import { commitPaths } from './helpers/seed';

describe('check verdict', () => {
  const run = (
    runNumber: number,
    status: string,
    conclusion: string | null
  ) => ({
    runNumber,
    status,
    conclusion,
  });
  it('without review.yml: a failed run fails, a running one waits, none is fine', () => {
    expect(checkVerdict([], [], 'any')).toBeNull();
    expect(
      checkVerdict([run(3, 'in_progress', null)], [], 'any')
    ).toMatchObject({
      kind: 'waiting',
      started: true,
    });
    expect(
      checkVerdict(
        [run(3, 'completed', 'success'), run(4, 'completed', 'failure')],
        [],
        'any'
      )
    ).toMatchObject({ kind: 'failed', runNumber: 4, check: null });
  });

  it('require all waits for a first run; a list names the failed check and its run', () => {
    expect(checkVerdict([], [], 'all')).toMatchObject({
      kind: 'waiting',
      started: false,
      reason: 'No checks have run for this commit yet',
    });
    expect(
      checkVerdict([run(1, 'completed', 'failure')], [], 'none')
    ).toBeNull();
    const jobs = [
      {
        key: 'lint',
        name: 'lint',
        status: 'completed',
        conclusion: 'success',
        runNumber: 5,
      },
      {
        key: 'test',
        name: 'test',
        status: 'completed',
        conclusion: 'failure',
        runNumber: 6,
      },
    ];
    expect(checkVerdict([], jobs, ['lint', 'test'])).toEqual({
      kind: 'failed',
      reason: 'The "test" check failed',
      runNumber: 6,
      check: 'test',
    });
    expect(checkVerdict([], jobs, ['build'])).toMatchObject({
      kind: 'waiting',
      check: 'build',
      started: false,
    });
  });
});

describe('non-text conflicts', () => {
  it('are recorded as a failed resolution a person or agent must handle', async () => {
    const t = makeEnv({ actions: true });
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'internal' },
    });
    const repo = [...t.fake.repos.values()][0];
    const main = await commitPaths(
      repo,
      'main',
      { 'a.txt': 'a\n', 'b.txt': 'b\n' },
      'base'
    );
    repo.refs.set('refs/heads/feature', main);
    // The branch deletes a.txt while main changes it: a delete/edit conflict AI can't resolve.
    await commitPaths(repo, 'feature', { 'b.txt': 'b\n' }, 'Delete a');
    await commitPaths(
      repo,
      'main',
      { 'a.txt': 'A\n', 'b.txt': 'b\n' },
      'Change a'
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Delete a', body: '', base: 'main', head: 'feature' },
    });
    await settle(t);
    // Opening the PR already ran ensureResolution once (openPull); calling it again must not add a row.
    const db = drizzle(t.env.DB, { schema });
    const row = await db.query.pullRequests.findFirst();
    const found = await findRepoById(db, row!.repositoryId);
    const shas = {
      base: repo.refs.get('refs/heads/main')!,
      head: repo.refs.get('refs/heads/feature')!,
    };
    expect(
      await ensureResolution(
        t.env,
        db,
        gitFor(t.env, found!.repo),
        row as PullRequest,
        shas
      )
    ).toBe(false);
    const res = await t.env.DB.prepare(
      'SELECT status, model, base_sha AS baseSha, error_message AS error FROM merge_resolutions'
    ).all<{ status: string; model: string; baseSha: string; error: string }>();
    expect(res.results).toEqual([
      expect.objectContaining({
        status: 'failed',
        model: 'none',
        baseSha: shas.base,
      }),
    ]);
    expect(res.results[0].error).toMatch(
      /can't be resolved automatically.*a\.txt/
    );
    // Still one row per commit pair.
    await ensureResolution(
      t.env,
      db,
      gitFor(t.env, found!.repo),
      row as PullRequest,
      shas
    );
    expect(
      (await t.env.DB.prepare(
        'SELECT COUNT(*) AS n FROM merge_resolutions'
      ).first<{ n: number }>())!.n
    ).toBe(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn test worker/src/__tests__/pull-states.test.ts`
Expected: FAIL: cannot resolve `../review/checks`.

- [ ] **Step 3: Create `worker/src/review/checks.ts`**

```ts
import type { ReviewPolicy } from './policy';

export type CheckRun = {
  runNumber: number;
  status: string;
  conclusion: string | null;
};
export type CheckJob = {
  key: string;
  name: string;
  status: string;
  conclusion: string | null;
  runNumber: number;
};
/** review.yml's `checks.require`, or `any` when there is no (valid) review.yml. */
export type CheckRequirement = ReviewPolicy['checks']['require'] | 'any';
export type CheckVerdict =
  | { kind: 'failed'; reason: string; runNumber: number; check: string | null }
  | {
      kind: 'waiting';
      reason: string;
      check: string | null;
      started: boolean;
    };

const failed = (x: { status: string; conclusion: string | null }) =>
  x.status === 'completed' && x.conclusion !== 'success';

/**
 * Whether a commit's Actions checks hold it up: null when they don't. `all` and `any` look at runs (`all` also
 * waits for a first run); a list looks at the named jobs. Shared by auto-merge and pull request states.
 */
export function checkVerdict(
  runs: CheckRun[],
  jobs: CheckJob[],
  require: CheckRequirement
): CheckVerdict | null {
  if (require === 'none') return null;
  if (require === 'all' || require === 'any') {
    if (!runs.length)
      return require === 'all'
        ? {
            kind: 'waiting',
            reason: 'No checks have run for this commit yet',
            check: null,
            started: false,
          }
        : null;
    const bad = runs.find(failed);
    if (bad)
      return {
        kind: 'failed',
        reason: 'Checks failed',
        runNumber: bad.runNumber,
        check: null,
      };
    if (runs.some((r) => r.status !== 'completed'))
      return {
        kind: 'waiting',
        reason: 'Checks are running',
        check: null,
        started: true,
      };
    return null;
  }
  for (const wanted of require) {
    const matching = jobs.filter((j) => j.key === wanted || j.name === wanted);
    if (!matching.length)
      return {
        kind: 'waiting',
        reason: `Waiting for the "${wanted}" check`,
        check: wanted,
        started: false,
      };
    const bad = matching.find(failed);
    if (bad)
      return {
        kind: 'failed',
        reason: `The "${wanted}" check failed`,
        runNumber: bad.runNumber,
        check: wanted,
      };
    if (matching.some((j) => j.status !== 'completed'))
      return {
        kind: 'waiting',
        reason: `The "${wanted}" check is running`,
        check: wanted,
        started: true,
      };
  }
  return null;
}
```

- [ ] **Step 4: Rewrite `checkProblem` in `worker/src/review/auto-merge.ts`** to load and delegate (same messages,
      so the existing review tests keep passing). Replace the whole function body with:

```ts
async function checkProblem(
  db: DrizzleDB,
  repositoryId: string,
  sha: string,
  require: ReviewPolicy['checks']['require']
): Promise<{ kind: 'waiting' | 'blocked'; reason: string } | null> {
  if (require === 'none') return null;
  const at = and(
    eq(workflowRuns.repositoryId, repositoryId),
    eq(workflowRuns.headSha, sha)
  );
  const runs = await db.select().from(workflowRuns).where(at).all();
  const jobs =
    Array.isArray(require) && runs.length
      ? await db
          .select({
            key: workflowJobs.jobKey,
            name: workflowJobs.name,
            status: workflowJobs.status,
            conclusion: workflowJobs.conclusion,
            runNumber: workflowRuns.runNumber,
          })
          .from(workflowJobs)
          .innerJoin(workflowRuns, eq(workflowRuns.id, workflowJobs.runId))
          .where(at)
          .all()
      : [];
  const v = checkVerdict(runs, jobs, require);
  if (!v) return null;
  return {
    kind: v.kind === 'failed' ? 'blocked' : 'waiting',
    reason: v.reason,
  };
}
```

and add `import { checkVerdict } from './checks';` to the imports.

- [ ] **Step 5: Export `SUPERSEDED`** in `worker/src/merge/resolution.ts`, after `MAX_INTENT_COMMITS`:

```ts
/** The error a resolution gets when newer commits replace the ones it was for. */
export const SUPERSEDED = 'Superseded by newer commits.';
```

and replace the three `'Superseded by newer commits.'` literals in that file with `SUPERSEDED`.

- [ ] **Step 6: Record non-text conflicts** in `ensureResolution` (`worker/src/merge/auto.ts`). Replace
      `if (!resolvable) return false;` with:

```ts
if (!resolvable) {
  // Binary or delete/edit conflicts: AI can't resolve them, so record why for the PR's state and inbox.
  if (!plan.upToDate && plan.conflicts.length > 0) {
    const textual = new Set(plan.conflictFiles.map((f) => f.path));
    const other = plan.conflicts.filter((p) => !textual.has(p));
    await db.insert(mergeResolutions).values({
      id: crypto.randomUUID(),
      pullRequestId: pr.id,
      baseSha: shas.base,
      headSha: shas.head,
      status: 'failed',
      model: 'none',
      conflictedPaths: plan.conflicts,
      errorMessage: `These conflicts can't be resolved automatically (binary files, or a file deleted on one side and changed on the other): ${other.join(', ')}. Resolve them locally.`,
      createdAt: new Date(),
    });
  }
  return false;
}
```

- [ ] **Step 7: Run the tests**

Run: `yarn test worker/src/__tests__/pull-states.test.ts worker/src/__tests__/review.test.ts worker/src/__tests__/merge-resolution.test.ts`
Expected: PASS. If a merge-resolution test asserted that a non-text conflict creates no row, update it to expect the
one `failed` row with `model: 'none'` (that is this task's intended change).

- [ ] **Step 8: Commit**

```bash
git add worker/src/review/checks.ts worker/src/review/auto-merge.ts worker/src/merge/resolution.ts worker/src/merge/auto.ts worker/src/__tests__/
git commit -m "Checks verdict shared by auto-merge and states; record conflicts AI can't resolve

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 3: `pullStates` (batch signals)

**Files:**

- Create: `worker/src/pulls/signals.ts`
- Modify: `worker/src/stack/view.ts` (export `chunks`)
- Test: `worker/src/__tests__/pull-states.test.ts`

**Interfaces:**

- Consumes: `checkVerdict` (Task 2), `decideState`, `stackReasons` (Task 1), `stackTreeView(db, git, repositoryId, { authors: false })` and `StackTreeView` from `worker/src/stack/view.ts`, `readPolicy`/`parsePolicy`/`POLICY_PATH` from `worker/src/review/policy.ts`, `SUPERSEDED`.
- Produces:
  - `pullStates(db: DrizzleDB, git: GitService, repositoryId: string, prs: PullRequest[], opts?: { refs?: Map<string, string>; tree?: StackTreeView }): Promise<Map<string, PullState>>` keyed by PR id; open PRs with both branches only.
  - `pullStateFor(db: DrizzleDB, git: GitService, pr: PullRequest): Promise<PullState | null>`.
  - `export function chunks<T>(xs: T[], size: number): T[][]` from `worker/src/stack/view.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `worker/src/__tests__/pull-states.test.ts` (merge imports):

```ts
import { pullStates } from '../pulls/signals';
import { executeClassification } from '../review/classify';
import type { StepRunner } from '../merge/resolution';
import type { ClassifierAnswer } from '../db/app.schema';
import type { ReviewModels } from '../review/models';
import type { TestEnv } from './helpers/app';

const step = {
  do: async (_name: string, a: unknown, b?: unknown) =>
    ((b ?? a) as () => Promise<unknown>)(),
} as unknown as StepRunner;

/** Review models that flag `data_model` when `flag` is set. */
function reviewModels(flag = false): ReviewModels {
  return {
    summarize: async (f) => `Changes ${f.path}.`,
    classify: async (): Promise<Record<string, ClassifierAnswer>> => ({
      data_model: { type: 'noul', value: flag ? 0.9 : 0.05 },
    }),
    investigate: async () => ({
      detail: 'x',
      diagram: null,
      snippets: [],
      paths: [],
    }),
  };
}

const FLAGGING = `
model: clef
checks:
  require: all
human_review:
  questions:
    data_model:
      ask: Does this change alter how data is stored?
      above: 0.3
`;

/** A repository whose main has `policy` (or none), with helpers to open PRs and read their states. */
async function statesRepo(policy: string | null) {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'private' },
  });
  const repo = [...t.fake.repos.values()][0];
  const files = {
    'src/app.ts': 'export const a = 1;\n',
    ...(policy ? { '.gitorange/review.yml': policy } : {}),
  };
  const main = await commitPaths(repo, 'main', files, 'base');
  const db = drizzle(t.env.DB, { schema });
  const repoId = (await t.env.DB.prepare('SELECT id FROM repositories').first<{
    id: string;
  }>())!.id;
  async function open(
    branch: string,
    changes: Record<string, string>,
    title = branch
  ) {
    repo.refs.set(`refs/heads/${branch}`, main);
    await commitPaths(repo, branch, { ...files, ...changes }, title);
    const res = await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title, body: '', base: 'main', head: branch },
    });
    expect(res.status).toBe(201);
    await settle(t);
    return ((await res.json()) as { number: number }).number;
  }
  async function states() {
    const found = await findRepoById(db, repoId);
    const prs = await db.query.pullRequests.findMany();
    const map = await pullStates(
      db,
      gitFor(t.env, found!.repo),
      repoId,
      prs as PullRequest[]
    );
    return Object.fromEntries(
      prs.map((p) => [p.number, map.get(p.id) ?? null])
    ) as Record<number, { state: string; reasons: { kind: string }[] } | null>;
  }
  async function runReviews(models: ReviewModels) {
    for (const r of t.actions.resolutions) {
      const id = (r.params as { classificationId?: string }).classificationId;
      if (id) await executeClassification({ env: t.env, db, step, models }, id);
    }
    await settle(t);
  }
  const head = (branch: string) => repo.refs.get(`refs/heads/${branch}`)!;
  async function run(
    n: number,
    branch: string,
    status: string,
    conclusion: string | null
  ) {
    await t.env.DB.prepare(
      `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title, status, conclusion, created_at)
       VALUES (?, ?, ?, '.github/workflows/ci.yml', 'CI', 'pull_request', 'x', ?, 'x', ?, ?, 0)`
    )
      .bind(crypto.randomUUID(), repoId, n, head(branch), status, conclusion)
      .run();
  }
  return {
    t,
    admin,
    repo,
    db,
    repoId,
    open,
    states,
    runReviews,
    head,
    run,
    files,
  };
}

describe('pullStates', () => {
  it('without review.yml: failed checks need the agent, running ones wait, none is ready', async () => {
    const s = await statesRepo(null);
    await s.open('one', { 'a.txt': 'a\n' });
    expect((await s.states())[1]).toEqual({ state: 'ready', reasons: [] });
    await s.run(1, 'one', 'in_progress', null);
    expect((await s.states())[1]).toEqual({
      state: 'waiting',
      reasons: [{ kind: 'checks_running', check: null, started: true }],
    });
    await s.run(2, 'one', 'completed', 'failure');
    expect((await s.states())[1]).toMatchObject({
      state: 'agent_followup',
      reasons: [{ kind: 'check_failed', run_number: 2, check: null }],
    });
  });

  it('ignores checks that review.yml doesn’t require', async () => {
    const s = await statesRepo('checks:\n  require: none\n');
    await s.open('one', { 'a.txt': 'a\n' });
    // Otherwise the clean review would land it on its own.
    await call(s.t, '/api/repos/octocat/app/pulls/1/auto-merge', {
      cookie: s.admin,
      method: 'PUT',
      json: { enabled: false },
    });
    await s.runReviews(reviewModels());
    await s.run(1, 'one', 'completed', 'failure');
    expect((await s.states())[1]).toEqual({ state: 'ready', reasons: [] });
  });

  it('follows the review: running waits, flags need a person, changes requested need the agent', async () => {
    const s = await statesRepo(FLAGGING);
    await s.open('one', { 'migrations/0001.sql': 'x\n' });
    expect((await s.states())[1]?.reasons).toContainEqual({
      kind: 'review_running',
    });
    await s.runReviews(reviewModels(true));
    await s.run(1, 'one', 'completed', 'success');
    expect((await s.states())[1]).toEqual({
      state: 'human_review',
      reasons: [{ kind: 'flags_pending', count: 1 }],
    });
    const flag = (await s.t.env.DB.prepare(
      'SELECT id FROM pr_review_flags'
    ).first<{ id: string }>())!;
    await call(
      s.t,
      `/api/repos/octocat/app/pulls/1/review/flags/${flag.id}/request-changes`,
      {
        cookie: s.admin,
        json: { note: 'Add a down migration.' },
      }
    );
    await settle(s.t);
    expect((await s.states())[1]).toEqual({
      state: 'agent_followup',
      reasons: [{ kind: 'changes_requested', flags: 1 }],
    });
  });

  it('a failed review needs a person; an invalid review.yml in the PR needs the agent', async () => {
    const s = await statesRepo(FLAGGING);
    await s.open('one', { 'a.txt': 'a\n' });
    await s.runReviews({
      ...reviewModels(),
      classify: async () => {
        throw new Error('down');
      },
    });
    expect((await s.states())[1]?.state).toBe('human_review');
    expect((await s.states())[1]?.reasons[0]).toMatchObject({
      kind: 'review_failed',
    });
    await s.open('two', {
      '.gitorange/review.yml': 'checks:\n  require: sometimes\n',
    });
    await s.runReviews(reviewModels());
    expect((await s.states())[2]?.reasons[0]).toMatchObject({
      kind: 'review_policy_invalid',
      where: 'pull_request',
    });
    expect((await s.states())[2]?.state).toBe('agent_followup');
  });

  it('an invalid review.yml on the target needs a person', async () => {
    const s = await statesRepo('checks:\n  require: sometimes\n');
    await s.open('one', { 'a.txt': 'a\n' });
    expect((await s.states())[1]).toMatchObject({
      state: 'human_review',
      reasons: [{ kind: 'review_policy_invalid', where: 'target' }],
    });
  });

  it('reads AI resolution at the current commits: running waits, failed needs the agent', async () => {
    const s = await statesRepo(null);
    await s.open('one', { 'a.txt': 'a\n' });
    const pr = (await s.t.env.DB.prepare('SELECT id FROM pull_requests').first<{
      id: string;
    }>())!;
    const insert = (
      status: string,
      base: string,
      error: string | null,
      at: number
    ) =>
      s.t.env.DB.prepare(
        `INSERT INTO merge_resolutions (id, pull_request_id, base_sha, head_sha, status, model, conflicted_paths, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, 'm', '["a.txt"]', ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          pr.id,
          base,
          s.head('one'),
          status,
          error,
          at
        )
        .run();
    await insert('running', s.head('main'), null, 100);
    expect((await s.states())[1]?.reasons).toEqual([
      { kind: 'resolution_running' },
    ]);
    await insert('failed', s.head('main'), 'Gave up.', 200);
    expect((await s.states())[1]).toEqual({
      state: 'agent_followup',
      reasons: [
        { kind: 'conflicts_unresolved', files: ['a.txt'], error: 'Gave up.' },
      ],
    });
  });

  it('ignores resolutions for other commits and superseded ones', async () => {
    const s = await statesRepo(null);
    await s.open('one', { 'a.txt': 'a\n' });
    const pr = (await s.t.env.DB.prepare('SELECT id FROM pull_requests').first<{
      id: string;
    }>())!;
    await s.t.env.DB.prepare(
      `INSERT INTO merge_resolutions (id, pull_request_id, base_sha, head_sha, status, model, conflicted_paths, error_message, created_at)
       VALUES ('old', ?, ?, ?, 'failed', 'm', '[]', 'Gave up.', 1), ('sup', ?, ?, ?, 'failed', 'm', '[]', 'Superseded by newer commits.', 2)`
    )
      .bind(
        pr.id,
        'f'.repeat(40),
        s.head('one'),
        pr.id,
        s.head('main'),
        s.head('one')
      )
      .run();
    expect((await s.states())[1]).toEqual({ state: 'ready', reasons: [] });
  });

  it('with stacking on: must account for is reported; the state comes from the rest', async () => {
    // Checks are required and never run, so neither PR lands on its own.
    const s = await statesRepo(
      'checks:\n  require: all\nstacking:\n  enabled: true\n'
    );
    await s.open('one', { 'a.txt': 'a\n' });
    await s.open('two', { 'b.txt': 'b\n' });
    const ids = (
      await s.t.env.DB.prepare(
        'SELECT id FROM pull_requests ORDER BY number'
      ).all<{ id: string }>()
    ).results;
    await s.t.env.DB.prepare(
      `INSERT INTO pr_edges (id, repository_id, land_target, pr_a_id, pr_b_id, a_head, b_head, stage, kind, prerequisite, reason, instructions, created_at, updated_at)
       VALUES ('e', ?, 'main', ?, ?, ?, ?, 'done', 'must_account_for', 'a', 'Needs a check.', 'Add a setup check.', 0, 0)`
    )
      .bind(s.repoId, ids[0].id, ids[1].id, s.head('one'), s.head('two'))
      .run();
    await s.runReviews(reviewModels());
    const st = await s.states();
    // Reported for the agent, but (until 2b) it doesn't decide the state: checks still wait.
    expect(st[2]).toEqual({
      state: 'waiting',
      reasons: [
        { kind: 'checks_running', check: null, started: false },
        {
          kind: 'must_account_for',
          pr: 1,
          landed: false,
          instructions: 'Add a setup check.',
        },
        { kind: 'stacked_on', pr: 1 },
      ],
    });
    expect(st[1]).toEqual({
      state: 'waiting',
      reasons: [{ kind: 'checks_running', check: null, started: false }],
    });
  });

  it('has no state for a PR whose branch is gone, nor for closed PRs', async () => {
    const s = await statesRepo(null);
    await s.open('one', { 'a.txt': 'a\n' });
    s.repo.refs.delete('refs/heads/one');
    expect((await s.states())[1]).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn test worker/src/__tests__/pull-states.test.ts`
Expected: FAIL: cannot resolve `../pulls/signals`.

- [ ] **Step 3: Export `chunks`** in `worker/src/stack/view.ts`: change `function chunks<T>(` to
      `export function chunks<T>(`.

- [ ] **Step 4: Create `worker/src/pulls/signals.ts`**

```ts
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  mergeResolutions,
  prClassifications,
  prReviewFlags,
  workflowJobs,
  workflowRuns,
  type PullRequest,
} from '../db/app.schema';
import type { GitService } from '../git/service';
import { SUPERSEDED } from '../merge/resolution';
import { checkVerdict, type CheckJob, type CheckRun } from '../review/checks';
import {
  parsePolicy,
  POLICY_PATH,
  readPolicy,
  type ReviewPolicy,
} from '../review/policy';
import { chunks, stackTreeView, type StackTreeView } from '../stack/view';
import {
  decideState,
  stackReasons,
  type PullState,
  type Reason,
} from './state';

type TargetPolicy = {
  sha: string;
  policy: ReviewPolicy | null;
  error: string | null;
} | null;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** review.yml at a commit: null when absent, `error` when it doesn't parse. */
async function policyAt(git: GitService, sha: string): Promise<TargetPolicy> {
  const file = await readPolicy(git, sha).catch(() => null);
  if (!file) return null;
  try {
    return { sha: file.sha, policy: parsePolicy(file.text), error: null };
  } catch (e) {
    return { sha: file.sha, policy: null, error: message(e) };
  }
}

/**
 * The computed state of each open PR among `prs` (keyed by id), in a fixed number of queries: one ref listing,
 * one review.yml read per target tip, the stack view, and chunked D1 reads. PRs missing a branch are left out.
 */
export async function pullStates(
  db: DrizzleDB,
  git: GitService,
  repositoryId: string,
  prs: PullRequest[],
  opts: { refs?: Map<string, string>; tree?: StackTreeView } = {}
): Promise<Map<string, PullState>> {
  const out = new Map<string, PullState>();
  if (!prs.some((p) => p.state === 'open')) return out;
  const refs = opts.refs ?? (await git.refs());
  const tips = prs.flatMap((pr) => {
    if (pr.state !== 'open') return [];
    const base = refs.get(`refs/heads/${pr.baseRef}`);
    const head = refs.get(`refs/heads/${pr.headRef}`);
    return base && head ? [{ pr, base, head }] : [];
  });
  if (!tips.length) return out;

  const policies = new Map<string, TargetPolicy>();
  for (const base of new Set(tips.map((t) => t.base)))
    policies.set(base, await policyAt(git, base));
  const ids = tips.map((t) => t.pr.id);
  const heads = [...new Set(tips.map((t) => t.head))];

  // Reviews (no file lists: whether one changes review.yml is answered in SQL).
  const reviews = (
    await Promise.all(
      chunks(ids, 90).map((part) =>
        db
          .select({
            id: prClassifications.id,
            pullRequestId: prClassifications.pullRequestId,
            headSha: prClassifications.headSha,
            policySha: prClassifications.policySha,
            status: prClassifications.status,
            verdict: prClassifications.verdict,
            errorMessage: prClassifications.errorMessage,
            changesPolicy: sql<number>`EXISTS (SELECT 1 FROM json_each(COALESCE(${prClassifications.files}, '[]')) WHERE json_extract(value, '$.path') = ${POLICY_PATH} AND json_extract(value, '$.status') <> 'removed')`,
          })
          .from(prClassifications)
          .where(inArray(prClassifications.pullRequestId, part))
          .all()
      )
    )
  ).flat();
  const reviewAt = new Map(
    reviews.map((r) => [`${r.pullRequestId} ${r.headSha} ${r.policySha}`, r])
  );
  const current = tips.flatMap(({ pr, base, head }) => {
    const pol = policies.get(base);
    const r = pol ? reviewAt.get(`${pr.id} ${head} ${pol.sha}`) : undefined;
    return r ? [r] : [];
  });

  // Unapproved flags of the current reviews: how many, and how many with changes requested.
  const flags = new Map<string, { open: number; changes: number }>();
  const human = current
    .filter((r) => r.status === 'done' && r.verdict === 'human')
    .map((r) => r.id);
  for (const part of chunks(human, 90))
    for (const f of await db
      .select({
        classificationId: prReviewFlags.classificationId,
        open: sql<number>`COUNT(*)`,
        changes: sql<number>`SUM(CASE WHEN ${prReviewFlags.changesRequestedAt} IS NOT NULL THEN 1 ELSE 0 END)`,
      })
      .from(prReviewFlags)
      .where(
        and(
          inArray(prReviewFlags.classificationId, part),
          isNull(prReviewFlags.approvedAt)
        )
      )
      .groupBy(prReviewFlags.classificationId)
      .all())
      flags.set(f.classificationId, {
        open: Number(f.open),
        changes: Number(f.changes ?? 0),
      });

  // Actions runs (and, when review.yml names checks, their jobs) at the heads.
  const runs: (CheckRun & { headSha: string })[] = [];
  const jobs: (CheckJob & { headSha: string })[] = [];
  const wantJobs = [...policies.values()].some((p) =>
    Array.isArray(p?.policy?.checks.require)
  );
  for (const part of chunks(heads, 90)) {
    const at = and(
      eq(workflowRuns.repositoryId, repositoryId),
      inArray(workflowRuns.headSha, part)
    );
    runs.push(
      ...(await db
        .select({
          runNumber: workflowRuns.runNumber,
          status: workflowRuns.status,
          conclusion: workflowRuns.conclusion,
          headSha: workflowRuns.headSha,
        })
        .from(workflowRuns)
        .where(at)
        .all())
    );
    if (wantJobs)
      jobs.push(
        ...(await db
          .select({
            key: workflowJobs.jobKey,
            name: workflowJobs.name,
            status: workflowJobs.status,
            conclusion: workflowJobs.conclusion,
            runNumber: workflowRuns.runNumber,
            headSha: workflowRuns.headSha,
          })
          .from(workflowJobs)
          .innerJoin(workflowRuns, eq(workflowRuns.id, workflowJobs.runId))
          .where(at)
          .all())
      );
  }

  // The latest AI resolution of each PR.
  const resolutions = new Map<
    string,
    {
      status: string;
      baseSha: string;
      headSha: string;
      errorMessage: string | null;
      conflictedPaths: string[];
    }
  >();
  for (const part of chunks(ids, 90))
    for (const r of await db
      .select({
        pullRequestId: mergeResolutions.pullRequestId,
        status: mergeResolutions.status,
        baseSha: mergeResolutions.baseSha,
        headSha: mergeResolutions.headSha,
        errorMessage: mergeResolutions.errorMessage,
        conflictedPaths: mergeResolutions.conflictedPaths,
      })
      .from(mergeResolutions)
      .where(inArray(mergeResolutions.pullRequestId, part))
      .orderBy(desc(mergeResolutions.createdAt))
      .all())
      if (!resolutions.has(r.pullRequestId))
        resolutions.set(r.pullRequestId, r);

  const tree =
    opts.tree ??
    (await stackTreeView(db, git, repositoryId, { authors: false }));

  for (const { pr, base, head } of tips) {
    const reasons: Reason[] = [];
    const pol = policies.get(base) ?? null;

    const v = checkVerdict(
      runs.filter((r) => r.headSha === head),
      jobs.filter((j) => j.headSha === head),
      pol?.policy ? pol.policy.checks.require : 'any'
    );
    if (v?.kind === 'failed')
      reasons.push({
        kind: 'check_failed',
        run_number: v.runNumber,
        check: v.check,
      });
    else if (v)
      reasons.push({
        kind: 'checks_running',
        check: v.check,
        started: v.started,
      });

    if (pol?.error)
      reasons.push({
        kind: 'review_policy_invalid',
        where: 'target',
        error: pol.error,
      });
    else if (pol) {
      const review = reviewAt.get(`${pr.id} ${head} ${pol.sha}`);
      if (!review || (review.status !== 'done' && review.status !== 'failed'))
        reasons.push({ kind: 'review_running' });
      else if (review.status === 'failed')
        reasons.push({ kind: 'review_failed', error: review.errorMessage });
      else if (review.verdict === 'human') {
        const f = flags.get(review.id);
        if (f?.changes)
          reasons.push({ kind: 'changes_requested', flags: f.changes });
        if (f && f.open - f.changes > 0)
          reasons.push({ kind: 'flags_pending', count: f.open - f.changes });
      }
      // The PR's own review.yml takes effect once it lands: an invalid one is the author's to fix.
      if (review && Number(review.changesPolicy)) {
        const own = await policyAt(git, head);
        if (own?.error)
          reasons.push({
            kind: 'review_policy_invalid',
            where: 'pull_request',
            error: own.error,
          });
      }
    }

    const r = resolutions.get(pr.id);
    if (r && r.baseSha === base && r.headSha === head) {
      if (r.status === 'queued' || r.status === 'running')
        reasons.push({ kind: 'resolution_running' });
      else if (
        r.status === 'rejected' ||
        (r.status === 'failed' && r.errorMessage !== SUPERSEDED)
      )
        reasons.push({
          kind: 'conflicts_unresolved',
          files: r.conflictedPaths,
          error: r.errorMessage,
        });
    }

    const node = tree.targets
      .find((t) => t.branch === pr.baseRef)
      ?.nodes.find((n) => n.number === pr.number);
    if (node) reasons.push(...stackReasons(node));

    out.set(pr.id, decideState(reasons));
  }
  return out;
}

/** One PR's state; null unless it is open with both branches. */
export async function pullStateFor(
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest
): Promise<PullState | null> {
  if (pr.state !== 'open') return null;
  return (await pullStates(db, git, pr.repositoryId, [pr])).get(pr.id) ?? null;
}
```

- [ ] **Step 5: Run the tests**

Run: `yarn test worker/src/__tests__/pull-states.test.ts`
Expected: PASS. (In the invalid-review.yml test, `#2`'s review runs under main's valid `FLAGGING` policy and
records `.gitorange/review.yml` among its files; only then is the PR's own copy read and found invalid.)

- [ ] **Step 6: Commit**

```bash
git add worker/src/pulls/signals.ts worker/src/stack/view.ts worker/src/__tests__/pull-states.test.ts
git commit -m "Pull request states: batch signals from checks, review, resolution and stack

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 4: `pr_events` and recording state changes

**Files:**

- Modify: `worker/src/db/app.schema.ts` (after `prEdges`), generated `migrations/00NN_*.sql`
- Create: `worker/src/pulls/events.ts`, `worker/src/pulls/settle.ts`
- Test: `worker/src/__tests__/pull-states.test.ts`

**Interfaces:**

- Consumes: `pullStates` (Task 3), `publishChange` from `worker/src/live/publish.ts`, `findRepoById`/`gitFor`.
- Produces:
  - Table `prEvents` (`pr_events`), types `PrEvent`, `PrEventKind = 'state_changed'` (2b extends the enum).
  - `stateEventStatement(db, pr: Pick<PullRequest, 'id' | 'repositoryId'>, s: PullState, computedAt: number)` (a batchable `db.run`).
  - `recordStates(db, prs: Pick<PullRequest, 'id' | 'repositoryId'>[], states: Map<string, PullState>, computedAt: number): Promise<number>` (rows inserted).
  - `eventsFor(db, pullRequestId: string): Promise<PrEvent[]>` (oldest first).
  - `latestStates(db, pullRequestIds: string[]): Promise<Map<string, PullState>>`.
  - `settleStates(env, db, repositoryId: string): Promise<number>` (never throws; pings `repo:<id>` and `approvals` when it recorded something).
  - `repositoryForPayload(db, p: { resolutionId?: string; classificationId?: string; sweep?: { repositoryId: string }; stack?: { pullRequestId: string } }): Promise<string | null>`.

- [ ] **Step 1: Add the table** to `worker/src/db/app.schema.ts`, after `export type PrEdge = …`:

```ts
// ── Pull request timeline ────────────────────────────────────────────────────
// GitOrange's own timeline entries. state_changed: the PR's computed state changed (states are never stored
// otherwise). Milestone 2b adds stacking events.

export type PrEventKind = 'state_changed';

export const prEvents = sqliteTable(
  'pr_events',
  {
    id: text('id').primaryKey(),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['state_changed'] }).notNull(),
    // state_changed: the state it changed to.
    state: text('state', {
      enum: ['agent_followup', 'human_review', 'waiting', 'ready'],
    }),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
    actorId: text('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // state_changed: when the recorded state was computed. A computation older than the latest recorded one
    // never records (see worker/src/pulls/events.ts).
    computedAt: integer('computed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('pr_events_pr_kind_idx').on(t.pullRequestId, t.kind, t.computedAt),
  ]
);
export type PrEvent = typeof prEvents.$inferSelect;
```

- [ ] **Step 2: Generate and review the migration**

Run: `yarn db:generate`
Expected: a new `migrations/00NN_*.sql` with `CREATE TABLE pr_events` (both foreign keys `ON DELETE cascade`,
`actor_id` `ON DELETE set null`) and `CREATE INDEX pr_events_pr_kind_idx`. Nothing else may change; if the diff
touches other tables, stop and find out why.

- [ ] **Step 3: Write the failing tests**

Append to `worker/src/__tests__/pull-states.test.ts` (merge imports):

```ts
import { recordStates, eventsFor, latestStates } from '../pulls/events';
import { repositoryForPayload, settleStates } from '../pulls/settle';

describe('recording state changes', () => {
  async function onePr() {
    const s = await statesRepo(null);
    await s.open('one', { 'a.txt': 'a\n' });
    const pr = (await s.db.query.pullRequests.findFirst())!;
    return { ...s, pr };
  }
  const ready = { state: 'ready' as const, reasons: [] };
  const waiting = {
    state: 'waiting' as const,
    reasons: [{ kind: 'review_running' as const }],
  };

  it('records a change once, and nothing when unchanged', async () => {
    const s = await onePr();
    await s.t.env.DB.prepare('DELETE FROM pr_events').run();
    expect(
      await recordStates(s.db, [s.pr], new Map([[s.pr.id, ready]]), 1000)
    ).toBe(1);
    expect(
      await recordStates(s.db, [s.pr], new Map([[s.pr.id, ready]]), 2000)
    ).toBe(0);
    expect(
      await recordStates(s.db, [s.pr], new Map([[s.pr.id, waiting]]), 3000)
    ).toBe(1);
    expect(
      (await eventsFor(s.db, s.pr.id)).map((e) => [e.kind, e.state])
    ).toEqual([
      ['state_changed', 'ready'],
      ['state_changed', 'waiting'],
    ]);
    expect((await latestStates(s.db, [s.pr.id])).get(s.pr.id)).toEqual(waiting);
  });

  it('never records a stale computation over a newer one', async () => {
    const s = await onePr();
    await s.t.env.DB.prepare('DELETE FROM pr_events').run();
    expect(
      await recordStates(s.db, [s.pr], new Map([[s.pr.id, waiting]]), 5000)
    ).toBe(1);
    // Computed earlier (before the change above), finishing later: dropped.
    expect(
      await recordStates(s.db, [s.pr], new Map([[s.pr.id, ready]]), 4000)
    ).toBe(0);
    expect((await latestStates(s.db, [s.pr.id])).get(s.pr.id)).toEqual(waiting);
  });

  it('records once under concurrent settles', async () => {
    const s = await onePr();
    await s.t.env.DB.prepare('DELETE FROM pr_events').run();
    const [a, b] = await Promise.all([
      settleStates(s.t.env, s.db, s.repoId),
      settleStates(s.t.env, s.db, s.repoId),
    ]);
    expect(a + b).toBe(1);
    expect(await eventsFor(s.db, s.pr.id)).toHaveLength(1);
  });

  it('finds the repository of every MERGE_RESOLUTION payload', async () => {
    const s = await onePr();
    expect(
      await repositoryForPayload(s.db, { sweep: { repositoryId: s.repoId } })
    ).toBe(s.repoId);
    expect(
      await repositoryForPayload(s.db, { stack: { pullRequestId: s.pr.id } })
    ).toBe(s.repoId);
    expect(
      await repositoryForPayload(s.db, { classificationId: 'nope' })
    ).toBeNull();
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `yarn test worker/src/__tests__/pull-states.test.ts`
Expected: FAIL: cannot resolve `../pulls/events`.

- [ ] **Step 5: Create `worker/src/pulls/events.ts`**

```ts
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import { prEvents, type PrEvent, type PullRequest } from '../db/app.schema';
import { chunks } from '../stack/view';
import type { PullState, PullStateName, Reason } from './state';

type PrRef = Pick<PullRequest, 'id' | 'repositoryId'>;

/**
 * One atomic statement recording `s` for the PR, unless its latest recorded state is already `s.state`, or a state
 * computed after `computedAt` is already recorded (a slower, older computation never overwrites a newer one).
 */
export function stateEventStatement(
  db: DrizzleDB,
  pr: PrRef,
  s: PullState,
  computedAt: number
) {
  const data = JSON.stringify({ reasons: s.reasons });
  return db.run(sql`
    INSERT INTO pr_events (id, repository_id, pull_request_id, kind, state, data, computed_at, created_at)
    SELECT ${crypto.randomUUID()}, ${pr.repositoryId}, ${pr.id}, 'state_changed', ${s.state}, ${data}, ${computedAt}, ${Date.now()}
    WHERE COALESCE(
        (SELECT state FROM pr_events
          WHERE pull_request_id = ${pr.id} AND kind = 'state_changed'
          ORDER BY computed_at DESC, rowid DESC LIMIT 1),
        '') <> ${s.state}
      AND NOT EXISTS (
        SELECT 1 FROM pr_events
         WHERE pull_request_id = ${pr.id} AND kind = 'state_changed' AND computed_at > ${computedAt})`);
}

/** Records each PR's state if it changed; returns how many were recorded. */
export async function recordStates(
  db: DrizzleDB,
  prs: PrRef[],
  states: Map<string, PullState>,
  computedAt: number
): Promise<number> {
  const stmts = prs.flatMap((pr) => {
    const s = states.get(pr.id);
    return s ? [stateEventStatement(db, pr, s, computedAt)] : [];
  });
  if (!stmts.length) return 0;
  const results = (await db.batch(
    stmts as [(typeof stmts)[0], ...typeof stmts]
  )) as unknown as D1Result[];
  return results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}

/** A PR's timeline events, oldest first. */
export function eventsFor(
  db: DrizzleDB,
  pullRequestId: string
): Promise<PrEvent[]> {
  return db
    .select()
    .from(prEvents)
    .where(eq(prEvents.pullRequestId, pullRequestId))
    .orderBy(asc(prEvents.createdAt))
    .limit(500)
    .all();
}

/** Each PR's latest recorded state, in chunked queries. */
export async function latestStates(
  db: DrizzleDB,
  pullRequestIds: string[]
): Promise<Map<string, PullState>> {
  const out = new Map<string, PullState>();
  for (const part of chunks(pullRequestIds, 90))
    for (const e of await db
      .select({
        pullRequestId: prEvents.pullRequestId,
        state: prEvents.state,
        data: prEvents.data,
      })
      .from(prEvents)
      .where(
        and(
          inArray(prEvents.pullRequestId, part),
          eq(prEvents.kind, 'state_changed'),
          sql`${prEvents}.rowid = (SELECT x.rowid FROM pr_events x WHERE x.pull_request_id = ${prEvents.pullRequestId} AND x.kind = 'state_changed' ORDER BY x.computed_at DESC, x.rowid DESC LIMIT 1)`
        )
      )
      .all())
      if (e.state)
        out.set(e.pullRequestId, {
          state: e.state as PullStateName,
          reasons: (e.data as { reasons?: Reason[] } | null)?.reasons ?? [],
        });
  return out;
}
```

If `db.batch` rejects `db.run` items in the installed drizzle version (a type error you can't cast away), replace
the batch with `for (const st of stmts) total += ((await st) as unknown as D1Result).meta.changes;`: each statement
is still atomic on its own, which is all the guarantee needs.

- [ ] **Step 6: Create `worker/src/pulls/settle.ts`**

```ts
import { and, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  mergeResolutions,
  prClassifications,
  pullRequests,
} from '../db/app.schema';
import { publishChange } from '../live/publish';
import { findRepoById, gitFor } from '../lib/repos';
import { recordStates } from './events';
import { pullStates } from './signals';

/**
 * Recomputes the states of a repository's open PRs and records those that changed (timeline). Called where
 * changes already ping live pages; pings again when it recorded something. Never throws.
 */
export async function settleStates(
  env: CloudflareBindings,
  db: DrizzleDB,
  repositoryId: string
): Promise<number> {
  try {
    const computedAt = Date.now();
    const found = await findRepoById(db, repositoryId);
    if (!found) return 0;
    const open = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          eq(pullRequests.state, 'open')
        )
      )
      .all();
    if (!open.length) return 0;
    const states = await pullStates(
      db,
      gitFor(env, found.repo),
      repositoryId,
      open
    );
    const recorded = await recordStates(db, open, states, computedAt);
    if (recorded) await publishChange(env, repositoryId, { approvals: true });
    return recorded;
  } catch (e) {
    console.error('[states] settle failed', repositoryId, e);
    return 0;
  }
}

/** The repository a MERGE_RESOLUTION Workflow payload is about. */
export async function repositoryForPayload(
  db: DrizzleDB,
  p: {
    resolutionId?: string;
    classificationId?: string;
    sweep?: { repositoryId: string };
    stack?: { pullRequestId: string };
  }
): Promise<string | null> {
  if (p.sweep) return p.sweep.repositoryId;
  let prId = p.stack?.pullRequestId;
  if (!prId && p.classificationId)
    prId = (
      await db
        .select({ id: prClassifications.pullRequestId })
        .from(prClassifications)
        .where(eq(prClassifications.id, p.classificationId))
        .get()
    )?.id;
  if (!prId && p.resolutionId)
    prId = (
      await db
        .select({ id: mergeResolutions.pullRequestId })
        .from(mergeResolutions)
        .where(eq(mergeResolutions.id, p.resolutionId))
        .get()
    )?.id;
  if (!prId) return null;
  const row = await db
    .select({ repositoryId: pullRequests.repositoryId })
    .from(pullRequests)
    .where(eq(pullRequests.id, prId))
    .get();
  return row?.repositoryId ?? null;
}
```

- [ ] **Step 7: Run the tests**

Run: `yarn test worker/src/__tests__/pull-states.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add worker/src/db/app.schema.ts migrations/ worker/src/pulls/events.ts worker/src/pulls/settle.ts worker/src/__tests__/pull-states.test.ts
git commit -m "Pull request timeline: record state changes once, never stale

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 5: Settle where changes already ping

**Files:**

- Modify: `worker/src/index.ts` (`pingAfterChange`), `worker/src/git-http.ts` (`afterPush`), `worker/src/lib/pulls.ts` (`openPull`), `worker/src/merge/land.ts` (`landPull`), `worker/src/review/flags.ts` (`decideFlag`), `worker/src/merge/workflow.ts` (`run`), `worker/src/actions/executor.ts` (`executeRun`)
- Test: `worker/src/__tests__/pull-states.test.ts`, `worker/src/__tests__/actions.test.ts`

**Interfaces:**

- Consumes: `settleStates`, `repositoryForPayload` (Task 4).
- Produces: a `states` step at the end of every MERGE_RESOLUTION run and every Actions run.

- [ ] **Step 1: Write the failing tests**

Append to `worker/src/__tests__/pull-states.test.ts`:

```ts
describe('state changes on the timeline', () => {
  it('records the opened PR’s state, and a change after an API mutation, once', async () => {
    const s = await statesRepo(null);
    await s.open('one', { 'a.txt': 'a\n' });
    const kinds = async () =>
      (
        await s.t.env.DB.prepare(
          "SELECT state FROM pr_events WHERE kind = 'state_changed' ORDER BY computed_at"
        ).all<{ state: string }>()
      ).results.map((r) => r.state);
    expect(await kinds()).toEqual(['ready']);
    await s.run(1, 'one', 'completed', 'failure');
    await call(s.t, '/api/repos/octocat/app/pulls/1/comments', {
      cookie: s.admin,
      json: { body: 'CI is red.' },
    });
    await settle(s.t);
    expect(await kinds()).toEqual(['ready', 'agent_followup']);
    await call(s.t, '/api/repos/octocat/app/pulls/1/comments', {
      cookie: s.admin,
      json: { body: 'Still red.' },
    });
    await settle(s.t);
    expect(await kinds()).toEqual(['ready', 'agent_followup']);
  });
});
```

In `worker/src/__tests__/actions.test.ts`, inside `describe('Actions execution', …)`, add:

```ts
it('settles pull request states when a run finishes', async () => {
  const s = await setup();
  await pushFiles(s, 'main', { '.github/workflows/ci.yml': CI });
  const [queued] = (await runs(s.t, s.admin)).runs;
  const h = harness(s.t);
  await h.run(queued.id);
  expect(h.stepNames).toContain('states');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn test worker/src/__tests__/pull-states.test.ts worker/src/__tests__/actions.test.ts`
Expected: FAIL: no `pr_events` rows; no `states` step.

- [ ] **Step 3: Middleware** in `worker/src/index.ts`. Add `import { settleStates } from './pulls/settle';` and
      replace the body of `pingAfterChange` after the `if (c.req.method === 'GET' …) return;` line with:

```ts
const rc = c as unknown as Context<RepoEnv>;
const repo = rc.get('repo');
if (repo) {
  c.executionCtx.waitUntil(
    publishChange(c.env, repo.id, {
      approvals: c.req.path.includes('/pulls'),
    })
  );
  // The change may move a pull request to another state: record it for the timeline.
  c.executionCtx.waitUntil(settleStates(c.env, rc.get('db'), repo.id));
}
```

- [ ] **Step 4: Push** in `worker/src/git-http.ts` `afterPush`: after `await publishChange(env, repoId, { approvals: true });`
      add `await settleStates(env, db, repoId);` (import from `./pulls/settle`).

- [ ] **Step 5: `openPull`** in `worker/src/lib/pulls.ts`: after
      `opts.after(publishChange(env, repo.id, { approvals: true }));` add
      `opts.after(settleStates(env, db, repo.id));` (import from `../pulls/settle`).

- [ ] **Step 6: `landPull`** in `worker/src/merge/land.ts`: after
      `opts.after(publishChange(env, pr.repositoryId, { approvals: true }));` add
      `opts.after(settleStates(env, db, pr.repositoryId));` (import from `../pulls/settle`).

- [ ] **Step 7: `decideFlag`** in `worker/src/review/flags.ts`: after the `after(maybeAutoMerge(...))` call add
      `after(settleStates(env, db, pr.repositoryId));` (import from `../pulls/settle`). This covers the MCP flag
      tools, which don't pass through the API middleware.

- [ ] **Step 8: MERGE_RESOLUTION entrypoint** in `worker/src/merge/workflow.ts`. Import
      `import { repositoryForPayload, settleStates } from '../pulls/settle';` and restructure `run` so every payload
      falls through to one final step:

```ts
  async run(event: WorkflowEvent<MergeResolutionParams>, step: WorkflowStep) {
    const db = drizzle(this.env.DB, { schema });
    // The executors' results are plain JSON; adapt to WorkflowStep's Serializable typing.
    const runner = step as unknown as StepRunner;
    const p = event.payload;
    if (p.classificationId) {
      const ids = await getSettings(db, this.env, [
        'ai.summary_model',
        'ai.review_model',
      ]);
      const models = workersAiModels(
        this.env,
        { summary: ids['ai.summary_model'], review: ids['ai.review_model'] },
        { classificationId: p.classificationId }
      );
      await executeClassification(
        { env: this.env, db, step: runner, models },
        p.classificationId
      );
    } else if (p.stack) {
      const ids = await getSettings(db, this.env, ['ai.review_model']);
      const pr = p.stack.pullRequestId;
      const row = await db.query.pullRequests.findFirst({
        where: (x, { eq }) => eq(x.id, pr),
        columns: { repositoryId: true },
      });
      if (row)
        await executeStacking(
          {
            env: this.env,
            db,
            step: runner,
            models: workersAiStackModels(
              this.env,
              { review: ids['ai.review_model'] },
              { repositoryId: row.repositoryId, pullRequestId: pr }
            ),
          },
          p.stack
        );
    } else if (p.sweep) {
      await executeSweep({ env: this.env, db, step: runner }, p.sweep);
    } else {
      await executeResolution(
        {
          env: this.env,
          db,
          step: runner,
          resolver: (id) => this.env.MERGE_RESOLVER.getByName(id),
        },
        p.resolutionId!
      );
    }
    // Whatever ran may have moved pull requests to another state: record changes for the timeline.
    await runner.do('states', async () => {
      const repositoryId = await repositoryForPayload(db, p);
      if (repositoryId) await settleStates(this.env, db, repositoryId);
      return true;
    });
  }
```

- [ ] **Step 9: Actions** in `worker/src/actions/executor.ts` `executeRun`: import `settleStates` from
      `../pulls/settle`, and add a final step on both completion paths. After the `fail-run` step (before
      `return 'failure';`) and after the `auto-merge` step block (before `return conclusion;`), add:

```ts
await step.do('states', async () => {
  await settleStates(env, db, ctx.repoId);
  return true;
});
```

(`db` here is the executor's `Db`; if its type differs from `DrizzleDB`, cast as the `auto-merge` step's
`autoMergeForCommit(env, db, …)` call already does, the same database.)

- [ ] **Step 10: Run the tests**

Run: `yarn test worker/src/__tests__/pull-states.test.ts worker/src/__tests__/actions.test.ts worker/src/__tests__/live.test.ts worker/src/__tests__/review.test.ts`
Expected: PASS. Existing Actions tests that assert the exact `stepNames` list need `'states'` appended at the end;
add it (that is the intended change).

- [ ] **Step 11: Commit**

```bash
git add worker/src/
git commit -m "Record pull request state changes where changes already ping

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 6: REST API: `pullState`, the `state` filter, events, tree nodes

**Files:**

- Modify: `worker/src/routers/schemas.ts`, `worker/src/routers/pulls-router.ts` (list ~line 133, tree ~315, detail ~544)
- Test: `worker/src/__tests__/pull-states.test.ts`

**Interfaces:**

- Consumes: `pullStates`, `pullStateFor` (Task 3), `eventsFor` (Task 4), `PULL_STATES`, `REASON_KINDS` (Task 1).
- Produces:
  - `pullStateSchema` (`PullState` in OpenAPI) and `prEventSchema` from `worker/src/routers/schemas.ts`.
  - `GET /pulls?state=open|closed|agent_followup|human_review|waiting|ready`; each open row has `pullState: PullState | null`.
  - `GET /pulls/{n}` adds `pullState: PullState | null` and `events: { id, kind, state, data, actor, createdAt }[]`.
  - `GET /pulls/tree` nodes add `pullState: PullState | null`.

- [ ] **Step 1: Write the failing tests**

Append to `worker/src/__tests__/pull-states.test.ts` (merge imports: `addMember` from `./helpers/app`):

```ts
describe('pull request states over the API', () => {
  it('shows each open PR’s state in the list, and its events on the PR', async () => {
    const s = await statesRepo(null);
    await s.open('one', { 'a.txt': 'a\n' });
    await s.open('two', { 'b.txt': 'b\n' });
    await s.run(1, 'one', 'completed', 'failure');
    const list = (await (
      await call(s.t, '/api/repos/octocat/app/pulls', { cookie: s.admin })
    ).json()) as {
      pulls: { number: number; pullState: { state: string } | null }[];
    };
    expect(list.pulls.map((p) => [p.number, p.pullState?.state])).toEqual([
      [2, 'ready'],
      [1, 'agent_followup'],
    ]);
    const detail = (await (
      await call(s.t, '/api/repos/octocat/app/pulls/2', { cookie: s.admin })
    ).json()) as {
      pullState: { state: string; reasons: unknown[] };
      events: { kind: string; state: string; data: unknown }[];
    };
    expect(detail.pullState).toEqual({ state: 'ready', reasons: [] });
    expect(detail.events).toMatchObject([
      { kind: 'state_changed', state: 'ready', data: { reasons: [] } },
    ]);
  });

  it('filters by pull state, open PRs only, and rejects unknown values', async () => {
    const s = await statesRepo(null);
    await s.open('one', { 'a.txt': 'a\n' });
    await s.open('two', { 'b.txt': 'b\n' });
    await s.run(1, 'one', 'completed', 'failure');
    const numbers = async (q: string) =>
      (
        (await (
          await call(s.t, `/api/repos/octocat/app/pulls?state=${q}`, {
            cookie: s.admin,
          })
        ).json()) as {
          pulls: { number: number }[];
        }
      ).pulls.map((p) => p.number);
    expect(await numbers('agent_followup')).toEqual([1]);
    expect(await numbers('ready')).toEqual([2]);
    await call(s.t, '/api/repos/octocat/app/pulls/2', {
      cookie: s.admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    expect(await numbers('ready')).toEqual([]);
    expect(
      (
        await call(s.t, '/api/repos/octocat/app/pulls?state=sleepy', {
          cookie: s.admin,
        })
      ).status
    ).toBe(400);
  });

  it('labels tree nodes with their state', async () => {
    const s = await statesRepo(
      'checks:\n  require: none\nstacking:\n  enabled: true\n'
    );
    await s.open('one', { 'a.txt': 'a\n' });
    const tree = (await (
      await call(s.t, '/api/repos/octocat/app/pulls/tree', { cookie: s.admin })
    ).json()) as {
      targets: {
        nodes: { number: number; pullState: { state: string } | null }[];
      }[];
    };
    expect(tree.targets[0].nodes[0].pullState?.state).toBe('waiting'); // review still running
  });

  it('hides a private repository’s states', async () => {
    const s = await statesRepo(null);
    await s.open('one', { 'a.txt': 'a\n' });
    const bob = await addMember(s.t, s.admin, 'bob');
    expect(
      (
        await call(s.t, '/api/repos/octocat/app/pulls?state=ready', {
          cookie: bob,
        })
      ).status
    ).toBe(404);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn test worker/src/__tests__/pull-states.test.ts`
Expected: FAIL: no `pullState` in responses; `?state=agent_followup` is a 400.

- [ ] **Step 3: Shared schemas** in `worker/src/routers/schemas.ts` (append):

```ts
import { PULL_STATES, REASON_KINDS } from '../pulls/state';

/** One structured reason; its other fields depend on `kind` (snake_case, as agents read them). */
export const pullReasonSchema = z
  .object({ kind: z.enum(REASON_KINDS) })
  .catchall(z.unknown())
  .openapi('PullReason');

export const pullStateSchema = z
  .object({
    state: z.enum(PULL_STATES),
    reasons: z.array(pullReasonSchema),
  })
  .openapi('PullState');

export const prEventSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    /** state_changed: the state it changed to. */
    state: z.enum(PULL_STATES).nullable(),
    data: z.record(z.string(), z.unknown()).nullable(),
    actor: publicUserSchema.nullable(),
    createdAt: z.string(),
  })
  .openapi('PullEvent');
```

(Move the new `import` to the top of the file.)

- [ ] **Step 4: List route** in `worker/src/routers/pulls-router.ts`:
  - Imports: `pullStateSchema`, `prEventSchema` from `./schemas`; `PULL_STATES` from `../pulls/state`;
    `pullStates`, `pullStateFor` from `../pulls/signals`; `eventsFor` from `../pulls/events`.
  - Query: `query: z.object({ state: z.enum(['open', 'closed', ...PULL_STATES] as const).default('open') })`.
  - Row schema: add `/** Open PRs: whose move it is, and why. */ pullState: pullStateSchema.nullable(),`.
  - Handler: after `const { state } = c.req.valid('query');` add
    `const openList = state !== 'closed';` and
    `const byPullState = (PULL_STATES as readonly string[]).includes(state);`; in the rows query replace
    `state === 'open'` with `openList`; replace the two later `state === 'open'` checks (resolutions,
    reviews) with `openList`. After `const refs = …` and the existing lookups, add:

```ts
const states = openList
  ? await pullStates(
      db,
      c.get('git'),
      repo.id,
      rows.map((r) => r.pr),
      {
        refs,
      }
    )
  : new Map<string, PullState>();
const shown = byPullState
  ? rows.filter((r) => states.get(r.pr.id)?.state === state)
  : rows;
```

and in the response map over `shown` instead of `rows`, adding `pullState: states.get(r.pr.id) ?? null,` to each
row (import `type PullState` from `../pulls/state`).

- [ ] **Step 5: Detail route**: add to the response schema

```ts
        /** Whose move it is, and why; null unless the PR is open with both branches. */
        pullState: pullStateSchema.nullable(),
        /** GitOrange's timeline entries (state changes), oldest first. */
        events: z.array(prEventSchema),
```

In the handler, before `usersById`, load `const events = await eventsFor(db, pr.id);` and add
`...events.map((e) => e.actorId ?? '')` to the `usersById` ids; after `const stack = …` add
`const pullState = await pullStateFor(db, git, pr);`; in the JSON add:

```ts
      pullState,
      events: events.map((e) => ({
        id: e.id,
        kind: e.kind,
        state: e.state,
        data: e.data ?? null,
        actor: e.actorId ? (people.get(e.actorId) ?? ghost) : null,
        createdAt: e.createdAt.toISOString(),
      })),
```

- [ ] **Step 6: Tree route**: extend the node schema with `pullState: pullStateSchema.nullable()` and attach states:

```ts
pullsRouter.openapi(treeRoute, async (c) => {
  const db = c.get('db');
  const repo = c.get('repo');
  const view = await stackTreeView(db, c.get('git'), repo.id, {
    defaultBranch: repo.defaultBranch,
  });
  const open = view.targets.length
    ? await db
        .select()
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repositoryId, repo.id),
            eq(pullRequests.state, 'open')
          )
        )
        .all()
    : [];
  const states = await pullStates(db, c.get('git'), repo.id, open, {
    tree: view,
  });
  const idOf = new Map(open.map((p) => [p.number, p.id]));
  return c.json(
    {
      ...view,
      targets: view.targets.map((t) => ({
        ...t,
        nodes: t.nodes.map((n) => ({
          ...n,
          pullState: states.get(idOf.get(n.number) ?? '') ?? null,
        })),
      })),
    },
    200
  );
});
```

- [ ] **Step 7: Run the tests**

Run: `yarn test worker/src/__tests__/pull-states.test.ts worker/src/__tests__/repos-pulls.test.ts worker/src/__tests__/stacking.test.ts worker/src/__tests__/review.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add worker/src/routers/ worker/src/__tests__/pull-states.test.ts
git commit -m "API: pull request state on the list, PR and tree; filter by state; timeline events

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 7: MCP: `pull_state` and the `state` filter

**Files:**

- Modify: `worker/src/mcp/pull-tools.ts` (`listPullRequests`, `getPullRequest`)
- Test: `worker/src/__tests__/mcp.test.ts`

**Interfaces:**

- Consumes: `pullStates`, `pullStateFor` (Task 3), `PULL_STATES` (Task 1).
- Produces: `gitorange_list_pull_requests` accepts `state` in `open|closed|merged|all|agent_followup|human_review|waiting|ready`, and each row has `pull_state` (open PRs; null otherwise). `gitorange_get_pull_request` returns `pull_state` and `reasons` (`[]` when not open).

- [ ] **Step 1: Write the failing test**

In `worker/src/__tests__/mcp.test.ts`, inside `describe('MCP pull request tools', …)`, add:

```ts
it('says whose move it is, and lists what needs the agent', async () => {
  const { t, token, repo } = await repoWithBranch();
  await tool(t, token, 'gitorange_create_pull_request', {
    repository: 'octocat/app',
    head: 'feature',
    title: 'Add a',
  });
  const head = repo.refs.get('refs/heads/feature')!;
  await t.env.DB.prepare(
    `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title, status, conclusion, created_at)
       SELECT 'r1', id, 9, 'ci.yml', 'CI', 'pull_request', 'x', ?, 'x', 'completed', 'failure', 0 FROM repositories`
  )
    .bind(head)
    .run();
  const got = JSON.parse(
    (
      await tool(t, token, 'gitorange_get_pull_request', {
        repository: 'octocat/app',
        number: 1,
      })
    ).content[0].text
  );
  expect(got).toMatchObject({
    state: 'open',
    pull_state: 'agent_followup',
    reasons: [{ kind: 'check_failed', run_number: 9 }],
  });
  const mine = JSON.parse(
    (
      await tool(t, token, 'gitorange_list_pull_requests', {
        repository: 'octocat/app',
        state: 'agent_followup',
      })
    ).content[0].text
  );
  expect(mine).toMatchObject([
    { number: 1, state: 'open', pull_state: 'agent_followup' },
  ]);
  const ready = JSON.parse(
    (
      await tool(t, token, 'gitorange_list_pull_requests', {
        repository: 'octocat/app',
        state: 'ready',
      })
    ).content[0].text
  );
  expect(ready).toEqual([]);
  const bad = await tool(t, token, 'gitorange_list_pull_requests', {
    repository: 'octocat/app',
    state: 'sleepy',
  });
  expect(bad.isError).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test worker/src/__tests__/mcp.test.ts`
Expected: FAIL: `pull_state` missing; `state: 'agent_followup'` is refused.

- [ ] **Step 3: `gitorange_list_pull_requests`**. Import `PULL_STATES` from `../pulls/state` and `pullStates`,
      `pullStateFor` from `../pulls/signals`. Change the definition's description and `state` property:

```ts
    description:
      "List a repository's pull requests, most recently updated first: number, title, author, branches, " +
      'state, whose move it is (pull_state, for open ones), and web URL. Pass state "agent_followup" to find ' +
      'open pull requests waiting on their author or agent (failed checks, requested changes, conflicts); ' +
      '"human_review", "waiting" and "ready" work the same way. Use ' +
      'gitorange_get_pull_request for the reasons and details.',
```

```ts
        state: {
          type: 'string',
          enum: ['open', 'closed', 'merged', 'all', ...PULL_STATES],
          description:
            'Which pull requests to list. Defaults to "open". agent_followup, human_review, waiting and ready ' +
            'list open pull requests in that state.',
        },
```

Replace the handler body after `repoFor` with:

```ts
const { repo, fullName, git } = await repoFor(ctx, args);
const state = str(args, 'state') ?? 'open';
const byPullState = (PULL_STATES as readonly string[]).includes(state);
if (!['open', 'closed', 'merged', 'all'].includes(state) && !byPullState)
  throw new McpToolError(
    `state must be open, closed, merged, all, or one of ${PULL_STATES.join(', ')}.`
  );
const which = byPullState ? 'open' : state;
const query = ctx.db
  .select()
  .from(pullRequests)
  .where(
    which === 'all'
      ? eq(pullRequests.repositoryId, repo.id)
      : and(
          eq(pullRequests.repositoryId, repo.id),
          eq(pullRequests.state, which as PullRequest['state'])
        )
  )
  .orderBy(desc(pullRequests.updatedAt));
const fetched = byPullState ? await query.all() : await query.limit(50).all();
const states = fetched.some((r) => r.state === 'open')
  ? await pullStates(ctx.db, git, repo.id, fetched)
  : new Map();
const rows = (
  byPullState
    ? fetched.filter((r) => states.get(r.id)?.state === state)
    : fetched
).slice(0, 50);
const people = await usersById(
  ctx.db,
  rows.map((r) => r.authorId)
);
return {
  content: [
    json(
      rows.map((r) => ({
        number: r.number,
        title: r.title,
        author: people.get(r.authorId)?.username ?? null,
        base: r.baseRef,
        head: r.headRef,
        state: r.state,
        pull_state: states.get(r.id)?.state ?? null,
        merged_automatically: r.mergedAutomatically,
        updated_at: r.updatedAt.toISOString(),
        url: pullUrl(ctx, fullName, r.number),
      }))
    ),
  ],
};
```

- [ ] **Step 4: `gitorange_get_pull_request`**. Append to its description:

```ts
' "pull_state" says whose move it is: agent_followup (yours: push a fix for each reason), human_review (a ' +
  'person with merge permission), waiting (GitOrange: checks, review or AI conflict resolution are running), ' +
  'or ready; "reasons" lists why, as structured objects (e.g. check_failed with run_number for ' +
  'gitorange_get_run_logs).';
```

In the handler, after `const stack = …` add `const pullState = await pullStateFor(ctx.db, git, pr);` and in the
JSON, after `state: pr.state,`, add:

```ts
          pull_state: pullState?.state ?? null,
          reasons: pullState?.reasons ?? [],
```

- [ ] **Step 5: Run the tests**

Run: `yarn test worker/src/__tests__/mcp.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/src/mcp/pull-tools.ts worker/src/__tests__/mcp.test.ts
git commit -m "MCP: pull_state and reasons; list what needs the agent with state: agent_followup

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 8: Approvals lists `human_review` PRs

**Files:**

- Modify: `worker/src/review/inbox.ts` (`approvalsFor`), `worker/src/routers/approvals-router.ts` (`itemSchema`)
- Test: `worker/src/__tests__/pull-states.test.ts`

**Interfaces:**

- Consumes: `latestStates` (Task 4), `pullStateSchema` (Task 6).
- Produces: each Approvals item has `pullState: PullState | null` (the latest recorded state); open PRs whose recorded state is `human_review` are items even without flags or failures.

- [ ] **Step 1: Write the failing test**

Append to `worker/src/__tests__/pull-states.test.ts`:

```ts
describe('Approvals', () => {
  it('lists human_review PRs only to people who can merge', async () => {
    const s = await statesRepo(null);
    await s.open('one', { 'a.txt': 'a\n' });
    const pr = (await s.db.query.pullRequests.findFirst())!;
    await recordStates(
      s.db,
      [pr],
      new Map([
        [
          pr.id,
          { state: 'human_review', reasons: [{ kind: 'cycle', prs: [2] }] },
        ],
      ]),
      Date.now() + 60_000
    );
    const items = (await (
      await call(s.t, '/api/approvals', { cookie: s.admin })
    ).json()) as {
      pull: { number: number };
      pullState: { state: string; reasons: unknown[] } | null;
      flags: unknown[];
    }[];
    expect(items).toMatchObject([
      {
        pull: { number: 1 },
        flags: [],
        pullState: {
          state: 'human_review',
          reasons: [{ kind: 'cycle', prs: [2] }],
        },
      },
    ]);
    const bob = await addMember(s.t, s.admin, 'bob');
    expect(
      await (await call(s.t, '/api/approvals', { cookie: bob })).json()
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test worker/src/__tests__/pull-states.test.ts`
Expected: FAIL: the item isn't listed.

- [ ] **Step 3: `approvalsFor`** in `worker/src/review/inbox.ts`: import `latestStates` from `../pulls/events` and
      `type PullState` from `../pulls/state`. After `const resolutions = …`, add
      `const recorded = await latestStates(db, ids);`. Add `pullState: PullState | null` to the `Item` type. In the
      loop compute `const pullState = recorded.get(pr.id) ?? null;`, change the condition to
      `if (hasFlags || reviewFailed || resolutionFailed || pullState?.state === 'human_review')`, and push
      `{ pr, review, reviewFailed, resolutionFailed, pullState }`. In the output object add
      `pullState: i.pullState,`. Update the doc comment: "…and PRs whose state is Requires Human Review (from the
      latest recorded state)."

- [ ] **Step 4: Schema** in `worker/src/routers/approvals-router.ts`: import `pullStateSchema` from `./schemas` and
      add to `itemSchema`:

```ts
  /** The latest recorded state: human_review items may have no flag (e.g. a dependency cycle). */
  pullState: pullStateSchema.nullable(),
```

- [ ] **Step 5: Run the tests**

Run: `yarn test worker/src/__tests__/pull-states.test.ts worker/src/__tests__/review.test.ts`
Expected: PASS (the existing inbox tests still match: they use `toMatchObject`-style or now see `pullState`; if one
uses `toEqual` on a whole item, add `pullState: expect.anything()` or the recorded state it now carries).

- [ ] **Step 6: Commit**

```bash
git add worker/src/review/inbox.ts worker/src/routers/approvals-router.ts worker/src/__tests__/
git commit -m "Approvals: list pull requests that require human review

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 9: UI: state labels, filter, merge-box banner, timeline, tree, Approvals

**Files:**

- Create: `src/lib/pullState.ts`, `src/lib/pullState.test.ts`, `src/components/PullStateLabel.tsx`, `src/components/PullEvents.tsx`
- Modify: `src/lib/uiApi.ts`, `src/lib/approvals.ts`, `src/pages/Pulls.tsx`, `src/pages/PullView.tsx`, `src/components/StackTree.tsx`, `src/pages/Approvals.tsx`

**Interfaces:**

- Consumes: the API shapes from Tasks 6 and 8.
- Produces (`src/lib/uiApi.ts`): `PullStateName`, `PullReason = { kind: string; [k: string]: unknown }`, `PullState`, `PullEvent`; `Pull.pullState?`, `PullDetail.pullState`, `PullDetail.events`, tree node `pullState`, `ApprovalItem.pullState`; `api.pulls(o, n, state: 'open' | 'closed' | PullStateName)`.
- Produces (`src/lib/pullState.ts`): `STATE_LABEL`, `STATE_CLASS`, `reasonText(r: PullReason): string`, `blocking(r: PullReason): boolean`. Plan 2b adds cases to `reasonText` and event kinds to `PullEvents.tsx`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/pullState.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { blocking, reasonText, STATE_LABEL } from './pullState';

describe('pull state text', () => {
  it('names each state as the spec does', () => {
    expect(STATE_LABEL).toEqual({
      agent_followup: 'Ready for agent followup',
      human_review: 'Requires human review',
      waiting: 'Waiting for checks',
      ready: 'Ready',
    });
  });

  it('says each reason in a few words', () => {
    expect(
      reasonText({ kind: 'check_failed', run_number: 7, check: 'test' })
    ).toBe('the "test" check failed (run #7)');
    expect(reasonText({ kind: 'flags_pending', count: 2 })).toBe(
      '2 review flags await approval'
    );
    expect(
      reasonText({ kind: 'must_account_for', pr: 28, landed: false })
    ).toBe('must account for #28');
    expect(reasonText({ kind: 'stacked_on', pr: 28 })).toBe('stacked on #28');
    expect(reasonText({ kind: 'something_new' })).toBe('something new');
  });

  it('tells informational reasons apart', () => {
    expect(blocking({ kind: 'stacked_on', pr: 1 })).toBe(false);
    expect(blocking({ kind: 'must_account_for', pr: 1, landed: false })).toBe(
      false
    );
    expect(blocking({ kind: 'check_failed', run_number: 1, check: null })).toBe(
      true
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/lib/pullState.test.ts`
Expected: FAIL: cannot resolve `./pullState`.

- [ ] **Step 3: Types** in `src/lib/uiApi.ts`, after `export type Comment = …`:

```ts
export type PullStateName =
  'agent_followup' | 'human_review' | 'waiting' | 'ready';
/** A structured reason; fields other than kind depend on it (snake_case). */
export type PullReason = { kind: string; [key: string]: unknown };
export type PullState = { state: PullStateName; reasons: PullReason[] };
/** GitOrange's own timeline entry on a pull request. */
export type PullEvent = {
  id: string;
  kind: string;
  state: PullStateName | null;
  data: Record<string, unknown> | null;
  actor: User | null;
  createdAt: string;
};
```

Add `/** Pull request lists only (open): whose move it is. */ pullState?: PullState | null;` to `Pull`;
`pullState: PullState | null;` and `events: PullEvent[];` to `PullDetail`; `pullState: PullState | null;` to the
tree node type inside `StackTree` (`nodes: (StackNode & { …; pullState: PullState | null })[]`) and to
`ApprovalItem`. Change `api.pulls` to:

```ts
  pulls: (o: string, n: string, state: 'open' | 'closed' | PullStateName) =>
    apiFetch<{ pulls: Pull[]; openCount: number; closedCount: number }>(
      `${r(o, n)}/pulls?${q({ state })}`
    ),
```

- [ ] **Step 4: Create `src/lib/pullState.ts`**

```ts
import type { PullReason, PullStateName } from './uiApi';

export const STATE_LABEL: Record<PullStateName, string> = {
  agent_followup: 'Ready for agent followup',
  human_review: 'Requires human review',
  waiting: 'Waiting for checks',
  ready: 'Ready',
};

/** Primer Label modifiers per state. */
export const STATE_CLASS: Record<PullStateName, string> = {
  agent_followup: 'Label--attention',
  human_review: 'Label--severe',
  waiting: 'Label--secondary',
  ready: 'Label--success',
};

// must_account_for only informs until plan 2b can mark it accounted for.
const INFO = new Set(['stacked_on', 'waits_on', 'must_account_for']);
/** Whether a reason holds the PR in its state (others only inform). */
export const blocking = (r: PullReason) => !INFO.has(r.kind);

const n = (v: unknown) => Number(v);
const prs = (v: unknown) =>
  ((v as number[]) ?? []).map((x) => `#${x}`).join(', ');
const s = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;

/** A reason in a few words, for labels, banners and the timeline. */
export function reasonText(r: PullReason): string {
  switch (r.kind) {
    case 'check_failed':
      return `${r.check ? `the "${r.check}" check` : 'a check'} failed (run #${n(r.run_number)})`;
    case 'changes_requested':
      return `changes requested on ${s(n(r.flags), 'flag')}`;
    case 'conflicts_unresolved':
      return "conflicts AI couldn't resolve";
    case 'review_policy_invalid':
      return r.where === 'pull_request'
        ? "this pull request's .gitorange/review.yml is invalid"
        : '.gitorange/review.yml on the target branch is invalid';
    case 'must_account_for':
      return `must account for #${n(r.pr)}`;
    case 'review_failed':
      return 'the auto-merge review failed';
    case 'flags_pending':
      return `${s(n(r.count), 'review flag')} await${n(r.count) === 1 ? 's' : ''} approval`;
    case 'cycle':
      return `depends in a circle on ${prs(r.prs)}`;
    case 'checks_running':
      return r.check
        ? r.started
          ? `the "${r.check}" check is running`
          : `waiting for the "${r.check}" check`
        : r.started
          ? 'checks are running'
          : 'no checks have run yet';
    case 'review_running':
      return 'the auto-merge review is running';
    case 'resolution_running':
      return 'AI is resolving conflicts';
    case 'stack_checking':
      return (r.prs as number[] | undefined)?.length
        ? `checking against ${prs(r.prs)}`
        : 'checking how it relates to other open pull requests';
    case 'stacked_on':
      return `stacked on #${n(r.pr)}`;
    case 'waits_on':
      return `waits on #${n(r.pr)}`;
    default:
      return r.kind.replace(/_/g, ' ');
  }
}
```

(`flags_pending` with count 2 reads "2 review flags await approval"; with 1, "1 review flag awaits approval".)

- [ ] **Step 5: Run it to verify it passes**

Run: `yarn test src/lib/pullState.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Create `src/components/PullStateLabel.tsx`**

```tsx
import type { PullState } from '@/lib/uiApi';
import {
  blocking,
  reasonText,
  STATE_CLASS,
  STATE_LABEL,
} from '@/lib/pullState';

/** The state as a Primer Label; the title lists the reasons. */
export function PullStateLabel({
  state,
}: {
  state: PullState | null | undefined;
}) {
  if (!state) return null;
  const why = state.reasons.map(reasonText).join('; ');
  const stacked = state.reasons.find((r) => r.kind === 'stacked_on');
  return (
    <span
      className={`Label ${STATE_CLASS[state.state]} v-align-middle`}
      title={why || undefined}
    >
      {STATE_LABEL[state.state]}
      {state.state === 'ready' && stacked
        ? `, stacked on #${Number(stacked.pr)}`
        : ''}
    </span>
  );
}

/** Reasons as a short list, most urgent first (the merge box and Approvals). */
export function PullStateReasons({ state }: { state: PullState }) {
  const shown = state.reasons.filter(blocking);
  if (!shown.length) return null;
  return (
    <ul className="ml-3 f6">
      {shown.map((r, i) => (
        <li key={i}>{reasonText(r)}</li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 7: Create `src/components/PullEvents.tsx`** (2b adds kinds here)

```tsx
import { DotFillIcon } from '@primer/octicons-react';
import type { PullEvent, PullReason } from '@/lib/uiApi';
import { blocking, reasonText } from '@/lib/pullState';
import { timeAgo } from '@/lib/format';
import { PullStateLabel } from './PullStateLabel';

/** One GitOrange timeline entry, inside the page's TimelineItem layout. */
export function PullEventItem({ e }: { e: PullEvent }) {
  if (e.kind === 'state_changed' && e.state) {
    const reasons = ((e.data?.reasons as PullReason[]) ?? []).filter(blocking);
    return (
      <div className="TimelineItem ml-md-4 pl-md-3" style={{ marginLeft: 0 }}>
        <div className="TimelineItem-badge">
          <DotFillIcon />
        </div>
        <div
          className="TimelineItem-body f6 d-flex flex-items-center flex-wrap"
          style={{ gap: 4 }}
        >
          <PullStateLabel state={{ state: e.state, reasons: [] }} />
          {reasons.length > 0 && (
            <span>{reasons.map(reasonText).join('; ')}</span>
          )}
          <span className="color-fg-muted">{timeAgo(e.createdAt)}</span>
        </div>
      </div>
    );
  }
  return null;
}
```

- [ ] **Step 8: Pulls list** (`src/pages/Pulls.tsx`): read the filter and show labels.
  - Replace the `state` line with:

```tsx
const raw = params.get('state');
const filters = ['agent_followup', 'human_review', 'waiting', 'ready'] as const;
const pullFilter = filters.find((f) => f === raw) ?? null;
const state = raw === 'closed' ? 'closed' : (pullFilter ?? 'open');
const openish = state !== 'closed';
```

- Use `openish` where the file checks `state === 'open'` for the view toggle and the empty-state copy; render
  the tree only when `state === 'open'` (no filter).
- After the List/Tree `BtnGroup`, inside the same `{openish && …}` area, add a filter:

```tsx
<select
  className="form-select select-sm"
  aria-label="Filter by state"
  value={pullFilter ?? ''}
  onChange={(e) => setParams(e.target.value ? { state: e.target.value } : {})}
>
  <option value="">All open</option>
  {filters.map((f) => (
    <option key={f} value={f}>
      {STATE_LABEL[f]}
    </option>
  ))}
</select>
```

- In each row, after `<AiResolutionBadge state={p.aiResolution} />`, add
  `{' '}<PullStateLabel state={p.pullState} />`.
- Imports: `PullStateLabel` from `@/components/PullStateLabel`, `STATE_LABEL` from `@/lib/pullState`.

- [ ] **Step 9: Tree nodes** (`src/components/StackTree.tsx`): after the node's title `Link`, add
      `{' '}<PullStateLabel state={node.pullState} />`, and remove the now-redundant `checking…` chip
      (`node.checking` is a `stack_checking` reason on the label). Keep the `checking #N…` and dependency chips.

- [ ] **Step 10: Merge box and timeline** (`src/pages/PullView.tsx`):
  - In `MergeBox`, as the first child of the `Box` (before the conflicts `Box-row`), add:

```tsx
{
  d.pullState && d.pullState.state !== 'ready' && (
    <div className="Box-row">
      <div className="d-flex flex-items-center mb-1" style={{ gap: 8 }}>
        <PullStateLabel state={d.pullState} />
      </div>
      <PullStateReasons state={d.pullState} />
    </div>
  );
}
```

- In `Conversation`, bucket events between comments by time and render them:

```tsx
// GitOrange's events between the comments they happened between.
const slots: PullEvent[][] = Array.from(
  { length: d.comments.length + 1 },
  () => []
);
for (const e of d.events) {
  const i = d.comments.findIndex((c) => c.createdAt > e.createdAt);
  slots[i < 0 ? d.comments.length : i].push(e);
}
```

    Inside the comments map, before the `reviewAt === i` line, add
    `{slots[i].map((e) => <PullEventItem key={e.id} e={e} />)}`; after the map (before the trailing
    `reviewAt === d.comments.length` line) add
    `{slots[d.comments.length].map((e) => <PullEventItem key={e.id} e={e} />)}`.

- Imports: `PullStateLabel`, `PullStateReasons` from `@/components/PullStateLabel`, `PullEventItem` from
  `@/components/PullEvents`, `type PullEvent` from `@/lib/uiApi`.

- [ ] **Step 11: Approvals** (`src/pages/Approvals.tsx` and `src/lib/approvals.ts`):
  - In `Item`, before `item.reviewFailed`, add:

```tsx
{
  item.pullState?.state === 'human_review' &&
    !item.flags.length &&
    !item.reviewFailed &&
    !item.resolutionFailed && (
      <div className="flash flash-warn mb-2">
        <PullStateLabel state={item.pullState} />
        <PullStateReasons state={item.pullState} />
        <Link to={prUrl} className="btn btn-sm mt-2">
          Decide on the pull request
        </Link>
      </div>
    );
}
```

- In `approvalCount`, add
  `+ (i.pullState?.state === 'human_review' && !i.flags.length && !i.reviewFailed && !i.resolutionFailed ? 1 : 0)`
  and update its doc comment to mention human review.
- Update the blankslate copy: "Flags from auto-merge reviews, failed reviews, conflicts AI couldn't resolve, and
  pull requests that need a person's decision show up here."

- [ ] **Step 12: Typecheck and test**

Run: `yarn typecheck && yarn test src/lib/pullState.test.ts src/lib/stackTree.test.ts`
Expected: clean; PASS.

- [ ] **Step 13: See it in the browser.** Run `yarn dev`, open a repository with two open pull requests (one with a
      failing Actions run, if you can make one fail) and check: each list row shows a state label whose tooltip lists
      the reasons; the **Filter by state** select narrows the list and survives reload (it's in the URL); the merge box
      shows the banner with reasons for a non-ready PR; the timeline shows "Ready for agent followup · a check failed
      (run #N)" entries between comments; tree nodes (stacking on) carry the label; at 375px wide nothing scrolls
      horizontally. If Actions can't run in your dev environment, a PR waiting on its review still shows "Waiting for
      checks"; say so in the PR description.

- [ ] **Step 14: Commit**

```bash
git add src/
git commit -m "Pull requests: state labels and filter, merge-box reasons, timeline, tree and Approvals

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 10: Docs and final verification

**Files:**

- Modify: `docs/auto-merge.md`, `docs/architecture.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: `docs/auto-merge.md`.** Add a `## Pull request states` section before `## Stacking`: the four
      states and who acts (table from the spec), priority, the reason kinds with one line each (as in Deviations 1),
      that `must_account_for` is reported but doesn't change the state until milestone 2b, the checks rule with and
      without review.yml, that states exist for every open PR (stack reasons only with
      stacking on), the `?state=` filter and `gitorange_list_pull_requests` with `state: "agent_followup"`, and that
      state changes appear on the timeline.

- [ ] **Step 2: `docs/architecture.md`.** Add a "Pull request states" subsection: `worker/src/pulls/state.ts`
      (rules), `signals.ts` (`pullStates`, batch queries), `events.ts`/`settle.ts` (`pr_events`, conditional insert,
      where `settleStates` is called).

- [ ] **Step 3: `README.md`.** In Features, after the Stack tree bullet:

```markdown
- **Pull request states** — every open pull request says whose move it is: _Ready for agent followup_, _Requires human review_, _Waiting for checks_, or _Ready_, with structured reasons. Agents ask "what needs me?" with `gitorange_list_pull_requests` and `state: "agent_followup"`.
```

- [ ] **Step 4: `CLAUDE.md`.** Add one Architecture note bullet:

```markdown
- PR states (`worker/src/pulls/`): `pullState` = `{ state, reasons[] }` computed on read, never stored: `state.ts`
  (reasons → `agent_followup` > `human_review` > `waiting` > `ready`; add reason kinds only there), `signals.ts`
  (`pullStates`, batched per repository), `settle.ts` (`settleStates` records changes as `pr_events` rows with one
  conditional insert; called where pings happen and at the end of MERGE_RESOLUTION and Actions runs, never per step).
```

- [ ] **Step 5: Full verification**

Run: `yarn format && yarn typecheck && yarn test`
Expected: formatting applied, typecheck clean, all tests pass. Paste the final test summary line into the PR
description.

- [ ] **Step 6: Commit**

```bash
git add -A docs README.md CLAUDE.md
git commit -m "Docs: pull request states (milestone 2a)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

- [ ] **Step 7: Continue with plan 2b** (`docs/superpowers/plans/2026-10-04-stack-tree-m2b-retarget.md`) on the
      same branch. Open the PR only after both plans are done and the user asks: push `stack-tree-m2` to `origin`,
      open it with the `gitorange_create_pull_request` MCP tool (`choyiny/gitorange`, base `stack-tree` while #36 is
      open, else `main`), and follow it with `gitorange_get_pull_request`. Never push to the `github` remote.
