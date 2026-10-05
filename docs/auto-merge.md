# Auto-merge

A repository can let pull requests merge on their own: no one clicks **Rebase and merge** for a change that
passed its checks and that nothing in the repository's review rules says a person must read. Changes that do
need a person (a schema migration, an auth change) wait for someone with merge permission to approve each
thing that was flagged, and then merge on their own.

Auto-merge is **opt-in per repository**: it's on when the target branch has a `.gitorange/review.yml`. It's
read from the target branch (e.g. `main`), never from the pull request, so a pull request can't loosen its own
rules.

## When a pull request merges on its own

All of these must hold for the pull request's latest commit:

1. **Nothing is flagged, or every flag is approved.** See [How a change is reviewed](#how-a-change-is-reviewed).
2. **Checks passed.** By default, every Actions run for the commit succeeded and at least one ran
   (`checks.require`).
3. **It merges.** Either cleanly, or after [AI resolved its conflicts](architecture.md#merging-and-ai-conflict-resolution).

It merges the same way the button does: squashed onto the target branch's current tip, so history stays
linear. The commit is authored as the pull request's author; the pull request shows **Auto-merge merged
commit …**. A maintainer can turn auto-merge off (and back on) for one pull request in its merge box.
Afterwards GitOrange deletes the pull request's branch, unless someone pushed to it since, it's the default
branch, or another open pull request builds on it (as its base or head); a merge by hand keeps the branch.

> Checks run on the pull request's own commit, not on the result rebased onto the latest target branch. If the
> target branch moved in between, the merged result as a whole was never tested.

## How a change is reviewed

Every new commit on a pull request is reviewed once (again if `review.yml` changes):

1. **One line per changed file.** GLM-5.3-flash (`SUMMARY_MODEL`) reads each file's diff and writes one
   plain sentence about what changed, saying explicitly when it touches stored data, permissions or auth, or a
   public interface. Lockfiles, binary files, and submodules get a fixed line without a model. A file too large
   to summarize (or whose summary fails) is flagged.
2. **Classify.** [Clef](https://developers.cloudflare.com/workers-ai/models/), a decision model on Workers
   AI, answers the questions in `review.yml` from the pull request's title, description, and those one-liners.
   It never sees raw diffs, so nothing has to be truncated however large the pull request is.
3. **Flag.** Each answer past its threshold is a flag. Every flag comes from the AI's answers; there are no
   hand-written file rules.
4. **Investigate.** For each flag, GLM-5.3 (`REVIEW_MODEL`) reads every diff and explains what caused it,
   the concrete risk, and what to check. It draws the change when a picture helps, as a
   [Mermaid](https://mermaid.js.org) diagram: an ER diagram of the affected tables for data-model changes, a
   sequence or flow diagram for auth and request handling. It also points at the lines worth reading; GitOrange
   shows those as expandable excerpts taken from the actual diff, never from the model's own text.
5. **Approve.** The review appears in the pull request's conversation as a comment from **Auto-merge**, with
   **Approve** and **Request changes** buttons per flag. Anyone who can merge (including the pull request's
   author) approves or requests changes, with an optional short note. A flag with changes requested keeps
   blocking auto-merge until someone approves it, which clears the request; an approved flag can't have
   changes requested. New commits start a fresh review; earlier approvals and requests don't carry over. The
   comment stays after the pull request merges, as a record of who approved what.

Everything waiting on you, across every repository you can merge in, is on the **Approvals** page (the
shield in the header shows how many): flags to approve (or that have changes requested), failed reviews to retry, and conflicts AI couldn't
resolve. Pages update live as reviews progress, flags are approved, and pull requests merge. The page lists the most
recently updated pull requests first, 25 at a time (**Load more** for the rest); `GET /api/approvals?limit=&cursor=`
returns one page as `{ items, count, nextCursor }`, where `count` covers every page.

If a model can't be reached, the review fails and the pull request says so, with a button to try again; it
doesn't merge on its own until a review succeeds. You can always merge it by hand.

## `.gitorange/review.yml`

```yaml
# .gitorange/review.yml — read from the target branch.
model: clef # clef (27B) or clef-flash (9B, faster and cheaper)

checks:
  require: all # all: every Actions run passed (at least one ran) · none: don't wait for checks
  # require: [test, typecheck]   # or only these jobs (by job id or name)

limits:
  max_files: 100 # more changed files than this: flagged instead of reviewed

human_review:
  questions:
    # Yes/no: flagged when the probability of "yes" is above `above`.
    data_model:
      ask: >
        Does this change alter how data is stored: a database table or column, a migration, an index,
        or a stored format existing data must be converted for?
      yes: Existing or future stored data is affected. # optional: what yes means
      no: Only code paths change; stored data keeps its shape.
      above: 0.3

    security:
      ask: Does this change touch authentication, authorization, secrets, or cryptography?
      above: 0.2

    removes_functionality:
      ask: >
        Does this change remove or disable existing user-visible functionality, an API endpoint, or a
        configuration option, rather than refactoring it or replacing it with an equivalent?
      yes: Something users could do before can no longer be done.
      no: Nothing is taken away; behavior is kept or replaced by an equivalent.
      above: 0.3

    # Choice: flagged when the chosen option is listed in `flag`, with at least `min_confidence`.
    kind:
      ask: What kind of change is this, mostly?
      options:
        docs: Documentation, comments, or README only.
        tests: Tests only.
        fix: A bug fix that doesn't change intended behavior.
        feature: New user-visible behavior.
        infra: Build, CI, deployment, or dependency changes.
      flag: [infra]
      min_confidence: 0.5

    # Score: flagged when the score (levels numbered from 0) reaches `at_least`.
    risk:
      ask: How risky is it to ship this change without a person reading it?
      levels:
        - Trivial. Docs, comments, test-only, or formatting.
        - Low. Small, local change with obvious behavior.
        - Moderate. Touches shared code or behavior tests may not cover.
        - High. Broad, subtle, or hard to undo.
      at_least: 2
```

A question's kind follows from its fields: `above` (yes/no), `options` (choice), or `levels` (score). Ids may
use letters, digits, `_`, `.`, and `-`; up to 64 questions. An invalid file fails every review in the
repository with the error shown on each pull request, so nothing merges on its own until it's fixed.

**Questions see one-line summaries, not diffs.** A summary that leaves something out can't be flagged, so
ask about what must never slip through in plain terms ("does this change how data is stored?"): the
summarizer is told to mention stored data, permissions, and public interfaces explicitly. Older files with
`human_review.paths` fail with a message saying to remove it.

## `.orangeignore`

Files the review leaves out, in `.gitignore` syntax, at the repository root: generated code, vendored files, snapshots. Like `review.yml`, it's read from the **target branch**, so a pull request can't hide its own files; a change to `.orangeignore` applies to pull requests opened after it merges.

An ignored file still counts as changed and is listed with a fixed one-liner, so a question about it can still be flagged; it just isn't summarized by a model, read by the investigator, or quoted. Lockfiles are always ignored.

```gitignore
# Generated by `yarn cf-typegen`
worker/worker-configuration.d.ts
# Migration snapshots (the .sql migration itself is still reviewed)
migrations/meta/
```

## Pull request states

Every open pull request has one state that says whose move it is. It is computed when read (never stored), with the reasons behind it.

| State                                       | Whose move                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `agent_followup` (Ready for agent followup) | The author's agent: push a fix for each reason.                                                 |
| `human_review` (Requires human review)      | A person: review, approve, or decide.                                                           |
| `waiting` (Waiting for checks)              | Nobody yet: something is still running.                                                         |
| `ready` (Ready)                             | Nothing blocks it. Shown as "Ready, stacked on #N" when it builds on another open pull request. |

When several reasons apply, the most urgent state wins: `agent_followup`, then `human_review`, then `waiting`, then `ready`. Reasons are listed in that order too.

Each reason has a `kind` and its own fields:

| Reason                  | State                              | Meaning                                                                                                                                                                |
| ----------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check_failed`          | `agent_followup`                   | A required Actions check failed (`run_number`, and `check` when review.yml names it).                                                                                  |
| `changes_requested`     | `agent_followup`                   | A reviewer requested changes on this many flags.                                                                                                                       |
| `conflicts_unresolved`  | `agent_followup`                   | The AI resolution was rejected or failed; the conflicting `files` need a fix from the author.                                                                          |
| `review_policy_invalid` | `agent_followup` or `human_review` | `review.yml` doesn't parse. In this pull request's own change (`where: pull_request`) it is the author's to fix; on the target branch (`where: target`) a person must. |
| `review_failed`         | `human_review`                     | The auto-merge review failed to run.                                                                                                                                   |
| `flags_pending`         | `human_review`                     | Review flags are waiting for approval.                                                                                                                                 |
| `cycle`                 | `human_review`                     | This pull request is in a stack cycle with the listed pull requests.                                                                                                   |
| `checks_running`        | `waiting`                          | Required checks are running, or haven't started (`started: false`).                                                                                                    |
| `review_running`        | `waiting`                          | The auto-merge review hasn't finished.                                                                                                                                 |
| `resolution_running`    | `waiting`                          | An AI conflict resolution is queued or running.                                                                                                                        |
| `stack_checking`        | `waiting`                          | Stack discovery is still comparing it with other pull requests.                                                                                                        |
| `must_account_for`      | none                               | Another pull request changes code this one depends on (`pr`, `landed`, `instructions`).                                                                                |
| `stacked_on`            | none                               | This pull request builds on `pr`.                                                                                                                                      |
| `waits_on`              | none                               | It should land after `pr`.                                                                                                                                             |

`must_account_for` is shown for information: it doesn't change the state yet.

Conflict reasons (`conflicts_unresolved`, `resolution_running`) come from AI conflict resolution, including conflicts it can't take on (binary files, or a file deleted on one side and changed on the other), which are `conflicts_unresolved` too. Without AI conflict resolution configured there is no conflict reason; the merge box still shows the conflicts. Likewise, without AI review configured (the `MERGE_RESOLUTION` Workflow binding), there is no `review_running` or `stack_checking` reason, since no review or stack check will ever run.

Checks count the same way as for auto-merge. With a `review.yml` on the target branch, `checks.require` decides: `none` ignores checks, `all` also waits for a first run, a list waits for those jobs. Without one, any run at the head commit counts: a failed run is `check_failed`, an unfinished one is `checks_running`, and no run at all is not a reason. As on the commit's checks badge, only the latest run of each workflow and event counts (a re-run replaces the run it repeats), and only failed or cancelled runs and jobs fail; skipped ones don't, except a required job skipped in a run that failed or was cancelled (Actions skips a job when a job it needs failed), which fails; while that run is still going, such a job counts as running.

States exist for every open pull request, with or without `review.yml`. Without it there is no review, so no review or flag reasons. The stack reasons (`cycle`, `stack_checking`, `must_account_for`, `stacked_on`, `waits_on`) come from [stacking](#stacking), which always runs, with or without `review.yml`.

Where to see them:

- The Pull requests list shows the state on each row. Filter it with `?state=agent_followup` (or `human_review`, `waiting`, `ready`) on `GET /api/repos/:owner/:repo/pulls`; each row has `pullState`. The tree, the merge box, and PR detail show it too.
- The Approvals page lists pull requests whose latest recorded state is `human_review`.
- Over MCP, `gitorange_list_pull_requests` returns `pull_state`, and `state: "agent_followup"` lists the open pull requests that need an agent. `gitorange_get_pull_request` returns `pull_state` and `reasons`.
- State changes are recorded and appear on the timeline of the pull request, with the reasons at that moment.

## Stacking

When several agents open pull requests at once, they often touch the same code. Stacking works out how open pull requests into the same branch relate and shows the result as a tree. Today it only shows relationships: nothing is retargeted, blocked, or reordered.

It's always on, whenever AI is configured, with or without a `.gitorange/review.yml`. The file's optional `stacking:` section only tunes it (these are the defaults):

```yaml
stacking:
  max_open: 20 # check a pull request against this many open ones; beyond it, only those sharing a file
  related_above: 0.3 # Clef's "could these depend on each other?" probability above which a pair is related
  confident_above: 0.6 # from this confidence Clef's kind and direction stand without the reasoning model
```

Clef uses the file's top-level `model` (`clef` without a valid `review.yml`). `stacking.enabled`, which used to turn stacking on, is no longer used: it's accepted and ignored, so `enabled: false` doesn't turn it off.

**How a pair is checked.** With a `review.yml` on the target branch, a `stack` run starts when a pull request's review finishes (or fails); without one (or with an invalid one), when the pull request is opened. In both cases it also starts when the conflict sweep sees a branch move. It pairs the pull request with the other open pull requests into the same target (newest first) and with pull requests that landed there in the last 30 days and aren't in its history. For each pair:

1. A textual check merges the two heads and notes which files conflict.
2. Clef decides over the one-line summaries from the review (file paths when there are none, or no review): are they related, which kind, and which goes first.
3. For related pairs, GLM-5.3 reads the diffs and writes the reason and, where needed, instructions for the author. It also decides the kind and direction, but only when Clef was unsure.

A pair is saved only for the commits the run started from, so a push mid-run can't leave a stale answer. A pair that can't be checked shows as "Couldn't check against #N"; the retry button is in that pull request's **Stack** section (the Tree view only shows the label).

**The four kinds.**

- **Builds on:** #31 adds a `parseConfig` helper and #32 calls it. #32 builds on #31.
- **Must account for:** #28 renames `getUser` to `fetchUser`, and #29 adds a new call to `getUser`. They merge cleanly, but #29 must change to use `fetchUser`. The pull request shows instructions for its author.
- **Conflicts:** #40 and #41 both rewrite the same function differently. One has to go first, and the other has to be redone on top of it.
- **Independent:** #50 edits the docs and #51 fixes a bug elsewhere. Neither waits on the other. Independent pairs are recorded so they aren't checked again, but they aren't drawn.

The **Tree** view on the Pull requests tab shows open pull requests with their builds-on, must-account-for, and conflict relationships, each pull request's **Stack** section lists its own relationships, and agents read both over MCP (`gitorange_get_pull_tree`, and `stack` on `gitorange_get_pull_request`). Closed-unmerged pull requests are ignored. While checks are still running, a pull request shows "checking…" (no check has started for its latest commit yet; `checking` in the API and MCP) or "checking #N…" (that pair is in progress; `pending`), and isn't called independent until they finish. With nothing open, the Tree view says "No open pull requests".

**Cost.** Per PR head change, one Clef call per open PR into the same target and per landed candidate (up to 20 pull requests landed in the last 30 days), skipped for pairs already checked at the same commits, plus one GLM-5.3 call per related or conflicting pair.

## Cost

Per reviewed commit: one GLM-5.3-flash call per changed file (8 at a time), one Clef call, and one GLM-5.3
call per flag, all on [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/). A
typical small pull request reviews in a few seconds; investigating flags takes up to a minute or two.
