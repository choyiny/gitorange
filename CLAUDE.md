# CLAUDE.md

GitOrange is a single-tenant GitHub Enterprise Server–style app. One Cloudflare Worker serves a Hono +
Zod-OpenAPI API and a React + Vite SPA (styled with GitHub's Primer CSS) on one origin, with Drizzle/D1
and better-auth. Git storage is **Cloudflare Artifacts**: one Artifacts repo per GitOrange repo.

## Architecture notes

- **D1** holds users, invitations, tokens, repository metadata, pull requests, and comments. **Artifacts**
  holds every git object and ref; nothing about git content is mirrored into D1.
- Artifacts repos are named `r_<repository id>` (`repositories.artifacts_name`), so renames never touch storage.
- `worker/src/git-http.ts` serves `https://host/<owner>/<repo>.git`: users authenticate with a personal
  access token (Basic auth), and the worker streams the request to the Artifacts remote with a
  short-lived repo-scoped token. Artifacts credentials never leave the worker.
- Reads use the Artifacts binding (`readTree`, `readCommit`, `readBlob`, `readFile`, `log`). Branches come
  from the smart-HTTP ref advertisement. Merges are computed in the worker (three-way tree merge in
  `worker/src/git/service.ts`) and written as a packfile pushed over `git-receive-pack`
  with compare-and-swap on the base ref.
- Access: every member reads every repo; owner, site admins, and collaborators push and merge.
- Artifacts has no local emulator: `yarn dev` runs `env.dev`, which uses the remote service in the
  `gitorange-dev` namespace. Tests use `wrangler.test.jsonc` (no remote bindings) plus an in-memory
  Artifacts fake.

## Configuration files

- `wrangler.jsonc` is **gitignored** — each deployer copies `wrangler.jsonc.example` and fills in their
  own account and resource IDs. Never commit it, and never put real IDs in the tracked templates.
- When adding a binding or var, update all of: `wrangler.jsonc.example` (top level **and** `env.dev`),
  `wrangler.jsonc.ci`, `wrangler.test.jsonc` (if tests need it), and `docs/configuration.md`; then run
  `yarn cf-typegen` (which generates types from `wrangler.jsonc.ci`, never the local file).
- Deploying is set up by the `/gitorange-onboarding` skill; keep it and `docs/setup.md` in sync.

## Git Workflow

- ALL work happens on a new feature branch — never commit directly to `main`.
- **NEVER push directly to `main`**.
- **NEVER deploy** (`yarn deploy` or any `wrangler deploy`) — deployments are done by humans. The one
  exception is the `/gitorange-onboarding` skill, which a deployer runs and confirms step by step.
- Submit work as a pull request for human review.

## Package Manager

- Always use `yarn` — never `npm` or `npx` for project commands.
- Dev server: `yarn dev` (app + API + git endpoint on one origin at http://localhost:8080)
- Tests: `yarn test`

## Git Hooks

- Husky runs lint-staged (prettier) on pre-commit. After cloning, run `yarn husky`.

## Database

- **Never create migration files manually.** Change the Drizzle schema, run `yarn db:generate`, review the
  SQL in `migrations/`, then `yarn db:migrate:local` / `yarn db:migrate:prod`.
- `worker/src/db/auth.schema.ts` is **generated** by the better-auth CLI — do not hand-edit it. After
  changing `worker/src/auth/index.ts`, run `yarn auth:update`, then `yarn db:generate` and migrate.

## Testing

- Always write Vitest tests for new backend functionality, under `worker/src/__tests__/`. They run in
  workerd against real D1 via `@cloudflare/vitest-pool-workers`. Never mock `env.DB`; inject the Artifacts
  fake from `worker/src/__tests__/helpers/` instead.

## Definition of Done

- `yarn test` passes, with new functionality covered.
- `yarn typecheck` is clean.
- `yarn format` has been run.
