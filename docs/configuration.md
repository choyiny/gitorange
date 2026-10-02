# Configuration

GitOrange reads its configuration from `wrangler.jsonc` (copied from [`wrangler.jsonc.example`](../wrangler.jsonc.example), gitignored) and from Worker secrets.

## Bindings

Binding names are load-bearing — the worker looks them up by exact name. Resource names and IDs can be anything.

| Key                      | Required value | What it is                                                        |
| ------------------------ | -------------- | ----------------------------------------------------------------- |
| `d1_databases[].binding` | `"DB"`         | Users, invitations, tokens, repositories, pull requests, comments |
| `artifacts[].binding`    | `"ARTIFACTS"`  | Git storage. `namespace` groups this instance's repositories      |
| `send_email[].name`      | `"EMAIL"`      | Outbound invitation email via Cloudflare Email Sending            |
| `assets.binding`         | `"ASSETS"`     | The built React app in `dist/client`                              |

Keep `assets.run_worker_first` as shipped: the git endpoint (`/<owner>/<repo>.git/...`) and `/api/*` must reach the worker before static asset handling.

## Variables

| Variable     | Example                   | Purpose                                                                                        |
| ------------ | ------------------------- | ---------------------------------------------------------------------------------------------- |
| `APP_NAME`   | `GitOrange`               | Name shown in emails and the git auth realm                                                    |
| `BASE_URL`   | `https://git.example.com` | Public origin; used for auth and trusted origins. Cookies are `Secure` when this is `https://` |
| `FROM_EMAIL` | `noreply@example.com`     | Sender for invitation emails; its domain must be onboarded to Email Sending                    |

## Secrets

| Secret               | How to set                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` | Production: `wrangler secret put BETTER_AUTH_SECRET`. Local: `.dev.vars` (see `.dev.vars.example`). Generate with `openssl rand -hex 32` |

## Environments

The top level of `wrangler.jsonc` is production (`yarn deploy`). The `env.dev` block is what `yarn dev` runs: a local D1 database, and Artifacts in a separate `gitorange-dev` namespace (Artifacts has no local emulator), so development never touches production repositories.

## Other config files

| File                  | Purpose                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `wrangler.jsonc.ci`   | Placeholder config CI copies into place to build, and that `yarn cf-typegen` generates `worker/worker-configuration.d.ts` from |
| `wrangler.test.jsonc` | Test config with no remote bindings; tests inject an in-memory Artifacts fake                                                  |
