# GitOrange

A single-tenant, GitHub Enterprise Server–style git host that runs entirely on Cloudflare:
a Worker for the app and git endpoint, D1 for metadata, and [Artifacts](https://developers.cloudflare.com/artifacts/) for git storage.

- First visit: create the initial admin account.
- Admins invite teammates by email (Cloudflare Email Sending).
- Unlimited repositories, browsable like GitHub, cloneable over HTTPS with a personal access token.
- Pull requests with conversation, commits, file diffs, merge commits, and squash merges.

## Local development

```sh
yarn install
cp .dev.vars.example .dev.vars   # set BETTER_AUTH_SECRET
yarn db:migrate:local
yarn dev                          # http://localhost:8080
```

`yarn dev` talks to the real Artifacts service (namespace `gitorange-dev`) because Artifacts has no
local emulator, so you need `wrangler login` on an account with Artifacts access.

Clone a repo with a personal access token from **Settings → Personal access tokens**:

```sh
git clone http://localhost:8080/<owner>/<repo>.git   # username: anything, password: the token
```

## Deploying (humans only)

1. `wrangler d1 create gitorange` and put the id in `env.production` in `wrangler.jsonc`; set `BASE_URL`.
2. Make sure `FROM_EMAIL` is on a domain onboarded to Cloudflare Email Sending.
3. `wrangler secret put BETTER_AUTH_SECRET --env production`
4. `yarn db:migrate:prod && yarn deploy:production`
