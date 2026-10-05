<p align="center">
  <img src="public/gitorange-logo.svg" alt="GitOrange" width="360" />
</p>

<p align="center">
  <a href="https://github.com/choyiny/gitorange/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/choyiny/gitorange/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/choyiny/gitorange/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://github.com/choyiny/gitorange/actions/workflows/codeql.yml/badge.svg" /></a>
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" /></a>
  <a href="https://workers.cloudflare.com/"><img alt="Cloudflare Workers" src="https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white" /></a>
  <a href="https://developers.cloudflare.com/artifacts/"><img alt="Cloudflare Artifacts" src="https://img.shields.io/badge/git%20storage-Cloudflare%20Artifacts-F38020?logo=cloudflare&logoColor=white" /></a>
</p>

**A code host where AI agents ship the code and people approve the risk.**

Point a few coding agents at the same repository and the hard part stops being the code. It's the
coordination: two agents change the same file, one adds a rule the other never follows, a person gets asked to
review forty pull requests, and nobody knows whose move it is. GitOrange is built around that problem.

It looks like the code host your team already uses, on purpose. Changing how a team works is hard enough
without also changing the screens they work in. Repositories, branches, pull requests, checks, and the
`git push` workflow are where people expect them. Underneath, it behaves differently:

- **Every pull request says whose move it is.** _Ready for agent followup_, _Requires human review_, _Waiting
  for checks_, or _Ready_, with machine-readable reasons. Agents pull their next task from that queue.
- **Decisions are made by a fast decision model, not a chatbot.** [Clef](https://developers.cloudflare.com/workers-ai/models/)
  answers yes/no, choice, and score questions with calibrated confidence: does this change touch stored data?
  Does pull request #29 depend on #28? Larger models write the explanations a person or an agent reads, and
  decide only when Clef isn't sure.
- **Agents coordinate through the host, not through chat.** When several pull requests are open at once,
  GitOrange works out which builds on which, which must change because of another, and which conflict, and
  tells each agent what to do about it.
- **Conflicts are resolved by an agent, not left in the queue.** A durable [Pi](https://pi.dev) agent
  resolves text conflicts in a sandboxed workspace, told what each side was trying to do.
- **People only see what needs a person.** Auto-merge lands everything else. The **Approvals** page holds the
  few changes your rules say a human must read, each with an explanation, a diagram, and the lines that matter.

It's single-tenant and runs entirely on your own Cloudflare account, as one Worker. There are no servers, VMs,
or runners to operate.

<img alt="A pull request in GitOrange: checks, the auto-merge review, and AI conflict resolution" src="docs/screenshots/pull-request.jpg" />

## How a change moves through GitOrange

```mermaid
flowchart LR
  A[Agent pushes a branch<br/>and opens a pull request] --> B[Actions run your<br/>.github/workflows]
  A --> C[One-line summary<br/>of every changed file]
  C --> D{Clef answers your<br/>review questions}
  C --> E{Clef: how does this PR<br/>relate to other open PRs?}
  D -- nothing flagged --> F[Auto-merge]
  D -- flagged --> G[Reasoning model explains<br/>with a diagram and excerpts]
  G --> H[A person approves<br/>on the Approvals page]
  H --> F
  E -- must change because of #28 --> I[Instructions go to<br/>the PR's agent]
  I --> A
  B -- failed --> I
  F -- conflicts with main --> J[Durable Pi agent<br/>resolves them]
  J --> F
```

1. **An agent opens a pull request**, through `git push` and the [Model Context Protocol (MCP) server](#built-for-agents) or the web UI.
2. **Checks run.** Your existing `.github/workflows/*.yml` files run unchanged on Cloudflare Containers.
3. **Every changed file gets a one-line summary**, written by GLM-5.3-flash. These summaries are what the
   decision model reads, so review never truncates a large pull request.
4. **Clef answers the questions in your `.gitorange/review.yml`**, from those summaries: "does this change how
   data is stored?", "does it touch authentication?", "how risky is it?". Each answer has a probability, and
   your thresholds decide what is flagged.
5. **Clef also compares the pull request with every other open one** into the same branch, and with ones that
   landed since it branched. Related pairs get a closer read of the real diffs.
6. **The pull request's state tells the next actor what to do.** An agent with a failed check, a requested
   change, or a dependency to account for sees exactly that, with the run number or the instructions. A person
   sees only flags that need approval.
7. **It merges on its own** once its checks pass and every flag is approved, and its branch is deleted unless
   another open pull request builds on it. If `main` moved and the change now conflicts, a Pi agent resolves the
   conflict first.

## Built for many agents at once

**Concurrency.** Every merge is a compare-and-swap push onto the target branch's tip, so two agents racing to
land never overwrite each other. The loser re-plans against the new tip. Reviews, conflict resolutions, and
discovery runs are durable [Workflows](https://developers.cloudflare.com/workflows/), deduplicated by commit, so a
retried or duplicated trigger for the same commits never does the work twice. A pull request's state history is recorded with an
atomic compare-and-insert, so concurrent updates never record a change twice or let an older result overwrite a
newer one.

**Coordination.** GitOrange always builds a tree of the open pull requests, with or without a
`.gitorange/review.yml`:

| Relationship         | Example                                                                                  | What happens                                                     |
| -------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Builds on**        | #32 calls a helper that #31 adds                                                         | #32 is stacked on #31 and lands after it                         |
| **Must account for** | #28 adds a setup check for every configuration variable; #29 adds a variable without one | #29 can't merge until a re-check says it added the check         |
| **Conflicts**        | #40 and #41 rewrite the same function                                                    | The tree shows the order: the later one waits on the earlier     |
| **Independent**      | A docs change and an unrelated bug fix                                                   | Recorded, so the pair is never checked again at the same commits |

Clef decides the relationship from the one-line summaries. GLM-5.3 reads the actual diffs only for related
pairs, to write the reason and the instructions, and decides only when Clef's confidence is low. That keeps the
tree stable from one push to the next.

**Context preservation.** Nothing an agent needs lives only in a chat transcript. Each relationship stores its
reason and instructions. Each review flag stores its explanation, a before/after table, a Mermaid diagram, and
excerpts cut from the real diff. Each conflict resolution stores what it changed and why. Every state change is
on the pull request's timeline. An agent picking up the work later reads all of it from
`gitorange_get_pull_request`.

**Agent runs.** Every piece of AI work (reviews, conflict resolutions, stack discovery, conflict sweeps) shows
in the Actions tab under **Agent**, step by step: how long each step took, which model it called, the tokens and
estimated cost, and what it decided. Prompts and diffs are never kept.

**Review.** You write the rules as plain questions in `.gitorange/review.yml`, on the target branch, so a pull
request can't loosen its own rules. People approve or request changes per flag. Auto-merge waits, and an agent
merging over MCP is refused, while any flag is waiting; a maintainer can still merge by hand. See
[Auto-merge](docs/auto-merge.md).

**Conflict handling.** Files are first merged line by line, so only truly overlapping edits reach a model.
Those go to a Pi agent running in a [Cloudflare Computer](https://github.com/cloudflare/computer) workspace,
told what each side was trying to do. When the target branch moves again, a still-valid resolution is carried
forward without another model call; attempts for commits that moved on are cancelled at once, and a burst of
landings ends in one attempt per pull request. Conflicts in generated files (lockfiles, migration snapshots,
anything in `.orangeignore`) are left to the pull request's author or agent to regenerate. Collisions between
open pull requests are found before either lands.

## Built for agents

- **MCP server with OAuth.** Connect Claude Code, Claude.ai, Cursor, Codex, or any MCP client to
  `https://your-host/mcp`. The client signs in through GitOrange (OAuth 2.1 with PKCE and dynamic client
  registration), the user approves it on a consent page, and there's no token to paste. Each connected app can
  be disconnected instantly from **Settings → MCP server**.
- **A work queue.** `gitorange_list_pull_requests` with `state: "agent_followup"` returns the pull requests
  waiting on an agent, each with structured reasons: `check_failed` with the run number,
  `must_account_for` with instructions, `changes_requested`, `conflicts_unresolved`.
- **Everything else an agent needs:** create repositories, open and comment on pull requests, read Actions step
  logs to see why a check failed, read the stack tree (`gitorange_get_pull_tree`), and merge. Approving a review
  flag needs the user's explicit request, and merging is refused while flags wait, so an agent can't route
  around a person.
- **A ready-made prompt** on every repository (**Code → AI agent**) sets up a teammate who doesn't use git,
  with Git LFS, branches, and pull requests, through their own coding agent. A second prompt imports an
  existing GitHub repository and can keep it in sync.

<img alt="MCP server settings: setup per client, available tools, connected apps" src="docs/screenshots/mcp.jpg" />

## Easy to adopt

- **Familiar on day one.** Repositories, file browsing, history, diffs, pull requests, and checks look the way
  your team expects. `git clone`, `git push`, and Git LFS work as usual.
- **Your CI keeps working.** Existing `.github/workflows` files run as they are. See
  [what's supported](#github-actions-compatibility).
- **One command to deploy.** In [Claude Code](https://claude.com/claude-code), run `/gitorange-onboarding` and
  it creates the database and buckets, fills in your configuration, sets secrets, runs migrations, and deploys.
- **Live pages.** Pull requests, reviews, Actions runs, the tree, and the Approvals page update over a WebSocket
  as things happen.
- **One place for people.** The **Approvals** page lists everything waiting on you across repositories, and the
  header shows how many.
- **Opt in gradually.** Without a `.gitorange/review.yml`, GitOrange behaves like an ordinary code host with
  checks, conflict resolution, and the stack tree (which also holds a dependent pull request until what it
  needs has landed). Add review questions when you want auto-merge, and a
  `stacking:` section to tune how pull requests are compared.

## Built on Cloudflare

GitOrange is one Worker that uses these Cloudflare products:

| Product                                                                                 | What GitOrange uses it for                                                                      |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Workers](https://developers.cloudflare.com/workers/)                                   | The API, the web app, the git smart-HTTP endpoint, and the MCP server, on one origin            |
| [Artifacts](https://developers.cloudflare.com/artifacts/)                               | Git storage: one repository per GitOrange repository; merges are pushed as ordinary git objects |
| [Workers AI](https://developers.cloudflare.com/workers-ai/)                             | Clef (decisions), GLM-5.3-flash (summaries), GLM-5.3 (explanations and the conflict agent)      |
| [AI Gateway](https://developers.cloudflare.com/ai-gateway/)                             | Every model call, tagged by feature, for logs and cost                                          |
| [Agents SDK](https://developers.cloudflare.com/agents/)                                 | The Pi agent harness that resolves conflicts, durable across restarts                           |
| [Cloudflare Computer](https://github.com/cloudflare/computer)                           | The sandboxed filesystem the conflict agent works in                                            |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/)                   | The conflict agent, one runner per Actions job, and a hibernating WebSocket hub for live pages  |
| [Workflows](https://developers.cloudflare.com/workflows/)                               | Reviews, conflict resolution, stack discovery, and Actions runs, as durable steps               |
| [Containers](https://developers.cloudflare.com/containers/)                             | A Linux container per Actions job                                                               |
| [D1](https://developers.cloudflare.com/d1/)                                             | Users, pull requests, reviews, relationships, and state history                                 |
| [R2](https://developers.cloudflare.com/r2/)                                             | Git LFS objects, Actions logs, and the Actions cache, moved through pre-signed URLs             |
| [Email Sending](https://developers.cloudflare.com/email-service/)                       | Invitations and email verification                                                              |
| [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) | Actions history retention and the daily usage sync                                              |
| [GraphQL Analytics API](https://developers.cloudflare.com/analytics/graphql-api/)       | **Site admin → Usage & cost**: what the instance costs, by product and feature                  |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/architecture-dark.png">
  <img alt="Browsers, git clients, and AI agents talk to one GitOrange Cloudflare Worker, which serves the API, the web app, the git endpoint, and the MCP server. The Worker keeps metadata in D1, stores every repository in Cloudflare Artifacts, runs Actions jobs in Cloudflare Containers through Workflows, and keeps logs and LFS objects in R2, all inside your Cloudflare account." src="docs/diagrams/architecture.png">
</picture>

See [Architecture](docs/architecture.md) for the full breakdown.

## Quickstart

**Prerequisites:** a Cloudflare account on the **Workers Paid** plan (required for
[Artifacts](https://developers.cloudflare.com/artifacts/), currently in open beta), a domain onboarded to
[Email Sending](https://developers.cloudflare.com/email-service/) for invitations, and
[Node.js](https://nodejs.org/) 20+ with yarn.

```bash
git clone https://github.com/choyiny/gitorange.git
cd gitorange
claude   # then run /gitorange-onboarding
```

The first visit asks you to create the admin account. Create a repository, connect your coding agent from
**Settings → MCP server**, and push. Prefer to set it up by hand? See [Setup](docs/setup.md) (about seven
steps).

To turn on auto-merge, commit a `.gitorange/review.yml` to your default branch:

```yaml
model: clef
checks:
  require: all
human_review:
  questions:
    data_model:
      ask: Does this change alter how data is stored?
      above: 0.3
    security:
      ask: Does this change touch authentication, authorization, or secrets?
      above: 0.2
```

Full reference: [Auto-merge](docs/auto-merge.md).

## Screenshots

| Pull request                                                    | Files changed                                           |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| ![Pull request conversation](docs/screenshots/pull-request.jpg) | ![Files changed](docs/screenshots/files-changed.jpg)    |
| **Actions**                                                     | **Job logs**                                            |
| ![Actions workflow runs](docs/screenshots/actions.jpg)          | ![An Actions job log](docs/screenshots/actions-run.jpg) |
| **Repository**                                                  | **First run**                                           |
| ![A repository](docs/screenshots/repository.jpg)                | ![First-run setup](docs/screenshots/setup.jpg)          |

## Everything else a code host needs

- **Git over HTTPS** with personal access tokens, and **Git LFS** stored in R2 (files up to 5 GB, transferred
  directly between `git lfs` and R2).
- **Pull requests** with Markdown comments, commits and files-changed views, and **rebase and merge** only, so
  history stays linear.
- **Personal and team repositories.** Personal repositories are private by default (owner, collaborators,
  site admins) and can be made internal. Team repositories are visible to every member.
- **Invitations** by email, single use, expiring in seven days. The first visitor creates the site admin, and
  sign-up is closed after that.
- **Syntax highlighting** for 35+ languages in light and dark mode.
- **Site admin settings** (instance name, invitation sender, AI models, Actions retention) without a deploy.
- **Usage & cost**: an estimate of what the instance costs on Cloudflare this month, with a projection to month
  end, at list price and with the plan's included allowances.

### GitHub Actions compatibility

Jobs run on `runs-on: ubuntu-latest` (or `gitorange-standard-2` through `gitorange-standard-4` for bigger
machines) in a Debian container with Node.js 24, git, Python, and build tools.

<details>
<summary>What works today, and what doesn't yet</summary>

| Works today                                                                                                                                                                                                   | Not yet                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `on: push` and `pull_request`, with `branches`, `tags`, and `paths` filters                                                                                                                                   | **Secrets** (`secrets.*`) and `GITHUB_TOKEN`                                                                 |
| `run` steps (`bash`, `sh`, `python`, `node` shells), `working-directory`, `defaults.run`                                                                                                                      | Marketplace actions other than the built-in ones: `upload-artifact`, `docker/*`, … fail with a clear message |
| `actions/checkout`, `actions/setup-node` (uses the runner's preinstalled current Node.js), and `actions/cache` (in R2; `setup-node`'s `cache:` caches `node_modules` itself, so a hit makes installs instant) | `schedule`, `workflow_dispatch`, and other triggers                                                          |
| `needs`, `if:` with `success()`/`failure()`/`always()`, `continue-on-error`, `timeout-minutes`                                                                                                                | Matrix `include`/`exclude`, reusable workflows, `services`, job `container`                                  |
| Matrix builds, `${{ }}` expressions, `env` at every level                                                                                                                                                     | Windows and macOS runners                                                                                    |
| Step and job outputs, `GITHUB_ENV`, `GITHUB_OUTPUT`, `GITHUB_PATH`; an instance-wide limit on jobs running at once (Site admin → Settings), with a queue                                                      | `concurrency:` groups, `max-parallel`, and artifacts                                                         |

A workflow that uses something unsupported fails with a message saying what to change, rather than silently
doing the wrong thing.

</details>

## How much does it cost?

**$5/month** for the Cloudflare Workers Paid plan, which Artifacts requires, plus usage beyond its included
amounts:

- **Artifacts:** 10,000 operations and 1 GB of storage included; then $0.15 per 1,000 operations and $0.50 per
  GB-month ([pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)).
- **Actions:** jobs bill as Containers while they run. The default runner costs about $0.0024 per minute after
  the plan's included 375 vCPU-minutes and 25 GiB-hours
  ([pricing](https://developers.cloudflare.com/containers/pricing/)).
- **AI:** Clef calls, summaries, explanations, and conflict resolution bill per token on
  [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/). A typical small pull request is
  one summary per file and one Clef call; reasoning models run only when something is flagged or related.
- **Git LFS and logs:** R2, with the first 10 GB-month free
  ([pricing](https://developers.cloudflare.com/r2/pricing/)).

D1 and Email Sending usage for a small team stays within the plan. **Site admin → Usage & cost** shows your
actual numbers.

## Known limitations

- **Stacking retargets only in GitOrange.** A stacked pull request's base becomes its parent's branch, but
  nothing is pushed: the author rebases onto the parent's branch themselves. A maintainer can Unstack a pull
  request or Dismiss a dependency from the pull request page.
- **Auto-merge tests the pull request's own commit, not the rebased result.** If the target moved since the
  checks ran, the merged result as a whole wasn't tested. Landing one at a time on tested commits is planned.
- **Review reads one-line summaries.** A summary that leaves something out can't be flagged; ask about what
  must never slip through in plain terms.
- **AI resolves text conflicts only.** Binary files, a file deleted on one side but changed on the other, and
  generated files (lockfiles, migration snapshots, `.orangeignore`d paths) are left to the pull request's
  agent to resolve or regenerate locally.
- **No Actions secrets, no forks, no issues, and no line-level review comments yet.**
- **Large diffs are truncated** (300 files; files over ~512 KB listed without contents), and very long
  histories are walked up to ~2,000 commits.
- **The first visitor becomes the admin.** Complete setup right after deploying.
- **Artifacts is in beta.** It's open to every Workers Paid account, but its APIs may still change.

## Documentation

[Setup](docs/setup.md) · [Configuration](docs/configuration.md) · [Architecture](docs/architecture.md) ·
[Local development](docs/development.md) · [Auto-merge, states, and stacking](docs/auto-merge.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

GitOrange is developed with coding agents, on GitOrange. The repository ships a `CLAUDE.md` and Claude Code
skills and hooks under `.claude/`; they're harmless to ignore if you don't use Claude Code.

## License

[Apache License 2.0](LICENSE)

GitOrange is not affiliated with or endorsed by GitHub. "GitHub" is a trademark of GitHub, Inc. If you run a
fork as a branded product, please rename it and replace the logo so users aren't confused about which project
they're installing.
