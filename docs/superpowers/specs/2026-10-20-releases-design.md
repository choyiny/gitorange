# Tags and releases: semantic versions cut from landed pull requests

Status: draft for approval, 2026-10-20.

## Why

GitOrange has no tags view, no releases and no record of what changed between versions. Every repository should get
semantic versioning and a changelog without anyone wiring up an Action or keeping a `CHANGELOG.md` by hand. The
immediate need: `npx gitorange` (spec `2026-10-19-npm-cli-design.md`, parked) deploys released versions only, so
GitOrange itself needs releases first, cut on `git.xyspace.dev`.

How saasmail does it today, for comparison: each PR ticks Major/Minor/Patch, a GitHub Action turns that into a label,
Release Drafter keeps a draft release updated on every merge, and a person publishes it. GitOrange does the same
first-party, in every repository, with no Action (operator, 2026-10-20).

## Goals

- Every pull request carries a version bump: `major`, `minor` or `patch` (operator).
- The bump does not change any version by itself; several PRs land between releases (operator).
- A person clicks a button, or an agent calls an MCP tool, to cut a release; only then does the version change
  (operator).
- The next version is inferred from the bumps on the PRs landed since the last release (operator).
- The changelog lives in GitOrange, outside the repository: the list of releases with their notes (operator).
- A tags view lists the repository's git tags.
- A release's tag starts any Actions workflow with `on: push: tags:`, as a pushed tag does today. No separate
  `release` event (operator, 2026-10-20).

## Non-goals

- A `release` Actions event (`on: release`), release assets or uploaded binaries.
- General-purpose PR labels. The bump is one field, not a labels system _(my call)_.
- Writing to `CHANGELOG.md` or any file in the repository (operator: keep it outside).
- Pre-release versions (`-rc.1`) and build metadata; plain `vX.Y.Z` only _(my call)_.
- Publishing to npm or deploying: that is a workflow on the tag, per repository.

## Anti-goals

- A release whose tag points at a commit other than the one its notes describe.
- A release that moves or overwrites an existing tag.
- Version numbers that go backwards or repeat.

## 1. The bump on a pull request

- `pull_requests.version_bump`: `major` | `minor` | `patch`, nullable.
- Set when opening a PR (a control on the new-PR form; an optional `version_bump` on
  `gitorange_create_pull_request` and the REST create route) and editable by anyone who can edit the PR's title, until
  the PR lands. Shown on the PR page.
- A PR that lands without one counts as `patch`, shown as "patch (default)" wherever unreleased changes are listed
  _(my call, matching saasmail's drafter default)_. Landing is never blocked by a missing bump.
- Changing it is audited (`recordAudit`) and recorded as a PR event.

## 2. Unreleased changes and the next version

- "Since the last release" = PRs landed onto the repository's current default branch (`land_target`) that are in no
  release's `release_pulls`. Decided from D1 alone, no history walk through Artifacts, so a rewritten branch or an
  old PR whose landed commit is gone cannot confuse it _(my call)_. Releases are cut from the default branch.
- Next version = latest release's version with the largest bump among them applied (`major` resets minor and patch,
  `minor` resets patch).
- The first release is a starting line (operator, 2026-10-20): the person types its version (suggested `v0.1.0`), its
  notes default to "First release." instead of a PR list, and every PR landed before it is recorded in its
  `release_pulls` without being listed, so the changelog starts from there. The Unreleased section of a repository
  with no release shows how many PRs have landed and the "Cut first release" button, not the list.
- The Releases page shows an "Unreleased" section at the top: each PR (number, title, author, bump), the version they
  would make, and the button to cut it. Nothing landed since the last release → no button, "Nothing to release".

## 3. Cutting a release

- Who: anyone with push access to the repository (`permissionsFor`), from the Releases page or the MCP tool
  `gitorange_create_release` (repository, optional `version`, optional `notes`, `head_sha` the caller saw, so a release
  never covers a PR the person did not see; a moved default branch returns 409 with the new head).
- What it does, in order:
  1. Resolve the default branch head (or check `head_sha`).
  2. Compute the version (section 2), or validate an override: `vX.Y.Z`, greater than the latest release, no existing
     tag of that name. When the computed version's tag already exists (pushed by hand), the cut stops with 409 naming
     the tag and asks for a typed version; it never skips ahead silently _(my call)_.
  3. Create the tag `vX.Y.Z` at that commit through Artifacts, compare-and-swap from "absent" (`ZERO_SHA`), so an
     existing tag is never moved. Annotated (tagger = the person, message = the release title) or lightweight is the
     builder's call; `git describe` and Actions see either.
  4. Write the `releases` row (below) with its notes.
  5. Call `onRefsUpdated` for the new tag, as `landPull` does for branches, so `on: push: tags:` workflows run.
  6. Audit (`release.created`), live ping the repository.
- Notes: generated from the PRs in the release, grouped Major / Minor / Patch, one line each
  (`- <title> (#<n>) @<author>`), plus a "Full changes" link comparing the previous tag to the new one. The page shows
  the generated notes for editing before publishing; the MCP tool takes `notes` to replace them. Editable afterwards.
- No drafts: a release is created published. The Unreleased section is the draft.

## 4. Data

- `releases`: id, repository id, tag name, version (major, minor, patch as integers, for ordering), commit sha,
  title (defaults to the tag name), notes (markdown), created by, created at, previous release id. Unique on
  (repository, tag). Deleted with the repository.
- `release_pulls` (release id, pull request id), written when the release is cut, so a release's contents never change
  later and a PR shows "Released in vX.Y.Z".
- Generated with `yarn db:generate`, never by hand.

## 5. Tags

- A Tags view (next to Branches) lists every tag from the ref advertisement: name, commit, date, and the release when
  there is one. Tags pushed with git appear too; only GitOrange-cut tags have releases.
- Releases cannot be deleted, only their title and notes edited. A workflow on the tag may already have published
  that version somewhere (npm refuses a version twice), so a version is never handed out again. Deleting tags stays a
  `git push --delete` _(my call)_.
- A tag pushed by hand that looks like a version (`vX.Y.Z`) is not a release and does not move "the latest release";
  versions are counted from releases only _(my call)_.

## 6. API, MCP, UI

- REST under `/api/repos/{owner}/{repo}`: `GET …/releases`, `GET …/releases/{tag}`, `GET …/releases/unreleased`
  (PRs + next version), `POST …/releases`, `PATCH …/releases/{tag}` (title, notes),
  `GET …/tags`. Zod-OpenAPI like the other routers; PR create/update gain `version_bump`.
- MCP: `gitorange_list_releases`, `gitorange_create_release`; `gitorange_create_pull_request` gains `version_bump`;
  `gitorange_get_pull_request` returns it.
- UI: a Releases tab on the repository (Unreleased section + release list = the changelog), a release page, the Tags
  view, the bump control on the new-PR form and PR page. Uses the existing design system (`components/ui/`).

## 7. Testing

Vitest in workerd (real D1, Artifacts fake): version arithmetic (each bump, default patch, first release, override
rules), "since last release" with PRs landed before and after a tag, CAS refusing an existing tag, a moved head
returning 409, permissions (no push access → 403), the tag queueing `push` runs with a `tags:` filter, notes grouping,
release contents frozen after more PRs land, MCP tools.

## Calls made without the operator (check these)

- One `version_bump` field on PRs, not a labels system; missing = patch; landing never blocked.
- Plain `vX.Y.Z`, no pre-releases.
- No drafts; Unreleased is the draft. Notes editable before and after.
- Hand-pushed version tags are not releases and do not count toward the next version.
- Releases cannot be deleted; versions are never reused.
- Unreleased = landed on the default branch and in no release (D1 only).
- A computed version whose tag already exists stops with 409 and asks for a typed version.
