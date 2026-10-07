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
- Commit attribution (`worker/src/lib/commit-authors.ts`): every API commit's author/committer carries `user` — the member
  whose account email or _verified_ alternate (`user_emails`, Settings → Emails, verified by an emailed link) it is.
  Lookups are batched per response (`attributeCommits`), never per commit.
- Reviewer agents (`worker/src/agents/`): an agent is a `users` row (email `<id>@agents.invalid`, no credential)
  plus an `agents` row; refused at `session.create.before`, the PAT lookup in `git-http.ts`, and `getMcpSession`.
  Its repository `<handle>/<handle>` holds `AGENT.md` (`config.ts`), `avatar.png`, `knowledge/`; `refreshAgentConfig`
  re-caches `AGENT.md` after pushes/merges to its default branch (one indexed lookup for other repositories).
  Invitations: `repository_agents`. Reviews: see the Reviews bullet.
- Git LFS (`worker/src/lfs-http.ts`, `worker/src/lib/lfs.ts`): Batch API at `/<owner>/<repo>.git/info/lfs/...`,
  sharing the git endpoint's auth. Bytes go client ↔ R2 directly via pre-signed URLs (needs the
  `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` secrets); D1 `lfs_objects` holds bare R2 keys, never URLs. One copy
  per repository under `lfs/<repository id>/`, deleted with the repository.
- Actions (`worker/src/actions/`): pushes/merges/PR opens queue `workflow_runs` rows (D1, written before the Workflow
  starts), an `ActionsRun` Workflow executes jobs, and a `JobRunner` Durable Object per job owns its container
  (Cloudflare Containers, `durable_object` scheduling, image `actions/runner/Dockerfile`). Step logs in R2
  (`ACTIONS_LOGS`). Tests drive `executeRun` with a fake step and runner; `makeEnv({ actions: true })` adds fake
  `ACTIONS_RUN`/`JOB_RUNNER` bindings and a fresh real `ACTIONS_QUEUE`. A job waits for a slot from the one
  `ActionsQueue` DO (`actions/queue.ts`, setting `actions.max_concurrent_jobs`) before its container starts
  (`step.waitForEvent`, rechecking after 5/10/20/30 minutes; fails open if the queue is unreachable); it gives the slot
  back on complete, restart, and cancel. The cache (`actions/cache.ts`): zstd tarballs in R2 `ACTIONS_CACHE`, moved by
  the runner via pre-signed URLs (never through the Worker), scoped per ref (read own ref then default branch, write own
  ref), saved by "Post" steps. `setup-node` uses the image's Node.js and its `cache:` caches `node_modules` keyed by
  lockfile. `ubuntu-latest` → `standard-2`.
- MCP (`worker/src/mcp/`): `POST /mcp` is a hand-rolled JSON-RPC MCP server. better-auth's `@better-auth/oauth-provider`
  (+ `jwt()`) is the OAuth 2.1 authorization server; `/mcp` verifies JWT access tokens (audience `<origin>/mcp`) locally
  and requires the user's consent row, so disconnecting an app is immediate. Discovery routes live at the origin root.
  `yarn auth:update` runs `scripts/fix-auth-schema.mjs` to patch a better-auth CLI bug in the generated schema.
  Moderator apps (`mcp_moderators`, `worker/src/mcp/moderators.ts`): only a connection the user marked as a moderator
  lists and calls the approve/dismiss tools; checked on every call, never cached; the tools reuse `decideFlag` /
  `approvePull` and record `via`.
- Merging is rebase-only (squash onto the target tip). Conflicts: line-level diff3 in `GitService.mergeTrees`; text
  conflicts are resolved automatically by AI (`worker/src/merge/`): sweep/attempt Workflow `MERGE_RESOLUTION`,
  `MergeResolver` DO (Cloudflare Computer workspace + Pi Durable harness, model `RESOLVER_MODEL` via the `AI`
  binding). A valid resolution (`merge_resolutions.status = 'proposed'` for the current shas) makes the PR mergeable.
  Tests drive `executeResolution`/`executeSweep` with fake steps and a fake resolver.
- Reviews (`worker/src/review/`): reviewer agents invited per repository (`repository_agents`). Per head commit
  (`pr_classifications`, id `<pr id>-<head sha>`): GLM one-liner per file → one Clef call over every agent's
  `trigger.ask` (`pr_reviewers`, requested iff p ≥ above; unsure = requested) → each requested agent reviews
  (`engine: pass`: one GLM-5.3 call) at its repository's default-branch SHA (`agent_sha`; `AGENT.md` + `knowledge/`
  ≤ 20 files / 64 KB) → approve or findings (`pr_review_flags.kind` `needs_person` | `change_requested`).
  `engine: pi`: `AgentReviewer` DO (`review/agent-reviewer.ts`, binding `AGENT_REVIEWER`; one per row attempt
  `<id>:<created_at ms>`) checks out the head (`review/checkout.ts`) and runs Pi with read-only tools; the Workflow
  starts it in `review:<handle>`, then `waitForEvent` + `pi:<handle>:<n>` checks (`review/pi.ts`), recording through
  `recordReview` (`review/outcome.ts`, fenced on status and `created_at`). Limits are Site admin settings
  (`review.pi_*`, `ai.review_pi_model`), read once per review start. No binding → single pass with
  `PI_FALLBACK_NOTE`. Tests use `fakePi` (`helpers/reviews.ts`). `review/gate.ts` (`reviewVerdict`) is the only
  landing rule for review; a person's `pr_approvals` row satisfies it except over an agent's open `change_requested`
  finding (dismiss it or push), and is recorded as an `approved` event (withdrawing: `withdrawn`). `landPull`: stack
  gate → checks → review. Auto-merge is on iff the repository invites ≥ 1 agent. `.orangeignore` and lockfiles stay
  out of model calls. Tests drive `executeHeadReview`/`executeReviewerRetry` with fake `AgentReviewModels`
  (`helpers/reviews.ts`). `GET /api/approvals` (`review/inbox.ts`) groups findings by agent.
- Agent learning (`worker/src/learn/`): when a PR closes (`landPull`, the close route) `queueLessons` writes one
  `agent_lessons` row per agent whose `change_requested` findings a person dismissed (`approved_at` set), unique per
  (agent, PR). A `learn` payload on `MERGE_RESOLUTION` (`learn/run.ts`) claims it (one `learning` lesson per agent;
  writes fenced on `run_id`), runs `AgentReviewer` in learn mode (`learn:<lesson id>:<attempt>`; agent repo at
  `/agent`, write/edit only `AGENT.md`'s body and `knowledge/**`), validates (`learn/validate.ts`) and commits as the
  agent (`GitService.commitFiles`, CAS + one retry), then starts the agent's next lesson. Limits `review.learn_*`;
  daily `recoverLessons`. Tests drive `executeLearn` with `fakeLearner` (`helpers/lessons.ts`).
- Agent runs (`worker/src/agent-runs/`): every `MERGE_RESOLUTION` Workflow is recorded as `agent_runs` + `agent_steps` (Actions
  tab → Agent) by one wrapper at the entrypoint (`recordAgentRun`): ids are the instance id and `<run>:<step name>` (replay-safe),
  writes never throw. Model calls land on their step via an `AsyncLocalStorage` context read by `recordAiUsage`
  (`ai_usage.agent_step_id`); decisions come from step results or `noteDecision` (short, never prompts/diffs/model text). The
  daily retention prunes them and closes runs left running over 2 h. Tests wrap executors in `recordAgentRun`.
- PR states (`worker/src/pulls/`): `pullState` = `{ state, reasons[] }` computed on read, never stored: `state.ts`
  (reasons → `agent_followup` > `human_review` > `waiting` > `ready`; add reason kinds only there), `signals.ts`
  (`pullStates`, batched per repository), `settle.ts` (`settleStates` records changes as `pr_events` rows with one
  conditional insert; called where pings happen and at the end of MERGE_RESOLUTION and Actions runs, never per step).
- Live updates (`worker/src/live/`): one hibernating `LiveHub` DO (binding `LIVE`) relays "changed" pings over
  WebSockets (`GET /api/live[?repo=o/n]`, channels `repo:<id>` and `approvals`); pages refetch through the API. Pings
  come from a middleware after successful repo mutations, `pingingSteps` around Workflow step runners, pushes, and
  `landPull`. The client (`src/lib/live.tsx`) invalidates `['repo', o, n]` / `['approvals']`.
- Instance settings (`worker/src/lib/settings.ts`, D1 `instance_settings`, Site admin → Settings, `/api/admin/settings`):
  a typed registry of keys (instance name, invitation sender, AI models, Actions retention), each defaulting to the
  wrangler var it replaced or a built-in value. Read with `getSetting`/`getSettings` only where used, never per request;
  deploy-time facts (BASE_URL, bucket names) stay in wrangler. A daily Cron Trigger (`scheduled()` in `index.ts`) runs
  `runActionsRetention` (`worker/src/actions/retention.ts`).
- Stacking (`worker/src/stack/`): always on when AI is configured, with `STACKING_DEFAULTS` (`stack/defaults.ts`). A `stack` run on `MERGE_RESOLUTION` (after the review finishes — or on PR open
  where no agent is invited — and from the sweep) pairs a PR with open PRs into the same target and
  recently landed ones: textual check (`planMerge(headA, headB)`), Clef decides over the review's one-liners (paths without one)
  (`STACK_QUESTIONS`, `routeDecision`), the reasoning model explains related pairs from diffs (and decides when Clef
  is unsure) → one `pr_edges` row per pair. `buildTree` (pure) derives parents, waits-on, must-account-for, cycles.
  Tests drive `executeStacking` with fake `StackModels`.
  Milestone 2: `pull_requests.land_target` (nullable; null means `base_ref`) is where a PR lands (always read via
  `landTargetOf`/`landTargetIs`, written on create and every retarget; readers of "where this lands" use it,
  diffs use `base_ref`). `executeReconcile` (`stack/reconcile.ts`) prunes/linearizes (`pr_edges.slot = 'order'`,
  kind `ordered_after`) and retargets `base_ref` (metadata only, CAS); `stackGate` blocks `landPull`. Tests drive
  `executeReconcile` with fake `StackModels` (`order`, `recheck`).
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
- **Deploy only when a person says so.** Run `yarn deploy` (or any `wrangler deploy`) and
  `yarn db:migrate:prod` only when a person directs it in the conversation, or after you ask and they
  confirm; never on your own initiative, and never as part of finishing a task. Deploy `main` from a clean
  checkout of `origin/main` (a separate worktree with `wrangler.jsonc` copied in), never from a feature
  branch or a dirty tree, and apply pending migrations before `yarn deploy`. Say what you deployed (the
  commit) when done. The `/gitorange-onboarding` skill deploys step by step with the deployer's confirmation.
- Submit work as a pull request for human review, on **git.xyspace.dev** (`origin`,
  `choyiny/gitorange`): push the branch, then open it with the `gitorange_create_pull_request` MCP tool
  (server `xy-space-gitorange`) and follow it with `gitorange_get_pull_request`. GitHub (`github` remote) is a
  mirror for CodeQL and Dependabot; keep it in sync with `git push github main` after merges. Never approve
  pull requests or review findings on someone's behalf.

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
