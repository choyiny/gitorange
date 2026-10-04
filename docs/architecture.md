# Architecture

GitOrange is one Cloudflare Worker backed by D1, Artifacts, and R2, with Actions jobs running on Cloudflare Workflows and Containers.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/architecture-dark.png">
  <img alt="Browsers and git clients talk to one GitOrange Cloudflare Worker, which keeps metadata in D1, stores repositories in Cloudflare Artifacts, and sends invitations through Email Sending. Pushes queue GitOrange Actions runs on Cloudflare Workflows, which run each job in a Cloudflare Container and keep step logs in R2." src="diagrams/architecture.png">
</picture>

The diagram's source is [`diagrams/architecture.html`](diagrams/architecture.html) (light) and [`diagrams/architecture-dark.html`](diagrams/architecture-dark.html) (dark); the PNGs are 2× screenshots of them.

| Concern                                                                                   | Where it lives                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git objects and refs (branches, commits, files)                                           | **Cloudflare Artifacts** — one Artifacts repo per GitOrange repository                                                                                                                                            |
| Users, sessions, invitations, access tokens, repository metadata, pull requests, comments | **D1**                                                                                                                                                                                                            |
| Invitation emails                                                                         | **Cloudflare Email Sending**                                                                                                                                                                                      |
| Git LFS file contents                                                                     | **R2**, one object per repository and oid; D1's `lfs_objects` records which objects each repository has                                                                                                           |
| Actions runs, jobs, and steps                                                             | **D1** (`workflow_runs`, `workflow_jobs`, `workflow_steps`); step logs in **R2**; jobs run in **Cloudflare Containers**                                                                                           |
| OAuth clients, consents, tokens, and signing keys for the MCP server                      | **D1**, in better-auth's generated tables (`oauth_*`, `jwkss`)                                                                                                                                                    |
| Auto-merge reviews                                                                        | **D1** (`pr_classifications`, `pr_review_flags`); runs on **Workflows** and **Workers AI** (GLM-5.3-flash, Clef, GLM-5.3)                                                                                         |
| AI merge resolutions                                                                      | **D1** (`merge_resolutions`); resolved commits on `refs/resolutions/*` in **Artifacts**; transcripts in **R2**; runs on **Workflows**, **Durable Objects** (Cloudflare Computer + Pi Durable), and **Workers AI** |
| Live updates                                                                              | One **Durable Object** (`LiveHub`, hibernating WebSockets); stores nothing                                                                                                                                        |
| Web interface                                                                             | React SPA in `src/`, served from the same Worker via the `ASSETS` binding                                                                                                                                         |

Nothing about git content is copied into D1. The repository page, history, and diffs are read from Artifacts on each request.

## Repository identity

Each repository row has an immutable `artifacts_name` (`r_<id>`). The Artifacts repo is addressed by that name, so renaming `alice/api` changes one D1 row and never touches storage.

## The git endpoint

`https://host/<owner>/<repo>.git` is served by [`worker/src/git-http.ts`](../worker/src/git-http.ts):

1. The client sends Basic auth with a personal access token (stored in D1 as a SHA-256 hash).
2. The worker checks the user's permission on the repository: read for `git-upload-pack` (clone/fetch), write for `git-receive-pack` (push).
3. It mints a 5-minute Artifacts token scoped to that one repository (read or write) and streams the request to the Artifacts remote.

Artifacts credentials never leave the worker.

## Reads

The repository UI uses the Artifacts binding directly: `readTree`, `readCommit`, `readBlob`, `readFile`, and `log`. Branch lists come from the git smart-HTTP ref advertisement. See [`worker/src/git/service.ts`](../worker/src/git/service.ts).

## Pull requests and merging

Artifacts has no merge API and the binding cannot write objects, so GitOrange writes git itself:

1. Find the merge base by walking commit parents through the binding.
2. Three-way merge at the tree level: take whichever side changed a path; a file changed differently on both sides is a conflict (resolve locally and push).
3. Encode the new trees and the merge commit as git objects, pack them into a packfile ([`worker/src/git/pack.ts`](../worker/src/git/pack.ts)), and push over `git-receive-pack`. The ref update is compare-and-swap, so a concurrent push to the base branch fails the merge instead of being overwritten.
4. Only after the push succeeds is the pull request marked merged in D1.

On merge or close, the head commit is pinned at `refs/pull/<n>/head`, so a pull request's diff stays viewable after its branch is deleted.

## Actions

GitOrange Actions runs `.github/workflows/*.yml` files with GitHub Actions syntax ([`worker/src/actions/`](../worker/src/actions/)).

1. **Trigger.** The git endpoint snapshots the refs before a push and diffs them after it lands; an in-app merge reports its own ref update; opening a pull request triggers `pull_request`. For each moved branch or tag, [`trigger.ts`](../worker/src/actions/trigger.ts) reads the workflow files at the new commit, applies the `on:` filters (branches, tags, paths), and writes a queued run with its jobs (matrix expanded) and steps to D1 **before** starting a Cloudflare Workflow (`ACTIONS_RUN`) named after the run id. An invalid workflow file becomes a failed run with the parse error.
2. **Execute.** The `ActionsRun` Workflow ([`executor.ts`](../worker/src/actions/executor.ts)) runs jobs in waves by `needs`, in parallel within a wave. Every status change and every job step is a durable Workflow step, so a run survives restarts. Expressions, `if:` conditions, `env` layering, step outputs, and `GITHUB_ENV`/`GITHUB_PATH` are evaluated in the Worker.
3. **Run.** Each job gets a `JobRunner` Durable Object ([`job-runner.ts`](../worker/src/actions/job-runner.ts)) that starts its own container (scheduling policy `durable_object`, image `runner`, instance size from `runs-on`) and runs each step with `exec`. `actions/checkout` fetches the commit with a short-lived read-only Artifacts token, passed through an environment variable and masked in the log. The object keeps only the running step's output in memory for live logs, plus an alarm that destroys the container if its run disappears.
4. **Logs.** Each finished step's log goes to R2 (`actions/<repository id>/...`); while a step runs, the logs endpoint reads it from the job's `JobRunner`. Deleting a repository deletes its logs.

Cancelling terminates the Workflow and destroys the job containers. A run whose Workflow crashed is marked failed the next time someone views it.

## Merging and AI conflict resolution

Every pull request lands the same way: **rebase and merge**. The pull request's changes are squashed into one commit on top of the target branch's current tip and pushed with compare-and-swap, so history stays linear and a concurrent push fails the merge instead of being overwritten.

The three-way merge runs in the Worker ([`worker/src/git/service.ts`](../worker/src/git/service.ts)). Files changed on both sides are merged line by line with diff3 ([node-diff3](https://github.com/bhousel/node-diff3)); only truly overlapping edits are conflicts. Binary files and delete-versus-edit stay conflicts for a person.

Text conflicts are resolved by AI ([`worker/src/merge/`](../worker/src/merge/)), without anyone asking:

1. **Trigger.** A push or a merge that moves a branch starts one sweep (`MERGE_RESOLUTION` Workflow) that checks, a durable step each, every open pull request into or out of that branch. Opening, reopening, or viewing a pull request checks just that one, which also backstops anything a trigger missed. Each pair of commits gets at most one attempt.
2. **Carry forward.** If the pull request already has a resolution and neither side changed its conflicted files since, the resolved files are reapplied to the new commits: a new proposal with no model call.
3. **Queue.** Otherwise a resolution attempt starts, at most 5 at once per repository (more wait as `queued`). Attempts for commits that moved on are terminated and marked superseded.
4. **Resolve.** A `MergeResolver` Durable Object writes the conflicted files, with diff3 markers, into a [Cloudflare Computer](https://github.com/cloudflare/computer) workspace in its own SQLite and runs a [pi](https://pi.dev) agent ([Pi Durable harness](https://developers.cloudflare.com/agents/harnesses/pi/) via the Agents SDK) on `RESOLVER_MODEL` through the `AI` binding. The agent gets file tools only (no shell, network, or git credentials), plus what each side changed and why: the commit subjects that landed on the target branch, and the pull request's title, description, and commits. Before its run may end, a hook checks the files: leftover markers continue the same run with the exact lines to fix.
5. **Commit.** GitOrange reads the files back, rejects any with markers, rebuilds the merge with them, and pushes the squashed commit to a side ref, `refs/resolutions/<id>`. The pull request then counts as mergeable; merging lands that commit if neither branch has moved. The agent's transcript goes to R2 (`merge-resolutions/<repository id>/<id>.json`).

A person is needed only when the model fails to answer (after pi's own retries with backoff, and Workflow retries), or after discarding a resolution: the pull request then offers to try again.

## Auto-merge

A repository opts in with `.gitorange/review.yml` on the target branch ([format](auto-merge.md)). Code: [`worker/src/review/`](../worker/src/review/).

- **Review, once per head commit and policy version** (`pr_classifications`, unique on pull request, head sha, and the policy's blob sha). Started by the same triggers as conflict resolution (the push/merge sweep, PR open and reopen, the PR page as a backstop) and run as a `MERGE_RESOLUTION` Workflow instance: a durable step per file summary (GLM-5.3-flash), one Clef call over the summaries, then a step per flag for GLM-5.3's investigation. Flags (`pr_review_flags`) hold the investigation and the approval.
- **The gate** (`autoMergeStatus`): the review is clean or every flag is approved; the required Actions runs for the head commit succeeded; and the pull request merges cleanly or has a valid AI resolution.
- **Merging** goes through the same `landPull` as the button, with no merging user (`merged_automatically`). It's attempted whenever something the gate waits on finishes: a review, an approval, a successful Actions run (from the `ActionsRun` Workflow), a proposed AI resolution, or turning auto-merge back on. Compare-and-swap on the base branch makes concurrent attempts safe; a lost race waits for the next trigger.

## Live updates

Pages update without a reload. One hibernating Durable Object, `LiveHub` ([`worker/src/live/`](../worker/src/live/)), holds every open browser WebSocket (`GET /api/live`). It relays pings that only say _what_ changed, never data: `repo:<id>` (anything in a repository) and `approvals` (anyone's approvals inbox). The worker checks that a user can read a repository before its socket may join that channel, and pages refetch what they show through the normal, permission-checked API. Pings come from a middleware after every successful change to a repository through the API, from each step of the review, conflict-resolution, sweep, and Actions Workflows (`pingingSteps`), from pushes, and from auto-merges. The browser keeps one socket per tab, collapses bursts into one refetch, and refetches everything after reconnecting.

## MCP server and OAuth 2.1

`POST /mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server ([`worker/src/mcp/`](../worker/src/mcp/)): JSON-RPC 2.0 over Streamable HTTP, stateless, tools only (`gitorange_list_repositories`, `gitorange_get_repository`, `gitorange_create_repository`). It is hand-rolled rather than built on an MCP SDK; the whole method set is `initialize`, `ping`, `tools/list`, and `tools/call`.

GitOrange is its own OAuth 2.1 authorization server, through better-auth's [`@better-auth/oauth-provider`](https://www.better-auth.com/docs/plugins/oauth-provider) plugin (plus `jwt()` for signing keys). Users, the login page, and sessions are the ones GitOrange already has.

1. A client calls `/mcp` without a token and gets `401` with `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`.
2. It reads the protected-resource document (RFC 9728) and then the authorization-server metadata (RFC 8414) at `/.well-known/oauth-authorization-server[/api/auth]`. Both are served at the origin root ([`well-known.ts`](../worker/src/mcp/well-known.ts)); the issuer is `<origin>/api/auth`.
3. It registers itself at `/api/auth/oauth2/register` (RFC 7591). A client with only loopback or app-scheme redirect URIs that omits `application_type` is registered as `native`, which desktop clients need for `http://localhost` callbacks.
4. It opens `/api/auth/oauth2/authorize` with PKCE (S256) and `resource=<origin>/mcp` (RFC 8707). A signed-out user lands on `/login`; the login form carries the signed request so sign-in continues to `/oauth/consent`, where the user allows or denies.
5. The token endpoint issues a JWT access token whose audience is `<origin>/mcp` (1 hour), plus a refresh token with `offline_access`.

[`oauth-session.ts`](../worker/src/mcp/oauth-session.ts) verifies each `/mcp` request locally against GitOrange's own JWKS (signature, issuer, audience, expiry), then requires that the user still exists, isn't banned, and still has a consent row for the client. **Settings → MCP server** lists connected apps; disconnecting one deletes its consent and tokens, so even an unexpired access token stops working immediately. Tools run as the user, with the same permissions as the web UI.

The `/mcp` resource row is inserted on demand by an auth hook rather than through the plugin's `resources` option, because that option seeds on every auth instance and GitOrange builds one per request.

## Git LFS

`https://host/<owner>/<repo>.git/info/lfs/...` implements the Git LFS [Batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md) with the `basic` transfer adapter ([`worker/src/lfs-http.ts`](../worker/src/lfs-http.ts)). It shares the git endpoint's token authentication and repository permissions: any member can download, writers can upload.

1. `git lfs` posts a batch of `{oid, size}` objects.
2. For uploads, the worker returns a 15-minute pre-signed R2 `PUT` URL, signed together with an `x-amz-checksum-sha256` header equal to the oid so R2 rejects content that doesn't hash to it. For downloads it returns a pre-signed `GET`. Bytes never pass through the worker.
3. After uploading, the client calls `verify`. The worker checks that R2 holds the object at the declared size (and checksum), then records it in `lfs_objects`. Batch responses also adopt objects that are in R2 but were never verified.

URLs are minted per request after the permission check and never stored; D1 keeps only the bare R2 key. Objects are stored once per repository (`lfs/<repository id>/<oid>`), so deleting a repository deletes its prefix. Locking isn't implemented: listing and verifying locks return empty, and creating one returns 501.

In the web UI, a file whose blob is an LFS pointer shows the real size, an image preview, and a download link that redirects to a pre-signed URL.

## Access model

Repositories live in one of two namespaces, which share the URL space:

- **Personal** (`/<username>/<repo>`): `private` by default (the owner, collaborators, and site admins can see it) or `internal` (every member can read it). The owner switches between the two in settings.
- **Team** (`/<team slug>/<repo>`): owned by the instance's single shared team, which a site admin creates and renames in Site admin. Always `internal`.

Usernames and the team slug can't collide; both directions are checked, including renames through better-auth's own endpoints.

Site admins and a repository's owner (or, for a team repository, its creator) can do everything. Collaborators can read, push, open pull requests, and merge. Every other member can read what's visible to them and comment. The same rules govern the web UI, listings, the git endpoint, and Git LFS; a repository a user can't see answers 404 rather than 403, so its existence isn't revealed.

## Authentication

[better-auth](https://www.better-auth.com/) with email/password, the `username` plugin (sign in with username or email), and the `admin` plugin (roles). Public sign-up is disabled: users are created only by first-run setup or an accepted invitation. Rate limits are stored in D1, so they hold across Worker isolates.
