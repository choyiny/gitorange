# Local development

## Prerequisites

- Node.js v20+ and yarn
- `yarn wrangler login` on a Cloudflare account on Workers Paid (Artifacts is in open beta there). Artifacts has no local emulator, so `yarn dev` talks to the real service (namespace `gitorange-dev`). D1 is local.

## First run

```bash
yarn install
cp wrangler.jsonc.example wrangler.jsonc   # set account_id and env.dev values
cp .dev.vars.example .dev.vars             # set BETTER_AUTH_SECRET (and R2_* for Git LFS)
yarn wrangler r2 bucket create gitorange-lfs-dev   # only if you'll use Git LFS locally
yarn db:migrate:local
yarn dev                                   # http://localhost:8080
```

The app, API, and git endpoint share one origin: `git clone http://localhost:8080/<owner>/<repo>.git`.

## Scripts

| Script                              | What it does                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `yarn dev`                          | Vite dev server running the Worker in `env.dev`                                      |
| `yarn test`                         | Vitest inside workerd against a real local D1, with an in-memory Artifacts fake      |
| `yarn typecheck`                    | Type-checks the SPA and the Worker                                                   |
| `yarn format` / `yarn format:check` | Prettier                                                                             |
| `yarn db:generate`                  | Generate a migration after changing the Drizzle schema (never hand-write migrations) |
| `yarn auth:update`                  | Regenerate `worker/src/db/auth.schema.ts` after changing the better-auth config      |
| `yarn cf-typegen`                   | Regenerate `worker/worker-configuration.d.ts` from `wrangler.jsonc.ci`               |

## Layout

```
src/                 React SPA (Primer CSS, react-router, TanStack Query)
worker/src/
  index.ts           Worker entry: Hono app + git endpoint
  git-http.ts        git smart-HTTP proxy to Artifacts
  git/               pkt-line, object encoding, packfiles, merge/diff service
  routers/           API routes (Hono + Zod OpenAPI)
  db/                Drizzle schema (auth.schema.ts is generated)
  auth/              better-auth config and guards
  __tests__/         Vitest suites and the Artifacts fake
migrations/          Generated D1 migrations
```

API docs are served at `/api/swagger-ui` while running.
