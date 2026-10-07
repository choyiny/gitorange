# Reviewer agents, auto-merge, states and stacking

Every review concern in GitOrange is a **reviewer agent**: an account like a person (`@securityagent`,
`@dataagent`), with a profile and its own repository that says who it is and how it reviews. Repositories invite
agents in **Settings → Agents**. On every new commit of a pull request, each invited agent decides whether the
change concerns it; the ones that do review it. No pull request lands without a review from an agent or a person.

## When a pull request lands

By the merge button, the MCP merge tool, or on its own (auto-merge), a pull request lands only when all of these
hold for its current head commit:

- **Checks pass:** no failed or cancelled latest Actions run, and none still running (no run at all is fine).
- **The stack gate is clear** (see [Stacking](#stacking)).
- **Review is satisfied:** every agent requested for this commit approved it, or a person approved each of its
  findings that needs a person and every change it requested was made (a new commit) or dismissed; or, when no
  agent was requested, a person approved the commit.

All three share one gate, checked in that order: the stack gate, then checks, then review.

A person with merge permission (the pull request's author included) can **Approve** any pull request's head
commit. That satisfies review past findings for a person and failed or unfinished agent reviews — the timeline
records what the approval was given over, and when it is withdrawn — but never past an agent's open change request: dismiss it, or push a
new commit, first. The merge box offers **Approve and merge** when review isn't satisfied yet. An approval is for
one commit: the page sends the commit you saw, and if the branch moved since, the approval is refused (`409`) so
you can look again. A new commit needs new reviews and a new approval. There is no way past review without a
recorded review or approval, and agents can't approve over MCP except through an app the user marked as a moderator
(Settings → MCP server → Connected apps), which approves as that user, recorded "via" the app.

**Auto-merge** is on in every repository with at least one invited agent: a pull request lands on its own as soon
as the conditions hold, with no merging user, and its branch is deleted unless another open pull request builds
on it. A maintainer can turn it off per pull request. A repository without agents is an ordinary code host: a
person approves and merges.

Landing works the same way from every path: squashed onto the target branch's current tip, so history stays
linear, after [AI resolves any conflicts](architecture.md#merging-and-ai-conflict-resolution).

> Checks run on the pull request's own commit, not on the result rebased onto the latest target branch. If the
> target branch moved in between, the merged result as a whole was never tested.

## How a commit is reviewed

1. **Summaries.** GLM-5.3-flash writes one line per changed file (the first 300 files; lockfiles and
   [`.orangeignore`](#orangeignore) matches get fixed text without a model call). With more than 5,000 changed
   files (or more than 512 KB of paths beyond the first 300) nothing is reviewed: the review fails and a person
   must approve.
2. **Trigger.** One Clef call asks every invited agent's `trigger.ask` over those summaries (never the diff). An
   agent is **requested** when Clef's probability is at or above its `trigger.above`; otherwise it is **not
   needed**, with the probability shown. If Clef fails or doesn't answer for an agent, that agent is requested
   (unsure means review). An agent whose `AGENT.md` is invalid on its default branch fails at once, with the parse
   error.
3. **Review.** Each requested agent reviews at its repository's current default-branch commit (shown as a link
   on its review). An `engine: pass` agent makes one GLM-5.3 call with its `AGENT.md` instructions, its
   `knowledge/*.md` (at most 20 files and 64 KB, in path order; the rest are listed by path), the summaries, and the diff (24 KB per file, 120 KB in all;
   files beyond that are listed by path). Pull request text and diffs are data, never instructions: they go inside
   one tag whose name carries a random suffix, so they can't forge the prompt around them. It answers
   **approve**, or up to five **findings**, each with a sentence, a before/after table, a diagram and excerpts cut
   from the real diff:
   - `needs_person`: a person approves it, or requests changes on it (the pull request's agent then follows up);
   - `change_requested`: the agent is sure what must change. It goes to the pull request's agent, and a new commit
     resolves it (the new commit is reviewed afresh); a person may also **Dismiss** it.

   An `engine: pi` agent gets the same input as a durable [Pi](https://pi.dev) agent in a [Cloudflare
   Computer](https://github.com/cloudflare/computer) workspace, with the pull request's repository checked out at
   the head commit under `/repo` (text files only: the changed files first, then the rest, up to 3,000 files and 24
   MB, at most 512 KB each; lockfiles, `.orangeignore` matches, binary files, symlinks and submodules stay out, and
   `/review/not-checked-out.txt` lists what was left out). It reads callers, tests and anything else the diff
   doesn't show with read-only tools (read, ls, find, grep), each confined to `/repo` and `/review`: no shell, no
   network, no writes, and nothing it does can change the pull request. Everything the tools return is fenced as
   untrusted data like the pull request. It answers in the same form as the single pass, read by the same parser,
   and its findings are the same; an answer that can't be read goes back to it, twice at most. A Pi review has 30
   minutes, 60 tool calls, and about 80 model calls or 4,000,000 input tokens by default. Past its tool calls it is
   told to answer with what it has; past its time or model budget it fails (Retry runs it again). The model budget
   is approximate: a compaction counts as a model call but its tokens aren't counted, and the request that crosses
   the token limit has already been sent, so a review can overshoot by about one context. Site admins change
   these limits under **Site admin → Settings → Reviews** (at most 60 minutes), and the model under **AI models →
   Agent deep review model** (by default the same model as the agent review model); a review keeps the values it
   started with. It stops early when the pull request closes (failed, so Retry can review it again after a
   reopen), when a new commit replaces the head (not needed: the new commit is reviewed afresh), or when the agent
   is removed. Its transcript is never kept: the workspace is deleted when the review ends, or 15 minutes after
   its time limit if nothing stopped it. Where the deployment has no `AGENT_REVIEWER` binding, `engine: pi` agents
   review as a single pass and their review says so.

4. **Outcome.** Each requested agent ends `approved`, `flagged` (findings for a person), `changes_requested`, or
   `failed` (its review model failed twice more after the first try, or its `AGENT.md` is invalid; for a Pi review,
   Pi gave up after its own retries, ran out of time or budget, or answered in a form that couldn't be read after
   being asked twice). **Retry** on a failed agent reviews again at its current commit. A review (or an agent's
   Retry) still in progress 2 hours after it started was cut off: it is stopped as failed ("The review stopped
   unexpectedly. Try again.") when the commit is next looked at, or by the daily retention job, and Retry starts it
   again.

An agent removed from the repository mid-review is cancelled and stops counting, as are the finished reviews of an
agent no longer invited. Each review runs as a `MERGE_RESOLUTION` Workflow and shows under **Actions → Agent**,
with one step per agent ("Review by @securityagent", decided "Approved" or "2 findings: …"). A Pi review shows its
start ("Started a Pi review"), each check ("Pi review by @securityagent": "Running: 4 turns, 9 tool calls, 3 min"),
and its end with what it spent.

Everything waiting on you, across every repository you can merge in, is on the **Approvals** page (the shield in
the header shows how many): agents' findings for a person, grouped by agent, failed agent reviews, pull requests
that need a person's approval, and conflicts AI couldn't resolve. Pages update live as reviews progress. `GET
/api/approvals?limit=&cursor=` returns one page as `{ items, count, nextCursor }`, where `count` covers every page.

An old `.gitorange/review.yml` does nothing: invite reviewer agents instead.

## Writing an agent

Site admins create agents in **Site admin → Agents**; each gets a repository `<handle>/<handle>` with a starter
`AGENT.md`. Its frontmatter says when it reviews; its body says how:

```yaml
---
name: Security Agent
bio: Reviews changes to authentication, authorization and secrets.
trigger:
  ask: Does this change touch authentication, authorization, sessions, tokens or secrets?
  above: 0.3
engine: pass
---
(what this agent cares about, how it judges, and what is worth a finding)
```

`engine: pass` (the default) reviews in one model call over the diff. `engine: pi` reviews with a Pi agent that can
also read the rest of the repository at the head commit: slower and costlier, for agents whose judgement needs
context beyond the diff (callers of a changed function, the schema a query runs against).

Edit an agent like any code: open a pull request on its repository. Reviews always read the agent at its default
branch, so a pull request that changes an agent never reviews itself with its own changes. A repository invites at
most 10 agents.

## How agents learn

Dismissing an agent's change request tells it it was wrong. When the pull request closes — merged or not — each
agent with dismissed change requests on it gets one lesson: a Pi run over its own repository that looks for the
general reason (a pattern it misjudges, context it lacks, an instruction too broad) and makes the smallest edit to
the instructions in `AGENT.md` or to `knowledge/` that stops similar false positives. If the dismissals were
one-offs, it changes nothing and says why. It never changes the front matter (name, bio, trigger, engine).

The edit is committed straight to the agent's default branch, as the agent, with a message naming the pull request,
the dismissed findings, and one `Dismissed-Finding:` trailer each. There is no review step: undo it like any commit
(revert it, or edit `AGENT.md`). The agent's profile lists its lessons, the pull request's timeline says "@agent
learned from N dismissed findings", and the run is in the Actions tab under **Agent**. An agent learns one lesson at
a time; limits are in **Site admin → Settings** (Reviews).

An agent is shared by every repository that invites it, so a dismissal in one repository can change how it reviews in
the others; its learned edits are unreviewed commits, reverted like any commit. Every member can read an agent's
repository, so lessons from private repositories are redacted there: the commit message is only the summary and the
trailers, and the learner is told to write general lessons without the pull request's code, paths or names.

## `.orangeignore`

Files the review leaves out, in `.gitignore` syntax, at the repository root: generated code, vendored files, snapshots. It's read from the **target branch**, so a pull request can't hide its own files; a change to `.orangeignore` applies to pull requests opened after it merges.

An ignored file still counts as changed and is listed with a fixed one-liner, so an agent's trigger still sees it; it just isn't summarized by a model, shown to a reviewing agent, or quoted. Lockfiles are always ignored.

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

| Reason                    | State            | Meaning                                                                                                                         |
| ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `check_failed`            | `agent_followup` | An Actions check failed (`run_number`).                                                                                         |
| `agent_changes_requested` | `agent_followup` | An agent requested changes (`agent`, and each change's `id`, `title`, `detail`). Push a fix; the new commit is reviewed afresh. |
| `changes_requested`       | `agent_followup` | A person requested changes on this many findings.                                                                               |
| `conflicts_unresolved`    | `agent_followup` | The AI resolution was rejected or failed; the conflicting `files` need a fix from the author.                                   |
| `agent_flagged`           | `human_review`   | An agent's findings wait for a person (`agent`, `flags`).                                                                       |
| `agent_review_failed`     | `human_review`   | An agent's review failed (`agent`, `error`; `agent` is null when the whole review failed): fix the agent, Retry, or remove it.  |
| `needs_approval`          | `human_review`   | No agent was requested for this commit: a person approves it.                                                                   |
| `cycle`                   | `human_review`   | This pull request is in a stack cycle with the listed pull requests.                                                            |
| `checks_running`          | `waiting`        | Required checks are running, or haven't started (`started: false`).                                                             |
| `agent_reviewing`         | `waiting`        | An agent (`agent`; null before any is requested) hasn't finished.                                                               |
| `resolution_running`      | `waiting`        | An AI conflict resolution is queued or running.                                                                                 |
| `stack_checking`          | `waiting`        | Stack discovery is still comparing it with other pull requests.                                                                 |
| `must_account_for`        | none             | Another pull request changes code this one depends on (`pr`, `landed`, `instructions`).                                         |
| `stacked_on`              | none             | This pull request builds on `pr`.                                                                                               |
| `waits_on`                | none             | It should land after `pr`.                                                                                                      |

`must_account_for` is shown for information: it doesn't change the state yet.

Conflict reasons (`conflicts_unresolved`, `resolution_running`) come from AI conflict resolution, including conflicts it can't take on (binary files, or a file deleted on one side and changed on the other), which are `conflicts_unresolved` too. Without AI conflict resolution configured there is no conflict reason; the merge box still shows the conflicts. Likewise, without AI review configured (the `MERGE_RESOLUTION` Workflow binding), there is no `agent_reviewing` or `stack_checking` reason, since no review or stack check will ever run.

Checks count the same way as for landing: a failed or cancelled latest run is `check_failed`, an unfinished one is `checks_running`, and no run at all is not a reason. As on the commit's checks badge, only the latest run of each workflow and event counts (a re-run replaces the run it repeats).

States exist for every open pull request. Without invited agents, an unapproved pull request is `human_review` with `needs_approval`. The stack reasons (`cycle`, `stack_checking`, `must_account_for`, `stacked_on`, `waits_on`) come from [stacking](#stacking), which always runs.

Where to see them:

- The Pull requests list shows the state on each row. Filter it with `?state=agent_followup` (or `human_review`, `waiting`, `ready`) on `GET /api/repos/:owner/:repo/pulls`; each row has `pullState`. The tree, the merge box, and PR detail show it too.
- The Approvals page lists agents' findings for a person (grouped by agent), failed agent reviews, pull requests that need a person's approval, and pull requests whose latest recorded state is `human_review`.
- Over MCP, `gitorange_list_pull_requests` returns `pull_state`, and `state: "agent_followup"` lists the open pull requests that need an agent. `gitorange_get_pull_request` returns `pull_state` and `reasons`.
- State changes are recorded and appear on the timeline of the pull request, with the reasons at that moment.

## Stacking

When several agents open pull requests at once, they often touch the same code. Stacking works out how open pull requests into the same branch relate and shows the result as a tree. It then acts on what it finds: it retargets stacked pull requests onto their parent, puts several prerequisites in one line, and holds back a pull request that must change for another (see [Retargeting](#retargeting-and-blocking)).

It's always on, whenever AI is configured, with built-in tuning: a pull request is checked against the 20 newest open ones (beyond that, only those sharing a file); a pair is related from Clef's probability 0.3; Clef's kind and direction stand from confidence 0.6.

**How a pair is checked.** Where agents review the repository, a `stack` run starts when a pull request's review finishes (or fails); elsewhere, when the pull request is opened. In both cases it also starts when the conflict sweep sees a branch move. It pairs the pull request with the other open pull requests into the same target (newest first) and with pull requests that landed there in the last 30 days and aren't in its history, plus any landed pull request it still has to account for (whatever its age, and even once its history contains it). For each pair:

1. A textual check merges the two heads and notes which files conflict.
2. Clef decides over the one-line summaries from the review (file paths when there are none, or no review): are they related, which kind, and which goes first.
3. For related pairs, GLM-5.3 reads the diffs and writes the reason and, where needed, instructions for the author. It also decides the kind and direction, but only when Clef was unsure.

A pair is saved only for the commits the run started from, so a push mid-run can't leave a stale answer. A pair that can't be checked shows as "Couldn't check against #N"; the retry button is in that pull request's **Stack** section (the Graph view doesn't show it). A pair still being checked 30 minutes after its run claimed it belongs to a run that died: the next run checks it again, and the retry button resets it.

**The four kinds.**

- **Builds on:** #31 adds a `parseConfig` helper and #32 calls it. #32 builds on #31.
- **Must account for:** #28 renames `getUser` to `fetchUser`, and #29 adds a new call to `getUser`. They merge cleanly, but #29 must change to use `fetchUser`. The pull request shows instructions for its author.
- **Conflicts:** #40 and #41 both rewrite the same function differently. One has to go first, and the other has to be redone on top of it.
- **Independent:** #50 edits the docs and #51 fixes a bug elsewhere. Neither waits on the other. Independent pairs are recorded so they aren't checked again, but they aren't drawn.

The **Graph** view on the Pull requests tab draws how open pull requests are slated to land, one Mermaid flowchart per land target: each open pull request is a node with its whole title and, beneath it, its status as the list shows it (the state and its first reason), coloured by that state (click it to open the pull request; hover it for its title, branch, author, state and reasons, and each dependency with its reason), and arrows point at what lands first: solid for stacked on, dashed for waits on, dotted for lands after (an ordering edge), and red for must change for (a merged pull request gets its own node). A pull request with nothing ahead of it points into its land target, so each graph flows down into the branch; pull requests in a cycle are outlined in red under a note. Each pull request's **Stack** section lists its own relationships, and agents read the same data over MCP (`gitorange_get_pull_tree`, and `stack` on `gitorange_get_pull_request`). Closed-unmerged pull requests are ignored. While checks are still running, a pull request's Stack section shows "checking…" (no check has started for its latest commit yet; `checking` in the API and MCP) or "checking #N…" (that pair is in progress; `pending`), and isn't called independent until they finish. Each target's header lists the pull requests that recently landed into it. With nothing open, the Graph view says "Nothing is slated to land."

### Retargeting and blocking

After discovery, a `reconcile` run (also started when a pull request closes or lands) settles each target branch's stacks. Like discovery, retargeting and the stack gate apply to every repository; a maintainer who disagrees with a relationship can Unstack or Dismiss it (below).

**Retargeting.** A pull request that builds on another open one is _stacked_ on it: its base becomes the parent's branch, so its diff shows only its own change. Its **land target** stays the branch it will finally land on. A stacked pull request lands on the land target once its parent has. Retargeting only changes pull request metadata (the base shown, the diff, a `stacked` timeline event); GitOrange never pushes to a branch. When the parent closes or lands, its children go back to the land target at once, and the run restacks what is left. A parent is the strongest stackable prerequisite (must account for, then builds on, then an order from linearizing) whose own line already includes the other prerequisites; a pull request with no such prerequisite stays on the land target. If a stacked pull request's head doesn't contain its parent's yet, its state says to rebase onto the parent's branch first (nothing is asked when GitOrange can't tell).

**Linearizing several prerequisites.** A pull request has one parent, so when it builds on or must account for several open pull requests, GitOrange puts them in one line. If #31 builds on #28 and #29, and #28 and #29 are otherwise unrelated, one of them must land first: say #29 lands after #28, and #31 stacks on #29. An existing relationship between the two decides it (a conflict sets which lands first; the ordering edge is still added, since a conflict alone doesn't stack one on the other). Otherwise Clef reads both and says which is easier to build on; if it isn't confident enough (below 0.6) or fails, the one closer to Ready goes first, then the lower number. The choice is saved as an ordering edge (kind `ordered_after`), recorded on the timeline as an `ordered` event, and dropped when any of the three pull requests' heads moves (the two it orders and the one it was added for), or one of them closes or lands. An order that would make a cycle is never added: that pull request waits on its prerequisites instead.

**Must account for.** A pull request that must change for another gets the reason and instructions for its author on its timeline. It can't merge until it does. When the dependent gets a new commit and the prerequisite hasn't moved, GLM-5.3 re-checks the dependent's new head against the prerequisite (open or landed) and either marks it accounted for (an `accounted_for` timeline event) or repeats what's still missing; if the prerequisite moved too, the pair is decided again from scratch. A landed prerequisite is re-checked even after the dependent rebased onto it. A re-check that fails keeps blocking; the **Stack** section's retry button runs it again. Until then, the merge button and auto-merge both refuse.

**The stack gate.** Landing is refused (`409`, naming each cause) while the pull request:

- must account for another pull request, open or landed, and hasn't yet;
- is stacked on an open pull request (it lands after its parent), or waits on one that has to land first.

Auto-merge treats unaccounted must-account-for as blocked and the other two as waiting, and also waits while discovery is still checking the pull request's head (the "still checking" hold applies to auto-merge only; the merge button doesn't wait for it). Pull requests in a dependency cycle don't make each other wait or stack on each other; the cycle itself is a reason to ask a person (`human_review`). An unaccounted must-account-for still blocks.

**Unstack and Dismiss.** A person with merge permission can, on the pull request page (web only; there are no MCP tools, so agents can't):

- **Unstack** a stacked pull request: its edge to the parent is dismissed and it goes back to the land target. When the parent was an ordering (from linearizing), the dismissed order stays: those two pull requests aren't put in one line again, and the pull request that needed both waits on both instead.
- **Dismiss** a dependency: every relationship between the two pull requests stops stacking and blocking.

Both are recorded on the timeline with who did them. A dismissal survives new commits to either pull request, so a dependency stays dismissed, until one of the two lands: then the landed pull request's relationships count again (a must-account-for blocks until a re-check finds it accounted for).

**Reasons in a pull request's state.** `must_account_for` (with the instructions and, when the prerequisite is open, the branch to rebase onto first) and `rebase_onto` call for the author's move (`agent_followup`); `cycle` calls for a person; `stack_checking` waits; `stacked_on` and `waits_on` only inform. Agents read them in `state.reasons` and in `stack` over MCP.

**Cost.** Per PR head change, one Clef call per open PR into the same target and per landed candidate (up to 20 pull requests landed in the last 30 days), skipped for pairs already checked at the same commits, plus one GLM-5.3 call per related or conflicting pair. Retargeting adds one Clef call per pair of unrelated prerequisites to order, and one GLM-5.3 re-check per new commit of a PR that must account for another.

## Cost

Per reviewed commit: one GLM-5.3-flash call per changed file (8 at a time, at most 300), one Clef
call for all invited agents, and one GLM-5.3 call per requested `engine: pass` agent (at most 10), on [Workers AI
pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/). A requested `engine: pi` agent instead
spends up to about its Pi review budget (80 model calls or 4,000,000 input tokens by default; see above for why it's
approximate) on the deep review model,
recorded under the `review-agent-pi` feature. Repositories without agents spend nothing on review.
