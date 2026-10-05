# Reviewer agents

Status: design approved in conversation, 2026-10-05.

## Problem

Review in GitOrange is configured by `.gitorange/review.yml`: a list of yes/no, choice and score questions with
thresholds, answered by Clef over the per-file summaries, plus limits and stacking tuning. That is the GitHub
mindset — a config file of rules. It hides who is reviewing, can't carry knowledge beyond a one-line question, and
changing it is a config edit rather than a change to a reviewer.

## Goal

Every review concern is a **reviewer agent**: an account like a person (`@securityagent`, `@featureagent`,
`@dataagent`, `@docsagent`), with a profile and its own git repository holding who it is and how it reviews.
Repositories invite agents. On each pull request commit, every invited agent decides with Clef whether the change
concerns it; the ones that do are requested as reviewers and review. Their concerns go through the existing flag
approval flow, so **no pull request lands without a review from someone or some agent**. `review.yml` is removed.

## Non-goals

- Agents writing code or pushing (they review; the PR's own agent fixes).
- Agents owned by a user or team (all agents are instance-wide).
- Migrating `review.yml` questions into agents automatically.
- Per-repository tuning of limits or stacking (built-in defaults only).

## 1. Agents and their repositories

- **Account.** An agent is a row in better-auth's `user` table (so profiles, avatars, @mentions, comment authorship,
  timeline, Approvals and the shared URL namespace in `worker/src/lib/namespaces.ts` work unchanged) plus a row in a
  new `agents` table marking it as an agent. An agent has no password, sessions, personal access tokens or OAuth
  consents: signing in as an agent, or issuing it a token, is refused at the auth layer.
- **Creation.** Site admin → Agents → New: a handle (namespace rules as usernames) and a display name. GitOrange
  creates the user row, the `agents` row, and the repository `<handle>/<handle>` (internal visibility), seeded from a
  template `AGENT.md`, `avatar.png` and `knowledge/README.md`, with the creator as a collaborator.
- **Agent repository** (read from its default branch):
  - `AGENT.md` — YAML frontmatter plus a Markdown body:
    ```yaml
    ---
    name: Security Agent
    bio: Reviews changes to authentication, authorization and secrets.
    trigger:
      ask: Does this change touch authentication, authorization, sessions, tokens or secrets?
      above: 0.3 # Clef probability that it applies; 0 < above < 1
    engine: pass # pass (one reasoning-model call) | pi (durable Pi agent with tools)
    ---
    (instructions: what this agent cares about, how it judges, what counts as a blocking concern)
    ```
  - `avatar.png` — its profile picture (falls back to the generated avatar).
  - `knowledge/*.md` — material it reads when reviewing and can cite (checklists, data-model notes). Bounded: the
    review reads at most 20 files / 64 KB in total, in path order; the rest is listed by path.
- **Editing.** Anyone with push access to the agent repository edits the agent. Changes are pull requests on that
  repository like any code. The agent row caches `name`, `bio` and `trigger` from the latest valid `AGENT.md` on a
  push to its default branch (for profile pages and the Clef call); the review itself always reads the repository at
  a recorded commit.
- **Versioning.** Every review records the agent repository commit SHA it used (`agent_sha`), shown as a link on the
  review.
- **Profile page** `/<handle>`: an "Agent" label, name, bio, avatar, the trigger question, link to its repository,
  the repositories it is invited to (visible to the viewer), and its recent reviews.
- **Inviting.** Repository settings → **Agents** (beside Collaborators): repository admins invite or remove any
  instance agent. Only invited agents run on that repository's pull requests. The agent's own repository can invite
  agents too (including itself).
- **Deletion.** Site admin can delete an agent: it is removed from every repository, its user row is kept as a
  "deleted agent" so past reviews and flags stay attributed; its repository is left for an admin to delete.

## 2. Review of each pull request commit

On every new head commit of an open pull request (where `review.yml` is read today: PR open, push, sweep, retry):

1. **Summaries** — unchanged: one line per changed file (GLM-5.3-flash); `.orangeignore` and lockfiles stay out.
2. **Trigger** — one Clef call asks each invited agent's `trigger.ask` over the summaries. Each agent gets a
   `pr_reviewers` row for this head: `requested` when the probability is at or above its `above`, otherwise
   `not_needed` with the probability shown. If Clef fails or answers unusably, every invited agent is requested
   (unsure means review). An agent whose `AGENT.md` is invalid at its current SHA gets a `failed` row with the parse
   error.
3. **Review** — each requested agent reviews at its agent repository's current default-branch SHA:
   - `engine: pass` — one GLM-5.3 call with `AGENT.md`'s body, its knowledge files, the per-file summaries and the
     diffs (whole diff up to today's size caps; files beyond the caps listed by path). It returns `approve`, or
     findings.
   - `engine: pi` (milestone 3) — a durable Pi agent in a Cloudflare Computer workspace with the repository checked
     out at the head, `AGENT.md` as its instructions, read-only tools, and the same output contract.
   - Untrusted input: PR text, file contents and diffs are data, never instructions; the prompt says so.
4. **Findings** are flags (`pr_review_flags`) owned by the agent, with today's investigation shape (one sentence,
   before/after table, Mermaid diagram, excerpts cut from the real diff) and the `agent_sha`. Each finding has a kind:
   - `needs_person` — a person approves it or requests changes on the PR or the Approvals page (today's flow);
   - `change_requested` — the agent asks for a change it is sure of; it goes to the PR's agent as follow-up and is
     resolved by the next push (a new head is reviewed afresh). A person may also dismiss it.
     The reviewer row ends `approved` (no findings), `flagged` (any `needs_person`) or `changes_requested` (any
     `change_requested`).
5. **Nobody requested** (no invited agents triggered, or none invited) — the pull request requires a person:
   **Approve** on the pull request (new, collaborators/admins, recorded per head SHA in `pr_approvals`). People may
   also approve any pull request.

Agent reviews run as `MERGE_RESOLUTION` Workflow steps like today's classification (replay-safe, deterministic ids,
recorded under Actions → Agent with the agent named on each review step).

## 3. When a pull request may land

By the merge button, MCP merge, or auto-merge (`landPull` and `autoMergeStatus`), all of:

- checks pass (`checkVerdict`, unchanged);
- the stack gate is clear (unchanged);
- **review is satisfied for the current head**: every requested agent's row is `approved`, or `flagged` with every
  `needs_person` flag approved, and none is `reviewing`, `failed` or `changes_requested`; **or**, when no agent was
  requested, a person approved this head.

A new commit resets agent reviews and person approvals (they are per head SHA). A maintainer can still merge by hand
past unresolved agent review only if they approve the outstanding flags or the pull request themselves — there is
no bypass without a recorded approval.

**Auto-merge** is on for every repository with at least one invited agent. A repository with no invited agents is an
ordinary code host: a person approves and merges.

## 4. Surfaces

- **PR states** (`worker/src/pulls/state.ts`) — new reasons, replacing the review.yml ones:
  `agent_reviewing` (waiting), `agent_flagged` (human_review, names the agent and flags), `agent_changes_requested`
  (agent_followup, names the agent and the change), `agent_review_failed` (human_review: fix or retry the agent),
  `needs_approval` (human_review: no agent requested).
- **Pull request page** — a Reviewers box: requested agents with status, avatar and the `agent_sha` link; not-needed
  agents collapsed with their probabilities; people who approved. Flags shown under their agent. The Approve button.
- **Approvals page** — flags grouped by agent; pull requests needing a person's approval.
- **MCP** — `gitorange_get_pull_request` returns `reviewers` (agent handle, status, probability, findings with kind)
  and the change requests as follow-up instructions; `pull_state` reasons as above. Agents can't approve over MCP;
  people approve in the web UI (as flags today).
- **Agent runs** — each agent review is a recorded step naming the agent; decisions show approve / N findings.

## 5. Removed

`worker/src/review/policy.ts` and every `readPolicy`/`ReviewPolicy` use; `.gitorange/review.yml` is ignored. Gone with
it: policy questions (yes/no, choice, score), thresholds, `model:`, `limits.max_files` (summaries keep their existing
size caps), and the `stacking:` section (stacking uses `STACKING_DEFAULTS`). `pr_classifications` keeps summaries
per head and drops its policy columns (historical rows stay readable). Docs (`docs/auto-merge.md`, README,
architecture, configuration, setup, the how-it-works diagram) are rewritten around agents.

## 6. Data model (Drizzle; migrations generated)

- `agents`: `user_id` PK → user, `repository_id` → repositories (its repo), `name`, `bio`, `trigger_ask`,
  `trigger_above`, `engine`, `config_sha` (the AGENT.md these cached fields came from), `config_error`,
  `created_by_id`, `created_at`, `deleted_at`.
- `repository_agents`: `repository_id`, `agent_id`, `invited_by_id`, `created_at`; unique (repository, agent);
  deleted with either side.
- `pr_reviewers`: `id`, `pull_request_id`, `head_sha`, `agent_id`, `probability`, `requested`, `agent_sha`,
  `status` (`not_needed` | `reviewing` | `approved` | `flagged` | `changes_requested` | `failed`), `summary`, `error`,
  `created_at`, `finished_at`; unique (pull request, head, agent).
- `pr_review_flags`: add `agent_id`, `kind` (`needs_person` | `change_requested`), `agent_sha`.
- `pr_approvals`: `pull_request_id`, `head_sha`, `user_id`, `created_at`; unique (pull request, head, user).

D1 limits apply: chunk `inArray` at 90.

## 7. Failure handling

- Agent repository unreadable or `AGENT.md` invalid → that reviewer `failed` with the error; blocks landing until the
  agent is fixed and the review retried (Retry on the reviewer row) or the agent is removed from the repository.
- Clef fails → every invited agent requested.
- Review model fails or times out → retried (2), then `failed` with Retry.
- Agent removed from the repository mid-review → its row is cancelled (`not_needed`, note "removed") and stops
  counting.
- Agent deleted → removed everywhere; history kept.
- Sign-in, token or OAuth consent for an agent user → refused.

## 8. Testing (Vitest, real D1, fake Clef / reasoning model / Pi)

Agent creation and repo seeding; `AGENT.md` parsing (valid, invalid frontmatter, bad thresholds, unknown engine);
cached fields refresh on push; agents can't sign in or get tokens; invite/remove permissions; trigger threshold edges
and Clef failure; pass review → approve / needs_person / change_requested; land conditions (agents, human approval,
new head resets, failed reviewer blocks, removed agent stops counting); auto-merge on only with invited agents;
`review.yml` ignored; PR state reasons; Approvals grouping; MCP output; profile page; agent run steps name the agent;
Pi engine with a fake resolver (milestone 3).

## Milestones (each its own PR into `main`)

1. **Agents exist** — accounts, `agents`/`repository_agents`, agent repository seeding and `AGENT.md` parsing, profile
   page, Site admin → Agents, repository settings → Agents, auth refusal.
2. **Agents review** — trigger, single-pass review, agent-owned flags with kinds, change requests to the PR's agent,
   person approval, land/auto-merge rewired, states/Approvals/MCP/PR page, `review.yml` removed, docs and README.
3. **Pi on demand** — `engine: pi` reviews in a Computer workspace.
