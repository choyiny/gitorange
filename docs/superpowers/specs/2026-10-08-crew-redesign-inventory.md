# Crew redesign: existing features to keep

The frontend as of 54562fe (origin/main, 8 October 2026), page by page. Every redesigned page covers every
item in its section, or the PR description says where the item moved. Calls that bypass `src/lib/uiApi.ts`
are marked `[non-uiApi]`. Paths are relative to `src/`.

---

# 0. App shell and cross-cutting behaviour (`App.tsx`, `main.tsx`, `lib/live.tsx`, `lib/appName.ts`)

**Routing guards**

- **Public routes:** `/setup`, `/login` and `/invite/:token`.
- **Everything else is wrapped in `Gate`:**
  - It calls `api.setupStatus`. If setup is still required, it redirects to `/setup`.
  - It checks the session (`useSession`, better-auth). With no session, it redirects to `/login?return_to=<path+search>`.
  - Signed-in pages are wrapped in `<LiveUpdates>`.
- **Admin routes:** `/admin`, `/admin/usage` and `/admin/agents` are wrapped in `AdminOnly`. Anyone without `role === 'admin'` sees `NotFound`.
- **Repo routes:** all `/:owner/:repo/...` routes render inside `RepoLayout`. Unknown repo sub-paths render the inline `NotFound`.

**Data fetching**

- React Query defaults:
  - `staleTime` is 15s.
  - Failed queries retry up to 2 times, but never on a 404.
  - There is no refetch on window focus.

**Document title and branding**

- The browser tab title is the instance name (`appName` from `setupStatus`, default "GitOrange").
- The logo is `/logo.png`.
- `index.html` sets `data-color-mode="auto"`, so the app follows the OS light/dark setting. Mermaid also picks its dark theme from `prefers-color-scheme`.

**Live updates (`LiveUpdates` / `useLiveRepo`)**

- One WebSocket per tab to `/api/live` `[non-uiApi]`.
- Inside a repo, it connects with `?repo=owner/name`.
- A `repo` message invalidates every `['repo', owner, name, …]` query. That covers contents, pulls, the PR view, runs, agent runs, commit statuses and so on.
- An `approvals` message invalidates `['approvals']`, which feeds the header count and the Approvals page.
- Bursts of messages are collapsed with a 150ms debounce.
- It sends a keepalive ping every 30s and reconnects with exponential backoff (max 30s). After reconnecting it refetches both the repo and approvals queries.

**Polling (alongside the live updates)**

| Where                                    | Interval | Condition                                                       |
| ---------------------------------------- | -------- | --------------------------------------------------------------- |
| PR view                                  | 3s       | rebase is resolving, review in progress, or any agent reviewing |
| PR view                                  | 5s       | auto-merge is ready or waiting                                  |
| Commit checks (`commitRuns`)             | 4s       | state is pending                                                |
| Commit statuses batch (`commitStatuses`) | 5s       | any commit pending                                              |
| Actions run list                         | 3s       | any run not completed                                           |
| Run view                                 | 2s       | run not completed                                               |
| Step log                                 | 2s       | step is running                                                 |
| Agent run list                           | 5s       | any run is running                                              |
| Agent run view                           | 3s       | run is running                                                  |

- Running durations re-render every second (`useNow`).
- Setup checks have a 5-minute `staleTime`.

**Keyboard shortcuts**

- There are no global shortcuts.
- `Dropdown` closes on Escape or an outside click.
- Pull-graph nodes are focusable (`tabindex=0`); Enter or click opens the PR.
- A few inputs autofocus: login, setup, invite, new repo name, the branch filter, the title edit, the flag note, and the moderator confirm.

**Responsive behaviour**

- On phones:
  - Comment avatars and their speech-bubble arrows are hidden.
  - The file table drops its commit-message column.
  - The latest-commit bar hides the SHA.
  - The checks popover goes full width.
  - Header button labels collapse to icons.
- The settings sidebar is hidden below the md breakpoint.

---

# 1. Header (`components/Header.tsx`)

- **Left side**
  - The logo links to `/`.
  - The context area defaults to a "Dashboard" link. Pages can override it with a breadcrumb or a label such as "Settings" or "Site admin".
  - Pages can also add a nav row beneath the bar (the repo tabs, the profile tab).
- **Setup errors badge (admin only)**
  - It is a red button reading "N setup error(s)" that links to `/admin#setup`.
  - The count comes from `useSetupChecks` (`GET /api/admin/setup` `[non-uiApi]`). The badge is hidden when there are no errors.
- **Approvals button (everyone)**
  - It links to `/approvals` and shows a count badge from `useApprovalCount` (`api.approvals({limit:1})`, which returns `count`).
  - The count updates live.
- **"+" create menu**
  - "New repository" links to `/new`.
  - "Invite member" links to `/admin?invite=1` (admin only).
- **Avatar menu**
  - The menu header shows the avatar, `displayUsername` and name.
  - Links: "Your profile" (`/:username`) and "Your repositories" (`/:username?tab=repositories`; Profile ignores `tab`).
  - Links: "Personal access tokens" and "MCP server".
  - "Site admin" (admin only).
  - "Sign out" calls better-auth `signOut()` and then goes to `/login`.
- **Gaps**
  - There is no global search.
  - Settings → Emails is not in this menu. It is reachable only through the settings sidebar, which is hidden on mobile.

---

# 2. Setup (`/setup`, `pages/Setup.tsx`)

- The page uses `AuthShell`, titled "Welcome to {appName}", with an intro line.
- If setup is not required, it redirects to `/login`.
- **Form fields:** full name, username, email, and password (minimum 8 characters, with a hint).
- **Submit ("Create admin account")**
  - It calls `api.setup`, then signs in with better-auth `signIn.email`.
  - It then invalidates all queries and navigates to `/`.
  - Errors appear in a flash.

# 3. Login (`/login`, `pages/Login.tsx`)

- The title is "Sign in to {appName}".
- If setup is still required, it redirects to `/setup`.
- **Already signed in**
  - Normally it redirects to `return_to`, which must start with `/`.
  - During an OAuth flow (the query has `sig` and `client_id`), it instead resumes with `window.location.replace('/api/auth/oauth2/authorize?…')` `[non-uiApi]`.
- **Fields:** "Username or email address" and password.
  - If the login contains `@`, it uses `signIn.email`; otherwise `signIn.username`.
- **After sign-in**
  - If the response carries a `url` (OAuth flow), the browser follows it.
  - Otherwise it invalidates queries and navigates to `return_to`.
- A failed sign-in shows "Incorrect username or password."
- The footer reads "New to this instance? Ask an administrator for an invitation."

# 4. AcceptInvite (`/invite/:token`, `pages/AcceptInvite.tsx`)

- It calls `api.validateInvite(token)` with no retry.
- **Invalid or expired invite:** the page reads "Invitation not found", with a warning and a "Go to sign in" button.
- **Valid invite**
  - The title is "Join {appName}", with "@{inviter} invited you to join."
  - The email field is shown read-only.
  - Fields: name, username, and password (minimum 8 characters).
- **Submit ("Create account")**
  - If someone is already signed in, it calls `signOut()` first.
  - It then calls `api.acceptInvite`, then `signIn.email`, and navigates to `/`.

# 5. Dashboard (`/`, `pages/Dashboard.tsx`)

- **Left aside**
  - It shows the user's avatar and username.
  - The "Top repositories" list holds repos the user owns plus all team repos, with a "New" button linking to `/new`.
  - A client-side "Find a repository…" filter narrows the list.
  - Each row shows the owner avatar (square for the team) and a `fullName` link.
  - The empty state reads "You don't have any repositories yet."
- **Main column**
  - The heading is "Home".
  - Admins see a "Bring your team" card with "Invite member", linking to `/admin?invite=1`.
  - "Recently updated across this instance" lists all visible repos from `api.repos`. Each row shows the owner avatar, a name link, `VisibilityLabel`, the description and "Updated {timeAgo}".
  - The empty state reads "No repositories yet", with a "Create repository" CTA.

# 6. Approvals (`/approvals`, `pages/Approvals.tsx`)

- **Header text:** a description, plus "**N items** to go" when the count is above zero.
- **Data**
  - It uses `useApprovalPages`, which pages through `api.approvals({cursor})` as an infinite query.
  - Items are de-duplicated by `repo#number`.
  - A "Load more" button fetches the next page.
- **Loading, error and empty states**
  - Loading shows a spinner; errors show a flash.
  - The empty state reads "Nothing is waiting on you" and explains what would appear here.
- **Each item is a Box**
  - The header shows the repo `fullName`, the PR title (linked), the PR number, the author and the updated time.
  - **Generic human review:** shown when the state is `human_review` and no other card applies. It shows `PullStateLabel` and `PullStateReasons`, with a "Decide on the pull request" link.
  - **Review failed:** shows the error and "Try the review again" (`api.retryReview`).
  - **AI resolution failed:** shows the message and a "Decide on the pull request" link.
  - **Stale stack, one per PR:** "Still must account for #N (nothing new since …)", with a "View #N" link.
  - **Unchecked stack:** "Couldn't check against #…", with "Check again" (`api.retryStack`).
  - **Needs approval:** "No agent reviewed this commit: a person approves it."
    - If an agent requested changes, it adds a warning that approving does not override that request.
    - "Review the changes" links to the PR.
    - "Approve" calls `api.approvePull(…, headSha)` and is disabled when there is no `headSha`.
  - **Per agent:** avatar and an `@handle` link.
    - A failed review shows the error and "Retry" (`api.retryReviewer`).
    - Each finding renders a `Flag`: "Approve"/"Dismiss" (`api.approveFlag`), and "Request changes" with an optional note of up to 1000 characters (`api.requestFlagChanges`).
    - Decisions show an optimistic "by you" until the list reloads.
- **Errors inside an item**
  - Errors show in a flash.
  - A 409 conflict on a note adds "Your note was not sent."
  - Every action invalidates both the repo's queries and `approvals`.

# 7. NewRepo (`/new`, `pages/NewRepo.tsx`)

- **Owner select**
  - It offers the current user, or the team (loaded with `api.team`).
  - It is disabled when no team exists, with a tooltip saying a site admin can create one.
  - `?owner=team` preselects the team.
- **Name field**
  - It is required and autofocused.
  - It shows a live preview when the name will be normalised: "will be created as **x**".
- **Optional description.**
- **Visibility**
  - For a user owner: Private or Internal radios, each with an explanation.
  - For the team: a fixed "Internal" note.
- **"Add a README file" checkbox**, with a hint that GitHub importers should leave it empty because the next page has import steps and an agent prompt.
- **Submit ("Create repository")**
  - It is disabled while the name is blank.
  - It calls `api.createRepo`, invalidates the repos list, and navigates to the new repo.
  - Errors appear in a flash.

# 8. Profile (`/:owner`, `pages/Profile.tsx`)

- **Data and 404:** it loads `api.namespace(owner)`; a 404 shows the full `NotFound`.
- **Header:** the context is an owner link. The nav row has one "Repositories" tab with a count.
- **Left column (all variants):** a 260px avatar (square for the team), the name and the username.
- **Person variant:**
  - Email as a `mailto:` link, when present.
  - "Joined {timeAgo}".
- **Team variant:**
  - "Team · every member can see these repositories".
- **Agent variant (`AgentAbout`)**
  - An "Agent" label, or "Deleted agent" if deleted.
  - The bio.
  - "Reviews when", showing `trigger.ask` and "(Clef: yes with probability ≥ X)".
  - If AGENT.md has an error, a warning says the page shows the last valid version.
  - "Defined in" links to the agent's repo.
  - "Invited to" lists repo links.
  - "Recent reviews" shows `repo#n` links, a status label (from `REVIEWER_STATUS`) and the time.
  - "Learning" lists lessons. Each shows a `repo#n` link and a status: Queued, Learning, Learned, Nothing to learn, or Failed.
    - It also shows the time and a "Dismissed "…"" findings text.
    - It ends with a commit SHA (linked to the agent repo's commit) or a note.
- **Right column (all variants)**
  - The "New" button appears on the team's page (links to `/new?owner=team`) or your own profile (links to `/new`).
  - The repo list shows a name link, `VisibilityLabel`, the description and "Updated {timeAgo}".
  - The empty state reads "… doesn't have any repositories (you can see) yet."

# 9. RepoLayout (repo header and tabs, `components/RepoLayout.tsx`)

- **Data:** it loads `api.repo(o, n)`. The result (`RepoDetail`) is passed to child pages through the Outlet context. A 404 shows the full `NotFound`.
- **Live updates:** it subscribes to `useLiveRepo` only after the repo has loaded, so only once access is confirmed.
- **Header context:** an `owner / repo` breadcrumb with both parts linked.
- **Tabs**
  - **Code** is active for every path except pulls, compare, settings, actions and insights.
  - **Pull requests** shows the `openPullCount` counter.
  - **Actions** and **Insights**.
  - **Settings** appears only with `permissions.admin`.
- **Title row:** a repo icon, `owner / repo` links, and `VisibilityLabel`.
- **Quirk:** on `/pull/:n` and `/compare` no tab appears selected.

# 10. RepoCode (`/:o/:r`, `tree/<ref>/<path>`, `blob/<ref>/<path>`, `pages/RepoCode.tsx`)

**Empty repo (`repo.empty`) shows QuickSetup**

- "Set up with an AI agent" has two tabs, "Start a new project" and "Import from GitHub", each with an `AgentPrompt` (work or import prompt) and a copy button.
- "Quick setup" shows the HTTPS clone URL, which selects on focus, with a copy button and a hint to use a personal access token.
- Copyable command blocks:
  - create a new repo on the command line, with LFS;
  - push an existing repo;
  - import from GitHub with `--mirror` (all branches, tags and LFS files), plus re-sync notes;
  - store large files with Git LFS (up to 5 GB each, with a link to git-lfs.com).

**Non-empty repo**

- It calls `api.contents(o, n, refPath)`, where `refPath` is the `<ref>/<path>` string after `tree` or `blob`. A 404 shows the inline `NotFound`.
- **Toolbar**
  - `BranchSelect` switches branches and keeps the current path and the tree/blob mode.
  - At the root it shows the branch count. Elsewhere it shows a breadcrumb (repo name, then path segments).
  - At the root only, `CloneButton` appears.
- **Latest-commit bar** (above the tree, blob and LFS views)
  - The commit author (`CommitAuthor`) and the first line of the message, linked to the commit.
  - `CommitStatus`: a checks icon that opens a popover (`api.commitRuns`).
  - The short SHA, the age, and a "History" link to `/commits/<ref>`.
- **Tree view**
  - A ".." parent row.
  - Directory and file rows. Each shows its last commit message (linked) and age from `api.treeCommits`, which is cached forever.
  - The README is rendered below the tree: Markdown files through `Markdown`, with relative links and images resolved inside the repo; anything else as preformatted text.
- **Blob view**
  - The header shows the line count and size, a "Raw" link (`api.rawUrl`, opens a new tab), and "Copy raw content".
  - Markdown files are rendered.
  - Text files show line numbers with syntax highlighting (highlight.js, lazy-loaded). Each row has an `id="L{n}"` anchor, but there is no clickable line link.
  - Binary images render inline; other binaries say "Binary file not shown. View raw".
  - Files that are too large show "can't show files this big", with "View raw".
- **LFS file view**
  - It shows the real size and a "Stored with Git LFS" label.
  - "Download" uses `api.lfsUrl(oid, filename)`.
  - Images get an inline preview.
  - If the content was never uploaded, it says so and suggests `git lfs push --all origin`.
- **About sidebar (root only):** the description (or "No description provided.") and "Created {timeAgo}".

# 11. RepoCommits (`/:o/:r/commits/<ref>`, `pages/RepoCommits.tsx`)

- The heading is "Commits".
- `BranchSelect` navigates to `/commits/<branch>` and resets the page.
- `api.commits(o, n, ref, page)` feeds `CommitList`:
  - commits are grouped by day;
  - each row shows its checks badge (one batched `api.commitStatuses` call);
  - "…" expands the rest of the message;
  - each row shows the author or committer and the time;
  - a short-SHA link and "Copy full SHA" sit on the right.
- **Pagination:** "Newer" and "Older" buttons, using `hasMore`. The page number is local state, not in the URL.

# 12. CommitView (`/:o/:r/commit/:sha`, `pages/CommitView.tsx`)

- **Data:** it loads `api.commit`. Any API error shows the inline `NotFound`.
- **Message:** the first line as the title and the rest as preformatted text.
- **"Browse files"** links to `/tree/<sha>`.
- **Meta line**
  - `CommitAuthor` ("X authored and Y committed" when they differ).
  - The time.
  - Parent count with linked short SHAs.
  - The full SHA.
- **Files:** "Showing N changed files" with `DiffTotals`, then `DiffView`.

# 13. Pulls (`/:o/:r/pulls`, `pages/Pulls.tsx`)

**URL and view state**

- `?state=` takes `closed`, `agent_followup`, `human_review`, `waiting` or `ready`. With no value it means open.
- The list/graph choice is saved in localStorage (`gitorange.pulls.view`).

**Toolbar**

- A read-only search box shows `is:pr is:<state>`. It is decorative.
- "New pull request" links to `/compare` and needs write permission.

**Box header**

- "N Open" clears the state filter. "N Closed" sets `state=closed`.
- On open lists, a state dropdown offers "All open" and the four PR states.
- The List/Graph toggle appears only when `state === open`.

**List (`api.pulls(o, n, state)`)**

- Each row shows the PR state icon and the title link.
- `ChecksBadge` per head SHA comes from one batched `api.commitStatuses` call.
- `AiResolutionBadge` shows a sparkle and spinner while AI is resolving, or an alert when it failed.
- `PullStateLabel` shows the state with its first reason.
- **Meta line**
  - Open PRs: `#n opened {time} by {author link}`, then a `ReviewLabel`.
    - `ReviewLabel` reads Reviewing…, Review required (· N flags), Approved, Review failed, Changes requested, or Needs approval.
  - Merged PRs: "by X was merged {time}".
  - Closed PRs: "by X was closed {time}".
- A comment count with a link appears on the right.
- The empty state reads "There aren't any … pull requests", with a "Create a pull request" link for writers.

**Graph view (`PullGraph`, `api.pullTree`)**

- **Legend:** stacked on, waits on (dashed), lands after (dotted), must change for (red), accounted for (dashed). Arrows point at what lands first.
- **One Mermaid flowchart per land target branch** (Mermaid is lazy-loaded and its SVG sanitised):
  - The target header shows "recently landed: #n…" links.
  - Node tooltips list the PR's state and dependencies.
  - Nodes are coloured by PR state; merged dependencies are shown as purple nodes.
  - Clicking a node or pressing Enter opens that PR.
- **States**
  - A cycle shows a warning flash, and the cycling nodes are outlined in red.
  - A Mermaid parse failure shows "couldn't be drawn". A load error shows a flash.
  - The empty state reads "Nothing is slated to land."

# 14. PullNew / compare (`/:o/:r/compare`, `compare/<base>...<head>` or `compare/<head>`, `pages/PullNew.tsx`)

- **Header:** "Comparing changes" becomes "Open a pull request" once the form is open.
- **Branch pickers**
  - "base:" and "compare:" `BranchSelect`s. Picking navigates to `/compare/<base>...<head>`.
  - Next to them, the rebase status reads "Able to merge… can be rebased cleanly" or "Can't rebase automatically… you can still create".
- **No head chosen, or head equals base:** a "Compare changes" blankslate with one quick-pick button per branch.
- **Comparison (`api.compare(base, head)`)**
  - Loading shows a spinner; errors show a flash.
  - With nothing to compare (no commits, or the head is behind): "There isn't anything to compare."
  - Otherwise a banner reads "Discuss and review…".
    - "Create pull request" (write permission only) opens the form.
    - The title is pre-filled: the single commit's message, or a humanised branch name.
  - **Form**
    - It shows the current user's avatar.
    - "Add a title", plus a description in `MarkdownEditor` (Write and Preview tabs).
    - "Create pull request" calls `api.createPull`, invalidates the repo, and navigates to the new PR.
  - **Stats bar:** commit count, files changed, and `DiffTotals`.
  - Below it, a `CommitList` (oldest first) with checks, then `DiffView`.
- A "Back to pull requests" link sits at the bottom.

# 15. PullView (`/:o/:r/pull/:n` and `/pull/:n/:tab`, where tab is `commits` or `files`; `pages/PullView.tsx`)

**Data**

- `api.pull` loads the PR, with the polling described in section 0. A 404 shows the inline `NotFound`.
- `api.pullCommits` loads only on the Commits tab; `api.pullFiles` only on the Files tab.
- `refresh()` invalidates the repo, the pulls lists, approvals, `['namespace']` and the PR itself.

**Header**

- The title with the PR number.
- "Edit" appears for anyone who can merge, and for the PR author. It opens an inline title input with "Save" (`api.updatePull({title})`) and "Cancel". The PR body cannot be edited.
- `PrStateBadge` (Open, Closed or Merged).
- "{author or merger} wants to merge / merged N commits into `base` from `head`". The head branch links to its tree.

**Tabs (`NavLink`)**

- Conversation, with the comment count.
- Commits, with `commitCount`.
- Files changed, with a count once the files have loaded.

**Commits tab:** `CommitList`, oldest first, with checks.

**Files tab:** `DiffTotals` and `DiffView`.

**Conversation tab: timeline**

- The PR body is the first comment, labelled "Author"; an empty body shows "No description provided."
- Each comment shows the avatar, author link, "commented {time}" (full date on hover), Markdown, an "Author" label for the PR author, and a highlight for the current user's own comments.
  - Comments cannot be edited or deleted.
- Between comments, `timelineSlots` places entries by time:
  - `PullEventItem` entries;
  - `AgentReview` for the current head commit;
  - `EarlierReview` for earlier commits.
- **Merged**
  - A timeline event reads "{merger} merged commit {sha link} into base {time}". If GitOrange merged it, it reads "Auto-merge" with a sparkle instead.
  - A merged box reads "successfully merged and closed".
    - It notes the branch can be deleted, was deleted automatically, or has been deleted.
    - "Delete branch" (`api.deleteBranch`) appears when the user can merge, the branch exists, and it is not the default branch.
- **Closed:** a "This pull request was closed {time}" event.
- **Open PRs also show:**
  - `ChecksBox`, the head commit's workflow runs with "Details" links (`api.commitRuns`);
  - the merge box (below).
- **Comment composer**
  - It uses `MarkdownEditor`.
  - "Close with comment" or "Close pull request" (`api.comment`, then `api.updatePull({state:'closed'})`) appears for users who can merge and the author, while open.
  - "Reopen pull request" appears when the PR is closed and the head branch still exists.
  - "Comment" calls `api.comment`.

**Merge box** (open PRs; `MergeBox` in `PullView.tsx`)

- The icon is green when the PR can land and grey when it is held (conflict, resolving, or branch gone).
- If the state is not `ready`, it shows `PullStateLabel` and `PullStateReasons`.
- **Rebase headline (`rebaseHeadline`):**
  - "This branch is up to date";
  - "Up to date with X";
  - "Behind X";
  - "Resolving commit abc's conflict with AI";
  - "Commit abc conflicts with X", or the error text.
  - While checking it reads "Checking the branch…"; if the branch was deleted, "The {head} branch is gone".
  - Conflicting or resolving files are listed with `FileList` (show more / show fewer).
- **"Try the rebase again"** (`api.retryRebase`) appears when the user can merge and the rebase stopped on a retryable conflict.
- **`AutoMergeStatus`** (when `review.autoMerge.state` is not `off`):
  - `ready`: "Merging automatically…" with a spinner.
  - `disabled`: "Auto-merge is off for this pull request".
  - `blocked`: "Won't merge automatically:" followed by the reasons.
  - `waiting`: "Merges automatically once ready. Waiting on: …", with a "Review the flags" anchor to `#auto-merge-review`.
  - A "Turn off/on auto-merge" toggle (`api.setAutoMerge`) appears for users who can merge.
- **`PersonApprovals`**
  - It lists the people who approved the commit (with "via {app}" for approvals made through a moderator app), or "No person has approved this commit."
  - A warning appears if an agent requested changes.
  - "Approve" (`api.approvePull(headSha)`) carries an explanatory tooltip; "Withdraw approval" (`api.withdrawApproval`) appears instead once you have approved.
  - Both need an open PR and permission to merge.
- **Merge button** (shown when the user can merge and the PR is mergeable)
  - It reads "Rebase and merge", or "Approve and merge" when the review is not yet satisfied.
  - It opens a confirm step:
    - The step explains what will happen: rebase first if the branch is behind, otherwise the base fast-forwards to the head.
    - It lists the unsatisfied reasons and warns that approving does not override an agent's change request.
    - "Confirm rebase and merge" (or "Confirm approve and merge"), and "Cancel".
  - Confirming calls `api.mergePull({headSha, approve?})`.
  - **A 409 conflict response:**
    - If GitOrange rebased first and is now waiting on checks or review, a neutral notice appears instead of an error.
    - Otherwise an error appears.
    - Either way the page reloads and the confirm step closes.
- Users who cannot merge see "Only those with write access to this repository can merge pull requests."

**Sidebar**

- **`ReviewersSidebar`** (when a review exists)
  - The heading reads "Reviewers of {sha}", with "View run" (`AgentRunLink`, kind `review`).
  - A progress line shows "Summarizing each changed file…" or "Asking which agents this concerns…".
  - A failed review shows the error and "Try the review again" (`api.retryReview`).
  - With no agents invited: "a person approves each commit", plus an "Invite agents" link to settings for users who can merge.
  - When no invited agent was needed: "No invited agent was needed for this commit, so a person approves it."
  - Requested agents are listed with a status link that jumps to their timeline entry; the tooltip shows the Clef probability.
  - A collapsible "Not needed (N)" list shows the Clef % for each.
  - "Approved by" lists people (with via).
  - A collapsible "What the agents read" lists per-file summaries with +/− counts.
- **`StackSidebar`** (when the PR is stacked)
  - The heading is "Stack", with "View run" (kind `stack_discovery`).
  - Status lines read "Checking against other open pull requests…" or "Independent…", or list pending checks.
  - It shows "Builds on #n: reason", or "Lands after #n so #m can build on both: reason".
    - With write permission, "Unstack" (`api.unstack`) appears.
  - "Built on by #…".
  - "Waits on #n", with "Dismiss" (`api.dismissStackEdge`).
  - "Must change for #n (landed)": shows the reason, instructions, and an "accounted for" label.
    - With write permission, "Dismiss" appears.
  - A cycle warning appears when PRs depend on each other in a circle.
  - "Couldn't check against #…" offers "Retry" (`api.retryStack`) with write permission.
- **Participants:** de-duplicated avatars of the author, commenters and the merger.

**AgentReview timeline entry** (`components/ReviewersBox.tsx`)

- **Header**
  - The agent avatar, an `@handle` link, a status icon and verb ("approved these changes", "flagged N findings for a person", "requested changes", "is reviewing…", "couldn't finish its review").
  - The time, with the full date on hover.
  - A "removed" label if the agent is no longer invited, and an "Agent" label.
- **Body**
  - The summary.
  - On failure, the error and "Retry" (`api.retryReviewer`), shown to users who can act if the agent is still invited.
  - Each finding is a `Flag`:
    - title, a "Change requested" label, paths, and Markdown detail (or "Looking into this…" while reviewing, or "No further detail…");
    - who requested changes, with their note;
    - "Request changes", with a note composer of up to 1000 characters (`api.requestFlagChanges`); only on findings that need a person;
    - "Approve", or "Dismiss" for change requests (`api.approveFlag`);
    - "Approved/Dismissed by X (via app)" afterwards, or "Not approved".
- **Footer**
  - "of {sha}" and "requested at Clef X%".
  - "AGENT.md @ sha", linked to the commit in the agent's repo.
  - "View run".

**EarlierReview:** the same layout, read-only and muted. It reads "… on {sha link}, an earlier commit". Its findings sit in a collapsible `<details>` and have no controls.

**PullEventItem kinds** (`components/PullEvents.tsx`)

- `state_changed`: the state label with its blocking reasons.
- `stacked`: "Stacked on #n" with the branch and reason.
- `unstacked`.
- `ordered`: "Lands after #a so #b can build on both".
- `must_account_for`: optional "Rebase onto X first", and instructions marked "Generated by GitOrange; advisory".
- `accounted_for`.
- `dismissed`: who dismissed the dependency.
- `approved`: who, via which app, the short head SHA, and "over …" the reasons.
- `withdrawn`.
- `learned`: "@agent learned from N dismissed findings · sha", with the SHA linked.
- `rebased`: from → to, skipped commits and AI-resolved count, with a link to the new head.
- Any other kind renders nothing.

# 16. RepoActions (`/:o/:r/actions`, `pages/RepoActions.tsx`)

**URL state:** `?workflow=<path>`, `?page=N` and `?agent=<kind>`.

**Left nav**

- "All workflows".
- A "Workflows" list (from the runs response).
- An "Agent" list: Review, Rebase, Conflict resolution (squash-era), Stack discovery, Sweep and Learning. Each links to `?agent=<kind>`.

**Workflow runs (`api.runs(o, n, page, workflow)`)**

- The heading is the workflow name and path, or "All workflows".
- **Empty states**
  - Not configured, with no runs: "Actions isn't set up on this server", pointing to docs/configuration.md.
  - Configured, with no runs: "Get started with Actions", with a copyable starter `ci.yml` and notes on what is supported (run steps, checkout, setup-node, needs, if, matrix, expressions, outputs; `runs-on: gitorange-standard-2` up to `-4`).
- **List**
  - The header reads "N workflow runs".
  - Each row shows `RunStatusIcon`, the run title (linked to the run), "workflow #n", and the trigger ("Pull request #n by X" or "Commit sha pushed by X").
  - A PR-number label or a branch label.
  - The created time and the duration.
- **Pagination:** "Previous" and "Next", 25 per page, kept in the URL.
- While an agent kind is selected the run list is hidden rather than unmounted.

**Agent sub-tab (`AgentRunList` in `pages/AgentRuns.tsx`, `api.agentRuns({kind, cursor, limit:25})`)**

- The heading is the kind label, with "Agent runs".
- Errors show a flash. The empty state reads "No … runs yet".
- Each row shows a status icon, the title (linked to the agent run), the kind and PR title, any error in red, a PR-number label, the started time and a live-ticking duration.
- **Pagination:** cursor-based "Newer" and "Older". The cursor is local state, not in the URL.
- A footer note says costs are list-price estimates and that prompts and outputs are not kept, with "Back to workflows".

# 17. RunView (`/:o/:r/actions/runs/:n` and `/job/:jobId`, `pages/RunView.tsx`)

- **Data:** it loads `api.run` and polls every 2s until the run completes. Errors show a flash.
- **Header**
  - A back link to `/actions`, labelled with the workflow name.
  - A status icon and the title with the run number.
  - With write permission: "Re-run all jobs" (`api.rerun`, then navigates to the new run number) when the run is complete, otherwise "Cancel workflow" (`api.cancelRun`).
  - Action errors show a flash.
- **Left nav:** "Summary", plus one job link per job with its status icon.
- **Summary**
  - "Triggered via push/pull request {time}".
  - The actor, "updated #PR" or "pushed", a SHA link, and the branch label.
  - The status and the total duration.
  - The run's `errorMessage`, if any, as preformatted text.
  - A jobs panel titled with the workflow file name and "on: event". Each job card shows its status and duration, or "Queued (N ahead)".
- **Job log (`/job/:jobId`)**
  - A dark log panel.
  - The header shows the job name and its state: "succeeded X ago in D", "Queued (N ahead)", "started …", or "Waiting for a runner".
  - Steps are collapsible.
    - The running or failed step opens automatically.
    - Each step shows its status icon, name and duration.
  - The step log (`api.stepLog`) loads only when its step is opened. It polls every 2s while the step runs.
    - Lines are numbered.
    - Lines starting `Error` or `##[error]` are red.
    - Empty logs read "Waiting to start…" or "No output".

# 18. AgentRuns view (`/:o/:r/actions/agent/:id`, default export of `pages/AgentRuns.tsx`)

- **Data:** it loads `api.agentRun`, polling every 3s while the run is running. Durations tick live, and errors show a flash.
- **Header:** a back link to `?agent=<kind>`, plus a status icon and the title.
- **Left nav:** the agent kinds.
- **Summary box**
  - The started time, and the PR link (or the kind).
  - The status and the total duration.
  - Tokens in and out, and the estimated cost.
  - A footer listing the models used (the `@cf/` prefix is stripped).
- The run error, if any.
- **Steps box**
  - The workflow instance id.
  - Each step shows its status, display name (the raw name on hover), an "N attempts" label when retried, and its duration.
  - Below that, the model, tokens, cost estimate, decision text and error.
  - The empty state reads "Starting…" or "No steps were recorded."

# 19. RepoInsights (`/:o/:r/insights`, `pages/RepoInsights.tsx`)

- **URL state:** `?days=` takes 7, 30, 90 or 365 and defaults to 30. Changing it replaces the history entry. Previous data stays on screen while the new period loads.
- **Header:** "Insights" with the date range, and a period button group (1 week, 1 month, 3 months, 1 year).
- **Data:** `api.insights(o, n, days)`. Errors show a flash.
- **Headline cards**
  - Merged (with opened and open now).
  - Auto-merged %.
  - Needed a person %.
  - CI pass rate.
- **Pull requests section**
  - Opened, and merged with an auto-vs-person progress bar and legend.
  - Merged with no one involved, and merged after human review.
  - Closed without merging, and "Open now" (links to pulls).
  - Median time to merge: overall, when auto-merged, and when merged by a person.
- **Auto-merge review section**
  - Reviews run, cleared for auto-merge, asked a person, and failed.
  - PRs that needed human review.
  - Flags raised and approved, and the median time to approval.
  - "Waiting on a person now" (links to `/approvals`).
- **Flags by kind section:** a table of raised and approved counts, each kind linking to `/{key}`. The empty state reads "No flags raised in this period."
- **Agents learning section:** per agent, `@handle`, dismissed count and lessons. The empty state reads "No change requests were dismissed in this period."
- **AI conflict resolution section:** attempts, resolved %, merged with the resolution, failed, discarded, running, and PRs with conflicts.
- **CI on pull requests section:** runs (links to actions), passed, failed, cancelled, pass rate, and median time to green.

# 20. RepoSettings (`/:o/:r/settings`, `pages/RepoSettings.tsx`)

- **Access:** users without `permissions.admin` see the inline `NotFound`.
- **Left menu:** anchor links to `#general`, `#access` and `#agents`. "General" always shows as selected. Visibility and Danger Zone have no menu entries.
- **Flash:** one shared success/error message area.
- **General form**
  - Repository name, description, and default-branch select (disabled when the repo has no branches).
  - Protected branches: a textarea, one pattern per line or comma-separated (`release/*`, `develop`, `hotfix/**`). A note says the default branch is always protected.
  - "Save changes" calls `api.updateRepo({name, description, defaultBranch, protectedBranches})`. After a rename it navigates to the new URL.
- **Collaborators**
  - The description depends on visibility.
  - The owner row carries an "Owner" label.
  - Each collaborator row has a "Write" label and "Remove" (`api.removeCollaborator`, no confirmation).
  - The add form is a select of members not already listed (`api.members`), with "Add collaborator" (`api.addCollaborator`).
- **Agents**
  - Invited agents (`api.repoAgents`) show their avatar, handle link, name and bio.
  - "Remove" calls `api.removeAgent` with no confirmation.
  - The empty state reads "No agents invited."
  - The invite form is a select of agents not yet invited (`api.agents`), with "Invite agent" (`api.inviteAgent`).
- **Visibility**
  - The description depends on visibility.
  - For a user-owned repo: "Make internal" or "Make private" (`api.updateRepo({visibility})`).
  - Team repos are always internal.
- **Danger Zone:** "Delete this repository" is enabled only after typing the full name. It calls `api.deleteRepo` and navigates to `/`.

# 21. SettingsTokens (`/settings/tokens`, `pages/SettingsTokens.tsx`)

- **Layout:** the header context is "Settings", with the `SettingsNav` sidebar.
- **Generate form**
  - "Note" is required.
  - Expiration: 7, 30 (default), 90 or 366 days, or "No expiration".
  - "Generate token" calls `api.createToken`.
  - The plaintext token appears once in a success flash with a copy button and the warning "won't be able to see it again".
- **Token list (`api.tokens`)**
  - Each row shows the name, "Last used X" or "Never used", and "Expires {date}", "Expired" or "No expiration".
  - "Delete" calls `api.deleteToken` with no confirmation.
  - The empty state reads "You have no personal access tokens."

# 22. SettingsMcp (`/settings/mcp`, `pages/SettingsMcp.tsx`)

- **Layout:** the header context is "Settings", with `SettingsNav`.
- **Server URL** (`api.mcp`): read-only, with a copy button.
- **"Set it up" tabs**
  - **Claude Code:** a copyable `claude mcp add --transport http …` command, then the `/mcp` → Authenticate steps.
  - **Claude.ai & Desktop:** steps with a link to the claude.ai custom-connector page.
  - **Cursor:** an "Add to Cursor" deep-link button (`cursor://…`), a copyable `mcp.json` snippet, and the "Needs login" note.
  - **Codex:** copyable `codex mcp add` and `login` commands, plus the `config.toml` alternative.
  - **Other clients:** generic text covering Streamable HTTP and OAuth 2.1 with PKCE and dynamic client registration.
  - The footer suggests a test prompt.
- **Tools:** each shows the title, name, a "Read-only" or "Makes changes" label, the description and its parameters (required, enum values, description).
- **Moderator tools:** the same layout, noting that only moderator apps see them.
- **Connected apps (`api.mcpConnections`)**
  - Each app shows its name, a "Moderator" label, the connected time, the first characters of its client id and its redirect host.
  - **Moderator checkbox**
    - Turning it on opens an inline confirmation (Make moderator / Cancel) before calling `api.setMcpModerator(id, true)`.
    - Turning it off applies immediately.
    - After enabling, a hint reads "Reconnect the app to see the moderator tools".
  - "Disconnect" calls `api.disconnectMcp` with no confirmation.
  - The empty state says no apps are connected.
  - Footnotes explain what disconnecting does and warn about moderators.

# 23. SettingsEmails and VerifyEmail (`/settings/emails`, `/settings/emails/verify?token=`, `pages/SettingsEmails.tsx`)

**SettingsEmails (`api.emails`)**

- The intro explains that commit emails link commits to the profile.
- If `emailConfigured` is false, a warning says verification emails cannot be sent.
- Notice and error flashes appear at the top.
- **Address list**
  - The primary address has a "Primary" label.
  - Each alternate shows a "Verified" or "Unverified" label, plus "link expired" with a tooltip when the link lapsed.
  - Its label is shown inline and can be edited (`api.updateEmail`); "Add label" appears when none is set.
  - "Resend" (`api.resendEmailVerification`) appears on unverified addresses.
  - "Delete" calls `api.deleteEmail` with no confirmation.
- **Add form**
  - Email (max 254 characters) and an optional label (max 40).
  - It calls `api.addEmail`. The notice says the link was sent, or that the email failed and to try Resend.

**VerifyEmail**

- It posts the token once (`api.verifyEmail`).
- It then shows success ("{email} is verified"), the error, or "This verification link is incomplete" when there is no token.
- "Back to email settings" returns to the list.

# 24. OAuthConsent (`/oauth/consent?client_id&scope&sig…`, `pages/OAuthConsent.tsx`)

- Without `sig` or `client_id`, it shows "This authorization link is incomplete or has expired."
- **Client lookup:** `GET /api/auth/oauth2/public-client?client_id=` `[non-uiApi]`.
  - If the client isn't registered, an error says so.
- **Header:** the client logo (or a plug icon), a sync icon, and the GitOrange logo. The title reads "**{name}** wants to access your {appName} account".
- **Permissions box**
  - "Signed in as X. {name} will act as you."
  - "Read your repositories" lists the read-only tool titles from `api.mcp`.
  - "Make changes" lists the write tool titles.
  - "Know who you are" appears with the `profile` or `email` scope.
  - With `offline_access`: "Stays connected until you disconnect it".
- **Buttons:** "Cancel" and "Authorize {name}" both call `POST /api/auth/oauth2/consent {accept, oauth_query}` `[non-uiApi]` and follow the returned URL. Errors show a flash.
- The footer reads "From {client_uri host}".

# 25. Admin (`/admin`, `pages/Admin.tsx`, plus `AdminSetup` and `AdminSettings`)

- The header context is "Site admin".
- **AdminSetup** (`id="setup"`, the target of the header badge; `components/AdminSetup.tsx`)
  - Data comes from `useSetupChecks` (`GET /api/admin/setup` `[non-uiApi]`).
  - "Re-check" refetches.
  - A summary flash reads "N errors to fix", "No errors; some features are off…", or "Everything is set up", followed by the counts and the checked time.
  - Problem checks are listed first. Each shows a status icon, the title, a category label, the detail, and "How to fix" steps (text, external dashboard links, copyable commands).
  - The `ai-gateway` check has a "Test" button (`POST /api/admin/setup/ai-test` `[non-uiApi]`) that shows the result.
  - A collapsible "N checks passed" section shows the passing checks with their dashboard links.
  - Errors show a flash.
- **AdminNav tabs:** People & team, Agents, Usage & cost.
- **Team**
  - It describes the one shared team (`api.team`).
  - "Create team" or "Rename" opens a form with name and URL slug, saved with `api.saveTeam`.
  - Changing the slug shows a warning that every team repo URL changes.
  - The result shows in a flash.
- **Members**
  - "Invite member" toggles the invite form. `?invite=1` opens it on load.
  - **Invite form:** email and role (Member or Site admin), sent with `api.invite`.
    - The result flash says the email was sent or failed.
    - It always includes a copyable invite link.
    - Links expire after 7 days.
  - **Member list (`api.members`):** a count, then each member's avatar, username link, name, email, a "Site admin" label, and the joined time.
  - Members cannot be removed and roles cannot be changed from this page.
- **Pending invitations:** only unaccepted, unexpired invites (`api.invitations`).
  - Each shows the email, invited and expiry times, and a role label.
  - "Revoke" calls `api.revokeInvite` with no confirmation.
  - The empty state reads "No pending invitations."
- **AdminSettings (`components/AdminSettings.tsx`, `api.adminSettings`)**
  - Settings are grouped into General, AI models, Reviews and Actions.
  - **Each setting row**
    - It shows the label and description.
    - The input is text, a number (with min and max), or for `actions.retention_days`, a day count with a "Keep forever" checkbox.
    - "Save" (`api.saveSetting`) is enabled only when the value has changed.
    - "Reset to default" (`api.resetSetting`) appears when the value is overridden.
    - Status reads "Set here {time}. Default: …" or "Using the default (…)", with an inline "Saved." and any error.
  - The Actions group adds a footer with the stored run count, the oldest finished run, and when cleanup last ran.
  - Saving also invalidates `setup`, so a changed instance name updates the header and tab title.

# 26. AdminUsage (`/admin/usage?month=YYYY-MM`, `pages/AdminUsage.tsx`)

- **Toolbar**
  - A month input (no later than the current month) sets `?month`.
  - "Sync now" (`api.syncUsage`) is disabled if analytics are not configured. The result shows in a flash, noting any partial failures.
- **Description:** what is measured, and when analytics last synced.
- **Data:** `api.usage(month)`, keeping the previous data on screen while loading. Errors show a flash.
- If the `CF_ANALYTICS_TOKEN` analytics token is missing, a warning appears.
- **Cards**
  - Usage at list price.
  - Usage with allowances.
  - Projected for the month.
  - The Workers Paid plan fee.
- An info note explains that allowances are shared across the account.
- **"Estimated cost per day":** an SVG bar chart with a hover title on each bar and "Highest day".
- **"By product" table:** metric, usage, included amount, list price, with allowance, and projected.
  - Each metric carries a status label ("Cloudflare analytics", "Recorded by GitOrange", "Estimate", "Not configured", or "Unavailable").
  - Reasons, notes, "billed from" dates and per-resource splits appear under the metric.
- **Actions:** minutes and cost, with breakdowns by repository and by runner size, and a "running now" note.
- **Workers AI:** calls and cost, an unreported-calls note, and breakdowns by feature and by repository.
- **AI Gateway** (whole gateway): requests and its own estimate, or a not-configured/unavailable reason.
- **"Not measured":** a list of what isn't tracked.
- **Price sources:** links, with the date prices were last checked.

# 27. AdminAgents (`/admin/agents`, `pages/AdminAgents.tsx`)

- The description explains reviewer agents and AGENT.md.
- **"New agent" form:** a handle and a display name, with a preview of the `handle/handle` repo it will create. It calls `api.createAgent`, and the success flash links to AGENT.md.
- **List (`api.agents`)**
  - Each agent shows its avatar, handle link, name, repository link (or "Repository deleted"), created time, and any `configError` in attention colour.
  - Deleting uses an inline confirm: "Delete" becomes "Delete @x" plus "Cancel". It calls `api.deleteAgent`, and a flash explains what happens to the agent's reviews and repo.
- The empty state reads "No agents yet."

# 28. NotFound (`pages/NotFound.tsx`)

- It shows "404", "This is not the web page you are looking for.", and "Go to your dashboard".
- The full variant includes `Header`. The inline variant is used inside `RepoLayout` and its pages.

---

# Quirks and gaps to decide on in the redesign (current behaviour)

1. The header's "Your repositories" link adds `?tab=repositories`, which Profile ignores.
2. The Emails settings page is not in the avatar menu, and `SettingsNav` is hidden below md. On mobile, Emails can't be found and the settings pages have no navigation between them.
3. On `/pull/:n` and `/compare`, no repo tab is highlighted.
4. The Pulls search box is read-only and decorative.
5. The blob view has `L{n}` anchors but no clickable line numbers or permalinks. Diff files have `id="diff-<path>"` anchors but no file-tree navigation.
6. The PR description can't be edited (the API supports `body`), and comments can't be edited or deleted.
7. Repo settings: the menu always shows "General" selected, and Visibility and Danger Zone are missing from it.
8. These destructive actions have no confirmation: remove collaborator, remove agent, delete token, delete email, revoke invite, disconnect MCP app, delete branch. Repo delete requires typing the name and agent delete has an inline confirm.
9. Site admin has no member removal or role change.
10. The commit-list page number and the agent-run cursor are not in the URL. Actions page, workflow, agent kind, PR filters and insights period are.
11. "Delete branch" and the title-edit "Save" have no error handling.
12. Of the PR list filters, only the open list has a Graph view (persisted in localStorage).

---

# Shared building blocks

**`src/components`**

- `Header.tsx`: the app bar (logo, context slot, setup-errors badge, Approvals count, create menu, user menu) with an optional nav slot.
- `RepoLayout.tsx`: the repo header, tabs and Outlet context. It also exports `useRepoParams`, `useRepoSubPath(section)` and `useRepo`.
- `AdminNav.tsx`: the Site admin tabs (People & team, Agents, Usage & cost).
- `SettingsNav.tsx`: the personal settings sidebar (Emails, Tokens, MCP), hidden below md.
- `AdminSetup.tsx`: deployment health checks with fix steps and the AI Gateway test.
- `AdminSettings.tsx`: grouped instance settings with save and reset.
- `AgentPrompt.tsx`: a copyable coding-agent prompt (`work` or `import`), in compact or full form.
- `CloneButton.tsx`: the "Code" dropdown with HTTPS clone URL and AI agent tabs.
- `BranchSelect.tsx`: a filterable branch picker with a default badge and optional label.
- `CopyButton.tsx`: copies to the clipboard and shows a check for 1.5s.
- `Dropdown.tsx`: a click-to-open panel that closes on outside click or Escape. The trigger and children are render props.
- `Avatar.tsx`: the user image, falling back to a deterministic identicon. It is round, or square for the team.
- `Logo.tsx`: `/logo.png`, with the app name as alt text.
- `Spinner.tsx`: an SVG spinner.
- `VisibilityLabel.tsx`: a Private or Internal label with a tooltip.
- `Markdown.tsx`: GFM rendering via marked and DOMPurify. It draws Mermaid diagrams, colours `diff` blocks, resolves repo-relative links and images, and keeps in-app navigation for repo links.
- `CommentForm.tsx` (`MarkdownEditor`): a textarea with Write and Preview tabs.
- `CommitList.tsx`: commits grouped by day, with batched checks badges, an expandable message, a short-SHA link and a copy-SHA button.
- `CommitAuthor.tsx`: the author (member link with avatar, or git name) plus "authored and {committer} committed".
- `DiffView.tsx`: `DiffView` (per-file collapsible diffs, hunks, old/new line numbers, highlighting, binary/too-large/empty states) and `DiffTotals` (+/− counts with 5 blocks).
- `FileList.tsx`: a path list with a muted directory part and show-more.
- `Checks.tsx`: `CommitStatus` (single commit, polls), `useCommitStatuses` (batched, polls), `ChecksBadge` (icon plus summary popover) and `ChecksBox` (the PR checks panel).
- `RunStatusIcon.tsx`: the status glyph for queued, in-progress, success, failure, cancelled and skipped, plus `runStatusLabel`.
- `PullStateLabel.tsx`: `PullStateLabel` (a state label with the reasons in its tooltip and optional reason text) and `PullStateReasons` (a list of blocking reasons).
- `PullBadges.tsx`: `AiResolutionBadge` and `ReviewLabel` for list rows.
- `PullGraph.tsx`: the Mermaid stack graph per land target, with legend, tooltips, clickable and keyboard nodes, and cycle warnings.
- `PullEvents.tsx` (`PullEventItem`): renders GitOrange's PR timeline events.
- `ReviewersBox.tsx`: `AgentReview`, `EarlierReview`, `PersonApprovals`, `ReviewersSidebar`, plus `REVIEWER_STATUS` and `reviewEntryId`.
- `AutoMergeReview.tsx`: `useAction` (run, reload, 409 handling), `AutoMergeStatus` (with the toggle), `Flag` (finding card with approve, dismiss and request changes), `serverChangesRequester`, and `REVIEW_ANCHOR`.
- `StackSidebar.tsx`: PR stack relationships with Unstack, Dismiss and Retry.
- `AgentRunLink.tsx`: a "View run" link to a PR's latest agent run of a given kind.

**Page-level helpers reused across pages**

- `pages/AuthShell.tsx`: `AuthShell` (centred auth card with logo) and `FlashError`.
- `pages/PrIcons.tsx`: `PrStateIcon` and `PrStateBadge`.
- `pages/NotFound.tsx`: full and inline variants.
- `pages/AgentRuns.tsx`: also exports `AGENT_KINDS`, `agentKindLabel`, `isAgentKind`, `AgentStatusIcon`, `formatCost` and `AgentRunList`.
- `pages/AdminUsage.tsx`: also exports `usd`.

**`src/lib`**

- `uiApi.ts`: every typed API call (`api.*`), the domain types, query keys (`qk.*`) and `INSIGHT_PERIODS`.
- `api.ts`: `apiFetch` (JSON, cookies, throws `ApiError` with status and body) and `errorMessage` (flattens validation issues).
- `auth.ts`: the better-auth client (admin, username and OAuth-provider plugins), `useSession`, `signIn`, `signOut` and `useCurrentUser`.
- `live.tsx`: the `LiveUpdates` WebSocket provider and `useLiveRepo`.
- `approvals.ts`: `useApprovalCount` (header) and `useApprovalPages` (infinite query).
- `setupChecks.ts`: `useSetupChecks` and `testAiGateway`, the admin setup probes.
- `appName.ts`: `useAppName` and `useDocumentTitle`.
- `agentPrompt.ts`: builds the `agentPrompt` and `importFromGitHubPrompt` texts.
- `format.ts`: `timeAgo`, `fullDate`, `dayLabel`, `shortSha`, `firstLine`, `restOfMessage`, `formatBytes`, `spanOf` and `duration`.
- `pullState.ts`: state labels and classes, `reasonText` (every reason kind as words), `stateText`, and `blocking`.
- `rebaseStatus.ts`: `rebaseHeadline`, `canRetryRebase`, `rebasedText` and `rebasedFirst` (merge 409 that is really a notice).
- `reviewTimeline.ts`: places reviews and events between comments (`timelineSlots`), plus the verbs, `reviewTime` and `anchoredReviewer`.
- `pullGraph.ts`: turns the stack tree into safe Mermaid source (escaping, tooltips, edge styles, cycles).
- `mermaid.ts`: lazy-loaded Mermaid (strict security, dark-mode aware) and DOMPurify-sanitised SVG.
- `highlight.ts`, `useHighlight.ts`, `languages.ts`: lazy highlight.js with per-line and per-hunk HTML, and file-path-to-language mapping.
- `repoUrls.ts`: resolves Markdown-relative links and images into in-app blob/tree URLs and raw URLs.
- `lessons.ts`: agent lesson status labels and text helpers.
- `via.ts`: `withVia`, which renders "user via App".
- Unit tests exist for `agentPrompt`, `highlight`, `lessons`, `pullGraph`, `pullState`, `rebaseStatus`, `repoUrls`, `reviewTimeline` and `via`. These modules are safe to reuse in the redesign as they are.
