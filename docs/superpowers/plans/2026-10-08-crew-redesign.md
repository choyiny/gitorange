# Crew Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Ship the crew redesign (spec: `docs/superpowers/specs/2026-10-08-crew-redesign-design.md`, mockup:
`docs/design/crew/`) in the real app: new shell and themes, every page redesigned, and the backend the new
pages need, with no existing feature dropped.

**Architecture:** Four lanes. A (frontend foundation) and B (backend) run in parallel; C (pages) starts when
both are merged; D (integration, docs, PR) closes. Each task runs in its own git worktree reset to the
`crew-redesign` branch, and is merged back into `crew-redesign` by the coordinator after review.

**Tech Stack:** Cloudflare Worker (Hono + `@hono/zod-openapi`, Drizzle on D1, Durable Objects, Workflows,
Artifacts), React 18 + react-router 6 + TanStack Query 5 + Vite 7, Primer CSS 21 (base layer),
`agent-robot-avatar` (MIT), `@fontsource/{figtree,ibm-plex-mono,inter-tight}`, Vitest in workerd.

## Global Constraints

- Work only on branch `crew-redesign` (or a task worktree reset to it). Never commit to or push `main`. Never
  deploy, never run `yarn db:migrate:prod`.
- `yarn` only (never npm/npx for project commands). Tests: `yarn test`. Types: `yarn typecheck`. Format:
  `yarn format` (prettier). Husky runs lint-staged on commit.
- Never create migration files by hand: change `worker/src/db/app.schema.ts`, run `yarn db:generate`, review the
  SQL. Only Task B1 changes the schema; any later task that needs a schema change stops and reports.
- Backend tests live in `worker/src/__tests__/`, run in workerd against real D1; never mock `env.DB`; use the
  Artifacts fake and helpers in `worker/src/__tests__/helpers/`.
- New endpoints are Zod OpenAPI routes and enforce the same access rules as neighbours
  (`worker/src/lib/repos.ts`: `permissionsFor` and `visibleTo` must agree).
- Never print, log or commit secrets; `wrangler.jsonc` is gitignored and never committed.
- Copy: plain English, sentence case, no jargon on owner-facing surfaces, GitHub vocabulary on developer
  surfaces (Approve, Request changes, Dismiss). No exclamation marks, no emoji in UI.
- No modals: every decision/finding/session/agent/setting is a page with its own URL.
- Agent colours (exact): clef `#e26a17`, fixer `#e34948`, security `#2a78d6`, data `#199e70`, speed `#c98500`,
  features `#d55181`, reliability `#008300`, privacy `#6b5cc9`, shipping `#55606e`.
- Guarded agents (Security, Data by preset; any agent with `guarded: true`): no bulk approve, no one-key
  approve, approving requires a reason, never decided by AI.
- The work panel `.content` is the only scroller; `body` never scrolls; sticky elements use `top: 16px`.
- Respect `prefers-reduced-motion`: no avatar pointer-follow, no rings, no enter animation.
- Every route must render with no console errors and no horizontal page scroll at 1440×900 and 375×812, in
  HQ light, HQ dark (claret) and GitHub dark.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Contracts

These TypeScript shapes are the agreement between lane B (Zod schemas in `worker/src/routers/schemas.ts` or
the feature's router) and lane C (types in `src/lib/uiApi.ts`). Field names are exact. Timestamps are epoch
milliseconds. `login` is the username / agent handle.

```ts
type Facet =
  | 'security'
  | 'data'
  | 'speed'
  | 'features'
  | 'reliability'
  | 'privacy'
  | 'shipping'
  | 'other';
interface PersonRef {
  login: string;
  name: string | null;
  isAgent: boolean;
  color: string | null;
}

// GET /api/repos?stats=1 — each existing repo item gains `stats`
interface RepoStats {
  pulls: {
    open: number;
    needsPerson: number;
    changesRequested: number;
    checking: number;
    queued: number;
  };
  merged7d: number;
  mergedByDay: number[]; // 7 UTC days, oldest first
  mergedAutomaticallyPct: number | null; // 0–100; null when merged7d = 0
  agents: {
    handle: string;
    name: string;
    color: string;
    status: ReviewerStatus | 'idle';
  }[];
  branchCount: number | null; // null when the ref read failed
  language: string | null;
  updatedAt: number;
}

// GET /api/agents/{handle}/stats
interface AgentStats {
  handle: string;
  raised: number;
  kept: number;
  dismissed: number;
  keptPct: number | null; // kept/(kept+dismissed)*100
  rules: number; // committed agent_lessons
  reviews: number; // pr_reviewers rows where it reviewed (status ≠ not_needed)
  byDay: { date: string; reviews: number }[]; // 182 UTC days, oldest first, 'YYYY-MM-DD'
  bestCatch: { title: string; repo: string; number: number } | null;
  repos: {
    repo: string;
    status: ReviewerStatus | 'idle';
    number: number | null;
  }[];
}
// GET /api/agents/builtin
interface BuiltinAgent {
  id: 'clef' | 'fixer';
  name: string;
  job: string;
  stats: { label: string; value: string }[];
}
// GET /api/agents/presets
interface AgentPreset {
  facet: Facet;
  name: string;
  handle: string;
  bio: string;
  color: string;
  guarded: boolean;
  triggerAsk: string;
  triggerAbove: number;
  engine: 'pass' | 'pi';
  recommended: boolean;
  exists: boolean;
}

// GET /api/approvals — existing response gains:
//   top level: assignedToMe: number
//   each finding item: question: string | null; guarded: boolean; assignee: PersonRef | null;
//                      decidedVia: string | null; reason: string | null; teach: string | null
// GET /api/approvals/flags/{flagId} — one finding with its PR, agent, excerpts and history (for /approvals/:flagId)

// GET/PUT /api/me/delegations
interface Delegations {
  agents: {
    handle: string;
    name: string;
    color: string;
    guarded: boolean;
    delegated: boolean;
  }[];
  today: AuditEvent[]; // decisions made via "GitOrange AI" for this person since UTC midnight
}

interface AuditEvent {
  id: string;
  at: number;
  actor: {
    kind: 'person' | 'agent' | 'ai' | 'system';
    login: string | null;
    name: string | null;
  };
  via: string | null;
  action: string;
  target: string;
  data: Record<string, unknown>;
  repo: string | null;
  pull: number | null;
}
// GET /api/repos/{o}/{r}/audit?cursor= and GET /api/admin/audit?cursor=
interface AuditPage {
  events: AuditEvent[];
  nextCursor: string | null;
}

interface SessionSummary {
  id: string; // 's-' + first 10 hex of sha256(authorId + '\0' + (createdVia ?? '') + '\0' + (label ?? ''))
  client: string | null; // created_via, e.g. "Claude Code"; null = by hand
  label: string | null; // session_label, e.g. "s4"
  author: PersonRef;
  pulls: {
    number: number;
    title: string;
    state: 'open' | 'closed' | 'merged';
    pullState: PullStateSummary | null;
  }[];
  requests: { number: number; text: string }[];
  lastActivity: number;
}
// GET /api/repos/{o}/{r}/sessions → SessionSummary[]; GET .../sessions/{id} → SessionSummary

interface BranchInfo {
  name: string;
  sha: string;
  isDefault: boolean;
  isProtected: boolean;
  updatedAt: number | null;
  author: PersonRef | null;
  pull: {
    number: number;
    title: string;
    state: 'open' | 'closed' | 'merged';
    pullState: PullStateSummary | null;
    createdVia: string | null;
    session: string | null;
  } | null;
  mergedNotDeleted: boolean;
}
// GET /api/repos/{o}/{r}/branches → BranchInfo[]; POST .../branches/clean → { deleted: string[] }
interface BranchMap {
  from: number;
  to: number;
  main: {
    name: string;
    status: 'passing' | 'failing' | 'running' | 'unknown';
    landings: { number: number; title: string; at: number; sha: string }[];
  };
  open: {
    branch: string;
    number: number;
    title: string;
    openedAt: number;
    state: 'agent_followup' | 'human_review' | 'waiting' | 'ready';
    reasons: string[];
    author: PersonRef;
    createdVia: string | null;
    session: string | null;
    stackedOn: number | null;
  }[];
  leftover: { branch: string; number: number; mergedAt: number }[];
}
// GET /api/repos/{o}/{r}/branches/map?days=10 → BranchMap

interface QueueTarget {
  target: string;
  paused: { at: number; by: PersonRef } | null;
  entries: {
    position: number;
    number: number;
    title: string;
    author: PersonRef;
    createdVia: string | null;
    session: string | null;
    state: string;
    blockers: string[];
    etaMinutes: number | null;
  }[];
}
// GET /api/repos/{o}/{r}/queue → QueueTarget[]; POST/DELETE .../merging/pause → { paused: QueueTarget['paused'] }
// POST /api/repos/{o}/{r}/pulls/{n}/revert → { number: number } (the new PR) | 409 { message }

interface HealthArea {
  id: string;
  label: string;
  color: string | null;
  agent: string | null; // agent handle for agent rows
  thisWeek: number;
  lastWeek: number;
  weeks: number[]; // 8 ISO weeks, oldest first
  trend: 'better' | 'same' | 'worse';
  status: string;
  detail: string;
  open: number;
}
interface HealthReport {
  summary: string;
  decisionsWaiting: number;
  areas: HealthArea[];
  contributors: {
    who: {
      kind: 'person' | 'session';
      label: string;
      login: string;
      client: string | null;
    };
    merged: number;
    findings: number;
    note: string | null;
    trend: 'better' | 'same' | 'worse';
  }[];
}
// GET /api/repos/{o}/{r}/health → HealthReport

interface LivePayload {
  queue: QueueTarget[];
  floor: SessionSummary[];
  events: AuditEvent[];
}
// GET /api/repos/{o}/{r}/live → LivePayload

interface SearchResults {
  repos: { name: string; description: string | null }[];
  pulls: { repo: string; number: number; title: string; state: string }[];
  agents: { handle: string; name: string; color: string }[];
  people: { login: string; name: string | null }[];
  branches: { repo: string; name: string }[];
  files: { repo: string; path: string }[];
}
// GET /api/search?q=&repo=o/n → SearchResults (each list ≤ 8; files/branches only when repo given)
```

`PullStateSummary` and `ReviewerStatus` are the existing types (`worker/src/pulls/state.ts`,
`app.schema.ts`); `pullState` gains reason kind `merging_paused` (bucket `waiting`).

---

## Lane A: frontend foundation

### Task A1: Design system, themes, fonts, avatars

**Files:**

- Create: `src/styles/tokens.css`, `src/styles/primer-bridge.css`, `src/styles/shell.css`,
  `src/styles/components.css`, `src/styles/index.css` (imports the others in order)
- Create: `src/lib/theme.ts`, `src/lib/theme.test.ts`, `src/components/ThemeProvider.tsx`
- Create: `src/lib/identicon.ts`, `src/lib/identicon.test.ts`, `src/components/Identicon.tsx`
- Create: `src/lib/agentLook.ts`, `src/lib/agentLook.test.ts`, `src/components/AgentAvatar.tsx`,
  `src/types/agent-robot-avatar.d.ts`
- Create: `src/components/ui/` primitives: `Chip.tsx`, `Verdict.tsx`, `Spark.tsx`, `Skeleton.tsx`,
  `Toast.tsx` (+ `useToast`), `Banner.tsx`, `Section.tsx`, `Seg.tsx`, `EmptyState.tsx`, `PendingButton.tsx`,
  `Kbd.tsx`, `PageHead.tsx`
- Modify: `index.html` (inline boot script applying stored theme before paint; drop `data-color-mode="auto"`
  in favour of the boot script setting `data-color-mode`, `data-light-theme`, `data-dark-theme`,
  `data-skin`, `data-theme`), `src/main.tsx` (import `src/styles/index.css` after Primer, fonts, avatar
  element), `package.json` (+ `agent-robot-avatar`, `@fontsource/figtree`, `@fontsource/ibm-plex-mono`,
  `@fontsource/inter-tight`)
- Test: the `src/lib/*.test.ts` files above (check how existing `src/lib/*.test.ts` are run by
  `worker/vitest.config.ts` and follow the same pattern)

**Interfaces:**

- Produces: `THEMES: { id: ThemeId; label: string; skin: 'hq' | 'dev'; chrome: Chrome; swatch: [string, string] }[]`
  with ids `navy ink slate indigo forest claret paper github`; `type Mode = 'system' | 'light' | 'dark'`;
  `resolveTheme(id: ThemeId, mode: Mode, systemDark: boolean): { skin; chrome; dark: boolean }`;
  `useTheme(): { theme: ThemeId; mode: Mode; setTheme(id): void; setMode(m): void }`; storage keys
  `go-theme-id`, `go-mode`.
- Produces: `identiconCells(seed: string): { color: string; cells: boolean[] }` (5×5, mirrored, 15 bits from a
  32-bit FNV-1a hash; colour from hue = hash % 360, s 55%, l 52%); `<Identicon login size />`.
- Produces: `agentColor(handle: string, color?: string | null): string` (explicit colour, else preset colour by
  handle, else stable hash into the palette); `avatarState(status: ReviewerStatus | 'idle' | 'needs' |
'running' | 'learned' | 'off'): string` (mapping in the spec); `<AgentAvatar handle color status size
label? />` (halo ≥28px, ring for reviewing/needs/running, `followPointer` ≥40px unless reduced motion).
- Produces: `<PageHead crumbs title lede? actions? tab? />`, `useToast(): (msg, { undo?, icon? }) => void`.

- [ ] **Step 1:** Write failing unit tests: `resolveTheme` (github→dev; paper+dark→midnight chrome; claret+dark
      keeps claret; system follows `systemDark`), `identiconCells` (deterministic, mirrored columns 0↔4 and 1↔3,
      different seeds differ), `avatarState` (every mapping row in the spec), `agentColor` (explicit wins, preset
      handles `securityagent`→`#2a78d6` etc., unknown handle stable).
- [ ] **Step 2:** Run `yarn test` filtered to these files; expect failures.
- [ ] **Step 3:** Implement the libs. Port tokens and component styles from `docs/design/crew/app.css`,
      `dev.css` (Dev skin), and the shared parts of `views.css`/`repo.css`; port `identicon` and `THEMES` from
      `docs/design/crew/shell.js`; port avatar markup/halo from `docs/design/crew/core.js` (`function avatar`).
      Write `primer-bridge.css` mapping Primer functional variables to tokens for both skins and modes.
      Check the installed `agent-robot-avatar` version's attributes/states against the mockup's 0.3.2 usage and
      adapt the mapping (document any rename in `agentLook.ts`).
- [ ] **Step 4:** Tests pass; `yarn typecheck` clean.
- [ ] **Step 5:** Commit `Crew redesign A1: design system, themes, fonts, agent avatars`.

### Task A2: App shell and routing

**Files:**

- Create: `src/components/shell/AppShell.tsx`, `Rail.tsx`, `TopBand.tsx`, `GlobalSearch.tsx`,
  `AccountMenu.tsx`, `CreateMenu.tsx`, `src/lib/recentRepos.ts` (+ test), `src/lib/searchKeys.ts` (+ test:
  grouping, arrow-key wrap, Enter target, Escape clears)
- Modify: `src/App.tsx` (signed-in routes render inside `<AppShell>`; public/auth routes do not),
  `src/components/RepoLayout.tsx` (repo header + tabs: Code, Health, Pull requests, Branches, Live, Actions,
  Insights, Audit log, Settings; agent repos: Code, Commits, Settings + profile link), every page that renders
  `<Header />` (remove it; the shell provides it), `src/components/Header.tsx` (delete after its features move:
  Approvals count via `useApprovalCount`, setup-errors badge → TopBand)
- Test: `src/lib/recentRepos.test.ts`, `src/lib/searchKeys.test.ts`

**Interfaces:**

- Consumes: A1 (`useTheme`, `THEMES`, `Identicon`, `AgentAvatar`, `PageHead`).
- Produces: `usePageHead({ icon, crumbs, title })` so pages set the top band title; `AppShell` renders
  `<main id="main" className="content">` as the only scroller and resets its `scrollTop` on route change;
  `GlobalSearch` calls `api.search(q, repo?)` when it exists, else filters the repository list client-side
  (the C0 task swaps it to the API).

- [ ] **Step 1:** Failing tests for `recentRepos` (dedupe, cap 5, most recent first, survives bad JSON in
      storage) and `searchKeys`.
- [ ] **Step 2:** Implement the shell per `docs/design/crew/shell.js` + `app.css` (rail states: collapsed,
      peek, pinned, drawer ≤900px; search only redraws its results; clicking outside closes and clears; `/`
      focuses; account menu with theme grid + appearance segment + links + Sign out using the existing sign-out).
      Transitions are disabled until first paint (`.app.boot`).
- [ ] **Step 3:** Route every existing page into the shell; tabs for not-yet-built pages (Health, Branches,
      Live, Audit log) are added by their C tasks, not here.
- [ ] **Step 4:** `yarn dev`, visit every existing route: shell renders, no console errors, panel scrolls,
      rail peek/pin/drawer work, theme switching works across all eight themes and three modes.
- [ ] **Step 5:** `yarn test`, `yarn typecheck`, commit `Crew redesign A2: HQ shell, top band, search, routing`.

---

## Lane B: backend

### Task B1: Schema, agent metadata, presets, audit log

**Files:**

- Modify: `worker/src/db/app.schema.ts` (all columns/tables in the spec's Schema section, plus
  `repositories.language text`, `repositories.language_sha text`), then `yarn db:generate` (one migration)
- Modify: `worker/src/agents/config.ts` (frontmatter `color`, `facet`, `guarded`, all optional, strict),
  `worker/src/agents/refresh.ts` (cache them on `agents`), `worker/src/agents/template.ts` (template writes
  `facet: other`, no colour)
- Create: `worker/src/agents/presets.ts` (seven presets: name, handle `<facet>agent` except shipping →
  `shippingagent`, bio, colour, guarded = security|data, `trigger.ask`, `trigger.above` 0.4, engine `pass`
  except security `pi`, recommended = all seven, AGENT.md body with "How <name> reviews", "When to raise
  something", "Rules learned from dismissals"; copy tone from `docs/design/crew/core.js` AGENTS)
- Create: `worker/src/lib/audit.ts` (`recordAudit(db, e: NewAuditEvent): Promise<void>` never throws;
  `listAudit(db, { repositoryId | null, cursor, limit }): Promise<AuditPage>` merging `audit_events` and
  `pr_events`), `worker/src/routers/audit-router.ts` (`GET /api/repos/{o}/{r}/audit`, `GET /api/admin/audit`)
- Modify: call `recordAudit` from existing mutations: repo settings/visibility/delete/create, collaborators,
  repo agents invite/remove, admin agents create/delete, branch delete, flag approve/request-changes, PR
  approval, `landPull` (`pull.merged`, actor or `system` for auto-merge), tokens create/delete, instance
  settings
- Modify: `worker/src/routers/agents-router.ts`: `GET /api/agents/presets`, `POST /api/admin/agents` accepts
  `preset`, `POST /api/admin/agents/crew`
- Test: `worker/src/__tests__/agents-presets.test.ts`, `worker/src/__tests__/audit.test.ts`,
  extend `agents-config.test.ts`

**Interfaces:**

- Produces: tables/columns named exactly as in the spec; `recordAudit`, `listAudit`, `AuditEvent`/`AuditPage`
  Zod schemas; `PRESETS: Record<Facet, AgentPreset>`; `isGuarded(agent)`.

- [ ] **Step 1:** Failing tests: config accepts `color`/`facet`/`guarded`, rejects bad colour and unknown facet;
      refresh caches them; `GET /api/agents/presets` lists seven with `exists`; creating from preset writes the
      preset AGENT.md and caches colour/guarded; `crew` creates only missing ones and is admin-only; audit rows
      appear for each listed mutation; `GET .../audit` pages newest first, merges `pr_events`, hides private repos
      from non-members; `GET /api/admin/audit` is admin-only.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement; `yarn db:generate`; review the SQL (one migration, additive only).
- [ ] **Step 4:** `yarn test`, `yarn typecheck` green.
- [ ] **Step 5:** Commit `Crew redesign B1: schema, agent colours and facets, presets, audit log`.

### Task B2: Records: repositories board, agent stats, built-ins

**Files:**

- Create: `worker/src/lib/repo-stats.ts`, `worker/src/lib/agent-stats.ts`
- Modify: `worker/src/routers/repos-router.ts` (`GET /api/repos?stats=1`), `agents-router.ts`
  (`GET /api/agents/{handle}/stats`, `GET /api/agents/builtin`)
- Test: `worker/src/__tests__/repo-stats.test.ts`, `worker/src/__tests__/agent-stats.test.ts`

**Interfaces:** Consumes B1 columns. Produces `RepoStats`, `AgentStats`, `BuiltinAgent` exactly as in
Contracts. `pullStates` is batched per repository (never per PR). `language` = most common source extension
in the default branch tree, recomputed only when the default branch sha differs from `language_sha`.

- [ ] Steps: failing tests (counts by bucket from seeded PRs and `pullState`; `mergedByDay` 7 entries;
      `mergedAutomaticallyPct` null at 0 merges; agents list with colour; visibility respected; agent
      `keptPct` maths incl. null; `byDay` 182 entries; best catch; built-ins numbers from seeded rows) → implement
      → green → commit `Crew redesign B2: repository and agent records`.

### Task B3: Owner questions, assignment, guarded decisions, teach, Let Claude decide

**Files:**

- Modify: `worker/src/review/contract.ts` (+ prompts in `head.ts`/`pi.ts`: needs_person findings may carry a
  plain yes/no `question` ≤ 200 chars, no code words), storing `question` on the flag
- Modify: flag routes (`approve`, `request-changes`: `reason`, `teach`; guarded approve without reason → 422;
  bulk/one-key paths refuse guarded), add `assign`, `undo`, `delegate`; `GET /api/approvals/flags/{id}`;
  `worker/src/review/inbox.ts` (`assignedToMe`, `question`, `guarded`, `assignee`, `decidedVia`)
- Modify: `worker/src/learn/` (`queueLessons` includes flags with `teach_note`; learner input carries the
  person's words as the rule)
- Create: `worker/src/review/delegate.ts` (`decideFinding(env, flagId, userId)`: reasoning model via the
  `AI` binding and the instance's reasoning-model setting; output schema `{ decision: 'approve' |
'request_changes' | 'leave', reason: string }`; refuses guarded; applies as the user with `approvedVia =
'GitOrange AI'`; audit `finding.delegated`), hook after a review finishes for delegated agents on the
  delegating person's PRs; `GET/PUT /api/me/delegations`
- Test: `worker/src/__tests__/owner-questions.test.ts`, `delegate.test.ts` (fake model), extend
  `approvals.test.ts`, `agent-learning-lessons.test.ts`

**Interfaces:** Produces the Approvals additions and `Delegations` from Contracts; `POST
.../review/flags/{id}/assign { login }`, `.../undo`, `.../delegate`.

- [ ] Steps: failing tests (question stored and returned; assign requires push rights of assigner and
      assignee; guarded approve needs reason; delegation refuses guarded; AI decision recorded via "GitOrange
      AI" and undoable while open, not after merge; teach note reaches the learner input; inbox counts
      `assignedToMe`) → implement → green → commit `Crew redesign B3: owner questions, assignment, guarded
decisions, teaching, Let Claude decide`.

### Task B4: Sessions, branches, branch map, clean-up

**Files:**

- Modify: `worker/src/mcp/pull-tools.ts` (`create_pull_request` optional `session`, `request`; tool
  descriptions explain them), store `created_via` from the MCP token's OAuth client name
- Create: `worker/src/lib/sessions.ts`, `worker/src/routers/sessions-router.ts`
- Create: `worker/src/lib/branches.ts`, `worker/src/routers/branches-router.ts` (`GET .../branches`,
  `POST .../branches/clean`, `GET .../branches/map`)
- Modify: landing (`worker/src/merge/land.ts` / `landPull`): delete the head branch on every landing when
  `delete_merged_branches` (default true); repo settings route accepts `deleteMergedBranches`
- Modify: `src/components/AgentPrompt.tsx` copy to mention `session` and `request`
- Test: `worker/src/__tests__/sessions.test.ts`, `branches.test.ts`, extend `mcp.test.ts`

**Interfaces:** Produces `SessionSummary`, `BranchInfo`, `BranchMap` from Contracts.

- [ ] Steps: failing tests (MCP stores session/request/created_via; web PRs have null; sessions grouped and
      id stable; branches list marks default/protected/mergedNotDeleted; clean deletes only merged-not-deleted,
      never default/protected, needs push rights, audits; map window and leftovers; landing deletes head when
      enabled and keeps it when disabled) → implement → green → commit `Crew redesign B4: sessions, branches,
branch map, clean-up`.

### Task B5: Merge queue, pause, revert, live, health, search

**Files:**

- Create: `worker/src/lib/queue.ts`, `worker/src/routers/queue-router.ts` (`GET .../queue`,
  `POST/DELETE .../merging/pause`)
- Modify: `worker/src/pulls/state.ts` (reason `merging_paused` → `waiting`), `signals.ts`, `landPull` and
  auto-merge (refuse while paused)
- Create: `worker/src/lib/revert.ts` (+ route `POST .../pulls/{n}/revert` in `pulls-router.ts`)
- Create: `worker/src/lib/live-feed.ts` (`GET .../live`), `worker/src/lib/health.ts` (`GET .../health`),
  `worker/src/lib/search.ts` + `worker/src/routers/search-router.ts` (`GET /api/search`)
- Test: `worker/src/__tests__/queue.test.ts`, `revert.test.ts`, `health.test.ts`, `search.test.ts`,
  `live-feed.test.ts`

**Interfaces:** Produces `QueueTarget`, `HealthReport`, `LivePayload`, `SearchResults` from Contracts and the
revert response.

- [ ] Steps: failing tests (queue order follows `ordered_after` edges and creation; blockers from reasons; ETA
      accumulates; pause blocks merge button and auto-merge and shows `merging_paused`; resume clears; revert
      produces a PR whose diff inverts the landed range, 409 on conflict, needs push rights, refuses unmerged;
      health weeks/trend maths and agent rows only for invited agents; search respects visibility, caps 8,
      files only with repo; live payload shape) → implement → green → commit `Crew redesign B5: merge queue,
pause, revert, live feed, health, search`.

---

## Lane S: demo data

### Task S1: Local demo seed

**Files:**

- Create: `scripts/seed-demo.mjs` (Node, no new dependencies), `scripts/seed-demo/` (fixture files for the demo
  repository: a small TypeScript invoicing app — `package.json`, `src/invoices.ts`, `src/currency.ts`,
  `src/api/routes.ts`, `migrations/0001_invoices.sql`, `README.md`, `.github/workflows/test.yml`)
- Modify: `package.json` (script `seed:demo`), `docs/development.md` (how to seed a local instance)

**What it builds** (against a running `yarn dev`, base URL from `--url`, default `http://localhost:8080`; an
admin username/password from `--admin`/`--password` or env `SEED_ADMIN`/`SEED_PASSWORD`; never against a
non-local host — refuse unless the host is `localhost`, `127.0.0.1` or ends in `.localhost`/`.test`):

1. Sign in as the admin through the API; create a personal access token for git.
2. Invite and accept one teammate, `cho` (Cho Yin), through the invitation API.
3. Create repository `<admin>/invoices` (internal) and push the fixture project as a history of ~12 commits
   over the last 10 days (backdated author dates), with branches for open pull requests:
   `claude/s4-usd-invoices`, `claude/s4-invoice-pdf` (stacked on the first), `codex/s5-rate-limit`,
   `claude/s6-signin-log`, `cho/insights-findings`, `codex/s2-live-token`; plus three already-merged branches left
   undeleted (`rebase-merging`, `stack-tree`, `faster-conflict-resolution`).
4. `POST /api/admin/agents/crew`, then invite Security, Data, Features and Shipping to the repository.
5. Open the six pull requests through the API; mark provenance (`created_via`, `session_label`, `request`) with
   `wrangler d1 execute DB --local --env dev` so they read as Claude Code s4/s6, Codex s2/s5 and by hand.
6. Merge 8 earlier pull requests through the merge API (real landings), then backdate their `merged_at` across
   the last 10 days so Health and the branch map have history.
7. Insert review rows directly in local D1 (agents need not run): per open PR a `pr_classifications` row
   (`status = done`, file one-liners), `pr_reviewers` rows (mix of approved / flagged / changes_requested /
   reviewing), and findings: one Data `needs_person` finding on the USD-invoices PR with
   `question = 'Were all your invoices so far in Canadian dollars?'`; one Security `change_requested`; one
   Features `needs_person` assigned to `cho`; one Shipping `needs_person` approved yesterday via "GitOrange AI".
8. Insert `workflow_runs` rows: passing runs on the default branch, one failing run last week, one running.
9. Print a summary with URLs to open.

Idempotent: re-running detects the repository and skips steps already done. No secrets printed.

- [ ] Steps: write the script; run it against the local dev server; open every new page's data endpoint
      (`/api/repos?stats=1`, `/health`, `/branches/map`, `/queue`, `/live`, `/audit`, `/sessions`, `/api/approvals`)
      and confirm each returns non-empty, sensible data; commit `Crew redesign S1: local demo seed`.

---

## Lane C: pages

Every page task: port the matching mockup view (file + `registerView` id given) into React using lane A
components and real data from `src/lib/uiApi.ts`; cover every item of its section in
`docs/superpowers/specs/2026-10-08-crew-redesign-inventory.md`; loading skeleton, empty state and error state;
live refresh where the old page had it; check in the browser at 1440 and 375 in three themes. Move page CSS
into `src/styles/pages/<page>.css`. Unit-test any non-trivial pure logic under `src/lib/`.

### Task C0: API client for the new endpoints

**Files:** Modify `src/lib/uiApi.ts` (types from Contracts; functions `repoStats`, `agentStats`,
`agentsBuiltin`, `agentPresets`, `createAgentCrew`, `delegations`, `setDelegations`, `approvalFlag`,
`assignFlag`, `undoFlag`, `delegateFlag`, `sessions`, `session`, `branches`, `cleanBranches`, `branchMap`,
`queue`, `pauseMerging`, `resumeMerging`, `revertPull`, `repoAudit`, `adminAudit`, `live`, `health`,
`search`; `qk` keys), swap `GlobalSearch` to `api.search`. Commit `Crew redesign C0: API client`.

### Task C1: Home, Repositories, New repository

Routes `/`, `/repos`, `/new`. Mockup: `views.js` `home`, `repo.js` `repos`, `new`. Data: approvals,
`repoStats`, `health` per repo (top 3), `repoAudit` (activity). Inventory: Dashboard, NewRepo.

### Task C2: Code, commits, commit

Routes `/:o/:r`, `tree/*`, `blob/*`, `commits/*`, `commit/:sha`. Mockup: `repo.js` `repo`, `code`, `tree`,
`blob`, `commits`, `commit`. Keep branch select, clone, raw, LFS, README Markdown, commit attribution. Code tab
shows "Open the branch map" button. Inventory: RepoCode, RepoCommits, CommitView.

### Task C3: Health

Route `/:o/:r/health`. Mockup: `views.js` `project`. Data: `health`, compact `branchMap`, approvals for the
repo. Adds the Health tab.

### Task C4: Pull requests and compare

Routes `/:o/:r/pulls` (Board lanes default, List, Graph with existing `PullGraph`), `compare[/*]`. Mockup:
`views.js` `pulls`. Inventory: Pulls, PullNew.

### Task C5: Pull request page and sessions

Routes `/:o/:r/pull/:number[/:tab]`, `/:o/:r/session/:id`. Mockup: `views.js` `pull`, `session`. Merge box
with state sentence and blockers, why (request + session), order (queue position, stack), Clef's file
summaries (`pr_classifications.files`), reviewers as conversation entries (existing `ReviewersBox`), Fixer
attempts (agent runs), files/commits/checks tabs, auto-merge toggle, approve commit, delete branch, revert
(merged). Inventory: PullView.

### Task C6: Branches

Route `/:o/:r/branches`. Mockup: `views.js` `branches` + `branchMap`. Branch map (SVG; layout logic in
`src/lib/branchMap.ts` with unit tests), main card (tip, tests, protection, revert last merge), merge queue
(pause/resume), all branches with Delete and "Delete N merged branches", clean-up policy toggle. Adds tab.

### Task C7: Live and audit log

Routes `/:o/:r/live`, `/:o/:r/audit`, `/admin/audit`. Mockup: `live.js`, `views.js` `audit`. Adds tabs.

### Task C8: Actions, runs, agent runs, insights

Routes `/:o/:r/actions[...]`, `insights`. Mockup: `repo.js` `actions`, `run`, `agentrun`, `insights`.
Inventory: RepoActions, RunView, AgentRuns, RepoInsights.

### Task C9: Approvals and finding pages

Routes `/approvals`, `/approvals/:flagId`. Mockup: `approvals.js` (list, finding pages), `views.js`
`decision` (owner question page: Yes / No, fix it / Ask someone, teach, guarded reason). "Let Claude decide"
panel (`delegations`) and "What Claude did today" with Undo. Keyboard shortcuts skip guarded items.
Inventory: Approvals.

### Task C10: Agents, agent profile, new reviewer, person profile

Routes `/agents`, `/agents/new`, `/:owner`. Mockup: `views.js` `agents`, `crew`, `agent`; `repo.js`
`profile`. Agent profile: overview (AGENT.md rendered), Reviews, Rules learned, Configuration, record
(`agentStats`), activity grid, invite/turn off per repo. New reviewer: presets + recommended crew + blank
(admin only; others see who to ask). `/admin/agents` keeps delete and links here. Inventory: Profile (both),
AdminAgents.

### Task C11: Repository settings

Route `/:o/:r/settings[/:section]`. Mockup: `repo.js` `rsettings`, `views.js` `rules`. Sections: General,
Collaborators, Agents, Rules (protected branches, merge policy, pause merging, delete merged branches, guarded
reviewers, learned rules per agent), Danger zone. Inventory: RepoSettings.

### Task C12: Account, admin, auth pages, not found

Routes `/settings/{tokens,mcp,emails}`, `/settings/emails/verify`, `/admin`, `/admin/usage`, `/setup`,
`/login`, `/invite/:token`, `/oauth/consent`, 404s. Mockup: `repo.js` `settings`, `admin`. MCP settings keep
moderator toggles and add the delegation explanation. Inventory: those pages.

---

## Lane D: integration

### Task D1: Visual QA, docs, PR

- [ ] Every route × {1440×900, 375×812} × {HQ navy light, HQ claret dark, GitHub dark}: no console errors, no
      horizontal scroll, avatars never stretched, panel is the only scroller. Fix what fails.
- [ ] Inventory sweep: tick every item in the inventory file against the new pages; list moved items.
- [ ] Docs: update `CLAUDE.md` (shell, themes, new endpoints and tables), `docs/architecture.md`,
      `docs/configuration.md` if any var changed, `docs/auto-merge.md` (owner questions, delegation, guarded),
      screenshots in `docs/screenshots/`.
- [ ] `yarn format`, `yarn typecheck`, `yarn test` green.
- [ ] Push `crew-redesign` to `origin`; open the PR with `gitorange_create_pull_request`; description lists
      lanes, migrations to apply, rollout steps, moved features, screenshots.
