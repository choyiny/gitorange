# Deterministic install: `yarn gitorange install` sets up an instance with a plan, not a conversation

Status: design agreed in conversation, 2026-10-16. Modelled on `void platform install`
(github.com/voidzero-dev/void, `packages/void/src/cli/platform-*.ts`, read at `f2a6c30`).

## Problem

A first GitOrange deployment today runs through the `/gitorange-onboarding` Claude skill: Claude reads
`wrangler.jsonc.example`, runs `wrangler d1 create` and `r2 bucket create`, copies the returned IDs into a hand-filled
`wrangler.jsonc`, deploys, runs `scripts/do-namespaces.mjs`, deploys again, sets `BETTER_AUTH_SECRET`, and (on
workers.dev) fixes `BASE_URL` and deploys a third time. Every run is a fresh interpretation of prose, so two people
following it can end up with different names, a missed step, or a config that drifted from the template. A rerun
after a failure means working out by hand what already exists. And the instance is open to whoever reaches the URL
first: the first account created becomes the site admin.

## Goal

Someone who has a Cloudflare account and a fresh clone, and has never deployed GitOrange, runs one command, answers
a few questions, reviews a plan, and ends with a working instance and a one-time code that only they can use to
claim the admin account. The same inputs always produce the same names, the same `wrangler.jsonc` and the same plan.
An interrupted run is resumed with a printed command and continues where it stopped, creating nothing twice and
never touching a resource it did not create.

## Non-goals (this PR)

- `upgrade`, `uninstall`, drift detection ("edited in the dashboard"), and version rollback. They come in later PRs
  and reuse the state file and plan model defined here; the design leaves room for them (§9).
- Adopting an existing hand-configured instance (such as git.xyspace.dev). The plan stops on its resources as
  "exists but not created by this installation" and changes nothing; a later `--adopt` handles them.
- Creating Cloudflare zones, DNS records beyond what a Workers custom domain creates, Access/Zero Trust, or email
  domain onboarding. Missing prerequisites stop the run with a link.
- Local development setup (`docs/development.md`, `env.dev`) — the installer writes only the top-level (production)
  part of `wrangler.jsonc` and keeps an existing `env` block as it is.
- Reimplementing Worker uploads. Wrangler stays the deploy tool.

## Anti-goals

- An installer that "usually works": any nondeterminism (names from timestamps, plans that depend on list order,
  prompts whose defaults change) is a bug.
- Silently taking over or overwriting anything the installer can't prove it created — a bucket, a database, a worker,
  or a hand-written `wrangler.jsonc`.
- Secrets in argv, in the state file, in the plan output, or in Claude's context.

## 1. Shape

- `yarn gitorange <command>` runs `scripts/gitorange/cli.ts` (TypeScript run by Node 22's type stripping, or `tsx`
  — builder's call; the project already requires Node 20+, the skill checks it). Commands in this PR: `install`
  (with `--plan` and `--resume`) and `status`.
- Pure parts (naming, plan, config generation, state transitions) are separate modules with no I/O, unit-tested.
  I/O sits behind two small interfaces — a Cloudflare REST client and a process runner (wrangler, docker) — so tests
  drive the whole install against fakes.
- Tests: a Node-environment Vitest project for `scripts/gitorange/` (it is not Worker code, so it doesn't run in
  workerd), added to `yarn test`. Worker-side changes (§7) get workerd tests under `worker/src/__tests__/` as usual.

## 2. Inputs

Asked in this order, each with a flag (and, for secrets, an env var) so CI never hits a prompt:

| Prompt             | Flag                                   | Default / validation                                                                            |
| ------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Installation name  | `--name`                               | `gitorange`; lowercase slug, 3–30 chars, `[a-z0-9-]`, no leading/trailing hyphen                |
| Cloudflare account | `--account` (id or name)               | skipped when the login sees one account                                                         |
| Hostname           | `--hostname <host>` or `--workers-dev` | custom: the zone must exist in the account and be active                                        |
| Invitation sender  | `--from-email` / `--no-email`          | must be on a domain listed by Email Sending; choosing none is allowed (invite links still work) |

One helper, `collect(key, flag, env, prompt, validate)`: flag → env → saved draft → prompt in a terminal → otherwise
fail naming the flag. Without a terminal, any apply needs `--yes`; `--plan` never does.

Credentials: the installer uses wrangler's login (`wrangler auth token`, as `do-namespaces.mjs` already does) or
`CLOUDFLARE_API_TOKEN` when set. There is no token to create for the core install. If there is no login and there is
a terminal, it tells the user to run `yarn wrangler login` and stops (it does not open a browser itself).

Optional credentials, offered after the plan is approved and skippable:

- **R2 S3 keys for Git LFS and the Actions cache** (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`): the installer opens
  a prefilled `dash.cloudflare.com/<account>/r2/api-tokens/create?…` link (void: `platform-setup.ts:224-239`), prints
  which buckets to scope it to, and reads the two values with masked prompts (or `GITORANGE_R2_ACCESS_KEY_ID` /
  `GITORANGE_R2_SECRET_ACCESS_KEY`).
- **Usage & cost analytics token** (`CF_ANALYTICS_TOKEN`): a prefilled API-token link with
  `permissionGroupKeys=[{"key":"account_analytics","type":"read"}]` (void: `platform-setup.ts:91-150`), masked prompt
  or `GITORANGE_CF_ANALYTICS_TOKEN`.

Each is validated with one harmless call before it is stored (R2: a `ListObjectsV2` on the LFS bucket with the keys;
analytics: one GraphQL query for the account). A rejected value is asked for again; a skipped one is reported in the
final summary with the command to add it later (`yarn gitorange install --resume` asks again).

## 3. Preflight (read-only, before the plan is shown)

Each check maps a failure to one message saying what is missing and the link or command that fixes it; nothing is
created before all pass.

- Login works and sees the chosen account.
- **Artifacts**: list namespaces. `10004` → "Workers Paid and Artifacts access" message (today's Checkpoint 3/4).
- **R2 enabled**: list buckets. "not enabled" → link to R2 activation.
- **workers.dev subdomain** (workers.dev installs, and to compute the URL): `GET /accounts/{a}/workers/subdomain`.
  404 → "open Workers & Pages once".
- **Zone** (custom hostname): the zone covering the hostname is in this account and active; no other worker already
  owns the hostname as a custom domain or route.
- **Email Sending**: the sender's domain is listed (skipped with `--no-email`).
- **Docker** running (`docker info`), because the deploy builds the Actions runner image.
- **Workers AI / Containers / Workflows**: no separate probe; failures surface at deploy with wrangler's message.

## 4. Names and the plan

Names are a pure function of the installation name `<n>` (default `gitorange`, which reproduces today's documented
names exactly):

| Resource            | Name                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- |
| Worker              | `<n>`                                                                              |
| D1                  | `<n>-db`                                                                           |
| R2                  | `<n>-lfs`, `<n>-actions-logs`, `<n>-actions-cache` (+ 7-day expiry lifecycle rule) |
| Artifacts namespace | `<n>` (created by the first repository, nothing to provision)                      |
| Workflows           | `<n>-actions-run`, `<n>-merge-resolution`                                          |

The Actions cache expiry rule is scoped to the prefix `actions-cache/` (every cache key already lives there,
`worker/src/actions/cache.ts`), so it never deletes the bucket's ownership marker. _(Builder check; my call. The
manual steps in `docs/setup.md` change to the same prefixed rule.)_

Plan rows and stop rules cover the worker, D1, the three buckets and the two Workflows. A Workflow with our name that
is bound to a different script is a stop (deploying would take it over); one bound to our worker name is `reuse`. The
Containers application is named from the worker and follows the worker's row. An existing Artifacts namespace `<n>`
is shown as an info line ("existing Artifacts namespace reused"), not a stop: repositories are stored as
`r_<uuid>` and reached only through D1 rows, so a new instance can never see or overwrite an earlier one's
repositories. _(Builder check; my call.)_

`installationId = <n>-` + first 12 hex of `sha256(accountId, n, hostname)`, where `hostname` is the custom hostname,
or the fixed token `workers.dev` for workers.dev installs (the account's workers.dev subdomain can be renamed; the id
must not change). _(Builder check; my call.)_ A random 32-byte `ownershipNonce` is
made once when the draft is first saved. Resolved names are stored in the state file and read back on every later run,
never recomputed, so a future change to the naming rule never renames a live resource.

The plan is computed read-only from three inputs: desired (names + choices), observed (one list call per resource
type), recorded (the state file). For each resource:

| Observed            | Recorded / marker                                | Action                                                                                             |
| ------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| absent              | –                                                | `create`                                                                                           |
| present             | recorded with the same id, or carries our marker | `reuse` (worker: `deploy`)                                                                         |
| present             | not provably ours                                | **stop**: "`<name>` already exists and was not created by this installation. Nothing was changed." |
| absent              | recorded `ready`                                 | **stop**: "recorded but missing" (repair is a later command)                                       |
| more than one match | –                                                | **stop**                                                                                           |

Actions come out in a fixed order. The plan prints as one line per action (`create  d1  gitorange-db`), then the
hostname, the URL, the sender, and the final line "No Cloudflare resource or local file was changed." `--plan` exits
there, printing the exact `yarn gitorange install …` command that applies it.

Approval is never saved. The plan has a digest: the first 12 hex of `sha256` over the installation id and the ordered
`{action, kind, name}` list. `--plan` prints it, and the apply command it prints carries `--expect-plan <digest>`.
At apply time the plan is recomputed:

- With `--expect-plan`: the digest must match, or the run stops and prints the new plan and digest. This is how the
  onboarding skill hands a reviewed plan to a separate apply run.
- Interactive without it: the recomputed plan is shown and "Apply this plan?" is asked (default Yes).
- `--yes` without `--expect-plan` (CI that chose not to review): applies the recomputed plan, after printing it.

Immediately before each create, that one resource is looked up again. _(Builder check; my call.)_

## 5. State

**Local**: `.gitorange/<installationId>.json` (gitignored, mode 0600), written atomically (temp + rename) after every
change:

```jsonc
{
  "schemaVersion": 1,
  "installationId": "gitorange-1a2b3c4d5e6f",
  "ownershipNonce": "<64 hex>",
  "accountId": "…",
  "inputs": {
    "name": "gitorange",
    "hostname": "git.example.com",
    "workersDev": false,
    "fromEmail": "noreply@example.com",
  },
  "status": "planned | provisioning | deploying | verifying | installed | failed",
  "resources": [
    {
      "key": "d1",
      "kind": "d1",
      "name": "gitorange-db",
      "id": "…",
      "ownership": "created",
      "state": "ready",
    },
  ],
  "steps": [
    { "key": "provision-intent:d1", "at": "…" },
    { "key": "migrations:<digest>", "at": "…" },
  ],
  "baseUrl": "https://git.example.com",
}
```

No secret values are ever written here. A local lock file (`.gitorange/<id>.lock`, `O_EXCL`, with pid and host;
stale when the pid is gone) stops two runs at once. Status moves only along an explicit transition table.

**Remote**: one D1 table `install_state` (Drizzle schema, generated migration), a single row
`{installation_id, ownership_nonce, version, manifest_json, updated_at}`, written after migrations and at the end of
each later phase. It is the D1 database's ownership marker, the record `upgrade` will read on another machine, and
what `/.well-known/gitorange` (§7) reports.

**Steps are write-once idempotency keys**: rerunning a step with a recorded key skips it.

## 6. Apply

In order; each line is a recorded step:

1. Save the draft (status `planned`, nonce), take the lock.
2. **Provision**, for each `create`: record `provision-intent:<key>` → create → record the resource with its id →
   write the ownership marker. On a create race ("already exists"), look it up again and accept it only if its marker
   proves it is ours; otherwise stop. Markers:
   - D1: the `install_state` row (written in step 4; until then the provision intent plus the exact name stands in,
     and resume accepts a same-name database only when it is empty of tables).
   - R2: an object `.gitorange/ownership.json` holding `{installationId, ownershipNonce, key}` in each bucket (R2
     buckets have no id beyond the name, so this marker, not the recorded name, is what proves ownership).
   - Worker: a plain-text var `GITORANGE_INSTALLATION` = JSON `{installationId, ownershipNonce}` in the generated
     config, checked through the script's settings before deploying over an existing worker.
   - The Actions cache lifecycle rule is a full replace, so it is simply applied.
3. **Generate `wrangler.jsonc`** (§8).
4. **Migrate** D1 (`wrangler d1 migrations apply DB --remote`), then write the `install_state` row. Step key
   `migrations:<sha256 of the migrations/ file list and contents>`.
5. **Secrets**: generate `BETTER_AUTH_SECRET` (32 random bytes) only if `wrangler secret list` doesn't already show
   it; generate the setup code (§7) and its hash; add any optional credentials. All go in one 0600 temp file passed
   to `wrangler deploy --secrets-file` (supported by the installed wrangler 4.146; it adds the given secrets and
   keeps existing ones), deleted afterwards. Never regenerate `BETTER_AUTH_SECRET` on a rerun.
6. **Deploy** (`yarn deploy` with the generated config). The base URL is known before the first deploy (custom
   hostname, or `<n>.<account subdomain>.workers.dev` from preflight), so `BASE_URL` is right the first time.
7. **Durable Object namespace IDs**: read them from the API (as `do-namespaces.mjs` does), write them into the
   generated config, and deploy once more only if they changed. (A rerun finds them unchanged and skips the deploy.)
8. **Verify**: `GET <BASE_URL>/.well-known/gitorange` must return this `installationId` and the deployed `version`
   (retry for up to ~60 s while the custom domain's certificate is issued). Then `GET /api/setup/status` must report
   either setup pending with a code required, or setup already completed (an admin exists); setup pending _without_
   a code required is a failure.
9. Mark `installed`, release the lock, print the summary: URL, the setup code (printed once, see §7), what's set
   (D1, buckets, email sender, LFS keys, analytics token) and what was skipped with the command to add it.

On any failure: mark `failed`, keep everything created, print which step failed, what was **not** changed, and
`yarn gitorange install --resume`. `--resume` refuses inputs that differ from the recorded ones.

`--resume` on a `failed` or unfinished install continues from the first unrecorded step. On an `installed` one it
does only what was asked for or is still missing, and touches nothing else _(builder check; my call)_:

- skipped optional credentials (LFS keys, analytics token): asked again; if any are supplied, one
  `deploy --secrets-file` with just those, then verify;
- a lost setup code, only while no user exists: a new code and hash, one deploy, then verify and print the code;
- otherwise: verify only, and print "Nothing to do."

Provisioning, migrations and `BETTER_AUTH_SECRET` are never redone on an installed instance (that is `upgrade`'s
job). The status stays `installed` throughout; a failure here records the failed step without moving the install to
`failed`.

`status` prints the recorded state and checks `/.well-known/gitorange`; it never changes anything.

## 7. Worker changes: setup code and well-known endpoint

**Setup code.**

- The installer generates a code (e.g. 4 groups of 4 from an unambiguous alphabet, ~80 bits) and stores
  `sha256(code)` as the Worker secret `SETUP_CODE_HASH`. It prints the code once at the end, with
  `<BASE_URL>/setup`.
- `GET /api/setup/status` adds `codeRequired: boolean` (true when `SETUP_CODE_HASH` is set and no user exists).
- `POST /api/setup` takes `code`; when `SETUP_CODE_HASH` is set, a wrong or missing code is a 403 and nothing is
  created. Compare hashes in constant time. Attempts are rate-limited (builder's call on the mechanism).
- The welcome page (`src/pages/Setup.tsx`) asks for the code first when `codeRequired`.
- When `SETUP_CODE_HASH` is unset (existing instances, `yarn dev`), setup works exactly as today.
- Setup still closes forever once any user exists; the code is useless afterwards.
- A lost code: `yarn gitorange install --resume` while no user exists issues a new code and replaces the hash
  (recorded step `setup-code:<n>`).
- Site admin → Setup lists `SETUP_CODE_HASH` as optional and never shows its value.

**`GET /.well-known/gitorange`** (public, no auth, `run_worker_first` already covers `/.well-known/*`): returns
`{ installationId, version, schemaDigest }`. `installationId` comes from the `GITORANGE_INSTALLATION` var (null on
instances without it), `version` from the build (git commit or package version, builder's call, the same value the
installer expects), `schemaDigest` from `install_state` or the applied migration list. It exposes nothing secret.

Config files per CLAUDE.md: `GITORANGE_INSTALLATION` var and `SETUP_CODE_HASH` secret documented in
`wrangler.jsonc.example` (top level and `env.dev`), `wrangler.jsonc.ci`, `wrangler.test.jsonc` if tests need it,
`docs/configuration.md`; `yarn cf-typegen`.

## 8. Generated `wrangler.jsonc`

- Built from `wrangler.jsonc.example` (the template stays the single source of the binding shape) plus the state:
  `account_id`, D1 `database_name`/`database_id`, bucket names, workflow names, `routes` (custom domain, `custom_domain:
true`) or none, and the vars (`BASE_URL`, `FROM_EMAIL`, `R2_ACCOUNT_ID`, `WORKER_NAME`, `D1_DATABASE_ID`, the
  bucket/namespace/workflow name vars, the `*_NAMESPACE_ID`s, `GITORANGE_INSTALLATION`). Everything else is copied
  from the template unchanged.
- Generation is a pure function, unit-tested for byte-identical output from the same inputs.
- The file starts with a marker comment (`// Generated by yarn gitorange install (<installationId>). …`). The
  installer refuses to overwrite an existing `wrangler.jsonc` without that marker, saying how to move it aside; an
  existing `env` block in a marked file is preserved.
- The parse/edit approach (a JSONC parser such as `jsonc-parser` vs string templating) is the builder's call, so
  long as comments in the template survive.

## 9. Room for later commands

- `upgrade`: reads `install_state`, plans (`version A → B`, pending migrations), checks the migrations already applied
  are an exact prefix of `migrations/`, migrates, uploads a version, verifies with `/.well-known/gitorange`, rolls back
  to the previous version id on failure (void: `platform-installer.ts`, `platform-installer-database.ts:357-401`).
- Drift: refuse when the worker's `last_deployed_from` is `dash`/`api` unless confirmed in a terminal (void:
  `platform-installer-outside-changes.ts`).
- `uninstall`: deletes only `ownership: created` resources whose marker still matches, data kept unless
  `--purge-data`, confirmation defaulting to No.
- `--adopt` for existing hand-configured instances: writes markers onto resources the user names.

## 10. The onboarding skill and docs

- `/gitorange-onboarding` becomes a thin wrapper: explain cost and prerequisites (as today), run
  `yarn gitorange install --plan`, walk the user through the plan, run the apply (secrets entered by the user in
  masked prompts via `!`, never in chat), and interpret failures. The reviewer-agent and verification sections stay.
- `docs/setup.md` documents the command, flags, env vars, `--plan`/`--resume`, and the setup code; kept in sync with
  the skill.
- `scripts/do-namespaces.mjs` is folded into the installer and removed (or kept as a thin wrapper — builder's call).
- CLAUDE.md's architecture notes gain a line for `scripts/gitorange/`.

## Builder's calls

TypeScript runner (§1), prompt library (`@clack/prompts` suggested; void uses a clack fork), JSONC handling (§8),
the setup code's exact format and rate limiting (§7), and the `version` source (§7).

## Calls made after the builder check

Marked _(my call)_ in the text, for review:

1. The Actions cache expiry rule is scoped to `actions-cache/`, so the bucket's ownership marker survives (§4).
2. Plan rows cover the Workflows too (stop when bound to another script); an existing Artifacts namespace is reused
   with an info line (§4).
3. workers.dev installs hash the fixed token `workers.dev` into the installation id (§4).
4. A reviewed plan reaches a separate apply through `--expect-plan <digest>` (§4).
5. `--resume` on an installed instance only adds missing credentials or reissues a lost setup code (§6).
6. Secrets go through `wrangler deploy --secrets-file`, verified to exist in the installed wrangler (§6).
