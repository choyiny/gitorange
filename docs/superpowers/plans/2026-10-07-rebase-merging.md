# Rebase Merging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitOrange keeps every open pull request rebased onto its base itself (replaying its commits, skipping what
the target already has, resolving conflicting commits with AI), and merging is a fast-forward of the land target to
the pull request's head, so main keeps every commit with its author, message and SHA and stacked children rebase
cleanly once their parent lands.

**Architecture:** A pure-ish rebase engine (`worker/src/git/rebase.ts`, over `GitService` with a new in-memory object
overlay) replays a branch's own commits onto a new base with the existing three-way `mergeTrees`, skipping commits by
ancestry and by patch identity (`worker/src/git/patch-id.ts`). A `rebase` payload on the `MERGE_RESOLUTION` Workflow
(`worker/src/merge/rebase.ts`) runs it for one pull request, asks the `MergeResolver` Durable Object to resolve each
conflicting commit (`worker/src/merge/commit-resolution.ts`, one `merge_resolutions` row per commit), and replaces the
branch with compare-and-swap; the sweep after any branch move, opening, reopening, retargeting and the PR page start
it. A clean rebase carries the agents' review and people's approvals to the new head (`worker/src/review/carry.ts`).
`landPull` becomes a compare-and-swap fast-forward, rebasing inline first when the target moved.

**Tech Stack:** Cloudflare Workers, Workflows (`MERGE_RESOLUTION`), Durable Objects (`MergeResolver`: Cloudflare
Computer + Pi Durable), Workers AI, Drizzle/D1, Cloudflare Artifacts (in-memory fake in tests), `diff`
(`structuredPatch`), `node-diff3`, Hono + Zod-OpenAPI, React + Primer CSS, Vitest (`@cloudflare/vitest-pool-workers`,
real D1).

**Spec:** `docs/superpowers/specs/2026-10-07-rebase-merging-design.md` — sections 1 (the rebase engine), 2 (when
rebases happen, and conflicts), 3 (merging is a fast-forward), 4 (moving over, testing, deploying). Read it with this
plan; the Decisions below record where the real code made the spec's wording concrete or forced a change.

## Global Constraints

- Pre-v1: no backwards compatibility with squash landing. Squash landing, squash credits, `refs/resolutions/` result
  commits and the REST merge `method` field are removed, not kept alongside.
- Merge commits on a PR branch are flattened (no `--rebase-merges`); earlier squash commits on main stay as they are.
- Replay: merge base → head, oldest first; each commit is a three-way tree merge (base = its parent's tree, ours = the
  current onto-side tree, theirs = the commit's tree) with the existing `mergeTrees`. The new commit keeps the
  original author, author date and message; the committer is GitOrange.
- Patch identity: a hash of the commit's normalised diff against its parent (paths, modes, line hunks without line
  numbers or whitespace-only context differences). Commits whose identity matches a commit that reached onto since the
  merge base are skipped; commits already in onto's history are skipped too.
- At most 100 commits per rebase; a longer PR reports "too many commits to rebase — squash locally".
- Triggers: a target branch moves (push or landing) → each open PR on it that is behind is queued for a `rebase` run on
  `MERGE_RESOLUTION`, recorded in the Actions tab; a rebase also runs right before landing if the target moved;
  stacked children rebase onto their parent's branch when it moves, and onto the land target after `onPullClosed`
  moves them there.
- Writing: the rebased head replaces the PR branch with compare-and-swap on the old head; if the agent pushed
  meanwhile the rebase starts over from the new head. The old head is kept as `refs/pull/N/pre-rebase/<sha7>`. A
  `rebased` timeline event records old head, new head and the number of skipped commits.
- Conflicts: the `MergeResolver` (same model, `ai.resolver_model`) gets the conflicted files of the one commit that
  stopped the replay, that commit's message and diff, and the PR's title and description. The resolved commit keeps its
  author and message and gets a `Conflicts-resolved-by: GitOrange AI` trailer; each further conflicting commit gets its
  own resolution. If the AI fails, the PR shows a `rebase_conflict` reason ("commit `abc1234` conflicts in `x.ts`")
  with the files, and the coding agent rebases locally.
- Checks and reviews: Actions re-run on the new head. Agent reviews carry over (findings, approvals, verdicts re-keyed
  to the new head) when the rebase was clean and the per-commit patch identities are unchanged; a rebase that needed a
  conflict resolution starts a fresh review.
- Agents: MCP instructions and `gitorange_get_pull_request` say "GitOrange rebased this branch (old → new); run
  `git fetch && git reset --hard origin/<branch>` before you push again." A stale push is rejected as a
  non-fast-forward.
- Landing keeps its gates (stack, checks, review, expected head). When the head descends from the target's tip,
  landing is one compare-and-swap moving the target to the head; no commit is created. When the target moved since the
  last rebase, `landPull` rebases, pushes the rebased branch, and fast-forwards in the same call only when the new head
  needs no checks (no Actions workflow runs on it) and its review carried over; otherwise it stops with "rebased —
  waiting for checks", and auto-merge lands it when they pass.
- Records: `pull_requests.merge_commit_sha` is the landed head; new `landed_commits` count; `refs/pull/N/head` kept.
  `pullShas` for a merged PR: base = first parent of the oldest landed commit, head = landed head; PRs merged before
  this change keep the squash rule. MCP `merged.commit` is the landed head.
- Commit messages are the authors' own: no `(#N)`, no co-author trailers; the merge button's title and message fields
  are removed. `deleteMergedBranch` behaviour is unchanged.
- Schema changes only via `yarn db:generate` (never hand-written migration files); never hand-edit
  `worker/src/db/auth.schema.ts`. Deploy: migrations run after the code deploy (they cancel in-flight resolutions); no
  new bindings or vars.
- Always `yarn` (never `npm`/`npx`). Tests live in `worker/src/__tests__/` (frontend pure helpers in
  `src/lib/*.test.ts`), run in workerd against real D1 with the Artifacts fake; never mock `env.DB`. Every new test
  file goes into a job in `.github/workflows/ci.yml` (`ci-workflow.test.ts` enforces it).
- Workflow step results stay small and replay-safe: no file contents, prompts, transcripts or model text in step
  results.
- Never deploy, never push to `main`. Definition of done: `yarn test` passes, `yarn typecheck` clean, `yarn format` run.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  ```

## Decisions (made while planning)

1. **The engine is `rebase(git, opts)` in `git/rebase.ts`, not a `GitService` method.** Replaying commit 2 merges
   against the tree commit 1's replay produced, which exists only in memory until the push. `GitService` gains a small
   overlay (`stage(objects)`, read by `tree()` and `blob()`); the engine is a function over it, which keeps
   `service.ts` (724 lines) from growing a second responsibility.
2. **Patch identity is the added and removed lines with all whitespace removed, plus each file's path, status and
   mode.** Context lines are left out entirely (the strongest reading of "without whitespace-only context
   differences"); binary, submodule and >1 MB changes count by blob ids.
3. **Author dates keep their seconds, not their timezone.** `makeCommit` writes `+0000` and Artifacts' commit metadata
   has no timezone, so a rebased commit's author date is the same instant in UTC.
4. **"Per-commit patch identities unchanged" means: every replayed commit that needed no resolution has the same
   identity after the replay as before.** Commits skipped because the target already has them don't count; otherwise
   every stacked child would lose its review when its parent lands, which the spec's goal rules out.
5. **`merge_resolutions` keeps its name and columns and gains two: `commit_sha` (the replayed commit that conflicted)
   and `resolved_files` (path → resolved text).** `base_sha` is the tip the rebase was onto (base_ref's), `head_sha`
   the PR head being rebased, `result_sha` the rebased commit once written. Statuses: `running` → `resolved` →
   `applied`, or `failed`; `rejected` stays only for old rows. Dropping and adding columns in one `drizzle-kit
generate` would stop on an interactive rename prompt, so nothing is dropped.
6. **Two generated migrations, not one.** The schema change is `yarn db:generate --name=rebase_merging`; cancelling the
   open squash-era rows is a data change, which needs `yarn db:generate --custom --name=cancel_squash_resolutions`
   (as `0021_remove_review_yml_history.sql` was made): a custom migration carries no schema snapshot change, so it
   can't hold the `ALTER TABLE`s. Both apply in one `yarn db:migrate:prod`.
7. **A row's id is deterministic: `<pr id>-<onto 12>-<head 12>-<commit 12 | all>`** (`resolutionId`), so a replayed
   Workflow step inserts it once, and the resolver Durable Object (named by it) rejoins the same run. No new index.
8. **A PR rebases onto its `base_ref`** (its parent's branch while stacked; the land target when that branch is gone),
   and lands by rebasing onto its land target. Reconcile retargets also start a rebase: every trigger rebases onto
   `base_ref`, so a stacked child would otherwise be rebased by the next unrelated trigger anyway. `rebase_onto` now
   means "GitOrange is rebasing it": its state becomes `waiting` (was `agent_followup`).
9. **`rebase_conflict` replaces `conflicts_unresolved`.** Its source, a whole-PR squash resolution, is gone.
   `resolution_running` stays (an AI resolution of a commit is running). A conflict AI can't take (binary,
   delete/edit, generated files), more than 100 commits, or more than 20 conflicting commits is recorded as a failed
   row with model `none` and shows as `rebase_conflict` too (commit `null` for too many commits).
10. **At most 20 commits resolved by AI per run (`MAX_AI_COMMITS`); the per-repository cap of 5 concurrent
    resolutions is dropped.** Rebase runs are per pull request and resolve one commit at a time; Workers AI rate
    limits are already ridden out by the resolver's retry with backoff. A Workflow instance has a bounded step count.
11. **Rebase run instance ids are random (`rebase-<uuid>`).** A deterministic id per (onto, head) would forbid
    rebasing again after an agent force-pushes its old head back. Duplicates are avoided by `ensureRebase` (skip when a
    `rebase` agent run for the PR started in the last 15 minutes is still running, or a failed row exists for these
    tips); a duplicate that slips through loses the compare-and-swap and finds the branch up to date.
12. **"Behind" is not a reason.** A behind PR can be Ready: landing rebases it first.
13. **Without the `MERGE_RESOLUTION` binding** no background rebase runs: the PR page and `autoMergeStatus` compute a
    dry-run rebase to show a conflict, and `landPull` still rebases inline.
14. **Carry-over moves rows, it doesn't copy them** (`pr_classifications` re-inserted under the new id, its
    `pr_review_flags`, `pr_reviewers` and `pr_approvals` re-keyed, the old classification deleted, in one D1 batch), so
    agent learning never counts a dismissal twice. Only a finished review (`done` or `failed`) moves; a running one
    stays with the old head and the sweep reviews the new one. Approvals move on every clean rebase.
15. **An inline rebase in `landPull` that conflicts is refused (409, reason `rebase`), not resolved inline** (a model
    run doesn't fit a request); a rebase run is queued and auto-merge lands it after.
16. **The compare page's "Able to merge" is a dry-run rebase** (no `planMerge`). `planMerge` stays for stacking's
    textual check.
17. **`refs/pull/N/pre-rebase/<sha7>` is created once per old head** (never moved), in the same push as the branch.
18. **A rebase is a push for Actions** (`onRefsUpdated` with no actor) and for the sweep (`startSweep`, renamed from
    `autoResolveConflicts`: its second pass now starts rebases, step `rebase:<pr id>`), so the PR's own new head is
    reviewed and PRs stacked on it rebase.
19. **The agent run kind is `rebase`** (title "Rebase #N onto <branch>"); `conflict_resolution` stays for old rows. A
    `resolutionId` payload (squash-era instances in flight at deploy) is a no-op.
20. **`deleteMergedBranch` reads the branch tip from the remote** (not the request's cached refs), because landing may
    have just pushed a rebased head; its decision rules are unchanged.

## Review Focus

1. **An agent force-pushes its old, pre-rebase head after GitOrange rebased:** GitOrange rebases it again (nothing
   remembers "already rebased these tips"), and the older head is still at `refs/pull/N/pre-rebase/<sha7>`. → Task 2
   test "rebases again after the agent force-pushes the old head".
2. **Two rebase runs for the same pull request at once** (a sweep and a page view): the branch is written once and one
   `rebased` event is recorded; the second run finds it up to date. → Task 2 test "two runs at the same tips write
   once".
3. **A commit message that already ends in trailers** (`Co-authored-by: …`): untouched when replayed cleanly; when AI
   resolves it, `Conflicts-resolved-by: GitOrange AI` joins the trailer block instead of starting a paragraph. → Task 1
   tests "keeps messages byte for byte" and "adds the trailer to an existing trailer block".
4. **A commit whose conflict AI can't take (a binary file, or a file deleted on one side and edited on the other):** no
   model call; `rebase_conflict` names that commit and file. → Task 3 test "never asks the model about a binary
   conflict".
5. **The PR branch is deleted while its rebase run is queued:** the run ends quietly and never recreates the branch. →
   Task 2 test "ends quietly when the branch is deleted before the write".

---

## Before you start

```bash
git status            # on rebase-merging, clean
yarn install
yarn test worker/src/__tests__/git-merge.test.ts worker/src/__tests__/repos-pulls.test.ts   # green
```

## File Structure

**Create**

- `worker/src/git/patch-id.ts` — `changesPatchId`, `patchId`: a change's patch identity.
- `worker/src/git/rebase.ts` — the engine: `rebase`, `withResolvedTrailer`, `MAX_REBASE_COMMITS`, `RESOLVED_TRAILER`,
  `REBASE_COMMITTER`, result types.
- `worker/src/merge/rebase.ts` — rebase runs: `rebaseTips`, `ensureRebase`, `executeRebase`, `rebaseAt`,
  `writeRebase`, `afterRebase`, `recordStop`, `rebaseView`, `resolutionId`, `preRebaseRef`, messages.
- `worker/src/merge/commit-resolution.ts` — AI for one conflicting commit: `claimResolution`, `commitRequest`,
  `resolveCommit`, `failResolution`, `MAX_AI_COMMITS`.
- `worker/src/review/carry.ts` — `carryReview`.
- `worker/src/__tests__/helpers/rebase.ts` — `runRebases`, `fakeResolver`, `divergedPull`, `rows`.
- Tests: `git-rebase.test.ts`, `rebase-runs.test.ts`, `rebase-resolution.test.ts`, `review-carry.test.ts`,
  `rebase-landing.test.ts`, `stacking-rebase.test.ts` (all in `worker/src/__tests__/`).
- Migrations: `migrations/0024_rebase_merging.sql` (generated: `merge_resolutions` columns, `pull_requests.landed_commits`)
  and `migrations/0025_cancel_squash_resolutions.sql` (generated `--custom`, cancels open squash-era rows), with
  `migrations/meta/*`.
- `src/components/RebaseStatus.tsx` — the merge box's rebase line.

**Modify**

- Git: `worker/src/git/objects.ts` (`parseTree`), `worker/src/git/service.ts` (`stage`, overlay reads).
- Schema: `worker/src/db/app.schema.ts` (`merge_resolutions` columns and statuses, `pull_requests.landed_commits`,
  `PrEventKind` `rebased`, `agentRunKinds` `rebase`).
- Merge: `worker/src/merge/resolution.ts` (cut to shared helpers), `worker/src/merge/auto.ts` (`startSweep`, sweep's
  rebase pass), `worker/src/merge/resolver.ts` (preamble wording), `worker/src/merge/land.ts` (fast-forward),
  `worker/src/merge/workflow.ts` (`rebase` payload).
- Callers: `worker/src/git-http.ts`, `worker/src/lib/pulls.ts`, `worker/src/routers/pulls-router.ts`,
  `worker/src/routers/repos-router.ts`, `worker/src/review/auto-merge.ts`, `worker/src/mcp/pull-tools.ts`,
  `worker/src/mcp/index.ts`, `worker/src/stack/retarget.ts`, `worker/src/stack/reconcile.ts`,
  `worker/src/stack/discover.ts`, `worker/src/pulls/state.ts`, `worker/src/pulls/signals.ts`,
  `worker/src/pulls/settle.ts`, `worker/src/agent-runs/record.ts`, `worker/src/lib/insights.ts`.
- SPA: `src/lib/uiApi.ts`, `src/lib/pullState.ts`, `src/pages/PullView.tsx`, `src/pages/PullNew.tsx`,
  `src/pages/AgentRuns.tsx`, `src/components/PullBadges.tsx`, `src/components/PullEvents.tsx`.
- Tests updated: `repos-pulls`, `land-target`, `mcp`, `review-gate`, `actions`, `pull-states`, `agent-runs`,
  `stacking-landing`, `insights`, `pulls-ai-resolution`, `helpers/stacking.ts`, `helpers/app.ts`.
- Deleted: `worker/src/__tests__/merge-resolution.test.ts`, `worker/src/__tests__/squash-credits.test.ts`,
  `src/components/AiResolution.tsx`.
- `.github/workflows/ci.yml`; docs: `README.md`, `docs/architecture.md`, `docs/auto-merge.md`, `CLAUDE.md`.

---

### Task 1: The rebase engine and patch identity

**Files:**

- Modify: `worker/src/git/objects.ts` (add `parseTree` after `makeTree`)
- Modify: `worker/src/git/service.ts:80-139` (the object overlay: `stage`, `tree()`, `blob()`)
- Create: `worker/src/git/patch-id.ts`
- Create: `worker/src/git/rebase.ts`
- Test: `worker/src/__tests__/git-rebase.test.ts`
- Modify: `.github/workflows/ci.yml` (job `test-review`)

**Interfaces:**

- Consumes: `GitService.mergeBase`, `commitsBetween`, `diffTrees`, `mergeTrees`, `commit`, `tree`, `blob`;
  `makeCommit`, `makeTree`, `GitObject`, `Signature` (`git/objects.ts`); `ConflictFile`, `Commit`, `FileChange`
  (`git/service.ts`).
- Produces:
  - `parseTree(data: Uint8Array): Entry[]` (`git/objects.ts`; `Entry` = `ArtifactsTreeEntry`).
  - `GitService.stage(objects: GitObject[]): void` — staged trees and blobs are readable through `tree()`/`blob()`.
  - `changesPatchId(git: GitService, changes: FileChange[]): Promise<string>`, `patchId(git: GitService, a: string | null, b: string | null): Promise<string>` (`git/patch-id.ts`).
  - `git/rebase.ts`: `MAX_REBASE_COMMITS = 100`, `RESOLVED_TRAILER = 'Conflicts-resolved-by: GitOrange AI'`,
    `REBASE_COMMITTER = { name: 'GitOrange', email: 'noreply@gitorange' }`, `withResolvedTrailer(message: string): string`,
    `type CommitResolutions = Map<string, Map<string, string | null>>` (original commit sha → path → content),
    `type ReplayedCommit = { original: string; rebased: string; resolved: boolean }`,
    `type RebaseResult = { kind: 'up_to_date' } | { kind: 'too_many'; count: number } | { kind: 'done'; head: string; commits: ReplayedCommit[]; skipped: number; samePatches: boolean; objects: GitObject[] } | { kind: 'conflict'; commit: Commit; conflicts: string[]; files: ConflictFile[]; replayed: ReplayedCommit[]; skipped: number }`,
    `type RebaseOptions = { head: string; onto: string; committer: Signature; ontoLabel?: string; resolutions?: CommitResolutions }`,
    `rebase(git: GitService, opts: RebaseOptions): Promise<RebaseResult>`.

- [ ] **Step 1: Write the failing tests**

Create `worker/src/__tests__/git-rebase.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ArtifactsRepoClient } from '../git/remote';
import { GitService } from '../git/service';
import { decoder } from '../git/bytes';
import { patchId } from '../git/patch-id';
import {
  rebase,
  REBASE_COMMITTER,
  RESOLVED_TRAILER,
  withResolvedTrailer,
} from '../git/rebase';
import { createFakeArtifacts, type FakeRepo } from './helpers/fake-artifacts';
import { commitFiles } from './helpers/seed';

const AT = { ...REBASE_COMMITTER, timestamp: 1_800_000_000 };
const ALICE = { name: 'Alice', email: 'alice@example.com' };
const LINES = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
/** `text` with line `n` tagged. */
const edit = (text: string, n: number, tag: string) =>
  text.replace(`line ${n}\n`, `line ${n} ${tag}\n`);

async function fixture() {
  const fake = createFakeArtifacts();
  await fake.binding.create('r');
  const repo = fake.repos.get('r')!;
  const git = new GitService(new ArtifactsRepoClient(fake.binding, 'r'));
  return { fake, repo, git };
}

/** A file at a commit; the rebase's objects must have been added to the fake first. */
async function text(git: GitService, commit: string, path: string) {
  const at = await git.entryAt(commit, path);
  return at?.type === 'blob'
    ? decoder.decode((await git.blob(at.entry.hash))!)
    : null;
}

/** Throws unless the rebase finished; keeps its objects readable from the fake. */
function done(repo: FakeRepo, r: Awaited<ReturnType<typeof rebase>>) {
  if (r.kind !== 'done') throw new Error(`expected done, got ${r.kind}`);
  repo.add(...r.objects);
  return r;
}

describe('rebase', () => {
  it('replays the branch’s commits onto the target, keeping authors, dates and messages', async () => {
    const { repo, git } = await fixture();
    const base = LINES(20);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    const f1 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1') },
      'First',
      [root],
      ALICE
    );
    const f2 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(edit(base, 2, 'f1'), 18, 'f2') },
      'Second\n\nWith a body.',
      undefined,
      ALICE
    );
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 10, 'main') },
      'Main moves'
    );
    const r = done(
      repo,
      await rebase(git, {
        head: f2,
        onto: tip,
        committer: AT,
        ontoLabel: 'main',
      })
    );
    expect(r.commits.map((c) => [c.original, c.resolved])).toEqual([
      [f1, false],
      [f2, false],
    ]);
    expect(r.skipped).toBe(0);
    expect(r.samePatches).toBe(true);
    const second = repo.parseCommit(r.head)!;
    const first = repo.parseCommit(second.parents[0])!;
    expect(first.parents).toEqual([tip]);
    expect([first.message, second.message]).toEqual([
      'First',
      'Second\n\nWith a body.',
    ]);
    for (const [c, original] of [
      [first, f1],
      [second, f2],
    ] as const) {
      expect(c.author).toEqual(ALICE);
      expect(c.authoredAt).toBe(repo.parseCommit(original)!.authoredAt);
      expect(c.committer).toEqual({
        name: 'GitOrange',
        email: 'noreply@gitorange',
      });
      expect(c.committedAt).toBe(AT.timestamp);
    }
    expect(await text(git, r.head, 'a.txt')).toBe(
      edit(edit(edit(base, 2, 'f1'), 10, 'main'), 18, 'f2')
    );
  });

  it('is up to date when the head already contains the target', async () => {
    const { repo, git } = await fixture();
    const root = await commitFiles(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    const head = await commitFiles(
      repo,
      'feature',
      { 'a.txt': 'b\n' },
      'Change',
      [root]
    );
    expect(await rebase(git, { head, onto: root, committer: AT })).toEqual({
      kind: 'up_to_date',
    });
  });

  it('skips a commit the target already has under another sha, wherever it landed in the file', async () => {
    const { repo, git } = await fixture();
    const base = LINES(20);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1') },
      'Fix line 2',
      [root]
    );
    const f2 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1'), 'b.txt': 'b\n' },
      'Add b'
    );
    // main shifts every line down, then makes the same fix (cherry-picked: another sha, other line numbers).
    await commitFiles(repo, 'main', { 'a.txt': `header\n${base}` }, 'Header');
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': `header\n${edit(base, 2, 'f1')}` },
      'Fix line 2 (picked)'
    );
    const r = done(
      repo,
      await rebase(git, { head: f2, onto: tip, committer: AT })
    );
    expect(r.skipped).toBe(1);
    expect(r.commits.map((c) => c.original)).toEqual([f2]);
    expect(repo.parseCommit(r.head)!.parents).toEqual([tip]);
    expect(await text(git, r.head, 'a.txt')).toBe(
      `header\n${edit(base, 2, 'f1')}`
    );
    expect(await text(git, r.head, 'b.txt')).toBe('b\n');
  });

  it('gives the same change the same identity whatever its context, and a different change another', async () => {
    const { repo, git } = await fixture();
    let n = 0;
    const tree = async (content: string) =>
      repo.parseCommit(
        await commitFiles(repo, `t${n++}`, { 'a.txt': content }, 'x', [])
      )!.treeHash;
    const [a1, a2] = [
      await tree('one\ntwo\nthree\n'),
      await tree('one\nTWO\nthree\n'),
    ];
    const [b1, b2] = [
      await tree('zero\n  one\ntwo\nthree  \nfour\n'),
      await tree('zero\n  one\nTWO\nthree  \nfour\n'),
    ];
    const c2 = await tree('one\nTwo\nthree\n');
    expect(await patchId(git, a1, a2)).toBe(await patchId(git, b1, b2));
    expect(await patchId(git, a1, c2)).not.toBe(await patchId(git, a1, a2));
  });

  it('skips commits already in the target’s history', async () => {
    const { repo, git } = await fixture();
    const root = await commitFiles(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    const f1 = await commitFiles(repo, 'feature', { 'a.txt': 'a1\n' }, 'One', [
      root,
    ]);
    const f2 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': 'a1\n', 'b.txt': 'b\n' },
      'Two'
    );
    repo.refs.set('refs/heads/main', f1); // f1 landed by fast-forward
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': 'a1\n', 'c.txt': 'c\n' },
      'Main moves'
    );
    const r = done(
      repo,
      await rebase(git, { head: f2, onto: tip, committer: AT })
    );
    expect(r.commits.map((c) => c.original)).toEqual([f2]);
    expect(repo.parseCommit(r.head)!.parents).toEqual([tip]);
  });

  it('flattens merge commits on the branch', async () => {
    const { repo, git } = await fixture();
    const base = LINES(20);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    const f1 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1') },
      'One',
      [root]
    );
    const m1 = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 10, 'm1') },
      'Main 1'
    );
    await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(edit(base, 2, 'f1'), 10, 'm1') },
      'Merge main',
      [f1, m1]
    );
    const f2 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(edit(edit(base, 2, 'f1'), 10, 'm1'), 18, 'f2') },
      'Two'
    );
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(base, 10, 'm1'), 'o.txt': 'o\n' },
      'Main 2'
    );
    const r = done(
      repo,
      await rebase(git, { head: f2, onto: tip, committer: AT })
    );
    expect(r.commits.map((c) => c.original)).toEqual([f1, f2]);
    expect(repo.parseCommit(r.head)!.parents).toHaveLength(1);
    expect(await text(git, r.head, 'a.txt')).toBe(
      edit(edit(edit(base, 2, 'f1'), 10, 'm1'), 18, 'f2')
    );
    expect(await text(git, r.head, 'o.txt')).toBe('o\n');
  });

  it('drops a commit whose changes the target already made (no empty commit)', async () => {
    const { repo, git } = await fixture();
    const base = LINES(10);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1') },
      'Fix 2',
      [root]
    );
    const f2 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1'), 'b.txt': 'b\n' },
      'Add b'
    );
    // Same fix plus another change in one commit: a different patch identity, but nothing left to apply.
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(edit(base, 2, 'f1'), 8, 'm') },
      'Fix 2 and 8'
    );
    const r = done(
      repo,
      await rebase(git, { head: f2, onto: tip, committer: AT })
    );
    expect(r.commits.map((c) => c.original)).toEqual([f2]);
    expect(r.skipped).toBe(1);
  });

  it('notices when a replayed commit no longer makes the same change', async () => {
    const { repo, git } = await fixture();
    const base = LINES(10);
    const root = await commitFiles(
      repo,
      'main',
      { 'a.txt': base, 'c.txt': 'c\n' },
      'base'
    );
    const f1 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': edit(base, 2, 'f1'), 'c.txt': 'c2\n' },
      'Two files',
      [root]
    );
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': edit(edit(base, 2, 'f1'), 8, 'm'), 'c.txt': 'c\n' },
      'Upstream'
    );
    const r = done(
      repo,
      await rebase(git, { head: f1, onto: tip, committer: AT })
    );
    expect(r.commits.map((c) => c.original)).toEqual([f1]);
    expect(r.samePatches).toBe(false); // the rebased commit only changes c.txt now
  });

  it('stops at the first conflicting commit with its files and what replayed before it', async () => {
    const { repo, git } = await fixture();
    const base = LINES(5);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    const f1 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': base, 'b.txt': 'b\n' },
      'Add b',
      [root]
    );
    const f2 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': base.replace('line 3', 'line 3 feature'), 'b.txt': 'b\n' },
      'Change line 3'
    );
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': base.replace('line 3', 'line 3 main') },
      'Main line 3'
    );
    const r = await rebase(git, {
      head: f2,
      onto: tip,
      committer: AT,
      ontoLabel: 'main',
    });
    if (r.kind !== 'conflict') throw new Error(r.kind);
    expect(r.commit.hash).toBe(f2);
    expect(r.conflicts).toEqual(['a.txt']);
    expect(r.replayed.map((c) => c.original)).toEqual([f1]);
    const markers = r.files[0].withMarkers;
    expect(markers).toContain('<<<<<<< main');
    expect(markers).toContain(`>>>>>>> ${f2.slice(0, 7)}`);
    expect(markers).toContain('line 3 main');
    expect(markers).toContain('line 3 feature');
  });

  it('applies resolved contents for a conflicting commit and marks it with the trailer', async () => {
    const { repo, git } = await fixture();
    const base = LINES(5);
    const root = await commitFiles(repo, 'main', { 'a.txt': base }, 'base');
    await commitFiles(
      repo,
      'feature',
      { 'a.txt': base, 'b.txt': 'b\n' },
      'Add b',
      [root]
    );
    const f2 = await commitFiles(
      repo,
      'feature',
      { 'a.txt': base.replace('line 3', 'line 3 feature'), 'b.txt': 'b\n' },
      'Change line 3'
    );
    const tip = await commitFiles(
      repo,
      'main',
      { 'a.txt': base.replace('line 3', 'line 3 main') },
      'Main line 3'
    );
    const resolved = base.replace('line 3', 'line 3 main and feature');
    const r = done(
      repo,
      await rebase(git, {
        head: f2,
        onto: tip,
        committer: AT,
        resolutions: new Map([[f2, new Map([['a.txt', resolved]])]]),
      })
    );
    expect(r.commits.map((c) => c.resolved)).toEqual([false, true]);
    expect(repo.parseCommit(r.head)!.message).toBe(
      `Change line 3\n\n${RESOLVED_TRAILER}`
    );
    expect(await text(git, r.head, 'a.txt')).toBe(resolved);
  });

  it('keeps messages byte for byte, trailers included', async () => {
    const { repo, git } = await fixture();
    const root = await commitFiles(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    const message = 'Fix it\n\nCo-authored-by: Bob <bob@example.com>';
    const head = await commitFiles(
      repo,
      'feature',
      { 'a.txt': 'a\n', 'b.txt': 'b\n' },
      message,
      [root]
    );
    const tip = await commitFiles(repo, 'main', { 'a.txt': 'a2\n' }, 'Main');
    const r = done(repo, await rebase(git, { head, onto: tip, committer: AT }));
    expect(repo.parseCommit(r.head)!.message).toBe(message);
  });

  it('adds the trailer to an existing trailer block', () => {
    expect(
      withResolvedTrailer('Fix it\n\nCo-authored-by: Bob <bob@example.com>')
    ).toBe(
      `Fix it\n\nCo-authored-by: Bob <bob@example.com>\n${RESOLVED_TRAILER}`
    );
    expect(withResolvedTrailer('Fix it')).toBe(`Fix it\n\n${RESOLVED_TRAILER}`);
    expect(withResolvedTrailer('Fix: the parser\n')).toBe(
      `Fix: the parser\n\n${RESOLVED_TRAILER}`
    );
  });

  it('refuses more than 100 commits', async () => {
    const { repo, git } = await fixture();
    const root = await commitFiles(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    repo.refs.set('refs/heads/feature', root);
    for (let i = 0; i < 101; i++)
      await commitFiles(
        repo,
        'feature',
        { 'a.txt': 'a\n', 'n.txt': `${i}\n` },
        `#${i}`
      );
    const tip = await commitFiles(repo, 'main', { 'a.txt': 'b\n' }, 'Main');
    expect(
      await rebase(git, {
        head: repo.refs.get('refs/heads/feature')!,
        onto: tip,
        committer: AT,
      })
    ).toEqual({
      kind: 'too_many',
      count: 101,
    });
  });

  it('builds the same commits from the same inputs (a replayed Workflow step rebuilds them)', async () => {
    const { fake, repo, git } = await fixture();
    const root = await commitFiles(repo, 'main', { 'a.txt': 'a\n' }, 'base');
    const head = await commitFiles(
      repo,
      'feature',
      { 'a.txt': 'a\n', 'b.txt': 'b\n' },
      'Add b',
      [root]
    );
    const tip = await commitFiles(repo, 'main', { 'a.txt': 'a2\n' }, 'Main');
    const again = new GitService(new ArtifactsRepoClient(fake.binding, 'r'));
    const [x, y] = [
      await rebase(git, { head, onto: tip, committer: AT }),
      await rebase(again, { head, onto: tip, committer: AT }),
    ];
    expect(x.kind === 'done' && y.kind === 'done' && x.head === y.head).toBe(
      true
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test worker/src/__tests__/git-rebase.test.ts`
Expected: FAIL — `Failed to load url ../git/patch-id` (the modules don't exist yet).

- [ ] **Step 3: Read tree objects back**

In `worker/src/git/objects.ts`, change the first import to also take `decoder` and `toHex`:

```ts
import { concat, decoder, encoder, fromHex, sha1, toHex } from './bytes';
```

and add after `makeTree`:

```ts
/** The type Artifacts reports for a tree entry's mode. */
function modeType(mode: string): ArtifactsTreeEntryType {
  if (mode === '40000' || mode === '040000') return 'tree';
  if (mode === '120000') return 'symlink';
  if (mode === '160000') return 'gitlink';
  if (mode === '100755') return 'exec';
  return 'blob';
}

/** A tree object's entries, as `readTree` returns them (for trees made in memory and not pushed yet). */
export function parseTree(data: Uint8Array): ArtifactsTreeEntry[] {
  const out: ArtifactsTreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0, sp);
    const mode = decoder.decode(data.subarray(i, sp));
    out.push({
      mode,
      name: decoder.decode(data.subarray(sp + 1, nul)),
      hash: toHex(data.subarray(nul + 1, nul + 21)),
      type: modeType(mode),
    });
    i = nul + 21;
  }
  return out;
}
```

- [ ] **Step 4: Let `GitService` read objects it made but hasn't pushed**

In `worker/src/git/service.ts`, import `parseTree` from `./objects` (add it to the existing import list), add a field
after `private headCache?: string | null;`:

```ts
  /** Objects made in memory (a rebase's trees, blobs and commits), readable before they are pushed. */
  private staged = new Map<string, GitObject>();
```

add a method in the `// ── objects ──` section, before `commit()`:

```ts
  /** Makes `objects` readable through tree() and blob() until this service is dropped (nothing is pushed). */
  stage(objects: GitObject[]) {
    for (const o of objects) this.staged.set(o.sha, o);
  }
```

and replace `tree()` and `blob()` with:

```ts
  async tree(sha: string): Promise<Entry[]> {
    const hit = this.trees.get(sha);
    if (hit) return hit;
    const staged = this.staged.get(sha);
    const t =
      staged?.type === 'tree'
        ? parseTree(staged.data)
        : ((await (await this.client.repo()).readTree(sha)) ?? []);
    this.trees.set(sha, t);
    return t;
  }

  async blob(sha: string): Promise<Uint8Array | null> {
    const staged = this.staged.get(sha);
    if (staged?.type === 'blob') return staged.data;
    const b = await (await this.client.repo()).readBlob(sha);
    return b ? new Uint8Array(await b.arrayBuffer()) : null;
  }
```

- [ ] **Step 5: Patch identity**

Create `worker/src/git/patch-id.ts`:

```ts
import { structuredPatch } from 'diff';
import { decoder, encoder, sha1, toHex } from './bytes';
import type { FileChange, GitService } from './service';

/** Above this (both sides together) a file's change counts by its blob ids, not its lines. */
const MAX_PATCH_BYTES = 1024 * 1024;

const isBinary = (b: Uint8Array) => b.subarray(0, 8000).includes(0);

/**
 * The patch identity of a change: a hash of each file's path, status and mode and of its added and removed lines with
 * every whitespace character removed. Line numbers and context lines are left out, so the same change made at another
 * place in a file, or next to different lines, has the same identity. Binary, submodule and huge changes count by
 * their blob ids.
 */
export async function changesPatchId(
  git: GitService,
  changes: FileChange[]
): Promise<string> {
  const parts: string[] = [];
  for (const ch of [...changes].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )) {
    parts.push(`${ch.status} ${ch.mode} ${ch.path}`);
    if (ch.mode === '160000') {
      parts.push(`${ch.oldHash} ${ch.newHash}`);
      continue;
    }
    const [a, b] = await Promise.all([
      ch.oldHash ? git.blob(ch.oldHash) : null,
      ch.newHash ? git.blob(ch.newHash) : null,
    ]);
    const size = (a?.length ?? 0) + (b?.length ?? 0);
    if (size > MAX_PATCH_BYTES || (a && isBinary(a)) || (b && isBinary(b))) {
      parts.push(`${ch.oldHash} ${ch.newHash}`);
      continue;
    }
    const patch = structuredPatch(
      ch.path,
      ch.path,
      a ? decoder.decode(a) : '',
      b ? decoder.decode(b) : '',
      '',
      '',
      { context: 0 }
    );
    for (const h of patch.hunks)
      for (const l of h.lines)
        if (l[0] === '+' || l[0] === '-')
          parts.push(l[0] + l.slice(1).replace(/\s+/g, ''));
  }
  return toHex(await sha1(encoder.encode(parts.join('\n'))));
}

/** The patch identity of the change from tree `a` to tree `b` (null: empty). */
export async function patchId(
  git: GitService,
  a: string | null,
  b: string | null
): Promise<string> {
  return changesPatchId(git, await git.diffTrees(a, b));
}
```

- [ ] **Step 6: The engine**

Create `worker/src/git/rebase.ts`:

```ts
import {
  makeCommit,
  makeTree,
  type GitObject,
  type Signature,
} from './objects';
import { changesPatchId, patchId } from './patch-id';
import type { Commit, ConflictFile, FileChange, GitService } from './service';

/** At most this many of a branch's own commits are replayed in one rebase. */
export const MAX_REBASE_COMMITS = 100;
/** The newest commits that reached the target since the merge base, checked for patch identity. */
const MAX_UPSTREAM = 500;
/** The trailer of a commit whose conflicts AI resolved. */
export const RESOLVED_TRAILER = 'Conflicts-resolved-by: GitOrange AI';
/** The committer of every rebased commit (its author stays the original one). */
export const REBASE_COMMITTER = {
  name: 'GitOrange',
  email: 'noreply@gitorange',
};

/** Resolved contents of conflicting commits: original commit sha → path → content (null deletes it). */
export type CommitResolutions = Map<string, Map<string, string | null>>;

export type ReplayedCommit = {
  original: string;
  rebased: string;
  /** Its conflicts were resolved (it carries RESOLVED_TRAILER). */
  resolved: boolean;
};

export type RebaseResult =
  /** The head already contains the target. */
  | { kind: 'up_to_date' }
  | { kind: 'too_many'; count: number }
  | {
      kind: 'done';
      head: string;
      commits: ReplayedCommit[];
      /** Commits left out: the target already had their change (patch identity), or nothing of it was left. */
      skipped: number;
      /** Every replayed commit that needed no resolution makes the same change as before. */
      samePatches: boolean;
      /** Every object the rebase made: what a push sends. */
      objects: GitObject[];
    }
  | {
      kind: 'conflict';
      /** The commit the replay stopped at. */
      commit: Commit;
      conflicts: string[];
      /** Text conflicts, with diff3 markers (labels: the target, then the commit's sha7). */
      files: ConflictFile[];
      replayed: ReplayedCommit[];
      skipped: number;
    };

export type RebaseOptions = {
  head: string;
  onto: string;
  committer: Signature;
  /** The target's name in conflict markers. */
  ontoLabel?: string;
  resolutions?: CommitResolutions;
};

const TRAILER_LINE = /^[A-Za-z][\w-]*: \S.*$/;

/** `message` with RESOLVED_TRAILER: in its trailer block when it ends in one, else as a new paragraph. */
export function withResolvedTrailer(message: string): string {
  const body = message.replace(/\s+$/, '');
  const paragraphs = body.split(/\n\n/);
  const last = paragraphs.at(-1) ?? '';
  const inBlock =
    paragraphs.length > 1 &&
    last.split('\n').every((l) => TRAILER_LINE.test(l));
  return `${body}${inBlock ? '\n' : '\n\n'}${RESOLVED_TRAILER}`;
}

async function parentTree(git: GitService, c: Commit): Promise<string | null> {
  if (!c.parents.length) return null;
  const p = await git.commit(c.parents[0]);
  if (!p) throw new Error(`Missing commit ${c.parents[0]}`);
  return p.treeHash;
}

const pathsKey = (changes: FileChange[]) =>
  changes
    .map((c) => c.path)
    .sort()
    .join('\0');

/**
 * Replays `head`'s own commits (since its merge base with `onto`, oldest first) onto `onto`. Each commit is a
 * three-way tree merge (base: its parent's tree; ours: the replay so far; theirs: the commit's tree) and keeps its
 * author, author date and message; the committer is `opts.committer`. Merge commits are flattened; commits already in
 * `onto`'s history, and commits whose patch identity matches one that reached `onto` since the merge base, are left
 * out, as are commits with nothing left to apply. Stops at the first commit that conflicts, unless
 * `opts.resolutions` has its contents. Pushes nothing: the new objects are returned (and staged on `git`).
 * Deterministic: the same inputs give the same commits.
 */
export async function rebase(
  git: GitService,
  opts: RebaseOptions
): Promise<RebaseResult> {
  const mb = await git.mergeBase(opts.onto, opts.head);
  if (mb === opts.onto) return { kind: 'up_to_date' };
  const onto = await git.commit(opts.onto);
  if (!onto) throw new Error(`Missing commit ${opts.onto}`);
  const own = (await git.commitsBetween(opts.onto, opts.head)).filter(
    (c) => c.parents.length <= 1
  );
  if (own.length > MAX_REBASE_COMMITS)
    return { kind: 'too_many', count: own.length };

  const changes = new Map<string, FileChange[]>();
  for (const c of own)
    changes.set(
      c.hash,
      await git.diffTrees(await parentTree(git, c), c.treeHash)
    );
  // Identities of what reached the target, only for commits touching exactly the paths one of ours touches.
  const keys = new Set([...changes.values()].map(pathsKey));
  const landed = new Set<string>();
  if (mb)
    for (const u of (await git.commitsBetween(opts.head, opts.onto)).slice(
      -MAX_UPSTREAM
    )) {
      if (u.parents.length > 1) continue;
      const ch = await git.diffTrees(await parentTree(git, u), u.treeHash);
      if (keys.has(pathsKey(ch))) landed.add(await changesPatchId(git, ch));
    }

  const objects: GitObject[] = [];
  const commits: ReplayedCommit[] = [];
  let skipped = 0;
  let samePatches = true;
  let tip = opts.onto;
  let tree = onto.treeHash;
  for (const c of own) {
    const id = await changesPatchId(git, changes.get(c.hash)!);
    if (landed.has(id)) {
      skipped++;
      continue;
    }
    const resolutions = opts.resolutions?.get(c.hash);
    const state = {
      created: [] as GitObject[],
      conflicts: [] as string[],
      conflictFiles: [] as ConflictFile[],
      resolutions,
      labels: { a: opts.ontoLabel ?? 'onto', o: 'base', b: c.hash.slice(0, 7) },
    };
    let merged = await git.mergeTrees(
      await parentTree(git, c),
      tree,
      c.treeHash,
      state
    );
    git.stage(state.created);
    objects.push(...state.created);
    if (state.conflicts.length)
      return {
        kind: 'conflict',
        commit: c,
        conflicts: state.conflicts,
        files: state.conflictFiles,
        replayed: commits,
        skipped,
      };
    if (!merged) {
      const empty = await makeTree([]);
      git.stage([empty]);
      objects.push(empty);
      merged = empty.sha;
    }
    if (merged === tree) {
      skipped++; // nothing of it is left to apply
      continue;
    }
    const resolved = !!resolutions?.size;
    const commit = await makeCommit({
      tree: merged,
      parents: [tip],
      author: {
        name: c.author.name,
        email: c.author.email,
        timestamp: c.authoredAt,
      },
      committer: opts.committer,
      message: resolved ? withResolvedTrailer(c.message) : c.message,
    });
    git.stage([commit]);
    objects.push(commit);
    if (!resolved && samePatches)
      samePatches = (await patchId(git, tree, merged)) === id;
    commits.push({ original: c.hash, rebased: commit.sha, resolved });
    tip = commit.sha;
    tree = merged;
  }
  return { kind: 'done', head: tip, commits, skipped, samePatches, objects };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `yarn test worker/src/__tests__/git-rebase.test.ts worker/src/__tests__/git-merge.test.ts worker/src/__tests__/git-objects.test.ts`
Expected: PASS.

- [ ] **Step 8: Add the test file to CI**

In `.github/workflows/ci.yml`, job `test-review`, after `worker/src/__tests__/git-merge.test.ts` add:

```yaml
worker/src/__tests__/git-rebase.test.ts
```

Run: `yarn test worker/src/__tests__/ci-workflow.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

Run: `yarn typecheck`
Expected: clean.

```bash
yarn -s prettier --write worker/src/git/objects.ts worker/src/git/service.ts worker/src/git/patch-id.ts \
  worker/src/git/rebase.ts worker/src/__tests__/git-rebase.test.ts
git add worker/src/git/objects.ts worker/src/git/service.ts worker/src/git/patch-id.ts worker/src/git/rebase.ts \
  worker/src/__tests__/git-rebase.test.ts .github/workflows/ci.yml
git commit -m "Rebase engine: replay a branch onto a new base, skipping by ancestry and patch identity" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Rebase runs replace squash-era conflict resolution

GitOrange rebases a behind pull request in the background; a conflict stops the run and is recorded for the agent
(AI resolution of a commit is Task 3). The squash-era whole-PR resolution (`executeResolution`, its routes, its
`refs/resolutions/` commits, the merge box's "proposed resolution") goes, with everything that read it.

**Files:**

- Modify: `worker/src/db/app.schema.ts` (`pullRequests`: `landedCommits`; `mergeResolutions`: `commitSha`,
  `resolvedFiles`, statuses; `PrEventKind` and `prEvents.kind`: `rebased`; `agentRunKinds`: `rebase`)
- Create (generated): `migrations/0024_rebase_merging.sql`, `migrations/0025_cancel_squash_resolutions.sql`,
  `migrations/meta/*`
- Modify: `worker/src/merge/resolution.ts` (cut to the shared helpers)
- Create: `worker/src/merge/rebase.ts`
- Modify: `worker/src/merge/auto.ts` (`startSweep`; the sweep's second pass starts rebases)
- Modify: `worker/src/merge/workflow.ts` (`rebase` payload; `resolutionId` becomes a no-op)
- Modify: `worker/src/merge/land.ts` (drop the resolution branch; `startSweep`)
- Modify: `worker/src/git-http.ts` (`startSweep`)
- Modify: `worker/src/lib/pulls.ts` (`openPull`: `ensureRebase`)
- Modify: `worker/src/routers/pulls-router.ts` (list `aiResolution`, PR detail `rebase`, reopen, merge body, delete
  the resolution routes)
- Modify: `worker/src/routers/repos-router.ts` (`compareShas`: dry-run rebase)
- Modify: `worker/src/review/auto-merge.ts`, `worker/src/mcp/pull-tools.ts` (rebase view)
- Modify: `worker/src/stack/retarget.ts`, `worker/src/stack/reconcile.ts` (rebase moved pull requests)
- Modify: `worker/src/pulls/state.ts`, `worker/src/pulls/signals.ts`, `worker/src/pulls/settle.ts`
- Modify: `worker/src/agent-runs/record.ts`, `worker/src/lib/insights.ts`
- Create: `worker/src/__tests__/helpers/rebase.ts`, `worker/src/__tests__/rebase-runs.test.ts`
- Modify tests: `helpers/app.ts`, `helpers/stacking.ts`, `pull-states.test.ts`, `pulls-ai-resolution.test.ts`,
  `land-target.test.ts`, `mcp.test.ts`, `agent-runs.test.ts`, `stacking-landing.test.ts`, `insights.test.ts`,
  `repos-pulls.test.ts`
- Delete: `worker/src/__tests__/merge-resolution.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes (Task 1): `rebase`, `REBASE_COMMITTER`, `MAX_REBASE_COMMITS`, `RebaseResult`, `CommitResolutions`.
- Produces (`worker/src/merge/rebase.ts`):
  - `type RebaseParams = { pullRequestId: string }`; `type RebaseTips = { onto: string; ontoBranch: string; head: string }`.
  - `rebaseTips(git: GitService, pr: Pick<PullRequest, 'baseRef' | 'landTarget' | 'headRef'>): Promise<RebaseTips | null>` — onto base_ref's tip, or the land target's when that branch is gone.
  - `rebaseAt(git: GitService, db: DrizzleDB, pr: Pick<PullRequest, 'id'>, tips: RebaseTips, committer: Signature): Promise<RebaseResult>` — with the `resolved` rows' contents for these tips.
  - `resolutionId(pullRequestId: string, tips: { onto: string; head: string }, commit: string | null): string`.
  - `preRebaseRef(number: number, sha: string): string`.
  - `stopMessage.tooMany(n)`, `.notText(commit, paths)`, `.generated(commit, paths)`, `.noAi(commit, paths)`.
  - `recordStop(db, pullRequestId: string, tips, stop: { commit: string | null; paths: string[]; error: string }): Promise<string>` (returns `stop.error`).
  - `ensureRebase(env, db, git, pr: PullRequest): Promise<boolean>` — never throws.
  - `writeRebase(git, pr: Pick<PullRequest, 'number' | 'headRef'>, tips, result: Extract<RebaseResult, { kind: 'done' }>): Promise<'written' | 'moved'>`.
  - `type Written = { from: string; to: string; ontoBranch: string; skipped: number; resolved: { original: string; rebased: string }[]; clean: boolean }`; `written(tips, result): Written`.
  - `afterRebase(env, db, opts: { repo: Repository; repoFullName: string; pr: PullRequest; w: Written }): Promise<void>`.
  - `interface RebaseDeps { env; db; step: StepRunner; resolver?: (resolutionId: string) => ConflictResolverApi }`; `executeRebase(deps: RebaseDeps, params: RebaseParams): Promise<void>`.
  - `type RebaseStatus = 'nothing_to_merge' | 'up_to_date' | 'behind' | 'resolving' | 'conflict'`; `type RebaseView = { status: RebaseStatus; onto: string; commit: string | null; files: string[]; error: string | null }`; `rebaseView(env, db, git, pr: Pick<PullRequest, 'id'>, tips: RebaseTips): Promise<RebaseView>`.
- Produces elsewhere: `startSweep(env, repo, updates)` (`merge/auto.ts`, was `autoResolveConflicts`); reason
  `{ kind: 'rebase_conflict'; commit: string | null; files: string[]; error: string | null }` (`pulls/state.ts`);
  schema `mergeResolutions.commitSha`, `.resolvedFiles` (`Record<string, string> | null`), statuses
  `'running' | 'resolved' | 'applied' | 'failed' | 'rejected'`; `pullRequests.landedCommits` (`number | null`, used
  in Task 5); event kind `rebased` (`data: { from, to, onto, skipped, resolved }`); agent run kind `rebase`.
- Kept in `worker/src/merge/resolution.ts`: `StepRunner`, `resolutionConfigured`, `resolverModel`,
  `latestResolution`, `transcriptKey`, `SUPERSEDED`, `NO_MODEL`, `SETTLE_MS`.
- Test helpers (`helpers/rebase.ts`): `step`, `namedSteps()`, `fakeResolver(answer?)`, `runRebases(t, opts?)`,
  `runSweeps(t)`, `moved(t, branch, old)`, `rows(t)`, `NOTES`, `divergedPull(opts?)`, `detail(t, cookie, n?)`.

- [ ] **Step 1: Write the test helpers**

Create `worker/src/__tests__/helpers/rebase.ts`:

```ts
/** Rebase fixtures: a pull request whose base moved, running queued sweeps and rebase runs inline, conflict rows. */
import { expect } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../../db/schema';
import type { Repository } from '../../db/app.schema';
import { executeSweep, startSweep, type SweepParams } from '../../merge/auto';
import { executeRebase, type RebaseParams } from '../../merge/rebase';
import type { StepRunner } from '../../merge/resolution';
import type {
  ConflictResolverApi,
  ResolveRequest,
  ResolveResult,
} from '../../merge/resolver';
import { bootstrapAdmin, call, makeEnv, settle, type TestEnv } from './app';
import { commitFiles } from './seed';

export const step = {
  do: async (_name: string, a: unknown, b?: unknown) =>
    ((b ?? a) as () => Promise<unknown>)(),
  sleep: async () => {},
} as unknown as StepRunner;

/** A step runner that records step names and can act before a step runs (`before(name)`). */
export function namedSteps(before?: (name: string) => Promise<void> | void) {
  const names: string[] = [];
  const runner = {
    do: async (name: string, a: unknown, b?: unknown) => {
      names.push(name);
      await before?.(name);
      return ((b ?? a) as () => Promise<unknown>)();
    },
    sleep: async () => {},
  } as unknown as StepRunner;
  return { names, step: runner };
}

/** A resolver answering `answer(request, id)` (default: done, no files), recording each request. */
export function fakeResolver(
  answer?: (
    req: ResolveRequest,
    id: string
  ) => Partial<ResolveResult> | Promise<Partial<ResolveResult>>
) {
  const requests: { id: string; request: ResolveRequest }[] = [];
  const resolver = (id: string): ConflictResolverApi => ({
    resolve: async (request) => {
      requests.push({ id, request });
      return {
        status: 'done',
        explanation: 'Kept both.',
        files: {},
        transcript: '[]',
        ...(await answer?.(request, id)),
      };
    },
  });
  return { resolver, requests };
}

const ranSweeps = new WeakMap<TestEnv, Set<string>>();
/** Runs every sweep started so far (once each). */
export async function runSweeps(t: TestEnv) {
  const db = drizzle(t.env.DB, { schema });
  const done = ranSweeps.get(t) ?? new Set<string>();
  ranSweeps.set(t, done);
  for (;;) {
    await settle(t);
    const next = t.actions.resolutions.find(
      (s) => !done.has(s.id) && (s.params as { sweep?: SweepParams }).sweep
    );
    if (!next) return;
    done.add(next.id);
    await executeSweep(
      { env: t.env, db, step },
      (next.params as { sweep: SweepParams }).sweep
    );
  }
}

const ranRebases = new WeakMap<TestEnv, Set<string>>();
/** Runs every sweep and rebase run started so far (once each), until none are left; returns how many rebases ran. */
export async function runRebases(
  t: TestEnv,
  opts: {
    resolver?: (id: string) => ConflictResolverApi;
    step?: StepRunner;
  } = {}
) {
  const db = drizzle(t.env.DB, { schema });
  const done = ranRebases.get(t) ?? new Set<string>();
  ranRebases.set(t, done);
  let n = 0;
  for (;;) {
    // A written rebase starts a sweep (its own new head; pull requests stacked on its branch): run it first.
    await runSweeps(t);
    const next = t.actions.resolutions.find(
      (s) => !done.has(s.id) && (s.params as { rebase?: RebaseParams }).rebase
    );
    if (!next) return n;
    done.add(next.id);
    n++;
    await executeRebase(
      { env: t.env, db, step: opts.step ?? step, resolver: opts.resolver },
      (next.params as { rebase: RebaseParams }).rebase
    );
  }
}

/** Starts the sweep a push of `branch` (from `old`) starts, and runs it. */
export async function moved(t: TestEnv, branch: string, old: string) {
  const repo = [...t.fake.repos.values()][0];
  const id = (await t.env.DB.prepare(
    "SELECT id FROM repositories WHERE name = 'app'"
  ).first<{ id: string }>())!.id;
  await startSweep(t.env, { id } as Repository, [
    {
      ref: `refs/heads/${branch}`,
      old,
      new: repo.refs.get(`refs/heads/${branch}`)!,
    },
  ]);
  await runSweeps(t);
}

export type ResolutionRow = {
  id: string;
  commit: string | null;
  status: string;
  model: string;
  paths: string;
  error: string | null;
  base: string;
  head: string;
  result: string | null;
  files: string | null;
};

/** Every merge_resolutions row, oldest first. */
export async function rows(t: TestEnv): Promise<ResolutionRow[]> {
  return (
    await t.env.DB.prepare(
      `SELECT id, commit_sha AS "commit", status, model, conflicted_paths AS paths, error_message AS error,
              base_sha AS base, head_sha AS head, result_sha AS result, resolved_files AS files
         FROM merge_resolutions ORDER BY created_at, rowid`
    ).all<ResolutionRow>()
  ).results;
}

export const NOTES = 'one\ntwo\nthree\nfour\nfive\n';

/**
 * octocat/app: `notes.txt` on main; PR #1 from `feature` with two commits (`Add b`, then `Elaborate on three`, which
 * changes line three); then main moves: line three changes too (`conflict`), or `other.txt` is added. Not swept yet.
 */
export async function divergedPull(opts: { conflict?: boolean } = {}) {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'internal' },
  });
  const repo = [...t.fake.repos.values()][0];
  const root = await commitFiles(repo, 'main', { 'notes.txt': NOTES }, 'base');
  const f1 = await commitFiles(
    repo,
    'feature',
    { 'notes.txt': NOTES, 'b.txt': 'b\n' },
    'Add b',
    [root]
  );
  const f2 = await commitFiles(
    repo,
    'feature',
    {
      'notes.txt': NOTES.replace('three', 'three, and a half'),
      'b.txt': 'b\n',
    },
    'Elaborate on three'
  );
  const res = await call(t, '/api/repos/octocat/app/pulls', {
    cookie: admin,
    json: {
      title: 'Elaborate',
      body: 'Line three needs more detail.',
      base: 'main',
      head: 'feature',
    },
  });
  expect(res.status).toBe(201);
  await settle(t);
  const tip = await commitFiles(
    repo,
    'main',
    opts.conflict
      ? { 'notes.txt': NOTES.replace('three', 'THREE (main)') }
      : { 'notes.txt': NOTES, 'other.txt': 'x\n' },
    'Main moves'
  );
  return { t, admin, repo, root, f1, f2, tip };
}

export type Detail = {
  mergeable: boolean | null;
  rebase: {
    status: string;
    onto: string;
    commit: string | null;
    files: string[];
    error: string | null;
  } | null;
  pullState: {
    state: string;
    reasons: { kind: string; [k: string]: unknown }[];
  } | null;
};

/** The pull request page's data. */
export async function detail(
  t: TestEnv,
  cookie: string,
  n = 1
): Promise<Detail> {
  return (await (
    await call(t, `/api/repos/octocat/app/pulls/${n}`, { cookie })
  ).json()) as Detail;
}
```

In `worker/src/__tests__/helpers/app.ts`, make the fake `MERGE_RESOLUTION.create` refuse an id it already has, as
Workflows does:

```ts
  const MERGE_RESOLUTION = {
    create: async (opts: { id: string; params: unknown }) => {
      if (resolutions.some((r) => r.id === opts.id))
        throw new Error(`instance ${opts.id} already exists`);
      resolutions.push(opts);
      return { id: opts.id };
    },
```

In `worker/src/__tests__/helpers/stacking.ts`, rename the import and call of `autoResolveConflicts` to `startSweep`
(`import { executeSweep, startSweep, type SweepParams } from '../../merge/auto';` and `await startSweep(t.env, …)` in
`pushTo`).

- [ ] **Step 2: Write the failing tests**

Create `worker/src/__tests__/rebase-runs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { call, settle } from './helpers/app';
import { commitFiles } from './helpers/seed';
import {
  detail,
  divergedPull,
  moved,
  namedSteps,
  NOTES,
  rows,
  runRebases,
} from './helpers/rebase';
import { events } from './helpers/stacking';

/** The commits from `head` down to (not including) `stop`, newest first: [sha, message]. */
function chain(
  repo: Awaited<ReturnType<typeof divergedPull>>['repo'],
  head: string,
  stop: string
) {
  const out: [string, string][] = [];
  for (let sha = head; sha !== stop;) {
    const c = repo.parseCommit(sha);
    if (!c) throw new Error(`${stop} is not an ancestor`);
    out.push([sha, c.message]);
    sha = c.parents[0];
  }
  return out;
}

describe('rebase runs', () => {
  it('rebases an open pull request when its target moves, keeping the old head and recording it', async () => {
    const { t, admin, repo, f2, root } = await divergedPull();
    expect((await detail(t, admin)).rebase!.status).toBe('behind');
    await moved(t, 'main', root);
    expect(await runRebases(t)).toBeGreaterThan(0);
    const head = repo.refs.get('refs/heads/feature')!;
    const tip = repo.refs.get('refs/heads/main')!;
    expect(chain(repo, head, tip).map(([, m]) => m)).toEqual([
      'Elaborate on three',
      'Add b',
    ]);
    expect(repo.refs.get(`refs/pull/1/pre-rebase/${f2.slice(0, 7)}`)).toBe(f2);
    expect(await events(t, 1)).toContainEqual({
      kind: 'rebased',
      data: { from: f2, to: head, onto: 'main', skipped: 0, resolved: 0 },
    });
    const d = await detail(t, admin);
    expect(d.rebase!.status).toBe('up_to_date');
    expect(d.mergeable).toBe(true);
    expect(await rows(t)).toEqual([]);
  });

  it('queues a rebase when a pull request behind its base opens', async () => {
    const { t, admin, repo, root } = await divergedPull();
    await commitFiles(
      repo,
      'two',
      { 'notes.txt': NOTES, 'c.txt': 'c\n' },
      'Add c',
      [root]
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Two', body: '', base: 'main', head: 'two' },
    });
    await runRebases(t);
    const head = repo.refs.get('refs/heads/two')!;
    expect(repo.parseCommit(head)!.parents).toEqual([
      repo.refs.get('refs/heads/main'),
    ]);
  });

  it('starts over from the new head when the agent pushes during the rebase', async () => {
    const { t, repo, f2, root } = await divergedPull();
    await moved(t, 'main', root);
    let pushed = '';
    const { step, names } = namedSteps(async (name) => {
      if (name !== 'write:0') return;
      pushed = await commitFiles(
        repo,
        'feature',
        {
          'notes.txt': NOTES.replace('three', 'three, and a half'),
          'b.txt': 'b\n',
          'late.txt': 'late\n',
        },
        'Late'
      );
    });
    await runRebases(t, { step });
    expect(names).toContain('write:1');
    const head = repo.refs.get('refs/heads/feature')!;
    const tip = repo.refs.get('refs/heads/main')!;
    expect(chain(repo, head, tip).map(([, m]) => m)).toEqual([
      'Late',
      'Elaborate on three',
      'Add b',
    ]);
    // Only the head that was replaced is kept: the agent's own push was never overwritten.
    expect(repo.refs.get(`refs/pull/1/pre-rebase/${pushed.slice(0, 7)}`)).toBe(
      pushed
    );
    expect(repo.refs.has(`refs/pull/1/pre-rebase/${f2.slice(0, 7)}`)).toBe(
      false
    );
  });

  it('records a conflict for the agent, and leaves the branch alone, when AI isn’t there', async () => {
    const { t, admin, repo, f2, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    await runRebases(t); // no resolver
    expect(repo.refs.get('refs/heads/feature')).toBe(f2);
    const [row] = await rows(t);
    expect(row).toMatchObject({
      commit: f2,
      status: 'failed',
      model: 'none',
      paths: '["notes.txt"]',
    });
    expect(row.error).toMatch(
      /^Commit [0-9a-f]{7} conflicts in notes\.txt\. Rebase locally\.$/
    );
    const d = await detail(t, admin);
    expect(d.rebase).toMatchObject({
      status: 'conflict',
      commit: f2,
      files: ['notes.txt'],
    });
    expect(d.mergeable).toBe(false);
    expect(d.pullState!.state).toBe('agent_followup');
    expect(d.pullState!.reasons).toContainEqual({
      kind: 'rebase_conflict',
      commit: f2,
      files: ['notes.txt'],
      error: row.error,
    });
  });

  it('records a conflict AI can’t take: a file deleted on one side and changed on the other', async () => {
    const { t, admin, repo, root } = await divergedPull();
    await commitFiles(repo, 'gone', { 'b.txt': 'b\n' }, 'Delete notes', [root]);
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Gone', body: '', base: 'main', head: 'gone' },
    });
    const old = repo.refs.get('refs/heads/main')!;
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': NOTES.replace('one', 'ONE'), 'other.txt': 'x\n' },
      'Edit notes'
    );
    await moved(t, 'main', old);
    await runRebases(t);
    const gone = (await rows(t)).find((r) => r.paths === '["notes.txt"]')!;
    expect(gone.error).toMatch(/deleted on one side and changed on the other/);
  });

  it('reports too many commits, to squash locally', async () => {
    const { t, repo, root } = await divergedPull();
    for (let i = 0; i < 100; i++)
      await commitFiles(
        repo,
        'feature',
        { 'notes.txt': NOTES, 'b.txt': `${i}\n` },
        `#${i}`
      );
    await moved(t, 'main', root);
    await runRebases(t);
    expect(await rows(t)).toEqual([
      expect.objectContaining({
        commit: null,
        status: 'failed',
        error:
          'Too many commits to rebase (102; at most 100) — squash locally.',
      }),
    ]);
  });

  it('rebases again after the agent force-pushes the old head', async () => {
    const { t, admin, repo, f2, root } = await divergedPull();
    await moved(t, 'main', root);
    await runRebases(t);
    const first = repo.refs.get('refs/heads/feature')!;
    repo.refs.set('refs/heads/feature', f2); // git push --force of the old head
    expect((await detail(t, admin)).rebase!.status).toBe('behind'); // the page starts a rebase
    await runRebases(t);
    const again = repo.refs.get('refs/heads/feature')!;
    expect(again).not.toBe(f2);
    expect(chain(repo, again, repo.refs.get('refs/heads/main')!)).toHaveLength(
      2
    );
    expect(repo.refs.get(`refs/pull/1/pre-rebase/${f2.slice(0, 7)}`)).toBe(f2);
    expect(first).not.toBe(f2);
  });

  it('two runs at the same tips write once', async () => {
    const { t, admin, repo, root } = await divergedPull();
    await moved(t, 'main', root);
    await detail(t, admin); // a page view starts a second run before the first ran
    await settle(t);
    expect(
      t.actions.resolutions.filter(
        (r) => (r.params as { rebase?: unknown }).rebase
      )
    ).toHaveLength(2);
    await runRebases(t);
    expect(
      (await events(t, 1)).filter((e) => e.kind === 'rebased')
    ).toHaveLength(1);
    expect(
      chain(
        repo,
        repo.refs.get('refs/heads/feature')!,
        repo.refs.get('refs/heads/main')!
      )
    ).toHaveLength(2);
  });

  it('ends quietly when the branch is deleted before the write', async () => {
    const { t, repo, root } = await divergedPull();
    await moved(t, 'main', root);
    const { step } = namedSteps((name) => {
      if (name === 'write:0') repo.refs.delete('refs/heads/feature');
    });
    await runRebases(t, { step });
    expect(repo.refs.has('refs/heads/feature')).toBe(false);
    expect([...repo.refs.keys()].some((r) => r.includes('pre-rebase'))).toBe(
      false
    );
  });

  it('rebases a stacked child onto its parent’s branch when the parent moves', async () => {
    const { t, admin, repo, f2, root } = await divergedPull();
    // #2 from `child`, built on feature, stacked on it by hand (as a reconcile would).
    const child = await commitFiles(
      repo,
      'child',
      {
        'notes.txt': NOTES.replace('three', 'three, and a half'),
        'b.txt': 'b\n',
        'c.txt': 'c\n',
      },
      'Add c',
      [f2]
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Child', body: '', base: 'main', head: 'child' },
    });
    await t.env.DB.prepare(
      "UPDATE pull_requests SET base_ref = 'feature' WHERE number = 2"
    ).run();
    await moved(t, 'main', root); // rebases #1; its new head moves `feature`, which rebases #2
    await runRebases(t);
    const parent = repo.refs.get('refs/heads/feature')!;
    expect(parent).not.toBe(f2);
    const head = repo.refs.get('refs/heads/child')!;
    expect(head).not.toBe(child);
    expect(repo.parseCommit(head)!.parents).toEqual([parent]);
    expect(repo.parseCommit(head)!.message).toBe('Add c');
  });

  it('rebases children onto the land target once their parent closes', async () => {
    const { t, admin, repo, f2 } = await divergedPull();
    await commitFiles(
      repo,
      'child',
      { 'notes.txt': NOTES, 'b.txt': 'b\n', 'c.txt': 'c\n' },
      'Add c',
      [f2]
    );
    await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title: 'Child', body: '', base: 'main', head: 'child' },
    });
    await t.env.DB.prepare(
      "UPDATE pull_requests SET base_ref = 'feature' WHERE number = 2"
    ).run();
    await call(t, '/api/repos/octocat/app/pulls/1', {
      cookie: admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    await runRebases(t);
    const head = repo.refs.get('refs/heads/child')!;
    // Its own commit and the closed parent's, now on main's tip.
    expect(
      chain(repo, head, repo.refs.get('refs/heads/main')!).map(([, m]) => m)
    ).toEqual(['Add c', 'Elaborate on three', 'Add b']);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `yarn test worker/src/__tests__/rebase-runs.test.ts`
Expected: FAIL — `Failed to load url ../../merge/rebase` (and `startSweep` is not exported).

- [ ] **Step 4: Change the schema and generate the migrations**

In `worker/src/db/app.schema.ts`:

In `pullRequests`, after `mergeCommitSha: text('merge_commit_sha'),` add:

```ts
    // How many commits a rebase landing added to the target (merge_commit_sha is the landed head). NULL: landed before
    // rebase merging, as one squash commit.
    landedCommits: integer('landed_commits'),
```

Replace the `mergeResolutions` table with:

```ts
// One AI resolution of one pull request commit whose replay conflicted during a rebase (worker/src/merge/rebase.ts), or
// a rebase that stopped for the agent (model 'none'). Squash-era rows (one per pull request and tips, commit_sha NULL)
// stay as history.
export const mergeResolutions = sqliteTable(
  'merge_resolutions',
  {
    // `<pr id>-<onto 12>-<head 12>-<commit 12 | all>` (resolutionId): one row per pull request, tips and commit.
    id: text('id').primaryKey(),
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    /** The tip the rebase was onto (base_ref's), and the pull request head it rebased. */
    baseSha: text('base_sha').notNull(),
    headSha: text('head_sha').notNull(),
    /** The pull request commit whose replay conflicted; NULL when the rebase stopped before any (too many commits). */
    commitSha: text('commit_sha'),
    // running → resolved (contents ready) → applied (the rebase was written), or failed. rejected: squash-era only.
    status: text('status', {
      enum: ['running', 'resolved', 'applied', 'failed', 'rejected'],
    })
      .notNull()
      .default('running'),
    model: text('model').notNull(),
    conflictedPaths: text('conflicted_paths', { mode: 'json' })
      .$type<string[]>()
      .notNull(),
    /** The resolved contents of conflictedPaths (path → text), once resolved. */
    resolvedFiles: text('resolved_files', { mode: 'json' }).$type<
      Record<string, string>
    >(),
    /** Files the model changed outside the conflicted ones. */
    touchedExtraPaths: text('touched_extra_paths', { mode: 'json' }).$type<
      string[]
    >(),
    explanation: text('explanation'),
    errorMessage: text('error_message'),
    /** The rebased commit made from commit_sha with these contents, once written. */
    resultSha: text('result_sha'),
    transcriptR2Key: text('transcript_r2_key'),
    durationMs: integer('duration_ms'),
    createdById: text('created_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    decidedAt: integer('decided_at', { mode: 'timestamp' }),
  },
  (t) => [index('merge_resolutions_pr_idx').on(t.pullRequestId, t.createdAt)]
);
```

Add `| 'rebased'` to `PrEventKind` (comment: `// GitOrange rebased the pull request's branch onto its base.`) and `'rebased'`
to the `prEvents.kind` enum list; add `'rebase'` to `agentRunKinds` after `'learning'`.

Run: `yarn db:generate --name=rebase_merging`
Expected: `migrations/0024_rebase_merging.sql` with exactly three statements — `ALTER TABLE \`merge_resolutions\`
ADD \`commit_sha\` text;`, `ALTER TABLE \`merge_resolutions\` ADD \`resolved_files\` text;`, `ALTER TABLE
\`pull_requests\` ADD \`landed_commits\` integer;` (no prompt: nothing is dropped or renamed). Review it.

Run: `yarn db:generate --custom --name=cancel_squash_resolutions`
Expected: an empty `migrations/0025_cancel_squash_resolutions.sql`. Fill it with:

```sql
-- Rebase merging (2026-10-07): squash-era AI resolutions are cancelled. A queued, running or proposed row was a
-- whole-pull-request resolution that merging would have landed; nothing lands one any more. Runs after the code deploy.
UPDATE merge_resolutions
   SET status = 'failed', error_message = 'Superseded by newer commits.', decided_at = unixepoch()
 WHERE status IN ('queued', 'running', 'proposed');
```

Run: `yarn db:migrate:local`
Expected: both apply.

- [ ] **Step 5: Cut `resolution.ts` to what rebase runs share**

Replace `worker/src/merge/resolution.ts` with:

```ts
import type { WorkflowStepConfig } from 'cloudflare:workers';
import { desc, eq, sql } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import { mergeResolutions, type MergeResolution } from '../db/app.schema';
import { getSetting } from '../lib/settings';

/** R2 key of a resolution's transcript. */
export const transcriptKey = (repoId: string, id: string) =>
  `merge-resolutions/${repoId}/${id}.json`;

/** The error a row gets when newer commits replaced the ones it was for. */
export const SUPERSEDED = 'Superseded by newer commits.';
/** The model of a failed row recording a stop AI never attempted (binary, delete/edit, generated, too many). */
export const NO_MODEL = 'none';

/**
 * How long a sweep waits before it starts rebases, so a burst of landings on the target wakes to the same tip and ends
 * in one rebase per pull request instead of one per landing.
 */
export const SETTLE_MS = 45_000;

/** The model conflict resolution uses: Site admin's setting, else `RESOLVER_MODEL`. */
export const resolverModel = (db: DrizzleDB, env: CloudflareBindings) =>
  getSetting(db, env, 'ai.resolver_model');

/** Whether the MERGE_RESOLUTION Workflow (rebases, reviews, stacking, lessons) runs here. */
export function resolutionConfigured(env: CloudflareBindings): boolean {
  return Boolean((env as Partial<CloudflareBindings>).MERGE_RESOLUTION);
}

/** The latest merge_resolutions row of a pull request (a run writes its rows in replay order: rowid breaks a tie). */
export async function latestResolution(
  db: DrizzleDB,
  pullRequestId: string
): Promise<MergeResolution | undefined> {
  return db
    .select()
    .from(mergeResolutions)
    .where(eq(mergeResolutions.pullRequestId, pullRequestId))
    .orderBy(desc(mergeResolutions.createdAt), sql`rowid DESC`)
    .limit(1)
    .get();
}

/** The part of WorkflowStep the executors use; tests pass a direct-call fake. */
export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    fn: () => Promise<T>
  ): Promise<T>;
  /** A durable sleep (milliseconds). */
  sleep(name: string, duration: number): Promise<void>;
  /**
   * Waits for `instance.sendEvent({ type })`; throws when `timeout` passes first. Optional: callers fall back to a
   * sleep where a runner lacks it.
   */
  waitForEvent?<T = unknown>(
    name: string,
    options: { type: string; timeout?: string }
  ): Promise<{ payload: T }>;
}
```

- [ ] **Step 6: Rebase runs**

Create `worker/src/merge/rebase.ts`:

```ts
/**
 * Rebase runs. GitOrange keeps each open pull request rebased onto its base_ref (a parent pull request's branch while
 * stacked, else the land target): a `rebase` payload on MERGE_RESOLUTION replays the pull request's own commits
 * (git/rebase.ts) and replaces the branch with compare-and-swap on the old head, keeping the old head as
 * refs/pull/N/pre-rebase/<sha7>. A commit whose replay conflicts gets a merge_resolutions row; where the run stops,
 * the pull request shows `rebase_conflict` and its agent rebases locally.
 */
import { and, eq, gt } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  agentRuns,
  mergeResolutions,
  pullRequests,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import { onRefsUpdated } from '../actions/trigger';
import type { Signature } from '../git/objects';
import { GitPushError, ZERO_SHA } from '../git/remote';
import {
  MAX_REBASE_COMMITS,
  rebase,
  REBASE_COMMITTER,
  type CommitResolutions,
  type RebaseResult,
} from '../git/rebase';
import type { GitService } from '../git/service';
import { landTargetOf } from '../lib/land-target';
import { findRepoById, gitFor } from '../lib/repos';
import { pingingSteps, publishChange } from '../live/publish';
import { recordEvent } from '../pulls/events';
import { contains } from '../stack/contains';
import { startSweep } from './auto';
import { generatedConflicts } from './generated';
import {
  latestResolution,
  NO_MODEL,
  resolutionConfigured,
  SUPERSEDED,
  type StepRunner,
} from './resolution';
import type { ConflictResolverApi } from './resolver';

export type RebaseParams = { pullRequestId: string };

/** What a rebase is between: the tip it goes onto (and that branch), and the pull request's head. */
export type RebaseTips = { onto: string; ontoBranch: string; head: string };

/** Tries per run: a push to the branch while it rebases starts it over from the new tips. */
export const MAX_REBASE_ATTEMPTS = 3;
/** A rebase run still marked running this long after it started no longer holds back a new one. */
export const REBASE_RUN_FRESH_MS = 15 * 60_000;

const ONCE = { retries: { limit: 0, delay: 0 } } as const;
const sha7 = (s: string) => s.slice(0, 7);

/** Where a rebase keeps the head it replaced. */
export const preRebaseRef = (number: number, sha: string) =>
  `refs/pull/${number}/pre-rebase/${sha7(sha)}`;

/** A merge_resolutions row's id: one per pull request, tips and commit (null: the rebase as a whole). */
export const resolutionId = (
  pullRequestId: string,
  tips: { onto: string; head: string },
  commit: string | null
) =>
  `${pullRequestId}-${tips.onto.slice(0, 12)}-${tips.head.slice(0, 12)}-${commit ? commit.slice(0, 12) : 'all'}`;

/** Why a rebase stopped for the agent (merge_resolutions.error_message, shown with `rebase_conflict`). */
export const stopMessage = {
  tooMany: (n: number) =>
    `Too many commits to rebase (${n}; at most ${MAX_REBASE_COMMITS}) — squash locally.`,
  notText: (commit: string, paths: string[]) =>
    `Commit ${sha7(commit)} conflicts in ${paths.join(', ')}: binary files, or a file deleted on one side and changed on the other. Rebase locally.`,
  generated: (commit: string, paths: string[]) =>
    `Commit ${sha7(commit)} conflicts in generated files (${paths.join(', ')}). Rebase locally and regenerate them.`,
  noAi: (commit: string, paths: string[]) =>
    `Commit ${sha7(commit)} conflicts in ${paths.join(', ')}. Rebase locally.`,
};

/** The tips a pull request rebases between: base_ref's (the land target's when that branch is gone) and its head. */
export async function rebaseTips(
  git: GitService,
  pr: Pick<PullRequest, 'baseRef' | 'landTarget' | 'headRef'>
): Promise<RebaseTips | null> {
  const [base, target, head] = await Promise.all([
    git.resolve(pr.baseRef),
    git.resolve(landTargetOf(pr)),
    git.resolve(pr.headRef),
  ]);
  const onto = base ?? target;
  if (!onto || !head) return null;
  return { onto, ontoBranch: base ? pr.baseRef : landTargetOf(pr), head };
}

/** The resolved contents of the pull request's conflicting commits at these tips, by original commit. */
async function resolutionsFor(
  db: DrizzleDB,
  pullRequestId: string,
  tips: { onto: string; head: string }
): Promise<CommitResolutions> {
  const resolved = await db
    .select({
      commitSha: mergeResolutions.commitSha,
      files: mergeResolutions.resolvedFiles,
    })
    .from(mergeResolutions)
    .where(
      and(
        eq(mergeResolutions.pullRequestId, pullRequestId),
        eq(mergeResolutions.baseSha, tips.onto),
        eq(mergeResolutions.headSha, tips.head),
        eq(mergeResolutions.status, 'resolved')
      )
    )
    .all();
  const out: CommitResolutions = new Map();
  for (const r of resolved)
    if (r.commitSha && r.files)
      out.set(r.commitSha, new Map(Object.entries(r.files)));
  return out;
}

/** Rebases the pull request's head onto `tips.onto` in memory, with every resolution made for these tips. */
export async function rebaseAt(
  git: GitService,
  db: DrizzleDB,
  pr: Pick<PullRequest, 'id'>,
  tips: RebaseTips,
  committer: Signature
): Promise<RebaseResult> {
  return rebase(git, {
    head: tips.head,
    onto: tips.onto,
    committer,
    ontoLabel: tips.ontoBranch,
    resolutions: await resolutionsFor(db, pr.id, tips),
  });
}

/** Records where a rebase stopped for the agent (a failed row AI never attempted); returns the message. */
export async function recordStop(
  db: DrizzleDB,
  pullRequestId: string,
  tips: { onto: string; head: string },
  stop: { commit: string | null; paths: string[]; error: string }
): Promise<string> {
  const now = new Date();
  await db
    .insert(mergeResolutions)
    .values({
      id: resolutionId(pullRequestId, tips, stop.commit),
      pullRequestId,
      baseSha: tips.onto,
      headSha: tips.head,
      commitSha: stop.commit,
      status: 'failed',
      model: NO_MODEL,
      conflictedPaths: stop.paths,
      errorMessage: stop.error,
      createdAt: now,
      decidedAt: now,
    })
    .onConflictDoNothing();
  return stop.error;
}

/**
 * Starts a rebase run for a pull request behind its base, unless one is running for it, or the last rebase at these
 * tips stopped for the agent (a conflict: the agent's move). Never throws.
 */
export async function ensureRebase(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest
): Promise<boolean> {
  if (!resolutionConfigured(env) || pr.state !== 'open') return false;
  try {
    const tips = await rebaseTips(git, pr);
    if (!tips) return false;
    // Up to date (or git can't say), or the base already has all of it: nothing to replay.
    if ((await contains(git, tips.onto, tips.head)) !== false) return false;
    if ((await contains(git, tips.head, tips.onto)) === true) return false;
    const last = await latestResolution(db, pr.id);
    if (
      last &&
      last.baseSha === tips.onto &&
      last.headSha === tips.head &&
      last.status === 'failed' &&
      last.errorMessage !== SUPERSEDED
    )
      return false;
    const running = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.pullRequestId, pr.id),
          eq(agentRuns.kind, 'rebase'),
          eq(agentRuns.status, 'running'),
          gt(agentRuns.startedAt, new Date(Date.now() - REBASE_RUN_FRESH_MS))
        )
      )
      .get();
    if (running) return false;
    await env.MERGE_RESOLUTION.create({
      id: `rebase-${crypto.randomUUID()}`,
      params: { rebase: { pullRequestId: pr.id } },
    });
    return true;
  } catch (e) {
    console.error('[rebase] could not start', pr.id, e);
    return false;
  }
}

/**
 * Replaces the pull request's branch with the rebased head, compare-and-swap on the head it was rebased from, and keeps
 * that head as its pre-rebase ref. `moved`: the branch is no longer where the rebase started (pushed, or deleted).
 */
export async function writeRebase(
  git: GitService,
  pr: Pick<PullRequest, 'number' | 'headRef'>,
  tips: RebaseTips,
  result: Extract<RebaseResult, { kind: 'done' }>
): Promise<'written' | 'moved'> {
  // From the remote: a cached listing may predate a push.
  const { refs } = await git.client.listRefs();
  const now = refs.get(`refs/heads/${pr.headRef}`);
  if (now === result.head) return 'written'; // a retried step already pushed it
  if (now !== tips.head) return 'moved';
  const pre = preRebaseRef(pr.number, tips.head);
  try {
    await git.client.push(
      [
        { ref: `refs/heads/${pr.headRef}`, old: tips.head, new: result.head },
        ...(refs.has(pre) ? [] : [{ ref: pre, old: ZERO_SHA, new: tips.head }]),
      ],
      result.objects
    );
  } catch (e) {
    if (e instanceof GitPushError) return 'moved';
    throw e;
  }
  return 'written';
}

/** What a written rebase changed, small enough for a step result. */
export type Written = {
  from: string;
  to: string;
  ontoBranch: string;
  skipped: number;
  /** Commits whose conflicts AI resolved: original → rebased. */
  resolved: { original: string; rebased: string }[];
  /** Nothing needed resolving and every replayed commit makes the same change: the review carries over. */
  clean: boolean;
};

export function written(
  tips: RebaseTips,
  result: Extract<RebaseResult, { kind: 'done' }>
): Written {
  const resolved = result.commits
    .filter((c) => c.resolved)
    .map(({ original, rebased }) => ({ original, rebased }));
  return {
    from: tips.head,
    to: result.head,
    ontoBranch: tips.ontoBranch,
    skipped: result.skipped,
    resolved,
    clean: !resolved.length && result.samePatches,
  };
}

/**
 * After a rebase was written: the `rebased` timeline event, then what a push of the branch does — Actions on the new
 * head, and the sweep (review of the new head; pull requests stacked on this branch rebase).
 */
export async function afterRebase(
  env: CloudflareBindings,
  db: DrizzleDB,
  opts: { repo: Repository; repoFullName: string; pr: PullRequest; w: Written }
): Promise<void> {
  const { repo, pr, w } = opts;
  await recordEvent(db, {
    id: `rebased:${pr.id}:${w.to}`,
    repositoryId: pr.repositoryId,
    pullRequestId: pr.id,
    kind: 'rebased',
    data: {
      from: w.from,
      to: w.to,
      onto: w.ontoBranch,
      skipped: w.skipped,
      resolved: w.resolved.length,
    },
  });
  const update = { ref: `refs/heads/${pr.headRef}`, old: w.from, new: w.to };
  await onRefsUpdated(env, db, repo, opts.repoFullName, [update], null);
  await startSweep(env, repo, [update]);
  await publishChange(env, pr.repositoryId, { approvals: true });
}

export interface RebaseDeps {
  env: CloudflareBindings;
  db: DrizzleDB;
  step: StepRunner;
  /** The AI resolver of one conflicting commit (by merge_resolutions.id); absent where AI isn't configured. */
  resolver?: (resolutionId: string) => ConflictResolverApi;
}

type Job = {
  pullRequestId: string;
  repositoryId: string;
  fullName: string;
  timestamp: number;
};

/** A replay's outcome, small for a step result. */
export type Replay =
  | { kind: 'gone' }
  | { kind: 'up_to_date' }
  | { kind: 'done' }
  | { kind: 'too_many'; count: number }
  | {
      kind: 'conflict';
      commit: string;
      paths: string[];
      textual: boolean;
      generated: string[];
    };

/** The pull request (open, unless `open` is false) and its repository, read afresh. */
async function context(
  env: CloudflareBindings,
  db: DrizzleDB,
  id: string,
  open = true
) {
  const pr = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.id, id))
    .get();
  if (!pr || (open && pr.state !== 'open')) return null;
  const found = await findRepoById(db, pr.repositoryId);
  return found ? { pr, repo: found.repo, git: gitFor(env, found.repo) } : null;
}

/** Rebases one pull request (MERGE_RESOLUTION payload `{ rebase: { pullRequestId } }`). */
export async function executeRebase(
  deps: RebaseDeps,
  params: RebaseParams
): Promise<void> {
  const { env, db } = deps;
  const job = await deps.step.do('load', async (): Promise<Job | null> => {
    const ctx = await context(env, db, params.pullRequestId);
    if (!ctx) return null;
    const found = await findRepoById(db, ctx.pr.repositoryId);
    return {
      pullRequestId: ctx.pr.id,
      repositoryId: ctx.pr.repositoryId,
      fullName: `${found!.namespace.username}/${ctx.repo.name}`,
      // One committer date for the run: a replayed step rebuilds the same commits.
      timestamp: Math.floor(Date.now() / 1000),
    };
  });
  if (!job) return;
  const step = pingingSteps(env, deps.step, job.repositoryId, {
    approvals: true,
  });
  for (let attempt = 0; attempt < MAX_REBASE_ATTEMPTS; attempt++)
    if ((await rebaseAttempt(deps, step, job, attempt)) !== 'moved') return;
}

async function rebaseAttempt(
  deps: RebaseDeps,
  step: StepRunner,
  job: Job,
  attempt: number
): Promise<'done' | 'moved'> {
  const { env, db } = deps;
  const committer: Signature = {
    ...REBASE_COMMITTER,
    timestamp: job.timestamp,
  };
  const tips = await step.do(`tips:${attempt}`, async () => {
    const ctx = await context(env, db, job.pullRequestId);
    return ctx ? rebaseTips(ctx.git, ctx.pr) : null;
  });
  if (!tips) return 'done';
  for (let k = 0; ; k++) {
    const r = await step.do(
      `replay:${attempt}:${k}`,
      async (): Promise<Replay> => {
        const ctx = await context(env, db, job.pullRequestId);
        if (!ctx) return { kind: 'gone' };
        const result = await rebaseAt(ctx.git, db, ctx.pr, tips, committer);
        if (result.kind === 'too_many')
          return { kind: 'too_many', count: result.count };
        if (result.kind !== 'conflict') return { kind: result.kind };
        return {
          kind: 'conflict',
          commit: result.commit.hash,
          paths: result.conflicts,
          textual: result.files.length === result.conflicts.length,
          generated: await generatedConflicts(
            ctx.git,
            tips.onto,
            result.conflicts
          ),
        };
      }
    );
    if (r.kind === 'gone' || r.kind === 'up_to_date') return 'done';
    if (r.kind === 'done') break;
    if (r.kind === 'too_many') {
      await step.do(`stop:${attempt}:${k}`, () =>
        recordStop(db, job.pullRequestId, tips, {
          commit: null,
          paths: [],
          error: stopMessage.tooMany(r.count),
        })
      );
      return 'done';
    }
    if ((await onConflict(deps, step, job, tips, r, attempt, k)) === 'stop')
      return 'done';
  }
  const out = await step.do(
    `write:${attempt}`,
    async (): Promise<
      { kind: 'written'; w: Written } | { kind: 'moved' } | { kind: 'stale' }
    > => {
      const ctx = await context(env, db, job.pullRequestId);
      if (!ctx) return { kind: 'stale' };
      const result = await rebaseAt(ctx.git, db, ctx.pr, tips, committer);
      if (result.kind !== 'done') return { kind: 'stale' };
      return (await writeRebase(ctx.git, ctx.pr, tips, result)) === 'moved'
        ? { kind: 'moved' }
        : { kind: 'written', w: written(tips, result) };
    }
  );
  if (out.kind === 'moved') return 'moved';
  if (out.kind !== 'written') return 'done';
  await step.do(`after:${attempt}`, ONCE, async () => {
    const ctx = await context(env, db, job.pullRequestId, false);
    if (ctx)
      await afterRebase(env, db, {
        repo: ctx.repo,
        repoFullName: job.fullName,
        pr: ctx.pr,
        w: out.w,
      });
    return true;
  });
  return 'done';
}

/**
 * A commit's replay conflicted: record why the rebase stops here (Task 3 lets AI resolve text conflicts and go on).
 */
async function onConflict(
  deps: RebaseDeps,
  step: StepRunner,
  job: Job,
  tips: RebaseTips,
  r: Extract<Replay, { kind: 'conflict' }>,
  attempt: number,
  k: number
): Promise<'continue' | 'stop'> {
  const error = !r.textual
    ? stopMessage.notText(r.commit, r.paths)
    : r.generated.length
      ? stopMessage.generated(r.commit, r.generated)
      : stopMessage.noAi(r.commit, r.paths);
  await step.do(`stop:${attempt}:${k}`, () =>
    recordStop(deps.db, job.pullRequestId, tips, {
      commit: r.commit,
      paths: r.paths,
      error,
    })
  );
  return 'stop';
}

export type RebaseStatus =
  'nothing_to_merge' | 'up_to_date' | 'behind' | 'resolving' | 'conflict';
export type RebaseView = {
  status: RebaseStatus;
  /** The branch it rebases onto. */
  onto: string;
  /** The commit being resolved, or where the rebase stopped; null when it stopped before any. */
  commit: string | null;
  files: string[];
  error: string | null;
};

/**
 * Where an open pull request stands against its base: nothing to merge, up to date, behind (GitOrange rebases it, and
 * landing does too), resolving (AI is resolving a commit), or a conflict for the agent. Where no rebase runs (no
 * MERGE_RESOLUTION binding), a dry run says whether landing's rebase would stop.
 */
export async function rebaseView(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: Pick<PullRequest, 'id'>,
  tips: RebaseTips
): Promise<RebaseView> {
  const view = {
    onto: tips.ontoBranch,
    commit: null,
    files: [] as string[],
    error: null,
  };
  if ((await contains(git, tips.head, tips.onto)) === true)
    return { ...view, status: 'nothing_to_merge' };
  if ((await contains(git, tips.onto, tips.head)) === true)
    return { ...view, status: 'up_to_date' };
  const row = await latestResolution(db, pr.id);
  if (row && row.baseSha === tips.onto && row.headSha === tips.head) {
    if (row.status === 'running' || row.status === 'resolved')
      return {
        ...view,
        status: 'resolving',
        commit: row.commitSha,
        files: row.conflictedPaths,
      };
    if (row.status === 'failed' && row.errorMessage !== SUPERSEDED)
      return {
        ...view,
        status: 'conflict',
        commit: row.commitSha,
        files: row.conflictedPaths,
        error: row.errorMessage,
      };
  }
  if (!resolutionConfigured(env)) {
    const dry = await rebaseAt(git, db, pr, tips, {
      ...REBASE_COMMITTER,
      timestamp: 0,
    });
    if (dry.kind === 'too_many')
      return {
        ...view,
        status: 'conflict',
        error: stopMessage.tooMany(dry.count),
      };
    if (dry.kind === 'conflict')
      return {
        ...view,
        status: 'conflict',
        commit: dry.commit.hash,
        files: dry.conflicts,
        error: stopMessage.noAi(dry.commit.hash, dry.conflicts),
      };
  }
  return { ...view, status: 'behind' };
}
```

- [ ] **Step 7: The sweep starts rebases**

In `worker/src/merge/auto.ts`:

- Rename `autoResolveConflicts` to `startSweep` (doc comment: "Starts one sweep Workflow over the open pull requests into
  or from moved branches. Never throws.").
- Replace the imports from `./resolution` with `import { resolutionConfigured, SETTLE_MS, type StepRunner } from './resolution';`,
  drop the `mergeResolutions`, `generatedConflicts` and `GitService`-only imports that become unused, and add
  `import { ensureRebase } from './rebase';`.
- Replace the second pass of `executeSweep` (from `await step.sleep('settle', SETTLE_MS);` to the end of the function)
  with:

```ts
  await step.sleep('settle', SETTLE_MS);
  for (const { id } of prs) {
    await step.do(`rebase:${id}`, async () => {
      try {
        // The PR and its tips as they are after the delay.
        const pr = await db.select().from(pullRequests).where(eq(pullRequests.id, id)).get();
        if (!pr) return false;
        return await ensureRebase(env, db, gitFor(env, repo as Repository), pr);
      } catch (e) {
        console.error('[rebase] sweep failed', id, e);
        return false;
      }
    });
  }
}
```

- Delete `ensureResolution`.

In `worker/src/git-http.ts`: `import { startSweep } from './merge/auto';` and `await startSweep(env, repo, updates);`.

In `worker/src/lib/pulls.ts`: replace the `ensureResolution` import with `import { ensureRebase } from '../merge/rebase';`
and the "A PR opened against a moved base may already conflict" block with:

```ts
// A PR opened against a moved base is rebased onto it.
opts.after(ensureRebase(env, db, git, pr));
```

- [ ] **Step 8: The Workflow runs `rebase`**

In `worker/src/merge/workflow.ts`: add `| 'rebase'` to `PayloadKey`; replace `import { executeResolution, type StepRunner } from './resolution';`
with `import type { StepRunner } from './resolution';` and add `import { executeRebase, type RebaseParams } from './rebase';`;
in `MergeResolutionParams` replace the first line with:

```ts
  /** Squash-era AI resolution: instances started before rebase merging do nothing. */
  | Only<'resolutionId', string>
  /** Rebase one pull request onto its base (merge/rebase.ts). */
  | Only<'rebase', RebaseParams>
```

and replace the final `else { await executeResolution(…) }` with:

```ts
    } else if (p.rebase) {
      const resolver = (this.env as Partial<CloudflareBindings>).MERGE_RESOLVER;
      await executeRebase(
        {
          env: this.env,
          db,
          step: runner,
          resolver: resolver ? (id: string) => resolver.getByName(id) : undefined,
        },
        p.rebase
      );
    }
    // p.resolutionId: cancelled by migration 0025; nothing to do.
```

Update the class doc comment: "MERGE_RESOLUTION: runs a rebase, an agents' review, a sweep, stacking discovery, a stack
reconcile, or a lesson."

In `worker/src/merge/land.ts`: replace `import { autoResolveConflicts } from './auto';` with `import { startSweep } from './auto';`,
drop `latestResolution` from the `./resolution` import, drop `mergeResolutions` and `makeCommit` imports, remove the
`resolutionId?: string;` option, and replace the whole `try { let resolutionId = opts.resolutionId; … } catch (e) { … }`
block and the `if (appliedResolution) …` update after it with:

```ts
let sha: string;
try {
  ({ sha } = await git.merge({
    base: target,
    // The commit the gates checked, never whatever the branch points at by now.
    head: headSha,
    method: 'squash',
    message: fullMessage,
    author,
    committer,
    extraRefs: [{ ref: pullRef(pr.number), sha: headSha }],
  }));
} catch (e) {
  if (e instanceof MergeConflictError)
    return { ok: false, status: 409, error: e.message };
  if (e instanceof GitPushError)
    return {
      ok: false,
      status: 409,
      error: 'Base branch was modified. Review and try the merge again.',
    };
  return {
    ok: false,
    status: 400,
    error: e instanceof Error ? e.message : 'Merge failed',
  };
}
```

and `opts.after(startSweep(env, opts.repo, updates));` where it called `autoResolveConflicts`. (Task 5 replaces
squash landing.)

- [ ] **Step 9: Stacking moves start rebases**

In `worker/src/stack/retarget.ts`: add `import { ensureRebase } from '../merge/rebase';` and
`import { findRepoById, gitFor } from '../lib/repos';`. In `onPullClosed`, collect the moved children
(`const movedChildren: PullRequest[] = [];` and `movedChildren.push({ ...c, baseRef: target, landTarget: target });`
after `moved++`), and after the `if (moved) await settleStates(…)` line add:

```ts
// Children now on the land target rebase onto it.
if (movedChildren.length) {
  const found = await findRepoById(db, pr.repositoryId);
  if (found)
    for (const c of movedChildren)
      await ensureRebase(env, db, gitFor(env, found.repo), c);
}
```

In `dismissEdge`, after `await settleStates(env, db, pr.repositoryId, { branch: target });` add:

```ts
const found = await findRepoById(db, pr.repositoryId);
if (found)
  await ensureRebase(env, db, gitFor(env, found.repo), {
    ...pr,
    baseRef: target,
    landTarget: target,
  });
```

In `worker/src/stack/reconcile.ts`: add `import { ensureRebase } from '../merge/rebase';`. In the `${p}retarget` step
keep a list `const movedIds: string[] = [];`, push `pr.id` where it now does `moved++`, and `return movedIds;`; then
replace `if (changed)` with `if (changed.length)`, and after the `${p}states` step add (inside the same `if`):

```ts
await step.do(`${p}rebase`, async () => {
  // A retargeted pull request rebases onto its new base (a parent's branch, or the land target).
  const git = gitFor(env, job.repo as Repository);
  for (const id of changed) {
    const pr = await db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.id, id))
      .get();
    if (pr) await ensureRebase(env, db, git, pr);
  }
  return true;
});
```

and `return changed.length;` at the end of `executeReconcile`.

- [ ] **Step 10: States read the rebase**

In `worker/src/pulls/state.ts`:

- In `Reason`, replace `| { kind: 'conflicts_unresolved'; files: string[]; error: string | null }` with:

```ts
  /** GitOrange's rebase stopped at `commit` (null: before any) on these files; the agent rebases locally. */
  | { kind: 'rebase_conflict'; commit: string | null; files: string[]; error: string | null }
```

- In `KINDS`, replace `conflicts_unresolved: true,` with `rebase_conflict: true,`.
- In `reasonState`, replace `case 'conflicts_unresolved':` with `case 'rebase_conflict':`, and move `case 'rebase_onto':`
  from the `agent_followup` group to the `waiting` group with the comment `// GitOrange rebases it onto its parent.`

In `worker/src/pulls/signals.ts`:

- Add `commitSha: mergeResolutions.commitSha,` to the resolutions select (and `commitSha: string | null;` to the map's
  value type).
- Replace the `const r = resolutions.get(pr.id); if (r && …) { … }` block with:

```ts
// The latest rebase conflict row, at the tips the PR rebases between now (base_ref's, else the land target's).
const r = resolutions.get(pr.id);
const onto = (await tipOf(pr.baseRef)) ?? base;
if (r && r.baseSha === onto && r.headSha === head) {
  if (r.status === 'running' || r.status === 'resolved')
    reasons.push({ kind: 'resolution_running' });
  else if (r.status === 'failed' && r.errorMessage !== SUPERSEDED)
    reasons.push({
      kind: 'rebase_conflict',
      commit: r.commitSha,
      files: r.conflictedPaths,
      error: r.errorMessage,
    });
}
```

In `worker/src/pulls/settle.ts`: add `rebase?: { pullRequestId: string };` to `Payload` and
`if (!prId && p.rebase) prId = p.rebase.pullRequestId;` after `let prId = p.stack?.pullRequestId;`.

- [ ] **Step 11: Surfaces that showed the old resolution**

`worker/src/routers/pulls-router.ts`:

- Imports: replace the `../merge/resolution` import with
  `import { NO_MODEL, SUPERSEDED } from '../merge/resolution';`, delete the `generatedConflicts`,
  `ensureResolution` and `MergeResolution` imports, add
  `import { ensureRebase, rebaseTips, rebaseView, type RebaseView } from '../merge/rebase';`.
- List: the `resolutions` map's value type becomes
  `Pick<MergeResolution, 'status' | 'baseSha' | 'headSha' | 'errorMessage' | 'model'>` → write it as
  `{ status: string; baseSha: string; headSha: string; errorMessage: string | null; model: string }`; replace
  `aiResolution` with:

```ts
const aiResolution = (pr: PullRequest) => {
  const r = resolutions.get(pr.id);
  const onto =
    refs.get(`refs/heads/${pr.baseRef}`) ??
    refs.get(`refs/heads/${landTargetOf(pr)}`);
  if (
    !r ||
    r.baseSha !== onto ||
    r.headSha !== refs.get(`refs/heads/${pr.headRef}`)
  )
    return null;
  // A stop AI never attempted (binary, delete/edit, generated, too many commits) isn't an AI resolution.
  if (r.model === NO_MODEL) return null;
  if (r.status === 'running' || r.status === 'resolved')
    return 'running' as const;
  if (r.status === 'failed' && r.errorMessage !== SUPERSEDED)
    return 'failed' as const;
  return null;
};
```

and its schema to `aiResolution: z.enum(['running', 'failed']).nullable(),` (comment: "Open PRs: AI resolving a
rebase conflict at the current tips, or failed to").

- Delete `resolutionSchema`, `serializeResolution`, `startResolutionRoute` and `rejectResolutionRoute` with their
  handlers.
- Add, before `getPullRoute`:

```ts
const rebaseViewSchema = z
  .object({
    status: z.enum([
      'nothing_to_merge',
      'up_to_date',
      'behind',
      'resolving',
      'conflict',
    ]),
    /** The branch it rebases onto: base_ref, or the land target when that branch is gone. */
    onto: z.string(),
    /** The commit AI is resolving, or where the rebase stopped (null: before any commit). */
    commit: z.string().nullable(),
    files: z.array(z.string()),
    error: z.string().nullable(),
  })
  .openapi('RebaseStatus');
```

- In `getPullRoute`'s response, replace the lines from `mergeable: z.boolean().nullable(),` through
  `resolution: resolutionSchema.nullable(),` with:

```ts
        /** It can land: up to date with its base, or behind it (landing rebases it first). */
        mergeable: z.boolean().nullable(),
        /** Where it stands against its base; null unless it is open with both branches. */
        rebase: rebaseViewSchema.nullable(),
```

- In the handler, replace from `let mergeable: boolean | null = null;` down to (not including)
  `const review = await reviewersView(` with:

```ts
let mergeable: boolean | null = null;
let rebase: RebaseView | null = null;
let commitCount = 0;
// Merging is measured against the land target, which base_ref (the diff's base) may not be while stacked.
const target = pr.state === 'open' ? await landShas(git, pr) : null;
if (shas) commitCount = (await git.commitsBetween(shas.base, shas.head)).length;
const tips = pr.state === 'open' ? await rebaseTips(git, pr) : null;
if (tips) {
  rebase = await rebaseView(c.env, db, git, pr, tips);
  mergeable = rebase.status === 'up_to_date' || rebase.status === 'behind';
  // Backstop for missed triggers: a pull request behind its base gets a rebase run.
  if (rebase.status === 'behind')
    c.executionCtx.waitUntil(ensureRebase(c.env, db, git, pr));
}
```

and in the JSON replace `mergeable, conflicts, conflictsResolvable, aiResolution: …, resolvedByAi, resolution: …` with
`mergeable, rebase,`.

- Reopen: replace the `ensureResolution(…)` `waitUntil` with
  `c.executionCtx.waitUntil(ensureRebase(c.env, c.get('db'), c.get('git'), { ...pr, state: 'open' }));`.
- Merge route: delete `resolutionId` from the body schema and from the `landPull` call.

`worker/src/routers/repos-router.ts`: import `rebase, REBASE_COMMITTER` from `../git/rebase`; give `compareShas` a
fourth parameter `opts: { mergeability?: boolean } = {}`, and replace its `const [commits, plan] = …` and the
`mergeable`/`conflicts` fields with:

```ts
const commits = await git.commitsBetween(baseSha, headSha);
// Whether landing's rebase would replay it cleanly (a dry run: nothing is pushed).
const dry =
  opts.mergeability === false || mb === headSha
    ? null
    : await rebase(git, {
        head: headSha,
        onto: baseSha,
        committer: { ...REBASE_COMMITTER, timestamp: 0 },
        ontoLabel: 'base',
      });
```

```ts
    mergeable: dry?.kind === 'up_to_date' || dry?.kind === 'done',
    conflicts: dry?.kind === 'conflict' ? dry.conflicts : [],
```

and in `pulls-router.ts`'s files route call `compareShas(c.get('git'), shas.base, shas.head, { mergeability: false })`.

`worker/src/review/auto-merge.ts`: replace the `../merge/resolution` import with
`import { resolutionConfigured } from '../merge/resolution';`, add `import { rebaseTips, rebaseView } from '../merge/rebase';`,
and replace the `const plan = await git.planMerge(base, head); … }` block with:

```ts
const tips = await rebaseTips(git, pr);
if (tips) {
  // Behind is fine: landing rebases it first.
  const v = await rebaseView(env, db, git, pr, tips);
  if (v.status === 'nothing_to_merge') blocked.push('Nothing to merge');
  else if (v.status === 'resolving')
    waiting.push('Resolving a rebase conflict with AI');
  else if (v.status === 'conflict') blocked.push(v.error ?? 'Rebase conflict');
}
```

`worker/src/mcp/pull-tools.ts`: replace `import { latestResolution } from '../merge/resolution';` with
`import { rebaseTips, rebaseView } from '../merge/rebase';` and the `if (target) { const plan = … }` block with:

```ts
const tips = pr.state === 'open' ? await rebaseTips(git, pr) : null;
if (tips) {
  const v = await rebaseView(ctx.env, ctx.db, git, pr, tips);
  merge = {
    nothing_to_merge: v.status === 'nothing_to_merge',
    // GitOrange rebases a branch that is behind; landing does too.
    behind: v.status === 'behind',
    rebase_onto: v.onto,
    ai_resolving:
      v.status === 'resolving' ? { commit: v.commit, files: v.files } : null,
    rebase_conflict:
      v.status === 'conflict'
        ? { commit: v.commit, files: v.files, error: v.error }
        : null,
  };
}
```

and in `gitorange_get_pull_request`'s description replace "whether it merges cleanly (or has conflicts, and what AI
conflict resolution is doing about them)" with "whether it is up to date with its base or behind (GitOrange rebases it
itself; a rebase_conflict names the commit and files to fix locally, ai_resolving the commit AI is resolving)", and in
the `pull_state` sentence "AI conflict resolution" with "AI resolving a rebase conflict".

`worker/src/agent-runs/record.ts`: in `describeRun`, before `if (payload.stack)`, add:

```ts
if (payload.rebase) {
  const pr = await db
    .select({
      id: pullRequests.id,
      number: pullRequests.number,
      baseRef: pullRequests.baseRef,
      repositoryId: pullRequests.repositoryId,
    })
    .from(pullRequests)
    .where(eq(pullRequests.id, payload.rebase.pullRequestId))
    .get();
  return pr
    ? {
        kind: 'rebase',
        repositoryId: pr.repositoryId,
        pullRequestId: pr.id,
        title: `Rebase #${pr.number} onto ${pr.baseRef}`,
      }
    : null;
}
```

in `outcomeError`, before the learn branch, add (import `desc`, `gte` from `drizzle-orm`):

```ts
if (payload.rebase) {
  // Where this run stopped for the agent, or AI failed: a row it wrote that failed.
  const run = await db
    .select({ startedAt: agentRuns.startedAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .get();
  if (!run) return null;
  const row = await db
    .select({
      status: mergeResolutions.status,
      error: mergeResolutions.errorMessage,
    })
    .from(mergeResolutions)
    .where(
      and(
        eq(mergeResolutions.pullRequestId, payload.rebase.pullRequestId),
        gte(
          mergeResolutions.createdAt,
          new Date(Math.floor(run.startedAt.getTime() / 1000) * 1000)
        )
      )
    )
    .orderBy(desc(mergeResolutions.createdAt), sql`rowid DESC`)
    .get();
  return row?.status === 'failed' ? (row.error ?? 'The rebase stopped.') : null;
}
```

and in `decisionFor` delete the `prepare` and `commit` cases and add:

```ts
    case 'tips':
      return r && typeof r.onto === 'string'
        ? `Onto ${r.ontoBranch} at ${String(r.onto).slice(0, 7)}, head ${String(r.head).slice(0, 7)}`
        : 'Closed, or a branch is gone';
    case 'replay':
      switch (r?.kind) {
        case 'up_to_date':
          return 'Already up to date';
        case 'done':
          return 'Replays cleanly';
        case 'too_many':
          return `Too many commits (${r.count})`;
        case 'conflict':
          return `Commit ${String(r.commit).slice(0, 7)} conflicts in ${plural(r.paths.length, 'file')}: ${r.paths.join(', ')}`;
        case 'gone':
          return 'Closed, or a branch is gone';
        default:
          return null;
      }
    case 'stop':
      return typeof r === 'string' ? r : null;
    case 'write':
      if (r?.kind === 'moved') return 'The branch moved: starting over';
      return r?.kind === 'written'
        ? `Rebased ${String(r.w.from).slice(0, 7)} → ${String(r.w.to).slice(0, 7)}${
            r.w.skipped ? `, skipped ${plural(r.w.skipped, 'commit')}` : ''
          }`
        : null;
    case 'rebase':
      return r === true ? 'Started a rebase' : null;
```

`worker/src/lib/insights.ts`: in the resolutions query, `SUM(r.status IN ('proposed', 'applied')) AS succeeded` →
`SUM(r.status IN ('resolved', 'applied')) AS succeeded`.

- [ ] **Step 12: Update the tests that read the old resolution**

- Delete `worker/src/__tests__/merge-resolution.test.ts` (it tests the squash-era path, removed here; its rebase
  equivalents are in `rebase-runs.test.ts` and Task 3's `rebase-resolution.test.ts`), and its line in
  `.github/workflows/ci.yml`.
- `pull-states.test.ts`: drop the `ensureResolution` import (and `findRepoById`/`gitFor`/`PullRequest` only if no other
  test uses them — `statesRepo` does, so keep them); in "lists every reason kind" replace `'conflicts_unresolved',`
  with `'rebase_conflict',`; delete the `describe('non-text conflicts', …)` block (now "records a conflict AI can't take"
  in `rebase-runs.test.ts`); in "reads AI resolution at the current commits" replace the expected failed state with:

```ts
expect((await s.states())[1]).toEqual({
  state: 'agent_followup',
  reasons: [
    {
      kind: 'rebase_conflict',
      commit: null,
      files: ['a.txt'],
      error: 'Gave up.',
    },
  ],
});
```

and in "finds the repository of every MERGE_RESOLUTION payload" add:

```ts
expect(
  await repositoryForPayload(s.db, { rebase: { pullRequestId: s.pr.id } })
).toEqual({ repositoryId: s.repoId, branch: 'main' });
```

- `pulls-ai-resolution.test.ts`: replace the whole file with (Task 3 adds the AI cases):

```ts
import { describe, expect, it } from 'vitest';
import { call, type TestEnv } from './helpers/app';
import { divergedPull, moved, runRebases } from './helpers/rebase';

export async function listed(t: TestEnv, cookie: string, state = 'open') {
  const body = (await (
    await call(t, `/api/repos/octocat/app/pulls?state=${state}`, { cookie })
  ).json()) as { pulls: { number: number; aiResolution: string | null }[] };
  return Object.fromEntries(body.pulls.map((p) => [p.number, p.aiResolution]));
}

describe('pull request list: AI resolving a rebase conflict', () => {
  it("doesn't call a stop AI never attempted (model none) an AI resolution", async () => {
    const { t, admin, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    await runRebases(t); // no resolver: the run stops for the agent
    expect(await listed(t, admin)).toEqual({ 1: null });
  });
});
```

- `land-target.test.ts`: replace the test "plans the merge, sweeps conflicts, and lists AI resolution against the land
  target" and "sweeps many moved branches in chunks and still reaches a PR by its land target" and "plans the merge
  against the land target when the base_ref branch is gone" with:

```ts
it('rebases a stacked PR onto its parent’s branch, not the land target', async () => {
  const s = await stackedByHand({ conflict: true });
  const d = await detail(s, 2);
  // #2 already contains its parent, so it is up to date with base_ref even though main moved.
  expect(d.rebase).toMatchObject({ status: 'up_to_date', onto: 'parent' });
});

it('sweeps many moved branches in chunks and still reaches a PR by its land target', async () => {
  const s = await stackedByHand();
  await s.t.env.DB.prepare(
    "UPDATE pull_requests SET base_ref = 'main' WHERE number = 2"
  ).run();
  await commitPaths(
    s.repo,
    'main',
    { ...s.base, 'z.txt': 'z\n' },
    'Main again'
  );
  const branches = Array.from({ length: 40 }, (_, i) =>
    i === 35 ? 'main' : `other-${i}`
  );
  await executeSweep(
    { env: s.t.env, db: s.db, step },
    { repositoryId: s.repoId, branches }
  );
  expect(
    s.t.actions.resolutions.filter(
      (r) =>
        (r.params as { rebase?: { pullRequestId: string } }).rebase
          ?.pullRequestId === s.pr2
    )
  ).toHaveLength(1);
});

it('rebases onto the land target when the base_ref branch is gone', async () => {
  const s = await stackedByHand({ conflict: true });
  s.repo.refs.delete('refs/heads/parent');
  const d = await detail(s, 2);
  expect(d.rebase).toMatchObject({ onto: 'main' });
  expect(d.rebase!.status).not.toBe('up_to_date');
});
```

and in `detail`'s type replace `conflicts: string[];` with
`rebase: { status: string; onto: string; files: string[] } | null;`.

- `mcp.test.ts` (the `merge:` expectation in the create/get/merge flow): replace with

```ts
      merge: {
        nothing_to_merge: false,
        behind: false,
        rebase_onto: 'main',
        ai_resolving: null,
        rebase_conflict: null,
      },
```

- `agent-runs.test.ts`: replace the `executeResolution` import with
  `import { executeRebase } from '../merge/rebase';` and `import { commitFiles } from './helpers/seed';` stays; replace
  the test "records a conflict resolution with the resolver model and tokens" with:

```ts
it('records a rebase run, step by step', async () => {
  const { t } = await conflictingPull();
  const pr = (await t.env.DB.prepare('SELECT id FROM pull_requests').first<{
    id: string;
  }>())!;
  const db = dbOf(t);
  await recordAgentRun(
    t.env,
    db,
    { instanceId: 'rebase-1', payload: { rebase: { pullRequestId: pr.id } } },
    durableSteps().step,
    (step) => executeRebase({ env: t.env, db, step }, { pullRequestId: pr.id })
  );
  const [run] = await runs(t);
  expect(run).toMatchObject({
    kind: 'rebase',
    status: 'failed',
    title: 'Rebase #1 onto main',
  });
  expect(run.error).toMatch(
    /^Commit [0-9a-f]{7} conflicts in notes\.txt\. Rebase locally\.$/
  );
  const steps = await stepsOf(t, run.id);
  expect(steps.map((s) => s.name)).toEqual([
    'load',
    'tips:0',
    'replay:0:0',
    'stop:0:0',
  ]);
  expect(steps[2].decision).toMatch(
    /^Commit [0-9a-f]{7} conflicts in 1 file: notes\.txt$/
  );
});
```

and in "records a sweep" expect step prefixes `['repo', 'targets', 'pr', 'rebase']`.

- `stacking-landing.test.ts`: in "asks the later prerequisite to rebase first, then the dependent" change
  `expect(st[2]!.state).toBe('agent_followup');` to `expect(st[2]!.state).toBe('waiting');` and the comment
  "(GitOrange never does)" to "(as GitOrange's rebase run would)"; in "reports rebase_onto in the PR detail for a
  stacked PR that lacks its parent" change `toBe('agent_followup')` to `toBe('waiting')`.
- `insights.test.ts`: in the fixture rows, `resolution('r3', 5, DAY, 'proposed')` → `resolution('r3', 5, DAY, 'resolved')`.
- `repos-pulls.test.ts` "reports conflicts and refuses to merge them": replace the detail type and assertions with

```ts
const detail = (await (
  await call(t, '/api/repos/octocat/app/pulls/1', { cookie: admin })
).json()) as {
  mergeable: boolean;
  rebase: { status: string; files: string[] };
};
expect(detail.mergeable).toBe(false);
expect(detail.rebase).toMatchObject({
  status: 'conflict',
  files: ['README.md'],
});
```

- [ ] **Step 13: Run the tests**

Run: `yarn test worker/src/__tests__/rebase-runs.test.ts worker/src/__tests__/pull-states.test.ts worker/src/__tests__/pulls-ai-resolution.test.ts worker/src/__tests__/land-target.test.ts worker/src/__tests__/mcp.test.ts worker/src/__tests__/agent-runs.test.ts worker/src/__tests__/stacking-landing.test.ts worker/src/__tests__/stacking-discovery.test.ts worker/src/__tests__/insights.test.ts worker/src/__tests__/repos-pulls.test.ts worker/src/__tests__/approvals.test.ts`
Expected: PASS.

- [ ] **Step 14: CI, typecheck, commit**

In `.github/workflows/ci.yml`, job `test-review`: replace `worker/src/__tests__/merge-resolution.test.ts` with
`worker/src/__tests__/rebase-runs.test.ts`.

Run: `yarn typecheck && yarn test`
Expected: clean; all green.

```bash
yarn -s prettier --write worker/src migrations .github/workflows/ci.yml
git add -A worker/src migrations .github/workflows/ci.yml
git commit -m "Rebase runs: GitOrange rebases behind pull requests; a conflict stops for the agent" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: AI resolves each conflicting commit

**Files:**

- Create: `worker/src/merge/commit-resolution.ts`
- Modify: `worker/src/merge/rebase.ts` (`MAX_AI_COMMITS`, `stopMessage.tooManyConflicts`, export `resolutionsFor`,
  `onConflict` asks AI, `afterRebase` marks rows applied)
- Modify: `worker/src/merge/resolver.ts` (the preamble's label for the replayed commit)
- Modify: `worker/src/agent-runs/record.ts` (`resolve`, `fail` decisions)
- Test: `worker/src/__tests__/rebase-resolution.test.ts`; `worker/src/__tests__/pulls-ai-resolution.test.ts` (two
  AI cases)
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes (Task 2): `RebaseDeps`, `RebaseTips`, `Replay`, `rebaseAt`, `rebaseTips`, `resolutionId`, `recordStop`,
  `stopMessage`, `Written`; `resolverModel`, `transcriptKey`, `SUPERSEDED`; `ConflictResolverApi`, `ResolveRequest`
  (`merge/resolver.ts`); `recordAiUsage`, `usageFromTranscript` (`usage/record.ts`); test helpers `fakeResolver`,
  `runRebases`, `divergedPull`, `moved`, `rows`, `detail`, `NOTES`.
- Produces (`worker/src/merge/commit-resolution.ts`):
  - `RESOLVE_RETRIES: WorkflowStepConfig`; `MODEL_UNREACHABLE: string`.
  - `claimResolution(env, db, pullRequestId: string, tips: RebaseTips, c: { commit: string; paths: string[] }): Promise<{ id: string; status: MergeResolution['status'] }>`.
  - `failResolution(db, id: string, error: string): Promise<string>`.
  - `commitRequest(git: GitService, pr: Pick<PullRequest, 'number' | 'title' | 'body'>, tips: RebaseTips, stop: Extract<RebaseResult, { kind: 'conflict' }>): Promise<ResolveRequest>`.
  - `resolveCommit(deps: { env; db; resolver: (id: string) => ConflictResolverApi }, id: string): Promise<{ status: 'resolved' | 'failed'; error?: string }>`.
- Produces (`merge/rebase.ts`): `MAX_AI_COMMITS = 20`; `resolutionsFor(db, pullRequestId, tips): Promise<CommitResolutions>` (now exported).

- [ ] **Step 1: Write the failing tests**

Create `worker/src/__tests__/rebase-resolution.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { commitFiles } from './helpers/seed';
import { call } from './helpers/app';
import {
  detail,
  divergedPull,
  fakeResolver,
  moved,
  NOTES,
  rows,
  runRebases,
} from './helpers/rebase';
import { events } from './helpers/stacking';
import { MODEL_UNREACHABLE } from '../merge/commit-resolution';
import { MAX_AI_COMMITS } from '../merge/rebase';
import { RESOLVED_TRAILER } from '../git/rebase';
import { decoder } from '../git/bytes';

const RESOLVED = NOTES.replace('three', 'THREE (main), and a half');

/** A file at a commit of the fake repo. */
function fileAt(
  repo: Awaited<ReturnType<typeof divergedPull>>['repo'],
  commit: string,
  path: string
) {
  const tree = repo.parseTree(repo.parseCommit(commit)!.treeHash)!;
  const e = tree.find((x) => x.name === path);
  return e ? decoder.decode(repo.objects.get(e.hash)!.data) : null;
}

describe('AI resolution of a conflicting commit', () => {
  it('resolves the commit, which keeps its author and message and gets the trailer, then goes on', async () => {
    const { t, admin, repo, f2, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    const { resolver, requests } = fakeResolver(() => ({
      files: { 'notes.txt': RESOLVED },
    }));
    await runRebases(t, { resolver });
    const head = repo.refs.get('refs/heads/feature')!;
    const c = repo.parseCommit(head)!;
    expect(c.message).toBe(`Elaborate on three\n\n${RESOLVED_TRAILER}`);
    expect(c.author).toEqual({ name: 'Dev', email: 'dev@example.com' });
    expect(fileAt(repo, head, 'notes.txt')).toBe(RESOLVED);
    expect(repo.parseCommit(c.parents[0])!.message).toBe('Add b');
    // One request: the commit's conflicted file, its message and diff, the PR's title and description.
    expect(requests).toHaveLength(1);
    const { request } = requests[0];
    expect(request.labels).toEqual({ ours: 'main', theirs: f2.slice(0, 7) });
    expect(request.files['notes.txt']).toContain('<<<<<<< main');
    expect(request.theirsIntent).toContain('Pull request #1: Elaborate');
    expect(request.theirsIntent).toContain('Line three needs more detail.');
    expect(request.theirsIntent).toContain('Elaborate on three');
    expect(request.theirsIntent).toContain('+three, and a half');
    expect(request.oursIntent).toContain('Main moves');
    const [row] = await rows(t);
    expect(row).toMatchObject({ commit: f2, status: 'applied', result: head });
    expect(row.model).not.toBe('none');
    expect(JSON.parse(row.files!)).toEqual({ 'notes.txt': RESOLVED });
    expect(await events(t, 1)).toContainEqual(
      expect.objectContaining({
        kind: 'rebased',
        data: expect.objectContaining({ resolved: 1 }),
      })
    );
    expect((await detail(t, admin)).rebase!.status).toBe('up_to_date');
  });

  it('resolves several conflicting commits, one resolution each', async () => {
    const { t, repo, root } = await divergedPull();
    // Rewrite feature: two commits, each conflicting with main on its own line.
    repo.refs.set('refs/heads/feature', root);
    const f1 = await commitFiles(
      repo,
      'feature',
      { 'notes.txt': NOTES.replace('one', 'one, first') },
      'First'
    );
    const f2 = await commitFiles(
      repo,
      'feature',
      {
        'notes.txt': NOTES.replace('one', 'one, first').replace(
          'five',
          'five, second'
        ),
      },
      'Second'
    );
    const old = repo.refs.get('refs/heads/main')!;
    await commitFiles(
      repo,
      'main',
      {
        'notes.txt': NOTES.replace('one', 'ONE (main)').replace(
          'five',
          'FIVE (main)'
        ),
        'other.txt': 'x\n',
      },
      'Shout one and five'
    );
    const first = NOTES.replace('one', 'ONE (main), first').replace(
      'five',
      'FIVE (main)'
    );
    const second = NOTES.replace('one', 'ONE (main), first').replace(
      'five',
      'FIVE (main), second'
    );
    await moved(t, 'main', old);
    const { resolver, requests } = fakeResolver((req) => ({
      files: {
        'notes.txt': req.labels.theirs === f1.slice(0, 7) ? first : second,
      },
    }));
    await runRebases(t, { resolver });
    expect(requests.map((r) => r.request.labels.theirs)).toEqual([
      f1.slice(0, 7),
      f2.slice(0, 7),
    ]);
    const head = repo.refs.get('refs/heads/feature')!;
    expect(fileAt(repo, head, 'notes.txt')).toBe(second);
    const c = repo.parseCommit(head)!;
    expect([repo.parseCommit(c.parents[0])!.message, c.message]).toEqual([
      `First\n\n${RESOLVED_TRAILER}`,
      `Second\n\n${RESOLVED_TRAILER}`,
    ]);
    expect((await rows(t)).map((r) => [r.commit, r.status])).toEqual([
      [f1, 'applied'],
      [f2, 'applied'],
    ]);
  });

  it('shows rebase_conflict when the AI fails, and leaves the branch for the agent', async () => {
    const { t, admin, repo, f2, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    const { resolver } = fakeResolver(() => ({
      status: 'unanswered',
      reason: 'gave up',
    }));
    await runRebases(t, { resolver });
    expect(repo.refs.get('refs/heads/feature')).toBe(f2);
    const [row] = await rows(t);
    expect(row).toMatchObject({
      commit: f2,
      status: 'failed',
      error: "The model didn't finish (gave up).",
    });
    const d = await detail(t, admin);
    expect(d.pullState!.reasons).toContainEqual({
      kind: 'rebase_conflict',
      commit: f2,
      files: ['notes.txt'],
      error: "The model didn't finish (gave up).",
    });
  });

  it('fails a resolution that still has conflict markers', async () => {
    const { t, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    const { resolver } = fakeResolver((req) => ({
      files: { 'notes.txt': req.files['notes.txt'] },
    }));
    await runRebases(t, { resolver });
    expect((await rows(t))[0]).toMatchObject({
      status: 'failed',
      error: 'notes.txt still has conflict markers.',
    });
  });

  it('records a model that can’t be reached as a failed resolution', async () => {
    const { t, root } = await divergedPull({ conflict: true });
    await moved(t, 'main', root);
    await runRebases(t, {
      resolver: () => ({
        resolve: async () => {
          throw new Error('AI down');
        },
      }),
    });
    expect((await rows(t))[0]).toMatchObject({
      status: 'failed',
      error: MODEL_UNREACHABLE,
    });
  });

  it('never asks the model about a binary conflict', async () => {
    const { t, repo, root } = await divergedPull();
    const old = repo.refs.get('refs/heads/main')!;
    repo.refs.set('refs/heads/feature', root);
    const f = await commitFiles(
      repo,
      'feature',
      { 'notes.txt': NOTES, 'logo.bin': 'a\u0000feature' },
      'Logo'
    );
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': NOTES, 'other.txt': 'x\n', 'logo.bin': 'a\u0000main' },
      'Logo too'
    );
    await moved(t, 'main', old);
    const { resolver, requests } = fakeResolver();
    await runRebases(t, { resolver });
    expect(requests).toEqual([]);
    expect((await rows(t))[0]).toMatchObject({
      commit: f,
      model: 'none',
      error: `Commit ${f.slice(0, 7)} conflicts in logo.bin: binary files, or a file deleted on one side and changed on the other. Rebase locally.`,
    });
  });

  it('never asks the model about generated files', async () => {
    const { t, repo, root } = await divergedPull();
    const old = repo.refs.get('refs/heads/main')!;
    repo.refs.set('refs/heads/feature', root);
    await commitFiles(
      repo,
      'feature',
      { 'notes.txt': NOTES, 'yarn.lock': 'a 1\n' },
      'Lock'
    );
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': NOTES, 'other.txt': 'x\n', 'yarn.lock': 'a 2\n' },
      'Lock too'
    );
    await moved(t, 'main', old);
    const { resolver, requests } = fakeResolver();
    await runRebases(t, { resolver });
    expect(requests).toEqual([]);
    expect((await rows(t))[0].error).toMatch(
      /conflicts in generated files \(yarn\.lock\)/
    );
  });

  it(`stops after ${MAX_AI_COMMITS} commits resolved by AI in one run`, async () => {
    const { t, repo, root } = await divergedPull();
    const n = MAX_AI_COMMITS + 1;
    const line = (j: number, tag: string) => `l${j}${tag}`;
    const file = (f: (j: number) => string) =>
      Array.from({ length: n }, (_, j) => f(j)).join('\n') + '\n';
    // Each feature commit changes one more line; main changed every line.
    repo.refs.set('refs/heads/main', root);
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': NOTES, 'n.txt': file((j) => line(j, '')) },
      'Lines'
    );
    const base = repo.refs.get('refs/heads/main')!;
    repo.refs.set('refs/heads/feature', base);
    const shas: string[] = [];
    for (let i = 0; i < n; i++)
      shas.push(
        await commitFiles(
          repo,
          'feature',
          {
            'notes.txt': NOTES,
            'n.txt': file((j) => line(j, j <= i ? ' f' : '')),
          },
          `#${i}`
        )
      );
    await commitFiles(
      repo,
      'main',
      { 'notes.txt': NOTES, 'n.txt': file((j) => line(j, ' main')) },
      'Main lines'
    );
    await moved(t, 'main', base);
    const index = new Map(shas.map((s, i) => [s.slice(0, 7), i]));
    const { resolver, requests } = fakeResolver((req) => {
      const i = index.get(req.labels.theirs)!;
      return {
        files: { 'n.txt': file((j) => line(j, j <= i ? ' main f' : ' main')) },
      };
    });
    await runRebases(t, { resolver });
    expect(requests).toHaveLength(MAX_AI_COMMITS);
    const last = (await rows(t)).at(-1)!;
    expect(last).toMatchObject({ commit: shas[MAX_AI_COMMITS], model: 'none' });
    expect(last.error).toMatch(/AI already resolved 20 commits of this rebase/);
  });
});
```

Append to `worker/src/__tests__/pulls-ai-resolution.test.ts` (inside the `describe`), importing `commitFiles` from
`./helpers/seed` and `fakeResolver`, `NOTES` from `./helpers/rebase`:

```ts
it('shows a running resolution, then a failed one, on its PR only', async () => {
  const { t, admin, repo, root } = await divergedPull({ conflict: true });
  await commitFiles(
    repo,
    'clean',
    { 'notes.txt': NOTES, 'c.txt': 'c\n' },
    'Clean',
    [root]
  );
  await call(t, '/api/repos/octocat/app/pulls', {
    cookie: admin,
    json: { title: 'Clean', body: '', base: 'main', head: 'clean' },
  });
  await moved(t, 'main', root);
  let during: Record<string, string | null> = {};
  const { resolver } = fakeResolver(async () => {
    during = await listed(t, admin);
    return { status: 'unanswered', reason: 'gave up' };
  });
  await runRebases(t, { resolver });
  expect(during[1]).toBe('running');
  expect(await listed(t, admin)).toEqual({ 1: 'failed', 2: null });
});

it('ignores a row for tips the branches moved past, and leaves closed PRs out', async () => {
  const { t, admin, repo, root } = await divergedPull({ conflict: true });
  await moved(t, 'main', root);
  await runRebases(t, {
    resolver: fakeResolver(() => ({ status: 'unanswered' })).resolver,
  });
  await commitFiles(
    repo,
    'main',
    { 'notes.txt': NOTES.replace('three', 'THREE (main)'), 'z.txt': 'z\n' },
    'More'
  );
  expect(await listed(t, admin)).toEqual({ 1: null });
  await call(t, '/api/repos/octocat/app/pulls/1', {
    cookie: admin,
    method: 'PATCH',
    json: { state: 'closed' },
  });
  expect(await listed(t, admin, 'closed')).toEqual({ 1: null });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test worker/src/__tests__/rebase-resolution.test.ts worker/src/__tests__/pulls-ai-resolution.test.ts`
Expected: FAIL — `Failed to load url ../merge/commit-resolution`.

- [ ] **Step 3: Resolving one commit**

Create `worker/src/merge/commit-resolution.ts`:

```ts
/**
 * AI resolution of one pull request commit whose replay conflicted during a rebase (merge/rebase.ts). The
 * MergeResolver Durable Object (named by the row id, so a retried step rejoins its run) gets that commit's conflicted
 * files with diff3 markers, its message and diff, and the pull request's title and description; the resolved contents
 * go on the commit's merge_resolutions row, and the rebase replays on with them.
 */
import type { WorkflowStepConfig } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  mergeResolutions,
  pullRequests,
  type MergeResolution,
  type PullRequest,
} from '../db/app.schema';
import { rebase, REBASE_COMMITTER, type RebaseResult } from '../git/rebase';
import type { GitService } from '../git/service';
import { findRepoById, gitFor } from '../lib/repos';
import { recordAiUsage, usageFromTranscript } from '../usage/record';
import {
  rebaseTips,
  resolutionId,
  resolutionsFor,
  type RebaseTips,
} from './rebase';
import { resolverModel, SUPERSEDED, transcriptKey } from './resolution';
import type { ConflictResolverApi, ResolveRequest } from './resolver';

/** The model's run: pi retries model errors itself; this covers the run dying (the run is idempotent). */
export const RESOLVE_RETRIES: WorkflowStepConfig = {
  retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
  timeout: '15 minutes',
};
export const MODEL_UNREACHABLE =
  'The model could not be reached or failed to answer.';

const CONFLICT_MARKER = /^(<{7}|\|{7}|={7}|>{7})( |$)/m;
const MAX_DIFF_CHARS = 20_000;
const MAX_INTENT_COMMITS = 30;
const DESCRIPTION_CHARS = 4000;
const sha7 = (s: string) => s.slice(0, 7);

/** Claims the AI resolution of one conflicting commit: its row, inserted once (a replayed step finds it). */
export async function claimResolution(
  env: CloudflareBindings,
  db: DrizzleDB,
  pullRequestId: string,
  tips: RebaseTips,
  c: { commit: string; paths: string[] }
): Promise<{ id: string; status: MergeResolution['status'] }> {
  const id = resolutionId(pullRequestId, tips, c.commit);
  await db
    .insert(mergeResolutions)
    .values({
      id,
      pullRequestId,
      baseSha: tips.onto,
      headSha: tips.head,
      commitSha: c.commit,
      status: 'running',
      model: await resolverModel(db, env),
      conflictedPaths: c.paths,
      createdAt: new Date(),
    })
    .onConflictDoNothing();
  const row = await db
    .select({ status: mergeResolutions.status })
    .from(mergeResolutions)
    .where(eq(mergeResolutions.id, id))
    .get();
  return { id, status: row!.status };
}

/** Fails a running resolution; returns the error. */
export async function failResolution(
  db: DrizzleDB,
  id: string,
  error: string
): Promise<string> {
  await db
    .update(mergeResolutions)
    .set({ status: 'failed', errorMessage: error, decidedAt: new Date() })
    .where(
      and(eq(mergeResolutions.id, id), eq(mergeResolutions.status, 'running'))
    );
  return error;
}

/** A commit's diff against its first parent, as unified text, clipped. */
async function commitDiff(git: GitService, sha: string): Promise<string> {
  const c = await git.commit(sha);
  const parent = c?.parents[0] ? await git.commit(c.parents[0]) : null;
  const files = await git.fileDiffs(
    await git.diffTrees(parent?.treeHash ?? null, c?.treeHash ?? null)
  );
  const out: string[] = [];
  for (const f of files) {
    out.push(`--- ${f.path} (${f.status})`);
    if (f.binary || f.tooLarge) {
      out.push('(binary or too large)');
      continue;
    }
    for (const h of f.hunks)
      out.push(
        `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
        ...h.lines
      );
  }
  const text = out.join('\n');
  return text.length > MAX_DIFF_CHARS
    ? `${text.slice(0, MAX_DIFF_CHARS)}\n… (diff clipped)`
    : text;
}

/** The model's request for the commit a replay stopped at. */
export async function commitRequest(
  git: GitService,
  pr: Pick<PullRequest, 'number' | 'title' | 'body'>,
  tips: RebaseTips,
  stop: Extract<RebaseResult, { kind: 'conflict' }>
): Promise<ResolveRequest> {
  const landed = await git.commitsBetween(tips.head, tips.onto);
  const subjects =
    landed
      .slice(-MAX_INTENT_COMMITS)
      .map((c) => `- ${c.message.split('\n')[0]}`)
      .join('\n') || '- (no commit messages)';
  const sha = stop.commit.hash;
  return {
    files: Object.fromEntries(stop.files.map((f) => [f.path, f.withMarkers])),
    labels: { ours: tips.ontoBranch, theirs: sha7(sha) },
    oursIntent: `Commits on ${tips.ontoBranch} the pull request is being rebased onto:\n${subjects}`,
    theirsIntent:
      `Pull request #${pr.number}: ${pr.title}\n${pr.body ? `${pr.body.slice(0, DESCRIPTION_CHARS)}\n` : ''}\n` +
      `The commit being replayed (${sha7(sha)}):\n${stop.commit.message}\n\nIts diff:\n${await commitDiff(git, sha)}`,
  };
}

/**
 * Resolves one claimed commit (row `running`): asks the model, checks its files, and stores them (`resolved`) or why
 * not (`failed`). Throws only when the model can't be reached (the step retries). A finished row returns its outcome.
 */
export async function resolveCommit(
  deps: {
    env: CloudflareBindings;
    db: DrizzleDB;
    resolver: (id: string) => ConflictResolverApi;
  },
  id: string
): Promise<{ status: 'resolved' | 'failed'; error?: string }> {
  const { env, db } = deps;
  const row = await db
    .select()
    .from(mergeResolutions)
    .where(eq(mergeResolutions.id, id))
    .get();
  if (!row) return { status: 'failed', error: SUPERSEDED };
  if (row.status === 'resolved' || row.status === 'applied')
    return { status: 'resolved' };
  if (row.status !== 'running')
    return { status: 'failed', error: row.errorMessage ?? undefined };
  const fail = async (error: string) => ({
    status: 'failed' as const,
    error: await failResolution(db, id, error),
  });
  const pr = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.id, row.pullRequestId))
    .get();
  const found = pr ? await findRepoById(db, pr.repositoryId) : undefined;
  if (!pr || pr.state !== 'open' || !found) return fail(SUPERSEDED);
  const git = gitFor(env, found.repo);
  // The model is never asked about commits nobody will land.
  const tips = await rebaseTips(git, pr);
  if (!tips || tips.onto !== row.baseSha || tips.head !== row.headSha)
    return fail(SUPERSEDED);
  const committer = { ...REBASE_COMMITTER, timestamp: 0 };
  const earlier = await resolutionsFor(db, pr.id, tips);
  const stop = await rebase(git, {
    head: tips.head,
    onto: tips.onto,
    committer,
    ontoLabel: tips.ontoBranch,
    resolutions: earlier,
  });
  if (stop.kind !== 'conflict' || stop.commit.hash !== row.commitSha)
    return fail('There is nothing to resolve anymore.');
  const request = await commitRequest(git, pr, tips, stop);
  const r = await deps.resolver(id).resolve({ ...request, model: row.model });
  await env.ACTIONS_LOGS.put(transcriptKey(pr.repositoryId, id), r.transcript, {
    httpMetadata: { contentType: 'application/json' },
  });
  let messages: unknown = [];
  try {
    messages = JSON.parse(r.transcript);
  } catch {
    // Not JSON: recorded without token counts.
  }
  // One usage row per resolution (a retried step rejoins the same run, so its record replaces this one).
  await recordAiUsage(env, {
    id: `merge-resolution:${id}`,
    feature: 'merge-resolution',
    model: row.model,
    repositoryId: pr.repositoryId,
    pullRequestId: pr.id,
    mergeResolutionId: id,
    ...usageFromTranscript(messages),
  });
  if (r.status !== 'done')
    return fail(`The model didn't finish${r.reason ? ` (${r.reason})` : ''}.`);
  const files: Record<string, string> = {};
  for (const path of row.conflictedPaths) {
    const text = r.files[path];
    if (text === undefined)
      return fail(`The model deleted ${path} instead of resolving it.`);
    if (CONFLICT_MARKER.test(text))
      return fail(`${path} still has conflict markers.`);
    files[path] = text;
  }
  // The commit must now replay: the rebase gets past it (done, or a later commit's conflict).
  const after = await rebase(git, {
    head: tips.head,
    onto: tips.onto,
    committer,
    ontoLabel: tips.ontoBranch,
    resolutions: new Map([
      ...earlier,
      [row.commitSha!, new Map(Object.entries(files))],
    ]),
  });
  if (after.kind === 'conflict' && after.commit.hash === row.commitSha)
    return fail('The resolved files still left conflicts.');
  const extra = Object.keys(r.files).filter(
    (p) => !row.conflictedPaths.includes(p)
  );
  await db
    .update(mergeResolutions)
    .set({
      status: 'resolved',
      resolvedFiles: files,
      explanation: r.explanation.trim() || null,
      touchedExtraPaths: extra.length ? extra : null,
      transcriptR2Key: transcriptKey(pr.repositoryId, id),
      durationMs: Date.now() - row.createdAt.getTime(),
      decidedAt: new Date(),
    })
    .where(
      and(eq(mergeResolutions.id, id), eq(mergeResolutions.status, 'running'))
    );
  return { status: 'resolved' };
}
```

- [ ] **Step 4: The run asks AI**

In `worker/src/merge/rebase.ts`:

- Export `resolutionsFor` (`export async function resolutionsFor(`).
- Add after `REBASE_RUN_FRESH_MS`:

```ts
/** At most this many commits of one rebase run are resolved by AI; then the agent rebases locally. */
export const MAX_AI_COMMITS = 20;
```

- Add to `stopMessage`:

```ts
  tooManyConflicts: (commit: string, paths: string[]) =>
    `Commit ${sha7(commit)} conflicts in ${paths.join(', ')}; AI already resolved ${MAX_AI_COMMITS} commits of this rebase. Rebase locally.`,
```

- Add `import { claimResolution, failResolution, MODEL_UNREACHABLE, RESOLVE_RETRIES, resolveCommit } from './commit-resolution';`
  and replace `onConflict` with:

```ts
/**
 * A commit's replay conflicted. AI resolves text conflicts outside generated files (one resolution per commit, at most
 * MAX_AI_COMMITS a run); anything else, or AI failing, stops the rebase for the agent.
 */
async function onConflict(
  deps: RebaseDeps,
  step: StepRunner,
  job: Job,
  tips: RebaseTips,
  r: Extract<Replay, { kind: 'conflict' }>,
  attempt: number,
  k: number
): Promise<'continue' | 'stop'> {
  const { env, db, resolver } = deps;
  const why = !r.textual
    ? stopMessage.notText(r.commit, r.paths)
    : r.generated.length
      ? stopMessage.generated(r.commit, r.generated)
      : !resolver
        ? stopMessage.noAi(r.commit, r.paths)
        : k >= MAX_AI_COMMITS
          ? stopMessage.tooManyConflicts(r.commit, r.paths)
          : null;
  if (why || !resolver) {
    await step.do(`stop:${attempt}:${k}`, () =>
      recordStop(db, job.pullRequestId, tips, {
        commit: r.commit,
        paths: r.paths,
        error: why!,
      })
    );
    return 'stop';
  }
  const claimed = await step.do(`claim:${attempt}:${k}`, () =>
    claimResolution(env, db, job.pullRequestId, tips, r)
  );
  if (claimed.status === 'resolved' || claimed.status === 'applied')
    return 'continue';
  if (claimed.status !== 'running') return 'stop';
  try {
    const out = await step.do(
      `resolve:${sha7(r.commit)}:${attempt}`,
      RESOLVE_RETRIES,
      () => resolveCommit({ env, db, resolver }, claimed.id)
    );
    return out.status === 'resolved' ? 'continue' : 'stop';
  } catch (e) {
    console.error('[rebase] resolution failed', claimed.id, e);
    await step.do(`fail:${attempt}:${k}`, () =>
      failResolution(db, claimed.id, MODEL_UNREACHABLE)
    );
    return 'stop';
  }
}
```

- In `afterRebase`, before `const update = …`, mark the resolutions the written rebase used:

```ts
for (const c of w.resolved)
  await db
    .update(mergeResolutions)
    .set({ status: 'applied', resultSha: c.rebased })
    .where(
      and(
        eq(mergeResolutions.pullRequestId, pr.id),
        eq(mergeResolutions.headSha, w.from),
        eq(mergeResolutions.commitSha, c.original),
        eq(mergeResolutions.status, 'resolved')
      )
    );
```

In `worker/src/merge/resolver.ts`, in `preamble`, replace
`>>>>>>> ${labels.theirs}   (the pull request being merged)` with
`>>>>>>> ${labels.theirs}   (the pull request's commit being replayed onto it)`, and in `resolve()`'s prompt replace
`What the pull request (${request.labels.theirs}) changes and why:` with
`What the pull request's commit (${request.labels.theirs}) changes and why:`.

In `worker/src/agent-runs/record.ts`, `decisionFor`: replace the `resolve` case with

```ts
    case 'resolve':
      if (r?.status === 'resolved') return 'Resolved';
      return r?.status === 'failed' ? `Not resolved: ${r.error ?? 'failed'}` : null;
    case 'fail':
      return typeof r === 'string' ? r : null;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test worker/src/__tests__/rebase-resolution.test.ts worker/src/__tests__/pulls-ai-resolution.test.ts worker/src/__tests__/rebase-runs.test.ts worker/src/__tests__/agent-runs.test.ts`
Expected: PASS.

- [ ] **Step 6: CI, typecheck, commit**

In `.github/workflows/ci.yml`, job `test-review`, after `worker/src/__tests__/rebase-runs.test.ts` add
`worker/src/__tests__/rebase-resolution.test.ts`.

Run: `yarn typecheck && yarn test worker/src/__tests__/ci-workflow.test.ts`
Expected: clean; PASS.

```bash
yarn -s prettier --write worker/src/merge worker/src/agent-runs/record.ts worker/src/__tests__/rebase-resolution.test.ts worker/src/__tests__/pulls-ai-resolution.test.ts
git add worker/src/merge worker/src/agent-runs/record.ts worker/src/__tests__/rebase-resolution.test.ts \
  worker/src/__tests__/pulls-ai-resolution.test.ts .github/workflows/ci.yml
git commit -m "Rebase runs: AI resolves each conflicting commit, with a trailer; a failure stops for the agent" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: A clean rebase keeps the review

**Files:**

- Create: `worker/src/review/carry.ts`
- Modify: `worker/src/merge/rebase.ts` (`afterRebase` carries before the sweep)
- Test: `worker/src/__tests__/review-carry.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: `headReviewFor`, `headReviewId` (`review/keys.ts`); `d1Of` (`pulls/events.ts`); `Written.clean`
  (Task 2); test helpers `appRepo`, `invitedAgent`, `openPull`, `startReview`, `runReviews`, `agentModels`,
  `AGENT_MD`, `BASE` (`helpers/reviews.ts`), `finding`, `decide`, `findings` (`helpers/lessons.ts`), `moved`,
  `runRebases`, `fakeResolver` (`helpers/rebase.ts`).
- Produces: `carryReview(db: DrizzleDB, pr: Pick<PullRequest, 'id'>, from: string, to: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

Create `worker/src/__tests__/review-carry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { AgentReview } from '../review/contract';
import { call, type TestEnv } from './helpers/app';
import { commitPaths } from './helpers/seed';
import {
  AGENT_MD,
  agentModels,
  appRepo,
  BASE,
  invitedAgent,
  openPull,
  runReviews,
  startReview,
} from './helpers/reviews';
import { decide, finding, findings } from './helpers/lessons';
import { fakeResolver, moved, runRebases } from './helpers/rebase';

const ONE_FOR_A_PERSON: AgentReview = {
  verdict: 'findings',
  summary: 'One thing for a person.',
  findings: [finding('needs_person', 'Check the token')],
};

const prId = async (t: TestEnv) =>
  (await t.env.DB.prepare(
    'SELECT id FROM pull_requests WHERE number = 1'
  ).first<{ id: string }>())!.id;

const heads = async (t: TestEnv, table: string) =>
  (
    await t.env.DB.prepare(`SELECT DISTINCT head_sha AS h FROM ${table}`).all<{
      h: string;
    }>()
  ).results.map((r) => r.h);

/** octocat/app with @secagent, PR #1 changing `changes`, reviewed (one finding for a person, approved), approved. */
async function reviewedAndApproved(changes: Record<string, string>) {
  const { t, admin, repo } = await appRepo();
  await invitedAgent(t, admin, 'secagent', AGENT_MD());
  const { head } = await openPull(t, admin, repo, changes);
  await startReview(t);
  await runReviews(t, agentModels({ review: () => ONE_FOR_A_PERSON }).models);
  const [flag] = await findings(t);
  await decide(t, admin, flag.id);
  const res = await call(t, '/api/repos/octocat/app/pulls/1/approval', {
    cookie: admin,
    method: 'POST',
  });
  expect(res.status).toBe(200);
  return { t, admin, repo, head, flag };
}

const reviewPayloadsFor = (t: TestEnv, id: string) =>
  t.actions.resolutions.filter(
    (r) => (r.params as { headReview?: { id: string } }).headReview?.id === id
  );

describe('review carry-over', () => {
  it('moves findings, verdicts and approvals to the head a clean rebase made', async () => {
    const { t, repo, head, flag } = await reviewedAndApproved({
      'src/auth.ts': 'export const t = 1;\n',
    });
    const old = repo.refs.get('refs/heads/main')!;
    await commitPaths(repo, 'main', { ...BASE, 'z.txt': 'z\n' }, 'Main moves');
    await moved(t, 'main', old);
    await runRebases(t);
    const now = repo.refs.get('refs/heads/feature')!;
    expect(now).not.toBe(head);
    const id = await prId(t);
    expect(
      (
        await t.env.DB.prepare('SELECT id FROM pr_classifications').all<{
          id: string;
        }>()
      ).results.map((r) => r.id)
    ).toEqual([`${id}-${now}`]);
    expect(await findings(t)).toEqual([
      expect.objectContaining({ id: flag.id }),
    ]);
    expect(await heads(t, 'pr_reviewers')).toEqual([now]);
    expect(await heads(t, 'pr_approvals')).toEqual([now]);
    // Nothing reviews the new head again.
    expect(reviewPayloadsFor(t, `${id}-${now}`)).toEqual([]);
  });

  it('starts a fresh review, and keeps old approvals on the old head, after an AI resolution', async () => {
    const { t, repo, head } = await reviewedAndApproved({
      'src/app.ts': 'export const a = 2;\n',
    });
    const old = repo.refs.get('refs/heads/main')!;
    await commitPaths(
      repo,
      'main',
      { 'src/app.ts': 'export const a = 3;\n' },
      'Main moves'
    );
    await moved(t, 'main', old);
    const { resolver } = fakeResolver(() => ({
      files: { 'src/app.ts': 'export const a = 23;\n' },
    }));
    await runRebases(t, { resolver });
    const now = repo.refs.get('refs/heads/feature')!;
    expect(now).not.toBe(head);
    const id = await prId(t);
    expect(reviewPayloadsFor(t, `${id}-${now}`)).toHaveLength(1);
    expect(await heads(t, 'pr_approvals')).toEqual([head]);
  });

  it('starts a fresh review when a replayed commit no longer makes the same change', async () => {
    const { t, repo, head } = await reviewedAndApproved({
      'src/app.ts': 'export const a = 2;\n',
      'src/b.ts': 'export const b = 1;\n',
    });
    const old = repo.refs.get('refs/heads/main')!;
    // main makes the same change to src/app.ts, plus another: the replayed commit only adds src/b.ts now.
    await commitPaths(
      repo,
      'main',
      { 'src/app.ts': 'export const a = 2;\n', 'z.txt': 'z\n' },
      'Main moves'
    );
    await moved(t, 'main', old);
    await runRebases(t);
    const now = repo.refs.get('refs/heads/feature')!;
    expect(now).not.toBe(head);
    expect(reviewPayloadsFor(t, `${await prId(t)}-${now}`)).toHaveLength(1);
  });

  it('leaves a review still running with the old head, and still carries approvals', async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    const { head } = await openPull(t, admin, repo, {
      'src/auth.ts': 'export const t = 1;\n',
    });
    await call(t, '/api/repos/octocat/app/pulls/1/approval', {
      cookie: admin,
      method: 'POST',
    });
    const old = repo.refs.get('refs/heads/main')!;
    await commitPaths(repo, 'main', { ...BASE, 'z.txt': 'z\n' }, 'Main moves');
    await moved(t, 'main', old);
    await runRebases(t);
    const now = repo.refs.get('refs/heads/feature')!;
    const id = await prId(t);
    const reviews = (
      await t.env.DB.prepare(
        'SELECT id FROM pr_classifications ORDER BY created_at'
      ).all<{ id: string }>()
    ).results.map((r) => r.id);
    expect(reviews[0]).toBe(`${id}-${head}`);
    expect(reviewPayloadsFor(t, `${id}-${now}`)).toHaveLength(1);
    expect(await heads(t, 'pr_approvals')).toEqual([now]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test worker/src/__tests__/review-carry.test.ts`
Expected: FAIL — the first test sees the old review id and a fresh review payload for the new head.

- [ ] **Step 3: Carry the review**

Create `worker/src/review/carry.ts`:

```ts
import type { DrizzleDB } from '../db/middleware';
import type { PullRequest } from '../db/app.schema';
import { d1Of } from '../pulls/events';
import { headReviewFor, headReviewId } from './keys';

/**
 * A clean rebase keeps the pull request's review. The agents' finished review of the old head (pr_classifications, its
 * findings, each agent's verdict) moves to the new head, and so do people's approvals: rows are re-keyed, not copied,
 * so a finding or a dismissal never counts twice. A review still running stays with the old head (the sweep reviews
 * the new one). One D1 batch. Returns whether a review moved.
 */
export async function carryReview(
  db: DrizzleDB,
  pr: Pick<PullRequest, 'id'>,
  from: string,
  to: string
): Promise<boolean> {
  const old = await headReviewFor(db, pr.id, from);
  const moveReview =
    !!old &&
    (old.status === 'done' || old.status === 'failed') &&
    !(await headReviewFor(db, pr.id, to));
  const d1 = d1Of(db);
  const oldId = headReviewId(pr.id, from);
  const newId = headReviewId(pr.id, to);
  const statements: D1PreparedStatement[] = [];
  if (moveReview)
    statements.push(
      d1
        .prepare(
          `INSERT INTO pr_classifications (id, pull_request_id, head_sha, status, summary_model, classifier_model,
             files, error_message, duration_ms, created_at, finished_at)
           SELECT ?, pull_request_id, ?, status, summary_model, classifier_model, files, error_message, duration_ms,
             created_at, finished_at
             FROM pr_classifications WHERE id = ?`
        )
        .bind(newId, to, oldId),
      d1
        .prepare(
          'UPDATE pr_review_flags SET classification_id = ? WHERE classification_id = ?'
        )
        .bind(newId, oldId),
      d1
        .prepare(
          'UPDATE OR IGNORE pr_reviewers SET head_sha = ? WHERE pull_request_id = ? AND head_sha = ?'
        )
        .bind(to, pr.id, from),
      d1.prepare('DELETE FROM pr_classifications WHERE id = ?').bind(oldId)
    );
  statements.push(
    d1
      .prepare(
        'UPDATE OR IGNORE pr_approvals SET head_sha = ? WHERE pull_request_id = ? AND head_sha = ?'
      )
      .bind(to, pr.id, from)
  );
  await d1.batch(statements);
  return moveReview;
}
```

In `worker/src/merge/rebase.ts`, add `import { carryReview } from '../review/carry';` and in `afterRebase`, before
`const update = …`:

```ts
// A clean rebase keeps the review; otherwise the sweep below starts a fresh one for the new head.
if (w.clean) await carryReview(db, pr, w.from, w.to);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test worker/src/__tests__/review-carry.test.ts worker/src/__tests__/rebase-runs.test.ts worker/src/__tests__/agent-learning-lessons.test.ts worker/src/__tests__/review-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: CI, typecheck, commit**

In `.github/workflows/ci.yml`, job `test-review`, after `worker/src/__tests__/review-gate.test.ts` add
`worker/src/__tests__/review-carry.test.ts`.

Run: `yarn typecheck && yarn test worker/src/__tests__/ci-workflow.test.ts`
Expected: clean; PASS.

```bash
yarn -s prettier --write worker/src/review/carry.ts worker/src/merge/rebase.ts worker/src/__tests__/review-carry.test.ts
git add worker/src/review/carry.ts worker/src/merge/rebase.ts worker/src/__tests__/review-carry.test.ts .github/workflows/ci.yml
git commit -m "Rebase runs: a clean rebase carries the review and approvals to the new head" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Merging is a fast-forward

**Files:**

- Modify: `worker/src/merge/land.ts` (whole file: fast-forward landing, rebase before landing, no squash credits)
- Modify: `worker/src/lib/pulls.ts` (`pullShas`)
- Modify: `worker/src/routers/pulls-router.ts` (merge route body)
- Modify: `worker/src/mcp/pull-tools.ts` (`gitorange_merge_pull_request`)
- Modify: `worker/src/review/auto-merge.ts` (`landPull` call)
- Test: `worker/src/__tests__/rebase-landing.test.ts`
- Modify tests: `repos-pulls.test.ts`, `land-target.test.ts`, `mcp.test.ts`, `review-gate.test.ts`,
  `actions.test.ts`
- Delete: `worker/src/__tests__/squash-credits.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes (Tasks 2–4): `rebaseAt`, `writeRebase`, `written`, `afterRebase`, `ensureRebase`, `stopMessage`,
  `RebaseTips`, `REBASE_COMMITTER`; `pullRequests.landedCommits`; `checksAt`, `reviewGateFor`, `reviewReasonText`.
- Produces:
  - `landPull(opts: { env; db; repo; repoFullName; git; pr; by: { id: string; name: string; email: string } | null; expectedHead?: string; after: (work: Promise<unknown>) => void; deleteBranch?: boolean }): Promise<LandResult>` — no `author`, `title`, `message` or `resolutionId`.
  - `LandResult = { ok: true; sha: string; headSha: string } | { ok: false; status: 400 | 409; error: string; reason?: 'stack' | 'checks' | 'review' | 'rebase' }` — `sha` is the landed head.
  - `pullShas(git, pr)` — merged: `{ base: <first parent of the oldest landed commit>, head: <landed head> }`, or the
    squash rule when `landedCommits` is null.
  - Removed: `squashCredits`.

- [ ] **Step 1: Write the failing tests**

Create `worker/src/__tests__/rebase-landing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
  type TestEnv,
} from './helpers/app';
import { commitPaths } from './helpers/seed';
import { events } from './helpers/stacking';

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

/** octocat/app; PR #1 from `feature` (Add b, then Add c) into main; `ci` adds a pull_request workflow. */
async function landing(opts: { ci?: boolean } = {}) {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'internal' },
  });
  const repo = [...t.fake.repos.values()][0];
  const base: Record<string, string> = {
    'a.txt': 'a\n',
    ...(opts.ci ? { '.github/workflows/ci.yml': CI } : {}),
  };
  const root = await commitPaths(repo, 'main', base, 'base');
  repo.refs.set('refs/heads/feature', root);
  const f1 = await commitPaths(
    repo,
    'feature',
    { ...base, 'b.txt': 'b\n' },
    'Add b'
  );
  const f2 = await commitPaths(
    repo,
    'feature',
    { ...base, 'b.txt': 'b\n', 'c.txt': 'c\n' },
    'Add c'
  );
  const res = await call(t, '/api/repos/octocat/app/pulls', {
    cookie: admin,
    json: { title: 'B and c', body: '', base: 'main', head: 'feature' },
  });
  expect(res.status).toBe(201);
  await settle(t);
  return {
    t,
    admin,
    repo,
    base,
    root,
    f1,
    f2,
    passChecks: () =>
      t.env.DB.prepare(
        "UPDATE workflow_runs SET status = 'completed', conclusion = 'success'"
      ).run(),
    merge: () =>
      call(t, '/api/repos/octocat/app/pulls/1/merge', {
        cookie: admin,
        json: { approve: true },
      }),
    moveMain: (files: Record<string, string> = { ...base, 'z.txt': 'z\n' }) =>
      commitPaths(repo, 'main', files, 'Main moves'),
  };
}

const row = (t: TestEnv) =>
  t.env.DB.prepare(
    'SELECT state, merge_commit_sha AS sha, landed_commits AS landed FROM pull_requests WHERE number = 1'
  ).first();

describe('landing by fast-forward', () => {
  it('moves the target to the head: no new commit, every SHA and message kept', async () => {
    const { t, repo, root, f1, f2, merge } = await landing();
    const res = await merge();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sha: f2 });
    expect(repo.refs.get('refs/heads/main')).toBe(f2);
    expect(repo.parseCommit(f2)!.parents).toEqual([f1]);
    expect(repo.parseCommit(f1)!.parents).toEqual([root]);
    expect(repo.refs.get('refs/pull/1/head')).toBe(f2);
    expect(await row(t)).toEqual({ state: 'merged', sha: f2, landed: 2 });
  });

  it('shows a landed pull request’s own commits and files, even after the target moves on', async () => {
    const { t, admin, merge, moveMain } = await landing();
    expect((await merge()).status).toBe(200);
    await moveMain();
    const commits = (await (
      await call(t, '/api/repos/octocat/app/pulls/1/commits', { cookie: admin })
    ).json()) as { message: string }[];
    expect(commits.map((c) => c.message)).toEqual(['Add b', 'Add c']);
    const files = (await (
      await call(t, '/api/repos/octocat/app/pulls/1/files', { cookie: admin })
    ).json()) as { path: string }[];
    expect(files.map((f) => f.path)).toEqual(['b.txt', 'c.txt']);
  });

  it('rebases first when the target moved, and lands at once when nothing needs checks', async () => {
    const { t, repo, f2, merge, moveMain } = await landing();
    const tip = await moveMain();
    const res = await merge();
    expect(res.status).toBe(200);
    const head = repo.refs.get('refs/heads/feature')!;
    expect(head).not.toBe(f2);
    expect(repo.refs.get('refs/heads/main')).toBe(head);
    const top = repo.parseCommit(head)!;
    expect(top.message).toBe('Add c');
    expect(repo.parseCommit(top.parents[0])!.parents).toEqual([tip]);
    expect(repo.refs.get(`refs/pull/1/pre-rebase/${f2.slice(0, 7)}`)).toBe(f2);
    expect(await row(t)).toEqual({ state: 'merged', sha: head, landed: 2 });
    expect((await events(t, 1)).map((e) => e.kind)).toContain('rebased');
  });

  it('rebases first, then waits for checks on the new head; merging again lands it', async () => {
    const { t, repo, base, merge, moveMain, passChecks } = await landing({
      ci: true,
    });
    await passChecks();
    await moveMain({ ...base, 'z.txt': 'z\n' });
    const res = await merge();
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(
      /Rebased onto main as [0-9a-f]{7} — waiting for checks/
    );
    const head = repo.refs.get('refs/heads/feature')!;
    expect(repo.refs.get('refs/heads/main')).not.toBe(head);
    expect(
      await t.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM workflow_runs WHERE event = 'pull_request' AND head_sha = ? AND status != 'completed'"
      )
        .bind(head)
        .first()
    ).toEqual({ n: 1 });
    await passChecks();
    expect((await merge()).status).toBe(200);
    expect(repo.refs.get('refs/heads/main')).toBe(head);
  });

  it('refuses a rebase conflict, naming the commit, and leaves it to a rebase run', async () => {
    const { t, repo, base, f2, merge, moveMain } = await landing();
    await moveMain({ ...base, 'c.txt': 'main c\n' });
    const res = await merge();
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(
      `stops at commit ${f2.slice(0, 7)}, which conflicts in c.txt. GitOrange is resolving it`
    );
    expect(repo.refs.get('refs/heads/feature')).toBe(f2);
    await settle(t);
    expect(
      t.actions.resolutions.some(
        (r) => (r.params as { rebase?: unknown }).rebase
      )
    ).toBe(true);
  });

  it('refuses when there is nothing to merge', async () => {
    const { repo, f2, merge } = await landing();
    repo.refs.set('refs/heads/main', f2);
    const res = await merge();
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Nothing to merge');
  });

  it('keeps the squash rule for pull requests merged before rebase merging', async () => {
    const { t, admin, repo, f2 } = await landing();
    const squash = await commitPaths(
      repo,
      'main',
      { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' },
      'B and c (#1)'
    );
    repo.refs.set('refs/pull/1/head', f2);
    await t.env.DB.prepare(
      "UPDATE pull_requests SET state = 'merged', merge_commit_sha = ?, landed_commits = NULL, merged_at = 1, closed_at = 1"
    )
      .bind(squash)
      .run();
    const files = (await (
      await call(t, '/api/repos/octocat/app/pulls/1/files', { cookie: admin })
    ).json()) as { path: string }[];
    expect(files.map((f) => f.path)).toEqual(['b.txt', 'c.txt']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test worker/src/__tests__/rebase-landing.test.ts`
Expected: FAIL — the first test gets a new squash commit (`sha` ≠ `f2`), `landed` is null.

- [ ] **Step 3: Land by fast-forward**

Replace `worker/src/merge/land.ts` with:

```ts
import { and, eq, ne, or } from 'drizzle-orm';
import { settleStates } from '../pulls/settle';
import { queueLessons } from '../learn/lessons';
import { publishChange } from '../live/publish';
import type { DrizzleDB } from '../db/middleware';
import {
  pullRequests,
  repositories,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import { REBASE_COMMITTER } from '../git/rebase';
import { GitPushError, ZERO_SHA } from '../git/remote';
import type { GitService } from '../git/service';
import { onRefsUpdated } from '../actions/trigger';
import { startSweep } from './auto';
import { resolutionConfigured } from './resolution';
import {
  afterRebase,
  ensureRebase,
  rebaseAt,
  stopMessage,
  writeRebase,
  written,
  type RebaseTips,
} from './rebase';
import { checksAt, reviewGateFor, reviewReasonText } from '../review/gate';
import { landTargetIs, landTargetOf } from '../lib/land-target';
import { stackGate } from '../stack/gate';
import { onPullClosed } from '../stack/retarget';
import { refreshAgentConfig } from '../agents/refresh';

export const pullRef = (n: number) => `refs/pull/${n}/head`;

type Refusal = {
  ok: false;
  status: 400 | 409;
  error: string;
  /** Which gate refused it (absent for other failures). */
  reason?: 'stack' | 'checks' | 'review' | 'rebase';
};
export type LandResult = { ok: true; sha: string; headSha: string } | Refusal;

type LandOpts = {
  env: CloudflareBindings;
  db: DrizzleDB;
  repo: Repository;
  repoFullName: string;
  git: GitService;
  pr: PullRequest;
  /** Who merged it; null for auto-merge. */
  by: { id: string; name: string; email: string } | null;
  /** The head commit the person saw: refused (409) when the branch has moved since. */
  expectedHead?: string;
  /** Runs follow-up work (Actions, sweeps) after the merge. */
  after: (work: Promise<unknown>) => void;
  /**
   * Delete the head branch once it has landed (auto-merge), after its stacked children have been sent back to
   * the land target, so a branch a child was stacked on isn't kept for that child.
   */
  deleteBranch?: boolean;
};

/**
 * Lands a pull request by moving its land target to its head with compare-and-swap (a fast-forward): the target keeps
 * every commit with its author, message and SHA, and no commit is made. When the target moved since the branch was
 * last rebased, rebases it first and pushes the rebased branch; it then lands in the same call only when the new head
 * needs no checks and its review carried over, else it stops ("rebased — waiting for checks") and auto-merge lands it
 * once they pass.
 */
export async function landPull(opts: LandOpts): Promise<LandResult> {
  const { env, db, git, pr } = opts;
  if (pr.state !== 'open')
    return { ok: false, status: 400, error: 'Pull request is not open' };
  const target = landTargetOf(pr);
  const headSha = await git.resolve(pr.headRef);
  if (!headSha)
    return {
      ok: false,
      status: 400,
      error: 'The head branch no longer exists',
    };
  if (opts.expectedHead && opts.expectedHead !== headSha)
    return {
      ok: false,
      status: 409,
      error:
        'The pull request has new commits since you looked. Review them, then merge again.',
    };
  const gate = await stackGate(db, git, pr);
  if (gate.error)
    return {
      ok: false,
      status: 409,
      reason: 'stack',
      error:
        'Couldn’t check how it relates to other open pull requests (the stack tree). Try again.',
    };
  if (gate.blocks.length)
    return {
      ok: false,
      status: 409,
      reason: 'stack',
      error: `${gate.blocks.map((b) => b.message.replace(/[.\s]+$/, '')).join('. ')}. A maintainer can dismiss a dependency on the pull request page.`,
    };
  // Checks, then review, for the commit that lands; a person's approval of it satisfies review.
  const checks = await checksAt(db, pr.repositoryId, headSha);
  if (checks)
    return {
      ok: false,
      status: 409,
      reason: 'checks',
      error:
        checks.kind === 'failed'
          ? `${checks.reason} (run #${checks.runNumber}). Fix them, then merge.`
          : `${checks.reason}. Merge once they pass.`,
    };
  const review = await reviewGateFor(
    db,
    resolutionConfigured(env),
    pr,
    headSha
  );
  if (!review.satisfied)
    return {
      ok: false,
      status: 409,
      reason: 'review',
      error: `Review isn't satisfied: ${review.reasons.map(reviewReasonText).join('; ')}. Approve the pull request or its flags (an agent's change request needs a new commit or a Dismiss first).`,
    };
  const refsBefore = await git.refs();
  const baseBefore = refsBefore.get(`refs/heads/${target}`);
  if (!baseBefore)
    return {
      ok: false,
      status: 400,
      error: 'The target branch no longer exists',
    };
  const mb = await git.mergeBase(baseBefore, headSha);
  if (mb === headSha)
    return { ok: false, status: 400, error: 'Nothing to merge' };
  let landHead = headSha;
  if (mb !== baseBefore) {
    const rebased = await rebaseForLanding(opts, {
      onto: baseBefore,
      ontoBranch: target,
      head: headSha,
    });
    if (!rebased.ok) return rebased;
    landHead = rebased.head;
  }
  try {
    await git.client.push(
      [
        { ref: `refs/heads/${target}`, old: baseBefore, new: landHead },
        {
          ref: pullRef(pr.number),
          old: refsBefore.get(pullRef(pr.number)) ?? ZERO_SHA,
          new: landHead,
        },
      ],
      []
    );
  } catch (e) {
    if (e instanceof GitPushError)
      return {
        ok: false,
        status: 409,
        error: 'Base branch was modified. Review and try the merge again.',
      };
    return {
      ok: false,
      status: 400,
      error: e instanceof Error ? e.message : 'Merge failed',
    };
  }
  // The push is the commit point; record only after it succeeds.
  const landedCommits = (await git.commitsBetween(baseBefore, landHead)).length;
  const now = new Date();
  await db
    .update(pullRequests)
    .set({
      state: 'merged',
      mergeCommitSha: landHead,
      landedCommits,
      mergedById: opts.by?.id ?? null,
      mergedAutomatically: !opts.by,
      mergedAt: now,
      closedAt: now,
      updatedAt: now,
    })
    .where(eq(pullRequests.id, pr.id));
  await db
    .update(repositories)
    .set({ updatedAt: now })
    .where(eq(repositories.id, pr.repositoryId));
  // Auto-merges happen in the background.
  opts.after(publishChange(env, pr.repositoryId, { approvals: true }));
  opts.after(settleStates(env, db, pr.repositoryId));
  // The agents whose change requests on it were dismissed learn from them (worker/src/learn/).
  opts.after(queueLessons(env, db, pr));
  // Children stacked on its branch go back to the land target; a reconcile restacks them. Only then is the
  // branch free to delete.
  opts.after(
    onPullClosed(env, db, pr, 'landed').then(() =>
      opts.deleteBranch
        ? deleteMergedBranch({
            env,
            db,
            repo: opts.repo,
            git,
            pr,
            headSha: landHead,
          })
        : false
    )
  );
  const updates = [
    { ref: `refs/heads/${target}`, old: baseBefore, new: landHead },
  ];
  // Pull requests into the target are now behind: the sweep rebases them.
  opts.after(startSweep(env, opts.repo, updates));
  opts.after(
    onRefsUpdated(
      env,
      db,
      opts.repo,
      opts.repoFullName,
      updates,
      opts.by?.id ?? pr.authorId
    )
  );
  if (target === opts.repo.defaultBranch)
    opts.after(refreshAgentConfig(env, db, opts.repo.id));
  return { ok: true, sha: landHead, headSha };
}

/**
 * The target moved since the branch was last rebased: rebase it now and push the rebased branch (as a rebase run
 * would: Actions, the sweep, review carry-over). Ready to land only if the new head needs no checks and its review
 * holds; a conflict leaves the pull request to a rebase run.
 */
async function rebaseForLanding(
  opts: LandOpts,
  tips: RebaseTips
): Promise<{ ok: true; head: string } | Refusal> {
  const { env, db, git, pr } = opts;
  const result = await rebaseAt(git, db, pr, tips, {
    ...REBASE_COMMITTER,
    timestamp: Math.floor(Date.now() / 1000),
  });
  if (result.kind === 'up_to_date') return { ok: true, head: tips.head };
  if (result.kind !== 'done') {
    opts.after(ensureRebase(env, db, git, pr));
    return {
      ok: false,
      status: 409,
      reason: 'rebase',
      error:
        result.kind === 'too_many'
          ? stopMessage.tooMany(result.count)
          : `Rebasing onto ${tips.ontoBranch} stops at commit ${result.commit.hash.slice(0, 7)}, which conflicts in ${result.conflicts.join(', ')}. ${
              resolutionConfigured(env)
                ? 'GitOrange is resolving it; merge again once it has.'
                : 'Rebase it locally and push.'
            }`,
    };
  }
  if ((await writeRebase(git, pr, tips, result)) === 'moved')
    return {
      ok: false,
      status: 409,
      error:
        'The pull request has new commits since you looked. Review them, then merge again.',
    };
  const w = written(tips, result);
  await afterRebase(env, db, {
    repo: opts.repo,
    repoFullName: opts.repoFullName,
    pr,
    w,
  });
  const rebased = `Rebased onto ${tips.ontoBranch} as ${w.to.slice(0, 7)}`;
  const checks = await checksAt(db, pr.repositoryId, w.to);
  if (checks)
    return {
      ok: false,
      status: 409,
      reason: 'checks',
      error: `${rebased} — waiting for checks (${checks.reason}). It lands once they pass: on its own with auto-merge, else merge again.`,
    };
  const review = await reviewGateFor(db, resolutionConfigured(env), pr, w.to);
  if (!review.satisfied)
    return {
      ok: false,
      status: 409,
      reason: 'review',
      error: `${rebased}; review isn't satisfied for the new head: ${review.reasons.map(reviewReasonText).join('; ')}.`,
    };
  return { ok: true, head: w.to };
}

/**
 * After auto-merge lands a pull request, deletes its head branch with compare-and-swap on the
 * landed head. Keeps it when someone pushed since, when it's the default branch, or when
 * another open pull request uses it as base, head or land target (a stack builds on it). Never throws.
 */
export async function deleteMergedBranch(opts: {
  env: CloudflareBindings;
  db: DrizzleDB;
  repo: Repository;
  git: GitService;
  pr: Pick<PullRequest, 'id' | 'repositoryId' | 'headRef'>;
  /** The head commit that landed. */
  headSha: string;
}): Promise<boolean> {
  const { env, db, repo, git, pr } = opts;
  const branch = pr.headRef;
  try {
    if (branch === repo.defaultBranch) return false;
    const inUse = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, pr.repositoryId),
          eq(pullRequests.state, 'open'),
          ne(pullRequests.id, pr.id),
          or(
            eq(pullRequests.baseRef, branch),
            eq(pullRequests.headRef, branch),
            landTargetIs(branch)
          )
        )
      )
      .get();
    if (inUse) return false;
    // From the remote: landing may have just pushed a rebased head, which a cached listing wouldn't show.
    const { refs } = await git.client.listRefs();
    if (refs.get(`refs/heads/${branch}`) !== opts.headSha) return false;
    // A deletion starts no Actions run and leaves no PR to sweep, so a live ping is all it needs.
    await git.deleteBranch(branch, opts.headSha);
  } catch (e) {
    console.warn('[merge] could not delete merged branch', pr.id, branch, e);
    return false;
  }
  await publishChange(env, pr.repositoryId);
  return true;
}
```

- [ ] **Step 4: Callers, records and the merged diff**

`worker/src/lib/pulls.ts`, `pullShas`: replace the `if (pr.state === 'merged' && pr.mergeCommitSha) { … }` block
with:

```ts
if (pr.state === 'merged' && pr.mergeCommitSha) {
  if (pr.landedCommits) {
    // Landed by fast-forward: its commits are the first-parent run below the landed head.
    const landed = await git.log(pr.mergeCommitSha, pr.landedCommits);
    const oldest = landed.at(-1);
    if (landed.length < pr.landedCommits || !oldest?.parents[0]) return null;
    return { base: oldest.parents[0], head: pr.mergeCommitSha };
  }
  // Landed before rebase merging, as one squash commit: its first parent, and the pinned head.
  const merge = await git.commit(pr.mergeCommitSha);
  const head = (await git.resolve(pullRef(pr.number))) ?? merge?.parents[1];
  if (!merge || !head) return null;
  return { base: merge.parents[0], head };
}
```

and its doc comment: "The commits a PR compares: live branches while open; once merged, the landed commits (or, for a
squash-era merge, the squash commit's first parent and `refs/pull/<n>/head`); once closed, `refs/pull/<n>/head`."

`worker/src/routers/pulls-router.ts`, merge route: the body schema becomes

```ts
          schema: z.object({
            /** Approve the head commit as you merge it (a recorded approval; needs merge permission). */
            approve: z.boolean().optional(),
            /** The head commit you reviewed (and, with `approve`, approve); 409 if the branch has moved since. */
            headSha: z.string().optional(),
          }),
```

the 200 response `z.object({ sha: z.string() })` gets the description `'Merged: the target branch is now at sha'`, and
the `landPull` call drops `author`, `title` and `message`.

`worker/src/review/auto-merge.ts`, `maybeAutoMerge`: drop the `author` lookup (and the `users` import if unused) and
the `author:` argument.

`worker/src/mcp/pull-tools.ts`, `gitorange_merge_pull_request`: description becomes

```ts
      'Rebase and merge a pull request: if its target branch moved, GitOrange rebases it first, then moves the target ' +
      'branch to its head (a fast-forward), so every commit keeps its author, message and SHA and history stays linear. ' +
      'When it had to rebase and the new head needs checks or a fresh review, it stops with "Rebased onto … — waiting ' +
      'for checks" and lands once they pass (auto-merge) — call it again then. Refused while checks fail or run, review ' +
      "is not satisfied (an agent's change request, findings for a person, or no approval yet), or a rebase conflict " +
      'needs fixing locally. Needs push access.' +
      ' Also refused while it must account for another pull request, is stacked on an open one, or waits on one; the refusal names it. Only a person can dismiss such a dependency, in the web UI.',
```

its `inputSchema.properties` keep only `repository` and `number`, the `landPull` call drops `author`, `title`,
`message`, and the success text becomes
`` `Merged #${pr.number} into ${landTargetOf(pr)}: it is now at ${result.sha.slice(0, 7)}: ${pullUrl(ctx, fullName, pr.number)}` ``.

- [ ] **Step 5: Update the tests that pinned squash landing**

- Delete `worker/src/__tests__/squash-credits.test.ts` and its line in `.github/workflows/ci.yml`.
- `repos-pulls.test.ts`: delete the test "squash merges into a single-parent commit"; rename "shows the diff and merges
  a diverged branch with a real merge commit" to "shows the diff, rebases a diverged branch and fast-forwards onto it",
  and replace its block from `const baseBefore = …` to the tree assertion with:

```ts
const baseBefore = repo.refs.get('refs/heads/main')!;
const headSha = repo.refs.get('refs/heads/feature')!;
const merge = await call(t, '/api/repos/octocat/app/pulls/1/merge', {
  cookie: admin,
  json: { approve: true },
});
expect(merge.status).toBe(200);
const { sha } = (await merge.json()) as { sha: string };

// Rebased onto main, then main moved to it: the author's own commit, history linear.
expect(sha).toBe(repo.refs.get('refs/heads/feature'));
expect(repo.refs.get('refs/heads/main')).toBe(sha);
expect(repo.refs.get('refs/pull/1/head')).toBe(sha);
expect(repo.refs.get(`refs/pull/1/pre-rebase/${headSha.slice(0, 7)}`)).toBe(
  headSha
);
const commit = repo.parseCommit(sha)!;
expect(commit.parents).toEqual([baseBefore]);
expect(commit.message).toBe('Add greet');
expect(repo.parseTree(commit.treeHash)!.map((e) => e.name)).toEqual([
  'LICENSE',
  'README.md',
  'greet.py',
]);
```

and in "reports conflicts and refuses to merge them" drop `method: 'rebase',` from the merge body.

- `land-target.test.ts`, "lands into the land target, never the parent branch": replace the last three lines with

```ts
const childHead = s.repo.refs.get('refs/heads/child')!;
expect(s.repo.refs.get('refs/heads/main')).toBe(childHead); // a fast-forward to the child's head
expect(s.repo.parseCommit(childHead)!.parents).toEqual([parentTip]);
expect(s.repo.parseCommit(parentTip!)!.parents).toEqual([mainTip]);
```

- `mcp.test.ts`, the create/get/merge flow: replace the merged-text regex with
  `/^Merged #1 into main: it is now at [0-9a-f]{7}/`, and the `tip` lines with

```ts
const tip = repo.refs.get('refs/heads/main')!;
expect(tip).toBe(repo.refs.get('refs/heads/feature')); // a fast-forward: the branch's own commit
expect(repo.parseCommit(tip)!.message).toBe('Add a');
```

and the `after` expectation with `merged: { by: 'octocat', automatically: false, commit: tip },`.

- `review-gate.test.ts`: rename "squashes the commit the gate checked, even if the branch moves after the check" to
  "lands the commit the gate checked, even if the branch moves after the check", drop `author: user,` from the
  `landPull` call, and replace the last two lines with

```ts
expect(result).toMatchObject({ ok: true, sha: head, headSha: head });
expect(repo.refs.get('refs/heads/main')).toBe(head); // not the late commit
```

- `actions.test.ts`, "runs push workflows for the base branch after a merge": `json: { approve: true },` (no `method`).

- [ ] **Step 6: Run the tests**

Run: `yarn test worker/src/__tests__/rebase-landing.test.ts worker/src/__tests__/repos-pulls.test.ts worker/src/__tests__/land-target.test.ts worker/src/__tests__/mcp.test.ts worker/src/__tests__/review-gate.test.ts worker/src/__tests__/actions.test.ts worker/src/__tests__/stacking-landing.test.ts worker/src/__tests__/agent-learning-lessons.test.ts worker/src/__tests__/approvals.test.ts worker/src/__tests__/mcp-moderator.test.ts`
Expected: PASS.

- [ ] **Step 7: CI, typecheck, commit**

In `.github/workflows/ci.yml`, job `test-review`: replace `worker/src/__tests__/squash-credits.test.ts` with
`worker/src/__tests__/rebase-landing.test.ts`.

Run: `yarn typecheck && yarn test`
Expected: clean; all green.

```bash
yarn -s prettier --write worker/src .github/workflows/ci.yml
git add -A worker/src .github/workflows/ci.yml
git commit -m "Merging is a fast-forward: rebase first when the target moved; no squash commit, credits or title" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The pages say rebased, behind and rebase conflict

**Files:**

- Create: `src/lib/rebaseStatus.ts`, `src/lib/rebaseStatus.test.ts`
- Modify: `src/lib/uiApi.ts` (types, `mergePull`, drop the resolution calls, `AgentRunKind`)
- Modify: `src/lib/pullState.ts`, `src/lib/pullState.test.ts` (`rebase_conflict`, `rebase_onto`)
- Modify: `src/pages/PullView.tsx` (merge box, polling)
- Modify: `src/components/PullBadges.tsx`, `src/components/PullEvents.tsx` (`rebased`), `src/pages/AgentRuns.tsx`
  (`rebase` kind), `src/pages/PullNew.tsx` (compare wording)
- Delete: `src/components/AiResolution.tsx`

**Interfaces:**

- Consumes (Tasks 2, 5): `GET …/pulls/{n}` → `mergeable`, `rebase: { status, onto, commit, files, error } | null`;
  list `aiResolution: 'running' | 'failed' | null`; event `rebased` with `data: { from, to, onto, skipped, resolved }`;
  reason `rebase_conflict`; agent run kind `rebase`; merge body `{ approve?, headSha? }`.
- Produces (`src/lib/rebaseStatus.ts`):
  - `rebaseHeadline(r: RebaseView, headRef: string): { title: string; detail: string }`.
  - `rebasedText(d: Record<string, unknown>): string` — the `rebased` timeline entry.
  - `RebaseView` type in `uiApi.ts`: `{ status: 'nothing_to_merge' | 'up_to_date' | 'behind' | 'resolving' | 'conflict'; onto: string; commit: string | null; files: string[]; error: string | null }`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/rebaseStatus.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { rebasedText, rebaseHeadline } from './rebaseStatus';

const view = { onto: 'main', commit: null, files: [], error: null };

describe('rebase status text', () => {
  it('says where the branch stands against its base', () => {
    expect(
      rebaseHeadline({ ...view, status: 'up_to_date' }, 'feature').title
    ).toBe('Up to date with main');
    expect(rebaseHeadline({ ...view, status: 'behind' }, 'feature')).toEqual({
      title: 'Behind main',
      detail:
        'GitOrange rebases it onto the latest commits; merging rebases it first if it still needs to.',
    });
    expect(
      rebaseHeadline({ ...view, status: 'nothing_to_merge' }, 'feature').title
    ).toBe('This branch is up to date');
  });

  it('names the conflicting commit, and what to do', () => {
    expect(
      rebaseHeadline(
        {
          ...view,
          status: 'conflict',
          commit: 'abc1234def',
          files: ['x.ts'],
          error: 'Commit abc1234 conflicts in x.ts. Rebase locally.',
        },
        'feature'
      )
    ).toEqual({
      title: 'Commit abc1234 conflicts with main',
      detail: 'Commit abc1234 conflicts in x.ts. Rebase locally.',
    });
    expect(rebaseHeadline({ ...view, status: 'conflict' }, 'feature')).toEqual({
      title: 'This branch can’t be rebased onto main',
      detail: 'Rebase feature onto main locally, then push.',
    });
    expect(
      rebaseHeadline(
        { ...view, status: 'resolving', commit: 'abc1234def' },
        'feature'
      ).title
    ).toBe('Resolving commit abc1234’s conflict with AI');
  });

  it('describes a rebase on the timeline', () => {
    expect(
      rebasedText({
        from: 'aaaaaaa1',
        to: 'bbbbbbb2',
        onto: 'main',
        skipped: 2,
        resolved: 1,
      })
    ).toBe(
      'GitOrange rebased this branch onto main (aaaaaaa → bbbbbbb), skipping 2 commits main already has; AI resolved the conflicts of 1 commit'
    );
    expect(
      rebasedText({
        from: 'aaaaaaa1',
        to: 'bbbbbbb2',
        onto: 'main',
        skipped: 0,
        resolved: 0,
      })
    ).toBe('GitOrange rebased this branch onto main (aaaaaaa → bbbbbbb)');
  });
});
```

In `src/lib/pullState.test.ts`, replace the "says rebase onto" test with:

```ts
it('says rebase onto and rebase conflict', () => {
  expect(
    reasonText({
      kind: 'rebase_onto',
      pr: 28,
      branch: 'setup-checks',
      why: 'x',
    })
  ).toBe('GitOrange is rebasing it onto #28 (setup-checks)');
  expect(
    reasonText({
      kind: 'rebase_conflict',
      commit: 'abc1234def',
      files: ['x.ts', 'y.ts'],
      error: null,
    })
  ).toBe('commit abc1234 conflicts in x.ts, y.ts');
  expect(
    reasonText({
      kind: 'rebase_conflict',
      commit: null,
      files: [],
      error: 'Too many commits.',
    })
  ).toBe('Too many commits.');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/lib/rebaseStatus.test.ts src/lib/pullState.test.ts`
Expected: FAIL — `Failed to load url ./rebaseStatus`; `rebase onto #28 (setup-checks)` ≠ the new text.

- [ ] **Step 3: The text helpers**

Create `src/lib/rebaseStatus.ts`:

```ts
import type { RebaseView } from './uiApi';

const sha7 = (s: unknown) => (typeof s === 'string' ? s.slice(0, 7) : '');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The merge box's line about the branch against its base. */
export function rebaseHeadline(
  r: RebaseView,
  headRef: string
): { title: string; detail: string } {
  switch (r.status) {
    case 'nothing_to_merge':
      return {
        title: 'This branch is up to date',
        detail: 'There is nothing to merge.',
      };
    case 'up_to_date':
      return {
        title: `Up to date with ${r.onto}`,
        detail:
          'Merging moves the target branch to this branch’s head: its commits land as they are.',
      };
    case 'behind':
      return {
        title: `Behind ${r.onto}`,
        detail:
          'GitOrange rebases it onto the latest commits; merging rebases it first if it still needs to.',
      };
    case 'resolving':
      return {
        title: r.commit
          ? `Resolving commit ${sha7(r.commit)}’s conflict with AI`
          : 'Resolving a conflict with AI',
        detail: `The rebase onto ${r.onto} stopped there; an agent is resolving it and the rebase goes on.`,
      };
    case 'conflict':
      return {
        title: r.commit
          ? `Commit ${sha7(r.commit)} conflicts with ${r.onto}`
          : `This branch can’t be rebased onto ${r.onto}`,
        detail:
          r.error ?? `Rebase ${headRef} onto ${r.onto} locally, then push.`,
      };
  }
}

/** The `rebased` timeline entry as text. */
export function rebasedText(d: Record<string, unknown>): string {
  const skipped = Number(d.skipped) || 0;
  const resolved = Number(d.resolved) || 0;
  const onto = String(d.onto ?? 'its base');
  return (
    `GitOrange rebased this branch onto ${onto} (${sha7(d.from)} → ${sha7(d.to)})` +
    (skipped
      ? `, skipping ${plural(skipped, 'commit')} ${onto} already has`
      : '') +
    (resolved
      ? `; AI resolved the conflicts of ${plural(resolved, 'commit')}`
      : '')
  );
}
```

In `src/lib/pullState.ts`, `reasonText`: replace the `conflicts_unresolved` case with

```ts
    case 'rebase_conflict':
      return r.commit
        ? `commit ${String(r.commit).slice(0, 7)} conflicts in ${((r.files as string[]) ?? []).join(', ')}`
        : String(r.error ?? 'the rebase stopped');
```

and the `rebase_onto` case's text with `` `GitOrange is rebasing it onto #${n(r.pr)} (${String(r.branch)})` ``.

- [ ] **Step 4: Types and API calls**

In `src/lib/uiApi.ts`:

- `Pull.aiResolution?: 'running' | 'failed' | null;` (comment: "Pull request lists only (open): AI resolving a rebase
  conflict, or failed to").
- Add:

```ts
/** Where an open pull request stands against its base (GET …/pulls/{n} `rebase`). */
export type RebaseView = {
  status:
    'nothing_to_merge' | 'up_to_date' | 'behind' | 'resolving' | 'conflict';
  /** The branch it rebases onto. */
  onto: string;
  /** The commit AI is resolving, or where the rebase stopped (null: before any). */
  commit: string | null;
  files: string[];
  error: string | null;
};
```

- In `PullDetail`, replace `conflicts`, `conflictsResolvable`, `resolvedByAi`, `aiResolution`, `resolution` with
  `rebase: RebaseView | null;` (keep `mergeable: boolean | null;`, comment: "It can land: up to date, or behind
  (landing rebases it first).").
- Delete the `MergeResolution` type, `startResolution` and `rejectResolution`.
- `mergePull`'s body type becomes `{ approve?: boolean; headSha?: string }`.
- `AgentRunKind` gains `| 'rebase'`.

- [ ] **Step 5: The merge box**

In `src/pages/PullView.tsx`:

- Remove the `AiResolution` import; add `import { rebaseHeadline } from '@/lib/rebaseStatus';`.
- In `MergeBox`, delete the `title`/`message` state and their setters in `open` (`open` becomes
  `() => { setError(null); setConfirming(true); }`), drop `title, message,` from the `api.mergePull` body, and replace
  everything from `const hasConflicts = …` to the end of `confirmBox`'s explanatory `<p>` and the two inputs with:

```tsx
  const rebase = d.rebase;
  const conflict = rebase?.status === 'conflict';
  const headline = rebase ? rebaseHeadline(rebase, pr.headRef) : null;
  const confirmBox = (
    <div className="Box-row">
      {error && <div className="flash flash-error mb-2">{error}</div>}
      {needsApproval && (
        <p className="f6 mb-2">
          Review isn&apos;t satisfied (
          {d.pullState?.reasons.filter(blocking).map(reasonText).join('; ') ||
            'not approved'}
          ). Merging records your approval of this commit.
          {changesRequested &&
            ' Approval does not override an agent’s change request: dismiss it first, or the merge is refused.'}
        </p>
      )}
      <p className="f6 color-fg-muted mb-2">
        {rebase?.status === 'behind' ? (
          <>
            GitOrange rebases this branch onto <code>{rebase.onto}</code> first. If the rebased commits need
            checks, it lands once they pass.
          </>
        ) : (
          <>
            <code>{pr.baseRef}</code> moves to this branch&apos;s head: its commits land as they are, keeping
            history linear.
          </>
        )}
      </p>
```

(the buttons `div` after it stays as it is).

- In the returned JSX, replace the `<h3>` … `{conflict && !d.resolvedByAi && d.conflicts.length > 0 && (…)}` block
  inside the status row with:

```tsx
<h3 className="f5">{headline?.title ?? 'Checking the branch…'}</h3>;
{
  headline && <p className="f6 color-fg-muted mb-0">{headline.detail}</p>;
}
{
  (rebase?.status === 'conflict' || rebase?.status === 'resolving') &&
    rebase.files.length > 0 && <FileList paths={rebase.files} />;
}
```

and delete the `{showAi && <AiResolution … />}` line.

- In the page's `refetchInterval`, replace the two resolution lines at its top with
  `if (d.rebase?.status === 'resolving') return 3000;` and the final `const pending = …; return pending ? 5000 : false;`
  with `return false;` (a rebase run's push pings the page live).

- [ ] **Step 6: Badges, timeline, runs, compare**

`src/components/PullBadges.tsx`: `AI_LABEL` becomes

```ts
const AI_LABEL: Record<NonNullable<Pull['aiResolution']>, string> = {
  running: 'Resolving a rebase conflict with AI…',
  failed: 'Rebase conflict needs the author',
};
```

and the component's `state === 'proposed'`/`'queued'` branches go (the spark is always `color-fg-attention`; the
spinner shows for `running`).

`src/components/PullEvents.tsx`: `import { rebasedText } from '@/lib/rebaseStatus';` and before the final
`return null;`:

```tsx
if (e.kind === 'rebased') {
  const to = str(d.to);
  return (
    <Row icon={<GitBranchIcon />}>
      {rebasedText(d)}
      {to && (
        <>
          {' '}
          · <Link to={`${repoPath}/commit/${to}`}>{to.slice(0, 7)}</Link>
        </>
      )}
      {when}
    </Row>
  );
}
```

`src/pages/AgentRuns.tsx`: add `GitBranchIcon` to the octicons import and
`{ kind: 'rebase', label: 'Rebase', icon: GitBranchIcon },` before the `conflict_resolution` entry (relabel that one
`'Conflict resolution (squash-era)'`).

`src/pages/PullNew.tsx`: "These branches can be automatically merged." → "This branch can be rebased onto the base
cleanly."; "Can’t automatically merge." → "Can’t rebase automatically.".

Delete `src/components/AiResolution.tsx`.

- [ ] **Step 7: Run the tests, typecheck, build**

Run: `yarn test src/lib/rebaseStatus.test.ts src/lib/pullState.test.ts`
Expected: PASS.

Run: `yarn typecheck`
Expected: clean (`src/` no longer references `resolution`, `conflicts`, `resolvedByAi`, `startResolution`).

Run: `yarn build`
Expected: builds.

- [ ] **Step 8: Commit**

```bash
yarn -s prettier --write src
git add -A src
git commit -m "Pages: the merge box says behind, up to date or rebase conflict; rebased timeline entries" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Stacked children rebase cleanly once their parent lands

**Files:**

- Modify: `worker/src/stack/discover.ts:238-251` (landed prerequisites by their landed range)
- Test: `worker/src/__tests__/stacking-rebase.test.ts`
- Modify: `.github/workflows/ci.yml` (job `test-stacking`)

**Interfaces:**

- Consumes: `pullShas` (Task 5); `repoWithAgent`, `stackModels`, `drain`, `pushTo` (`helpers/stacking.ts`);
  `runRebases`, `detail`, `rows` (`helpers/rebase.ts`).
- Produces: nothing new; the landed side of a stack pair is `pullShas(git, landed)`.

- [ ] **Step 1: Write the failing tests**

Create `worker/src/__tests__/stacking-rebase.test.ts`:

```ts
// The stacked-child reproductions (rebase-merging spec, "Problem"): a child stacked on a parent that lands.
import { describe, expect, it } from 'vitest';
import type { Relation } from '../stack/models';
import type { TestEnv } from './helpers/app';
import { call } from './helpers/app';
import { commitPaths } from './helpers/seed';
import { drain, pushTo, repoWithAgent, stackModels } from './helpers/stacking';
import { detail, rows, runRebases } from './helpers/rebase';

const BUILDS_A: Relation = {
  kind: 'builds_on',
  prerequisite: 'a',
  reason: 'Builds on it.',
  instructions: null,
};
const PARENT_A = 'line 1\nfunction f() {\n  return 1;\n}\n';

/** Runs stacking, sweeps and rebase runs until nothing is left. */
async function quiet(
  t: TestEnv,
  models: ReturnType<typeof stackModels>['models']
) {
  for (;;) {
    await drain(t, models);
    if (!(await runRebases(t))) return;
  }
}

/**
 * #1 `one` adds a.txt; #2 `two` starts at one's head and adds `childChange`, opened against main and stacked on one by
 * discovery. Then `parentLater` (if any) is pushed to one, and #1 lands.
 */
async function scenario(
  childChange: Record<string, string>,
  parentLater?: Record<string, string>
) {
  const { t, admin, repo, open, files } = await repoWithAgent(true);
  const { models } = stackModels({
    related: () => true,
    relation: () => BUILDS_A,
  });
  await open('one', { 'a.txt': PARENT_A }, 'One');
  repo.refs.set('refs/heads/two', repo.refs.get('refs/heads/one')!);
  await commitPaths(
    repo,
    'two',
    { ...files, 'a.txt': PARENT_A, ...childChange },
    'Two'
  );
  const res = await call(t, '/api/repos/octocat/app/pulls', {
    cookie: admin,
    json: { title: 'Two', body: 'Two.', base: 'main', head: 'two' },
  });
  expect(res.status).toBe(201);
  await quiet(t, models);
  expect(
    await t.env.DB.prepare(
      'SELECT base_ref AS base FROM pull_requests WHERE number = 2'
    ).first()
  ).toEqual({ base: 'one' });
  if (parentLater) {
    await pushTo(t, repo, 'one', {
      ...files,
      'a.txt': PARENT_A,
      ...parentLater,
    });
    await quiet(t, models);
  }
  const parentHead = repo.refs.get('refs/heads/one')!;
  await call(t, '/api/repos/octocat/app/pulls/1/approval', {
    cookie: admin,
    method: 'POST',
  });
  await quiet(t, models);
  return { t, admin, repo, models, files, parentHead };
}

async function landedCleanly(s: Awaited<ReturnType<typeof scenario>>) {
  const { t, admin, repo, parentHead } = s;
  expect(
    (
      await t.env.DB.prepare(
        'SELECT number, state, base_ref AS base FROM pull_requests ORDER BY number'
      ).all()
    ).results
  ).toEqual([
    { number: 1, state: 'merged', base: 'main' },
    { number: 2, state: 'open', base: 'main' },
  ]);
  // #1 landed by fast-forward: main is the parent's own head.
  expect(repo.refs.get('refs/heads/main')).toBe(parentHead);
  const d = await detail(t, admin, 2);
  expect(d.rebase!.status).toBe('up_to_date');
  expect(d.mergeable).toBe(true);
  expect(d.pullState!.reasons.map((r) => r.kind)).not.toContain(
    'rebase_conflict'
  );
  expect(await rows(t)).toEqual([]);
}

describe('a stacked child after its parent lands', () => {
  it('A: the child only adds a file', async () => {
    await landedCleanly(await scenario({ 'b.txt': 'b\n' }));
  });

  it('B: the parent fixed its lines after the child stacked; the child only adds a file', async () => {
    const s = await scenario(
      { 'b.txt': 'b\n' },
      { 'a.txt': 'line 1\nfunction f() {\n  return 10;\n}\n' }
    );
    await landedCleanly(s);
    const head = s.repo.refs.get('refs/heads/two')!;
    // The child carries the parent's fix (rebased onto it), and its own commit once.
    expect(s.repo.parseCommit(head)!.message).toBe('Two');
    expect(s.repo.parseCommit(head)!.parents).toEqual([s.parentHead]);
  });

  it('C: the child edits the lines its parent added', async () => {
    const s = await scenario({
      'a.txt': 'line 1\nfunction f() {\n  return 2;\n}\n',
    });
    await landedCleanly(s);
  });

  it('a real conflict with main still surfaces, naming the child’s commit', async () => {
    const s = await scenario({
      'a.txt': 'line 1\nfunction f() {\n  return 2;\n}\n',
    });
    const { t, admin, repo, files, models } = s;
    const two = repo.refs.get('refs/heads/two')!;
    // Someone else changes the same line on main after the parent landed.
    await pushTo(t, repo, 'main', {
      ...files,
      'a.txt': 'line 1\nfunction f() {\n  return 3;\n}\n',
    });
    await quiet(t, models);
    const d = await detail(t, admin, 2);
    expect(d.rebase).toMatchObject({
      status: 'conflict',
      commit: two,
      files: ['a.txt'],
    });
    expect(d.pullState!.reasons).toContainEqual(
      expect.objectContaining({
        kind: 'rebase_conflict',
        commit: two,
        files: ['a.txt'],
      })
    );
  });

  it('pairs a pull request with a landed one by everything it landed', async () => {
    const { t, admin, repo, open, files } = await repoWithAgent(false);
    const { models, calls } = stackModels();
    await open('one', { 'x.txt': 'x\n' }, 'One');
    await commitPaths(
      repo,
      'one',
      { ...files, 'x.txt': 'x\n', 'y.txt': 'y\n' },
      'One more'
    );
    await quiet(t, models);
    const res = await call(t, '/api/repos/octocat/app/pulls/1/merge', {
      cookie: admin,
      json: { approve: true },
    });
    expect(res.status).toBe(200);
    await quiet(t, models);
    calls.triaged.length = 0;
    await open('two', { 'x.txt': 'x2\n' }, 'Two');
    await quiet(t, models);
    const pair = calls.triaged.find((i) => i.a.landed || i.b.landed)!;
    const landed = pair.a.landed ? pair.a : pair.b;
    expect(landed.summaries).toContain('x.txt');
    expect(landed.summaries).toContain('y.txt');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test worker/src/__tests__/stacking-rebase.test.ts`
Expected: the A/B/C and conflict tests PASS already (Tasks 1–5 fixed them: that is the point of rebase merging; if
any fails, stop and debug with superpowers:systematic-debugging before going on); the last test FAILS — the landed
side's summaries lack `x.txt` (its base is the landed head's first parent, `One`).

- [ ] **Step 3: The landed side is its landed range**

In `worker/src/stack/discover.ts`, add `import { pullShas } from '../lib/pulls';` and replace `addLanded` with:

```ts
const addLanded = async (l: PullRequest) => {
  // Everything it landed: from the first parent of its oldest landed commit to the landed head (or, landed
  // before rebase merging, the squash commit's first parent to its pinned head).
  const shas = await pullShas(git, l);
  if (!shas) return;
  candidates.push(candidate(await side(l, shas.head, shas.base, true)));
};
```

and in the loop below it change the comment on the containment check to
`continue; // already in this PR's history (merge_commit_sha is the landed head)`. Drop the `pullRef` import if it is
now unused.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test worker/src/__tests__/stacking-rebase.test.ts worker/src/__tests__/stacking-discovery.test.ts worker/src/__tests__/stacking-landing.test.ts`
Expected: PASS.

- [ ] **Step 5: CI and commit**

In `.github/workflows/ci.yml`, job `test-stacking`, after `worker/src/__tests__/land-target.test.ts` add
`worker/src/__tests__/stacking-rebase.test.ts`.

Run: `yarn test worker/src/__tests__/ci-workflow.test.ts && yarn typecheck`
Expected: PASS; clean.

```bash
yarn -s prettier --write worker/src/stack/discover.ts worker/src/__tests__/stacking-rebase.test.ts
git add worker/src/stack/discover.ts worker/src/__tests__/stacking-rebase.test.ts .github/workflows/ci.yml
git commit -m "Stacking: a landed prerequisite is its landed range; stacked children rebase cleanly after their parent lands" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Agents are told to reset after a rebase; docs

**Files:**

- Modify: `worker/src/mcp/pull-tools.ts` (`rebased` in `gitorange_get_pull_request`, `rebasedNote`)
- Modify: `worker/src/mcp/index.ts` (instructions)
- Modify: `worker/src/__tests__/mcp.test.ts`
- Modify: `README.md`, `docs/architecture.md`, `docs/auto-merge.md`, `CLAUDE.md`

**Interfaces:**

- Consumes: `rebased` events (Task 2); `moved`, `runRebases` (`helpers/rebase.ts`).
- Produces: `rebasedNote(branch: string, from: string, to: string): string` (`mcp/pull-tools.ts`);
  `gitorange_get_pull_request` field `rebased: { from: string; to: string; note: string } | null`.

- [ ] **Step 1: Write the failing tests**

In `worker/src/__tests__/mcp.test.ts`, in the server-instructions test (the one asserting `/^XY Space Git is/`), add:

```ts
expect(init.result.instructions).toContain(
  'run `git fetch && git reset --hard origin/<branch>` before you push again'
);
```

and in `describe('MCP pull request tools', …)` add (import `moved`, `runRebases` from `./helpers/rebase`):

```ts
it('tells the agent to reset after GitOrange rebased its branch', async () => {
  const { t, token, repo } = await repoWithBranch();
  await tool(t, token, 'gitorange_create_pull_request', {
    repository: 'octocat/app',
    head: 'feature',
    title: 'Add a',
  });
  const old = repo.refs.get('refs/heads/feature')!;
  const main = repo.refs.get('refs/heads/main')!;
  await commitPaths(
    repo,
    'main',
    { 'README.md': '# app\n', 'z.txt': 'z\n' },
    'Main moves'
  );
  await moved(t, 'main', main);
  await runRebases(t);
  const now = repo.refs.get('refs/heads/feature')!;
  const got = JSON.parse(
    (
      await tool(t, token, 'gitorange_get_pull_request', {
        repository: 'octocat/app',
        number: 1,
      })
    ).content[0].text
  );
  expect(got.rebased).toEqual({
    from: old,
    to: now,
    note: `GitOrange rebased this branch (${old.slice(0, 7)} → ${now.slice(0, 7)}); run \`git fetch && git reset --hard origin/feature\` before you push again.`,
  });
  // Once the agent pushes on top, the note goes.
  await commitPaths(
    repo,
    'feature',
    {
      'README.md': '# app\n',
      'z.txt': 'z\n',
      'src/a.ts': 'export const a = 2;\n',
    },
    'More'
  );
  const later = JSON.parse(
    (
      await tool(t, token, 'gitorange_get_pull_request', {
        repository: 'octocat/app',
        number: 1,
      })
    ).content[0].text
  );
  expect(later.rebased).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test worker/src/__tests__/mcp.test.ts`
Expected: FAIL — `got.rebased` is undefined; the instructions lack the reset line.

- [ ] **Step 3: Say it over MCP**

In `worker/src/mcp/pull-tools.ts` add `prEvents` to the schema import and:

```ts
/** What an agent must do after GitOrange rebased its branch. */
export const rebasedNote = (branch: string, from: string, to: string) =>
  `GitOrange rebased this branch (${from.slice(0, 7)} → ${to.slice(0, 7)}); run \`git fetch && git reset --hard origin/${branch}\` before you push again.`;
```

In `getPullRequest`'s handler, before the response, add:

```ts
// GitOrange rebased the branch to its current head: the agent's clone is stale until it resets.
const last = shas
  ? await ctx.db
      .select({ data: prEvents.data })
      .from(prEvents)
      .where(
        and(eq(prEvents.pullRequestId, pr.id), eq(prEvents.kind, 'rebased'))
      )
      .orderBy(desc(prEvents.createdAt))
      .limit(1)
      .get()
  : undefined;
const r = last?.data as { from?: string; to?: string } | undefined;
const rebased =
  pr.state === 'open' && r?.from && r.to && r.to === shas?.head
    ? { from: r.from, to: r.to, note: rebasedNote(pr.headRef, r.from, r.to) }
    : null;
```

and `rebased,` after `merge,` in the JSON. In the tool description, after the "whether it is up to date…" sentence
add: `' "rebased" (when set) means GitOrange rebased your branch: follow its note before pushing again.'`.

In `worker/src/mcp/index.ts`, replace `'follow its checks and agent reviews with gitorange_get_pull_request. Merging is always rebase ' + 'and merge. '`
with:

```ts
'follow its checks and agent reviews with gitorange_get_pull_request. Merging is always rebase ' +
  'and merge: GitOrange keeps every open pull request rebased onto its base itself, so after it rebases ' +
  'your branch (gitorange_get_pull_request shows "rebased"), run `git fetch && git reset --hard ' +
  'origin/<branch>` before you push again; a push of the old history is rejected as a non-fast-forward, ' +
  'never force it. ';
```

(keep the next string, `'Reviewer agents review …'`, as it is). Check the assembled sentence reads
"…before you push again; …" — the test asserts the substring
``run `git fetch && git reset --hard origin/<branch>` before you push again``, so keep that span on one source line
or join the pieces exactly as above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test worker/src/__tests__/mcp.test.ts worker/src/__tests__/mcp-moderator.test.ts`
Expected: PASS.

- [ ] **Step 5: Docs**

`CLAUDE.md`: replace the bullet starting "Merging is rebase-only (squash onto the target tip)." with:

```markdown
- Merging is rebase + fast-forward (`worker/src/merge/`, spec `docs/superpowers/specs/2026-10-07-rebase-merging-design.md`).
  GitOrange keeps open PRs rebased onto `base_ref` itself: the engine `rebase()` (`git/rebase.ts`, over `GitService`
  with `stage()`d objects) replays a PR's own commits with `mergeTrees`, skipping by ancestry and patch identity
  (`git/patch-id.ts`); a `rebase` payload on `MERGE_RESOLUTION` (`merge/rebase.ts`, started by `ensureRebase` from the
  sweep, open/reopen, retargets, `onPullClosed` and the PR page) writes the branch with CAS on the old head, keeps it as
  `refs/pull/N/pre-rebase/<sha7>`, records a `rebased` event, and pushes like a push (Actions, `startSweep`). A
  conflicting commit gets a `merge_resolutions` row (one per PR, tips and commit; `MergeResolver` DO via
  `merge/commit-resolution.ts`, `Conflicts-resolved-by` trailer); a stop shows `rebase_conflict`. A clean rebase moves
  the review and approvals to the new head (`review/carry.ts`). `landPull` is a CAS fast-forward of the land target,
  rebasing inline first when it moved (`merge_commit_sha` = landed head, `landed_commits`). Tests drive
  `executeRebase` with `runRebases`/`fakeResolver` (`__tests__/helpers/rebase.ts`).
```

`docs/architecture.md`:

- In the storage table, the "AI merge resolutions" row becomes
  `| Rebases and AI conflict resolution | **D1** (`merge_resolutions`: one row per pull request, tips and conflicting commit); rebased branches and `refs/pull/N/pre-rebase/*` in **Artifacts**; transcripts in **R2**; runs on **Workflows**, **Durable Objects** (Cloudflare Computer + Pi Durable), and **Workers AI** |`.
- Replace the section "## Merging and AI conflict resolution" (from its heading to the paragraph ending "the pull
  request then offers to try again.") with:

```markdown
## Rebasing and merging

Every pull request lands the same way: **rebase and merge**, as a fast-forward. GitOrange keeps each open pull
request rebased onto its base itself, and merging moves the target branch to the pull request's head with
compare-and-swap: no commit is made, so the target keeps every commit with its author, message and SHA, and a
concurrent push fails the merge instead of being overwritten.

**The rebase** ([`worker/src/git/rebase.ts`](../worker/src/git/rebase.ts)) replays the pull request's own commits
(merge base → head, oldest first) onto its base: `base_ref`, which is a parent pull request's branch while it is
stacked. Each commit is a three-way tree merge in the Worker (base: its parent's tree; ours: the replay so far;
theirs: the commit), merged line by line with diff3 ([node-diff3](https://github.com/bhousel/node-diff3)). A commit
keeps its author, author date and message; GitOrange is the committer. Commits the base already has are left out:
by ancestry, or by patch identity ([`patch-id.ts`](../worker/src/git/patch-id.ts): its added and removed lines,
without line numbers, context or whitespace), so a stacked child skips its parent's commits once the parent lands.
Merge commits on the branch are flattened; at most 100 commits are replayed.

**When.** A push or a landing that moves a branch starts one sweep (`MERGE_RESOLUTION` Workflow) over the open pull
requests into or out of it: it starts the agents' review and stack discovery at once, sleeps 45 seconds (so a burst
of landings ends in one rebase per pull request), then starts a `rebase` run for each pull request behind its base
([`merge/rebase.ts`](../worker/src/merge/rebase.ts)). Opening, reopening, a retarget, a parent closing
(`onPullClosed`) and viewing the pull request start one too. The run writes the rebased branch with compare-and-swap
on the old head (a push meanwhile starts it over from the new head), keeps the old head as
`refs/pull/N/pre-rebase/<sha7>`, records a `rebased` timeline event, and then acts like a push: Actions run on the
new head, and the sweep rebases pull requests stacked on the branch. Landing rebases inline when the target moved
since, and lands in the same request only if the new head needs no checks and its review carried over.

**Conflicts.** The replay stops at the first commit that conflicts. A text conflict outside generated files goes to
AI ([`merge/commit-resolution.ts`](../worker/src/merge/commit-resolution.ts)): a `MergeResolver` Durable Object
writes that commit's conflicted files, with diff3 markers, into a
[Cloudflare Computer](https://github.com/cloudflare/computer) workspace and runs a [pi](https://pi.dev) agent
([Pi Durable harness](https://developers.cloudflare.com/agents/harnesses/pi/)) on `RESOLVER_MODEL` with file tools
only, told what landed on the base and what the commit (its message and diff) and the pull request (title and
description) are for. Leftover markers send it back to work. GitOrange checks the files, stores them on the
commit's `merge_resolutions` row, and replays on; the resolved commit gets a `Conflicts-resolved-by: GitOrange AI`
trailer. At most 20 commits are resolved in one run. Binary and delete/edit conflicts, generated files (lockfiles,
migration snapshots, `.orangeignore`), too many commits, or an AI failure stop the rebase: the pull request shows
`rebase_conflict` with the commit and files, and its author or agent rebases locally.

**Reviews.** A clean rebase (nothing resolved, every replayed commit still making the same change) moves the review
of the old head, its findings and verdicts, and people's approvals to the new head
([`review/carry.ts`](../worker/src/review/carry.ts)); otherwise the new head is reviewed afresh.
```

- In "## Reviews and auto-merge", "started by the same triggers as conflict resolution" → "started by the same
  triggers as rebases"; "a proposed AI resolution" → "a rebase run's push".

`docs/auto-merge.md`:

- Lines 35–36 ("Landing works the same way from every path: squashed …") become: "Landing works the same way from
  every path: a fast-forward of the target branch to the pull request's head, after GitOrange
  [rebased it](architecture.md#rebasing-and-merging) onto the target (resolving conflicting commits with AI), so every
  commit lands with its author and message and history stays linear."
- The quoted note under it becomes: "> Checks run on the commit that lands. When the target moved since, landing
  rebases first and, if the new head runs checks, waits for them."
- In the reasons table, replace the `conflicts_unresolved` row with
  `| \`rebase_conflict\` | \`agent_followup\` | GitOrange's rebase stopped at \`commit\` (null: before any) on these \`files\` (\`error\` says why); rebase locally and push. |`,
the `resolution_running`meaning with "AI is resolving a commit's rebase conflict.", and add a row`| \`rebase_onto\` | \`waiting\` | Stacked on \`pr\` without its commits yet: GitOrange is rebasing it onto \`branch\`. |`.
- The paragraph "Conflict reasons (`conflicts_unresolved`, `resolution_running`) come from AI conflict resolution, …"
  becomes: "Rebase reasons (`rebase_conflict`, `resolution_running`) come from GitOrange's rebase runs, including
  conflicts AI doesn't take (binary files, a file deleted on one side and changed on the other, generated files).
  Without the `MERGE_RESOLUTION` Workflow binding no rebase runs in the background: the merge box shows whether
  landing's rebase would conflict, and there is no rebase reason. Likewise, without AI review configured, there is no
  `agent_reviewing` or `stack_checking` reason, since no review or stack check will ever run."
- Line 257: "`must_account_for` (…) and `rebase_onto` call for the author's move (`agent_followup`)" →
  "`must_account_for` (…) calls for the author's move (`agent_followup`), `rebase_onto` waits on GitOrange's rebase".

`README.md`:

- Step 7 (line 72): "If `main` moved and the change now conflicts, a Pi agent resolves the conflict first." →
  "GitOrange keeps it rebased onto `main` itself, and landing is a fast-forward: every commit keeps its author,
  message and SHA. A commit that conflicts is resolved by a Pi agent first."
- "Reviews, conflict resolutions, and discovery runs" (line 77) → "Reviews, rebases, and discovery runs".
- The "**Conflict handling.**" paragraph becomes: "**Rebasing and conflicts.** GitOrange rebases every open pull
  request onto its base itself, replaying its commits and skipping the ones the base already has, so a stacked
  pull request rebases cleanly once its parent lands. Files are merged line by line, so only truly overlapping
  edits conflict; each conflicting commit goes to a Pi agent in a
  [Cloudflare Computer](https://github.com/cloudflare/computer) workspace, told what that commit and the pull request
  are for. A burst of landings ends in one rebase per pull request. Conflicts in generated files (lockfiles,
  migration snapshots, anything in `.orangeignore`) are left to the pull request's author or agent. Collisions
  between open pull requests are found before either lands."
- In "A work queue", `` `conflicts_unresolved` `` → `` `rebase_conflict` with the commit and files ``.
- In the limitations list, delete the bullet "**Auto-merge tests the pull request's own commit, not the rebased
  result.** …" (landing now checks the commit that lands), and "**AI resolves text conflicts only.**" → "**AI
  resolves text conflicts only.** Binary files, a file deleted on one side but changed on the other, and generated
  files are left to the pull request's agent to rebase locally."
- Anywhere else, "squash" → describe the fast-forward (`grep -n -i squash README.md docs/*.md` must print nothing
  but the migration history mention in `docs/architecture.md`, if any).

- [ ] **Step 6: Format and commit**

Run: `yarn format && yarn typecheck && grep -rn -i "squash" README.md docs/architecture.md docs/auto-merge.md CLAUDE.md worker/src/mcp`
Expected: clean; grep prints nothing (or only intentional history notes).

```bash
git add -A README.md docs/architecture.md docs/auto-merge.md CLAUDE.md worker/src/mcp worker/src/__tests__/mcp.test.ts
git commit -m "MCP and docs: GitOrange rebases branches itself; agents reset after a rebase" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Finishing

- [ ] Run the whole definition of done: `yarn test`, `yarn typecheck`, `yarn format` (commit any formatting).
- [ ] `grep -rn "planMerge" worker/src` lists only `git/service.ts` and `stack/discover.ts` (stacking's textual
      check); `grep -rn "refs/resolutions\|squashCredits\|executeResolution\|conflicts_unresolved" worker/src src`
      prints nothing.
- [ ] Hand the branch back for review per CLAUDE.md (push `rebase-merging` to `origin`, open the pull request with
      `gitorange_create_pull_request`, follow it with `gitorange_get_pull_request`). Never deploy. Deploy notes for
      the PR description: run `yarn db:migrate:prod` **after** the code deploy (`0024` adds columns; `0025` cancels
      squash-era resolutions still queued, running or proposed); in-flight squash-era Workflow instances do nothing;
      no new bindings or vars.
