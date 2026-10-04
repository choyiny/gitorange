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
- Access (`worker/src/lib/repos.ts` — `permissionsFor` and the list filter `visibleTo` must agree): personal repos are
  private (owner, collaborators, site admins) or internal; team repos (`repositories.team_id`, one shared `teams` row) are
  always internal. Owner/creator, site admins, and collaborators push and merge. Usernames and the team slug share the URL
  namespace (`worker/src/lib/namespaces.ts`).
- Git LFS (`worker/src/lfs-http.ts`, `worker/src/lib/lfs.ts`): Batch API at `/<owner>/<repo>.git/info/lfs/...`,
  sharing the git endpoint's auth. Bytes go client ↔ R2 directly via pre-signed URLs (needs the
  `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` secrets); D1 `lfs_objects` holds bare R2 keys, never URLs. One copy
  per repository under `lfs/<repository id>/`, deleted with the repository.
- Actions (`worker/src/actions/`): pushes/merges/PR opens queue `workflow_runs` rows (D1, written before the Workflow starts), an
  `ActionsRun` Workflow executes jobs, and a `JobRunner` Durable Object per job owns its container (Cloudflare Containers,
  `durable_object` scheduling, image `actions/runner/Dockerfile`). Step logs in R2 (`ACTIONS_LOGS`). Tests drive `executeRun`
  with a fake step and runner; `makeEnv({ actions: true })` adds fake `ACTIONS_RUN`/`JOB_RUNNER` bindings.
- MCP (`worker/src/mcp/`): `POST /mcp` is a hand-rolled JSON-RPC MCP server. better-auth's `@better-auth/oauth-provider`
  (+ `jwt()`) is the OAuth 2.1 authorization server; `/mcp` verifies JWT access tokens (audience `<origin>/mcp`) locally
  and requires the user's consent row, so disconnecting an app is immediate. Discovery routes live at the origin root.
  `yarn auth:update` runs `scripts/fix-auth-schema.mjs` to patch a better-auth CLI bug in the generated schema.
- Merging is rebase-only (squash onto the target tip). Conflicts: line-level diff3 in `GitService.mergeTrees`; text
  conflicts are resolved automatically by AI (`worker/src/merge/`): sweep/attempt Workflow `MERGE_RESOLUTION`,
  `MergeResolver` DO (Cloudflare Computer workspace + Pi Durable harness, model `RESOLVER_MODEL` via the `AI`
  binding). A valid resolution (`merge_resolutions.status = 'proposed'` for the current shas) makes the PR mergeable.
  Tests drive `executeResolution`/`executeSweep` with fake steps and a fake resolver.
- Auto-merge (`worker/src/review/`): opt-in via `.gitorange/review.yml` on the target branch. Per head commit: GLM
  one-liner per file → Clef classifies the one-liners against the policy's questions → flags (questions, path rules,
  limits) investigated by GLM-5.3 and approved by people (`pr_classifications`, `pr_review_flags`). `maybeAutoMerge`
  lands via `landPull` (shared with the merge button) when `autoMergeStatus` is ready. Tests drive
  `executeClassification` with fake models.
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
