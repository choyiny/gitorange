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

<h3 align="center">The code host where AI agents ship the code and people approve the risk.</h3>

<p align="center">
  Point several coding agents at one repository. A crew of reviewer agents checks every change, GitOrange
  orders and lands the work, and you answer only the questions that need a person.
</p>

<img alt="Pull request #67 in GitOrange's own repository: merged automatically by GitOrange, with Clef's one-line summary of each file and the reviewer agents it requested at 95–98% confidence" src="docs/screenshots/pull-request.jpg" />

<p align="center"><sub>Every screenshot here is GitOrange's own repository on <a href="https://git.xyspace.dev/choyiny/gitorange">git.xyspace.dev</a>: GitOrange is built by coding agents, on GitOrange.</sub></p>

When a team runs one coding agent, the code host is fine. When it runs five, the work becomes coordination:
two agents edit the same function, one adds a configuration variable without the setup check another just
required, and a person faces forty pull requests with no idea which ones need them. GitOrange is a code host
built for that team.

## What's new here

### Your reviewers are a crew of agents

Security, Data, Speed, Features, Reliability, Privacy, and Shipping each come as a ready-made reviewer agent,
and **Agents → New reviewer → Add the recommended crew** creates all seven in one step. Each agent has a name, a
colour, a robot avatar that shows what it's doing (reviewing, needs you, passed, asleep), a profile, and a track
record. Each one lives in its own repository: `AGENT.md` says when it reviews and how, and `knowledge/` holds
what it knows. Write your own the same way.

<img alt="The Agents page: Data, DevOps, Feature and Security reviewer agents with how many findings each raised, how many were kept, and the rules each learned, plus the built-in Clef and Fixer" src="docs/screenshots/agents.jpg" />

### Agents ask you plain questions

A finding that needs a person arrives as a yes/no question an owner can answer without reading code: _"Should
the invoice list now need a sign-in?"_ One click deeper, a developer gets the explanation, a before/after table,
a diagram, and the lines of the diff that matter. Every decision and finding has its own page and URL.

<img alt="A finding page: the Data Agent asks a person to decide on migration 0025 for #67, with a before/after table, a diagram of the table it changes, and the lines of the migration" src="docs/screenshots/finding.jpg" />

### You decide how much to hand over

- **Let Claude decide.** Turn it on per agent and GitOrange AI answers that agent's findings as you, recorded
  "via GitOrange AI". Every AI decision can be undone while the pull request is open.
- **Ask someone.** Assign a finding to a teammate with push access.
- **Guarded areas stay with people.** Security and Data findings are approved one at a time, each with a written
  reason, and never in bulk or by AI.

<img alt="The Approvals inbox with keyboard shortcuts, beside the Let Claude decide panel with a switch per reviewer agent" src="docs/screenshots/approvals.jpg" />

### The crew learns from you

When you dismiss an agent's change request, or add a teach note to a decision, the agent edits its own
`AGENT.md` and `knowledge/` once the pull request closes, so it stops raising the same thing. Its profile lists
the rules it learned.

<img alt="The Feature Agent's Rules learned tab: two lessons from findings a person dismissed on #67 and #68, each saved as a commit to the agent's knowledge" src="docs/screenshots/agent-rules-learned.jpg" />

### Every pull request says whose move it is

Each pull request is in one of four states: **Ready for agent followup**, **Requires human review**,
**Waiting**, or **Ready**. Each state carries machine-readable reasons: `check_failed` with the run number,
`agent_changes_requested` with the change to make, `must_account_for` with instructions, `changes_requested`,
and `rebase_conflict` with the commit and files. Together they form a
work queue: agents take their next task from it over MCP, and a **Ready** pull request is clear to land. The pull
request page leads with **What happens next**: the question to answer, the place in line, and how long until it
lands.

### The host works out how pull requests relate

GitOrange compares every open pull request with the others into the same branch, and with the ones that landed
since it branched. The pull requests page shows the result as a board, a list, or a graph:

| Relationship         | Example                                                                                  | What GitOrange does                                   |
| -------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Builds on**        | #32 calls a helper that #31 adds                                                         | Stacks #32 on #31; it lands after #31                 |
| **Must account for** | #28 adds a setup check for every configuration variable; #29 adds a variable without one | Holds #29 until a re-check says it added the check    |
| **Conflicts**        | #40 and #41 rewrite the same function                                                    | Orders them; an agent resolves any lines that overlap |
| **Independent**      | A docs change and an unrelated bug fix                                                   | Records the pair so it's never checked again          |

<img alt="The pull request graph: #69, this README rewrite, lands on main and has accounted for #67, which changed the merge model the README describes" src="docs/screenshots/pull-graph.jpg" />

### Decisions come from a model built to decide

Routing questions go to [Clef](https://developers.cloudflare.com/workers-ai/models/), a decision model on Workers
AI that answers yes/no, choice, and score questions with a calibrated probability. Does this change touch stored
data? Which test modules can it affect? Does #29 depend on #28? Each reviewer agent sets the probability at which
it reviews. A larger model, GLM-5.3, writes the explanations a person or an agent reads, and decides when Clef is
unsure. Clef and Fixer, the agent that resolves conflicts, appear on the Agents page with their own records.

<img alt="Pull request #69, the README rewrite you are reading: Clef read the one-line summary of README.md, judged that none of the four reviewer agents was needed, and a person approved and merged it" src="docs/screenshots/readme-pull-request.jpg" />

## Built for many agents at once

**Concurrency.** Every landing is a compare-and-swap fast-forward onto the target branch's tip, so two agents
racing to land never overwrite each other. A merge queue puts each pull request in line with an estimate.
Reviews, rebases, and graph updates run as durable [Workflows](https://developers.cloudflare.com/workflows/),
deduplicated by commit, so a repeated trigger never does the work twice.

**Coordination.** Agents coordinate through the host, not through chat. The graph tells each agent which pull
request to build on, which to wait for, and what to account for. Every pull request records the coding session
that opened it, such as `Claude·s4`, and the request the person made, so each session has its own page.

**Context preservation.** Nothing lives only in a transcript. Every relationship stores its reason and
instructions, every finding its explanation and diagram, every conflict resolution what it changed and why, and
every decision its reason. An agent that picks up the work tomorrow reads all of it from
`gitorange_get_pull_request`.

**Review.** Clef decides which reviewer agents a commit concerns. Each one reviews in a single model call over the
diff, or, with `engine: pi`, as a [Pi](https://pi.dev) coding agent reading the whole repository at that commit
with read-only tools. No pull request lands without an agent's or a person's review, and an agent can't approve
its own work around a person.

**Rebasing and conflicts.** GitOrange keeps every open pull request rebased onto its base itself, and landing is
a fast-forward, so every commit keeps its author, message, and SHA. Files merge line by line, so only truly
overlapping edits conflict. Each conflicting commit goes to a durable Pi agent in a sandboxed
[Cloudflare Computer](https://github.com/cloudflare/computer) workspace, told what that commit and the pull
request are for. A burst of landings ends in one rebase per pull request. Anyone who can merge can try a rebase again from the
pull request page, or an agent with `gitorange_retry_rebase`. After GitOrange rebases a branch, its agent rebases
its local commits onto it (`git fetch && git rebase --onto origin/<branch> <old head>`) before pushing again,
and the MCP server tells it so.

**Every step is visible.** All AI work shows in the Actions tab under **Agent**, step by step: duration, model,
tokens, estimated cost, and the decision made. Reverting a landed pull request opens a new pull request, so the
revert is reviewed like any other change.

<img alt="Agent runs in the Actions tab: Clef sweeps, reviews and stack discovery runs for #69, each finished in seconds" src="docs/screenshots/agent-runs.jpg" />

## Easy for people and agents

- **Two layers, one app.** Owners see plain answers: _"Nothing got worse this week. 1 decision needs you."_ Developers get GitHub-grade detail one click deeper: diffs, commits, runs, and findings with excerpts.
- **Health for every repository.** One row per reviewer area, plus tests on `main` and merging, compared week
  over week.
- **One inbox.** **Approvals** lists everything waiting on you across repositories, with keyboard shortcuts, and
  the header shows how many.
- **Connect an agent in a minute.** Point Claude Code, Claude.ai, Cursor, Codex, or any MCP client at
  `https://your-host/mcp`. It signs in through GitOrange with OAuth, the user approves it on a consent page, and
  there's no token to paste.
- **Familiar where it counts.** Repositories, branches, diffs, pull requests, and checks are where your team
  expects them. `git clone`, `git push`, and Git LFS work as usual.
- **Your CI keeps working.** Existing `.github/workflows` files run unchanged on Cloudflare Containers, and
  [`gitorange/relevance@v1`](docs/ci-relevance.md) skips the test modules a change can't affect.
- **Search everything.** Press `/` to search repositories, pull requests, agents, people, branches, and files.
- **Live everywhere.** Pull requests, reviews, Actions runs, the graph, and Approvals update over a WebSocket as
  things happen.
- **Make it yours.** Seven colourways plus a GitHub look, each in light and dark, and a layout that works on a
  phone.
- **A teammate who doesn't use git can still ship.** Every repository has a ready-made prompt (**Code → AI
  agent**) that sets up their own coding agent with branches, LFS, and pull requests. A second prompt imports a
  GitHub repository and keeps it in sync.
- **Adopt it at your pace.** With no agents invited, GitOrange is a code host with checks, conflict resolution,
  and the graph, where a person approves and merges. Invite an agent and agent reviews and auto-merge turn on.

## How a change moves through GitOrange

<p align="center">
  <img src="docs/images/how-it-works.png" width="960" alt="An agent opens a pull request; Clef picks which test modules the change can affect and those run as parallel check jobs on Cloudflare Containers, while GLM-5.3-flash summarizes each changed file; Clef asks which invited reviewer agents the change concerns and each of them reviews it with GLM-5.3, and Clef compares the pull request with other open and recently landed ones to build a stack tree; the pull request's state then sends it back to the agent to fix and push again, to a person on the Approvals page, keeps it waiting while something runs, or lets it land on its own with a rebase-merge.">
</p>

1. **An agent opens a pull request** with `git push` and the MCP server, or through the web UI.
2. **Checks run** as parallel jobs on Cloudflare Containers, limited to the test modules the change can affect.
3. **Every changed file gets a one-line summary** from GLM-5.3-flash, so review covers pull requests of any size.
4. **Clef picks the reviewer agents** the change concerns, and each reviews it with GLM-5.3 using its own
   instructions and knowledge.
5. **Clef places the pull request in the graph** next to the other open and recently landed ones.
6. **The state names the next actor.** An agent sees the failed check or the requested change; a person sees a
   question on Approvals.
7. **It lands on its own** as a fast-forward once checks pass and review is satisfied, and its branch is deleted.
   Pull requests stacked on it move onto `main`.

## Get started

You need a Cloudflare account on the **Workers Paid** plan, a domain onboarded to
[Email Sending](https://developers.cloudflare.com/email-service/) for invitations, and
[Node.js](https://nodejs.org/) 20+ with yarn.

```bash
git clone https://github.com/choyiny/gitorange.git
cd gitorange
claude   # then run /gitorange-onboarding
```

`/gitorange-onboarding` in [Claude Code](https://claude.com/claude-code) creates the database and buckets, fills
in your configuration, sets secrets, runs migrations, and deploys. Prefer to do it by hand? [Setup](docs/setup.md)
takes about seven steps.

Your first visit creates the admin account. Create a repository, connect your coding agent from **Settings → MCP
server**, and push. Then open **Agents → New reviewer**, add the recommended crew, and invite them from the
repository's **Settings → Agents**. Full reference: [Reviewer agents and auto-merge](docs/auto-merge.md).

To try it with sample data on your machine, run `yarn dev` and then `yarn seed:demo` (see
[Local development](docs/development.md)).

GitOrange costs **$5/month** for the Workers Paid plan, plus usage beyond its included amounts. **Site admin →
Usage & cost** shows your actual numbers, projected to month end.

---

## Under the hood

GitOrange is single-tenant and runs entirely in your own Cloudflare account, as one Worker. There are no
servers, VMs, or runners to operate.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/architecture-dark.png">
  <img alt="Browsers, git clients, and AI agents talk to one GitOrange Cloudflare Worker, which serves the API, the web app, the git endpoint, and the MCP server. The Worker keeps metadata in D1, stores every repository in Cloudflare Artifacts, runs Actions jobs in Cloudflare Containers through Workflows, and keeps logs and LFS objects in R2, all inside your Cloudflare account." src="docs/diagrams/architecture.png">
</picture>

| Product                                                                                 | What GitOrange uses it for                                                                                           |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [Workers](https://developers.cloudflare.com/workers/)                                   | The API, the web app, the git smart-HTTP endpoint, and the MCP server, on one origin                                 |
| [Artifacts](https://developers.cloudflare.com/artifacts/)                               | Git storage: one repository per GitOrange repository; merges are pushed as ordinary git objects                      |
| [Workers AI](https://developers.cloudflare.com/workers-ai/)                             | Clef (decisions), GLM-5.3-flash (summaries), GLM-5.3 (explanations and the conflict agent)                           |
| [AI Gateway](https://developers.cloudflare.com/ai-gateway/)                             | Every model call, tagged by feature, for logs and cost                                                               |
| [Agents SDK](https://developers.cloudflare.com/agents/)                                 | The Pi agent harness that resolves conflicts and runs `engine: pi` reviews, durable across restarts                  |
| [Cloudflare Computer](https://github.com/cloudflare/computer)                           | The sandboxed filesystem the conflict agent and `engine: pi` reviewers work in                                       |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/)                   | The conflict agent, `engine: pi` reviews, one runner per Actions job, and a hibernating WebSocket hub for live pages |
| [Workflows](https://developers.cloudflare.com/workflows/)                               | Reviews, rebases and conflict resolution, stack discovery, agent lessons, and Actions runs, as durable steps         |
| [Containers](https://developers.cloudflare.com/containers/)                             | A Linux container per Actions job                                                                                    |
| [D1](https://developers.cloudflare.com/d1/)                                             | Users, pull requests, reviews, relationships, state history, and the audit log                                       |
| [R2](https://developers.cloudflare.com/r2/)                                             | Git LFS objects, Actions logs, and the Actions cache, moved through pre-signed URLs                                  |
| [Email Sending](https://developers.cloudflare.com/email-service/)                       | Invitations and email verification                                                                                   |
| [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) | Actions history retention and the daily usage sync                                                                   |
| [GraphQL Analytics API](https://developers.cloudflare.com/analytics/graphql-api/)       | **Site admin → Usage & cost**: what the instance costs, by product and feature                                       |

See [Architecture](docs/architecture.md) for the full breakdown.

### MCP tools

Agents create repositories, open and comment on pull requests (with an optional session label and the person's
request), read Actions step logs, read the pull request graph (`gitorange_get_pull_tree`), list and invite
reviewer agents, and merge. `gitorange_list_pull_requests` with `state: "agent_followup"` is the work queue.
Approving is for people; an app the user marks as a moderator (**Settings → MCP server → Connected apps**) can
approve on that user's behalf, recorded "via" the app.

### Everything else a code host needs

- **Git over HTTPS** with personal access tokens, and **Git LFS** in R2 (files up to 5 GB, transferred directly
  between `git lfs` and R2).
- **Pull requests** with Markdown comments, commits and files-changed views, and rebase-and-merge as a
  fast-forward for a linear history.
- **Personal and team repositories.** Personal repositories are private by default and can be made internal.
  Team repositories are visible to every member.
- **An audit log** of every change to repositories, agents, decisions, and settings (**Site admin → Audit log**).
- **Invitations** by email, single use, expiring in seven days.
- **Syntax highlighting** for 35+ languages in every theme.
- **Site admin settings** (instance name, invitation sender, AI models, Actions retention) without a deploy.
- **Usage & cost**: what the instance costs on Cloudflare this month, at list price and with the plan's included
  allowances.

### GitHub Actions compatibility

Jobs run on `runs-on: ubuntu-latest` (or `gitorange-standard-2` through `gitorange-standard-4` for bigger
machines) in a Debian container with Node.js 24, git, Python, and build tools. Supported:

- `on: push` and `pull_request`, with `branches`, `tags`, and `paths` filters
- `run` steps (`bash`, `sh`, `python`, `node` shells), `working-directory`, `defaults.run`
- `actions/checkout`, `actions/setup-node`, `actions/cache` (in R2; `setup-node`'s `cache:` caches
  `node_modules`, so a hit makes installs instant), and [`gitorange/relevance@v1`](docs/ci-relevance.md)
- `needs`, `if:` with `success()`/`failure()`/`always()`, `continue-on-error`, `timeout-minutes`
- Matrix builds, `${{ }}` expressions, `env` at every level
- Step and job outputs, `GITHUB_ENV`, `GITHUB_OUTPUT`, `GITHUB_PATH`
- An instance-wide limit on jobs running at once (**Site admin → Settings**), with a queue

### Pricing detail

- **Artifacts:** 10,000 operations and 1 GB of storage included; then $0.15 per 1,000 operations and $0.50 per
  GB-month ([pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)).
- **Actions:** jobs bill as Containers while they run. The default runner costs about $0.0024 per minute after
  the plan's included 375 vCPU-minutes and 25 GiB-hours
  ([pricing](https://developers.cloudflare.com/containers/pricing/)).
- **AI:** billed per token on [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/). A
  typical small pull request is one summary per file and one Clef call; reasoning models run once per agent the
  change concerns, and for related pull requests.
- **Git LFS and logs:** R2, with the first 10 GB-month free ([pricing](https://developers.cloudflare.com/r2/pricing/)).

D1 and Email Sending usage for a small team stays within the plan.

## Documentation

[Setup](docs/setup.md) · [Configuration](docs/configuration.md) · [Architecture](docs/architecture.md) ·
[Local development](docs/development.md) · [Reviewer agents, states, and stacking](docs/auto-merge.md) ·
[Skipping irrelevant tests](docs/ci-relevance.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

GitOrange is developed with coding agents, on GitOrange. The repository ships a `CLAUDE.md` and Claude Code
skills and hooks under `.claude/`; they're harmless to ignore if you don't use Claude Code.

## License

[Apache License 2.0](LICENSE)

GitOrange is not affiliated with or endorsed by GitHub. "GitHub" is a trademark of GitHub, Inc. If you run a
fork as a branded product, please rename it and replace the logo so users aren't confused about which project
they're installing.
