# The crew redesign

GitOrange gets a new interface built around its reviewer agents, plus the backend that interface needs. The
visual reference is the mockup in `docs/design/crew/` (open `docs/design/crew/index.html` through any static
server, e.g. `python3 -m http.server -d docs/design/crew 8765`). Where this document and the mockup disagree,
this document wins.

## Goals

- **Two layers, one app.** A non-technical owner sees plain answers ("Nothing is broken. 1 decision needs you.")
  and makes decisions without reading code. A developer one click deeper gets GitHub-grade detail: diffs,
  commits, runs, findings with excerpts, the branch map.
- **Reviewer agents are the crew.** Each agent is a named helper with its own colour, robot avatar
  (`agent-robot-avatar`), profile, record and instruction repository. Avatars are prominent everywhere an agent
  appears and show what the agent is doing (reviewing, needs you, passed, asleep).
- **Serious and secure.** GitHub-level, mission-critical tone; nothing playful. Guarded areas (Security, Data)
  can never be approved in bulk, by one key, or by AI, and approving them needs a written reason.
- **No modals.** Every decision, finding, session, agent and setting has its own page and URL.
- **Visual branch management.** The Branches tab leads with a branch map: branches in flight against `main` over
  time, their state, and merged branches nobody deleted, with one-click clean-up.
- **HQ's shell and themes.** The navigation rail, top band and inset work panel follow HQ (`~/python/hq/ui`):
  collapsed rail with hover peek and pin, drawer on phones, the panel is the only scroller. Every theme (the HQ
  colourways and GitHub) is picked the same way from the account menu, with System/Light/Dark appearance.
- **Nothing dropped.** Every existing page, action and API stays reachable (see "Existing features to keep").

## Non-goals

- Production telemetry (latency, error rates of the user's own deployed app). Health is measured from what
  GitOrange itself knows: reviewer findings, tests and merges.
- A notifications system beyond the existing Approvals count plus "assigned to you".
- Replacing better-auth, the review engine, stacking or Actions. They gain fields and endpoints, not rewrites.

## Decisions taken for this build

1. **Health is measured from GitOrange's own signals.** One row per invited reviewer agent (its facet), plus
   "Tests on main" and "Merging". Week over week: findings that needed a person or requested changes, risks
   approved, test pass rate on the default branch, merges, reverts and conflicts fixed. A row "got worse" when
   this week's count of problems is higher than last week's. The page says how it is measured.
2. **The seven facets ship as presets, not as pre-created accounts.** Security, Data, Speed, Features,
   Reliability, Privacy and Shipping are templates (name, handle, bio, `trigger.ask`, instructions, colour,
   guarded flag). A site admin creates any of them, or "the recommended crew" in one step, from Agents → New
   reviewer. Clef and Fixer are built-in agents (no account); they appear on the Agents page with records from
   `pr_classifications` and `agent_runs`.
3. **Theme preference is per browser** (`localStorage`), applied by an inline script before React mounts so
   there is no flash. A per-account preference is not needed for this build.
4. **Fonts are self-hosted** through `@fontsource` packages (Figtree, IBM Plex Mono, Inter Tight). No request
   leaves the instance to render a page.
5. **The avatar component is bundled** from npm (`agent-robot-avatar`, MIT), never loaded from a CDN.
6. **Primer CSS stays as the base layer** (forms, `markdown-body`, utilities) and is themed through its CSS
   variables from our tokens, so Primer pieces follow every theme. New UI uses the design-system classes ported
   from the mockup (`src/styles/`).
7. **"Let Claude decide" runs inside the worker** with the instance's reasoning model, as the person who turned
   it on, recorded `via: "GitOrange AI"`. It never decides a guarded agent's finding. Every AI decision can be
   undone while the pull request is open.
8. **Revert opens a pull request** ("Revert #67: …") instead of pushing to the target, so reverts are reviewed
   and land like any other change.
9. **"Pause merging" is per repository**, stops both auto-merge and the merge button, can be set by anyone with
   push rights, and is always recorded in the audit log.
10. **Coding sessions are self-reported by the MCP client.** `create_pull_request` accepts an optional `session`
    label and the person's original `request`; the client name comes from the OAuth client of the MCP token. PRs
    opened from the web or by `git push` show "by hand".

## Information architecture

### Rail (left, HQ)

Brand; workspace button (instance name); **Home** `/`; **Repositories** `/repos`; **Approvals** `/approvals`
(count); **Agents** `/agents`; a rule; the five most recently visited repositories (agent repositories show the
agent's avatar); a rule; **Settings** `/settings/tokens`; **Site admin** `/admin` (admins only); pin/unpin at the
foot. States: collapsed 64px (default), hover peek overlay 236px, pinned 236px, drawer below 900px.

### Top band

Drawer button (phones), page icon + breadcrumb trail + page title (`<h1>`, focused on navigation), global
search (`/` to focus; results grouped: Repositories, Pull requests, Agents, People, Branches, Files; arrow keys,
Enter, Escape; clicking outside closes and clears), create menu (New repository, New reviewer agent, New access
token), Approvals inbox with count, account button (identicon + username) whose menu holds the theme grid,
appearance (System/Light/Dark), Your profile, Your repositories, Settings, Sign out.

### Routes

| Route                                                     | Page                                                                                                            | Status                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `/`                                                       | Home: what needs you, since last week, health per repository, activity; aside: repositories, your crew          | redesigned                            |
| `/repos`                                                  | Repositories status board                                                                                       | new                                   |
| `/new`                                                    | New repository                                                                                                  | redesigned                            |
| `/approvals`                                              | Approvals inbox + "Let Claude decide" panel + what Claude did today                                             | redesigned                            |
| `/approvals/:flagId`                                      | One finding: owner question or developer finding, decision, teach, ask someone, delegate                        | new                                   |
| `/agents`                                                 | Agents directory: reviewing your code, built in, available presets                                              | new                                   |
| `/agents/new`                                             | New reviewer: presets, recommended crew, or blank                                                               | new (replaces `/admin/agents` create) |
| `/:owner`                                                 | Person profile, or agent profile (overview = AGENT.md, reviews, rules learned, configuration, record, activity) | redesigned                            |
| `/:owner/:repo` (+ `tree/*`, `blob/*`)                    | Code                                                                                                            | redesigned                            |
| `/:owner/:repo/health`                                    | Health                                                                                                          | new                                   |
| `/:owner/:repo/pulls`                                     | Pull requests: Board (lanes), List, Graph                                                                       | redesigned                            |
| `/:owner/:repo/compare[/*]`                               | New pull request                                                                                                | restyled                              |
| `/:owner/:repo/pull/:number[/:tab]`                       | Pull request                                                                                                    | redesigned                            |
| `/:owner/:repo/session/:id`                               | A coding session: its requests and pull requests                                                                | new                                   |
| `/:owner/:repo/branches`                                  | Branch map, main, merge queue, all branches, clean-up                                                           | new                                   |
| `/:owner/:repo/live`                                      | Live: merge queue, requests floor, event log                                                                    | new                                   |
| `/:owner/:repo/commits/*`, `commit/:sha`                  | Commits, commit                                                                                                 | redesigned                            |
| `/:owner/:repo/actions[...]`                              | Actions runs, run/job logs, Agent runs                                                                          | redesigned                            |
| `/:owner/:repo/insights`                                  | Insights                                                                                                        | redesigned                            |
| `/:owner/:repo/audit`                                     | Audit log                                                                                                       | new                                   |
| `/:owner/:repo/settings[/:section]`                       | General, Collaborators, Agents, Rules, Danger zone                                                              | redesigned                            |
| `/settings/{tokens,mcp,emails}`                           | Account settings                                                                                                | restyled                              |
| `/admin`, `/admin/usage`, `/admin/agents`, `/admin/audit` | Site admin (agents list links to `/agents`)                                                                     | restyled; audit new                   |
| `/setup`, `/login`, `/invite/:token`, `/oauth/consent`    | Public and auth pages (no rail)                                                                                 | restyled                              |

Repository tabs, in order: Code, Health, Pull requests (count), Branches, Live, Actions, Insights, Audit log,
Settings (push rights). Agent repositories (`<handle>/<handle>`) show Code, Commits, Settings and a link to the
agent's profile.

## Design system

- **Tokens** (`src/styles/tokens.css`): HQ light and midnight dark tokens; chrome colourways `navy`, `ink`,
  `slate`, `indigo`, `forest`, `claret`, `paper` (paper turns `midnight` in dark mode; the others keep their
  chrome); Dev skin `github` = Primer light/dark tokens, system font, 6px radius, green primary `#1f883d`.
  `<html data-skin="hq|dev" data-theme="light|dark">` (absent theme = system), `.app[data-chrome]`.
- **Primer bridge** (`src/styles/primer-bridge.css`): maps `--fgColor-*`, `--bgColor-*`, `--borderColor-*`,
  `--button-*`, `--borderRadius-*` to our tokens per skin and mode.
- **Agent palette** (validated for contrast and colour-blind separation): Clef `#e26a17`, Fixer `#e34948`,
  Security `#2a78d6`, Data `#199e70`, Speed `#c98500`, Features `#d55181`, Reliability `#008300`, Privacy
  `#6b5cc9`, Shipping `#55606e`. Custom agents take a colour from AGENT.md or a stable hash into this palette.
- **Agent avatar** (`AgentAvatar`): the `agent-robot-avatar` element with the agent colour. States: clear →
  success, needs → input (held), asked → send, reviewing → inspect, running → startWaiting, learned → surprise
  then send, off/skipped → sleep, idle. At 28px and up it gets a halo; reviewing/needs/running add a moving
  ring; 40px and up follows the pointer (off under reduced motion). Sizes: 24 rail, 32–40 lists, 56 decision,
  72 cards, 168 profile. The wrapper never stretches inside flex rows.
- **People** get a GitHub-style identicon (5×5 symmetric grid from a hash of the username) unless they have a
  picture.
- **Motion and loading:** a skeleton on first visit to a route, then a short `.enter` fade-up; revisits are
  instant; pending buttons show a spinner and keep their width; toasts last 8s, pause on hover, offer Undo where
  the action can be undone. Reduced motion disables all of it.
- **Accessibility:** focus moves to the page `<h1>` on navigation; every icon button has a label; colour is never
  the only signal (chips carry text); keyboard shortcuts on Approvals (`j k o a r d x A`) skip guarded items.

## Backend additions

All new tables and columns land in one migration generated by `yarn db:generate`. Every endpoint is a Zod
OpenAPI route, enforces the same access rules as its neighbours (`permissionsFor` / `visibleTo`), and pings the
`LiveHub` after mutations like the existing ones.

### Schema

- `agents`: `color text` (hex, nullable), `facet text` (nullable), `guarded integer boolean default false`;
  filled from AGENT.md frontmatter by the existing refresh.
- AGENT.md frontmatter (strict schema in `worker/src/agents/config.ts`) accepts optional `color`
  (`#rrggbb`), `facet` (`security|data|speed|features|reliability|privacy|shipping|other`) and `guarded`
  (boolean).
- `pull_requests`: `created_via text` (MCP client name), `session_label text`, `request text` (≤ 4000 chars).
- `pr_review_flags`: `question text` (owner question, ≤ 200 chars), `assignee_id`, `assigned_by_id`,
  `assigned_at`, `decision_reason text` (required for guarded approvals), `teach_note text`, `teach_by_id`.
- `repositories`: `merging_paused_at`, `merging_paused_by_id`, `delete_merged_branches integer boolean default
true`.
- `ai_delegations`: `(user_id, agent_id)` primary key, `created_at`: a person lets GitOrange AI answer that
  agent's findings on their pull requests.
- `audit_events`: `id`, `repository_id` (nullable = instance), `actor_id` (nullable), `actor_kind`
  (`person|agent|ai|system`), `via` (nullable app name), `action` (enum below), `target` (text), `data` (json),
  `created_at` (ms). Indexed by `(repository_id, created_at)` and `(created_at)`.
  Actions: `settings.changed`, `collaborator.added`, `collaborator.removed`, `agent.invited`, `agent.removed`,
  `agent.created`, `agent.deleted`, `branch.deleted`, `branches.cleaned`, `merging.paused`, `merging.resumed`,
  `pull.merged`, `pull.reverted`, `pull.approved`, `finding.approved`, `finding.changes_requested`,
  `finding.assigned`, `finding.delegated`, `finding.undone`, `finding.taught`, `token.created`,
  `token.deleted`, `visibility.changed`, `repository.created`, `repository.deleted`, `instance.settings`.

### Endpoints

- **Repositories board** `GET /api/repos?stats=1`: adds per repository `pulls` (counts by `pullState` bucket:
  `needs_person`, `changes_requested`, `checking`, `queued`), `merged7d`, `mergedByDay[7]`,
  `mergedAutomaticallyPct`, `agents[] {handle, name, color}`, `branchCount`, `language` (largest extension by
  file count, cached), `updatedAt`.
- **Agent records** `GET /api/agents/{handle}/stats`: `raised`, `kept` (approved needs_person + change requests
  the PR agent fixed), `dismissed`, `keptPct`, `rules` (committed lessons), `reviews`, `byDay[182]`,
  `bestCatch` (latest approved needs_person finding title + PR), `status[]` per invited repository.
  `GET /api/agents/builtin`: Clef (changes routed, median decision ms, test runs picked) and Fixer (attempts,
  combined, merged anyway) from `pr_classifications` and `agent_runs`.
- **Presets** `GET /api/agents/presets`; `POST /api/admin/agents` accepts `preset` (fills AGENT.md from
  `worker/src/agents/presets.ts`); `POST /api/admin/agents/crew` creates any missing recommended presets.
- **Owner questions** (contract + prompts in `worker/src/review/`): `needs_person` findings may carry `question`
  (yes/no, no jargon). `POST .../review/flags/{id}/assign {userId}` (someone with push rights);
  `POST .../review/flags/{id}/approve` takes `reason` (required when the agent is guarded) and `teach`;
  `POST .../review/flags/{id}/request-changes` takes `teach`; `POST .../review/flags/{id}/undo` reopens a decision
  the caller (or their AI) made while the PR is open. `GET /api/approvals` gains `assignedToMe` and per-item
  `question`, `guarded`, `assignee`.
- **Teach:** a decision's `teach` note is stored on the flag; at PR close `queueLessons` includes flags with a
  teach note (approved or dismissed) and the learner receives the person's words as the rule to learn.
- **Let Claude decide:** `GET/PUT /api/me/delegations` (agent ids; guarded agents refused).
  `POST .../review/flags/{id}/delegate` decides one now. After a review finishes, findings of delegated agents on
  the delegating person's PRs are decided automatically (approve, request changes with a note, or leave for the
  person with a reason). Decisions record `approvedVia`/`audit.via = "GitOrange AI"`.
- **Provenance:** MCP `create_pull_request` gains optional `session` (≤ 64) and `request` (≤ 4000);
  `created_via` = the token's OAuth client name. `GET /api/repos/{o}/{r}/sessions` (grouped by
  `created_via + session_label + author`) and `GET .../sessions/{id}` (its PRs, requests, states).
- **Branches:** `GET /api/repos/{o}/{r}/branches` → `{name, sha, isDefault, isProtected, updatedAt,
author, pull: {number, title, state, pullState, createdVia, session} | null, mergedNotDeleted}`.
  `POST .../branches/clean` deletes every merged-not-deleted branch (push rights; never default or protected;
  audit `branches.cleaned`). `GET .../branches/map?days=10` returns the branch map model: main's landings in the
  window, open branches (opened, state, author/session), merged-not-deleted branches (merged at).
  `delete_merged_branches` makes every landing (button or auto-merge) delete the head branch.
- **Merge queue:** `GET /api/repos/{o}/{r}/queue` → per land target, open PRs in landing order with blockers
  (from `pullState` reasons) and `etaMinutes` (median of the last 10 completed PR runs + median review time,
  accumulated down the queue). `POST/DELETE .../merging/pause`. `landPull` and auto-merge refuse while paused;
  `pullState` gains reason kind `merging_paused` (bucket `waiting`).
- **Revert:** `POST .../pulls/{n}/revert` (merged PRs, push rights) computes the inverse of the landed range
  onto the target tip (`GitService.mergeTrees` with base = landed head, ours = tip, theirs = parent of the first
  landed commit), pushes `revert-<n>` and opens "Revert #n: <title>". 409 when it does not apply cleanly.
- **Audit:** `GET /api/repos/{o}/{r}/audit?cursor=` merges `audit_events` and `pr_events` newest first;
  `GET /api/admin/audit` the same instance-wide. A helper `recordAudit(db, event)` never throws.
- **Live:** `GET /api/repos/{o}/{r}/live` → queue, requests floor (open PRs grouped by session/person with
  state), last 50 events. The page refetches on the existing `repo:<id>` pings.
- **Health:** `GET /api/repos/{o}/{r}/health` → `summary`, `areas[]` (agent facet rows + tests + merging, each
  with `thisWeek`, `lastWeek`, `weeks[8]`, `trend: better|same|worse`, `status` text, `open`), `contributors[]`
  (person or session: changes merged, findings on their PRs, notable item), `decisionsWaiting`.
- **Search:** `GET /api/search?q=&repo=o/n` → `repos`, `pulls`, `agents`, `people`, `branches` (scoped repo),
  `files` (scoped repo, path match over the default branch tree, cached per isolate for 60s, capped at 5000
  paths). Results respect visibility.

## Existing features to keep

See `docs/superpowers/specs/2026-10-08-crew-redesign-inventory.md`: the page-by-page inventory of today's
capabilities. Each redesigned page must cover every item in its section; the PR description lists any item
that moved (and where).

## Testing

- Backend: Vitest in workerd (`worker/src/__tests__/`) for every new endpoint and rule (access, guarded
  approvals, pause gating, revert conflict, branch clean-up refusing protected/default, audit writes, search
  visibility, delegation refusing guarded agents, health trend maths, queue ETA order).
- Frontend: pure logic in `src/lib` with unit tests (theme resolution, identicon, avatar state mapping, branch
  map layout, search grouping, queue ETA formatting).
- Visual: every route checked in light and dark, HQ and GitHub skins, at 1440 and 375 wide: no console errors,
  no horizontal page scroll, the panel is the only scroller.
- Definition of done: `yarn test`, `yarn typecheck`, `yarn format`.

## Rollout

1. Apply the migration (`yarn db:migrate:prod`) before deploying.
2. Deploy `main` from a clean worktree (only when a person says so).
3. A site admin opens Agents → New reviewer → "Add the recommended crew", then invites the agents to each
   repository (Settings → Agents).
4. Coding agents pick up `session`/`request` from the updated MCP tool descriptions; `AgentPrompt` mentions them.
