# Crew redesign: what's left

Status of the crew redesign (spec `docs/superpowers/specs/2026-10-08-crew-redesign-design.md`, plan
`docs/superpowers/plans/2026-10-08-crew-redesign.md`) when the first pull request was opened on 9 October 2026,
and the plan to finish it. Every task below goes through the same loop as the merged ones: implement in its own
worktree, task review (spec + quality), fix rounds, merge into `crew-redesign`.

## Merged in this pull request

| Task | What                                                                                                        | Tests at merge |
| ---- | ----------------------------------------------------------------------------------------------------------- | -------------- |
| A1   | Design system, 8 themes + System/Light/Dark, self-hosted fonts, agent avatars, identicons, primitives       | ✅             |
| A2   | HQ shell: rail (collapsed, peek overlay, pinned, drawer), top band, global search, account menu, routing    | ✅             |
| B1   | Migration `0027_crew_redesign.sql` (all new columns/tables), agent colour/facet/guarded, presets, audit log | ✅             |
| B2   | Repository board stats, agent records, built-in agents                                                      | ✅             |
| B3   | Owner questions, Ask someone, guarded reason rule, teach, Let Claude decide (with undo)                     | ✅             |
| B4   | Coding sessions, branch list, branch map data, safe merged-branch clean-up, delete on landing               | ✅             |
| B5   | Merge queue + ETA, pause merging, revert as a PR, live feed, health, search, reserved names                 | ✅             |
| B6   | Session ids on rows, health/search polish, "Paused" label                                                   | ✅             |
| S1   | `yarn seed:demo`: local demo data (repository, sessions, PRs, crew, findings, Actions history)              | ✅             |
| C0   | Typed API client for every new endpoint; search on the server                                               | ✅             |
| C1   | Home, Repositories board, New repository                                                                    | ✅             |
| C2   | Code browser, commits, commit                                                                               | ✅             |
| C4   | Pull requests board / list / graph, compare; list `limit`/`page`/`q`, reviewers per row                     | ✅             |
| C8   | Actions, runs, agent runs, Insights                                                                         | ✅             |
| C9   | Approvals inbox, owner-question and finding pages, Let Claude decide panel                                  | ✅             |
| C10  | Agents directory, agent and person profiles, New reviewer, built-in agents                                  | ✅             |
| C12  | Account settings, Site admin + instance Audit log, auth pages, not found                                    | ✅             |

Full suite on the merged branch: 118 files, 1,794 tests passing; `yarn typecheck` and `yarn build` clean.

## Known gaps in this pull request

- **Links to pages not built yet** show the inline "not found": `/:owner/:repo/health`, `/branches`, `/live`,
  `/audit`, `/session/:id`, `/settings/rules` (from Home, the Code page, the Pulls board and Approvals).
- **The pull request page and repository settings are the old pages** inside the new shell (C5 and C11 below).
- **Guarded findings (Security, Data) need a reason.** The old pull request page has no reason box, so decide them
  from Approvals (`/approvals/<finding>`) until C5 lands; the server returns 422 without one.
- **Docs are not updated yet** (CLAUDE.md architecture notes, `docs/architecture.md`, `docs/auto-merge.md`).

## Unfinished work (local branches on Mahmoud's machine)

These worktrees live under `.claude/worktrees/` in Mahmoud's checkout; their branches are not pushed. Each WIP
commit is unreviewed.

| Task                            | Branch                             | State                                                            | Next step                                                                                                                                                                                      |
| ------------------------------- | ---------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C5 Pull request page + sessions | `worktree-agent-a263a3c3eedfa0f1b` | Complete commit `59eee60`; review interrupted                    | Re-run the task review; fix; merge. Take C4's `src/lib/coder.ts` / `CoderChip` (identical copies).                                                                                             |
| C3 Health                       | `worktree-agent-ab739aa68b6d8582b` | Reviewed (one Important fix); fix round half done, WIP `07ae952` | Finish: API `noRuns[]` per area + `contributors[].who.sessionId` (+ tests), page shows no-run weeks as gaps, "overall" wording. Re-review, merge.                                              |
| C6 Branches + branch map        | `worktree-agent-a7c6ee0ba3e6ffb3c` | Reviewed (one Important fix); fix round half done, WIP `7066148` | Finish: `BranchInfo.inUse`, per-branch DELETE refuses protected and in-use branches (409), UI never offers Delete on them; revert captures its target; shared state wording. Re-review, merge. |
| C7 Live + repository audit log  | `worktree-agent-aad6384e7459d5282` | Implementation in progress, WIP `b657f83`                        | Finish, verify, review, merge. Adds Live and Audit log tabs.                                                                                                                                   |
| C11 Repository settings + Rules | `worktree-agent-adae75b92ab71fddc` | Implementation in progress, WIP `36c546d`                        | Finish, verify, review, merge. Rules must describe real behaviour (direct pushes to main are not blocked today).                                                                               |

To continue one: `cd .claude/worktrees/<agent-dir> && git merge crew-redesign`, finish, then merge its branch
into `crew-redesign`.

## Remaining tasks, in order

1. **Finish and merge the five pages above** (C5, C3, C6, C7, C11).
2. **Integration**
   - Health: replace the branch map placeholder with `<BranchMap compact />` from C6.
   - Sweep every internal link against `src/App.tsx` routes; no link may end on "not found".
   - Queued vs Checking state colours are too close in HQ light: adjust the tokens.
   - Mermaid diagram labels are clipped with the new fonts: set Mermaid's font family/size to the theme's.
3. **Backend must-fixes**
   - D1 caps LIKE/GLOB patterns at 50 bytes: `worker/src/lib/pull-search.ts` (words up to 50 + wildcards and
     escapes) and `worker/src/lib/search.ts` (terms up to 100 characters) can exceed it and fail in production.
     Cap every pattern at ≤ 50 UTF-8 bytes including `%` and escapes; add tests.
   - Flaky tests: `live-feed.test.ts` failed once and passed on rerun; another unidentified flake was seen once.
     Find and fix the ordering/timing assumption.
   - Teach note on an already-approved finding is silently dropped: return 409 (`worker/src/review/flags.ts`).
   - `POST …/delegate` must check the agent is live and invited (`worker/src/review/delegate.ts`).
   - Revert: delete the `revert-<n>` branch if opening the pull request fails after the push.
4. **Visual QA with demo data** (`yarn db:migrate:local`, `yarn dev`, `yarn seed:demo`): every route at 1440×900
   and 375×812 in HQ light, HQ dark (claret) and GitHub dark — no console errors, no sideways scroll, avatars never
   stretched, the panel is the only scroller.
5. **Docs**: CLAUDE.md (shell, themes, new tables and endpoints, the guarded rule: a commit approval no longer
   stands over a guarded agent's findings), `docs/architecture.md`, `docs/auto-merge.md` (owner questions, Ask
   someone, delegation, guarded), screenshots in `docs/screenshots/`. Fix the mockup's rail peek
   (`docs/design/crew/shell.js` `applyRail`: keep `shut` while peeking).
6. **Final whole-branch review** (most capable model) over `origin/main…crew-redesign`, one fix wave, re-review.
7. **Rollout** (only when a person says so): `yarn db:migrate:prod` (migration 0027), deploy `main` from a clean
   worktree, Agents → New reviewer → "Add the recommended crew", invite the agents per repository.

## Decisions parked for after the demo

- A guarded agent's failed or unfinished review is still stood over by a person's commit approval (pre-existing
  behaviour; blocking would leave pull requests unmergeable while agents can't run).
- An AI approval can trigger auto-merge before the person has a chance to undo it.
- Not built for lack of an API: snooze, a second person confirming a rule taught to a guarded agent, session labels
  on approval rows, calibration strip / propose change / dry run / rule revert on agent profiles, queue Move up and
  Hold, ahead/behind counts, session steps, test-module counts.
- New repositories leave reviewer agents unchecked (inviting one turns on auto-merge).

## Deferred minor findings (from task reviews)

Triaged at the final review; none blocks the demo.

- **Shell and design system:** toast live-region announcements and focus pause; `role=status` for persistent
  banners; boot-script/theme agreement test; avatar size thresholds as a tested function; custom-agent colours
  avoiding Clef/Fixer; raw hex in `components.css`; announced button errors; Mermaid re-theme on switch; search
  `aria-controls`, breadcrumb `nav`, menus closing on Tab, drawer closing on same-page links, pin storage outside
  the updater, `pointercancel` in search, create menu hidden under 560px.
- **Backend:** legacy approvals in the audit list; settings audit records raw input; crew route partial failure;
  audit tests for MCP repo create and system branch deletes; audit `headSha` naming; serial language detection;
  Clean reporting per-branch failures; `PersonRef` schema placement; session queries loading every PR; pushes to
  `refs/pull/<n>/head` unfiltered; AI decision log wording; `assignedToMe` counting change requests; lesson commits
  saying "Dismissed" for taught approvals; delegation settings not audited; pause/resume race and resume order.
- **Pages:** paging without keep-previous-data (Actions), run-title coupling, duplicated skeletons and `FileSummary`,
  contrast of log line numbers, commit-author duplicate hook, search result flash on reopen, Approvals dismiss
  stored as approval, owner-question reassignment, Home mixed failure states, agent profile wording, front matter
  edge cases, queue/blocker reflow on the board, check status cap of 100 commits.
- **Demo seed:** timeline backdating flattens events, direct SQL where an API exists, dry run skips the state rows.
