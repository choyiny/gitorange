# gitorange

The installer for [GitOrange](https://github.com/choyiny/gitorange), the code host where AI agents ship the code
and people approve the risk, on Cloudflare Workers. This package carries a built GitOrange release (worker, web app,
database migrations and the Actions runner image's Dockerfile) and deploys it to your Cloudflare account with its own
pinned wrangler. You do not need a clone of the repository.

Requires Node.js 22 or later, and Docker running for `install` and `upgrade`: deploying builds the Actions runner
image.

## Install

```bash
npx gitorange install
```

It asks for what it needs, shows the plan, and applies it when you confirm. Sign in first with
`npx wrangler login`, or set `CLOUDFLARE_API_TOKEN`. To review the plan without changing anything:

```bash
npx gitorange install --plan
```

## Upgrade

```bash
npx gitorange@latest upgrade
```

Moves an installation to the package's version: applies new migrations, adds new resources and secrets, and
deploys. It never downgrades.

## Adopt an existing installation

From a checkout that ran `yarn gitorange install`:

```bash
npx gitorange adopt --from path/to/checkout
```

Or a worker deployed by hand:

```bash
npx gitorange adopt --worker <worker name>
```

## Status

```bash
npx gitorange status
```

State lives in `~/.gitorange` (override with `GITORANGE_HOME`). Run `npx gitorange --help` for every option.

Docs: [setup](https://github.com/choyiny/gitorange/blob/main/docs/setup.md) ·
[updating](https://github.com/choyiny/gitorange/blob/main/docs/updating.md). Licensed under Apache-2.0.
