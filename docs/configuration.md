# Configuration

GitOrange reads its configuration from `wrangler.jsonc` (copied from [`wrangler.jsonc.example`](../wrangler.jsonc.example), gitignored) and from Worker secrets.

## Bindings

Binding names are load-bearing — the worker looks them up by exact name. Resource names and IDs can be anything.

| Key                               | Required value       | What it is                                                                                                                                                                      |
| --------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d1_databases[].binding`          | `"DB"`               | Users, invitations, tokens, repositories, pull requests, comments                                                                                                               |
| `artifacts[].binding`             | `"ARTIFACTS"`        | Git storage. `namespace` groups this instance's repositories                                                                                                                    |
| `send_email[].name`               | `"EMAIL"`            | Outbound invitation email via Cloudflare Email Sending                                                                                                                          |
| `r2_buckets[].binding`            | `"LFS"`              | Git LFS file contents, keyed `lfs/<repository id>/<oid>`                                                                                                                        |
| `r2_buckets[].binding`            | `"ACTIONS_LOGS"`     | Actions step logs, keyed `actions/<repository id>/<run>/<job>/<step>.log`                                                                                                       |
| `workflows[].binding`             | `"ACTIONS_RUN"`      | One Workflow instance per Actions run (`class_name: "ActionsRun"`)                                                                                                              |
| `durable_objects.bindings[].name` | `"JOB_RUNNER"`       | One `JobRunner` Durable Object per Actions job; it owns the job's container                                                                                                     |
| `durable_objects.bindings[].name` | `"MERGE_RESOLVER"`   | One `MergeResolver` Durable Object per AI conflict resolution: a Cloudflare Computer workspace and the pi agent                                                                 |
| `durable_objects.bindings[].name` | `"LIVE"`             | One `LiveHub` Durable Object: the WebSocket hub that tells open pages to refresh (it relays pings and stores nothing). Without it pages still work, they just don't update live |
| `workflows[].binding`             | `"MERGE_RESOLUTION"` | AI conflict resolution and auto-merge: one instance per resolution attempt or review, plus a sweep per push or merge (`class_name: "MergeResolutionWorkflow"`)                  |
| `ai.binding`                      | `"AI"`               | Workers AI, the model behind conflict resolution                                                                                                                                |
| `assets.binding`                  | `"ASSETS"`           | The built React app in `dist/client`                                                                                                                                            |

`containers` defines the Actions runner: class `JobRunner` with `scheduling_policy: "durable_object"` and one image named `runner`, built from [`actions/runner/Dockerfile`](../actions/runner/Dockerfile) when you deploy (Docker must be running). Each job picks its instance size at start from `runs-on` (`ubuntu-latest` → `standard-1`; `gitorange-standard-2` … `gitorange-standard-4` for bigger machines). To deploy without Actions, remove the `JobRunner` container, its Durable Object binding and export, the `ACTIONS_RUN` Workflow, and the `ACTIONS_LOGS` bucket. Without them, pushes never queue runs and the Actions tab says Actions isn't set up. To deploy without AI conflict resolution and auto-merge, remove the `MergeResolver` Durable Object binding and export and the `MERGE_RESOLUTION` Workflow: conflicts then have to be resolved locally, and nothing merges on its own.

Keep `assets.run_worker_first` as shipped (it includes `/mcp` and `/.well-known/*`, which the MCP server and OAuth discovery need): the git endpoint (`/<owner>/<repo>.git/...`) and `/api/*` must reach the worker before static asset handling.

## Variables

| Variable          | Example                     | Purpose                                                                                                                                                                                                        |
| ----------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_NAME`        | `GitOrange`                 | The instance's name: page titles, sign-in and setup pages, invitation emails, the git auth realm, AI agent prompts, and the MCP server (whose id is the lowercased name, e.g. `XY Space Git` → `xy-space-git`) |
| `BASE_URL`        | `https://git.example.com`   | Public origin; used for auth and trusted origins. Cookies are `Secure` when this is `https://`                                                                                                                 |
| `FROM_EMAIL`      | `noreply@example.com`       | Sender for invitation emails; its domain must be onboarded to Email Sending                                                                                                                                    |
| `R2_ACCOUNT_ID`   | `0123…cdef`                 | Account that owns the LFS bucket; pre-signed URLs point at `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`                                                                                                  |
| `RESOLVER_MODEL`  | `@cf/zai-org/glm-5.3`       | Workers AI model the conflict-resolution agent uses; it must support tool calling                                                                                                                              |
| `SUMMARY_MODEL`   | `@cf/zai-org/glm-5.3-flash` | Auto-merge: writes the one-line summary of each changed file ([Auto-merge](auto-merge.md))                                                                                                                     |
| `REVIEW_MODEL`    | `@cf/zai-org/glm-5.3`       | Auto-merge: investigates each flag. The classifier (Clef) is chosen per repository in `.gitorange/review.yml`                                                                                                  |
| `LFS_BUCKET_NAME` | `gitorange-lfs`             | The LFS bucket's name; must match `r2_buckets[].bucket_name` (a binding doesn't expose its name)                                                                                                               |

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
