# MCP moderator apps

Status: design approved in conversation, 2026-10-06.

## Problem

Reviewer agents raise findings on pull requests; today only a person in the web UI can approve a finding, dismiss an
agent's change request, or approve a pull request. Every MCP client acts as the user who connected it, so letting any
MCP client make those decisions would let a pull request's own coding agent clear the findings raised against it.
The user wants a dedicated AI moderator ("Claude Mod") that reads agent findings and decides them over MCP.

## Goal

A user can mark one or more of their connected MCP apps as a **moderator**. A moderator connection can approve
agent findings, dismiss agent change requests, and approve pull requests — the decisions a person makes in the web
UI — with every decision recorded as made by that user **via** that app. Other MCP connections can't.

## Non-goals

- A moderator built into GitOrange (it is an external MCP client the user authorises).
- New merge paths: merging stays `gitorange_merge_pull_request` / auto-merge through the unchanged gate.
- Restricting a moderator from pull requests the same app opened (the user chose to allow it).

## 1. Marking an app as a moderator

- **Settings → MCP server → Connected apps** lists the user's OAuth consents (existing page) and gains a **Moderator**
  toggle per app, with a short warning: "A moderator can approve agent findings and pull requests as you." Each row
  shows a client-id fragment and the redirect host, so two apps registered under the same name can be told apart.
- Stored in a new app table `mcp_moderators` (`user_id`, `client_id`, `consent_id`, `created_at`; primary key (user,
  client); deleted with the user, the client, or the consent). `consent_id` binds the row to the consent it was turned
  on under: better-auth's own delete-consent knows nothing of moderators, so without it a consent revoked elsewhere
  and granted again would silently be a moderator again (a `created_at` comparison doesn't work: better-auth stamps
  consents in whole seconds). better-auth's generated consent/client tables are not changed.
- API: `GET /api/mcp/connections` (existing list, gains `moderator: boolean` and `redirectHost`), `PUT`/`DELETE
/api/mcp/connections/:clientId/moderator` (session only — never over MCP).
- A moderator app always gets the consent screen when it authorises again (a `hooks.before` on `/oauth2/authorize`
  forces `prompt=consent`): better-auth otherwise issues a code silently once a consent exists, and loopback redirects
  match any port, so a local process could otherwise obtain a moderator token through the user's browser. Consenting
  again keeps the same consent row, so the moderator setting survives only an explicit consent.
- Disconnecting an app (revoking consent) also removes its moderator row. The moderator check runs on every MCP call,
  so turning it off, or disconnecting, takes effect immediately.
- A moderator acts with the user's own permissions: each tool still requires `perms.write` on the repository.

## 2. Moderator MCP tools

Listed in `tools/list` and callable only when the MCP session's (user, client) has a moderator row. A direct call from
another connection is refused: "This connected app isn't a moderator — turn it on in Settings → MCP server → Connected
apps." Moderator connections get server instructions that describe the tools (without the "only a person can approve"
sentence ordinary connections get).

- `gitorange_approve_review_finding { repository, number, finding_id, head_sha }` — approve an agent finding that needs
  a person (`kind = needs_person`). Same effect as the web approve.
- `gitorange_dismiss_change_request { repository, number, finding_id, head_sha }` — dismiss an agent's change request
  (`kind = change_requested`). Same effect as the web dismiss.
- `gitorange_approve_pull_request { repository, number, head_sha }` — approve the pull request's current head. Same
  effect as a person's Approve: satisfies review when no agent was requested, and overrides needs-a-person findings and
  failed agent reviews, but not open change requests.
- Every tool requires the full 40-character `head_sha` (the commit the moderator looked at; an abbreviation is refused
  with "pass the full head_sha"); a mismatch with the pull request's current head
  answers an error ("The pull request has new commits since you looked") and records nothing.
- `gitorange_request_changes_on_review_flag` stays available to every MCP client, as today. Reading findings needs no
  new tool (`gitorange_get_pull_request` returns them).

## 3. Audit

- `pr_review_flags` gains `approved_via` (text, nullable): the app's client name for decisions made over MCP, with
  control and bidi characters stripped and at most 80 characters (the name is the client's own choice).
- `pr_approvals` gains `via` (text, nullable) likewise; the `approved` timeline event records `via`.
- The web UI shows "@user via <app name>" wherever an approval or dismissal is shown (PR Reviewers box, timeline).
  The Approvals page lists only undecided items, so it has no `via`. `gitorange_get_pull_request` returns `via` on
  findings and in `approvals`. Web decisions leave `via` null.
- Migration generated by `yarn db:generate`; additive only.

## 4. Testing

Moderator vs non-moderator connection (tools listed / refused); toggling off and disconnecting take effect on the next
call; each of the three tools (effect identical to the web path, including gate results and timeline events); head
mismatch refused; change requests still block until dismissed; `perms.write` still required; audit fields set; the
toggle routes are session-only (an MCP token can't call them).
