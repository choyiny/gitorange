---
name: gitorange-onboarding
description: Interactive setup wizard for deploying your own GitOrange instance to Cloudflare. Use when the user wants to set up, install, deploy, or get started with GitOrange, configure its Cloudflare resources or wrangler.jsonc, or says "onboarding", "setup", or "deploy gitorange".
---

# GitOrange onboarding wizard

Deploy a production GitOrange instance to **the user's own Cloudflare account**. This wizard is deployment-only; local development is covered in `docs/development.md`. The project's "humans deploy" rule is satisfied here because the user is running this wizard and confirms before anything is created — never deploy outside it.

## Before you start

Read `wrangler.jsonc.example` in the project root. It is the source of truth for the config shape you will fill in.

## What the user is signing up for

Tell the user this before touching anything, so they can back out cheaply:

- **~15 minutes**, longer if their sending domain still needs DNS verification.
- **One decision**: which hostname the instance runs on (custom domain or `*.workers.dev`), and which email domain sends invitations.
- **Cost**: the Cloudflare **Workers Paid** plan (about 5 USD/month) is required, because Artifacts is not on Workers Free. It includes 10,000 Artifacts operations and 1 GB of storage per month; beyond that, 0.15 USD per 1,000 operations and 0.50 USD per GB-month.

<!-- Never write a dollar sign followed by a digit in this file: Claude Code replaces those with the skill arguments. Write amounts as "5 USD". -->

## Preflight checkpoints (hard gates)

Confirm each **explicitly** — ask or check, don't assume. If any fails, stop and help resolve it before creating anything.

### Checkpoint 1 — Tooling

```bash
node --version    # v20+
yarn --version
```

Then `yarn install`. Use `yarn wrangler ...` for every wrangler command so the project's pinned version is used.

### Checkpoint 1.5 — Docker

```bash
docker info --format '{{.ServerVersion}}'
```

Deploying builds the Actions runner image, so Docker must be running. If it isn't, ask the user to start Docker Desktop (or their Docker daemon) and wait.

### Checkpoint 2 — Cloudflare login

```bash
yarn wrangler whoami
```

If not logged in, the user runs it themselves (it opens a browser): ask them to type `! yarn wrangler login`. If whoami lists several accounts, ask which one to deploy to and use its ID as `CLOUDFLARE_ACCOUNT_ID` for the checks below.

### Checkpoint 3 — Workers Paid plan

Ask: "Is this account on the **Workers Paid** plan?" If not, send them to https://dash.cloudflare.com/?to=/:account/workers/plans and wait.

### Checkpoint 4 — Artifacts access

```bash
CLOUDFLARE_ACCOUNT_ID=<id> yarn wrangler artifacts namespaces list
```

- A table or "No Artifacts namespaces found" → access is enabled.
- `Access denied [code: 10004]` → Artifacts (open beta, Workers Paid) isn't usable from this login. Check, in order: the account ID is the one they chose, the account is on Workers Paid (Checkpoint 3), and the wrangler login has Artifacts scopes (`! yarn wrangler login` again). Stop until this check passes — nothing else in GitOrange works without Artifacts.

### Checkpoint 5 — Email Sending domain

```bash
CLOUDFLARE_ACCOUNT_ID=<id> yarn wrangler email sending list
```

Ask which listed domain should send invitation emails, and the address to use (e.g. `noreply@example.com`). If the domain they want isn't listed, they can onboard it at https://dash.cloudflare.com/?to=/:account/email-service (or `yarn wrangler email sending enable <domain>`). This is not a hard stop: invitations still work by copying the link from the admin page; only the email won't send. Record their choice.

### Final confirmation

Restate, then wait for an explicit yes:

> You've confirmed account `<name>` (`<id>`) is on Workers Paid with Artifacts access, and invites will come from `<FROM_EMAIL>`. I'm about to create a D1 database named `gitorange-db` and R2 buckets named `gitorange-lfs`, `gitorange-actions-logs`, and `gitorange-actions-cache`, deploy a worker named `gitorange`, and set its auth secret. Ready?

## Deployment steps

Run straight through; pause only for decisions or credentials.

### Step 1: Hostname

Ask: custom domain (e.g. `git.example.com`, the zone must be on Cloudflare) or the free `gitorange.<subdomain>.workers.dev`? If custom, uncomment `routes` in Step 3. Record `BASE_URL` as `https://<hostname>`. For workers.dev, the exact URL is printed by the first deploy; use a placeholder now and fix it in Step 6.

### Step 2: Create D1 and the R2 buckets

```bash
yarn wrangler d1 create gitorange-db
yarn wrangler r2 bucket create gitorange-lfs
yarn wrangler r2 bucket create gitorange-actions-logs
yarn wrangler r2 bucket create gitorange-actions-cache
yarn wrangler r2 bucket lifecycle add gitorange-actions-cache expire-7d --expire-days 7 -y
```

Capture the `database_id`. `gitorange-actions-logs` holds Actions step logs; `gitorange-actions-cache` holds the Actions cache, and its lifecycle rule expires entries after 7 days. If any already exists, get the ID from `yarn wrangler d1 list` / confirm the bucket with `yarn wrangler r2 bucket list`. No Artifacts resource needs creating: the `gitorange` namespace is created with the first repository.

### Step 2.5: R2 API token for Git LFS (the user does this in the dashboard)

Git LFS hands clients pre-signed R2 URLs, which need S3-compatible credentials. Wrangler can't create them, so ask the user to:

1. Open https://dash.cloudflare.com/?to=/:account/r2/api-tokens → **Create API token**.
2. Permission **Object Read & Write**, scoped to **Apply to specific buckets only → gitorange-lfs and gitorange-actions-cache** (Git LFS and the Actions cache both use pre-signed URLs).
3. Keep the **Access Key ID** and **Secret Access Key** for Step 5. Never ask them to paste the values into the chat.

If they want to skip LFS for now, continue: everything else works, and Git LFS answers "not configured" until the two secrets are set.

### Step 3: Write `wrangler.jsonc`

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

Fill in the top level (production):

- `account_id`
- `d1_databases[0].database_id`
- `routes` — uncomment with the custom hostname, keep `custom_domain: true` (custom domain only)
- `vars.BASE_URL`, `vars.FROM_EMAIL`
- `vars.R2_ACCOUNT_ID` — the same account ID (keep `LFS_BUCKET_NAME` as `gitorange-lfs` unless they named the bucket differently)

Also replace the `FROM_EMAIL` and `R2_ACCOUNT_ID` placeholders in `env.dev.vars` so local development works later.

Do not rename bindings — the code looks them up by name: `DB`, `ARTIFACTS`, `EMAIL`, `LFS`, `ACTIONS_LOGS`, `ACTIONS_CACHE`, `ACTIONS_RUN`, `JOB_RUNNER`, `ASSETS`. Keep the `containers`, `durable_objects`, `exports`, and `workflows` entries as shipped: they run GitOrange Actions. Keep `assets.run_worker_first` as shipped; the git endpoint depends on it. `wrangler.jsonc` is gitignored; never commit it.

### Step 4: Migrate and deploy

```bash
yarn db:migrate:prod
yarn deploy
```

### Step 5: Secret

```bash
openssl rand -hex 32 | yarn wrangler secret put BETTER_AUTH_SECRET
```

The worker exists now, so this applies non-interactively and rolls out a new version with the secret. Sign-in fails until this step runs.

If they created the R2 token in Step 2.5, have the user set both values themselves (each prompts for the value, so the secret never passes through the chat):

```
! yarn wrangler secret put R2_ACCESS_KEY_ID
! yarn wrangler secret put R2_SECRET_ACCESS_KEY
```

### Step 6: Fix `BASE_URL` for workers.dev (workers.dev only)

If they chose workers.dev, set `vars.BASE_URL` to the URL `yarn deploy` printed and run `yarn deploy` again. Auth rejects requests from origins that don't match `BASE_URL`.

### Step 7: Verify end to end

1. Open `BASE_URL`. It must show **Welcome to GitOrange**. Tell the user: **the account created here becomes the site admin, and setup closes forever after** — do it now, before sharing the URL.
2. Have them create a repository with **Add a README file** checked. If creation fails with an Artifacts error, recheck Checkpoint 4 and `account_id`.
3. Have them create a token (avatar → **Personal access tokens**) and run `git clone <BASE_URL>/<username>/<repo>.git`, using the token as the password.
4. If the R2 secrets are set and they have [git-lfs](https://git-lfs.com) installed: in the clone, `git lfs install && git lfs track "*.bin"`, add a file, commit, and `git push`. The file's page in the UI should say **Stored with Git LFS** and offer a download.
5. Have them invite themselves at a second address (**+ → Invite member**) and confirm the email arrives. If it doesn't, the `FROM_EMAIL` domain isn't verified for Email Sending — the invite link on the admin page still works meanwhile.

## Completion summary

Report, with real values substituted:

- Worker `gitorange` live at `<BASE_URL>`
- D1 database `gitorange-db` (binding `DB`), migrations applied
- Artifacts namespace `gitorange` (binding `ARTIFACTS`) — repositories appear there as they're created
- Invitations sent from `<FROM_EMAIL>` (binding `EMAIL`)
- R2 bucket `gitorange-lfs` (binding `LFS`) for Git LFS — R2 secrets `<set | not set yet>`
- GitOrange Actions: Workflow `gitorange-actions-run`, `JobRunner` containers, logs in R2 bucket `gitorange-actions-logs`, cache in `gitorange-actions-cache`
- Admin account `<username>`
- To update later: `git pull && yarn install && yarn db:migrate:prod && yarn deploy`

## Common issues

- **`Access denied [code: 10004]`** — wrong `account_id`, account not on Workers Paid, or a wrangler login without Artifacts scopes.
- **Auth errors / "invalid origin" after deploy** — `BASE_URL` doesn't match the URL in the browser (common on workers.dev before Step 6).
- **Custom domain shows a Cloudflare error page** — `routes` wasn't uncommented, or the zone isn't on this Cloudflare account.
- **Invitation email never arrives** — `FROM_EMAIL`'s domain isn't verified in Email Sending; check `yarn wrangler email sending list`.
- **`git push` 403** — the user isn't owner, site admin, or collaborator on that repository.
- **`git lfs push` says LFS isn't configured** — `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` aren't set.
- **LFS upload fails with `SignatureDoesNotMatch` / `AccessDenied`** — the R2 token lacks Object Read & Write on the bucket, or `R2_ACCOUNT_ID` / `LFS_BUCKET_NAME` don't match it.
