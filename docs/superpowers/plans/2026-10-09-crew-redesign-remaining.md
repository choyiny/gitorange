# Crew redesign: what's left

Status of the crew redesign (spec `docs/superpowers/specs/2026-10-08-crew-redesign-design.md`, plan
`docs/superpowers/plans/2026-10-08-crew-redesign.md`) being prepared for a pull request on 9 October 2026,
and the plan to finish it. Every task below goes through the same loop as the merged ones: implement in its own
worktree, task review (spec + quality), fix rounds, merge into `crew-redesign`.

## Merged in this pull request

| Task | What                                                                                                                                | Tests at merge |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| A1   | Design system, 8 themes + System/Light/Dark, self-hosted fonts, agent avatars, identicons, primitives                               | ✅             |
| A2   | HQ shell: rail (collapsed, peek overlay, pinned, drawer), top band, global search, account menu, routing                            | ✅             |
| B1   | Migration `0027_crew_redesign.sql` (all new columns/tables), agent colour/facet/guarded, presets, audit log                         | ✅             |
| B2   | Repository board stats, agent records, built-in agents                                                                              | ✅             |
| B3   | Owner questions, Ask someone, guarded reason rule, teach, Let Claude decide (with undo)                                             | ✅             |
| B4   | Coding sessions, branch list, branch map data, safe merged-branch clean-up, delete on landing                                       | ✅             |
| B5   | Merge queue + ETA, pause merging, revert as a PR, live feed, health, search, reserved names                                         | ✅             |
| B6   | Session ids on rows, health/search polish, "Paused" label                                                                           | ✅             |
| S1   | `yarn seed:demo`: local demo data (repository, sessions, PRs, crew, findings, Actions history)                                      | ✅             |
| C0   | Typed API client for every new endpoint; search on the server                                                                       | ✅             |
| C1   | Home, Repositories board, New repository                                                                                            | ✅             |
| C2   | Code browser, commits, commit                                                                                                       | ✅             |
| C3   | Health route/tab, no-run chart gaps, contributor session links, reviewer overall statistics; reviewed and merged as `9964eec`       | ✅ focused     |
| C4   | Pull requests board / list / graph, compare; list `limit`/`page`/`q`, reviewers per row                                             | ✅             |
| C5   | Pull request tabs/actions, guarded reason panels, safe branch-delete gate, Session lifecycle page; reviewed and merged as `6f5f128` | ✅ focused     |
| C8   | Actions, runs, agent runs, Insights                                                                                                 | ✅             |
| C9   | Approvals inbox, owner-question and finding pages, Let Claude decide panel                                                          | ✅             |
| C10  | Agents directory, agent and person profiles, New reviewer, built-in agents                                                          | ✅             |
| C12  | Account settings, Site admin + instance Audit log, auth pages, not found                                                            | ✅             |

Recorded baseline before the C3/C5 merges: 118 files, 1,794 tests passing; `yarn typecheck` and `yarn build`
clean. C3 records 8 focused files / 160 passing tests and typecheck; C5 records 10 focused files / 158 passing
tests, then 30 passing tests for its review fix round, plus typecheck and build. These are task-level results,
not substitutes for integrated validation.

Integrated validation on 9 October: `CI=1 yarn test` passed **122 files / 1,876 tests**; `yarn typecheck` and
`yarn build` passed. The initial local run, concurrent with build/typecheck, exceeded the default five-second
per-test timeout and was stopped; the complete rerun used the repository's existing 30-second CI timeout.
Existing workerd HTTP-body warnings and Vite large-chunk warnings remain. The `003cb38..9964eec` integration
delta passed an independent review with no new blocking findings. Full-browser acceptance and the review of
the whole original redesign remain pending.

## Known gaps in this pull request

- **Links to pages not built yet** show the inline "not found": `/:owner/:repo/branches`, `/live`, `/audit`,
  `/settings/rules` (from Home, the Code page, the Pulls board and Approvals). Health and Session routes have
  landed; the full internal-link sweep is still pending.
- **Repository settings are the old pages** inside the new shell (C11 below).
- **Health's compact branch map is a link placeholder** until C6 supplies `<BranchMap compact />`.
- **Health's approval decision card only searches loaded inbox pages.** A matching finding beyond the loaded
  pages can show the generic waiting card, whose Approvals link remains actionable (minor C3 review finding).
- **C3/C5 full browser acceptance remains pending.** Focused local-demo smoke checks covered the PR, Health
  and Session routes, desktop and 375×812 mobile layouts, no page-width overflow, session navigation, and guarded
  approval disabled without a selected reason. PR/head action-state resets, long lists, every route/theme and
  the full interaction matrix remain unverified. Captures: `docs/screenshots/crew-health.jpg`,
  `crew-health-mobile.jpg`, and `crew-pull-mobile.jpg`.
- **Docs are not updated yet** (CLAUDE.md architecture notes, `docs/architecture.md`, `docs/auto-merge.md`).

## Unfinished work (local branches on Mahmoud's machine)

These worktrees live under `.claude/worktrees/` in Mahmoud's checkout; their branches are not pushed. Each WIP
commit needs completion or re-review before merging.

| Task                            | Branch                             | State                                                            | Next step                                                                                                                                                                                      |
| ------------------------------- | ---------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C6 Branches + branch map        | `worktree-agent-a7c6ee0ba3e6ffb3c` | Reviewed (one Important fix); fix round half done, WIP `7066148` | Finish: `BranchInfo.inUse`, per-branch DELETE refuses protected and in-use branches (409), UI never offers Delete on them; revert captures its target; shared state wording. Re-review, merge. |
| C7 Live + repository audit log  | `worktree-agent-aad6384e7459d5282` | Implementation in progress, WIP `b657f83`                        | Finish, verify, review, merge. Adds Live and Audit log tabs.                                                                                                                                   |
| C11 Repository settings + Rules | `worktree-agent-adae75b92ab71fddc` | Implementation in progress, WIP `36c546d`                        | Finish, verify, review, merge. Rules must describe real behaviour (direct pushes to main are not blocked today).                                                                               |

To continue one: `cd .claude/worktrees/<agent-dir> && git merge crew-redesign`, finish, then merge its branch
into `crew-redesign`.

## Remaining tasks, in order

1. **Finish and merge the three pages above** (C6, C7, C11).
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
4. **Final integrated validation and visual QA**: run the full suite, typecheck and build on the assembled branch,
   recording fresh totals separately from the 1,794-test baseline. With demo data (`yarn db:migrate:local`,
   `yarn dev`, `yarn seed:demo`), inspect every route at 1440×900
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
