# Configuration

GitOrange reads its configuration from `wrangler.jsonc` (copied from [`wrangler.jsonc.example`](../wrangler.jsonc.example), gitignored) and from Worker secrets.

## Bindings

Binding names are load-bearing — the worker looks them up by exact name. Resource names and IDs can be anything.

| Key                               | Required value   | What it is                                                                  |
| --------------------------------- | ---------------- | --------------------------------------------------------------------------- |
| `d1_databases[].binding`          | `"DB"`           | Users, invitations, tokens, repositories, pull requests, comments           |
| `artifacts[].binding`             | `"ARTIFACTS"`    | Git storage. `namespace` groups this instance's repositories                |
| `send_email[].name`               | `"EMAIL"`        | Outbound invitation email via Cloudflare Email Sending                      |
| `r2_buckets[].binding`            | `"LFS"`          | Git LFS file contents, keyed `lfs/<repository id>/<oid>`                    |
| `r2_buckets[].binding`            | `"ACTIONS_LOGS"` | Actions step logs, keyed `actions/<repository id>/<run>/<job>/<step>.log`   |
| `workflows[].binding`             | `"ACTIONS_RUN"`  | One Workflow instance per Actions run (`class_name: "ActionsRun"`)          |
| `durable_objects.bindings[].name` | `"JOB_RUNNER"`   | One `JobRunner` Durable Object per Actions job; it owns the job's container |
| `assets.binding`                  | `"ASSETS"`       | The built React app in `dist/client`                                        |

`containers` defines the Actions runner: class `JobRunner` with `scheduling_policy: "durable_object"` and one image named `runner`, built from [`actions/runner/Dockerfile`](../actions/runner/Dockerfile) when you deploy (Docker must be running). Each job picks its instance size at start from `runs-on` (`ubuntu-latest` → `standard-1`; `gitorange-standard-2` … `gitorange-standard-4` for bigger machines). To deploy without Actions, remove `containers`, `durable_objects`, `exports`, `workflows`, and the `ACTIONS_LOGS` bucket: pushes then never queue runs, and the Actions tab says Actions isn't set up.

Keep `assets.run_worker_first` as shipped (it includes `/mcp` and `/.well-known/*`, which the MCP server and OAuth discovery need): the git endpoint (`/<owner>/<repo>.git/...`) and `/api/*` must reach the worker before static asset handling.

## Variables

| Variable          | Example                   | Purpose                                                                                                       |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `APP_NAME`        | `GitOrange`               | Name shown in emails and the git auth realm                                                                   |
| `BASE_URL`        | `https://git.example.com` | Public origin; used for auth and trusted origins. Cookies are `Secure` when this is `https://`                |
| `FROM_EMAIL`      | `noreply@example.com`     | Sender for invitation emails; its domain must be onboarded to Email Sending                                   |
| `R2_ACCOUNT_ID`   | `0123…cdef`               | Account that owns the LFS bucket; pre-signed URLs point at `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `LFS_BUCKET_NAME` | `gitorange-lfs`           | The LFS bucket's name; must match `r2_buckets[].bucket_name` (a binding doesn't expose its name)              |

## Secrets

| Secret                                     | How to set                                                                                                                                                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                       | Signs sessions and encrypts the MCP server's OAuth signing keys; changing it signs everyone out and disconnects every MCP app. Production: `wrangler secret put BETTER_AUTH_SECRET`. Local: `.dev.vars` (see `.dev.vars.example`). Generate with `openssl rand -hex 32` |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | S3-compatible credentials of an R2 API token with **Object Read & Write** on the LFS bucket, used only to sign short-lived LFS URLs. Without them Git LFS answers "not configured"; everything else works                                                               |

## Environments

The top level of `wrangler.jsonc` is production (`yarn deploy`). The `env.dev` block is what `yarn dev` runs: a local D1 database, and Artifacts in a separate `gitorange-dev` namespace (Artifacts has no local emulator), so development never touches production repositories. Likewise, dev LFS files go to a separate `gitorange-lfs-dev` bucket (a real one, since pre-signed URLs must reach R2). Actions jobs in dev run in local Docker containers, so Docker must be running for `yarn dev`, and their logs go to a local R2 bucket.

## Other config files

| File                  | Purpose                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `wrangler.jsonc.ci`   | Placeholder config CI copies into place to build, and that `yarn cf-typegen` generates `worker/worker-configuration.d.ts` from |
| `wrangler.test.jsonc` | Test config with no remote bindings; tests inject an in-memory Artifacts fake and fake Actions bindings                        |
