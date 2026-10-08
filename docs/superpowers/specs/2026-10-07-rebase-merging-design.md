# Rebase merging: GitOrange rebases pull request branches, and merging is a fast-forward

Status: design approved in conversation, 2026-10-07.

## Problem

Pull requests land as one squash commit built by a three-way tree merge at merge time; the branch is never
rewritten. A stacked child carries its parent's original commits, which never reach main's history (main gets the
squash), so the child's merge base is main from before the parent. Whenever the child's copy of the parent's lines
differs from what landed (the parent was fixed after the child stacked, or the child edits the parent's lines), the
child conflicts in files it may not even have touched. Reproduced: a child that only adds a file conflicts in the
parent's file once the parent received a fix commit; a child editing its parent's lines conflicts outright.

## Goal

GitOrange keeps every open pull request rebased onto its target itself — replaying the PR's commits, skipping the
ones the target already has, resolving conflicting commits with AI — and merging moves the target to the PR's head
(a fast-forward). Main keeps every commit with its author, message and SHA. Stacked children rebase cleanly once
their parent lands.

## Non-goals

- Backwards compatibility with squash landing (pre-v1): squash landing, squash credits, `refs/resolutions/` result
  commits and the REST merge `method` field are removed, not kept alongside.
- Preserving merge commits on a PR branch (`--rebase-merges`): they are flattened.
- Rewriting already-merged history: earlier squash commits stay on main.

## 1. The rebase engine (GitService)

- `rebase(head, onto)` replays the PR's own commits (merge base → head, oldest first) onto `onto`. Each commit is a
  three-way tree merge — base = its parent's tree, ours = the current `onto`-side tree, theirs = the commit's tree —
  with the existing `mergeTrees`. The new commit keeps the original author, author date and message; the committer
  is GitOrange.
- Patch identity: a hash of the commit's normalised diff against its parent (paths, modes, and line hunks without
  line numbers or whitespace-only context differences). Commits whose patch identity matches a commit that reached
  `onto` since the merge base are skipped. Commits already in `onto`'s history are skipped too.
- Merge commits on the branch are skipped; their changes arrive through the replay of the commits around them.
- Result: the new commits and the new head, or a stop at the first conflicting commit — that commit, its conflicted
  files (base/ours/theirs and diff3 text), and the commits replayed so far.
- At most 100 commits per rebase; a longer PR reports "too many commits to rebase — squash locally".

## 2. When rebases happen, and conflicts

- Triggers: when a target branch moves (push or landing), each open pull request on it that is behind is queued for
  a rebase — a `rebase` run on the `MERGE_RESOLUTION` Workflow, one at a time per pull request, recorded in the
  Actions tab. A rebase also runs right before landing if the target moved. Stacked children rebase onto their
  parent's branch when it moves, and onto the land target after `onPullClosed` moves them there.
- Writing: the rebased head replaces the PR branch with compare-and-swap on the old head; if the agent pushed
  meanwhile, the rebase starts over from the new head. The old head is kept as `refs/pull/N/pre-rebase/<sha7>`. A
  `rebased` timeline event records old head, new head and the number of skipped commits.
- Conflicts: the AI resolver (the MergeResolver Durable Object, same model) gets the conflicted files of the one
  commit that stopped the replay, that commit's message and diff, and the PR's title and description. The resolved
  commit keeps its author and message and gets a `Conflicts-resolved-by: GitOrange AI` trailer; replay continues,
  and each further conflicting commit gets its own resolution. If the AI fails, the PR shows a new `rebase_conflict`
  reason — "commit `abc1234` conflicts in `x.ts`" — with the files, and the coding agent rebases locally.
- Checks and reviews: Actions re-run on the new head. Agent reviews carry over (findings, approvals and verdicts
  re-keyed to the new head) when the rebase was clean and the PR's per-commit patch identities are unchanged; a
  rebase that needed a conflict resolution starts a fresh review.
- Agents: MCP instructions and `gitorange_get_pull_request` say "GitOrange rebased this branch (old → new); run
  `git fetch && git rebase --onto origin/<branch> <old head>` before you push again" (a rebase onto the new branch
  keeps unpushed local commits; a hard reset would drop them). A stale push is rejected as a non-fast-forward.

## 3. Merging is a fast-forward

- `landPull` keeps its gates (stack, checks, review, expected head). When the head descends from the target's tip,
  landing is one compare-and-swap moving the target ref to the head; no commit is created.
- When the target moved since the last rebase, `landPull` rebases, pushes the rebased branch, and fast-forwards in
  the same step only when the new head needs no checks (no Actions workflow runs on it) and its reviews carried
  over; otherwise it stops with "rebased — waiting for checks" (the gate checks Actions on the head it lands, as
  today), and auto-merge lands it when they pass.
- Records: `pull_requests.merge_commit_sha` is the landed head; a new `landed_commits` count. `refs/pull/N/head` is
  kept. `pullShas` for a merged pull request: base = the first parent of the oldest landed commit, head = the landed
  head; pull requests merged before this change (one single-parent commit not containing the PR head) keep the
  squash rule. MCP `merged.commit` is the landed head.
- Commit messages are the authors' own: no `(#N)`, no co-author trailers. The merge button's title and message
  fields are removed.
- Stacked children: a landed parent's commits are in main's history, so a child rebased onto main skips them (by
  ancestry, or by patch identity if the parent was rebased before landing).
- Also: stacking's landed-prerequisite containment check uses the landed head; squash credits are deleted; the REST
  `method` field is removed; MCP and README wording drops "squash"; `deleteMergedBranch` is unchanged.

## 4. Moving over, testing, deploying

- `merge_resolutions` is reshaped for per-commit resolutions (one row per pull request, head and replayed commit,
  with the conflicted files and resolved contents); open resolution rows are cancelled. Schema change via
  `yarn db:generate`.
- Tests: the rebase engine (replay, patch-identity skip, merge commit, the 100-commit cap, stop at the conflicting
  commit); rebase runs (trigger on target move, CAS losing to a push, old head kept, timeline event); per-commit AI
  resolution with a fake resolver, several conflicting commits, AI failure → `rebase_conflict`; landing
  (fast-forward keeps SHAs and messages; target moved → rebase then fast-forward or wait for checks); review
  carry-over (clean vs resolved); the stacked-child reproductions A/B/C as regression tests plus a real conflict
  with main still surfacing; every test pinning squash behaviour updated.
- Docs: README, docs/architecture.md, docs/auto-merge.md, CLAUDE.md ("Merging is rebase-only (squash onto the target
  tip)" → rebase + fast-forward), MCP instructions.
- Deploy: two migrations (0024 reshapes `merge_resolutions`; 0025 cancels squash-era resolutions still queued,
  running or proposed). Run `yarn db:migrate:prod` before deploying the code; in-flight squash-era Workflow instances
  then do nothing. No new bindings.
