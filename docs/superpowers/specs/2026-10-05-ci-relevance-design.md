# CI split, Clef relevance gate, and an Actions job queue

Status: design approved in conversation, 2026-10-05.

## Problem

GitOrange's own CI is one job: install, build, typecheck, then every test file in one `yarn test`. Every pull request
pays for the whole suite, even a docs change, and the suite runs serially in one container. With many agents opening
pull requests at once, that is slow and costly, and GitOrange Actions has no limit on how many job containers run at
the same time.

## Goal

1. CI builds once, then runs the tests split by module, in parallel.
2. A fast decision model (Clef) skips the whole workflow, or individual modules, when a change can't affect them,
   behind safety nets that keep a wrong skip from reaching `main` untested.
3. GitOrange Actions never runs more than a configured number of job containers at once, across the instance; extra
   jobs wait in a queue.

## Non-goals

- `strategy.max-parallel` or `concurrency:` group semantics in workflows (still parsed and ignored).
- Passing build outputs between jobs other than through `actions/cache`.
- Clef deciding anything for workflows that don't use the new action.

## 1. Instance-wide job queue (GitOrange Actions)

- **Setting.** `actions.max_concurrent_jobs` in the instance settings registry (`worker/src/lib/settings.ts`, Site admin
  → Settings), default `10`, minimum `1`.
- **Queue.** A job that is ready to start (its `needs` are done and its `if:` passed) asks for a slot before its
  container starts. Slots are granted first-in, first-out across the instance by one Durable Object (`ActionsQueue`),
  so the limit holds exactly under concurrency. A job without a slot stays `queued` and the run page shows "Queued
  (N ahead)".
- **Release.** A slot is released when the job completes, fails, is cancelled, or its runner is found interrupted
  (the existing interrupted-runner restart path), and the next waiter is granted. A slot held by a job that no
  longer exists or has been running past its `timeout-minutes` plus a margin is reclaimed, so a crash can't leak a
  slot forever.
- **Waiting.** The `ActionsRun` Workflow waits for its grant durably (a Workflow event or a bounded polling sleep,
  decided in planning); waiting never holds a container.
- **Cancel.** Cancelling a run removes its queued jobs from the queue.

## 2. Built-in action `gitorange/relevance@v1`

A GitOrange-only step, executed by the runner like the existing built-ins (`actions/checkout`, `actions/setup-node`,
`actions/cache`):

```yaml
- id: relevance
  uses: gitorange/relevance@v1
  with:
    skip-below: 0.2 # skip only when Clef's probability that it's relevant is below this
    always-run-paths:
      | # changes here run everything (gitignore-style globs, added to the defaults)
      worker/src/__tests__/helpers/**
    modules: |
      stacking: Stack discovery, the stack tree, and land targets
      review: Auto-merge review, flags, and pull request states
      ...
```

- **Decision.** One Clef call per run, with one yes/no question for the whole workflow ("could this change affect any
  of these tests?") and one per module ("could this change affect <description>?"). Clef reads the pull request's
  title and description (or the pushed commit's message), the changed paths with addition/deletion counts, and the
  auto-merge review's one-line summaries when that review already finished for this commit.
- **Outputs.** `run` (`'true'`/`'false'`) for the whole workflow, and `run-<module>` for each module. A module runs
  when `run` is true and its own answer is relevant.
- **Safety nets** (all built into the action, in this order; any of them makes every output `'true'`):
  1. The event is a push to the repository's default branch.
  2. A changed path matches `always-run-paths` or the defaults: `package.json`, the lockfile, `.github/workflows/**`,
     `vitest.config.*`, `wrangler*.jsonc`, `tsconfig*.json`.
  3. Clef isn't configured, fails, or returns an unusable answer.
  4. The change has no changed paths it can read.
- **Unsure means run.** A module (or the workflow) is skipped only when Clef's probability that it's relevant is
  below `skip-below`.
- **Visibility.** The step log prints each question's probability and the decision; the run's checks summary marks
  jobs skipped by the gate as skipped, which auto-merge already counts as passing (unless their run failed).
- **Cost.** One Clef call per CI run, recorded under a new AI usage feature `ci-relevance`.

## 3. GitOrange's own CI (`.github/workflows/ci.yml`)

- `build`: checkout, setup-node (with its `node_modules` cache), install, stage `wrangler.jsonc`/`.dev.vars`, build,
  typecheck; save `node_modules` and `dist/` with `actions/cache` keyed by the commit.
- `gate`: runs `gitorange/relevance@v1` with the module list; its job-level `if:` is false on GitHub
  (`github.server_url != 'https://github.com'`), where `gitorange/` actions can't run.
- One test job per module, each `needs: [build, gate]`, with
  `if: always() && needs.build.result == 'success' && (needs.gate.result == 'skipped' || needs.gate.outputs.run-<m> == 'true')`,
  restoring the commit's cache and running `yarn test <its files>`. The needs context already carries outputs
  (`worker/src/actions/executor.ts` `needsContext`); planning confirms job-level `if:` can read it.
- Modules (by test file): stacking (`stacking`, `stack-tree`, `land-target`), review and states (`review`,
  `review-diagram`, `pull-states`), merge and conflicts (`merge-resolution`, `pulls-ai-resolution`, `git-merge`,
  `squash-credits`), Actions (`actions`, `actions-syntax`, `cron`), MCP (`mcp`), git and LFS (`git-http`,
  `git-objects`, `lfs`, `raw-files`), core (`repos-pulls`, `setup-invites`, `teams-visibility`, `admin-setup`,
  `settings`, `commit-emails`, `smoke`, `live`, `usage`, `insights`, `ai-gateway`), UI libraries (`src/lib/**/*.test.ts`).
  A test file not assigned to a module fails a check in CI (so new test files are never silently skipped).

## Testing

- Queue: cap respected under many concurrent runs; FIFO order; release on success, failure, cancel, interruption;
  leaked slot reclaimed; setting changes take effect for new grants.
- Relevance action: each safety net forces all-true; probabilities below/above `skip-below`; whole-workflow false
  skips every module; malformed Clef answers run everything; outputs reachable from a dependent job's `if:`.
- CI file: a workflow-syntax test that every test file belongs to exactly one module.

## Milestones (each its own PR into `main`)

1. Job queue (setting, Durable Object, executor integration, run page "Queued (N ahead)").
2. `gitorange/relevance@v1` (built-in action, Clef questions, safety nets, docs).
3. GitOrange's own CI split, using 2.
