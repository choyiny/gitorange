# Updating

GitOrange ships as an npm package, `gitorange`, that carries a built release and deploys it to your Cloudflare account with its own pinned wrangler. Installing and upgrading need Node.js 22 or later and Docker, running: deploying builds the Actions runner image.

Docker is checked first, before anything is planned or written. Without it you get one of two messages: `Docker is not installed.` (install Docker Desktop, start it, run the same command again) or `Docker is installed but not running.` (start it, run the same command again). `adopt` and `status` never check Docker.

## Install

```bash
npx gitorange install
```

See [Setup](setup.md) for the questions, the flags, and what it creates. State lives in `~/.gitorange/<name>/` (override the directory with `GITORANGE_HOME`).

## Upgrade

```bash
npx gitorange@latest upgrade
```

If `npx` offers an older version right after a release, its registry cache is stale: add `--prefer-online` (`npx --prefer-online gitorange@latest upgrade`).

`upgrade` moves an installation to the package's version. It reads the running version from the worker's `/.well-known/gitorange`, prints a plan (migrations to apply, resources and secrets to add, the deploy), and asks before applying.

- `--name <name>` picks the installation when several are recorded.
- `--plan` only shows the plan and prints the exact apply command, ending in `--expect-plan <digest> --yes`. The apply refuses if the plan has changed since you reviewed it.
- `--resume` continues an upgrade that failed part-way.
- `--yes` applies without asking; it is required outside a terminal.
- It never downgrades. If the worker runs a newer version it stops and prints the command for that version.
- It only adds secrets the worker lacks and never touches `SETUP_CODE_HASH`. The R2 upload keys and the analytics token are asked for in a terminal (leave one empty to skip it); with `--yes` the deploy goes ahead without them and lists them as missing, with the command that adds them later.
- If the worker runs code that is not a release (a fork, local changes), it stops before changing anything. `--replace-custom-code` replaces it with stock GitOrange. Forks keep deploying from their own checkout.

A deploy restarts any running Actions jobs (each restarts from the beginning, up to 3 attempts), so deploying when no CI is running avoids that.

## Adopt an existing installation

`adopt` takes over an installation that was made some other way, so `upgrade` can manage it. It changes nothing on Cloudflare.

From a checkout that ran `yarn gitorange install`, which moves its record under `~/.gitorange`:

```bash
npx gitorange adopt --from path/to/checkout
```

(`--name <name>` picks one when the checkout holds several.) Or a worker deployed by hand, read from Cloudflare:

```bash
npx gitorange adopt --worker <worker name> --account <id|name>
```

`--plan` shows what would be recorded; apply with `--expect-plan <digest> --yes`. APP_NAME, AI_GATEWAY and the model variables are kept as found.

## Status

```bash
npx gitorange status
```

Shows a recorded installation and asks the deployed worker whether it matches. `--from <checkout>` reads one that is still in a checkout.

## Forks and checkouts

If you run a fork or prefer a clone, the original flow works: `git pull && yarn install && yarn db:migrate:prod && yarn deploy` from your checkout, or `yarn gitorange install|status` there. Run the migrations before the deploy: new code may read new tables.

## Publishing a release (maintainers)

Releases come from the GitOrange instance that hosts the repository, and are published to npm from your own machine. npm asks for a one-time code, so this is never automated.

1. Cut a release in GitOrange (the Releases tab, or `gitorange_create_release`) from `main`. The Releases tab cuts from the default branch; `release:publish` refuses a tag that is not on `main`.
2. From a clone with `origin` and `main` up to date, run:

   ```bash
   yarn release:publish vX.Y.Z
   ```

   It checks with git, not the GitHub REST API, that the tag is on `origin` and on `main`, and that the version is not already on npm. It then builds that exact commit in a fresh worktree, runs the tests, packs the package, and checks the packed package as CI's Package job does: a dry-run deploy of the config an install would generate, and `gitorange --help` from the installed tarball. Any failure stops it before anything is asked. It then shows what it is about to publish and asks you to confirm. `npm publish` of that tarball follows, and npm asks for your 2FA code.

3. Upgrade the instance that runs this repository from the published package:

   ```bash
   npx --prefer-online gitorange@X.Y.Z upgrade --name gitorange
   ```

Cut, publish and upgrade only when a person says so.
