---
name: gitorange-onboarding
description: Interactive setup wizard for deploying your own GitOrange instance to Cloudflare. Use when the user wants to set up, install, deploy, or get started with GitOrange, configure its Cloudflare resources or wrangler.jsonc, or says "onboarding", "setup", or "deploy gitorange".
---

# GitOrange onboarding wizard

Deploy a production GitOrange instance to **the user's own Cloudflare account**. This wizard is deployment-only; local development is covered in `docs/development.md`. The project's "humans deploy" rule is satisfied here because the user is running this wizard and confirms before anything is created — never deploy outside it.

## Before you start

The deployment itself is `yarn gitorange install` (`scripts/gitorange/`, described in `docs/setup.md`). It creates the resources, generates `wrangler.jsonc` from `wrangler.jsonc.example`, deploys, and verifies, the same way every time. You choose the inputs, show the user the plan, and interpret failures; the user runs the apply.

## What the user is signing up for

Tell the user this before touching anything, so they can back out cheaply:

- **~15 minutes**, longer if their sending domain still needs DNS verification.
- **One decision**: which hostname the instance runs on (custom domain or `*.workers.dev`), and which email domain sends invitations.
- **Cost**: the Cloudflare **Workers Paid** plan (about 5 USD/month) is required, because Artifacts is not on Workers Free. It includes 10,000 Artifacts operations and 1 GB of storage per month; beyond that, 0.15 USD per 1,000 operations and 0.50 USD per GB-month.
- **Usage-based extras**, billed only when used: Actions jobs run as Cloudflare Containers (about 0.0024 USD per minute on the default runner, after the plan's included minutes); AI conflict resolution and reviewer agents' reviews use Workers AI (per token); LFS files and the Actions cache are R2 storage. Every AI call goes through an AI Gateway named `default`, created automatically, so its logs show exactly what AI costs.

<!-- Never write a dollar sign followed by a digit in this file: Claude Code replaces those with the skill arguments. Write amounts as "5 USD". -->

## Before the plan

Check these with the user; the installer checks Artifacts, R2, the hostname, and the sender domain itself.

```bash
node --version    # v22.18+
yarn --version
docker info --format '{{.ServerVersion}}'   # Docker must be running: the deploy builds the Actions runner image
```

Then `yarn install`. If Docker isn't running, ask the user to start it and wait. Ask "Is this account on the **Workers Paid** plan?"; if not, send them to https://dash.cloudflare.com/?to=/:account/workers/plans and wait.

Cloudflare credentials: `yarn wrangler whoami`. If not logged in, the user runs it themselves (it opens a browser): ask them to type `! yarn wrangler login`. A `CLOUDFLARE_API_TOKEN` also works (permissions in `docs/setup.md`); never ask them to paste one into the chat.

Then ask the inputs, one at a time:

1. **Name** (default `gitorange`; it names the worker and every resource).
2. **Account**, if `yarn wrangler whoami` lists several (`--account <id|name>`).
3. **Hostname**: a custom domain whose zone is on this Cloudflare account (`--hostname git.example.com`) or the free workers.dev address (`--workers-dev`).
4. **Invitation sender**: an address on a domain set up for Email Sending (`--from-email noreply@example.com`), or none (`--no-email`; invite links still work).

## Deployment

### Step 1: The plan

Run (flags from the answers; this is read-only, so it is safe from your shell):

```bash
yarn gitorange install --plan --name <name> --hostname <host> --from-email <address>
```

Never pass `--yes` yourself: your shell is not a terminal, so the apply must be run by the user. If preflight reports problems, nothing was changed: each failure comes with its fix. Help the user resolve them and run the plan again. Common ones: Artifacts or Workers Paid missing, R2 not enabled, no workers.dev subdomain yet (open Workers & Pages once), the zone not active, the sender domain not enabled for Email Sending, Docker not running, an API token lacking a permission.

Walk the user through the plan: what will be created (D1 database, three R2 buckets, the worker and its Durable Objects and Workflows), the address it will serve on, anything that "exists but not created by this installation" (the installer will stop rather than touch it), and the plan digest. If `wrangler.jsonc` exists and was written by hand, the installer refuses to overwrite it; the user moves it aside (`mv wrangler.jsonc wrangler.jsonc.bak`).

### Step 2: Optional credentials

Tell the user what the apply will offer. Both can be skipped and added later with `--resume`:

- **R2 upload keys** for Git LFS and the Actions cache: it prints a prefilled R2 token link (Object Read & Write); they create the token and paste the Access Key ID and Secret Access Key into the masked prompts.
- **Usage & cost analytics token** (Account Analytics, read) for Site admin → Usage & cost: another prefilled link and a masked prompt.

Never ask them to paste any of these into the chat.

### Step 3: Apply

Ask for an explicit yes, then give the user the apply command the plan printed (it ends with `--expect-plan <digest> --yes`, so it applies exactly the plan they reviewed) and have them run it themselves, so the masked prompts stay out of the chat:

```
! yarn gitorange install --name <name> ... --expect-plan <digest> --yes
```

It runs for several minutes (the first deploy builds the runner image). At the end it prints a **setup code** once and `<BASE_URL>/setup`. Tell the user to keep it and enter it there to create the admin account; only someone with the code can.

If the run fails, the message names the failed step and prints `yarn gitorange install --resume --name <name>`. Read the error with them, fix the cause, and have them run that command (it skips what is done and creates nothing twice). "The plan changed since it was reviewed" means something moved: run `--plan` again and review the new one. A failure after the secrets went live also prints the setup code, so they keep it. A lost code before the admin exists: `--resume` issues a new one. `yarn gitorange status --name <name>` shows the recorded installation and asks the deployed worker whether it matches.

### Step 4: Verify end to end

1. Open `<BASE_URL>/setup`. It asks for the setup code, then creates the account, which **becomes the site admin; setup closes forever after**. Do it before sharing the URL.
   Then have them open avatar → **Site admin**: Site admin → Setup shows what's misconfigured (missing secrets, bindings, or variables, `BASE_URL` mismatches, unapplied migrations, rejected R2 credentials, AI Gateway settings), errors first, each with the steps to fix it. Work through any errors before continuing.
2. Have them create a repository with **Add a README file** checked. If creation fails with an Artifacts error, run `yarn gitorange status` and recheck Artifacts access (Workers Paid).
3. Have them create a token (avatar → **Personal access tokens**) and run `git clone <BASE_URL>/<username>/<repo>.git`, using the token as the password.
4. If the R2 secrets are set and they have [git-lfs](https://git-lfs.com) installed: in the clone, `git lfs install && git lfs track "*.bin"`, add a file, commit, and `git push`. The file's page in the UI should say **Stored with Git LFS** and offer a download.
5. Have them invite themselves at a second address (**+ → Invite member**) and confirm the email arrives. If it doesn't, the `FROM_EMAIL` domain isn't verified for Email Sending — the invite link on the admin page still works meanwhile.

Optional, once the basics work (point them to the docs rather than doing it for them):

6. **Commit attribution:** under **avatar → Settings → Emails**, add any other address they commit with and click the verification link, so their commits link to their profile.
7. **AI tools (MCP):** **avatar → MCP server** shows the command for their client, e.g. `claude mcp add --transport http gitorange <BASE_URL>/mcp`.
8. **Actions:** a workflow file in `.github/workflows/` (GitHub Actions syntax) runs on pushes and pull requests; the run shows under the repository's **Actions** tab.

### Step 5: Reviewer agents

Reviewer agents are what turn on reviews and auto-merge, so ask before finishing:

> Do you want reviewer agents now? (a) the recommended crew: seven general reviewers (Security, Data, Speed,
> Features, Reliability, Privacy, Shipping); (b) GitOrange's own agents from https://github.com/gitorangeapp (Data,
> DevOps, Feature, Security, Speed), the ones that review GitOrange itself; (c) both; or (d) later.

**(a) The recommended crew:** the user opens **Agents → New reviewer → Add the recommended crew**, which creates all
seven in one step.

**(b) Agents from github.com/gitorangeapp:** each repository there (`dataagent`, `devopsagent`, `featureagent`,
`securityagent`, `speedagent`) holds an agent's `AGENT.md`, `avatar.png`, and `knowledge/`. Ask which ones, and
whether to bring each one **whole** or **`AGENT.md` only**: `knowledge/` holds what the agent learned reviewing
GitOrange's own code (its file paths and conventions), so whole suits a user working on GitOrange itself, and
`AGENT.md` only suits every other project. Then, for each chosen agent:

1. The user creates it in **Agents → New reviewer** with exactly that handle and a display name (Data Agent, DevOps
   Agent, Feature Agent, Security Agent, Speed Agent). If the crew already created that handle (`dataagent`,
   `securityagent`, `speedagent`), skip this: the import replaces its files.
2. Import its files over git. This uses the credentials saved by the clone in Step 4; if git asks for a password,
   have the user run the push themselves with `!` so the token never passes through the chat.

   ```bash
   H=featureagent    # the agent's handle
   git clone -q --depth 1 https://github.com/gitorangeapp/$H.git /tmp/gitorange-agents/$H-src
   git clone -q <BASE_URL>/$H/$H.git /tmp/gitorange-agents/$H
   cp -R /tmp/gitorange-agents/$H-src/{AGENT.md,avatar.png,knowledge} /tmp/gitorange-agents/$H/   # whole
   # AGENT.md only: cp /tmp/gitorange-agents/$H-src/{AGENT.md,avatar.png} /tmp/gitorange-agents/$H/
   cd /tmp/gitorange-agents/$H && git add -A && git commit -qm "Import $H from github.com/gitorangeapp" && git push -q
   ```

   GitOrange re-reads `AGENT.md` after the push; the agent's profile shows its new instructions and avatar.

Whichever they chose, they then invite the agents in a repository's **Settings → Agents**. Each new commit is
reviewed by the agents it concerns, and auto-merge is on wherever an agent is invited. Findings for a person wait on
**Approvals**; **Let Claude decide** (per agent, on that page) answers an agent's findings as the user, except
Security and Data, which always need a person. `.orangeignore` keeps generated files out of reviews. See
`docs/auto-merge.md`.

## Completion summary

Report, with real values substituted (the installer's own summary lists most of it):

- Worker `<name>` live at `<BASE_URL>`, installation recorded in `.gitorange/`
- D1 database and R2 buckets (LFS, Actions logs, Actions cache), migrations applied
- Invitations sent from `<FROM_EMAIL>` or none
- R2 upload keys and the analytics token: `<set | skipped: add with yarn gitorange install --resume>`
- Admin account `<username>` created with the setup code
- Reviewer agents: `<the recommended crew | from github.com/gitorangeapp: <handles>, whole or AGENT.md only | none yet>`, invited in `<repositories>`
- Instance name, invitation sender, and AI models can later be changed in Site admin → Settings without a deploy; the wrangler vars are only defaults
- To update later: `git pull && yarn install && yarn db:migrate:prod && yarn deploy`. A deploy restarts running Actions jobs (each restarts from the beginning, up to 3 attempts), so prefer deploying when no CI is running.

## Common issues

Site admin → Setup shows what's misconfigured on the deployed worker, with the fix for each item; check it first.

- **`Access denied [code: 10004]`** — wrong account, account not on Workers Paid, or a wrangler login without Artifacts scopes (`! yarn wrangler login` again).
- **"The API token cannot read: …"** — the token lacks a permission listed in `docs/setup.md`.
- **"Not running in a terminal: pass --yes"** — only the user's `!` command is a terminal; Claude's shell is not.
- **The installer refuses to overwrite `wrangler.jsonc`** — it was written by hand; move it aside and rerun.
- **Auth errors / "invalid origin" after deploy** — `BASE_URL` doesn't match the URL in the browser. The installer sets it from the hostname or workers.dev address it verified; if you moved the instance, rerun the plan.
- **Custom domain shows a Cloudflare error page** — the zone isn't on this Cloudflare account or isn't active; the plan's preflight reports it.
- **Invitation email never arrives** — `FROM_EMAIL`'s domain isn't verified in Email Sending; check `yarn wrangler email sending list` (the installer's preflight checks it).
- **`git push` 403** — the user isn't owner, site admin, or collaborator on that repository.
- **`git lfs push` says LFS isn't configured** — `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` aren't set.
- **LFS upload fails with `SignatureDoesNotMatch` / `AccessDenied`** — the R2 token lacks Object Read & Write on the bucket, or `R2_ACCOUNT_ID` / `LFS_BUCKET_NAME` don't match it.
- **`wrangler deploy` says it "could not finish applying its Durable Object-managed Container application settings"** — the Worker itself deployed; run `yarn deploy` again to finish.
- **Actions jobs never start** — Docker wasn't running when the runner image was built, or the `containers` entry was removed.
- **Usage & cost says "not configured" or "unavailable"** — `CF_ANALYTICS_TOKEN` was skipped (add it with `--resume`) or is missing or lacks Account Analytics: Read, or a resource var (`D1_DATABASE_ID`, the `*_NAMESPACE_ID`s) is empty or wrong. Each line on the page gives the reason.
- **No AI resolution or agent reviews** — the `ai` binding or the `MERGE_RESOLUTION` Workflow is missing, or (for reviews) the repository has no invited agents.
