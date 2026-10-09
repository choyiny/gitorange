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
| `yarn dev`                          | Vite dev server running the Worker in `env.dev`, under a memory watchdog (below)     |
| `yarn seed:demo`                    | Fills a running local instance with demo data (see below)                            |
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

## Demo data

`yarn seed:demo` fills a running local instance with a project to look at: a teammate (`cho`, Cho Yin), an `invoices`
repository with ten days of history, eight merged pull requests (three with their branches left behind), six open ones
(one stacked on another, opened by Claude Code, Codex and by hand), the reviewer crew with a finding in each state
(an owner question, a change request, one assigned to `cho`, one decided by GitOrange AI), and a week of test runs.
Every page of the redesign has something to show, and it makes a local demo possible.

```bash
yarn dev                                       # in one terminal; sign in once and create the first admin
SEED_ADMIN=<admin username> SEED_PASSWORD=<their password> yarn seed:demo --url http://localhost:8080
```

- **Run it from the checkout `yarn dev` runs from.** The API cannot write reviews, backdated dates or test runs, so the
  script writes those rows into that checkout's local D1 with `wrangler d1 execute DB --local --env dev`.
- **Local only.** It refuses any URL whose host is not `localhost`, `127.0.0.1`, `[::1]`, `*.localhost` or `*.test`.
- **It uses the real services in the `gitorange-dev` namespace** (Artifacts and Workers AI), as `yarn dev` does: it creates
  the `invoices` repository and the crew's repositories, pushes the history over git, and opens and lands pull requests
  through the API. Opening a pull request starts the usual background AI work, so a run takes a few minutes.
- **Running it again finds the demo and stops.** `--reset` deletes the `invoices` repository and builds it again;
  `--dry-run` builds the git history in a temporary folder and checks the SQL against the migrations, touching no server.
- `cho` gets the password in `SEED_TEAMMATE_PASSWORD`, or the local demo default at the top of `scripts/seed-demo.mjs`.
  Nothing else is printed or stored: the admin's password is only used to sign in, and the git token it creates is deleted
  at the end.
- The agents do not really run: their reviews and findings are written directly, as they would have been. Containers are
  off locally, so the demo's test runs are written the same way.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) builds and typechecks once (`build`), then runs the tests in one job per module (`test-stacking`; `test-review`, which also covers merging and agent runs; `test-actions`, which also covers the git endpoint and LFS; `test-core`, which also covers MCP and the client-side libraries), in parallel, from the build's cache. Modules are few and balanced by runtime, because each job pays to restore the build and start vitest. On GitOrange, `build` and the test jobs run on `gitorange-standard-4` (`runs-on` is an expression that picks `ubuntu-latest` on GitHub). On GitOrange a `gate` job asks [`gitorange/relevance@v1`](ci-relevance.md) which modules a change can affect and skips the rest; on GitHub the gate is skipped and every module runs.

Every test file belongs to exactly one module. When you add a test file, add it to the `yarn test` line of its module's job; `worker/src/__tests__/ci-workflow.test.ts`, which `build` always runs, fails until you do. A new module needs a `test-<name>` job, a line in the gate's `modules`, and a `run-<name>` gate output. Tests get 30 s each when `CI` is set (GitOrange Actions and GitHub both set it), 5 s locally.

## Dev server memory watchdog

`yarn dev` runs Vite through [`scripts/dev.mjs`](../scripts/dev.mjs), which adds up the memory of the whole dev
process tree (Node, workerd, esbuild) every 5 seconds. It logs each time usage passes another gigabyte and stops
the server, with a breakdown by process, once it passes **5 GB**, so a leak can't take the machine down. The
server uses about 1.3 GB right after starting. Change the limit with `DEV_MEMORY_LIMIT_MB=8192 yarn dev`, or turn
the watchdog off with `DEV_MEMORY_LIMIT_MB=0`. A stop for memory exits with code 137.
