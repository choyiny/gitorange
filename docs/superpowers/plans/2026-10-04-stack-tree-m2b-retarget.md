# Stack Tree — Milestone 2b (Retarget, Linearize, Block) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discovered dependencies start to act: a dependent PR is retargeted (metadata only) onto the PR it builds
on, several prerequisites are put in one line with `ordered_after` edges, `must_account_for` blocks landing until a
re-check of the dependent's new head says it was done, and maintainers can unstack or dismiss. Every reader that
means "where this lands" uses the new `land_target`.

**Architecture:** `pull_requests.land_target` holds where a PR finally lands; `base_ref` becomes "what the diff is
against" and may be a parent PR's head branch. After discovery saves a PR's pairs, a **reconcile** pass (inline in
the stack run, or its own `reconcile` MERGE_RESOLUTION run after a close or land) prunes stale ordering edges,
linearizes several prerequisites (existing relationship > one Clef choice call > closer to Ready, then lower
number), rebuilds the tree, and retargets `base_ref` with compare-and-swap, recording timeline events. A
`stackGate` derived from the tree blocks `landPull` (button, MCP, auto-merge) on unaccounted `must_account_for`,
an open parent, or open waits-on, and holds auto-merge while discovery is still checking. A reasoning-model
re-check of the dependent's new head sets `accounted_for_at`. Plan 2a's state rules gain `rebase_onto` in one
place.

**Tech Stack:** Cloudflare Workers, Hono + Zod OpenAPI (zod v4), Drizzle/D1 (drizzle-kit migrations), Workers AI
(Clef + the reasoning model through AI Gateway), Cloudflare Workflows, React + TanStack Query + Primer CSS, Vitest
(`@cloudflare/vitest-pool-workers`).

**Spec:** `docs/superpowers/specs/2026-10-04-stack-tree-design.md` (section 2 "Building the tree", including
"Linearizing several prerequisites" and "Things that change because `base_ref` can be a PR branch"; section 4's
PR-page and Approvals items; the milestone 2 line and its carried-over items). Runs after plan 2a
(`docs/superpowers/plans/2026-10-04-stack-tree-m2a-states.md`), whose `worker/src/pulls/` modules, `pr_events`
table and UI pieces it extends.

## Global Constraints

- GitOrange never pushes to or force-pushes anyone's branch: retargeting changes `base_ref` metadata only.
- `land_target` (new **nullable** column, no backfill) is where a PR lands; every reader goes through one helper, `landTargetOf(pr)` = `land_target ?? base_ref` (and `landTargetIs(branch)` for SQL filters), and code sets `land_target` explicitly on PR create and whenever it retargets. `base_ref` stays what the diff and the "into" label show.
- Readers that mean "where this lands" use the land target: `readPolicy` (auto-merge and stacking), Actions `pull_request` branch filters, `autoMergeStatus`'s merge plan and the AI conflict sweep, `landPull`, the stack tree and discovery, list review/resolution state, PR states.
- Model routing: Clef decides, the reasoning model explains. The linearize order is one Clef choice question; its answer stands only at or above review.yml's `stacking.confident_above`; otherwise closer to **Ready** first, then the lower number. An existing relationship (builds on, conflicts) always wins.
- An ordering edge is re-decided only when one of its three PRs gets a new head, closes or lands; ordering never creates a cycle (the dependent then waits on both).
- `must_account_for` blocks until `accounted_for_at` is set by a re-check (reasoning model, defensive parsing) of the dependent's new head. Landed parents never retarget; their `must_account_for` only blocks.
- Maintainer controls (Unstack, Dismiss) need merge permission and exist only in the web UI (never MCP), like review flags.
- No model call in a request: linearizing runs only in Workflow steps; requests do only the model-free part of unwinding.
- Stacking stays opt-in (`stacking.enabled` in the land target's review.yml); off ⇒ no retargeting, no stack blocking.
- Always `yarn`. Never hand-write migrations: change `worker/src/db/app.schema.ts`, run `yarn db:generate`, review the SQL. No hand-written migration of any kind (no data backfill): the generated migration only adds columns, indexes and the changed unique index.
- Never mock `env.DB`; real D1 plus the Artifacts fake and fake models.
- Definition of done: `yarn test` passes, `yarn typecheck` clean, `yarn format` run.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9
  ```

## Deviations and decisions (made while planning; Task 0 records them in the spec)

1. **Ordering edges live in `pr_edges` with a `slot` column.** `pr_edges` is unique per unordered pair, so an
   ordering edge between #28 and #29 would collide with their discovery verdict. A new `slot` (`pair` | `order`)
   joins the unique index; ordering rows are `slot = 'order'`, `kind = 'ordered_after'`, `prerequisite` = the side
   that lands first, `for_pr_id` = the PR that needed it, and `a_head`/`b_head`/`for_head` record the three heads
   it was decided at.
2. **No backfill.** `land_target` is nullable. Existing rows keep `NULL`, which means "lands into `base_ref`"
   (true for every PR opened before stacking could retarget). Every reader uses `landTargetOf(pr)`
   (`land_target ?? base_ref`) from `worker/src/lib/land-target.ts`, and SQL filters use `landTargetIs(branch)`
   (`COALESCE(land_target, base_ref) = branch`), both in that one small module rather than `worker/src/lib/pulls.ts`,
   which imports Actions, merging and review and would create import cycles with the readers. `openPull` sets
   `land_target`, and every retarget (reconcile, closed/landed parent, Unstack/Dismiss) writes it explicitly
   alongside `base_ref`.
3. **Which readers switch.** Policy, ignore file, Actions filter (and the `base_ref` in the Actions context and
   the changed paths for `paths:` filters), merge plan, conflict sweep and resolutions, landing, stack tree and
   discovery, list review and AI-resolution state, PR states: land target. Diff, commits, "into" label, the review's
   per-file summaries (a stacked PR is reviewed on its own changes, from `base_ref`): `base_ref`. The spec's "PR
   list's base filter" doesn't exist in the code; the equivalent readers are the tree grouping and discovery's
   candidate query.
4. **Linearize only stackable prerequisites** (`builds_on`, `must_account_for`). A `conflicts` prerequisite only
   needs ordering, not stacking, and can't sit on a stacking chain; it stays waits-on. `ordered_after` is itself
   stackable (weaker than `builds_on`), which is what puts #29 on #28. A PR's parent must be a stackable
   prerequisite whose ancestor chain contains every other stackable prerequisite; with none, it has no parent and
   waits on all (this changes milestone 1's "strongest wins" for unlinearized pairs). Prerequisites already on the
   parent's chain aren't listed again as waits-on.
5. **Re-check.** When only the dependent's head moved since a `must_account_for` verdict, discovery runs a
   dedicated re-check (reasoning model, usage feature `stack-explain`) instead of re-deciding. If the prerequisite
   moved too, the pair is re-decided; if it had been accounted for and is still `must_account_for`, the re-check
   runs right away. A failed re-check keeps blocking (stage `done`, `error_message` set; never `failed`, which
   would stop blocking) and the existing **Retry** re-runs it.
6. **Dismissals stick** across head moves (the claim never clears `dismissed_at`) until either PR closes or
   lands. Unstack = dismiss the parent edge + retarget to the land target.
7. **Closed parent.** Pair rows of a closed PR are kept (the tree already ignores closed PRs) so a reopen restores
   them without a new discovery run; ordering edges involving it are deleted. Its children retarget to the land
   target in the request, then a `reconcile` run restacks them.
8. **Blocking.** `landPull` (merge button, MCP merge, auto-merge) refuses on unaccounted, undismissed
   `must_account_for` (open or landed), an open parent, or open waits-on, naming each; until milestone 3's queue,
   a stacked PR lands once its parent has. "Discovery still checking" holds only auto-merge (carried-over fix).
9. **Promoting `must_account_for`.** Plan 2a reports it as informational (nothing could mark it accounted for).
   Task 9 makes it drive `agent_followup`, in `reasonState` in `worker/src/pulls/state.ts`, only while the edge is
   neither accounted for nor dismissed. **`rebase_onto`** is computed on read: a PR whose head doesn't contain its open parent's head, provided the
   parent itself needs no rebase (so #31 is told only once #29 contains #28). Containment is `mergeBase` memoized per
   isolate by commit pair (commit graphs never change), only for PRs with an open parent.
10. **Stacking turned off** on a target: the next reconcile there (any close or land) unstacks its PRs.
11. **Timeline kinds** added to `pr_events`: `stacked`, `unstacked`, `ordered`, `must_account_for` (the
    instructions, with "rebase onto `<branch>` first" when the prerequisite is open), `accounted_for`, `dismissed`.
12. **Carried over.** Discovery now starts before the review's `auto-merge` step, the stack run ends with its own
    `auto-merge` step, and auto-merge waits while the PR's head is still being checked. The claim race is fixed: a
    run deletes a reverse-oriented pair row only when its own orientation is the landed one, and otherwise skips
    the pair (the reverse row exists only because the other side landed after this run loaded).
13. **Approvals** also lists `must_account_for` blocks with no change for 24 hours and pairs that failed to check
    (spec section 4).

## Review Focus

1. **A parent whose head branch was deleted while children are stacked on it**: never stack onto a branch that
   doesn't exist; children go back to the land target. → Task 8 test "never stacks onto a branch that no longer
   exists".
2. **Two reconciles finishing at once** (two stack runs): `base_ref` changes once, one event. → Task 8 test
   "retargets once when reconciles repeat or race".
3. **Clef down or unsure on an order**: falls back to closer-to-Ready then lower number; the reconcile never fails.
   → Task 8 tests "falls back when Clef is unsure: closer to Ready first" and "falls back when Clef fails: equally
   close to Ready, the lower number first".
4. **A dismissed edge after the dependent pushes again**: stays dismissed, so the PR isn't re-blocked or restacked.
   → Task 10 test "keeps a dismissal when a head moves".
5. **A landed prerequisite with `must_account_for`**: blocks until accounted for, never retargets. → Task 6 test
   "blocks on a landed prerequisite without retargeting".

---

## File Structure

**Create**

- `worker/src/lib/land-target.ts`: `landTargetOf`, `landTargetIs`, `landShas` (the one helper for every land-target reader).
- `worker/src/stack/gate.ts`: `gateFor`, `stackGate` (what holds a PR back).
- `worker/src/stack/linearize.ts`: pure-with-callback `linearize`.
- `worker/src/stack/reconcile.ts`: `executeReconcile` (prune, linearize, retarget).
- `worker/src/stack/retarget.ts`: `onPullClosed`, `startReconcile`, `dismissEdge`.
- `worker/src/stack/contains.ts`: memoized `contains`.
- `worker/src/__tests__/land-target.test.ts`.

**Modify**

- `worker/src/db/app.schema.ts` (+ the migration `yarn db:generate` produces).
- Land-target readers: `worker/src/review/{auto-merge,list,view,classify}.ts`, `worker/src/merge/{auto,resolution,land}.ts`, `worker/src/actions/trigger.ts`, `worker/src/stack/{view,discover}.ts`, `worker/src/pulls/signals.ts`, `worker/src/lib/pulls.ts`, `worker/src/routers/pulls-router.ts`, `worker/src/mcp/pull-tools.ts`.
- `worker/src/stack/{tree,models,discover}.ts`, `worker/src/merge/workflow.ts`, `worker/src/pulls/{state,signals,events,settle}.ts`, `worker/src/review/inbox.ts`, `worker/src/routers/approvals-router.ts`.
- Tests: `worker/src/__tests__/{stacking,stack-tree,pull-states,mcp}.test.ts`.
- UI: `src/lib/uiApi.ts`, `src/lib/pullState.ts`, `src/lib/approvals.ts`, `src/components/{StackSidebar,StackTree,PullEvents}.tsx`, `src/pages/Approvals.tsx`.
- Docs: `docs/auto-merge.md`, `docs/architecture.md`, `README.md`, `CLAUDE.md`, the spec.

---

### Task 0: Spec alignment

**Files:**

- Modify: `docs/superpowers/specs/2026-10-04-stack-tree-design.md`

- [ ] **Step 1: Confirm the branch and that plan 2a is done**

Run: `git -C /Users/choyiny/workspace/gitorange branch --show-current && ls /Users/choyiny/workspace/gitorange/worker/src/pulls/`
Expected: `stack-tree-m2`, and `events.ts settle.ts signals.ts state.ts`.

- [ ] **Step 2: Update section 2.** At the end of "### Linearizing several prerequisites", add:

```markdown
**Decided while planning (milestone 2b).** Ordering edges are `pr_edges` rows with `slot = 'order'` (the table's
uniqueness is per pair and slot), recording the three heads they were decided at. Only stackable prerequisites
(`builds_on`, `must_account_for`) are linearized; a `conflicts` prerequisite stays waits-on. A parent must be a
stackable prerequisite whose chain contains the other stackable ones; otherwise the PR has no parent and waits on
all. When only a dependent's head moves, a `must_account_for` pair is re-checked instead of re-decided; a failed
re-check keeps blocking. Dismissals survive head moves. A closed parent's pair rows are kept (ignored while it is
closed); its ordering edges are deleted and its children go back to the land target at once, then a reconcile run
restacks them. Landing (button, MCP, auto-merge) is refused on an unaccounted must-account-for, an open parent or
open waits-on, naming each.
```

In "### Things that change because `base_ref` can be a PR branch", replace the bullet "The PR list's base filter
and the Approvals inbox." with: "The stack tree's grouping and discovery's candidates (the list has no base filter;
the Approvals inbox never read `base_ref`)." and add after the list: "A stacked PR's auto-merge review still
summarizes its own changes (from `base_ref`), under the land target's review.yml. `land_target` is nullable (no
backfill); a null value means `base_ref`, and every retarget writes `land_target` explicitly."

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-04-stack-tree-design.md
git commit -m "Spec: retarget, linearize and block decisions from planning milestone 2b

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 1: Schema: nullable `land_target`, edge columns, event kinds

**Files:**

- Modify: `worker/src/db/app.schema.ts` (`pullRequests`, `EdgeKind`, `EdgeStage`, `prEdges`, `prEvents`)
- Create: `worker/src/lib/land-target.ts`
- Modify: `worker/src/lib/pulls.ts` (`openPull` insert)
- Generated: `migrations/00NN_*.sql`, `migrations/meta/*` (by `yarn db:generate` only)
- Test: `worker/src/__tests__/land-target.test.ts` (create)

**Interfaces:**

- Produces:
  - `pullRequests.landTarget` (`land_target`, nullable; `NULL` means `base_ref`).
  - `EdgeKind` adds `'ordered_after'`; `EdgeStage` adds `'recheck'`.
  - `prEdges` adds `slot: 'pair' | 'order'` (default `pair`), `forPrId`, `forHead`, `accountedForAt`, `accountedHead`, `dismissedAt`, `dismissedById`; unique index `pr_edges_pair_uq` on `(pr_a_id, pr_b_id, slot)`.
  - `PrEventKind = 'state_changed' | 'stacked' | 'unstacked' | 'ordered' | 'must_account_for' | 'accounted_for' | 'dismissed'`.
  - `landTargetOf(pr: Pick<PullRequest, 'landTarget' | 'baseRef'>): string` (`land_target ?? base_ref`).
  - `landTargetIs(branch: string): SQL` (`COALESCE(land_target, base_ref) = branch`, for `where` clauses).
  - `landShas(git: GitService, pr: Pick<PullRequest, 'landTarget' | 'baseRef' | 'headRef'>): Promise<{ base: string; head: string } | null>` (land target tip and head tip).

- [ ] **Step 1: Write the failing test**

Create `worker/src/__tests__/land-target.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { landTargetOf } from '../lib/land-target';
import { bootstrapAdmin, call, makeEnv, settle } from './helpers/app';
import { commitPaths } from './helpers/seed';

describe('land target', () => {
  it('is the base a pull request was opened against', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'internal' },
    });
    const repo = [...t.fake.repos.values()][0];
    const main = await commitPaths(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    repo.refs.set('refs/heads/feature', main);
    await commitPaths(repo, 'feature', { 'a.txt': 'b\n' }, 'Change');
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Change', body: '', base: 'main', head: 'feature' },
    });
    await settle(t);
    expect(
      await t.env.DB.prepare(
        'SELECT base_ref AS baseRef, land_target AS landTarget FROM pull_requests'
      ).first()
    ).toEqual({ baseRef: 'main', landTarget: 'main' });
  });

  it('falls back to base_ref for rows written before the column (null)', () => {
    expect(landTargetOf({ landTarget: null, baseRef: 'main' })).toBe('main');
    expect(landTargetOf({ landTarget: 'main', baseRef: 'parent' })).toBe(
      'main'
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test worker/src/__tests__/land-target.test.ts`
Expected: FAIL: cannot resolve `../lib/land-target`.

- [ ] **Step 3: Change the schema** in `worker/src/db/app.schema.ts`.
  - In `pullRequests`, after `headRef`:

```ts
    // Where it finally lands. base_ref is what the diff is against and may be a parent PR's head branch when
    // stacked; readers that mean "where this lands" use landTargetOf (worker/src/lib/land-target.ts).
    // NULL (every row from before this column): lands into base_ref. Set on create and on every retarget.
    landTarget: text('land_target'),
```

    and add to its indexes `index('pull_requests_repo_target_idx').on(t.repositoryId, t.landTarget, t.state),`.

- `EdgeKind`: `'builds_on' | 'must_account_for' | 'conflicts' | 'independent' | 'ordered_after'`;
  `EdgeStage`: `'triage' | 'deep' | 'recheck' | 'done' | 'failed'`; mirror both in the `stage` and `kind`
  column enums.
- In `prEdges`, after `prBId`:

```ts
    // pair: one discovery verdict per unordered pair. order: an ordering edge (kind ordered_after) added so
    // `for_pr_id` can stack on several prerequisites; decided at a_head, b_head and for_head.
    slot: text('slot', { enum: ['pair', 'order'] }).notNull().default('pair'),
    forPrId: text('for_pr_id').references(() => pullRequests.id, {
      onDelete: 'cascade',
    }),
    forHead: text('for_head'),
```

    and after `instructions`:

```ts
    // must_account_for: set when a re-check of the dependent's head (accounted_head) found it accounted for.
    accountedForAt: integer('accounted_for_at', { mode: 'timestamp' }),
    accountedHead: text('accounted_head'),
    // A maintainer dismissed it (Dismiss, or Unstack for a parent): it neither stacks nor blocks. Survives head
    // moves.
    dismissedAt: integer('dismissed_at', { mode: 'timestamp' }),
    dismissedById: text('dismissed_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
```

    and change the unique index to `uniqueIndex('pr_edges_pair_uq').on(t.prAId, t.prBId, t.slot),`. Update the
    table's doc comment: "One `pair` row per unordered pair (`a` is the lower number, or the landed one), plus
    `order` rows for ordering edges."

- `prEvents.kind` enum and `PrEventKind`:
  `['state_changed', 'stacked', 'unstacked', 'ordered', 'must_account_for', 'accounted_for', 'dismissed']`.

- [ ] **Step 4: Generate and review the schema migration**

Run: `yarn db:generate`
Expected: one new migration adding `land_target` to `pull_requests` (nullable, no default) and its index, the new
`pr_edges` columns, and dropping/recreating `pr_edges_pair_uq` on `(pr_a_id, pr_b_id, slot)`. drizzle-kit may
rebuild `pr_edges` through a `__new_pr_edges` copy because of the new foreign keys; that's fine as long as every
existing column is copied. Nothing else may change, and nothing in it is edited by hand (no `UPDATE`).

- [ ] **Step 5: Create `worker/src/lib/land-target.ts`**

```ts
import { sql, type SQL } from 'drizzle-orm';
import { pullRequests, type PullRequest } from '../db/app.schema';
import type { GitService } from '../git/service';

/**
 * Where a pull request finally lands; base_ref may be a parent PR's head branch while it is stacked. NULL (rows
 * from before the column) means base_ref. The one helper every "where this lands" reader uses.
 */
export function landTargetOf(
  pr: Pick<PullRequest, 'landTarget' | 'baseRef'>
): string {
  return pr.landTarget ?? pr.baseRef;
}

/** `landTargetOf(pr) = branch`, for SQL filters on pull_requests. */
export function landTargetIs(branch: string): SQL {
  return sql`COALESCE(${pullRequests.landTarget}, ${pullRequests.baseRef}) = ${branch}`;
}

/** The commits that decide merging an open PR: its land target's tip and its head's. */
export async function landShas(
  git: GitService,
  pr: Pick<PullRequest, 'landTarget' | 'baseRef' | 'headRef'>
): Promise<{ base: string; head: string } | null> {
  const [base, head] = await Promise.all([
    git.resolve(landTargetOf(pr)),
    git.resolve(pr.headRef),
  ]);
  return base && head ? { base, head } : null;
}
```

- [ ] **Step 6: Set it when opening** in `openPull` (`worker/src/lib/pulls.ts`): in the
      `db.insert(pullRequests).values({ … })`, after `baseRef: base,` add `landTarget: base,`.

- [ ] **Step 7: Run the tests**

Run: `yarn test worker/src/__tests__/land-target.test.ts worker/src/__tests__/stacking.test.ts worker/src/__tests__/stack-tree.test.ts && yarn typecheck`
Expected: PASS; typecheck may flag exhaustive `Record<EdgeKind, …>` maps: add `ordered_after: 'lands after'` to
`KIND` in `src/components/StackTree.tsx` and `'ordered_after'` to `StackDependency['kind']` in `src/lib/uiApi.ts`
and to `dependencySchema`'s enum in `worker/src/routers/pulls-router.ts`.

- [ ] **Step 8: Commit**

```bash
git add worker/src/db/app.schema.ts migrations/ worker/src/lib/land-target.ts worker/src/lib/pulls.ts worker/src/__tests__/land-target.test.ts src/ worker/src/routers/pulls-router.ts
git commit -m "Schema: nullable land_target, ordering and accounting columns on pr_edges, stack events

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 2: Every "where this lands" reader uses the land target

**Files:**

- Modify: `worker/src/review/auto-merge.ts`, `worker/src/review/list.ts`, `worker/src/review/view.ts`, `worker/src/review/classify.ts`, `worker/src/merge/auto.ts`, `worker/src/merge/resolution.ts`, `worker/src/merge/land.ts`, `worker/src/actions/trigger.ts`, `worker/src/stack/view.ts`, `worker/src/stack/discover.ts`, `worker/src/pulls/signals.ts`, `worker/src/routers/pulls-router.ts`, `worker/src/mcp/pull-tools.ts`
- Test: `worker/src/__tests__/land-target.test.ts`

**Interfaces:**

- Consumes: `landTargetOf`, `landTargetIs`, `landShas` (Task 1). No reader touches `pr.landTarget` or `pullRequests.landTarget` directly; after this task `grep -rn landTarget worker/src` shows only the helper, the schema and writes.
- Produces: the REST pull object gains `landTarget: string`; MCP `gitorange_get_pull_request` gains `land_target`; `ensureStacking`, `retryFailedPairs`, `ensureResolution`, `ensureClassification`, `startResolution` keep their signatures but every caller now passes land-target shas.

- [ ] **Step 1: Write the failing tests** (one per reader group). Append to
      `worker/src/__tests__/land-target.test.ts` (merge imports):

```ts
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import type { StepRunner } from '../merge/resolution';
import { executeSweep } from '../merge/auto';
import { onRefsUpdated } from '../actions/trigger';
import { findRepoById, gitFor } from '../lib/repos';
import { readPolicy } from '../review/policy';

const step = {
  do: async (_name: string, a: unknown, b?: unknown) =>
    ((b ?? a) as () => Promise<unknown>)(),
} as unknown as StepRunner;

const CI = `name: CI
on:
  pull_request:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`;

/**
 * PR #1 parent → main and PR #2 child → main, with #2 then stacked by hand on `parent` (as Task 8's retargeting
 * does). The parent branch has no review.yml: anything still reading `base_ref` as the target loses the policy.
 */
async function stackedByHand(
  opts: { conflict?: boolean; stacking?: boolean } = {}
) {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'internal' },
  });
  const repo = [...t.fake.repos.values()][0];
  // Checks are required and never pass, so nothing lands on its own.
  const policy = `checks:\n  require: all\n${opts.stacking ? 'stacking:\n  enabled: true\n' : ''}`;
  const base = {
    'a.txt': 'a\n',
    '.gitorange/review.yml': policy,
    '.github/workflows/ci.yml': CI,
  };
  const main = await commitPaths(repo, 'main', base, 'base');
  repo.refs.set('refs/heads/parent', main);
  const { ['.gitorange/review.yml']: _drop, ...withoutPolicy } = base;
  const parentFiles = { ...withoutPolicy, 'p.txt': 'p\n' };
  await commitPaths(repo, 'parent', parentFiles, 'Parent');
  repo.refs.set('refs/heads/child', repo.refs.get('refs/heads/parent')!);
  const childFiles = {
    ...parentFiles,
    'c.txt': 'c\n',
    ...(opts.conflict ? { 'a.txt': 'child\n' } : {}),
  };
  await commitPaths(repo, 'child', childFiles, 'Child');
  if (opts.conflict)
    await commitPaths(
      repo,
      'main',
      { ...base, 'a.txt': 'main\n' },
      'Main moves'
    );
  for (const [head, title] of [
    ['parent', 'Parent'],
    ['child', 'Child'],
  ])
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls', {
          cookie: admin,
          json: { title, body: '', base: 'main', head },
        })
      ).status
    ).toBe(201);
  await settle(t);
  await t.env.DB.prepare(
    "UPDATE pull_requests SET base_ref = 'parent' WHERE number = 2"
  ).run();
  const db = drizzle(t.env.DB, { schema });
  const repoId = (await t.env.DB.prepare('SELECT id FROM repositories').first<{
    id: string;
  }>())!.id;
  const found = (await findRepoById(db, repoId))!;
  const pr2 = (await t.env.DB.prepare(
    'SELECT id FROM pull_requests WHERE number = 2'
  ).first<{ id: string }>())!.id;
  return {
    t,
    admin,
    repo,
    db,
    repoId,
    found,
    git: gitFor(t.env, found.repo),
    pr2,
    base,
    childFiles,
  };
}

const detail = async (
  s: Awaited<ReturnType<typeof stackedByHand>>,
  n: number
) =>
  (await (
    await call(s.t, `/api/repos/octocat/app/pulls/${n}`, { cookie: s.admin })
  ).json()) as {
    pull: { baseRef: string; landTarget: string };
    conflicts: string[];
    review: { autoMerge: { state: string; reasons: string[] } } | null;
    pullState: { reasons: { kind: string }[] } | null;
  };

describe('readers of the land target', () => {
  it('reads review.yml from the land target (review, auto-merge, list, states, sweep)', async () => {
    const s = await stackedByHand();
    const d = await detail(s, 2);
    expect(d.pull).toMatchObject({ baseRef: 'parent', landTarget: 'main' });
    expect(d.review).not.toBeNull();
    expect(d.review!.autoMerge.state).not.toBe('off');
    expect(d.pullState!.reasons.map((r) => r.kind)).toContain('review_running');
    const list = (await (
      await call(s.t, '/api/repos/octocat/app/pulls', { cookie: s.admin })
    ).json()) as {
      pulls: { number: number; review: unknown }[];
    };
    expect(list.pulls.find((p) => p.number === 2)!.review).not.toBeNull();
    // A new head is reviewed under main's review.yml.
    await commitPaths(
      s.repo,
      'child',
      { ...s.childFiles, 'c2.txt': 'x\n' },
      'More'
    );
    await executeSweep(
      { env: s.t.env, db: s.db, step },
      { repositoryId: s.repoId, branches: ['child'] }
    );
    const mainPolicy = (await readPolicy(
      s.git,
      s.repo.refs.get('refs/heads/main')!
    ))!.sha;
    const latest = await s.t.env.DB.prepare(
      'SELECT policy_sha AS sha FROM pr_classifications WHERE pull_request_id = ? AND head_sha = ?'
    )
      .bind(s.pr2, s.repo.refs.get('refs/heads/child')!)
      .first<{ sha: string }>();
    expect(latest?.sha).toBe(mainPolicy);
  });

  it('runs pull_request workflows filtered by the land target', async () => {
    const s = await stackedByHand();
    const old = s.repo.refs.get('refs/heads/child')!;
    await commitPaths(
      s.repo,
      'child',
      { ...s.childFiles, 'c2.txt': 'x\n' },
      'More'
    );
    const next = s.repo.refs.get('refs/heads/child')!;
    const admin = (await s.t.env.DB.prepare('SELECT id FROM users').first<{
      id: string;
    }>())!.id;
    await onRefsUpdated(
      s.t.env,
      s.db,
      s.found.repo,
      'octocat/app',
      [{ ref: 'refs/heads/child', old, new: next }],
      admin
    );
    expect(
      await s.t.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM workflow_runs WHERE event = 'pull_request' AND ref = 'refs/pull/2/head' AND head_sha = ?"
      )
        .bind(next)
        .first()
    ).toEqual({ n: 1 });
  });

  it('plans the merge, sweeps conflicts, and lists AI resolution against the land target', async () => {
    const s = await stackedByHand({ conflict: true });
    const d = await detail(s, 2);
    expect(d.conflicts).toEqual(['a.txt']); // with main; there are none with parent
    expect(d.review!.autoMerge.reasons).toContain(
      'Resolving conflicts with AI'
    );
    const list = (await (
      await call(s.t, '/api/repos/octocat/app/pulls', { cookie: s.admin })
    ).json()) as {
      pulls: { number: number; aiResolution: string | null }[];
    };
    expect(list.pulls.find((p) => p.number === 2)!.aiResolution).toMatch(
      /running|queued/
    );
    // main moves again: the sweep for main reaches #2 (its base_ref is parent) and re-resolves against main.
    await commitPaths(
      s.repo,
      'main',
      { ...s.base, 'a.txt': 'main 2\n' },
      'Main again'
    );
    await executeSweep(
      { env: s.t.env, db: s.db, step },
      { repositoryId: s.repoId, branches: ['main'] }
    );
    expect(
      await s.t.env.DB.prepare(
        'SELECT COUNT(*) AS n FROM merge_resolutions WHERE pull_request_id = ? AND base_sha = ?'
      )
        .bind(s.pr2, s.repo.refs.get('refs/heads/main')!)
        .first()
    ).toEqual({ n: 1 });
    // Starting one by hand also measures against main.
    const started = await call(
      s.t,
      '/api/repos/octocat/app/pulls/2/resolutions',
      { cookie: s.admin, method: 'POST' }
    );
    expect(started.status).toBe(201);
    expect(((await started.json()) as { baseSha: string }).baseSha).toBe(
      s.repo.refs.get('refs/heads/main')
    );
  });

  it('lands into the land target, never the parent branch', async () => {
    const s = await stackedByHand();
    const parentTip = s.repo.refs.get('refs/heads/parent');
    const mainTip = s.repo.refs.get('refs/heads/main')!;
    const res = await call(s.t, '/api/repos/octocat/app/pulls/2/merge', {
      cookie: s.admin,
      json: {},
    });
    expect(res.status).toBe(200);
    expect(s.repo.refs.get('refs/heads/parent')).toBe(parentTip);
    const landed = s.repo.parseCommit(s.repo.refs.get('refs/heads/main')!)!;
    expect(landed.parents).toEqual([mainTip]);
    expect(landed.message).toBe('Child (#2)');
  });

  it('groups the stack tree by land target', async () => {
    const s = await stackedByHand({ stacking: true });
    const tree = (await (
      await call(s.t, '/api/repos/octocat/app/pulls/tree', { cookie: s.admin })
    ).json()) as {
      targets: { branch: string; nodes: { number: number }[] }[];
    };
    expect(
      tree.targets.map((t) => [t.branch, t.nodes.map((n) => n.number)])
    ).toEqual([['main', [1, 2]]]);
  });

  it('treats a row with a null land_target as landing into its base, as before', async () => {
    const s = await stackedByHand({ stacking: true });
    // As on rows written before the column: no land_target, base_ref is the target.
    await s.t.env.DB.prepare(
      "UPDATE pull_requests SET base_ref = 'main', land_target = NULL"
    ).run();
    const d = await detail(s, 2);
    expect(d.pull).toMatchObject({ baseRef: 'main', landTarget: 'main' });
    expect(d.review).not.toBeNull();
    expect(d.pullState).not.toBeNull();
    const tree = (await (
      await call(s.t, '/api/repos/octocat/app/pulls/tree', { cookie: s.admin })
    ).json()) as { targets: { branch: string; nodes: { number: number }[] }[] };
    expect(
      tree.targets.map((t) => [t.branch, t.nodes.map((n) => n.number)])
    ).toEqual([['main', [1, 2]]]); // SQL filters (landTargetIs) see it too
    const mainTip = s.repo.refs.get('refs/heads/main')!;
    const res = await call(s.t, '/api/repos/octocat/app/pulls/1/merge', {
      cookie: s.admin,
      json: {},
    });
    expect(res.status).toBe(200);
    expect(
      s.repo.parseCommit(s.repo.refs.get('refs/heads/main')!)!.parents
    ).toEqual([mainTip]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn test worker/src/__tests__/land-target.test.ts`
Expected: FAIL: `landTarget` missing from the pull object; the review is null (read from `parent`); no run queued;
no conflicts; the merge lands into `parent`; the tree has no `main` node for #2; the null-`land_target` row's
`landTarget` is missing.

- [ ] **Step 3: Switch the readers.** Import `landTargetOf` (and `landTargetIs`/`landShas` where used) from
      `../lib/land-target` in each file.
  - `worker/src/review/auto-merge.ts` `autoMergeStatus`: `git.resolve(pr.baseRef)` → `git.resolve(landTargetOf(pr))`.
  - `worker/src/review/list.ts` `reviewProgressFor`: the `prs` parameter type becomes
    `Pick<PullRequest, 'id' | 'state' | 'baseRef' | 'landTarget' | 'headRef'>[]`, and
    `refs.get(\`refs/heads/${pr.baseRef}\`)`→`refs.get(\`refs/heads/${landTargetOf(pr)}\`)`.
  - `worker/src/review/view.ts` `reviewView`: for open PRs, read the policy at the land target's tip, not
    `shas.base`:

```ts
const target = open ? await git.resolve(landTargetOf(pr)) : null;
const policyFile = target ? await readPolicy(git, target) : null;
```

    (replacing `const policyFile = open ? await readPolicy(git, shas.base) : null;`).

- `worker/src/review/classify.ts` `executeClassification` `load` step: keep `baseTip` (from `pr.baseRef`) for the
  merge base, so a stacked PR is summarized on its own changes, and read the ignore file from the land target:

```ts
const targetTip = await git.resolve(landTargetOf(pr));
// From the land target, like review.yml: a pull request can't hide its own files.
const ignoreText = targetTip ? await readIgnore(git, targetTip) : null;
```

    In `startStacking`, `git.resolve(pr.baseRef)` → `git.resolve(landTargetOf(pr))`.

- `worker/src/merge/auto.ts`: `sweepTargets` also matches the land target:

```ts
or(
  ...params.branches.map((b) => landTargetIs(b)),
  ...params.branches.map((b) => eq(pullRequests.baseRef, b)),
  ...params.branches.map((b) => eq(pullRequests.headRef, b))
);
```

    and in `executeSweep`, `git.resolve(pr.baseRef)` → `git.resolve(landTargetOf(pr as PullRequest))`.

- `worker/src/merge/resolution.ts`: in `startNext`, `git.resolve(next.pr.baseRef)` →
  `git.resolve(landTargetOf(next.pr))`; in `executeResolution`, `labels = { a: landTargetOf(pr), o: 'base', b: pr.headRef }`;
  in `prepareRequest`, `` `Commits that landed on ${landTargetOf(pr)} since …` ``.
- `worker/src/merge/land.ts` `landPull`: add `const target = landTargetOf(pr);` after the `pr.state` check and
  replace every `pr.baseRef` in the function with `target` (`baseBefore`, the resolution push ref,
  `git.merge({ base: target, … })`, and the `updates` ref).
- `worker/src/actions/trigger.ts` `onRefsUpdated`: the PR event's `baseRef: pr.baseRef` → `baseRef: landTargetOf(pr)`.
  (`queueRuns` then filters branches, computes changed paths for `paths:` filters, and sets `github.base_ref` from
  the land target.) In `openPull` (`worker/src/lib/pulls.ts`) use `baseRef: landTargetOf(pr)` too.
- `worker/src/stack/view.ts` `stackTreeView`: `opts.branch ? landTargetIs(opts.branch) : undefined`;
  `const branches = [...new Set(open.map((p) => landTargetOf(p)))].sort();`;
  `open.filter((p) => on.includes(landTargetOf(p)))`; `.filter((p) => landTargetOf(p) === branch)`. In
  `stackViewFor`: `branch: landTargetOf(pr)` and `.find((t) => t.branch === landTargetOf(pr))`.
- `worker/src/stack/discover.ts` `executeStacking` `load`: `git.resolve(pr.baseRef)` → `git.resolve(landTargetOf(pr))`;
  both `eq(pullRequests.baseRef, pr.baseRef)` → `landTargetIs(landTargetOf(pr))`;
  `landTarget: pr.baseRef` → `landTarget: landTargetOf(pr)`. (`ensureStacking` and `retryFailedPairs` read the
  policy at `shas.base`; their callers now pass the land target's tip.)
- `worker/src/pulls/signals.ts` `pullStates`: `refs.get(\`refs/heads/${pr.baseRef}\`)`→`refs.get(\`refs/heads/${landTargetOf(pr)}\`)`, and the tree lookup `t.branch === landTargetOf(pr)`.

- [ ] **Step 4: The API** (`worker/src/routers/pulls-router.ts`):
  - `pullSchema`: add `/** Where it lands; baseRef may be a parent PR's branch while stacked. */ landTarget: z.string(),`
    and in `serializePull` `landTarget: landTargetOf(pr),`.
  - List: `aiResolution` compares `r.baseSha !== refs.get(\`refs/heads/${landTargetOf(pr)}\`)`.
  - Detail: keep `shas = pullShas(git, pr)` for commits; for an open PR compute merging against the land target:

```ts
const target = pr.state === 'open' ? await landShas(git, pr) : null;
```

    and use `target` (not `shas`) for `planMerge`, `resolvedByAi`, the `ensureResolution` and
    `ensureClassification` backstops, and `serializeResolution(resolution, target ?? shas)`.

- PATCH reopen, `retryReviewRoute`, `retryStackRoute`, `startResolutionRoute`: replace `pullShas(…)` with
  `landShas(c.get('git'), pr)` (for reopen: `landShas(c.get('git'), { ...pr, state: 'open' })`).

- [ ] **Step 5: MCP** (`worker/src/mcp/pull-tools.ts`) `gitorange_get_pull_request`: compute
      `const target = pr.state === 'open' ? await landShas(git, pr) : null;` and use it for the `merge` section's
      `planMerge` and `current` resolution check (instead of `shas`); add `land_target: landTargetOf(pr),` after
      `base`. In `gitorange_merge_pull_request`'s success text use `into ${landTargetOf(pr)}`.

- [ ] **Step 6: Run the tests**

Run: `yarn test worker/src/__tests__/land-target.test.ts worker/src/__tests__/review.test.ts worker/src/__tests__/stacking.test.ts worker/src/__tests__/merge-resolution.test.ts worker/src/__tests__/actions.test.ts worker/src/__tests__/mcp.test.ts worker/src/__tests__/repos-pulls.test.ts worker/src/__tests__/pull-states.test.ts && yarn typecheck`
Expected: PASS; clean. Tests that compare a whole pull object with `toEqual` need `landTarget: 'main'` added.

- [ ] **Step 7: Commit**

```bash
git add worker/src/
git commit -m "Readers of where a PR lands use land_target; diffs still use base_ref

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 3: Discovery: claim race fix, pair slot

**Files:**

- Modify: `worker/src/stack/discover.ts` (the `claim:` step, `save`, `retryFailedPairs`)
- Test: `worker/src/__tests__/stacking.test.ts`

**Interfaces:**

- Produces: `type Claim = { mode: 'skip' } | { mode: 'fresh'; wasAccounted: boolean }` (Task 5 adds `recheck`). The claim deletes a reverse-oriented pair row only when this run's `a` is landed; otherwise it skips the pair.

- [ ] **Step 1: Write the failing test**

In `worker/src/__tests__/stacking.test.ts`, inside `describe('stacking discovery', …)`, add:

```ts
it('never lets a run that loaded before a landing undo the landed orientation', async () => {
  const { t, open } = await repoWithPolicy();
  const db = drizzle(t.env.DB, { schema });
  const { models } = stackModels();
  await open('one', { 'a.txt': 'a\n' }, 'One');
  await open('two', { 'b.txt': 'b\n' }, 'Two');
  await drain(t, models);
  const ids = (
    await t.env.DB.prepare('SELECT id FROM pull_requests ORDER BY number').all<{
      id: string;
    }>()
  ).results.map((r) => r.id);
  // As #1's run claims the pair, #2 has landed and a newer run stored the pair the other way round.
  const racing = {
    do: async (name: string, a: unknown, b?: unknown) => {
      if (name.startsWith('claim:'))
        await t.env.DB.prepare(
          "UPDATE pr_edges SET pr_a_id = ?, pr_b_id = ?, kind = 'builds_on', prerequisite = 'a', reason = 'Landed.'"
        )
          .bind(ids[1], ids[0])
          .run();
      return ((b ?? a) as () => Promise<unknown>)();
    },
  } as unknown as StepRunner;
  await executeStacking(
    { env: t.env, db, step: racing, models },
    { pullRequestId: ids[0] }
  );
  expect(await edges(t)).toMatchObject([
    { a: 2, b: 1, kind: 'builds_on', reason: 'Landed.' },
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test worker/src/__tests__/stacking.test.ts -t "undo the landed orientation"`
Expected: FAIL: the row is back to `a: 1, b: 2` (the stale run deleted the landed row).

- [ ] **Step 3: Rewrite the claim step** in `executeStacking`. Above the loop add the type:

```ts
type Claim = { mode: 'skip' } | { mode: 'fresh'; wasAccounted: boolean };
```

and replace the whole `const fresh = await step.do(\`claim:${other.id}\`, …); if (!fresh) continue;` block with:

```ts
const pairOf = (x: string, y: string) =>
  and(eq(prEdges.prAId, x), eq(prEdges.prBId, y), eq(prEdges.slot, 'pair'));
const claim = await step.do(`claim:${other.id}`, async (): Promise<Claim> => {
  // One pair row per unordered pair. A reverse-oriented row exists only because the other side landed
  // (landed PRs are always a): drop it only when this run is the landed orientation; otherwise this run
  // loaded before that landing and its view is stale.
  const reverse = await db
    .select({ id: prEdges.id })
    .from(prEdges)
    .where(pairOf(b.id, a.id))
    .get();
  if (reverse) {
    if (!a.landed) return { mode: 'skip' };
    await db.delete(prEdges).where(eq(prEdges.id, reverse.id));
  }
  const row = await db.select().from(prEdges).where(pairOf(a.id, b.id)).get();
  if (
    row &&
    row.aHead === a.head &&
    row.bHead === b.head &&
    row.stage !== 'failed'
  )
    return { mode: 'skip' };
  const now = new Date();
  // dismissed_at is left alone: a maintainer's dismissal survives new heads.
  const values = {
    repositoryId: job.repo.id,
    landTarget: job.landTarget,
    prAId: a.id,
    prBId: b.id,
    slot: 'pair' as const,
    aHead: a.head,
    bHead: b.head,
    stage: 'triage' as const,
    kind: null,
    prerequisite: null,
    files: null,
    conflictFiles: null,
    reason: null,
    instructions: null,
    accountedForAt: null,
    accountedHead: null,
    errorMessage: null,
    updatedAt: now,
  };
  await db
    .insert(prEdges)
    .values({ id: crypto.randomUUID(), createdAt: now, ...values })
    .onConflictDoUpdate({
      target: [prEdges.prAId, prEdges.prBId, prEdges.slot],
      set: values,
    });
  return {
    mode: 'fresh',
    wasAccounted: !!row?.accountedForAt && row.kind === 'must_account_for',
  };
});
if (claim.mode === 'skip') continue;
```

In `save`, add `eq(prEdges.slot, 'pair')` to its `and(…)`. In `retryFailedPairs`, add `eq(prEdges.slot, 'pair')` to
the delete's `and(…)`.

- [ ] **Step 4: Run the stacking tests**

Run: `yarn test worker/src/__tests__/stacking.test.ts`
Expected: PASS, including "keeps one row per pair when the higher-numbered PR lands first" (that run's `a` is the
landed #2, so it still replaces the old orientation).

- [ ] **Step 5: Commit**

```bash
git add worker/src/stack/discover.ts worker/src/__tests__/stacking.test.ts
git commit -m "Stack discovery: a stale run never deletes the landed orientation of a pair

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 4: `buildTree` v2: ordering edges, dismissals, accounting, chain-covering parents

**Files:**

- Modify: `worker/src/stack/tree.ts`, `worker/src/stack/view.ts`, `worker/src/routers/pulls-router.ts` (`dependencySchema`)
- Test: `worker/src/__tests__/stack-tree.test.ts`

**Interfaces:**

- Produces:
  - `EdgeInput` gains optional `slot?: 'pair' | 'order'`, `forPr?: number | null`, `accounted?: boolean`, `dismissed?: boolean`.
  - `Dependency` gains `accounted: boolean`, `forPr: number | null` (the PR an `ordered_after` edge was added for).
  - `export function cycles(graph: Map<number, number[]>): Map<number, number[]>` (exported for Task 7).
  - Stage `recheck` counts like `done` (the verdict is known; only accounting is being re-checked).
  - Parent = the strongest stackable prerequisite (`must_account_for` 2 > `builds_on` 1 > `ordered_after` 0, ties to the higher number) whose ancestors include every other stackable prerequisite; none ⇒ no parent. `waitsOn` = other usable prerequisites not already on the parent's chain.
  - `stackTreeView` maps `slot`, `forPrId` → `forPr`, `accountedForAt` → `accounted`, `dismissedAt` → `dismissed`, and counts only `pair` rows for `checking`.

- [ ] **Step 1: Write the failing tests.** In `worker/src/__tests__/stack-tree.test.ts`, replace the test
      "prefers must_account_for, then the newer prerequisite, and keeps the rest as waits-on" with:

```ts
it('without one line through the prerequisites, has no parent and waits on all', () => {
  const t = buildTree(
    [1, 2, 3, 4],
    [edge(1, 4, 'builds_on'), edge(2, 4, 'conflicts'), edge(3, 4, 'builds_on')]
  );
  expect(t.get(4)!.parent).toBeNull();
  expect(
    t
      .get(4)!
      .waitsOn.map((d) => d.number)
      .sort()
  ).toEqual([1, 2, 3]);
});

it('stacks on the prerequisite whose chain holds the others, preferring must_account_for', () => {
  const order = (a: number, b: number, forPr: number): EdgeInput => ({
    ...edge(a, b, 'ordered_after'),
    slot: 'order',
    forPr,
  });
  // #31 needs #28 and #29; #29 was ordered after #28 for it.
  const t = buildTree(
    [28, 29, 31],
    [
      edge(28, 31, 'builds_on'),
      edge(29, 31, 'must_account_for'),
      order(28, 29, 31),
    ]
  );
  expect(t.get(31)!.parent).toMatchObject({
    number: 29,
    kind: 'must_account_for',
  });
  expect(t.get(31)!.waitsOn).toEqual([]); // #28 is on #29's chain
  expect(t.get(29)!.parent).toMatchObject({
    number: 28,
    kind: 'ordered_after',
    forPr: 31,
  });
  expect(t.get(28)!.children).toEqual([29]);
});

it('ignores dismissed edges and marks accounted ones', () => {
  const t = buildTree(
    [1, 2, 3],
    [
      { ...edge(1, 3, 'conflicts'), dismissed: true },
      { ...edge(2, 3, 'must_account_for'), accounted: true },
    ]
  );
  expect(t.get(3)!.waitsOn).toEqual([]);
  expect(t.get(3)!.mustAccountFor).toMatchObject([
    { number: 2, accounted: true },
  ]);
  expect(t.get(3)!.parent?.number).toBe(2);
});

it('keeps blocking while a must_account_for is re-checked', () => {
  const t = buildTree([1, 2], [edge(1, 2, 'must_account_for', 'a', 'recheck')]);
  expect(t.get(2)!.mustAccountFor).toMatchObject([
    { number: 1, accounted: false },
  ]);
  expect(t.get(2)!.pending).toEqual([]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn test worker/src/__tests__/stack-tree.test.ts`
Expected: FAIL: parent chosen by strength alone; `accounted` undefined; `ordered_after` ignored.

- [ ] **Step 3: Update `worker/src/stack/tree.ts`.**
  - Types:

```ts
export type EdgeInput = {
  a: number;
  b: number;
  stage: EdgeStage;
  kind: EdgeKind | null;
  prerequisite: 'a' | 'b' | null;
  reason: string | null;
  instructions: string | null;
  files: string[];
  /** pair (default): a discovery verdict; order: an ordering edge added for `forPr`. */
  slot?: 'pair' | 'order';
  forPr?: number | null;
  /** must_account_for: a re-check of the dependent's head found it accounted for. */
  accounted?: boolean;
  /** A maintainer dismissed it: it neither stacks nor blocks. */
  dismissed?: boolean;
};

export type Dependency = {
  number: number;
  kind: EdgeKind;
  reason: string;
  instructions: string | null;
  landed: boolean;
  files: string[];
  accounted: boolean;
  /** ordered_after: the PR this order was added for. */
  forPr: number | null;
};
```

- Constants:

```ts
const BLOCKING: EdgeKind[] = [
  'builds_on',
  'must_account_for',
  'conflicts',
  'ordered_after',
];
const STACKABLE: EdgeKind[] = [
  'builds_on',
  'must_account_for',
  'ordered_after',
];
const strength = (k: EdgeKind) =>
  k === 'must_account_for' ? 2 : k === 'builds_on' ? 1 : 0;
```

- Export `cycles` (`export function cycles(…)`).
- In `buildTree`'s edge loop: treat `recheck` as known (`if (e.stage !== 'done' && e.stage !== 'recheck') { … }`),
  then `if (e.dismissed) continue;` before the kind checks, and build the dependency with
  `accounted: !!e.accounted, forPr: e.forPr ?? null`.
- Replace the parent-choice loop with:

```ts
// Ancestry over the open prerequisites, ignoring edges inside cycles.
const acyclic = new Map<number, number[]>(
  open.map((n) => {
    const cyc = new Set(inCycle.get(n) ?? []);
    return [n, (graph.get(n) ?? []).filter((p) => !cyc.has(p))];
  })
);
const memo = new Map<number, Set<number>>();
const ancestors = (n: number): Set<number> => {
  const hit = memo.get(n);
  if (hit) return hit;
  const seen = new Set<number>();
  const stack = [...(acyclic.get(n) ?? [])];
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    stack.push(...(acyclic.get(p) ?? []));
  }
  memo.set(n, seen);
  return seen;
};
for (const [n, list] of deps) {
  const cyc = new Set(inCycle.get(n) ?? []);
  const usable = list.filter((d) => !cyc.has(d.number));
  const stackable = usable.filter((d) => STACKABLE.includes(d.kind));
  // The parent's chain must already contain every other stackable prerequisite (one line, after linearizing).
  const covers = (d: Dependency) =>
    stackable.every(
      (o) => o.number === d.number || ancestors(d.number).has(o.number)
    );
  const parent =
    stackable
      .filter(covers)
      .sort(
        (x, y) => strength(y.kind) - strength(x.kind) || y.number - x.number
      )[0] ?? null;
  const node = nodes.get(n)!;
  node.parent = parent;
  const chain = parent ? ancestors(parent.number) : new Set<number>();
  node.waitsOn = usable.filter(
    (d) => d !== parent && !chain.has(d.number) && d.number !== parent?.number
  );
  if (parent) nodes.get(parent.number)!.children.push(n);
}
```

    (Two edges between the same pair, a pair verdict and an order, both end up in `deps`; `d.number !== parent?.number`
    keeps the second from showing as waits-on.)

- [ ] **Step 4: Map the new columns** in `worker/src/stack/view.ts`. Include `forPrId` in the ids looked up
      (`[e.prAId, e.prBId, e.forPrId]` filtered to strings), and in the `inputs` map add:

```ts
              slot: e.slot,
              forPr: e.forPrId ? (byId.get(e.forPrId)?.number ?? null) : null,
              accounted: !!e.accountedForAt,
              dismissed: !!e.dismissedAt,
```

    Skip an `order` row whose `forPrId` PR is not open. In `checking`, count only `e.slot === 'pair'` rows.

    `Dependency` gained required fields: in plan 2a's `worker/src/__tests__/pull-states.test.ts`, add
    `accounted: false, forPr: null` to its `dep()` helper.

- [ ] **Step 5: API schema** in `worker/src/routers/pulls-router.ts` `dependencySchema`: add
      `accounted: z.boolean(),` and `/** ordered_after: the PR this order was added for. */ forPr: z.number().nullable(),`.
      In `src/lib/uiApi.ts` `StackDependency`, add `accounted: boolean; forPr: number | null;`.

- [ ] **Step 6: Run the tests**

Run: `yarn test worker/src/__tests__/stack-tree.test.ts worker/src/__tests__/stacking.test.ts worker/src/__tests__/pull-states.test.ts && yarn typecheck`
Expected: PASS; clean.

- [ ] **Step 7: Commit**

```bash
git add worker/src/stack/ worker/src/routers/pulls-router.ts src/lib/uiApi.ts worker/src/__tests__/stack-tree.test.ts
git commit -m "Stack tree: ordering edges, dismissals, accounting; parents must cover every prerequisite

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 5: Must-account-for re-check

**Files:**

- Modify: `worker/src/stack/models.ts`, `worker/src/stack/discover.ts`, `worker/src/pulls/events.ts`
- Test: `worker/src/__tests__/stack-tree.test.ts` (parser), `worker/src/__tests__/stacking.test.ts`

**Interfaces:**

- Consumes: `Claim` (Task 3), the new `pr_edges` columns (Task 1).
- Produces:
  - `type RecheckInput = { prerequisite: PrSide & { diffs: string }; dependent: PrSide & { diffs: string }; reason: string; instructions: string | null }`.
  - `type Recheck = { accounted: boolean; reason: string; instructions: string | null }`.
  - `StackModels.recheck(input: RecheckInput): Promise<Recheck>`; `parseRecheck(text: string): Recheck` (throws on anything unusable).
  - `Claim` gains `{ mode: 'recheck'; prerequisite: 'a' | 'b'; reason: string; instructions: string | null }`.
  - `recordEvent(db, e: { repositoryId: string; pullRequestId: string; kind: Exclude<PrEventKind, 'state_changed'>; data?: Record<string, unknown>; actorId?: string | null }): Promise<void>` in `worker/src/pulls/events.ts`.
  - Discovery's `Side` gains `headRef: string`.
  - Events: `must_account_for` (`{ pr, reason, instructions, rebase_first }`) and `accounted_for` (`{ pr, reason }`) on the dependent PR.

- [ ] **Step 1: Write the failing parser test.** Append to `worker/src/__tests__/stack-tree.test.ts` (import
      `parseRecheck` from `../stack/models`):

````ts
describe('parseRecheck', () => {
  it('reads an answer and drops instructions once accounted for', () => {
    expect(
      parseRecheck(
        '```json\n{"accounted":true,"reason":"Adds the check.","instructions":"x"}\n```'
      )
    ).toEqual({
      accounted: true,
      reason: 'Adds the check.',
      instructions: null,
    });
    expect(
      parseRecheck(
        '{"accounted":false,"reason":"Still missing.","instructions":"Add it."}'
      )
    ).toEqual({
      accounted: false,
      reason: 'Still missing.',
      instructions: 'Add it.',
    });
  });

  it('refuses anything else', () => {
    for (const text of [
      '{"accounted":"yes","reason":"r","instructions":null}',
      '{"reason":"r","instructions":null}',
      '{"accounted":true,"reason":"","instructions":null}',
      '[]',
      'not json',
    ])
      expect(() => parseRecheck(text)).toThrow();
  });
});
````

- [ ] **Step 2: Write the failing flow tests.** In `worker/src/__tests__/stacking.test.ts`:
  - Extend the fake: add to `stackModels`'s options `recheck?: (i: RecheckInput) => Recheck | Promise<Recheck>`,
    to `StackCalls` a `rechecked: RecheckInput[]` list (initialize it), and to the returned models:

```ts
      recheck: async (i) => {
        calls.rechecked.push(i);
        return (
          (await opts.recheck?.(i)) ?? {
            accounted: false,
            reason: 'Not yet.',
            instructions: 'Still add the check.',
          }
        );
      },
```

    (import `RecheckInput`, `Recheck` from `../stack/models`).

- Add a helper near `repoWithPolicy`:

```ts
/** Pushes `files` to `branch` and starts the sweep a push starts. */
async function pushTo(
  t: TestEnv,
  repo: Parameters<typeof commitPaths>[0],
  branch: string,
  files: Record<string, string>
) {
  const old = repo.refs.get(`refs/heads/${branch}`)!;
  await commitPaths(repo, branch, files, `Update ${branch}`);
  const row = await t.env.DB.prepare(
    "SELECT id FROM repositories WHERE name = 'app'"
  ).first<{ id: string }>();
  await autoResolveConflicts(t.env, { id: row!.id } as Repository, [
    {
      ref: `refs/heads/${branch}`,
      old,
      new: repo.refs.get(`refs/heads/${branch}`)!,
    },
  ]);
}

async function events(t: TestEnv, number: number) {
  return (
    await t.env.DB.prepare(
      `SELECT e.kind, e.data FROM pr_events e JOIN pull_requests p ON p.id = e.pull_request_id
        WHERE p.number = ? AND e.kind <> 'state_changed' ORDER BY e.created_at, e.rowid`
    )
      .bind(number)
      .all<{ kind: string; data: string }>()
  ).results.map((r) => ({ kind: r.kind, data: JSON.parse(r.data) }));
}
```

- Add a describe block:

```ts
describe('must account for', () => {
  const HAS_CHECK = {
    ...SETUP_CHECKS,
    ...USAGE,
    'src/setup-checks.ts':
      'export const checks = [check("CF_ANALYTICS_TOKEN")];\n',
  };

  it('tells the dependent what to change, then re-checks only its new head', async () => {
    const { t, open, repo, files } = await repoWithPolicy();
    const { models, calls } = stackModels({
      related: () => true,
      relation: () => MUST,
      recheck: (i) => ({
        accounted: i.dependent.diffs.includes('CF_ANALYTICS_TOKEN")'),
        reason: 'Adds a setup check for CF_ANALYTICS_TOKEN.',
        instructions: null,
      }),
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    expect(await events(t, 2)).toContainEqual({
      kind: 'must_account_for',
      data: expect.objectContaining({
        pr: 1,
        instructions: MUST.instructions,
        rebase_first: 'setup',
      }),
    });
    const decided = calls.triaged.length;
    await pushTo(t, repo, 'usage', { ...files, ...HAS_CHECK });
    await drain(t, models);
    expect(calls.triaged.length).toBe(decided); // not re-decided
    expect(calls.rechecked).toHaveLength(1);
    const row = await t.env.DB.prepare(
      "SELECT kind, stage, accounted_for_at AS at, accounted_head AS head FROM pr_edges WHERE slot = 'pair'"
    ).first<{
      kind: string;
      stage: string;
      at: number | null;
      head: string | null;
    }>();
    expect(row).toMatchObject({
      kind: 'must_account_for',
      stage: 'done',
      head: repo.refs.get('refs/heads/usage'),
    });
    expect(row!.at).not.toBeNull();
    expect((await events(t, 2)).map((e) => e.kind)).toContain('accounted_for');
  });

  it('keeps blocking with new instructions when not accounted for', async () => {
    const { t, open, repo, files } = await repoWithPolicy();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    await pushTo(t, repo, 'usage', { ...files, ...USAGE, 'docs/x.md': 'x\n' });
    await drain(t, models);
    expect(
      await t.env.DB.prepare(
        "SELECT accounted_for_at AS at, instructions FROM pr_edges WHERE slot = 'pair'"
      ).first()
    ).toEqual({ at: null, instructions: 'Still add the check.' });
  });

  it('keeps blocking when the re-check fails, and Retry runs it again', async () => {
    const { t, admin, open, repo, files } = await repoWithPolicy();
    let fail = true;
    const { models, calls } = stackModels({
      related: () => true,
      relation: () => MUST,
      recheck: () => {
        if (fail) throw new Error('model down');
        return { accounted: true, reason: 'Done.', instructions: null };
      },
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    await pushTo(t, repo, 'usage', { ...files, ...HAS_CHECK });
    await drain(t, models);
    expect(
      await t.env.DB.prepare(
        "SELECT stage, kind, accounted_for_at AS at, error_message AS error FROM pr_edges WHERE slot = 'pair'"
      ).first()
    ).toMatchObject({
      stage: 'done',
      kind: 'must_account_for',
      at: null,
      error: expect.stringMatching(/^Re-check failed/),
    });
    fail = false;
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/2/stack/retry', {
          cookie: admin,
          method: 'POST',
        })
      ).status
    ).toBe(202);
    await drain(t, models);
    expect(calls.rechecked.length).toBeGreaterThanOrEqual(2);
    expect(
      (await t.env.DB.prepare(
        "SELECT accounted_for_at AS at FROM pr_edges WHERE slot = 'pair'"
      ).first<{ at: number | null }>())!.at
    ).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `yarn test worker/src/__tests__/stack-tree.test.ts worker/src/__tests__/stacking.test.ts`
Expected: FAIL: `parseRecheck` missing; no events; the pair is re-decided instead of re-checked.

- [ ] **Step 4: Models** (`worker/src/stack/models.ts`). Add the types and `recheck` to `StackModels`:

```ts
export type RecheckInput = {
  prerequisite: PrSide & { diffs: string };
  dependent: PrSide & { diffs: string };
  /** Why the dependent must change, and what it was told. */
  reason: string;
  instructions: string | null;
};
export type Recheck = {
  accounted: boolean;
  reason: string;
  /** Not accounted for: what is still missing, addressed to the dependent's author. */
  instructions: string | null;
};
```

```ts
  /** The reasoning model: did the dependent's new head account for the prerequisite? */
  recheck(input: RecheckInput): Promise<Recheck>;
```

Add the parser and prompt after `parseRelation`:

```ts
export function parseRecheck(text: string): Recheck {
  const v: unknown = JSON.parse(unfence(text));
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('Expected a JSON object');
  const o = v as Record<string, unknown>;
  if (typeof o.accounted !== 'boolean')
    throw new Error('Re-check has no "accounted"');
  const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
  if (!reason) throw new Error('Re-check has no reason');
  const instructions =
    !o.accounted && typeof o.instructions === 'string'
      ? o.instructions.trim().slice(0, 1500) || null
      : null;
  return { accounted: o.accounted, reason: reason.slice(0, 600), instructions };
}

const RECHECK_SYSTEM = `Pull request "dependent" was told it must change because of pull request "prerequisite". Given both diffs (the dependent's is its latest), answer whether the dependent now accounts for the prerequisite.
"accounted": true only if the dependent's diff makes the change described; false otherwise.
"reason": one plain sentence naming the real things involved.
"instructions": when not accounted for, what is still missing, as a short imperative paragraph addressed to the dependent's author; otherwise null.
${GUARD}`;

const RECHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['accounted', 'reason', 'instructions'],
  properties: {
    accounted: { type: 'boolean' },
    reason: { type: 'string', maxLength: 600 },
    instructions: { type: ['string', 'null'], maxLength: 1500 },
  },
} as const;
```

and to `workersAiStackModels`' returned object:

```ts
    async recheck(input) {
      const out = await run(
        ids.review,
        {
          messages: [
            { role: 'system', content: RECHECK_SYSTEM },
            {
              role: 'user',
              content:
                `What the dependent was told: ${input.reason}\n${input.instructions ?? ''}\n\n` +
                `${sideText('prerequisite', input.prerequisite)}\n\nDiffs of the prerequisite:\n${input.prerequisite.diffs}\n\n` +
                `${sideText('dependent', input.dependent)}\n\nDiffs of the dependent (latest):\n${input.dependent.diffs}`,
            },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'recheck', strict: true, schema: RECHECK_SCHEMA },
          },
          reasoning_effort: 'low',
          max_completion_tokens: 3000,
        },
        'stack-explain'
      );
      return parseRecheck(chatText(out));
    },
```

- [ ] **Step 5: `recordEvent`** in `worker/src/pulls/events.ts`:

```ts
/** Records one of GitOrange's own timeline entries (not a state change). */
export async function recordEvent(
  db: DrizzleDB,
  e: {
    repositoryId: string;
    pullRequestId: string;
    kind: Exclude<PrEventKind, 'state_changed'>;
    data?: Record<string, unknown>;
    actorId?: string | null;
  }
): Promise<void> {
  await db.insert(prEvents).values({
    id: crypto.randomUUID(),
    repositoryId: e.repositoryId,
    pullRequestId: e.pullRequestId,
    kind: e.kind,
    state: null,
    data: e.data ?? null,
    actorId: e.actorId ?? null,
    computedAt: null,
    createdAt: new Date(),
  });
}
```

(import `type PrEventKind` from `../db/app.schema`).

- [ ] **Step 6: Discovery** (`worker/src/stack/discover.ts`).
  - `Side` gains `headRef: string`; in `load`'s `side()` add `headRef: p.headRef,`.
  - `Claim` gains the recheck mode:

```ts
type Claim =
  | { mode: 'skip' }
  | { mode: 'fresh'; wasAccounted: boolean }
  | {
      mode: 'recheck';
      prerequisite: 'a' | 'b';
      reason: string;
      instructions: string | null;
    };
```

- In the claim step, right after the "same heads → skip" check, add:

```ts
// Only the dependent moved since it was told to account for the prerequisite: re-check, don't re-decide.
if (
  row &&
  row.stage === 'done' &&
  row.kind === 'must_account_for' &&
  row.prerequisite &&
  (row.prerequisite === 'a' ? row.aHead === a.head : row.bHead === b.head)
) {
  await db
    .update(prEdges)
    .set({
      aHead: a.head,
      bHead: b.head,
      stage: 'recheck',
      accountedForAt: null,
      accountedHead: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(prEdges.id, row.id));
  return {
    mode: 'recheck',
    prerequisite: row.prerequisite,
    reason: row.reason ?? '',
    instructions: row.instructions,
  };
}
```

- Before the loop, replace the inline `diffs` helper with a shared one (and use `diffsOf(s, focus)` in the
  `explain:` step):

```ts
// The reasoning model reads the diffs: `focus` files first, then the rest within budget.
const diffsOf = async (s: Side, focus: string[]) => {
  const changes = await changesFor(git, s.target, s.head);
  const text = await diffsFor(git, changes, focus, ignored, false);
  return text.slice(0, MAX_SIDE_DIFF);
};
```

- After `const save = …`, add:

```ts
const sides = (pre: 'a' | 'b') =>
  pre === 'a' ? { pre: a, dep: b } : { pre: b, dep: a };
// Did the dependent's head account for the prerequisite? A failure keeps blocking (stage done, error set).
const recheck = async (
  pre: Side,
  dep: Side,
  reason: string,
  instructions: string | null
) => {
  try {
    const result = await step.do(
      `recheck:${other.id}`,
      MODEL_RETRIES,
      async () =>
        models.recheck({
          prerequisite: { ...pre, diffs: await diffsOf(pre, other.shared) },
          dependent: { ...dep, diffs: await diffsOf(dep, other.shared) },
          reason,
          instructions,
        })
    );
    await step.do(`rechecked:${other.id}`, async () => {
      const still = result.instructions ?? instructions;
      await save({
        stage: 'done',
        accountedForAt: result.accounted ? new Date() : null,
        accountedHead: result.accounted ? dep.head : null,
        instructions: result.accounted ? instructions : still,
        errorMessage: null,
      });
      await recordEvent(db, {
        repositoryId: job.repo.id,
        pullRequestId: dep.id,
        kind: result.accounted ? 'accounted_for' : 'must_account_for',
        data: result.accounted
          ? { pr: pre.number, reason: result.reason }
          : {
              pr: pre.number,
              reason: result.reason,
              instructions: still,
              rebase_first: pre.landed ? null : pre.headRef,
            },
      });
      return true;
    });
  } catch (e) {
    console.error('[stack] re-check failed', a.number, b.number, e);
    await step.do(`recheck-failed:${other.id}`, async () => {
      await save({
        stage: 'done',
        errorMessage: `Re-check failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      return true;
    });
  }
};
if (claim.mode === 'recheck') {
  const { pre, dep } = sides(claim.prerequisite);
  await recheck(pre, dep, claim.reason, claim.instructions);
  continue;
}
```

- In the `save:` step, after `await save({…})`, record the instructions on the dependent:

```ts
if (kind === 'must_account_for' && prerequisite) {
  const { pre, dep } = sides(prerequisite);
  await recordEvent(db, {
    repositoryId: job.repo.id,
    pullRequestId: dep.id,
    kind: 'must_account_for',
    data: {
      pr: pre.number,
      reason: relation.reason,
      instructions: relation.instructions,
      rebase_first: pre.landed ? null : pre.headRef,
    },
  });
}
```

    and after that step (still inside the `try`):

```ts
// Accounted for before both heads moved, and still must account for: re-check now rather than wait.
if (kind === 'must_account_for' && prerequisite && claim.wasAccounted) {
  const { pre, dep } = sides(prerequisite);
  await recheck(pre, dep, relation.reason, relation.instructions);
}
```

- `retryFailedPairs`: after the delete, re-arm failed re-checks (they keep their edge, so they aren't deleted):

```ts
// A failed re-check still blocks; forgetting the dependent's head makes the next run re-check it.
const failedRecheck = and(
  eq(prEdges.slot, 'pair'),
  eq(prEdges.kind, 'must_account_for'),
  isNull(prEdges.accountedForAt),
  isNotNull(prEdges.errorMessage)
);
await db
  .update(prEdges)
  .set({ bHead: '' })
  .where(
    and(failedRecheck, eq(prEdges.prerequisite, 'a'), eq(prEdges.prBId, pr.id))
  );
await db
  .update(prEdges)
  .set({ aHead: '' })
  .where(
    and(failedRecheck, eq(prEdges.prerequisite, 'b'), eq(prEdges.prAId, pr.id))
  );
```

    (import `isNull`, `isNotNull` from `drizzle-orm` and `recordEvent` from `../pulls/events`).

- [ ] **Step 7: Run the tests**

Run: `yarn test worker/src/__tests__/stack-tree.test.ts worker/src/__tests__/stacking.test.ts && yarn typecheck`
Expected: PASS; clean.

- [ ] **Step 8: Commit**

```bash
git add worker/src/stack/ worker/src/pulls/events.ts worker/src/__tests__/
git commit -m "Must account for: post the instructions, re-check the dependent's new head, keep blocking on failure

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 6: Blocking: the stack gate (and discovery before auto-merge)

**Files:**

- Create: `worker/src/stack/gate.ts`
- Modify: `worker/src/review/auto-merge.ts` (`autoMergeStatus`), `worker/src/merge/land.ts` (`landPull`), `worker/src/review/classify.ts` (step order), `worker/src/stack/discover.ts` (final `auto-merge` step), `worker/src/mcp/pull-tools.ts` (merge description)
- Test: `worker/src/__tests__/stacking.test.ts`

**Interfaces:**

- Consumes: `stackViewFor` (`TreeNode | null`), `Dependency.accounted` (Task 4).
- Produces:
  - `type StackBlock = { kind: 'must_account_for' | 'stacked_on' | 'waits_on'; pr: number; message: string }`.
  - `type StackGate = { on: boolean; checking: boolean; blocks: StackBlock[] }`.
  - `gateFor(node: TreeNode | null): StackGate` (pure), `stackGate(db: DrizzleDB, git: GitService, pr: PullRequest): Promise<StackGate>`.
  - `landPull` returns `{ ok: false, status: 409, error }` naming every block; `autoMergeStatus` adds must-account-for to `blocked`, the rest and "checking" to `waiting`.

- [ ] **Step 1: Write the failing tests.** In `worker/src/__tests__/stacking.test.ts`:
  - Update "keeps one row per pair when the higher-numbered PR lands first": its relation becomes
    `relation: (i) => (i.a.landed ? BUILDS : { ...BUILDS, prerequisite: 'b' })` (#1 builds on #2 while both are
    open, so landing #2 first is allowed; the rest of the test is unchanged).
  - Change `stackModels`' `relation` option type to `(i: { a: PrSide; b: PrSide }) => Relation` (import `PrSide`)
    so tests can relate pairs by number.
  - Add:

```ts
describe('stack gate', () => {
  it('holds auto-merge until discovery has checked the PR', async () => {
    const { t, open } = await repoWithPolicy(
      'model: clef\nchecks:\n  require: none\nstacking:\n  enabled: true\n'
    );
    const db = drizzle(t.env.DB, { schema });
    const { models } = stackModels();
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await settle(t);
    const review = t.actions.resolutions.find(
      (r) => (r.params as { classificationId?: string }).classificationId
    )!;
    await executeClassification(
      { env: t.env, db, step, models: reviewModels },
      (review.params as { classificationId: string }).classificationId
    );
    const state = () =>
      t.env.DB.prepare(
        'SELECT state FROM pull_requests WHERE number = 1'
      ).first<{ state: string }>();
    expect((await state())!.state).toBe('open'); // clean review, but not yet checked against #2
    const run = t.actions.resolutions.find(
      (r) => (r.params as { stack?: StackParams }).stack
    )!;
    await executeStacking(
      { env: t.env, db, step, models },
      (run.params as { stack: StackParams }).stack
    );
    expect((await state())!.state).toBe('merged');
  });

  it('refuses to land a PR that must account for another, naming it', async () => {
    const { t, admin, open } = await repoWithPolicy();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    const res = await call(t, '/api/repos/octocat/app/pulls/2/merge', {
      cookie: admin,
      json: {},
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /Must account for #1 first/
    );
    const d = (await (
      await call(t, '/api/repos/octocat/app/pulls/2', { cookie: admin })
    ).json()) as {
      review: { autoMerge: { state: string; reasons: string[] } };
    };
    expect(d.review.autoMerge.state).toBe('blocked');
    expect(d.review.autoMerge.reasons.join('\n')).toMatch(
      /Must account for #1 first/
    );
  });

  it('blocks on a landed prerequisite without retargeting', async () => {
    const { t, admin, open } = await repoWithPolicy();
    const { models } = stackModels({
      related: () => true,
      relation: (i) =>
        i.a.landed
          ? MUST
          : { ...MUST, kind: 'independent', prerequisite: null },
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await drain(t, models);
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/1/merge', {
          cookie: admin,
          json: {},
        })
      ).status
    ).toBe(200);
    await drain(t, models);
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    expect(
      await t.env.DB.prepare(
        'SELECT base_ref AS baseRef FROM pull_requests WHERE number = 2'
      ).first()
    ).toEqual({ baseRef: 'main' });
    const res = await call(t, '/api/repos/octocat/app/pulls/2/merge', {
      cookie: admin,
      json: {},
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/#1/);
  });
});
```

    (`step` and `reviewModels` already exist at the top of the file.)

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn test worker/src/__tests__/stacking.test.ts -t "stack gate"`
Expected: FAIL: #1 merges right after its review; #2 merges despite the edge.

- [ ] **Step 3: Create `worker/src/stack/gate.ts`**

```ts
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
  /** Stacking is on for the PR's land target. */
  on: boolean;
  /** Discovery hasn't finished checking this head: auto-merge waits. */
  checking: boolean;
  /** Edges that keep it from landing (dismissed ones never appear in the tree). */
  blocks: StackBlock[];
};

/** What holds a PR back in its stack tree. */
export function gateFor(node: TreeNode | null): StackGate {
  if (!node) return { on: false, checking: false, blocks: [] };
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
    on: true,
    checking: node.checking || node.pending.length > 0,
    blocks,
  };
}

export async function stackGate(
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest
): Promise<StackGate> {
  return gateFor(await stackViewFor(db, git, pr));
}
```

- [ ] **Step 4: `autoMergeStatus`**: after the conflicts block (before `if (blocked.length)`), add:

```ts
const gate = await stackGate(db, git, pr);
for (const b of gate.blocks)
  (b.kind === 'must_account_for' ? blocked : waiting).push(b.message);
// Discovery runs once the review ends; landing before it has checked this head would skip it.
if (gate.checking)
  waiting.push('Checking how it relates to other open pull requests');
```

- [ ] **Step 5: `landPull`**: after the head-branch check, add:

```ts
const gate = await stackGate(db, git, pr);
if (gate.blocks.length)
  return {
    ok: false,
    status: 409,
    error: `${gate.blocks.map((b) => b.message).join('. ')}. A maintainer can dismiss a dependency on the pull request page.`,
  };
```

- [ ] **Step 6: Discovery before auto-merge.** In `executeClassification`, move `await startStacking();` from after
      the `auto-merge` step to just before it. At the end of `executeStacking` (after the pair loop) add:

```ts
// Discovery held auto-merge for this head; now that it has checked it, try again.
await step.do('auto-merge', async () => {
  await maybeAutoMerge(env, db, params.pullRequestId);
  return true;
});
```

(import `maybeAutoMerge` from `../review/auto-merge`).

- [ ] **Step 7: MCP merge description** (`gitorange_merge_pull_request`): append
      `' Also refused while it must account for another pull request, is stacked on an open one, or waits on one; the refusal names it. Only a person can dismiss such a dependency, in the web UI.'`.

- [ ] **Step 8: Run the tests**

Run: `yarn test worker/src/__tests__/stacking.test.ts worker/src/__tests__/review.test.ts worker/src/__tests__/mcp.test.ts worker/src/__tests__/land-target.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add worker/src/
git commit -m "Stack gate: landing waits for parents and must-account-for; auto-merge waits for discovery

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 7: Linearize (and the Clef order question)

**Files:**

- Create: `worker/src/stack/linearize.ts`
- Modify: `worker/src/stack/models.ts` (`ORDER_QUESTIONS`, `readOrder`, `StackModels.order`, Workers AI implementation)
- Test: `worker/src/__tests__/stack-tree.test.ts`

**Interfaces:**

- Consumes: `cycles` (Task 4).
- Produces:
  - `type OrderEdge = { before: number; after: number; forPr: number }`.
  - `type LinearizeInput = { open: number[]; stackable: Map<number, number[]>; others: { pre: number; dep: number }[]; orders: OrderEdge[] }`.
  - `type Choose = (x: number, y: number, forPr: number) => Promise<number>` (returns the PR that lands first).
  - `linearize(input: LinearizeInput, choose: Choose): Promise<OrderEdge[]>` (the edges to add).
  - `ORDER_QUESTIONS: Record<string, ClefQuestion>`, `readOrder(answers: Record<string, ClassifierAnswer>): { first: 'a' | 'b'; confidence: number }`.
  - `StackModels.order(model: 'clef' | 'clef-flash', input: { a: PrSide; b: PrSide; dependent: PrSide }): Promise<Record<string, ClassifierAnswer>>`.

- [ ] **Step 1: Write the failing tests.** Append to `worker/src/__tests__/stack-tree.test.ts` (import `linearize`,
      `type Choose` from `../stack/linearize`; `readOrder` from `../stack/models`):

```ts
describe('linearize', () => {
  const firstIs =
    (n: number): Choose =>
    async (x, y) =>
      x === n || y !== n ? x : y;

  it('adds nothing when one prerequisite’s chain already holds the others', async () => {
    const added = await linearize(
      {
        open: [28, 29, 31],
        stackable: new Map([
          [29, [28]],
          [31, [28, 29]],
        ]),
        others: [],
        orders: [],
      },
      async () => {
        throw new Error('no choice needed');
      }
    );
    expect(added).toEqual([]);
  });

  it('orders two unrelated prerequisites by the choice, for the PR that needs both', async () => {
    const asked: number[][] = [];
    const added = await linearize(
      {
        open: [28, 29, 31],
        stackable: new Map([[31, [28, 29]]]),
        others: [],
        orders: [],
      },
      async (x, y, forPr) => {
        asked.push([x, y, forPr]);
        return 29;
      }
    );
    expect(asked).toEqual([[29, 28, 31]]);
    expect(added).toEqual([{ before: 29, after: 28, forPr: 31 }]);
  });

  it('lets an existing relationship win over the choice', async () => {
    const added = await linearize(
      {
        open: [28, 29, 31],
        stackable: new Map([[31, [28, 29]]]),
        others: [{ pre: 28, dep: 29 }], // #29 conflicts with #28 and lands after it
        orders: [],
      },
      async () => {
        throw new Error('no choice needed');
      }
    );
    expect(added).toEqual([]);
  });

  it('chains three prerequisites and stays acyclic whatever the choice says', async () => {
    const added = await linearize(
      {
        open: [1, 2, 3, 9],
        stackable: new Map([[9, [1, 2, 3]]]),
        others: [],
        orders: [],
      },
      async (_x, y) => y // contrary: always the second
    );
    expect(added).toHaveLength(2);
    const after = new Map(added.map((e) => [e.after, e.before]));
    // Following "lands after" from any node ends: no cycle.
    for (const start of [1, 2, 3]) {
      const seen = new Set<number>();
      for (
        let n: number | undefined = start;
        n !== undefined;
        n = after.get(n)
      ) {
        expect(seen.has(n)).toBe(false);
        seen.add(n);
      }
    }
  });

  it('skips PRs in a dependency cycle', async () => {
    const added = await linearize(
      {
        open: [1, 2, 3, 4],
        stackable: new Map([
          [1, [2]],
          [2, [1]],
          [4, [1, 3]],
        ]),
        others: [],
        orders: [],
      },
      firstIs(3)
    );
    expect(added).toEqual([]);
  });

  it('reads Clef’s order answer', () => {
    expect(
      readOrder({
        first: {
          type: 'choice',
          value: 'b',
          confidence: 0.8,
          probabilities: { b: 0.8 },
        },
      })
    ).toEqual({ first: 'b', confidence: 0.8 });
    expect(() => readOrder({ first: { type: 'noul', value: 0.9 } })).toThrow();
    expect(() =>
      readOrder({
        first: { type: 'choice', value: 'c', confidence: 1, probabilities: {} },
      })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn test worker/src/__tests__/stack-tree.test.ts`
Expected: FAIL: cannot resolve `../stack/linearize`.

- [ ] **Step 3: Create `worker/src/stack/linearize.ts`**

```ts
import { cycles } from './tree';

/** `after` lands after `before` (and stacks on it) so `forPr` can build on both. */
export type OrderEdge = { before: number; after: number; forPr: number };
export type LinearizeInput = {
  open: number[];
  /** Dependent → its open stackable prerequisites (builds_on, must_account_for; undismissed). */
  stackable: Map<number, number[]>;
  /** Other ordering facts among open PRs (conflicts): `dep` lands after `pre`. */
  others: { pre: number; dep: number }[];
  /** Ordering edges kept from before. */
  orders: OrderEdge[];
};
/** Which of x and y lands first so `forPr` is easiest to build on both. */
export type Choose = (x: number, y: number, forPr: number) => Promise<number>;

/**
 * Ordering edges that put each PR's stackable prerequisites on one line, in topological order. An existing
 * relationship decides a pair before `choose` is asked; an order that would make a cycle is never added (the PR
 * then waits on its prerequisites instead).
 */
export async function linearize(
  input: LinearizeInput,
  choose: Choose
): Promise<OrderEdge[]> {
  const open = new Set(input.open);
  const graph = new Map<number, Set<number>>(
    input.open.map((n) => [n, new Set<number>()])
  );
  const link = (dep: number, pre: number) => {
    if (open.has(dep) && open.has(pre) && dep !== pre) graph.get(dep)!.add(pre);
  };
  for (const [dep, pres] of input.stackable) for (const p of pres) link(dep, p);
  for (const r of input.others) link(r.dep, r.pre);
  for (const o of input.orders) link(o.after, o.before);
  const inCycle = cycles(new Map([...graph].map(([k, v]) => [k, [...v]])));
  /** Is `to` an ancestor of `from` (does `from` already land after `to`)? */
  const reaches = (from: number, to: number) => {
    const seen = new Set<number>();
    const stack = [...(graph.get(from) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(graph.get(n) ?? []));
    }
    return false;
  };
  const first = async (s: number, c: number, forPr: number) => {
    if (reaches(c, s)) return true;
    if (reaches(s, c)) return false;
    return (await choose(s, c, forPr)) === s;
  };

  // Topological order (prerequisites first), lower numbers first among equals; PRs in cycles are left out.
  const nodes = input.open.filter((n) => !inCycle.has(n)).sort((x, y) => x - y);
  const done = new Set<number>();
  const order: number[] = [];
  while (order.length < nodes.length) {
    const next = nodes.find(
      (n) =>
        !done.has(n) &&
        [...graph.get(n)!].every((p) => done.has(p) || inCycle.has(p))
    );
    if (next === undefined) break;
    done.add(next);
    order.push(next);
  }

  const added: OrderEdge[] = [];
  for (const p of order) {
    const pres = [...new Set(input.stackable.get(p) ?? [])]
      .filter((n) => open.has(n) && !inCycle.has(n))
      .sort((x, y) => x - y);
    if (pres.length < 2) continue;
    if (pres.some((m) => pres.every((o) => o === m || reaches(m, o)))) continue;
    const chain: number[] = [];
    for (const s of pres) {
      let i = 0;
      while (i < chain.length && !(await first(s, chain[i], p))) i++;
      chain.splice(i, 0, s);
    }
    const mine: OrderEdge[] = [];
    let ok = true;
    for (let i = 0; i + 1 < chain.length; i++) {
      const [x, y] = [chain[i], chain[i + 1]];
      if (reaches(y, x)) continue; // already in that order
      if (reaches(x, y)) {
        ok = false; // the other way round already: adding it would make a cycle
        break;
      }
      graph.get(y)!.add(x);
      mine.push({ before: x, after: y, forPr: p });
    }
    if (!ok) {
      for (const e of mine) graph.get(e.after)!.delete(e.before);
      continue;
    }
    added.push(...mine);
  }
  return added;
}
```

- [ ] **Step 4: The Clef order question** in `worker/src/stack/models.ts`:

```ts
/** Clef's question when a PR needs two unrelated prerequisites in one line. */
export const ORDER_QUESTIONS: Record<string, ClefQuestion> = {
  first: {
    type: 'choice',
    instructions:
      'Pull request "dependent" builds on both a and b, which do not depend on each other. One of a and b must land first and the other be rebased onto it, so the dependent can build on both. Which should land first so the dependent is easiest to build on both?',
    criteria: {
      a: 'a lands first; b is rebased onto a.',
      b: 'b lands first; a is rebased onto b.',
    },
  },
};

export function readOrder(answers: Record<string, ClassifierAnswer>): {
  first: 'a' | 'b';
  confidence: number;
} {
  const f = answers.first;
  if (f?.type !== 'choice' || (f.value !== 'a' && f.value !== 'b'))
    throw new Error('Clef gave no usable "first"');
  return { first: f.value, confidence: f.confidence };
}
```

Add to `StackModels`:

```ts
  /** Clef: ORDER_QUESTIONS for two prerequisites of `dependent`. */
  order(
    model: 'clef' | 'clef-flash',
    input: { a: PrSide; b: PrSide; dependent: PrSide }
  ): Promise<Record<string, ClassifierAnswer>>;
```

and to `workersAiStackModels`:

```ts
    async order(model, input) {
      const out = (await run(
        classifierModel(model),
        {
          model,
          state: {
            a: clefSide(input.a),
            b: clefSide(input.b),
            dependent: clefSide(input.dependent),
          },
          questions: ORDER_QUESTIONS,
        },
        'stack-decide'
      )) as { answers?: Record<string, ClefAnswer> };
      if (!out.answers) throw new Error('Clef returned no answers');
      return toAnswers(out.answers);
    },
```

In `worker/src/__tests__/stacking.test.ts`'s `stackModels` fake add an `order` option
(`order?: () => Record<string, ClassifierAnswer> | Promise<…>`), a `calls.ordered: number` counter, and:

```ts
      order: async () => {
        calls.ordered++;
        return (
          (await opts.order?.()) ?? {
            first: { type: 'choice', value: 'a', confidence: 0.9, probabilities: { a: 0.9 } },
          }
        );
      },
```

- [ ] **Step 5: Run the tests**

Run: `yarn test worker/src/__tests__/stack-tree.test.ts worker/src/__tests__/stacking.test.ts && yarn typecheck`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add worker/src/stack/linearize.ts worker/src/stack/models.ts worker/src/__tests__/
git commit -m "Stack: linearize several prerequisites (relationship, then Clef, never a cycle)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 8: Reconcile: prune, linearize, retarget; unwinding on close and land

**Files:**

- Create: `worker/src/stack/reconcile.ts`, `worker/src/stack/retarget.ts`
- Modify: `worker/src/stack/discover.ts` (export helpers; call reconcile), `worker/src/merge/workflow.ts` (`reconcile` payload), `worker/src/pulls/settle.ts` (`repositoryForPayload`), `worker/src/merge/land.ts`, `worker/src/routers/pulls-router.ts` (PATCH close)
- Test: `worker/src/__tests__/stacking.test.ts`

**Interfaces:**

- Consumes: `linearize`, `readOrder` (Task 7), `stackTreeView` (Task 2/4), `pullStates`, `STATE_RANK` (plan 2a), `recordEvent` (Task 5), `settleStates` (plan 2a).
- Produces:
  - `type ReconcileParams = { repositoryId: string; landTarget: string }`.
  - `executeReconcile(deps: { env; db; step: StepRunner; models: StackModels }, params: ReconcileParams, prefix?: string): Promise<number>` (PRs retargeted).
  - `startReconcile(env, repositoryId: string, landTarget: string): Promise<void>` (starts `{ reconcile: params }` on MERGE_RESOLUTION; never throws).
  - `onPullClosed(env, db, pr: PullRequest, how: 'closed' | 'landed'): Promise<void>` (model-free unwinding, then `startReconcile`).
  - `discover.ts` exports `stackingPolicy`, `changesFor`, `summariesFor`.
  - `MergeResolutionParams` gains a `reconcile` variant; `repositoryForPayload` handles it.
  - `workersAiStackModels` ctx `pullRequestId: string | null`.
  - Events `ordered` (`{ before, for_pr, reason }`), `stacked` (`{ pr, branch, kind, reason }`), `unstacked` (`{ pr, why }`).

- [ ] **Step 1: Write the failing tests.** In `worker/src/__tests__/stacking.test.ts`, make `drain` run reconcile
      payloads too: add `reconcile?: ReconcileParams` to its `p` type and
      `else if (p.reconcile) await executeReconcile({ env: t.env, db, step, models }, p.reconcile);` (import from
      `../stack/reconcile`). Then add:

```ts
describe('retargeting', () => {
  const BUILDS_A: Relation = {
    kind: 'builds_on',
    prerequisite: 'a',
    reason: 'Builds on it.',
    instructions: null,
  };
  /** #3 builds on #1 and on #2; #1 and #2 are unrelated. */
  const three = (more: Parameters<typeof stackModels>[0] = {}) =>
    stackModels({
      related: (i) => !(i.a.number === 1 && i.b.number === 2),
      relation: () => BUILDS_A,
      ...more,
    });
  const bases = async (t: TestEnv) =>
    (
      await t.env.DB.prepare(
        'SELECT number, base_ref AS base FROM pull_requests ORDER BY number'
      ).all<{
        number: number;
        base: string;
      }>()
    ).results.map((r) => [r.number, r.base]);

  async function openThree(
    t: TestEnv,
    open: (
      b: string,
      c: Record<string, string>,
      title: string
    ) => Promise<number>
  ) {
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await open('three', { 'c.txt': 'c\n' }, 'Three');
  }

  it('linearizes #3’s prerequisites and stacks each on its parent', async () => {
    const { t, open } = await repoWithPolicy();
    const { models, calls } = three();
    await openThree(t, open);
    await drain(t, models);
    expect(calls.ordered).toBe(1);
    expect(await bases(t)).toEqual([
      [1, 'main'],
      [2, 'one'],
      [3, 'two'],
    ]);
    expect(
      await t.env.DB.prepare(
        "SELECT kind, prerequisite, reason FROM pr_edges WHERE slot = 'order'"
      ).first()
    ).toEqual({
      kind: 'ordered_after',
      prerequisite: 'a',
      reason: '#2 lands after #1 so #3 can build on both.',
    });
    expect((await events(t, 2)).map((e) => e.kind)).toEqual(
      expect.arrayContaining(['ordered', 'stacked'])
    );
    expect((await events(t, 3)).at(-1)).toMatchObject({
      kind: 'stacked',
      data: { pr: 2, branch: 'two' },
    });
  });

  // Two tests: each needs its own instance (the admin is bootstrapped once per test database).
  it('falls back when Clef is unsure: closer to Ready first', async () => {
    const { t, open, repo } = await repoWithPolicy();
    const { models } = three({
      order: () => ({
        first: {
          type: 'choice',
          value: 'a',
          confidence: 0.2,
          probabilities: { a: 0.2 },
        },
      }),
    });
    await openThree(t, open);
    // #1 has a failed check (agent followup); #2 only waits: #2 is closer to Ready and goes first.
    await t.env.DB.prepare(
      `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title, status, conclusion, created_at)
       SELECT 'r1', id, 1, 'ci.yml', 'CI', 'pull_request', 'x', ?, 'x', 'completed', 'failure', 0 FROM repositories`
    )
      .bind(repo.refs.get('refs/heads/one'))
      .run();
    await drain(t, models);
    expect(await bases(t)).toEqual([
      [1, 'two'],
      [2, 'main'],
      [3, 'one'],
    ]);
  });

  it('falls back when Clef fails: equally close to Ready, the lower number first', async () => {
    const { t, open } = await repoWithPolicy();
    const { models } = three({
      order: () => {
        throw new Error('Clef down');
      },
    });
    await openThree(t, open);
    await drain(t, models);
    expect(await bases(t)).toEqual([
      [1, 'main'],
      [2, 'one'],
      [3, 'two'],
    ]);
  });

  it('keeps an ordering until one of its three PRs moves', async () => {
    const { t, open, repo, files } = await repoWithPolicy();
    const { models, calls } = three();
    await openThree(t, open);
    await drain(t, models);
    await drain(t, models);
    expect(calls.ordered).toBe(1);
    await pushTo(t, repo, 'three', { ...files, 'c.txt': 'c2\n' });
    await drain(t, models);
    expect(calls.ordered).toBe(2);
  });

  it('sends children back to the land target when their parent closes, then restacks them', async () => {
    const { t, admin, open } = await repoWithPolicy();
    const { models } = three();
    await openThree(t, open);
    await drain(t, models);
    await call(t, '/api/repos/octocat/app/pulls/1', {
      cookie: admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    await settle(t);
    expect((await bases(t)).slice(1)).toEqual([
      [2, 'main'],
      [3, 'two'],
    ]);
    expect((await events(t, 2)).at(-1)).toMatchObject({
      kind: 'unstacked',
      data: { pr: 1 },
    });
    expect(
      await t.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM pr_edges WHERE slot = 'order'"
      ).first()
    ).toEqual({ n: 0 });
    expect(
      t.actions.resolutions.some(
        (r) => (r.params as { reconcile?: unknown }).reconcile
      )
    ).toBe(true);
    await drain(t, models);
    expect((await bases(t)).slice(1)).toEqual([
      [2, 'main'],
      [3, 'two'],
    ]);
  });

  it('never stacks onto a branch that no longer exists', async () => {
    const { t, open, repo } = await repoWithPolicy();
    const { models } = stackModels({
      related: () => true,
      relation: () => BUILDS_A,
    });
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    expect(await bases(t)).toEqual([
      [1, 'main'],
      [2, 'one'],
    ]);
    repo.refs.delete('refs/heads/one');
    const db = drizzle(t.env.DB, { schema });
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{ id: string }>())!.id;
    await executeReconcile(
      { env: t.env, db, step, models },
      { repositoryId: repoId, landTarget: 'main' }
    );
    expect((await bases(t))[1]).toEqual([2, 'main']);
  });

  it('retargets once when reconciles repeat or race', async () => {
    const { t, open } = await repoWithPolicy();
    const { models } = stackModels({
      related: () => true,
      relation: () => BUILDS_A,
    });
    await open('one', { 'a.txt': 'a\n' }, 'One');
    await open('two', { 'b.txt': 'b\n' }, 'Two');
    await drain(t, models);
    const db = drizzle(t.env.DB, { schema });
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{ id: string }>())!.id;
    const params = { repositoryId: repoId, landTarget: 'main' };
    const [x, y] = await Promise.all([
      executeReconcile({ env: t.env, db, step, models }, params),
      executeReconcile({ env: t.env, db, step, models }, params),
    ]);
    expect(x + y).toBe(0);
    expect(
      (await events(t, 2)).filter((e) => e.kind === 'stacked')
    ).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn test worker/src/__tests__/stacking.test.ts -t retargeting`
Expected: FAIL: cannot resolve `../stack/reconcile`.

- [ ] **Step 3: Exports and ctx.** In `worker/src/stack/discover.ts` export `stackingPolicy`, `changesFor` and
      `summariesFor` (add `export`). In `worker/src/stack/models.ts` change `workersAiStackModels`' ctx type to
      `{ repositoryId: string; pullRequestId: string | null }` and pass
      `{ pull_request: ctx.pullRequestId ?? '' }` to `aiGateway` and `pullRequestId: ctx.pullRequestId ?? undefined`
      to `recordAiUsage`.

- [ ] **Step 4: Create `worker/src/stack/retarget.ts`**

```ts
import { and, eq, or } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import { prEdges, pullRequests, type PullRequest } from '../db/app.schema';
import { landTargetIs, landTargetOf } from '../lib/land-target';
import { resolutionConfigured } from '../merge/resolution';
import { recordEvent } from '../pulls/events';

/** Starts a reconcile run for a land target (no-op without the Workflow binding). Never throws. */
export async function startReconcile(
  env: CloudflareBindings,
  repositoryId: string,
  landTarget: string
): Promise<void> {
  if (!resolutionConfigured(env)) return;
  try {
    await env.MERGE_RESOLUTION.create({
      id: `reconcile-${crypto.randomUUID()}`,
      params: { reconcile: { repositoryId, landTarget } },
    });
  } catch (e) {
    console.error('[stack] could not start reconcile', repositoryId, e);
  }
}

/**
 * A PR closed or landed: the PRs stacked on its branch go back to its land target now (metadata only), the
 * ordering edges that involved it are dropped, and a reconcile run restacks what's left. Its pair rows are kept
 * (ignored while it's closed), so a reopen restores them.
 */
export async function onPullClosed(
  env: CloudflareBindings,
  db: DrizzleDB,
  pr: PullRequest,
  how: 'closed' | 'landed'
): Promise<void> {
  const target = landTargetOf(pr);
  const children = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, pr.repositoryId),
        eq(pullRequests.state, 'open'),
        eq(pullRequests.baseRef, pr.headRef),
        landTargetIs(target)
      )
    )
    .all();
  for (const c of children) {
    const moved = await db
      .update(pullRequests)
      .set({ baseRef: target, landTarget: target, updatedAt: new Date() })
      .where(
        and(eq(pullRequests.id, c.id), eq(pullRequests.baseRef, pr.headRef))
      )
      .returning({ id: pullRequests.id });
    if (moved.length)
      await recordEvent(db, {
        repositoryId: pr.repositoryId,
        pullRequestId: c.id,
        kind: 'unstacked',
        data: {
          pr: pr.number,
          why:
            how === 'landed'
              ? `#${pr.number} landed.`
              : `#${pr.number} was closed without landing.`,
        },
      });
  }
  await db
    .delete(prEdges)
    .where(
      and(
        eq(prEdges.slot, 'order'),
        or(
          eq(prEdges.prAId, pr.id),
          eq(prEdges.prBId, pr.id),
          eq(prEdges.forPrId, pr.id)
        )
      )
    );
  await startReconcile(env, pr.repositoryId, target);
}
```

- [ ] **Step 5: Create `worker/src/stack/reconcile.ts`**

```ts
import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import { prEdges, pullRequests, type Repository } from '../db/app.schema';
import { findRepoById, gitFor } from '../lib/repos';
import { landTargetIs } from '../lib/land-target';
import { pingingSteps } from '../live/publish';
import type { StepRunner } from '../merge/resolution';
import { MODEL_RETRIES } from '../review/classify';
import { recordEvent } from '../pulls/events';
import { settleStates } from '../pulls/settle';
import { pullStates } from '../pulls/signals';
import { STATE_RANK } from '../pulls/state';
import { stackingPolicy, summariesFor } from './discover';
import { linearize, type OrderEdge } from './linearize';
import { readOrder, type PrSide, type StackModels } from './models';
import { stackTreeView } from './view';

export type ReconcileParams = { repositoryId: string; landTarget: string };

const STACKABLE = new Set(['builds_on', 'must_account_for']);
const MAX_DESCRIPTION = 4 * 1024;
const MAX_SUMMARIES = 4 * 1024;

/**
 * Brings one land target's stacks up to date: drops ordering edges whose PRs moved, closed or landed; linearizes
 * PRs with several prerequisites (Clef chooses an order when nothing else decides it); and retargets each open
 * PR's base_ref to its parent's head branch, or to the land target (compare-and-swap, one event per change).
 * Returns how many PRs were retargeted.
 */
export async function executeReconcile(
  deps: {
    env: CloudflareBindings;
    db: DrizzleDB;
    step: StepRunner;
    models: StackModels;
  },
  params: ReconcileParams,
  prefix = ''
): Promise<number> {
  const { env, db, models } = deps;
  const p = `${prefix}reconcile:`;
  const job = await deps.step.do(`${p}load`, async () => {
    const found = await findRepoById(db, params.repositoryId);
    if (!found) return null;
    const git = gitFor(env, found.repo);
    const tip = await git.resolve(params.landTarget);
    if (!tip) return null;
    const policy = await stackingPolicy(git, tip);
    const open = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, params.repositoryId),
          eq(pullRequests.state, 'open'),
          landTargetIs(params.landTarget)
        )
      )
      .all();
    const refs = await git.refs();
    const states = policy
      ? await pullStates(db, git, params.repositoryId, open, { refs })
      : new Map();
    const prs = await Promise.all(
      open.map(async (pr) => {
        const head = refs.get(`refs/heads/${pr.headRef}`) ?? null;
        return {
          id: pr.id,
          number: pr.number,
          title: pr.title,
          description: pr.body.slice(0, MAX_DESCRIPTION),
          summaries: head
            ? (await summariesFor(db, pr.id, head, [])).slice(0, MAX_SUMMARIES)
            : '',
          headRef: pr.headRef,
          baseRef: pr.baseRef,
          head,
          rank: STATE_RANK[states.get(pr.id)?.state ?? 'ready'],
        };
      })
    );
    return { repo: found.repo, policy, prs };
  });
  if (!job) return 0;
  const step = pingingSteps(env, deps.step, params.repositoryId);
  const byNumber = new Map(job.prs.map((x) => [x.number, x]));
  const byId = new Map(job.prs.map((x) => [x.id, x]));

  if (job.policy) {
    // Keep ordering edges whose three PRs are still open at the heads they were decided at.
    const graph = await step.do(`${p}edges`, async () => {
      const rows = await db
        .select()
        .from(prEdges)
        .where(
          and(
            eq(prEdges.repositoryId, params.repositoryId),
            eq(prEdges.landTarget, params.landTarget)
          )
        )
        .all();
      const kept: OrderEdge[] = [];
      const stale: string[] = [];
      const stackable = new Map<number, number[]>();
      const others: { pre: number; dep: number }[] = [];
      for (const e of rows) {
        const a = byId.get(e.prAId);
        const b = byId.get(e.prBId);
        if (e.slot === 'order') {
          const f = e.forPrId ? byId.get(e.forPrId) : undefined;
          if (
            !a ||
            !b ||
            !f ||
            a.head !== e.aHead ||
            b.head !== e.bHead ||
            f.head !== e.forHead ||
            e.dismissedAt
          ) {
            stale.push(e.id);
            continue;
          }
          const [before, after] = e.prerequisite === 'a' ? [a, b] : [b, a];
          kept.push({
            before: before.number,
            after: after.number,
            forPr: f.number,
          });
          continue;
        }
        if (!a || !b || e.dismissedAt || !e.kind || !e.prerequisite) continue;
        if (e.stage !== 'done' && e.stage !== 'recheck') continue;
        const [pre, dep] = e.prerequisite === 'a' ? [a, b] : [b, a];
        if (STACKABLE.has(e.kind))
          stackable.set(dep.number, [
            ...(stackable.get(dep.number) ?? []),
            pre.number,
          ]);
        else if (e.kind === 'conflicts')
          others.push({ pre: pre.number, dep: dep.number });
      }
      for (let i = 0; i < stale.length; i += 90)
        await db
          .delete(prEdges)
          .where(inArray(prEdges.id, stale.slice(i, i + 90)));
      return { kept, stackable: [...stackable], others };
    });

    const side = (n: number): PrSide => {
      const x = byNumber.get(n)!;
      return {
        number: n,
        title: x.title,
        description: x.description,
        summaries: x.summaries,
        landed: false,
      };
    };
    const policy = job.policy;
    const added = await linearize(
      {
        open: job.prs.filter((x) => x.head).map((x) => x.number),
        stackable: new Map(graph.stackable),
        others: graph.others,
        orders: graph.kept,
      },
      async (x, y, forPr) => {
        const [lo, hi] = x < y ? [x, y] : [y, x];
        try {
          const answer = readOrder(
            await step.do(`${p}order:${lo}:${hi}:${forPr}`, MODEL_RETRIES, () =>
              models.order(policy.model, {
                a: side(lo),
                b: side(hi),
                dependent: side(forPr),
              })
            )
          );
          if (answer.confidence >= policy.confident_above)
            return answer.first === 'a' ? lo : hi;
        } catch (e) {
          console.warn('[stack] order choice failed', lo, hi, forPr, e);
        }
        // Closer to Ready first (higher rank), then the lower number.
        const rl = byNumber.get(lo)!.rank;
        const rh = byNumber.get(hi)!.rank;
        return rl === rh ? lo : rl > rh ? lo : hi;
      }
    );

    if (added.length)
      await step.do(`${p}save-orders`, async () => {
        const now = new Date();
        for (const o of added) {
          const [lo, hi] =
            o.before < o.after ? [o.before, o.after] : [o.after, o.before];
          const a = byNumber.get(lo)!;
          const b = byNumber.get(hi)!;
          const f = byNumber.get(o.forPr)!;
          const reason = `#${o.after} lands after #${o.before} so #${o.forPr} can build on both.`;
          const values = {
            repositoryId: params.repositoryId,
            landTarget: params.landTarget,
            prAId: a.id,
            prBId: b.id,
            slot: 'order' as const,
            aHead: a.head!,
            bHead: b.head!,
            forPrId: f.id,
            forHead: f.head,
            stage: 'done' as const,
            kind: 'ordered_after' as const,
            prerequisite: (o.before === lo ? 'a' : 'b') as 'a' | 'b',
            reason,
            updatedAt: now,
          };
          await db
            .insert(prEdges)
            .values({ id: crypto.randomUUID(), createdAt: now, ...values })
            .onConflictDoUpdate({
              target: [prEdges.prAId, prEdges.prBId, prEdges.slot],
              set: values,
            });
          await recordEvent(db, {
            repositoryId: params.repositoryId,
            pullRequestId: byNumber.get(o.after)!.id,
            kind: 'ordered',
            data: { before: o.before, for_pr: o.forPr, reason },
          });
        }
        return true;
      });
  }

  const changed = await step.do(`${p}retarget`, async () => {
    const git = gitFor(env, job.repo as Repository);
    const refs = await git.refs();
    const view = job.policy
      ? await stackTreeView(db, git, params.repositoryId, {
          branch: params.landTarget,
          authors: false,
        })
      : null;
    const nodes =
      view?.targets.find((t) => t.branch === params.landTarget)?.nodes ?? [];
    const branchOf = new Map(nodes.map((n) => [n.number, n.headRef]));
    let moved = 0;
    for (const pr of job.prs) {
      const parent = nodes.find((n) => n.number === pr.number)?.parent ?? null;
      const branch = parent ? branchOf.get(parent.number) : undefined;
      // Never stack onto a branch that no longer exists.
      const want =
        parent && branch && refs.has(`refs/heads/${branch}`)
          ? branch
          : params.landTarget;
      const current = await db
        .select({ baseRef: pullRequests.baseRef })
        .from(pullRequests)
        .where(eq(pullRequests.id, pr.id))
        .get();
      if (!current || current.baseRef === want) continue;
      const res = await db
        .update(pullRequests)
        .set({
          baseRef: want,
          landTarget: params.landTarget,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(pullRequests.id, pr.id),
            eq(pullRequests.baseRef, current.baseRef),
            eq(pullRequests.state, 'open')
          )
        )
        .returning({ id: pullRequests.id });
      if (!res.length) continue;
      moved++;
      const was = job.prs.find((x) => x.headRef === current.baseRef);
      await recordEvent(db, {
        repositoryId: params.repositoryId,
        pullRequestId: pr.id,
        ...(want !== params.landTarget && parent
          ? {
              kind: 'stacked' as const,
              data: {
                pr: parent.number,
                branch: want,
                kind: parent.kind,
                reason: parent.reason,
              },
            }
          : {
              kind: 'unstacked' as const,
              data: {
                pr: was?.number ?? null,
                why: job.policy
                  ? 'It no longer builds on an open pull request.'
                  : `Stacking is off for ${params.landTarget}.`,
              },
            }),
      });
    }
    return moved;
  });
  if (changed)
    await step.do(`${p}states`, async () => {
      await settleStates(env, db, params.repositoryId);
      return true;
    });
  return changed;
}
```

The `retarget` step's compare-and-swap (`base_ref` must still be what this run read) is what makes two racing
reconciles change a PR once.

- [ ] **Step 6: Wire it up.**
  - `executeStacking`: after the pair loop and before the `auto-merge` step (Task 6), add:

```ts
// Restack the land target with what this run found.
await executeReconcile(
  { env, db, step: deps.step, models },
  { repositoryId: job.repo.id, landTarget: job.landTarget },
  'stack-'
);
```

    (import from `./reconcile`; the prefix keeps step names unique within the stack run).

- `worker/src/merge/workflow.ts`: add `reconcile?: undefined` to each existing variant and a new variant
  `{ reconcile: ReconcileParams; resolutionId?: undefined; sweep?: undefined; classificationId?: undefined; stack?: undefined }`;
  in `run`, before the `else` (resolution) branch:

```ts
    } else if (p.reconcile) {
      const ids = await getSettings(db, this.env, ['ai.review_model']);
      await executeReconcile(
        {
          env: this.env,
          db,
          step: runner,
          models: workersAiStackModels(
            this.env,
            { review: ids['ai.review_model'] },
            { repositoryId: p.reconcile.repositoryId, pullRequestId: null }
          ),
        },
        p.reconcile
      );
```

- `repositoryForPayload` (`worker/src/pulls/settle.ts`): add `reconcile?: { repositoryId: string }` to the
  parameter type and `if (p.reconcile) return p.reconcile.repositoryId;` first.
- `landPull`: after the success `opts.after(settleStates(…))`, add
  `opts.after(onPullClosed(env, db, pr, 'landed'));`.
- PATCH `/pulls/{number}` close: after the update, when `patch.state === 'closed'`, add
  `c.executionCtx.waitUntil(onPullClosed(c.env, c.get('db'), pr, 'closed'));`.

- [ ] **Step 7: Run the tests**

Run: `yarn test worker/src/__tests__/stacking.test.ts worker/src/__tests__/pull-states.test.ts worker/src/__tests__/land-target.test.ts worker/src/__tests__/review.test.ts && yarn typecheck`
Expected: PASS; clean. In the fallback test, if ranks tie (no state recorded for `#1` because its review hadn't
finished when the reconcile loaded), check that the failing run was inserted before `drain`: states are computed
in the reconcile's `load` step.

- [ ] **Step 8: Commit**

```bash
git add worker/src/
git commit -m "Stack: reconcile (prune, linearize, retarget); unwind on close and land

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 9: States: `must_account_for` drives agent followup, plus `rebase_onto` (extending plan 2a in one place)

**Files:**

- Create: `worker/src/stack/contains.ts`
- Modify: `worker/src/pulls/state.ts` (`Reason`, `KINDS`, `reasonState`, `StackReasonContext`, `stackReasons`), `worker/src/pulls/signals.ts` (build the context), `src/lib/pullState.ts` (`reasonText`)
- Test: `worker/src/__tests__/stacking.test.ts`, `worker/src/__tests__/pull-states.test.ts`, `src/lib/pullState.test.ts`

**Interfaces:**

- Produces:
  - `reasonState('must_account_for')` becomes `agent_followup` (plan 2a kept it informational because nothing could mark an edge accounted for). `stackReasons` only emits it for edges neither accounted for nor dismissed (dismissed edges never reach the tree), so an accounted or dismissed edge no longer drives `agent_followup`.
  - `Reason` adds `{ kind: 'rebase_onto'; pr: number; branch: string; why: string }` → `agent_followup`; `must_account_for` adds `branch: string | null` (rebase onto it first when the prerequisite is open).
  - `StackReasonContext = { branchOf?: (pr: number) => string | null; needsRebase?: boolean }`.
  - `stackReasons` skips accounted `must_account_for`, and adds `rebase_onto` when `ctx.needsRebase`.
  - `contains(git: GitService, ancestor: string, descendant: string): Promise<boolean>` (memoized per isolate).

- [ ] **Step 1: Write the failing tests.** In `worker/src/__tests__/pull-states.test.ts` add (import `buildTree`,
      `type EdgeInput` from `../stack/tree`):

```ts
describe('must account for drives agent followup (milestone 2b)', () => {
  const must = (over: Partial<EdgeInput> = {}): EdgeInput => ({
    a: 1,
    b: 2,
    stage: 'done',
    kind: 'must_account_for',
    prerequisite: 'a',
    reason: 'Needs a check.',
    instructions: 'Add it.',
    files: [],
    ...over,
  });
  const stateOf = (e: EdgeInput) =>
    decideState(
      stackReasons(buildTree([1, 2], [e]).get(2)!, { branchOf: () => 'one' })
    ).state;

  it('only while the edge is neither accounted for nor dismissed', () => {
    expect(stateOf(must())).toBe('agent_followup');
    expect(stateOf(must({ accounted: true }))).toBe('ready'); // still stacked on #1: informational
    expect(stateOf(must({ dismissed: true }))).toBe('ready');
  });
});
```

Then in `worker/src/__tests__/stacking.test.ts`, inside `describe('retargeting', …)`, add (import `pullStates` from `../pulls/signals`, `findRepoById`/`gitFor` from
`../lib/repos`):

```ts
it('asks the later prerequisite to rebase first, then the dependent', async () => {
  const { t, open, repo, files } = await repoWithPolicy();
  const { models } = three();
  await openThree(t, open);
  await drain(t, models);
  const db = drizzle(t.env.DB, { schema });
  const states = async () => {
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{ id: string }>())!.id;
    const found = await findRepoById(db, repoId);
    const prs = await db.query.pullRequests.findMany();
    const map = await pullStates(db, gitFor(t.env, found!.repo), repoId, prs);
    return Object.fromEntries(prs.map((p) => [p.number, map.get(p.id)]));
  };
  let st = await states();
  expect(st[2]!.reasons).toContainEqual({
    kind: 'rebase_onto',
    pr: 1,
    branch: 'one',
    why: '#2 lands after #1 so #3 can build on both.',
  });
  expect(st[2]!.state).toBe('agent_followup');
  expect(st[3]!.reasons.map((r) => r.kind)).not.toContain('rebase_onto'); // #2 isn't on #1 yet
  // #2's agent rebases onto #1 (GitOrange never does): now #3 is asked to rebase onto #2.
  repo.refs.set('refs/heads/two', repo.refs.get('refs/heads/one')!);
  await pushTo(t, repo, 'two', { ...files, 'a.txt': 'a\n', 'b.txt': 'b\n' });
  await drain(t, models);
  st = await states();
  expect(st[2]!.reasons.map((r) => r.kind)).not.toContain('rebase_onto');
  expect(st[3]!.reasons).toContainEqual(
    expect.objectContaining({ kind: 'rebase_onto', pr: 2, branch: 'two' })
  );
});
```

In `src/lib/pullState.test.ts` add:

```ts
it('says rebase onto', () => {
  expect(
    reasonText({
      kind: 'rebase_onto',
      pr: 28,
      branch: 'setup-checks',
      why: 'x',
    })
  ).toBe('rebase onto #28 (setup-checks)');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn test worker/src/__tests__/stacking.test.ts -t "rebase first" src/lib/pullState.test.ts`
Expected: FAIL: no `rebase_onto` reason.

- [ ] **Step 3: Create `worker/src/stack/contains.ts`**

```ts
import type { GitService } from '../git/service';

// Commit graphs never change, so an answer for a pair of commits holds forever (per isolate, capped).
const memo = new Map<string, boolean>();
const MAX = 2000;

/** Whether `descendant`'s history contains `ancestor`. */
export async function contains(
  git: GitService,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  if (ancestor === descendant) return true;
  const key = `${ancestor}:${descendant}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const yes = (await git.mergeBase(ancestor, descendant)) === ancestor;
  if (memo.size >= MAX) memo.delete(memo.keys().next().value!);
  memo.set(key, yes);
  return yes;
}
```

- [ ] **Step 4: Extend the rules** in `worker/src/pulls/state.ts` (the one place):
  - `Reason`: add `| { kind: 'rebase_onto'; pr: number; branch: string; why: string }`, and give
    `must_account_for` a `branch: string | null` field.
  - `KINDS`: add `rebase_onto: true`.
  - `reasonState`: move `case 'must_account_for':` out of the informational (`return null`) group, deleting its
    "informs only until plan 2b" comment, into the `agent_followup` group, and add `case 'rebase_onto':` there too:

```ts
    case 'check_failed':
    case 'changes_requested':
    case 'conflicts_unresolved':
    // Not accounted for and not dismissed: stackReasons emits it only then.
    case 'must_account_for':
    case 'rebase_onto':
      return 'agent_followup';
```

    Update plan 2a's pure test "reports must account for without letting it decide the state (until 2b)": rename it
    "must account for needs the agent" and expect `reasonState(must)` to be `'agent_followup'`,
    `decideState([must]).state` to be `'agent_followup'`, and `decideState([must, { kind: 'review_running' }]).state`
    to be `'agent_followup'`.

- Replace `StackReasonContext` and `stackReasons`:

```ts
export type StackReasonContext = {
  /** Head branch of an open PR in the tree (rebase targets). */
  branchOf?: (pr: number) => string | null;
  /** This PR's head doesn't contain its open parent's head, and the parent's own chain is in order. */
  needsRebase?: boolean;
};

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
```

Update plan 2a's tests in `worker/src/__tests__/pull-states.test.ts` that expect exact `must_account_for`
reasons: in the pure "reads the stack tree" test add `branch: null` (no context given). In the signals test "with
stacking on: must account for is reported; the state comes from the rest" (rename it "with stacking on: must
account for needs the agent"), #2's state becomes `agent_followup`, and since #2's head doesn't contain #1's its
expected reasons become
`[{ kind: 'must_account_for', pr: 1, landed: false, instructions: 'Add a setup check.', branch: 'one' }, { kind: 'rebase_onto', pr: 1, branch: 'one', why: 'Needs a check.' }, { kind: 'checks_running', check: null, started: false }, { kind: 'stacked_on', pr: 1 }]`.

- [ ] **Step 5: Build the context** in `pullStates` (`worker/src/pulls/signals.ts`). Before the per-PR loop:

```ts
// Which stacked PRs still need to rebase onto their open parent: parents before children, and a PR is asked
// only once its parent's own chain is in order.
const needsRebase = new Map<number, boolean>();
const branchOf = new Map<number, string>();
for (const t of tree.targets) {
  for (const n of t.nodes) branchOf.set(n.number, n.headRef);
  const byNumber = new Map(t.nodes.map((n) => [n.number, n]));
  const visit = async (n: (typeof t.nodes)[number]): Promise<boolean> => {
    if (needsRebase.has(n.number)) return needsRebase.get(n.number)!;
    needsRebase.set(n.number, false); // cycle guard
    const parent = n.parent ? byNumber.get(n.parent.number) : undefined;
    let needs = false;
    if (parent) {
      const parentHead = refs.get(`refs/heads/${parent.headRef}`);
      const head = refs.get(`refs/heads/${n.headRef}`);
      needs =
        !!parentHead &&
        !!head &&
        !(await visit(parent)) &&
        !(await contains(git, parentHead, head));
    }
    needsRebase.set(n.number, needs);
    return needs;
  };
  for (const n of t.nodes) await visit(n);
}
```

and change the stack reasons line to:

```ts
if (node)
  reasons.push(
    ...stackReasons(node, {
      branchOf: (n) => branchOf.get(n) ?? null,
      needsRebase: needsRebase.get(node.number) ?? false,
    })
  );
```

(import `contains` from `../stack/contains`).

- [ ] **Step 6: UI text** in `src/lib/pullState.ts` `reasonText`: add

```ts
    case 'rebase_onto':
      return `rebase onto #${n(r.pr)} (${String(r.branch)})`;
```

and change `must_account_for` to
``return `must account for #${n(r.pr)}${r.branch ? `, after rebasing onto ${String(r.branch)}` : ''}`;``.
Remove `'must_account_for'` (and its comment) from `INFO`, so it shows in the merge-box banner and timeline as a
reason that holds the PR; in `src/lib/pullState.test.ts` flip
`expect(blocking({ kind: 'must_account_for', pr: 1, landed: false })).toBe(false)` to `.toBe(true)`. The
`reasonText` expectation for `must_account_for` has no `branch`, so its text is unchanged.

- [ ] **Step 7: Run the tests**

Run: `yarn test worker/src/__tests__/stacking.test.ts worker/src/__tests__/pull-states.test.ts src/lib/pullState.test.ts && yarn typecheck`
Expected: PASS; clean.

- [ ] **Step 8: Commit**

```bash
git add worker/src/ src/lib/
git commit -m "PR states: unaccounted must-account-for needs the agent; rebase_onto for stacked PRs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 10: Maintainer controls: Unstack and Dismiss

**Files:**

- Modify: `worker/src/stack/retarget.ts` (`dismissEdge`), `worker/src/routers/pulls-router.ts` (two routes), `src/lib/uiApi.ts`, `src/components/StackSidebar.tsx`
- Test: `worker/src/__tests__/stacking.test.ts`

**Interfaces:**

- Produces:
  - `dismissEdge(env, db, pr: PullRequest, other: number, actorId: string): Promise<'dismissed' | 'not_found'>`: marks every undismissed edge between the two (pair and order rows) dismissed; if `pr` is stacked on `other`'s branch, retargets it to the land target (`unstacked` event); records `dismissed` (`{ pr: other }`, with actor); starts a reconcile.
  - `POST /{owner}/{repo}/pulls/{number}/stack/unstack` (write permission): dismisses the parent edge. 400 when not stacked.
  - `POST /{owner}/{repo}/pulls/{number}/stack/dismiss` body `{ pr: number }` (write permission). 404 without such an edge.
  - `api.unstack(o, n, num)`, `api.dismissStackEdge(o, n, num, other)`.

- [ ] **Step 1: Write the failing tests.** In `worker/src/__tests__/stacking.test.ts`, let `repoWithPolicy` take a
      visibility: `async function repoWithPolicy(policy = POLICY(), visibility: 'private' | 'internal' = 'private')`
      and use it in the repo creation. Add:

```ts
describe('maintainer controls', () => {
  it('unstacks and dismisses with merge permission only', async () => {
    const { t, admin, open } = await repoWithPolicy(POLICY(), 'internal');
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    expect(
      await t.env.DB.prepare(
        'SELECT base_ref AS b FROM pull_requests WHERE number = 2'
      ).first()
    ).toEqual({ b: 'setup' });
    const bob = await addMember(t, admin, 'bob'); // can read the internal repo, can't merge
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/2/stack/unstack', {
          cookie: bob,
          method: 'POST',
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/2/stack/unstack', {
          cookie: admin,
          method: 'POST',
        })
      ).status
    ).toBe(200);
    await settle(t);
    expect(
      await t.env.DB.prepare(
        'SELECT base_ref AS b FROM pull_requests WHERE number = 2'
      ).first()
    ).toEqual({ b: 'main' });
    const ev = await events(t, 2);
    expect(ev.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['dismissed', 'unstacked'])
    );
    // Restacking leaves it alone, and the dismissed must-account-for no longer blocks landing.
    await drain(t, models);
    expect(
      await t.env.DB.prepare(
        'SELECT base_ref AS b FROM pull_requests WHERE number = 2'
      ).first()
    ).toEqual({ b: 'main' });
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/2/merge', {
          cookie: admin,
          json: {},
        })
      ).status
    ).toBe(200);
  });

  it('dismisses a waits-on edge', async () => {
    const { t, admin, open } = await repoWithPolicy();
    const { models } = stackModels();
    await open('one', { 'notes.txt': 'one\nTWO\nthree\n' }, 'One');
    await open('two', { 'notes.txt': 'one\n2\nthree\n' }, 'Two');
    await drain(t, models);
    const before = (await (
      await call(t, '/api/repos/octocat/app/pulls/2', { cookie: admin })
    ).json()) as {
      stack: { waitsOn: { number: number }[] };
    };
    expect(before.stack.waitsOn.map((d) => d.number)).toEqual([1]);
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/2/stack/dismiss', {
          cookie: admin,
          json: { pr: 1 },
        })
      ).status
    ).toBe(200);
    const after = (await (
      await call(t, '/api/repos/octocat/app/pulls/2', { cookie: admin })
    ).json()) as {
      stack: { waitsOn: unknown[] };
    };
    expect(after.stack.waitsOn).toEqual([]);
    expect(
      (
        await call(t, '/api/repos/octocat/app/pulls/2/stack/dismiss', {
          cookie: admin,
          json: { pr: 9 },
        })
      ).status
    ).toBe(404);
  });

  it('keeps a dismissal when a head moves', async () => {
    const { t, admin, open, repo, files } = await repoWithPolicy();
    const { models } = stackModels();
    await open('one', { 'notes.txt': 'one\nTWO\nthree\n' }, 'One');
    await open('two', { 'notes.txt': 'one\n2\nthree\n' }, 'Two');
    await drain(t, models);
    await call(t, '/api/repos/octocat/app/pulls/2/stack/dismiss', {
      cookie: admin,
      json: { pr: 1 },
    });
    await pushTo(t, repo, 'two', { ...files, 'notes.txt': 'one\n22\nthree\n' });
    await drain(t, models);
    expect(
      (await t.env.DB.prepare(
        "SELECT dismissed_at AS d FROM pr_edges WHERE slot = 'pair'"
      ).first<{ d: number | null }>())!.d
    ).not.toBeNull();
  });
});
```

(import `addMember` from `./helpers/app`).

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn test worker/src/__tests__/stacking.test.ts -t "maintainer controls"`
Expected: FAIL: 404 for the new routes.

- [ ] **Step 3: `dismissEdge`** in `worker/src/stack/retarget.ts`:

```ts
/** Dismisses every edge between `pr` and #`other` (a maintainer's decision; survives new heads). */
export async function dismissEdge(
  env: CloudflareBindings,
  db: DrizzleDB,
  pr: PullRequest,
  other: number,
  actorId: string
): Promise<'dismissed' | 'not_found'> {
  const o = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, pr.repositoryId),
        eq(pullRequests.number, other)
      )
    )
    .get();
  if (!o) return 'not_found';
  const between = or(
    and(eq(prEdges.prAId, pr.id), eq(prEdges.prBId, o.id)),
    and(eq(prEdges.prAId, o.id), eq(prEdges.prBId, pr.id))
  );
  const hit = await db
    .update(prEdges)
    .set({
      dismissedAt: new Date(),
      dismissedById: actorId,
      updatedAt: new Date(),
    })
    .where(and(between, isNull(prEdges.dismissedAt)))
    .returning({ id: prEdges.id });
  if (!hit.length) return 'not_found';
  await recordEvent(db, {
    repositoryId: pr.repositoryId,
    pullRequestId: pr.id,
    kind: 'dismissed',
    data: { pr: other },
    actorId,
  });
  const target = landTargetOf(pr);
  if (pr.baseRef === o.headRef && pr.baseRef !== target) {
    const moved = await db
      .update(pullRequests)
      .set({ baseRef: target, landTarget: target, updatedAt: new Date() })
      .where(
        and(eq(pullRequests.id, pr.id), eq(pullRequests.baseRef, o.headRef))
      )
      .returning({ id: pullRequests.id });
    if (moved.length)
      await recordEvent(db, {
        repositoryId: pr.repositoryId,
        pullRequestId: pr.id,
        kind: 'unstacked',
        data: { pr: other, why: 'A maintainer unstacked it.' },
        actorId,
      });
  }
  await startReconcile(env, pr.repositoryId, target);
  return 'dismissed';
}
```

(import `isNull` from `drizzle-orm`).

- [ ] **Step 4: Routes** in `worker/src/routers/pulls-router.ts` (after `retryStackRoute`):

```ts
const unstackRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/stack/unstack',
  tags: ['Pull requests'],
  request: { params: numberParams },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), 'Unstacked'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
  },
});
pullsRouter.openapi(unstackRoute, async (c) => {
  // A maintainer's decision, like approving a flag: merge permission, and never offered to agents (no MCP tool).
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to do that' }, 403);
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr || pr.state !== 'open') return c.json({ error: 'Not Found' }, 404);
  const node = await stackViewFor(c.get('db'), c.get('git'), pr);
  if (!node?.parent)
    return c.json({ error: 'This pull request is not stacked' }, 400);
  await dismissEdge(
    c.env,
    c.get('db'),
    pr,
    node.parent.number,
    c.get('user')!.id
  );
  return c.json({ ok: true as const }, 200);
});

const dismissRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/stack/dismiss',
  tags: ['Pull requests'],
  request: {
    params: numberParams,
    body: {
      content: {
        'application/json': {
          schema: z.object({ pr: z.number().int().min(1) }),
        },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), 'Dismissed'),
    ...json403Response,
    ...json404Response,
  },
});
pullsRouter.openapi(dismissRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to do that' }, 403);
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr || pr.state !== 'open') return c.json({ error: 'Not Found' }, 404);
  const result = await dismissEdge(
    c.env,
    c.get('db'),
    pr,
    c.req.valid('json').pr,
    c.get('user')!.id
  );
  if (result === 'not_found')
    return c.json({ error: 'No dependency on that pull request' }, 404);
  return c.json({ ok: true as const }, 200);
});
```

- [ ] **Step 5: UI.** In `src/lib/uiApi.ts` add:

```ts
  unstack: (o: string, n: string, num: number) =>
    apiFetch(`${r(o, n)}/pulls/${num}/stack/unstack`, { method: 'POST' }),
  dismissStackEdge: (o: string, n: string, num: number, pr: number) =>
    apiFetch(`${r(o, n)}/pulls/${num}/stack/dismiss`, { method: 'POST', json: { pr } }),
```

In `src/components/StackSidebar.tsx`, add two mutations next to `retry`:

```tsx
const refresh = () =>
  qc.invalidateQueries({ queryKey: ['repo', o, repo.name] });
const unstack = useMutation({
  mutationFn: () => api.unstack(o, repo.name, number),
  onSuccess: refresh,
});
const dismiss = useMutation({
  mutationFn: (pr: number) => api.dismissStackEdge(o, repo.name, number, pr),
  onSuccess: refresh,
});
const control = (label: string, onClick: () => void, title: string) =>
  repo.permissions.write ? (
    <button
      className="btn-link ml-1"
      title={title}
      disabled={unstack.isPending || dismiss.isPending}
      onClick={onClick}
    >
      {label}
    </button>
  ) : null;
```

Then append `{control('Unstack', () => unstack.mutate(), 'Retarget to the land target and stop building on it')}`
inside the "Builds on" paragraph, and `{control('Dismiss', () => dismiss.mutate(d.number), 'Stop waiting on it')}`
inside each waits-on paragraph and each must-change-for block. Show `unstack.error`/`dismiss.error` with
`errorMessage` like `retry.error`.

- [ ] **Step 6: Run the tests**

Run: `yarn test worker/src/__tests__/stacking.test.ts && yarn typecheck`
Expected: PASS; clean.

- [ ] **Step 7: Commit**

```bash
git add worker/src/ src/
git commit -m "Stack: maintainers can unstack a PR or dismiss a dependency (merge permission, web only)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 11: Surfaces: MCP, tree, timeline, Approvals

**Files:**

- Modify: `worker/src/mcp/pull-tools.ts` (`dep`, `stackJson`, tool descriptions), `worker/src/review/inbox.ts`, `worker/src/routers/approvals-router.ts`, `src/lib/uiApi.ts`, `src/lib/approvals.ts`, `src/components/{StackTree,StackSidebar,PullEvents}.tsx`, `src/pages/Approvals.tsx`
- Test: `worker/src/__tests__/mcp.test.ts`, `worker/src/__tests__/stacking.test.ts`

**Interfaces:**

- Produces:
  - MCP `stack`: each dependency has `accounted`; `must_account_for` entries add `rebase_first` (the prerequisite's branch while open); `parent` of kind `ordered_after` carries `for_pr`. `gitorange_get_pull_request` has `land_target` (Task 2).
  - Approvals items add `stackStale: { pr: number; since: string }[]` (unaccounted, undismissed `must_account_for` with no change for 24 hours) and `stackUnchecked: number[]` (failed pairs).
  - Timeline renders `stacked`, `unstacked`, `ordered`, `must_account_for`, `accounted_for`, `dismissed`.

- [ ] **Step 1: Write the failing tests.**
  - In `worker/src/__tests__/mcp.test.ts`'s `describe('stacking tools', …)`, extend the existing test: after the
    `gitorange_get_pull_request` call, also expect `JSON.parse(pr.content[0].text)` to match
    `{ base: 'main', land_target: 'main' }`.
  - In `worker/src/__tests__/stacking.test.ts` add:

```ts
describe('stack surfaces', () => {
  it('lists stale must-account-for blocks and failed pairs on Approvals', async () => {
    const { t, admin, open } = await repoWithPolicy();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    await t.env.DB.prepare('UPDATE pr_edges SET updated_at = 0').run();
    const items = (await (
      await call(t, '/api/approvals', { cookie: admin })
    ).json()) as {
      pull: { number: number };
      stackStale: { pr: number }[];
      stackUnchecked: number[];
    }[];
    expect(items.find((i) => i.pull.number === 2)).toMatchObject({
      stackStale: [{ pr: 1 }],
      stackUnchecked: [],
    });
  });

  it('shows stack events on the PR', async () => {
    const { t, admin, open } = await repoWithPolicy();
    const { models } = stackModels({
      related: () => true,
      relation: () => MUST,
    });
    await open('setup', SETUP_CHECKS, 'Setup checks');
    await open('usage', USAGE, 'Usage and cost');
    await drain(t, models);
    const d = (await (
      await call(t, '/api/repos/octocat/app/pulls/2', { cookie: admin })
    ).json()) as {
      events: { kind: string }[];
      stack: { mustAccountFor: { accounted: boolean }[] };
    };
    expect(d.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['must_account_for', 'stacked'])
    );
    expect(d.stack.mustAccountFor).toMatchObject([{ accounted: false }]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn test worker/src/__tests__/stacking.test.ts -t "stack surfaces" worker/src/__tests__/mcp.test.ts`
Expected: FAIL: no `stackStale` in Approvals items. (The events test may already pass; keep it as a guard.)

- [ ] **Step 3: MCP.** In `worker/src/mcp/pull-tools.ts`:

```ts
const dep = (d: Dependency) => ({
  number: d.number,
  kind: d.kind,
  reason: d.reason,
  landed: d.landed,
  accounted: d.accounted,
  files: d.files,
  ...(d.kind === 'ordered_after' ? { for_pr: d.forPr } : {}),
});
```

`stackJson` takes the node and a `branchOf: (n: number) => string | null` and maps `must_account_for` to
`{ ...dep(d), instructions: d.instructions, instructions_note: INSTRUCTIONS_NOTE, rebase_first: d.landed ? null : branchOf(d.number) }`.
In `gitorange_get_pull_tree` pass `(n) => t.nodes.find((x) => x.number === n)?.headRef ?? null`; in
`gitorange_get_pull_request` load the target's tree once (`stackTreeView(ctx.db, git, repo.id, { branch: landTargetOf(pr), authors: false })`)
for the same lookup. Update both tool descriptions: "A stacked pull request's base is its parent's branch
(land_target is where it lands). must_account_for blocks merging until GitOrange re-checks a new commit and marks
it accounted; rebase_first names the branch to rebase onto first. Only a person can dismiss a dependency."

- [ ] **Step 4: Approvals entries** in `worker/src/review/inbox.ts`. Add (import `alias` from
      `drizzle-orm/sqlite-core`, `and`, `isNull`, `lt`, `or` from `drizzle-orm`, `prEdges`):

```ts
/** A must-account-for block with no change for this long shows on Approvals. */
const STALE_MS = 24 * 3600 * 1000;
```

After `const recorded = …`:

```ts
const pa = alias(pullRequests, 'pa');
const pb = alias(pullRequests, 'pb');
const stackRows = await db
  .select({
    aId: prEdges.prAId,
    bId: prEdges.prBId,
    aNumber: pa.number,
    bNumber: pb.number,
    stage: prEdges.stage,
    prerequisite: prEdges.prerequisite,
    updatedAt: prEdges.updatedAt,
  })
  .from(prEdges)
  .innerJoin(pa, eq(pa.id, prEdges.prAId))
  .innerJoin(pb, eq(pb.id, prEdges.prBId))
  .where(
    and(
      eq(prEdges.slot, 'pair'),
      isNull(prEdges.dismissedAt),
      or(
        eq(prEdges.stage, 'failed'),
        and(
          eq(prEdges.kind, 'must_account_for'),
          isNull(prEdges.accountedForAt),
          lt(prEdges.updatedAt, new Date(Date.now() - STALE_MS))
        )
      )
    )
  )
  .all();
const openIds = new Set(ids);
const stale = new Map<string, { pr: number; since: string }[]>();
const unchecked = new Map<string, number[]>();
const push = <T>(m: Map<string, T[]>, k: string, v: T) =>
  m.set(k, [...(m.get(k) ?? []), v]);
for (const r of stackRows) {
  if (r.stage === 'failed') {
    if (openIds.has(r.aId)) push(unchecked, r.aId, r.bNumber);
    if (openIds.has(r.bId)) push(unchecked, r.bId, r.aNumber);
    continue;
  }
  const [pre, dep] =
    r.prerequisite === 'a' ? [r.aNumber, r.bId] : [r.bNumber, r.aId];
  if (openIds.has(dep))
    push(stale, dep, { pr: pre, since: r.updatedAt.toISOString() });
}
```

Add `stackStale` and `stackUnchecked` to `Item`, include a PR when either is non-empty, and output
`stackStale: stale.get(i.pr.id) ?? []`, `stackUnchecked: unchecked.get(i.pr.id) ?? []`. In
`worker/src/routers/approvals-router.ts` add to `itemSchema`:

```ts
  /** Must account for #pr, with nothing new since `since` (24 hours or more). */
  stackStale: z.array(z.object({ pr: z.number(), since: z.string() })),
  /** Other pull requests it couldn't be checked against. */
  stackUnchecked: z.array(z.number()),
```

- [ ] **Step 5: UI.**
  - `src/lib/uiApi.ts`: `ApprovalItem` adds `stackStale: { pr: number; since: string }[]; stackUnchecked: number[];`.
  - `src/lib/approvals.ts` `approvalCount`: `+ i.stackStale.length + (i.stackUnchecked.length ? 1 : 0)`.
  - `src/pages/Approvals.tsx` `Item`: for each `stackStale` entry a `flash flash-warn` row "Still must account
    for #N (nothing new since {timeAgo(since)})" with a link to the PR; for `stackUnchecked` a row "Couldn't check
    against #a, #b" with a button calling `api.retryStack(owner, name, n)` through `act('stack', …)`.
  - `src/components/PullEvents.tsx` `PullEventItem`: before `return null`, render the stack kinds with
    `GitBranchIcon` (`stacked`, `unstacked`, `ordered`), `AlertIcon` (`must_account_for`), `CheckIcon`
    (`accounted_for`) and `XIcon` (`dismissed`) badges and these texts (link `#N` to `/${fullName}/pull/N`; the
    component gains a `repoPath: string` prop, passed from `PullView` as `` `/${repo.fullName}` ``):
    - `stacked`: "Stacked on #N (`branch`): {reason}"
    - `unstacked`: "Unstacked{from #N}: {why}"
    - `ordered`: "Lands after #N so #M can build on both"
    - `must_account_for`: "Must account for #N: {reason}" and, below, `rebase_first` ? "Rebase onto `branch`
      first." and the instructions as text, with the note "Generated by GitOrange; advisory."
    - `accounted_for`: "Accounted for #N: {reason}"
    - `dismissed`: "{actor} dismissed the dependency on #N"
    - each followed by `timeAgo(e.createdAt)`.
  - `src/components/StackTree.tsx` / `StackSidebar.tsx`: an `ordered_after` parent reads "lands after #N so
    #forPr can build on both"; an accounted must-account-for shows a `Label--success` "accounted for" instead of
    the warning styling.

- [ ] **Step 6: Typecheck and test**

Run: `yarn typecheck && yarn test worker/src/__tests__/stacking.test.ts worker/src/__tests__/mcp.test.ts worker/src/__tests__/review.test.ts`
Expected: clean; PASS.

- [ ] **Step 7: See it in the browser.** Run `yarn dev`, enable `stacking` in a repository's
      `.gitorange/review.yml`, open three pull requests where the third builds on the first two, and check: the
      tree shows the chain (#2 under #1, #3 under #2), the PR page timeline shows ordered/stacked events, the
      sidebar's Unstack and Dismiss buttons appear only with write access and work, the merge box lists "rebase
      onto" for #2, and Approvals shows nothing new until a block goes stale. If the dev AI binding is unavailable,
      verify with the API and the tests, and say so in the PR description.

- [ ] **Step 8: Commit**

```bash
git add worker/src/ src/
git commit -m "Stack surfaces: MCP accounting and rebase hints, timeline events, Approvals entries

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

---

### Task 12: Docs and final verification

**Files:**

- Modify: `docs/auto-merge.md`, `docs/architecture.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: `docs/auto-merge.md`** `## Stacking`: replace "nothing is retargeted or blocked yet" with what
      milestone 2 does: retargeting (base vs land target, metadata only, never a push), linearizing (with the
      #28/#29/#31 example and the order rule), must account for (instructions on the timeline, re-check on each new
      commit, blocks merging), Unstack/Dismiss (merge permission, web only), and the cost line: "plus one Clef call per
      pair of unrelated prerequisites to order, and one GLM-5.3 re-check per new commit of a PR that must account for
      another."

- [ ] **Step 2: `docs/architecture.md`.** Extend "Stacking": `land_target` vs `base_ref`; reconcile (inline in the
      stack run, `reconcile` payload after close/land); `pr_edges.slot`; `stackGate` in `landPull`/`autoMergeStatus`;
      `rebase_onto` in `worker/src/pulls/state.ts`.

- [ ] **Step 3: `README.md`.** Update the Stack tree bullet: "…GitOrange stacks a dependent pull request on the one
      it builds on, puts several prerequisites in one line, and holds a pull request that must change for another
      until a re-check says it did."

- [ ] **Step 4: `CLAUDE.md`.** Append to the Stacking note:

```markdown
Milestone 2: `pull_requests.land_target` (nullable; null means `base_ref`) is where a PR lands (always read via
`landTargetOf`/`landTargetIs`, written on create and every retarget; readers of "where this lands" use it,
diffs use `base_ref`). `executeReconcile` (`stack/reconcile.ts`) prunes/linearizes (`pr_edges.slot = 'order'`,
kind `ordered_after`) and retargets `base_ref` (metadata only, CAS); `stackGate` blocks `landPull`. Tests drive
`executeReconcile` with fake `StackModels` (`order`, `recheck`).
```

- [ ] **Step 5: Full verification**

Run: `yarn format && yarn typecheck && yarn test`
Expected: formatting applied, typecheck clean, all tests pass. Paste the final test summary line into the PR
description.

- [ ] **Step 6: Commit**

```bash
git add -A docs README.md CLAUDE.md
git commit -m "Docs: retarget, linearize and block (milestone 2b)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Drmt7QkTW5J536ENWCrdg9"
```

- [ ] **Step 7: Open the PR** (only after the user asks): push `stack-tree-m2` to `origin`, open it with the
      `gitorange_create_pull_request` MCP tool (`choyiny/gitorange`, base `stack-tree` while #36 is open, else
      `main`), and follow it with `gitorange_get_pull_request`. Never push to the `github` remote.

## Notes carried from executing plan 2a

- `pr_events` ordering: `eventsFor` orders by `computed_at`, then rowid. Every event 2b records (stacked, unstacked,
  ordered, …) must set `computed_at` (milliseconds), or it sorts first.
- `GET /api/approvals` is paginated since 2a: it returns `{ items, count, nextCursor }` (query `limit`, `cursor`).
  Any 2b test or code that reads it must use `.items` (the plan's Approvals test around the Task 11 section still
  treats it as an array).
- `checkVerdict` now considers only the latest run per (workflow, event), treats skipped runs/jobs as passing, except
  a required job skipped in a run that concluded failure/cancelled (failed) or is still running (waiting).
- `settleStates(env, db, repositoryId, { branch })` can be scoped to one target branch; Workflow-end settles are
  scoped via `settleAfterPayload`. 2b's reconcile/retarget runs should settle both the old and the new target when
  a PR is retargeted.
