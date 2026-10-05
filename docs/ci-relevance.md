# Skipping tests a change can't affect (`gitorange/relevance@v1`)

`gitorange/relevance@v1` is a GitOrange-only workflow step. It asks Clef, a fast decision model on Workers AI, whether a change could affect a workflow's tests (as a whole and per module), and sets outputs that later jobs read in their `if:`. It's made for many small pull requests: a docs change skips the test jobs, a change to one area runs only that area's tests.

```yaml
jobs:
  gate:
    runs-on: ubuntu-latest
    outputs:
      run: ${{ steps.relevance.outputs.run }}
      run-stacking: ${{ steps.relevance.outputs.run-stacking }}
    steps:
      - id: relevance
        uses: gitorange/relevance@v1
        with:
          skip-below: 0.2
          always-run-paths: |
            test/helpers/**
          modules: |
            stacking: Stack discovery and the stack tree
            review: Auto-merge review and pull request states

  test-stacking:
    needs: gate
    if: always() && (needs.gate.result == 'skipped' || needs.gate.outputs.run-stacking == 'true')
    runs-on: ubuntu-latest
    steps:
      - run: yarn test stacking
```

## Inputs

| Input              | Default | Meaning                                                                                                                                                                                                                                         |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modules`          | —       | One `name: what its tests cover` per line. Names use letters, numbers, `-` and `_`. Required.                                                                                                                                                   |
| `skip-below`       | `0.2`   | A module (or the whole workflow) is skipped only when Clef's probability that the change is relevant is **below** this. Unsure means run.                                                                                                       |
| `always-run-paths` | none    | `.gitignore`-style patterns; a change to a matching path runs everything. `!` (exclude) lines aren't allowed. Added to the defaults: `package.json`, lockfiles, `.github/workflows/**`, `vitest.config.*`, `wrangler*.jsonc`, `tsconfig*.json`. |

A bad input (a `skip-below` that isn't a number from 0 to 1, a module line without `name: description`) fails the step with a message naming it.

## Outputs

- `run`: `'true'` or `'false'` for the whole workflow.
- `run-<module>`: `'true'` when `run` is true and Clef found the change relevant to that module.

## What Clef reads

One Clef call per run, with one yes/no question for the whole workflow and one per module. It reads the pull request's title (or the first line of the pushed commit's message, cut to 200 characters), the changed paths (at most 300 listed, the first 60 with added and deleted line counts), and, when the [auto-merge review](auto-merge.md) already finished for this commit, its one-line summary of each file. It never sees the diff itself.

A pull request is judged on its whole change since it branched from its base. A push to any other branch is judged on its whole change against the default branch (from their merge base), not just the pushed commit. Other events (`schedule`, `workflow_dispatch`, …) have no change to judge, so they run everything.

Unlike the auto-merge review, the gate doesn't send the pull request's description or the rest of the commit message: they are the author's claims about the change, not the change. Every question also tells Clef to judge only from the changed files; the title can make a change more relevant but never make a changed file irrelevant.

## Safety nets

Any of these makes every output `'true'`, checked in this order:

1. The run is a push to the repository's default branch.
2. A changed path matches `always-run-paths` or the defaults.
3. Clef isn't configured (no `AI` binding), fails, or returns an unusable answer.
4. The change has no changed paths that could be read (for example, a branch with no history in common with its base, or an event other than `push` and `pull_request`).

The step log shows which net fired, or each question's probability and the decision. Jobs skipped by the gate show as skipped; a run whose only non-successes are skipped jobs passes, so auto-merge treats it like any passing run. If the gate step itself fails (a bad input, for example), the module jobs that need it are skipped and the run fails.

On GitHub, `gitorange/` actions don't exist: give the gate job `if: github.server_url != 'https://github.com'` and write each module's `if:` so a skipped gate runs it (`needs.gate.result == 'skipped' || …`), as above.

## Cost

One Clef call per run, recorded in **Site admin → Usage & cost** under the feature `ci-relevance` and tagged the same way in AI Gateway.
