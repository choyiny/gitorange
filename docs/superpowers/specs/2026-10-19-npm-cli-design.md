# GitOrange from npm: install, upgrade, adopt without a clone

Status: draft for approval, revised 2026-10-21. Builds on the deterministic installer (spec
`2026-10-16-deterministic-install-design.md`, PR #80) and tags and releases in GitOrange (spec
`2026-10-20-releases-design.md`, PR #81), both on `main`.

Blueprint: the saasmail npm CLI, already shipped and used on nine live installs (spec
`~/workspace/saasmail-install/docs/superpowers/specs/2026-10-17-npm-cli-design.md`, code in
`~/workspace/saasmail-install/scripts/saasmail/`, published as `saasmail` 1.2.x). Where this document says "as
saasmail", the behaviour, flags, messages and file layout follow that implementation, renamed; the builder reads that
code rather than re-deriving it. Lessons saasmail learned live (section 9) are requirements here too.

## Why

Lower the barrier to running GitOrange, and move existing deploys onto the same path. Today an operator clones the
repo, installs yarn and dependencies, and runs `yarn gitorange install` from the checkout.
The goal: someone with Node, Docker, a Cloudflare account and a domain runs `npx gitorange install` and ends with a
working instance; later `npx gitorange@latest upgrade` moves it to a new release. The operator's own instance
(`git.xyspace.dev`, deployed by hand from `main`, no installer state) is taken over with `adopt` and upgraded the
same way. Both audiences matter (operator, 2026-10-19).

## Goals

- `npx gitorange install` does everything `yarn gitorange install` does (same questions, preflight, plan, digest
  binding, resume, secrets, setup code, migrations, deploy, verify) from the published package alone.
- `npx gitorange upgrade` moves an install to the package's version: plan, confirm, migrations, deploy, verify.
- `npx gitorange adopt` takes over an install made from a clone (`--from <checkout>`) or by hand (`--worker <name>`),
  so `upgrade` works for it afterwards. `git.xyspace.dev` is the first real case.
- `npx gitorange status` shows the install, as today, plus "running X, latest Y".
- Each npm version maps to one GitOrange release of `choyiny/gitorange` (cut on git.xyspace.dev), published by the
  operator from their own machine (section 9).

## Non-goals

- Customising GitOrange through the CLI. Anyone changing code forks the repo and deploys from it.
- Downgrades or rollback (D1 migrations only go forward).
- Uninstall (later).
- Changing the in-repo flow: `yarn gitorange install|status` from a checkout keeps working.
- Running without Docker. No "skip Actions" mode (operator, 2026-10-19).

## Anti-goals (a failure even if it works)

- An upgrade or adopt that regenerates, overwrites or deletes an existing secret (including the R2 upload keys and
  `SETUP_CODE_HASH`).
- Any command that touches a resource it cannot show belongs to this install.
- A package whose deployed code differs from the tagged commit it claims to be.
- Asking the operator to paste a secret anywhere but a masked prompt in their own terminal.
- Starting to change Cloudflare and then failing because Docker is missing.

## 1. Docker

Deploying GitOrange builds the Actions runner image (`actions/runner/Dockerfile`, the `containers` entry in the
config) on the operator's machine, so every command that deploys needs Docker. Operator's decision: no Docker, no
deploy; the CLI errors out with a clear message.

- `install` (including `--resume` that will still deploy) and `upgrade` check Docker in preflight, before the plan is
  shown and before anything is written. Two distinct failures, each with what to do:
  - not installed (`docker` not on PATH): "Docker is not installed. GitOrange runs Actions jobs in containers, and
    deploying builds the runner image with Docker. Install Docker Desktop (https://docs.docker.com/get-docker/), start
    it, then run the same command again."
  - installed but the daemon is not answering (`docker info` fails): "Docker is installed but not running. Start
    Docker Desktop (or the Docker daemon), then run the same command again."
- `--plan` runs the same check and reports it as a preflight failure (a plan that cannot be applied is not shown as
  ready).
- `adopt` and `status` do not need Docker and do not check it.
- The install-cli preflight already checks `docker info`; this splits it into the two cases above and adds it to
  `upgrade`.

## 2. The package

As saasmail section 1, renamed:

- Name `gitorange` on npm (unscoped; free as of 2026-10-19), `bin: { gitorange: ... }`.
- Contents: the installer compiled to plain JavaScript; the built worker and SPA assets; `migrations/`;
  `wrangler.jsonc.example` (the template); the Actions runner build context (`actions/runner/`, everything its
  Dockerfile needs) so wrangler can build the image from the package; wrangler pinned as a runtime dependency. Nothing
  else from the repo.
- The shipped worker carries no per-install value; everything per install comes from the generated config at deploy.
  The builder verifies the built bundle deploys with a config different from the one it was built with.
- Wrangler runs from the package's own dependency, never through yarn or a global install.
- Node floor follows wrangler, declared in `engines`.

## 3. Where things live

As saasmail section 2: `~/.gitorange/<slug>/` holds the generated `wrangler.jsonc`, state file and lock;
`GITORANGE_HOME` overrides it; 0700/0600. Package paths in the generated config (worker bundle, assets, migrations,
runner image context) are rewritten each run and normalised out of the hand-edit and drift comparisons. A "source"
abstraction (checkout vs package) decides paths, version, how wrangler runs, whether deploy builds first, and every
printed command (`npx gitorange@<version> …` from the package).

State gains `"adopted"` ownership, upgrade transitions (resumable), `movedTo`, `adoptedAt`, `deployedVersion`, as
saasmail.

## 4. Versions

As saasmail section 3:

- Package version = release tag (`v1.0.0` → `1.0.0`), stamped by `release:publish`; the package deploys `GITORANGE_VERSION` = that
  version and records its commit (`gitorangeCommit`).
- `/.well-known/gitorange` (already reporting `version` on `install-cli`) is how upgrade and status read what runs.
- Comparison: semver directly; a commit through GitHub's public compare API on `choyiny/gitorange`; diverged, dirty,
  unknown or offline = custom code (section 6). A running instance without `/.well-known/gitorange` (anything deployed
  before `install-cli`, including `git.xyspace.dev` today) reports "unknown", which is custom code.
- "Latest" = npm's `latest` dist-tag, short timeout, never fails.

## 5. `install`

Same as `yarn gitorange install` (all its flags and prompts, including the Artifacts namespace, AI, R2 upload keys and
setup code), using the package source and `~/.gitorange/`, plus the Docker check of section 1.

## 6. `upgrade`

As saasmail section 5 (find install, lock, read well-known, installation-id check with the adopted-not-yet-upgraded
exception, refuse downgrade, digest-bound plan listing version A → B, migrations, new resources, new secrets, config
changes, with the "migrations cannot be undone" line; confirm; regenerate config refusing hand edits; find-or-create
new resources; generate only missing secrets into `--secrets-file`; migrate; deploy; verify; record each step;
`--resume`), plus:

- Docker check in preflight (section 1).
- Custom code stops without `--replace-custom-code`, as saasmail section 5a.
- GitOrange-specific resources the new version may need and an adopted install may lack are created with slug-derived
  names: buckets, workflows, queues, the Artifacts namespace if none is bound. The containers application follows the
  worker, as in install.
- Durable Object classes: the generated config's Durable Object declarations (GitOrange uses `exports` with SQLite
  storage, not saasmail's migration tags) must match what the deployed worker already has, so an adopted worker's
  classes are never treated as new or deleted. The builder confirms how wrangler reconciles this for an adopted worker
  before the first live upgrade.
- Secrets the operator types (the R2 upload keys, `CF_ANALYTICS_TOKEN`): install already treats them as optional. A
  missing one never blocks an upgrade: in a terminal, upgrade offers the same masked prompt and check as install
  (skippable); with `--yes` it deploys without it and lists it as missing, with the command that adds it later. Pasted
  values are not part of the plan digest. _(my call)_
- `SETUP_CODE_HASH` is never added by upgrade. It belongs to a fresh install with no admin. _(my call)_
- The containers application keeps the name it was adopted with; upgrade never renames or replaces it. _(my call)_

## 7. `adopt`

As saasmail section 6:

- `--from <checkout>` moves a checkout's `.gitorange/<id>.json` and generated config into `~/.gitorange/<slug>/` and
  marks the checkout's state moved, so the in-repo CLI refuses to deploy from it.
- `--worker <name> --account <id>` reads the deployed worker's bindings, vars and secret names from the Cloudflare
  API, checks every bound resource exists (D1, the three R2 buckets, queues, workflows, Durable Objects, the
  containers application, the Artifacts namespace), maps them onto the installer's inputs and names (taken as found,
  recorded `"adopted"`), shows it as a digest-bound plan, and writes only `~/.gitorange/` when confirmed. Never deploys,
  never reads or regenerates secrets, never changes Cloudflare. Anything it cannot map stops before writing.
- A bound resource whose existence the public API cannot confirm (possibly the Artifacts namespace or the
  containers application) is accepted as found and marked "bound, not verified" in the plan, rather than stopping.
  The binding on a worker the operator named is the ownership proof, as for the other adopted resources.
  _(my call)_
- Vars the current release no longer reads are listed as dropped at the first upgrade, and localhost-only trusted
  origins are a drop, not a stop (saasmail 1.2.1).
- `git.xyspace.dev` runs unmodified `main` (operator, 2026-10-19), so its first upgrade uses `--replace-custom-code`
  only because its version is unknown.
- After adopt, `git.xyspace.dev` only ever runs releases (operator, 2026-10-20): deploying unreleased `main` there
  stops. CLAUDE.md's deploy rule and `docs/updating.md` change to "cut a release, then `npx gitorange upgrade`".
  Waits on tags and releases in GitOrange itself (separate design, built first).

## 8. `status`

As today, from `~/.gitorange/` (or `--from <checkout>`), plus running version and npm latest.

## 9. Publishing and docs

Operator's decision, 2026-10-21: publish from their own machine for now. GitOrange Actions has no secrets store, so no
CI job can hold an npm credential safely, and npm trusted publishing only accepts GitHub Actions or GitLab. A later
"Actions secrets" feature can replace this step without changing anything else here.

- A release is cut in GitOrange (the Releases tab or `gitorange_create_release`), which creates the `vX.Y.Z` tag on
  git.xyspace.dev. Nothing publishes on its own.
- `yarn release:publish vX.Y.Z`, run by the operator in their own terminal:
  1. Refuses unless the tag exists on `origin` (git.xyspace.dev) and is a GitOrange release
     (`GET /api/repos/choyiny/gitorange/releases/vX.Y.Z`, read with the operator's token or a public read; builder's
     call), and unless that version is not already on npm.
  2. Checks out the tag into a fresh temporary worktree (never the operator's working copy), `yarn install
--frozen-lockfile`, builds, runs the CLI tests and the package smoke test, and packs with `version` = the tag
     and `gitorangeCommit` = the tag's commit.
  3. Shows what will be published (name, version, commit, file count, size) and runs `npm publish --access public`
     from the packed directory. npm asks for the operator's 2FA code in their terminal; the script never reads,
     stores or passes it.
  4. Removes the worktree.
     No provenance (that needs CI); the package records its commit instead.
- The first real publish creates the `gitorange` package; no placeholder and no trusted-publisher setup.
- A `pack` script builds the package locally; a CI check runs it and smoke-tests the installed package
  (`gitorange --help`, `install --plan` against fakes, no Docker) on pull requests on git.xyspace.dev and on the
  mirror. _(my call)_
- Version comparison (section 4) uses GitHub's public compare API on the mirror, so the mirror's `main` must include a
  running commit for it to be placed; pushing `main` to the mirror after merges (already the practice) covers it.
- Docs: `docs/setup.md`, a new `docs/updating.md`, README and the `gitorange-onboarding` skill lead with
  `npx gitorange install|upgrade|adopt`; the clone flow stays for forks. CHANGELOG entry. CLAUDE.md's installer note
  mentions the package.

## 10. Lessons from saasmail's live run (requirements)

- DNS reads go through public DNS (Cloudflare DoH), not the zone DNS API: `wrangler login` cannot grant
  `dns_records:read`.
- Wrangler run from inside a directory with its own `wrangler.jsonc` (such as a GitOrange checkout) can pick up the
  wrong context; the package runs wrangler from its own state folder.
- `npx` may serve a stale registry cache right after a release; docs mention `--prefer-online`.
- Plan output stays identical between `--plan` and the printed apply command (digest stability).

## 11. Testing

As saasmail section 9 (both sources, version comparison, upgrade paths, adopt from checkout and worker, package smoke
test), plus: Docker not installed vs not running (each message, nothing written, plan not marked ready); upgrade's
Docker check; adopt and status run without Docker; adopt of a worker with Durable Objects, containers and an
Artifacts namespace.

## Calls made without the operator (check these)

- Package name `gitorange`, unscoped; state in `~/.gitorange/`, `GITORANGE_HOME` override.
- The first public release is `1.0.0`.
- `release:publish` builds from a fresh worktree of the tag, never the working copy, and refuses a tag that is not a
  GitOrange release or a version already on npm.
- The runner image is built locally by wrangler from the shipped build context, not pre-built in CI.
- Adopt never deploys; the first upgrade does.
- This work extends the installer on `main` (`scripts/gitorange/`), not a rewrite.
