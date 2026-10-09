# Crew redesign handoff to Cho

9 October 2026. The three unfinished page implementations have been published to GitOrange. They no
longer depend on access to Mahmoud's machine. They are WIP branches, not three completed PRs.

## Published source

Remote: `https://git.xyspace.dev/choyiny/gitorange.git` (`origin`).

| Work                               | Remote branch                       | Exact saved commit                         |
| ---------------------------------- | ----------------------------------- | ------------------------------------------ |
| C6: Branches and branch map        | `codex/crew-c6-branches-wip`        | `7066148e01622a4e1044e4ee92f203364a502638` |
| C7: Live and repository audit      | `codex/crew-c7-live-audit-wip`      | `b657f8364069eb1ef42132b2d0b69cd56a0573f6` |
| C11: Repository settings and Rules | `codex/crew-c11-settings-rules-wip` | `36c546d7b3f38f5122e0e589c209d407544870e7` |

The source worktrees were clean, including nonignored untracked files, when published. An audit of all
Crew task worktrees found that only these three had commits absent from `origin/crew-redesign`.
All their tracked files and ancestor commits are included in the pushes. Local dependency folders,
credentials, deployment configuration and local databases are not needed to transfer these changes.

The shared `crew-redesign` branch already includes the reviewed C3/C5 pages and Cho's nine subsequent
fix commits through `60a2bc7`. Preserve those fixes when integrating these older snapshots. The original
[design](../specs/2026-10-08-crew-redesign-design.md),
[implementation plan](2026-10-08-crew-redesign.md), mockups under `docs/design/crew/`, and
[current remaining-work plan](2026-10-09-crew-redesign-remaining.md) are tracked in Git.

## Fetch and continue

From a clean checkout with `origin` pointing to GitOrange:

```sh
git fetch origin
git switch -c codex/crew-finish-c6 origin/crew-redesign
git merge --no-ff origin/codex/crew-c6-branches-wip
```

Resolve overlapping changes, finish C6 and review/test it before proposing it back to `crew-redesign`.
For each later task, start a new finish branch from the then-current `origin/crew-redesign` and merge the
matching WIP branch. Use feature branches; never push directly to `main`.

If selectively applying commits is preferred, C6 needs **both** `a3fbdb5` and `7066148`, in that order;
`bc7aba6` is an ancestry merge, not another feature change. C7 is `b657f83`; C11 is `36c546d`.
Do not cherry-pick just C6's last commit: it only contains the partial fix round.

## Integration notes

- **Shared files:** all three change `src/App.tsx`, `src/lib/repoNav.ts`, its tests, and
  `src/styles/index.css`. Combine routes, tabs and stylesheet imports; do not take one whole side and
  accidentally remove Health, Session or another task's routes. Preserve agent-repository restrictions
  and permission-filtered settings navigation. Add shipped pages to global search as appropriate.
- **C6:** contains the branch page, SVG map, merge queue, cleanup policy, and partial safety fixes.
  Cho's `60a2bc7` already refuses protected/in-use branch deletion using `landTargetIs(name)`.
  Reconcile C6's `openPullsUsing` helper with that behavior rather than overwriting it. Complete and
  verify the `BranchInfo.inUse`/`usedBy` contract and UI deletion gate. The saved `MainCard` still stores
  the revert confirmation as a boolean; capture the selected target so a background refresh cannot
  change which merge the user confirms. Recheck shared pull-state wording and existing C5 deletion gates.
- **Health:** Cho removed the old branch-map placeholder and links to the absent Branches page.
  Once C6 is integrated, add `<BranchMap compact />` to Health and restore useful Branches links
  (see `ee56cc8` for the removed links). Keep map overflow inside its container on mobile.
- **C7:** includes Live, repository Audit, shared AuditLog and live connection/clock helpers. Its
  `CoderChip.tsx` and `coder.ts` additions are byte-identical to the current shared branch despite older
  ancestry. Preserve the reviewed session identifiers and navigation, and retain instance Admin Audit.
  Verify filters, paging, reconnect/offline states and pause/resume behavior.
- **C11:** includes General, Collaborators, Agents, Rules and Danger sections plus draft synchronization.
  Saved Rules copy already says protected branches do not stop direct pushes; retain that truthful
  distinction. Verify permission gates, unsaved drafts, save/error states, reviewer settings, and rules
  against current backend behavior.

## Verification and remaining scope

This handoff publishes existing work; it does not certify these three WIP implementations as finished.
No source code was changed to publish them and no new application test result is claimed here.
The earlier 122-file / 1,876-test pass, typecheck, build and limited browser smoke checks apply to the
reviewed `29b4746` baseline, before Cho's later fixes and before these three pages are integrated.

After completing each task, run relevant tests and `yarn typecheck`; after integration, run the full
`CI=1 yarn test`, `yarn typecheck`, `yarn build`, and formatting checks. Complete the route/link sweep,
desktop/mobile theme QA and whole-branch review described in the remaining-work plan. The new pages
need actual interaction checks, not just a successful build.

Use the existing setup/configuration documentation for a new development machine. Configure local
resources and credentials there; do not copy secrets into Git. The dev environment uses remote Artifacts,
so reuse an appropriate dev namespace and follow the existing demo-seeding instructions.

Production deployment and production migrations still require an explicit instruction. Publishing these
snapshots does not merge them or deploy the redesign.
