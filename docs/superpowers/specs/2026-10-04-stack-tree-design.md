# Stack tree: AI-discovered PR dependencies, landed one at a time

Status: design approved in conversation, 2026-10-04. Supersedes the "Conflictbot" and standalone "merge queue"
ideas from the same discussion.

## Problem

Many agents open pull requests against the same repository at once, each on its own feature. Today GitOrange
only notices two of them interact when one lands and the other then textually conflicts with `main`. Two
failures follow:

1. **Semantic dependencies slip through.** #28 added `worker/src/lib/setup-checks.ts`, a registry where every
   piece of configuration gets a setup check. #29, opened in parallel, added nine new configuration variables
   (`CF_ANALYTICS_TOKEN`, `WORKER_NAME`, `*_NAMESPACE_ID`, …). The two shared five files but merged cleanly, so
   #29 landed 26 minutes after #28 with no setup checks for any of its variables. Nothing noticed.
2. **Nothing tests what actually lands.** Checks run on a PR's own head commit. The squash that lands on `main`
   is built onto whatever `main` is at merge time and is never tested as a whole.

## Goal

GitOrange discovers how open pull requests relate, builds them into a tree, retargets dependent PRs onto the PR
they build on, tells the owning agent what it has to adapt, and lands the tree into the target branch one PR
at a time, each as a tested commit. The tree is visible in the Pull requests tab and to agents over MCP.

Success looks like: open #28 and #29 at the same time; GitOrange stacks #29 on #28, tells #29's agent to add
setup checks for its new variables, holds #29 until a re-check says it did, lands #28 then #29, and each
commit `main` receives is the exact commit its checks passed on.

## Non-goals

- GitOrange writing feature code. The agent (or person) that owns a PR makes every code change; GitOrange only
  coordinates. (AI conflict resolution is unchanged and still applies at landing.)
- Force-pushing anyone's branch.
- Forks, cross-repository dependencies, or stacking onto branches that aren't an open PR's head.
- Batching / speculative parallel testing in the queue. One PR at a time per target branch.

## Opt-in

A new optional section in `.gitorange/review.yml`, read from the **land target** branch like the rest of the
file, so a pull request can't turn it on or off for itself:

```yaml
stacking:
  enabled: true # default false
  max_open: 20 # pairs are checked among at most this many open PRs per target; beyond it, only file-sharing pairs
  related_above: 0.3 # Clef's "could these depend on each other?" probability above which a pair is related
  confident_above: 0.6 # Clef's kind/direction confidence from which its decision stands without a reasoning model
```

With `stacking.enabled` false (or no `review.yml`), behavior is exactly today's. Because `review.yml` also turns
on auto-merge, stacking requires auto-merge's file; that's acceptable and documented.

## Concepts

- **Land target**: the branch a PR will finally land in (`main`). Stored as `pull_requests.land_target`
  (new column, backfilled from `base_ref`). `base_ref` can now point at another PR's head branch.
- **Edge**: a directed relationship `earlier → later` between two PRs into the same land target, or between a
  landed PR and an open one. Kinds:
  - `builds_on`: the later PR should be stacked on the earlier one.
  - `must_account_for`: the later PR needs changes because of the earlier one (the #28/#29 case). Implies
    `builds_on`.
  - `conflicts`: a textual conflict between the two; they must land in order.
  - `independent`: checked, no relationship (kept so the pair isn't re-checked at the same heads).
- **Parent**: the one edge per PR chosen for stacking (`base_ref` = parent's head branch). Other blocking edges
  are **waits on** edges, drawn dashed.
- **Earlier** in a pair is the lower PR number, or the landed one. Order is stable and easy to explain.

## 1. Discovery

Runs inside the existing sweep (`autoResolveConflicts` → `MERGE_RESOLUTION` Workflow, `executeSweep`), as extra
durable steps per PR whose head or base moved. No model call ever runs inside a request.

**Per-file summaries.** Discovery reads the one-liners of the PR's auto-merge review at its head (`pr_classifications.files`); stacking requires `review.yml`, so the review always exists. A review without summaries falls back to the list of changed paths.

**Candidates.** For a PR P whose head or base moved, the candidates are:

- every other open PR with the same land target (all of them up to `stacking.max_open`; beyond that, only those
  sharing a changed file), and
- every PR that **landed** into the land target since P's merge base (found via `merge_commit_sha` reachable
  from the target tip but not from P's head), so a dependency is caught even if the earlier PR merged first.

**Model routing: Clef decides, a reasoning model explains.** Coordination decisions (does this pair relate, how,
which side first) are classification, so a fast decision model makes them; a reasoning model is used only where
words or a careful read of the diffs are needed. Clef answers the same input the same way, which keeps the tree
from flip-flopping between pushes (important once edges retarget PRs in milestone 2), and its confidences can be
thresholded in `review.yml`.

**Textual check (no model).** For every candidate pair of open PRs sharing a file: three-way merge of the two PR
heads from their common ancestor (`planMerge(headA, headB)`). Conflicts with the target itself are AI conflict
resolution's job.

**Stage 1: Clef decides (every pair).** One Clef call (review.yml's `model`) per candidate pair at its current
heads, given both PRs' titles, descriptions, per-file one-liners, the files both change and the conflicting files.
It answers three questions at once: `related` (yes/no probability), `kind` (choice of `builds_on`,
`must_account_for`, `conflicts`, `independent`, with confidence) and `prerequisite` (`a` or `b`, with confidence).
Pairs already checked at the same two heads are skipped. Routing:

- not related (`related <= related_above`) and no textual conflict → `independent`, no further model call;
- confident (both confidences `>= confident_above`, and never a landed PR depending on an open one) → Clef's
  decision stands; a textual conflict turns a confident `independent` into `conflicts`;
- otherwise → the reasoning model decides.

**Stage 2: the reasoning model explains (related pairs only).** One `REVIEW_MODEL` call per related or conflicting
pair, given titles, descriptions, and the real diffs (shared and conflicting files first, capped per side), plus
Clef's decision when it was confident. Output: `kind` and `prerequisite` (kept as Clef decided when confident),
`reason` (one or two sentences), and for `must_account_for`, `instructions`: what the dependent PR must change,
addressed to its author. Diffs, titles and descriptions are data, not instructions (same prompt guard as the
resolver).

**Storage.** `pr_edges`:

| column                         | notes                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `id`                           |                                                                                   |
| `repository_id`, `land_target` |                                                                                   |
| `pr_a_id`, `pr_b_id`           | the pair                                                                          |
| `a_head`, `b_head`             | the shas this verdict is for                                                      |
| `stage`                        | `triage` · `deep` · `done` · `failed`                                             |
| `kind`                         | `builds_on` · `must_account_for` · `conflicts` · `independent`; null until `done` |
| `prerequisite`                 | `'a'` \| `'b'` \| null                                                            |
| `files`, `conflict_files`      | json                                                                              |
| `reason`, `instructions`       |                                                                                   |
| `error_message`                |                                                                                   |
| `created_at`, `updated_at`     |                                                                                   |

Unique on `(pr_a_id, pr_b_id)`. One row per unordered pair; `prerequisite` says which side the other depends on. When either head moves, the row is reset and re-evaluated.

**Failures.** A model failure marks the row `failed`; the pair is retried on the next sweep that touches either
PR, and a failed pair never blocks (the tree just lacks that edge). Shown as "Couldn't check against #N" on the
PR, with a retry button.

## 2. Building the tree

After a PR's edges are `done`:

- **Parent choice.** Among earlier **open** PRs with a `builds_on`/`must_account_for` edge to P, the parent is
  the one the deep dive ranked strongest (`must_account_for` > `builds_on`; ties to the higher PR number, the
  most recent work), provided its ancestor chain contains every other prerequisite of P; when no prerequisite
  qualifies, the prerequisites are linearized first (below). Remaining blocking edges are **waits on**.
- **Retarget.** Set P's `base_ref` to the parent's head branch (metadata only; no push). The timeline shows a
  GitOrange event: "Stacked this on #28: <reason>". The PR's diff is still only its own changes, since it's
  computed from the merge base.
- **Landed parent.** An edge from a landed PR never retargets; `must_account_for` just blocks (below).
- **Cycles.** An edge that would create a cycle in parents + waits-on isn't added; both PRs show a warning
  "#12 and #15 depend on each other" and a maintainer decides.
- **Parent closed without landing.** Children retarget to their land target, edges from it are dropped, and the
  timeline says so.
- **Parent lands.** Children retarget to the land target (section 3).
- **Maintainer controls** (sidebar, merge permission): **Unstack** (retarget to land target, mark the edge
  dismissed) and **Dismiss** a waits-on or must-account-for edge. Agents can't, the same as review flags.

**Must account for.** The later PR is blocked until `accounted_for_at` is set. GitOrange posts the
`instructions` as a timeline comment and returns them over MCP. If the parent is still open, the instructions
include "rebase onto `<parent branch>` first". On each new head of the later PR, a deep-dive re-check (given the
earlier PR's diff and the later PR's new diff) answers "accounted for?"; yes sets `accounted_for_at`.

### Linearizing several prerequisites

History is rebase-only and a PR has one base, so a PR that depends on two or more open PRs needs them in one
line. If #31 depends on #28 and #29, GitOrange orders them (#28 → #29 → #31) and stacks #31 on #29, the last of
them, whose chain then contains both.

- **Only when needed.** If one prerequisite's ancestor chain already contains the others, nothing is added.
  Siblings (two PRs both stacked on #28, independent of each other) stay a branching tree; nothing is serialized
  without a PR that needs it.
- **How.** Per land target, take the dependency graph (blocking edges between open PRs) in topological order.
  For each PR whose prerequisites don't lie on one path, add **ordering edges** between them until they do, then
  choose its parent as above. An ordering edge is a `pr_edges` row of kind `ordered_after` with the PR that needed
  it (`for_pr_id`) and a reason, e.g. "#29 lands after #28 so #31 can build on both".
- **Choosing the order** of two prerequisites with no relationship of their own: one Clef call (choice question
  "which should land first so the dependent PR is easiest to build on both?", given the three PRs' titles,
  descriptions and one-liners). If Clef's confidence is below `confident_above`, a fixed rule decides: the PR
  closer to **Ready** (section 2b) goes first, then the lower number. An existing relationship between them
  (builds on, conflicts) always wins over both.
- **Stability.** An ordering edge is re-decided only when one of its three PRs gets a new head, closes or lands,
  so chains don't reshuffle on every push. Ordering edges never create cycles: an order that would is not added,
  and the dependent PR falls back to waiting on both.
- **Consequences for agents.** The later prerequisite (#29) must rebase onto the earlier one (#28) even though it
  doesn't depend on it; it gets the **Ready for Agent Followup** reason `rebase_onto` ("rebase onto #28 so #31
  can build on both"). The dependent PR gets `rebase_onto` #29 once #29 contains #28. GitOrange never pushes to
  anyone's branch.
- **Unwinding.** If a prerequisite closes without landing, ordering edges that existed for it are removed and the
  chain is rebuilt; when one lands, the rest of the chain retargets as in "Parent lands".

## 2b. Pull request states

Every open pull request has exactly one state saying whose move it is. The state is **computed** on read from
signals that already exist (checks, auto-merge review and flags, AI conflict resolution, stack edges), never
stored as a second copy; only changes are recorded, for the timeline.

| State                                           | When                                                                                                                                                                                                                                              | Who acts                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `agent_followup` (**Ready for Agent Followup**) | A required check failed · must account for #N and not accounted for · changes requested on a review flag · conflicts AI couldn't resolve · `rebase_onto` a new parent · the auto-merge review failed on an invalid `review.yml` change in this PR | The PR's author or agent: push a fix |
| `human_review` (**Requires Human Review**)      | Review flags awaiting approval · a dependency cycle a maintainer must order · a maintainer override is needed                                                                                                                                     | A person with merge permission       |
| `waiting` (**Waiting for Checks**)              | Actions running or queued · auto-merge review running · stack discovery still checking this PR's head · AI conflict resolution running                                                                                                            | GitOrange                            |
| `ready` (**Ready**, optionally _stacked on #N_) | Nothing left on this PR. Stacked on an open parent: it lands after the parent (milestone 3's queue; until then, the merge button or auto-merge once the parent has landed)                                                                        | GitOrange                            |

- **Priority** when several apply: `agent_followup` > `human_review` > `waiting` > `ready`. Agent work comes first
  because a new commit resets review flags; asking a person to approve a commit about to be replaced wastes their
  time.
- **Reasons are structured.** `pullState(pr)` returns `{ state, reasons[] }`; each reason has a `kind` and its
  data, e.g. `{ kind: 'check_failed', run_number }`, `{ kind: 'must_account_for', pr, instructions }`,
  `{ kind: 'rebase_onto', pr, branch, why }`, `{ kind: 'flags_pending', count }`, `{ kind: 'stacked_on', pr }`.
  Agents act on them without parsing prose.
- **Surfaces.** A state label on each row of the Pull requests list and each tree node (replacing milestone 1's
  missing chips); a banner in the merge box listing the reasons; `state` on PR detail; a `state` filter on the
  list API and on `gitorange_list_pull_requests` (`state: "agent_followup"` is how an agent asks "what needs
  me?"); `state` and `reasons` on `gitorange_get_pull_request`. The Approvals page lists `human_review` PRs.
- **Timeline and live.** The middleware and Workflow hooks that already send live pings compare the PR's state
  before and after and record a timeline event when it changes ("Ready for agent followup: check CI failed").
  Pings as today.
- **Only with stacking or auto-merge on?** States are computed for every open PR; reasons that need stacking
  (`must_account_for`, `rebase_onto`, `stacked_on`) appear only when it is on.

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

### Things that change because `base_ref` can be a PR branch

Every reader of `base_ref` that means "where this lands" switches to `land_target`:

- `readPolicy` (auto-merge and stacking read `review.yml` from the land target).
- Actions `pull_request` branch filters (`pullRequestMatches`).
- `autoMergeStatus`'s merge plan and the AI conflict sweep (conflicts are against the land target).
- `landPull` (lands into the land target, never into a parent branch).
- The PR list's base filter and the Approvals inbox.

`base_ref` stays what the diff and the "into" label show.

## 3. Landing one at a time

Replaces direct landing for repositories with stacking on. Off, `landPull` is unchanged.

**Eligibility.** A PR is **ready to queue** when everything `autoMergeStatus` requires holds (or a person
pressed the button) and every edge it waits on is satisfied: earlier PR landed, closed, or edge dismissed; and
every `must_account_for` edge is accounted for or dismissed.

**Queue.** `merge_queue_entries (id, repository_id, land_target, pull_request_id, state, queue_sha,
target_sha, error, enqueued_by_id, created_at, updated_at)`, states `queued` · `building` · `testing` ·
`landing` · `landed` · `failed` · `removed`. Order is enqueue time, except a PR never runs before a PR it
waits on. One entry per land target is past `queued` at a time.

**Run (a Workflow, `MERGE_RESOLUTION` gets a `queue` payload):**

1. **Build** the commit the target will get: the PR's own diff replayed onto the current target tip, as a
   three-way merge whose ancestor is the PR's **replay base**. Normally that's the PR's merge base with its land
   target. When a parent landed as a squash, the child's branch still contains the parent's original commits,
   which the target never received; so if the PR's head contains the head a landed parent had when it merged
   (`pull_requests.merged_head_sha`, new column), the replay base is that head instead. Only the child's own
   changes are replayed. Uses the PR's AI resolution if one is proposed for these shas. Message, author, and
   co-author credits as `landPull` builds them today.
2. **Test.** Push it to `refs/gitorange/queue/<pr number>` and queue Actions runs for it as a `pull_request`
   event (so existing workflows run unchanged), recorded with `workflow_runs.queue_entry_id`. Required checks
   follow `review.yml`'s `checks.require`, evaluated on this sha.
3. **Land.** When checks pass: push the target ref from `target_sha` to `queue_sha` with compare-and-swap. The
   exact tested commit becomes the tip. Mark the PR merged (with `merged_head_sha`), delete the queue ref.
4. **Target moved** before land (someone pushed directly): rebuild and re-test.
5. **Checks failed:** entry `failed`, the PR leaves the queue, the timeline and MCP say which check failed (with
   the run number for `gitorange_get_run_logs`). New commits re-enter it automatically if auto-merge is on.
6. **After landing:** children retarget to the land target, landed-PR edges are evaluated for open PRs (the
   sweep already runs on the target move), and the next entry starts.

**Merge button.** With stacking on, **Rebase and merge** becomes **Add to queue** (and **Remove from queue**).
Auto-merge enqueues instead of landing. MCP `gitorange_merge_pull_request` enqueues and says so. Nothing reaches
the target untested; a direct `git push` to the target still works for people with push rights.

## 4. Tree view and surfaces

**Pull requests tab.** A **List / Tree** toggle (remembered per viewer in `localStorage`). The tree is grouped
by land target; each root is the target branch, each node a PR: number, title, author, and a state chip
(checks, review, "needs changes for #28", "waits on #31", queue position, testing, landing). Solid edges are
parents; dashed edges are waits-on; an edge's hover/focus shows its reason. Landed PRs that an open PR must
account for show as faded nodes at the root. Live updates through the existing `repo:<id>` channel. Built as
HTML/SVG in React with Primer tokens (no new dependency), readable at phone width (indented outline below
`md`).

**PR page.** Sidebar section **Stack**: parent, children, waits-on, with reasons and the maintainer controls.
Timeline events for stacked / unstacked / must account for / accounted for / queued / tested / landed / removed
from queue.

**Approvals page.** PRs blocked on `must_account_for` with no new commits for a while, and pairs that failed to
check, so they don't sit unnoticed.

**MCP.**

- `gitorange_get_pull_request` gains `stack`: `parent`, `children`, `waits_on` (with reasons),
  `must_account_for` (with `instructions` and whether it's accounted for), and `queue` (state, position,
  failing check).
- New `gitorange_get_pull_tree(repository, land_target?)` returns the whole tree, so an agent starting work
  can see what's in flight.
- Merge refusals name the blocking edge.

**Live.** Edge, retarget and queue changes ping `repo:<id>`; must-account-for and failures also ping
`approvals`.

## Cost

Per PR head change, per candidate: one Clef call (skipped when both heads were already checked together), plus one
`REVIEW_MODEL` call per related or conflicting pair, plus one re-check per new head of a PR with an open
must-account-for edge. Per queue entry: one Actions run of the `pull_request` workflows. Recorded through the
existing usage recording under the features `stack-decide` and `stack-explain`.

## Testing

Vitest in workerd against real D1, with the Artifacts fake and fake Clef/reasoning models
(`worker/src/__tests__/stacking.test.ts`, `merge-queue.test.ts`):

- Discovery: Clef says unrelated → `independent`, no reasoning-model call; confident Clef decision stands and the reasoning model only explains; unsure Clef → the reasoning model decides; textual conflict always counts;
  pairs re-checked only when a head moves; model failure → `failed`, non-blocking.
- #28/#29 fixture: #29 adds config variables while #28 adds the setup-check registry → `must_account_for`,
  #29 retargeted onto #28's branch, instructions present, blocked; a new #29 head that adds checks → accounted
  for.
- Landed-earlier: #28 merged before #29 opened → edge from landed PR, no retarget, still blocks.
- Tree: parent choice, waits-on, cycle refusal, parent closed → retarget back, unstack/dismiss by a maintainer,
  refused for a non-maintainer.
- `land_target` readers: policy, Actions filters, conflict sweep, and landing all use the land target.
- Queue: build replays only the child's diff after its squashed parent landed; checks run on the queue sha;
  land is a fast-forward to the tested sha; target moved → rebuild; failed checks → removed with the run number;
  waits-on ordering; merge button and MCP enqueue; stacking off → today's `landPull` path unchanged.

## Milestones

Each is mergeable and useful alone:

1. **Discovery + tree view** (read-only): `pr_edges`, textual check, Clef decisions, reasoning-model explanations,
   Tree toggle, PR sidebar, MCP `stack` (without queue) and `gitorange_get_pull_tree`.
2. **Retarget, linearize, states**: `land_target`, retargeting, linearizing several prerequisites (ordering
   edges), must-account-for instructions, re-checks and blocking in `autoMergeStatus`/`landPull`/MCP, PR states
   (`pullState`, list filter, labels, merge-box banner, timeline), maintainer controls, Approvals entries.
   Carried over from milestone 1: start discovery before auto-merge can land the PR; fix the claim race that can
   leave a pair row with a stale orientation; tree-node state labels.
3. **One at a time**: `merge_queue_entries`, build/test/land Workflow, `merged_head_sha`, Add to queue, MCP
   enqueue.

## Docs to update

`docs/auto-merge.md` (`stacking:` section), `docs/architecture.md`, README features and known limitations,
`docs/configuration.md` if any new setting or binding appears, and `CLAUDE.md`'s architecture notes.
