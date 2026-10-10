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
yarn wrangler r2 bucket create gitorange-actions-cache
yarn wrangler r2 bucket lifecycle add gitorange-actions-cache expire-7d --expire-days 7 -y
```

Copy the `database_id` it prints. `gitorange-actions-logs` holds Actions step logs, and `gitorange-actions-cache` holds the Actions cache (its lifecycle rule expires entries after 7 days). You don't need to create anything in Artifacts: the namespace is created automatically with the first repository.

Git LFS clients upload and download directly to R2 with pre-signed URLs, which need an R2 API token. In the dashboard, open **R2 → Manage API tokens → Create API token**, choose **Object Read & Write**, scope it to the `gitorange-lfs` and `gitorange-actions-cache` buckets (the Actions cache uses pre-signed URLs too), and keep the **Access Key ID** and **Secret Access Key** for step 6.

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
- `vars.D1_DATABASE_ID` — the same `database_id` again, so **Site admin → Usage & cost** reads this database's analytics. The other usage variables (`WORKER_NAME`, the bucket, namespace, and Workflow names) already match the names above. After the first deploy, run `node scripts/do-namespaces.mjs --write` to fill in `JOB_RUNNER_NAMESPACE_ID`, `MERGE_RESOLVER_NAMESPACE_ID`, `AGENT_REVIEWER_NAMESPACE_ID`, and `LIVE_NAMESPACE_ID` (it uses wrangler's login), then deploy again. Until then, Durable Object usage shows as "not configured".

Keep `triggers.crons` as shipped: a daily job deletes Actions runs past their retention (set in **Site admin → Settings**, 90 days by default). `APP_NAME`, `FROM_EMAIL`, and the model variables are defaults that a site admin can change later in **Site admin → Settings** without a deploy.

Leave the AI variables at their defaults unless you want different models. `AI_GATEWAY: "default"` logs every Workers AI call (requests, tokens, cost) in an AI Gateway that Cloudflare creates on first use; set it to `"off"` to skip the gateway. Keep the `containers`, `durable_objects`, `exports`, `workflows`, and `ai` entries as shipped: they run Actions, AI conflict resolution, reviewer agents' reviews, and live page updates.

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

Optionally, for **Site admin → Usage & cost**: create an account API token (**Manage Account → Account API Tokens → Create Token → Custom token**) with the single permission **Account → Account Analytics → Read**, then:

```bash
yarn wrangler secret put CF_ANALYTICS_TOKEN     # paste the token
```

Without it, the page shows only what GitOrange records itself (Actions runner time, Workers AI calls, emails). With it, a daily cron (02:30 UTC) pulls this deployment's Cloudflare analytics, filtered to its own Worker, Durable Objects, Workflows, D1 database, R2 buckets, and Artifacts namespace. See [Configuration](configuration.md#usage--cost).

## 7. Create the admin account

Open your `BASE_URL`. The first visit shows **Welcome to GitOrange**; the account you create there becomes the site admin, and setup closes permanently after that. Do this before sharing the URL.

Then:

1. **Check the setup** — **avatar → Site admin**. Site admin → Setup shows what's misconfigured: missing secrets, bindings, and variables, a `BASE_URL` that doesn't match the address you're using, unapplied migrations, R2 credentials that R2 rejects, and AI Gateway settings, each with the steps to fix it. Site admins also see a red badge in the header while anything there is an error.
2. **Invite your team** — click **+ → Invite member**. Invitees receive an email with a link to create their account.
3. **Create a repository** — **+ → New repository**.
4. **Push code** — create a token under **avatar → Personal access tokens**, then:

   ```bash
   git remote add origin https://git.example.com/<you>/<repo>.git
   git push -u origin main   # username: anything, password: the token
   ```

## Linking commits to people

Commits link to a member's profile when their author email matches the member's account email or a verified alternate. Each member adds the addresses they commit with under **avatar → Settings → Emails** and clicks the verification link they're sent.

## Actions and reviews

- **Actions:** workflow files in `.github/workflows/` (GitHub Actions syntax) run on pushes and pull requests, each job in its own container. See the repository's **Actions** tab.
- **Reviews and auto-merge:** add reviewer agents with **Agents → New reviewer → Add the recommended crew** and invite them in a repository's **Settings → Agents**: each new commit is reviewed by the agents it concerns, and a pull request that passes CI and its agents' reviews merges on its own; findings for a person wait on the **Approvals** page. Without agents, a person approves and merges. `.orangeignore` keeps generated files out of reviews. See [Reviewer agents](auto-merge.md).
- **AI conflict resolution** needs no setup: conflicting pull requests are resolved automatically.

## Connecting AI tools (MCP)

Nothing to configure. Each member opens **avatar → MCP server** for their client's setup steps, e.g. `claude mcp add --transport http gitorange https://git.example.com/mcp`, then signs in and approves the app in the browser. MCP clients need to reach your instance over HTTPS.

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

Run the migrations before the deploy: new code may read new tables. A deploy restarts any running Actions jobs (each restarts from the beginning, up to 3 attempts), so CI just takes longer; deploying when nothing is running avoids that.

## Troubleshooting

Start with **Site admin → Setup**: it shows what's misconfigured and how to fix it.

- **`Access denied [code: 10004]` from Artifacts** — `account_id` points at a different account than the one you're logged into, the account isn't on Workers Paid, or your API token lacks Artifacts permissions (re-run `yarn wrangler login`).
- **Invitation emails never arrive** — `FROM_EMAIL`'s domain isn't verified in Email Sending. The admin page always shows the invite link too, so you can share it directly in the meantime.
- **`git push` returns 403** — you aren't the repository owner, a site admin, or a collaborator. The owner can add you under the repository's **Settings → Collaborators**.
- **`git clone` keeps asking for a password** — use a personal access token, not your account password.
- **`git lfs push` says LFS isn't configured** — set `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (step 6).
- **LFS uploads fail with `403 SignatureDoesNotMatch` or `AccessDenied`** — the R2 token doesn't have Object Read & Write on the bucket named in `LFS_BUCKET_NAME`, or `R2_ACCOUNT_ID` is wrong.
- **`wrangler deploy` says it "could not finish applying its Durable Object-managed Container application settings"** — the Worker deployed; run `yarn deploy` again to finish.
- **Actions jobs never start** — Docker wasn't running when you deployed, so the runner image wasn't built.
- **No AI resolution or agent reviews** — the `ai` binding or the `MERGE_RESOLUTION` Workflow is missing, or (for reviews) the repository has no invited agents.
