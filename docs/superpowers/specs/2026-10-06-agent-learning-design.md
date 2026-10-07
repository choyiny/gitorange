# Reviewer agents learn from dismissals

Status: design approved in conversation, 2026-10-06.

## Problem

A reviewer agent that raises a wrong change request is dismissed by a person, and then raises the same kind of
finding on the next pull request. Nothing carries a person's decision back to the agent: its `AGENT.md` and
`knowledge/` change only when someone edits them by hand.

## Goal

When a pull request closes, each agent whose change requests on it were **dismissed** gets one Pi run that edits the
agent's own repository (`<handle>/<handle>`) so similar false positives stop, and commits the edit straight to `main`
as the agent. The next review uses it.

## Non-goals

- Learning from approvals, needs-person findings, or findings the coding agent fixed. Only dismissals count.
- Asking people for a reason: the run infers it from the finding and the diff it cited.
- Changing an agent's front matter (name, bio, trigger question, threshold, engine): only the instructions body of
  `AGENT.md` and `knowledge/**` may change.
- A review step for the edit: commits land directly; a person reverts one like any commit.
- A new Durable Object class or binding.

## 1. Lessons: when, and from what

- **Trigger:** a pull request closes, merged (`landPull`, so the merge button, MCP and auto-merge) or closed unmerged
  (the close route).
- **Signal:** findings of kind `change_requested` that a person (or a moderator app acting for one) dismissed, on any
  of the pull request's commits.
- **Lesson rows:** a new D1 table `agent_lessons`: one row per (agent, pull request), unique on that pair, with the
  dismissed finding ids, `status` (`pending` → `learning` → `committed` | `nothing` | `failed`), `base_sha`,
  `commit_sha`, `summary`, `error`, timestamps. Written when the pull request closes, before the run starts, so a
  second close or a retried step never learns twice.
- **Runs:** a `learn` run type on the `MERGE_RESOLUTION` Workflow (like `stack` and agent reviews), recorded in the
  agent-runs log as `learn:<handle>`. Lessons for one agent run one at a time: a lesson starts only when no other lesson of that agent is `learning`.
  The daily cron retries lessons stuck in `pending`/`learning`, as it recovers stale reviews.
- **Input per lesson:** the agent repository at `main`; the pull request's title and target; for each dismissed
  finding its title, text, files, cited diff excerpts, commit, who dismissed it and when. Everything derived from the
  pull request or its diff is fenced as untrusted, as in deep reviews.

## 2. The learner run

- Runs on the existing `AgentReviewer` Durable Object in a **learn mode**, instance name `learn:<lesson id>`, reusing
  the Computer workspace, Pi harness, start gate, stop tombstone, `expire` job and usage recording.
- **Workspace:** the agent repository at `main` checked out under `/agent`. Tools: read, ls, find, grep over
  `/agent`; edit and write only for `/agent/AGENT.md` and `/agent/knowledge/**`. No shell, network or git. The write
  tools refuse any edit that changes `AGENT.md`'s front matter.
- **Model and limits:** the Pi model setting; separate, smaller learning limits (wall clock, tool calls, tokens) in
  Site admin → Settings.
- **Instructions:** you maintain `@handle`; people dismissed these findings as wrong; find the general reason (a
  pattern it misjudges, missing codebase context, an instruction too broad) and make the smallest edit to the
  instructions or `knowledge/` that stops similar false positives, keeping guidance the dismissals don't contradict;
  if they're one-offs, change nothing and say why; end with a 2–4 line summary.
- **Output:** the summary and the changed files, read back from the workspace. The workspace is then wiped and
  tombstoned.

## 3. Committing

- **Validation (Worker):** only `AGENT.md` and `knowledge/**` changed; `AGENT.md` not deleted; UTF-8 text files only, each at
  most 64 KB; the whole change at most 20 KB; `AGENT.md` still parses
  (`parseAgentConfig`) with front matter byte-for-byte unchanged. Any failure → `failed` with the reason, nothing
  committed. No change → `nothing`, with the model's explanation.
- **Commit:** one commit on `main`, pushed like merges (packfile over `git-receive-pack`, compare-and-swap from
  `base_sha`). If `main` moved, retry once from the new tip, else `failed`. Author and committer: the agent's user.
  Message: the summary, then `Learned from #N (owner/repo): dismissed "<title>"…`, then one trailer per dismissed
  finding id.
- **Effect:** the push refreshes `agents.config_sha` as any push does; the next review uses the new instructions.
- **Undo:** revert the commit or edit `AGENT.md`; a `committed` lesson is never re-learned.

## 4. Visibility, failures, testing

- **Agent profile:** a Learning section lists lessons (pull request, dismissed findings, status, commit link or the
  "nothing to learn" explanation or error).
- **Pull request page:** a timeline event, "@agent learned from N dismissed findings · `<sha7>`".
- **MCP:** `gitorange_list_agents` includes each agent's latest lessons (status, commit, summary).
- **Actions tab:** `learn:<handle>` runs with steps, tool calls and usage.
- **Insights:** per agent, dismissed findings and lessons committed.
- **Failures:** model or tool error or limits → `failed`, retried once by the sweep; validation rejected → `failed`,
  not retried; compare-and-swap lost twice → `failed`; agent deleted → lesson dropped. Usage is recorded either way.
- **Tests (Vitest in workerd, fake learner):** one lesson per agent on close, idempotent; approvals and needs-person
  findings create none; an allowed edit is committed as the agent with message and trailers; front-matter change,
  disallowed path, oversize and unparseable `AGENT.md` rejected; nothing-to-learn commits nothing; compare-and-swap
  retry from the new tip; the next review uses the new `configSha`; learn mode refuses writes outside the allow-list
  and front-matter edits, and a tombstoned run doesn't start. Frontend: the profile list and timeline text.
- **Deploy:** one generated migration (`agent_lessons`); no new bindings.
