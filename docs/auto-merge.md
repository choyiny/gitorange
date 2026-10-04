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
   an **Approve** button per flag. Anyone who can merge (including the pull request's author) approves. New
   commits start a fresh review; earlier approvals don't carry over. The comment stays after the pull request
   merges, as a record of who approved what.

Everything waiting on you, across every repository you can merge in, is on the **Approvals** page (the
shield in the header shows how many): flags to approve, failed reviews to retry, and conflicts AI couldn't
resolve. Pages update live as reviews progress, flags are approved, and pull requests merge.

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

## Cost

Per reviewed commit: one GLM-5.3-flash call per changed file (8 at a time), one Clef call, and one GLM-5.3
call per flag, all on [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/). A
typical small pull request reviews in a few seconds; investigating flags takes up to a minute or two.
