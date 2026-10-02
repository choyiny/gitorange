# Setup

Deploy GitOrange to your own Cloudflare account. This takes about 15 minutes, most of it waiting on DNS if your sending domain isn't on Email Sending yet. The [`/gitorange-onboarding`](../.claude/skills/gitorange-onboarding/SKILL.md) Claude Code skill performs these same steps for you.

## Prerequisites

- A Cloudflare account on the **Workers Paid** plan (Artifacts is not available on Workers Free).
- **Artifacts** is in open beta and available on Workers Paid. Confirm with `yarn wrangler artifacts namespaces list` — it should print a table or "No Artifacts namespaces found".
- A domain onboarded to [Cloudflare Email Sending](https://dash.cloudflare.com/?to=/:account/email-service), used as the sender for invitation emails.
- Node.js v20+ and yarn.
- Docker, running, when you deploy: Wrangler builds the Actions runner image (`actions/runner/Dockerfile`).

## 1. Clone and install

```bash
git clone https://github.com/choyiny/gitorange.git
cd gitorange
yarn install
```

## 2. Authenticate with Cloudflare

```bash
yarn wrangler login
yarn wrangler whoami   # note your account ID
```

## 3. Create the D1 database and the R2 buckets

```bash
yarn wrangler d1 create gitorange-db
yarn wrangler r2 bucket create gitorange-lfs
yarn wrangler r2 bucket create gitorange-actions-logs
```

Copy the `database_id` it prints. The second bucket holds Actions step logs. You don't need to create anything in Artifacts: the namespace is created automatically with the first repository.

Git LFS clients upload and download directly to R2 with pre-signed URLs, which need an R2 API token. In the dashboard, open **R2 → Manage API tokens → Create API token**, choose **Object Read & Write**, scope it to the `gitorange-lfs` bucket, and keep the **Access Key ID** and **Secret Access Key** for step 6.

## 4. Configure `wrangler.jsonc`

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

Fill in:

- `account_id` — from `wrangler whoami`.
- `d1_databases[0].database_id` — from step 3.
- `vars.BASE_URL` — the public URL, e.g. `https://git.example.com` (or your `*.workers.dev` URL).
- `vars.FROM_EMAIL` — an address on your Email Sending domain, e.g. `noreply@example.com`.
- `vars.R2_ACCOUNT_ID` — your account ID again (pre-signed LFS URLs point at `https://<account>.r2.cloudflarestorage.com`).
- `routes` — uncomment and set `pattern` to your hostname if you're using a custom domain.

`wrangler.jsonc` is gitignored, so your IDs stay out of the repository. See [Configuration](configuration.md) for every key.

## 5. Migrate and deploy

```bash
yarn db:migrate:prod
yarn deploy
```

## 6. Set the secrets

```bash
openssl rand -hex 32 | yarn wrangler secret put BETTER_AUTH_SECRET
yarn wrangler secret put R2_ACCESS_KEY_ID       # paste the R2 token's Access Key ID
yarn wrangler secret put R2_SECRET_ACCESS_KEY   # paste its Secret Access Key
```

Setting a secret rolls out a new version of the worker; sign-in fails until `BETTER_AUTH_SECRET` is set, and Git LFS answers "not configured" until both R2 secrets are set.

## 7. Create the admin account

Open your `BASE_URL`. The first visit shows **Welcome to GitOrange**; the account you create there becomes the site admin, and setup closes permanently after that. Do this before sharing the URL.

Then:

1. **Invite your team** — click **+ → Invite member**. Invitees receive an email with a link to create their account.
2. **Create a repository** — **+ → New repository**.
3. **Push code** — create a token under **avatar → Personal access tokens**, then:

   ```bash
   git remote add origin https://git.example.com/<you>/<repo>.git
   git push -u origin main   # username: anything, password: the token
   ```

## Using Git LFS

Nothing to configure per repository. The easiest route for non-developers is the **Set up with an AI agent** prompt on a new repository's page (or **Code → AI agent** on an existing one): paste it into Claude Code and the agent installs and configures Git LFS. By hand, with [git-lfs](https://git-lfs.com) installed:

```bash
git lfs install                 # once per machine
git lfs track "*.psd"           # in your repository
git add .gitattributes design.psd
git commit -m "Add design file"
git push                        # uses the same token as git
```

## Updating

```bash
git pull
yarn install
yarn db:migrate:prod
yarn deploy
```

## Troubleshooting

- **`Access denied [code: 10004]` from Artifacts** — `account_id` points at a different account than the one you're logged into, the account isn't on Workers Paid, or your API token lacks Artifacts permissions (re-run `yarn wrangler login`).
- **Invitation emails never arrive** — `FROM_EMAIL`'s domain isn't verified in Email Sending. The admin page always shows the invite link too, so you can share it directly in the meantime.
- **`git push` returns 403** — you aren't the repository owner, a site admin, or a collaborator. The owner can add you under the repository's **Settings → Collaborators**.
- **`git clone` keeps asking for a password** — use a personal access token, not your account password.
- **`git lfs push` says LFS isn't configured** — set `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (step 6).
- **LFS uploads fail with `403 SignatureDoesNotMatch` or `AccessDenied`** — the R2 token doesn't have Object Read & Write on the bucket named in `LFS_BUCKET_NAME`, or `R2_ACCOUNT_ID` is wrong.
