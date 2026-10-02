# Architecture

GitOrange is one Cloudflare Worker with three storage backends.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/architecture-dark.png">
  <img alt="Browsers and git clients talk to one GitOrange Cloudflare Worker, which keeps metadata in D1, stores repositories in Cloudflare Artifacts, and sends invitations through Email Sending." src="diagrams/architecture.png">
</picture>

The diagram's source is [`diagrams/architecture.html`](diagrams/architecture.html) (light) and [`diagrams/architecture-dark.html`](diagrams/architecture-dark.html) (dark); the PNGs are 2× screenshots of them.

| Concern                                                                                   | Where it lives                                                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Git objects and refs (branches, commits, files)                                           | **Cloudflare Artifacts** — one Artifacts repo per GitOrange repository                                  |
| Users, sessions, invitations, access tokens, repository metadata, pull requests, comments | **D1**                                                                                                  |
| Invitation emails                                                                         | **Cloudflare Email Sending**                                                                            |
| Git LFS file contents                                                                     | **R2**, one object per repository and oid; D1's `lfs_objects` records which objects each repository has |
| Web interface                                                                             | React SPA in `src/`, served from the same Worker via the `ASSETS` binding                               |

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

## Git LFS

`https://host/<owner>/<repo>.git/info/lfs/...` implements the Git LFS [Batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md) with the `basic` transfer adapter ([`worker/src/lfs-http.ts`](../worker/src/lfs-http.ts)). It shares the git endpoint's token authentication and repository permissions: any member can download, writers can upload.

1. `git lfs` posts a batch of `{oid, size}` objects.
2. For uploads, the worker returns a 15-minute pre-signed R2 `PUT` URL, signed together with an `x-amz-checksum-sha256` header equal to the oid so R2 rejects content that doesn't hash to it. For downloads it returns a pre-signed `GET`. Bytes never pass through the worker.
3. After uploading, the client calls `verify`. The worker checks that R2 holds the object at the declared size (and checksum), then records it in `lfs_objects`. Batch responses also adopt objects that are in R2 but were never verified.

URLs are minted per request after the permission check and never stored; D1 keeps only the bare R2 key. Objects are stored once per repository (`lfs/<repository id>/<oid>`), so deleting a repository deletes its prefix. Locking isn't implemented: listing and verifying locks return empty, and creating one returns 501.

In the web UI, a file whose blob is an LFS pointer shows the real size, an image preview, and a download link that redirects to a pre-signed URL.

## Access model

Every signed-in member can read every repository. The owner, site admins, and repository collaborators can push, open pull requests, and merge. Any member can comment.

## Authentication

[better-auth](https://www.better-auth.com/) with email/password, the `username` plugin (sign in with username or email), and the `admin` plugin (roles). Public sign-up is disabled: users are created only by first-run setup or an accepted invitation. Rate limits are stored in D1, so they hold across Worker isolates.
