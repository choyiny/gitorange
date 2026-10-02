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
- **Cost**: the Cloudflare **Workers Paid** plan (~$5/month) is required, because Artifacts is not on Workers Free. It includes 10,000 Artifacts operations and 1 GB of storage per month; beyond that, $0.15 per 1,000 operations and $0.50 per GB-month.

## Preflight checkpoints (hard gates)

Confirm each **explicitly** — ask or check, don't assume. If any fails, stop and help resolve it before creating anything.

### Checkpoint 1 — Tooling

```bash
node --version    # v20+
yarn --version
```

Then `yarn install`. Use `yarn wrangler ...` for every wrangler command so the project's pinned version is used.

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
- `Access denied [code: 10004]` → the account isn't in the Artifacts closed beta. Stop: they must request access at https://forms.gle/DwBoPRa3CWQ8ajFp7 and come back once approved. Nothing else in GitOrange works without it.

### Checkpoint 5 — Email Sending domain

```bash
CLOUDFLARE_ACCOUNT_ID=<id> yarn wrangler email sending list
```

Ask which listed domain should send invitation emails, and the address to use (e.g. `noreply@example.com`). If the domain they want isn't listed, they can onboard it at https://dash.cloudflare.com/?to=/:account/email-service (or `yarn wrangler email sending enable <domain>`). This is not a hard stop: invitations still work by copying the link from the admin page; only the email won't send. Record their choice.

### Final confirmation

Restate, then wait for an explicit yes:

> You've confirmed account `<name>` (`<id>`) is on Workers Paid with Artifacts access, and invites will come from `<FROM_EMAIL>`. I'm about to create a D1 database named `gitorange-db`, deploy a worker named `gitorange`, and set its auth secret. Ready?

## Deployment steps

Run straight through; pause only for decisions or credentials.

### Step 1: Hostname

Ask: custom domain (e.g. `git.example.com`, the zone must be on Cloudflare) or the free `gitorange.<subdomain>.workers.dev`? If custom, uncomment `routes` in Step 3. Record `BASE_URL` as `https://<hostname>`. For workers.dev, the exact URL is printed by the first deploy; use a placeholder now and fix it in Step 6.

### Step 2: Create D1

```bash
yarn wrangler d1 create gitorange-db
```

Capture the `database_id`. If it already exists, get the ID from `yarn wrangler d1 list`. No Artifacts resource needs creating: the `gitorange` namespace is created with the first repository.

### Step 3: Write `wrangler.jsonc`

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

Fill in the top level (production):

- `account_id`
- `d1_databases[0].database_id`
- `routes` — uncomment with the custom hostname, keep `custom_domain: true` (custom domain only)
- `vars.BASE_URL`, `vars.FROM_EMAIL`

Also replace the `FROM_EMAIL` placeholder in `env.dev.vars` so local development works later.

Do not rename bindings — the code looks them up by name: `DB`, `ARTIFACTS`, `EMAIL`, `ASSETS`. Keep `assets.run_worker_first` as shipped; the git endpoint depends on it. `wrangler.jsonc` is gitignored; never commit it.

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

### Step 6: Fix `BASE_URL` for workers.dev (workers.dev only)

If they chose workers.dev, set `vars.BASE_URL` to the URL `yarn deploy` printed and run `yarn deploy` again. Auth rejects requests from origins that don't match `BASE_URL`.

### Step 7: Verify end to end

1. Open `BASE_URL`. It must show **Welcome to GitOrange**. Tell the user: **the account created here becomes the site admin, and setup closes forever after** — do it now, before sharing the URL.
2. Have them create a repository with **Add a README file** checked. If creation fails with an Artifacts error, recheck Checkpoint 4 and `account_id`.
3. Have them create a token (avatar → **Personal access tokens**) and run `git clone <BASE_URL>/<username>/<repo>.git`, using the token as the password.
4. Have them invite themselves at a second address (**+ → Invite member**) and confirm the email arrives. If it doesn't, the `FROM_EMAIL` domain isn't verified for Email Sending — the invite link on the admin page still works meanwhile.

## Completion summary

Report, with real values substituted:

- Worker `gitorange` live at `<BASE_URL>`
- D1 database `gitorange-db` (binding `DB`), migrations applied
- Artifacts namespace `gitorange` (binding `ARTIFACTS`) — repositories appear there as they're created
- Invitations sent from `<FROM_EMAIL>` (binding `EMAIL`)
- Admin account `<username>`
- To update later: `git pull && yarn install && yarn db:migrate:prod && yarn deploy`

## Common issues

- **`Access denied [code: 10004]`** — no Artifacts beta access on that account, or `account_id` points at a different account than the one with access.
- **Auth errors / "invalid origin" after deploy** — `BASE_URL` doesn't match the URL in the browser (common on workers.dev before Step 6).
- **Custom domain shows a Cloudflare error page** — `routes` wasn't uncommented, or the zone isn't on this Cloudflare account.
- **Invitation email never arrives** — `FROM_EMAIL`'s domain isn't verified in Email Sending; check `yarn wrangler email sending list`.
- **`git push` 403** — the user isn't owner, site admin, or collaborator on that repository.
