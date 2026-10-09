import { apiFetch } from './api';

export type User = {
  id: string;
  username: string;
  name: string;
  image: string | null;
};
export type Member = User & {
  email: string | null;
  role: string;
  createdAt: string;
};
/** What an agent covers (AGENT.md `facet`); `other` is a custom one. */
export type Facet =
  | 'security'
  | 'data'
  | 'speed'
  | 'features'
  | 'reliability'
  | 'privacy'
  | 'shipping'
  | 'other';
/** A facet that has a preset (every facet but `other`). */
export type PresetFacet = Exclude<Facet, 'other'>;
/** Who someone is on the crew pages: a person, or a reviewer agent with its colour. `login` is the username or handle. */
export type PersonRef = {
  login: string;
  name: string | null;
  isAgent: boolean;
  /** An agent's `#rrggbb`; null for a person. */
  color: string | null;
};
/** A reviewer agent (Site admin → Agents). */
export type Agent = User & {
  bio: string;
  trigger: { ask: string; above: number };
  engine: 'pass' | 'pi';
  /** `#rrggbb`: AGENT.md's colour, else a stable one from the palette. */
  color: string;
  /** What it covers (AGENT.md `facet`); null when AGENT.md doesn't say. */
  facet: Facet | null;
  /** Its findings are never approved in bulk, by one key or by AI, and approving one needs a reason. */
  guarded: boolean;
  /** `<handle>/<handle>`; null once its repository was deleted, or when the viewer can't read it. */
  repository: string | null;
  configSha: string | null;
  configError: string | null;
  createdAt: string;
  deletedAt: string | null;
};
export type RepoAgent = Agent & { invitedAt: string };
export type Perms = { read: boolean; write: boolean; admin: boolean };
export type Visibility = 'private' | 'internal';
export type Repo = {
  id: string;
  /** The user or the team the repository lives under (`owner.username` is the URL segment). */
  owner: User;
  ownerType: 'user' | 'team';
  visibility: Visibility;
  name: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  /** Branch name patterns GitOrange never rebases (exact names, or globs: `*` within a segment, `**` across). */
  protectedBranches: string[];
  /** Every landing (the merge button or auto-merge) deletes the pull request's head branch. */
  deleteMergedBranches: boolean;
  createdAt: string;
  updatedAt: string;
};
export type RepoDetail = Repo & {
  permissions: Perms;
  cloneUrl: string;
  empty: boolean;
  branches: { name: string; sha: string }[];
  openPullCount: number;
};
/** A git identity; `user` is the member whose account email or verified alternate it is. */
export type CommitIdentity = { name: string; email: string; user: User | null };
export type Commit = {
  hash: string;
  treeHash: string;
  message: string;
  author: CommitIdentity;
  committer: CommitIdentity;
  parents: string[];
  authoredAt: number;
  committedAt: number;
};
export type Entry = {
  name: string;
  path: string;
  type: string;
  mode: string;
  hash: string;
};
export type Contents = {
  ref: string;
  path: string;
  commitSha: string | null;
  latestCommit: Commit | null;
  kind: 'tree' | 'blob' | 'empty';
  entries?: Entry[];
  readme?: { path: string; text: string } | null;
  file?: {
    path: string;
    size: number;
    binary: boolean;
    tooLarge: boolean;
    text: string | null;
    /** Set when the file is a Git LFS pointer; `stored` says whether the content was uploaded. */
    lfs: { oid: string; size: number; stored: boolean } | null;
  };
};
export type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};
export type FileDiff = {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldHash: string | null;
  newHash: string | null;
  mode: string;
  additions: number;
  deletions: number;
  binary: boolean;
  tooLarge: boolean;
  hunks: Hunk[];
};
export type Compare = {
  baseSha: string;
  headSha: string;
  status: 'identical' | 'ahead' | 'behind' | 'diverged';
  mergeable: boolean;
  conflicts: string[];
  commits: Commit[];
  files: FileDiff[];
};
export type Pull = {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  author: User;
  baseRef: string;
  headRef: string;
  /** Pull request lists only: the commit its checks ran on. */
  headSha?: string | null;
  /** Pull request lists only (open): AI resolving a rebase conflict, or failed to. */
  aiResolution?: 'running' | 'failed' | null;
  /** Pull request lists only (open): the head commit's review in a word (agents, or a person's approval). */
  review?: {
    state:
      | 'reviewing'
      | 'failed'
      | 'changes_requested'
      | 'review_required'
      | 'needs_approval'
      | 'approved';
    /** Agents' findings waiting for a person. */
    flags: number;
  } | null;
  /** Pull request lists only (open): whose move it is. */
  pullState?: PullState | null;
  /** Pull request lists only: the reviewer agents asked to review the head commit, each in its review's state. */
  reviewers?: PullReviewer[];
  mergeCommitSha: string | null;
  mergedBy: User | null;
  /** GitOrange merged it on its own (auto-merge); mergedBy is then null. */
  mergedAutomatically: boolean;
  mergedAt: string | null;
  closedAt: string | null;
  /** The app that opened it over MCP, self-reported (the OAuth client's name); null when opened by hand. */
  createdVia: string | null;
  /** The coding session label that app reported, if any. */
  sessionLabel: string | null;
  /** The id of its coding session (`SessionSummary.id`); never null: one opened by hand is its author's session. */
  sessionId: string;
  /** The person's original request that app reported, if any. */
  request: string | null;
  createdAt: string;
  updatedAt: string;
  commentCount: number;
};
/** A reviewer agent on a listed pull request (GET …/pulls): who it is and how its review of the head commit stands. */
export type PullReviewer = {
  handle: string;
  name: string;
  /** `#rrggbb`. */
  color: string;
  status: ReviewerStatus;
};
/** What a pull request list can ask for: `closed` is closed and merged together; `merged` is the merged ones, newest merge first. */
export type PullListState = 'open' | 'closed' | 'merged' | PullStateName;
/** One page of a pull request list (GET …/pulls). */
export type PullList = {
  pulls: Pull[];
  /** Every open pull request, and every closed or merged one, whatever the page. */
  openCount: number;
  closedCount: number;
  /** How many pull requests `state` matches, before paging. */
  total: number;
};
export type PullStateName =
  'agent_followup' | 'human_review' | 'waiting' | 'ready';
/** A structured reason; fields other than kind depend on it (snake_case). */
export type PullReason = { kind: string; [key: string]: unknown };
export type PullState = { state: PullStateName; reasons: PullReason[] };
/** GitOrange's own timeline entry on a pull request. */
export type PullEvent = {
  id: string;
  kind: string;
  state: PullStateName | null;
  data: Record<string, unknown> | null;
  actor: User | null;
  createdAt: string;
};
export type Comment = {
  id: string;
  author: User;
  body: string;
  createdAt: string;
  updatedAt: string;
};
export type StackDependency = {
  number: number;
  kind:
    | 'builds_on'
    | 'must_account_for'
    | 'conflicts'
    | 'independent'
    | 'ordered_after';
  reason: string;
  instructions: string | null;
  landed: boolean;
  files: string[];
  accounted: boolean;
  /** ordered_after: the PR this order was added for. */
  forPr: number | null;
};
export type StackNode = {
  number: number;
  parent: StackDependency | null;
  children: number[];
  waitsOn: StackDependency[];
  mustAccountFor: StackDependency[];
  cycleWith: number[];
  unchecked: number[];
  /** Other PRs a check against is still running. */
  pending: number[];
  /** No stack run has started for this PR's current head yet. */
  checking: boolean;
};
export type StackTree = {
  targets: {
    branch: string;
    nodes: (StackNode & {
      title: string;
      headRef: string;
      author: Pull['author'];
      pullState: PullState | null;
    })[];
    landed: { number: number; title: string }[];
  }[];
};

export type PullDetail = {
  pull: Pull;
  comments: Comment[];
  baseSha: string | null;
  headSha: string | null;
  headBranchExists: boolean;
  commitCount: number;
  /** It can land: up to date, or behind (landing rebases it first). */
  mergeable: boolean | null;
  /** Where it stands against its base; null unless it is open with both branches. */
  rebase: RebaseView | null;
  /** The head commit's review by agents and people. */
  review: PullReview | null;
  canMerge: boolean;
  /** People who approved the head commit, oldest first. */
  approvals: { user: User; createdAt: string; via: string | null }[];
  /** How this pull request stacks with other open ones; null once it isn't open. */
  stack: StackNode | null;
  pullState: PullState | null;
  events: PullEvent[];
};
export type ReviewFlag = {
  id: string;
  /** needs_person: a person approves it; change_requested: the PR's agent changes it (a person may dismiss it). */
  kind: 'needs_person' | 'change_requested';
  title: string;
  paths: string[];
  detail: string | null;
  detailModel: string | null;
  agentSha: string | null;
  approvedBy: User | null;
  approvedAt: string | null;
  /** The moderator app it was approved or dismissed through; null from the web UI. */
  approvedVia: string | null;
  /** Someone asked for changes instead of approving; cleared when it's approved. */
  changesRequestedBy: User | null;
  changesRequestedAt: string | null;
  changesRequestedNote: string | null;
  /** needs_person: the agent's plain yes/no question for the owner; null when it asked none. */
  question: string | null;
  /** Its agent is guarded: never approved in bulk, by one key or by AI; approving it needs a reason. */
  guarded: boolean;
  /** Who was asked to decide it. */
  assignee: PersonRef | null;
  /** How the current decision was made: a moderator app's name, or "GitOrange AI"; null from the web, or open. */
  decidedVia: string | null;
  /** The decider's reason (a person's for an approval, GitOrange AI's for either decision). */
  reason: string | null;
  /** What the decider taught the agent with the decision. */
  teach: string | null;
};
export type ReviewerStatus =
  | 'not_needed'
  | 'reviewing'
  | 'approved'
  | 'flagged'
  | 'changes_requested'
  | 'failed';
export type Reviewer = {
  id: string;
  agent: User;
  /** `<handle>/<handle>`, for the agent_sha link. */
  agentRepository: string | null;
  invited: boolean;
  status: ReviewerStatus;
  requested: boolean;
  probability: number | null;
  agentSha: string | null;
  summary: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  flags: ReviewFlag[];
};
/** A requested agent's review of an earlier head commit of the pull request. */
export type EarlierReview = {
  id: string;
  headSha: string;
  agent: User;
  status: ReviewerStatus;
  summary: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  flags: ReviewFlag[];
};
/** One instance setting in Site admin (GET /api/admin/settings). */
export type InstanceSetting = {
  key: string;
  label: string;
  description: string;
  group: 'General' | 'AI models' | 'Reviews' | 'Actions';
  value: unknown;
  default: unknown;
  overridden: boolean;
  updatedAt: string | null;
  min?: number;
  max?: number;
};
export type AdminSettingsView = {
  settings: InstanceSetting[];
  actions: {
    runs: number;
    oldestFinishedAt: string | null;
    retention: {
      at: string;
      retentionDays: number | null;
      deletedRuns: number;
      more: boolean;
    } | null;
  };
};
/** An open pull request waiting on a person (GET /api/approvals). */
export type ApprovalItem = {
  repo: { fullName: string; name: string };
  pull: {
    number: number;
    title: string;
    author: User | null;
    updatedAt: string;
    /** The head commit the page shows; what Approve approves. Null when its branch is gone. */
    headSha: string | null;
  };
  reviewFailed: string | null;
  resolutionFailed: string | null;
  /** No agent was requested: a person approves the commit. */
  needsApproval: boolean;
  /** Agents waiting on a person: failed reviews, and findings for a person. */
  agents: {
    reviewerId: string;
    agent: User;
    status: 'flagged' | 'changes_requested' | 'failed';
    error: string | null;
    flags: ReviewFlag[];
  }[];
  pullState: PullState | null;
  /** Must account for #pr, with nothing new since `since` (24 hours or more). */
  stackStale: { pr: number; since: string }[];
  /** Other pull requests it couldn't be checked against. */
  stackUnchecked: number[];
};
/** One page of GET /api/approvals; `count` and `assignedToMe` cover every page. */
export type ApprovalsPage = {
  items: ApprovalItem[];
  count: number;
  /** Findings someone asked you to decide that still wait. */
  assignedToMe: number;
  nextCursor: string | null;
};
export type PullReview = {
  headSha: string;
  agentsInvited: boolean;
  status: 'summarizing' | 'triggering' | 'reviewing' | 'done' | 'failed' | null;
  errorMessage: string | null;
  summaryModel: string | null;
  files: {
    path: string;
    status: 'added' | 'removed' | 'modified';
    additions: number;
    deletions: number;
    summary: string;
  }[];
  createdAt: string | null;
  durationMs: number | null;
  reviewers: Reviewer[];
  /** Requested agents' reviews of earlier head commits, newest first (at most 50): history that no longer counts. */
  earlier: EarlierReview[];
  verdict: { satisfied: boolean; reasons: PullReason[] } | null;
  autoMerge: {
    state: 'off' | 'disabled' | 'waiting' | 'blocked' | 'ready';
    reasons: string[];
    disabledAt: string | null;
  };
};
/** A refused merge's 409 body (`ApiError.body`). */
export type MergeRefusal = {
  error: string;
  /** Which gate refused it. */
  reason?: 'stack' | 'checks' | 'review' | 'rebase' | 'paused';
  /** Landing rebased the branch and pushed this head first, then stopped for its checks or review. */
  rebased?: string;
};
/** Where an open pull request stands against its base (GET …/pulls/{n} `rebase`). */
export type RebaseView = {
  status:
    'nothing_to_merge' | 'up_to_date' | 'behind' | 'resolving' | 'conflict';
  /** The branch it rebases onto. */
  onto: string;
  /** The commit AI is resolving, or where the rebase stopped (null: before any). */
  commit: string | null;
  files: string[];
  error: string | null;
};
export type Invitation = {
  id: string;
  email: string;
  role: 'admin' | 'user';
  acceptedAt: string | null;
  expiresAt: string;
  createdAt: string;
};
export type Team = {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
};
export type LessonStatus =
  'pending' | 'learning' | 'committed' | 'nothing' | 'failed';
/** What an agent learned from one pull request's dismissed change requests. */
export type Lesson = {
  id: string;
  repository: string;
  number: number;
  title: string;
  findings: string[];
  status: LessonStatus;
  commitSha: string | null;
  summary: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};
export type Namespace = {
  kind: 'user' | 'team';
  /** `email` is a member's account email (null for the team and agents). */
  owner: User & { createdAt: string; email: string | null };
  repositories: Repo[];
  /** Set when the user is a reviewer agent. */
  agent:
    | (Agent & {
        invitedTo: Repo[];
        recentReviews: {
          repository: string;
          number: number;
          title: string;
          headSha: string;
          agentSha: string | null;
          status: ReviewerStatus;
          createdAt: string;
        }[];
        lessons: Lesson[];
      })
    | null;
};
export type AlternateEmail = {
  id: string;
  email: string;
  label: string | null;
  verified: boolean;
  verifiedAt: string | null;
  verificationExpiresAt: string | null;
  createdAt: string;
};
export type Emails = {
  primary: string;
  alternates: AlternateEmail[];
  /** False when the instance cannot send email, so verification links cannot go out. */
  emailConfigured: boolean;
};
export type Token = {
  id: string;
  name: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export type RunStatus = 'queued' | 'in_progress' | 'completed';
export type RunConclusion =
  'success' | 'failure' | 'cancelled' | 'skipped' | null;
export type WorkflowRun = {
  id: string;
  runNumber: number;
  name: string;
  workflowPath: string;
  event: 'push' | 'pull_request';
  ref: string;
  refName: string;
  pullRequestNumber: number | null;
  headSha: string;
  displayTitle: string;
  actor: User | null;
  status: RunStatus;
  conclusion: RunConclusion;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};
export type WorkflowStep = {
  number: number;
  name: string;
  status: RunStatus;
  conclusion: RunConclusion;
  startedAt: string | null;
  completedAt: string | null;
};
export type WorkflowJob = {
  id: string;
  jobKey: string;
  name: string;
  runsOn: string;
  needs: string[];
  /** Jobs ahead of this one in the instance's queue; null when it isn't waiting for a slot. */
  queuedAhead: number | null;
  status: RunStatus;
  conclusion: RunConclusion;
  startedAt: string | null;
  completedAt: string | null;
  steps: WorkflowStep[];
};
/** AI processing recorded as a run (Actions tab → Agent). */
export type AgentRunKind =
  | 'review'
  | 'rebase'
  | 'conflict_resolution'
  | 'stack_discovery'
  | 'sweep'
  | 'learning';
export type AgentRunStatus = 'running' | 'succeeded' | 'failed';
export type AgentRun = {
  id: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  title: string;
  pullRequest: { number: number; title: string } | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};
export type AgentStep = {
  id: string;
  name: string;
  displayName: string;
  status: AgentRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costEstimate: number | null;
  decision: string | null;
  error: string | null;
};
export type AgentRunDetail = {
  run: AgentRun & {
    tokensIn: number;
    tokensOut: number;
    costEstimate: number | null;
  };
  steps: AgentStep[];
};

export type CommitRuns = {
  state: 'success' | 'failure' | 'pending' | null;
  runs: WorkflowRun[];
};

export type McpTool = {
  name: string;
  title: string;
  description: string;
  annotations: { readOnlyHint: boolean; title: string };
  inputSchema: {
    properties?: Record<
      string,
      { type?: string; description?: string; enum?: string[] }
    >;
    required?: string[];
  };
};
export type McpConnection = {
  clientId: string;
  name: string;
  uri: string | null;
  /** Host (or app scheme) its sign-in redirects to; tells apart apps with the same name. */
  redirectHost: string | null;
  scopes: string[];
  connectedAt: string | null;
  /** A moderator: may approve findings and pull requests as you over MCP. */
  moderator: boolean;
};

export const INSIGHT_PERIODS = [7, 30, 90, 365] as const;
/** Seconds, or null when nothing in the period had one. */
type Median = number | null;
export type RepoInsights = {
  days: number;
  since: string;
  until: string;
  pulls: {
    opened: number;
    merged: number;
    autoMerged: number;
    mergedByPerson: number;
    autoMergeShare: number | null;
    mergedAfterHumanReview: number;
    mergedHandsOff: number;
    closedUnmerged: number;
    openNow: number;
  };
  timeToMerge: { all: Median; auto: Median; person: Median };
  reviews: {
    runs: number;
    completed: number;
    failed: number;
    autoVerdicts: number;
    humanVerdicts: number;
    pullsReviewed: number;
    pullsNeedingHuman: number;
  };
  flags: {
    raised: number;
    approved: number;
    medianTimeToApproval: Median;
    pendingNow: number;
    pendingPullsNow: number;
    byKind: {
      key: string;
      title: string;
      raised: number;
      approved: number;
    }[];
  };
  resolutions: {
    attempts: number;
    succeeded: number;
    applied: number;
    failed: number;
    rejected: number;
    inProgress: number;
    pulls: number;
  };
  ci: {
    runs: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    passRate: number | null;
    medianTimeToGreen: Median;
  };
  learning: { handle: string; dismissed: number; lessonsCommitted: number }[];
};

export type UsageLineStatus = 'measured' | 'unavailable' | 'not-configured';
export type UsageLine = {
  metric: string;
  product: string;
  productLabel: string;
  label: string;
  unit: string;
  quantity: number;
  includedLabel: string;
  listCost: number;
  dedicatedCost: number;
  projectedQuantity: number;
  projectedListCost: number;
  projectedDedicatedCost: number;
  status: UsageLineStatus;
  reason?: string;
  source: 'cloudflare' | 'gitorange' | 'estimate';
  note?: string;
  billedFrom?: string;
  resources: { resource: string; quantity: number }[];
};
export type UsageAiBreakdown = {
  key: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
};
export type UsageReport = {
  month: string;
  from: string;
  to: string;
  daysInMonth: number;
  generatedAt: string;
  analyticsConfigured: boolean;
  lastSync: { day: string; completedAt: string | null; status: string } | null;
  prices: { checkedOn: string; sources: string[]; planFee: number };
  lines: UsageLine[];
  totals: {
    listCost: number;
    dedicatedCost: number;
    projectedListCost: number;
    projectedDedicatedCost: number;
  };
  daily: { date: string; costs: Record<string, number> }[];
  actions: {
    minutes: number;
    cost: number;
    running: number;
    byRepository: { repository: string; minutes: number; cost: number }[];
    byInstance: { instanceType: string; minutes: number; cost: number }[];
  };
  ai: {
    requests: number;
    cost: number;
    unreportedRequests: number;
    byFeature: UsageAiBreakdown[];
    byRepository: UsageAiBreakdown[];
  };
  gateway: {
    id: string;
    requests: number | null;
    estimatedCost: number | null;
    status: UsageLineStatus;
    reason?: string;
  } | null;
  notMeasured: string[];
};

/* ---------- Crew redesign: the endpoints the new pages read (worker/src/routers/…). Timestamps here are epoch
   milliseconds, unlike the older types above, which carry ISO strings. ---------- */

/** What an agent is doing on a repository's open pull requests: a reviewer status, or `idle` when it is on none. */
export type AgentActivity = ReviewerStatus | 'idle';

/** The Repositories board's numbers for one repository (GET /api/repos?stats=1). */
export type RepoStats = {
  pulls: {
    open: number;
    /** A person's move: approve it, answer a finding. */
    needsPerson: number;
    /** Its author's agent has changes to make: failed checks, requested changes, a rebase conflict. */
    changesRequested: number;
    /** Waiting for checks or reviews that are running. */
    checking: number;
    /** Ready, or waiting on its order or on other pull requests. */
    queued: number;
  };
  /** Pull requests merged in the last seven UTC days. */
  merged7d: number;
  /** Merges per UTC day over those seven days, oldest first, today last. */
  mergedByDay: number[];
  /** The share GitOrange merged on its own, 0 to 100; null when nothing merged. */
  mergedAutomaticallyPct: number | null;
  agents: {
    handle: string;
    name: string;
    color: string;
    status: AgentActivity;
  }[];
  /** Null when the repository's refs could not be read. */
  branchCount: number | null;
  /** A display name such as "TypeScript": the language most of its source files are written in. */
  language: string | null;
  updatedAt: number;
};
/** A repository in the Repositories board's list. */
export type RepoWithStats = Repo & { stats: RepoStats };

/** An agent's record (GET /api/agents/{handle}/stats). */
export type AgentStats = {
  handle: string;
  raised: number;
  kept: number;
  dismissed: number;
  /** kept / (kept + dismissed) as a whole percentage; null until one has been decided. */
  keptPct: number | null;
  /** Committed lessons. */
  rules: number;
  reviews: number;
  /** 182 UTC days, oldest first, today last; `date` is `YYYY-MM-DD`. */
  byDay: { date: string; reviews: number }[];
  bestCatch: { title: string; repo: string; number: number } | null;
  repos: { repo: string; status: AgentActivity; number: number | null }[];
};
/** Clef or Fixer: the agents GitOrange has built in (GET /api/agents/builtin). */
export type BuiltinAgent = {
  id: 'clef' | 'fixer';
  name: string;
  job: string;
  stats: { label: string; value: string }[];
};
/** A reviewer preset (GET /api/agents/presets). */
export type AgentPreset = {
  facet: Facet;
  name: string;
  handle: string;
  bio: string;
  color: string;
  guarded: boolean;
  triggerAsk: string;
  triggerAbove: number;
  engine: 'pass' | 'pi';
  /** Part of "the recommended crew" (POST /api/admin/agents/crew). */
  recommended: boolean;
  /** Its handle is taken (created already, or someone else holds the name): it can't be created. */
  exists: boolean;
};
/** POST /api/admin/agents/crew */
export type CrewResult = {
  created: Agent[];
  /** Presets not created: their handle is taken, or creating them failed. */
  skipped: { handle: string; reason: string }[];
};

export type AuditActorKind = 'person' | 'agent' | 'ai' | 'system';
/** One entry of an audit log: an audit_events row, or a pull request timeline event (`pull.<kind>`). */
export type AuditEvent = {
  id: string;
  at: number;
  actor: {
    kind: AuditActorKind;
    login: string | null;
    name: string | null;
  };
  /** The app it went through: a connected MCP app's name, or "GitOrange AI". */
  via: string | null;
  action: string;
  target: string;
  data: Record<string, unknown>;
  /** `owner/name`; null for an instance event. */
  repo: string | null;
  pull: number | null;
};
/** GET /api/repos/{o}/{r}/audit and GET /api/admin/audit, newest first. */
export type AuditPage = {
  events: AuditEvent[];
  /** Pass as `cursor` for the next (older) page; null on the last. */
  nextCursor: string | null;
};

/** `data` of a `finding.delegated` event: what GitOrange AI answered for you (the pull request is the event's `pull`). */
export type DelegatedData = {
  /** The finding's id. */
  finding: string;
  kind: 'needs_person' | 'change_requested';
  /** The agent's handle. */
  agent: string;
  decision: 'approve' | 'request_changes' | 'leave';
  reason: string;
  /** The finding no longer carries that decision. */
  undone: boolean;
  /** It still stands, on an open pull request you can push to: `undoFlag` works. */
  undoable: boolean;
};
export type DelegatedEvent = AuditEvent & { data: DelegatedData };
/** GET/PUT /api/me/delegations. */
export type Delegations = {
  /** Every reviewer agent, and whether GitOrange AI decides its findings on your pull requests. */
  agents: {
    handle: string;
    name: string;
    color: string;
    /** Its findings always come to you: it can't be delegated. */
    guarded: boolean;
    delegated: boolean;
  }[];
  /** GitOrange AI's answers for you since UTC midnight (`finding.delegated`), newest first. */
  today: DelegatedEvent[];
};

export type FindingState =
  'open' | 'approved' | 'dismissed' | 'changes_requested';
/** One finding for its own page (GET /api/approvals/flags/{flagId}). */
export type Finding = {
  id: string;
  kind: 'needs_person' | 'change_requested';
  title: string;
  /** needs_person: the agent's plain yes/no question for the owner. */
  question: string | null;
  /** The finding as recorded: its sentence, table, diagram and the diff excerpts it cites (Markdown). */
  detail: string | null;
  detailModel: string | null;
  paths: string[];
  agentSha: string | null;
  /** The commit it was raised on. */
  headSha: string;
  createdAt: number;
  /** Never approved in bulk, by one key or by AI; approving it needs a reason. */
  guarded: boolean;
  state: FindingState;
  decidedBy: PersonRef | null;
  decidedAt: number | null;
  /** A moderator app's name, or "GitOrange AI"; null from the web, or while open. */
  decidedVia: string | null;
  reason: string | null;
  /** The note sent with a request for changes. */
  note: string | null;
  teach: string | null;
  teachBy: PersonRef | null;
  assignee: PersonRef | null;
  assignedBy: PersonRef | null;
  assignedAt: number | null;
  repo: { fullName: string; name: string };
  pull: {
    number: number;
    title: string;
    state: 'open' | 'closed' | 'merged';
    author: PersonRef;
    headRef: string;
    landTarget: string;
    /** The branch tip now; null once closed or when it can't be read. */
    headSha: string | null;
  };
  /** Null for a finding whose agent was removed. */
  agent: {
    login: string;
    name: string;
    color: string;
    facet: Facet | null;
    guarded: boolean;
    bio: string;
    repository: string | null;
  } | null;
  /** You let GitOrange AI decide this agent's findings on your pull requests. */
  delegated: boolean;
  /** What you can do with it now: decide (push rights, open), undo your decision, delegate it, assign it. */
  can: { decide: boolean; undo: boolean; delegate: boolean; assign: boolean };
  /** Its audit entries, oldest first. */
  history: AuditEvent[];
};
/** POST …/review/flags/{id}/delegate: what GitOrange AI decided. */
export type DelegateResult = {
  decision: 'approve' | 'request_changes' | 'leave';
  reason: string;
  /** False when it left the finding for you. */
  applied: boolean;
};

/** A coding session: the pull requests one app opened for one person, with the label it reported. */
export type SessionSummary = {
  /** `s-` plus the first 10 hex of sha256(authorId, client, label). */
  id: string;
  /** The app that opened them, e.g. "Claude Code"; null means by hand. */
  client: string | null;
  /** The label the app gave the session, e.g. "s4". */
  label: string | null;
  author: PersonRef;
  pulls: {
    number: number;
    title: string;
    state: 'open' | 'closed' | 'merged';
    /** Whose move it is; null unless the pull request is open (with both branches). */
    pullState: PullState | null;
  }[];
  requests: { number: number; text: string }[];
  /** When any of its pull requests last changed. */
  lastActivity: number;
};

/** One branch (GET /api/repos/{o}/{r}/branches). */
export type BranchInfo = {
  name: string;
  sha: string;
  isDefault: boolean;
  /** The default branch and every branch matching the repository's protected patterns. */
  isProtected: boolean;
  /** When the tip commit was committed; null when it can't be read. */
  updatedAt: number | null;
  /** Whoever opened its pull request, else the member whose email is on the tip commit. */
  author: PersonRef | null;
  /** The branch's newest pull request, whatever its state. */
  pull: {
    number: number;
    title: string;
    state: 'open' | 'closed' | 'merged';
    /** Whose move it is; null unless the pull request is open. */
    pullState: PullState | null;
    /** The app that opened it; null means by hand. */
    createdVia: string | null;
    /** The session label that app reported. */
    session: string | null;
    /** The id of its coding session (`SessionSummary.id`); never null: one opened by hand is its author's session. */
    sessionId: string;
  } | null;
  /** Its newest pull request is merged and the branch is still there (never the default or a protected branch). */
  mergedNotDeleted: boolean;
};
/** GET /api/repos/{o}/{r}/branches/map */
export type BranchMap = {
  /** The window. */
  from: number;
  to: number;
  main: {
    name: string;
    /** From the latest Actions runs on the default branch. */
    status: 'passing' | 'failing' | 'running' | 'unknown';
    /** Pull requests merged into it in the window, oldest first. */
    landings: { number: number; title: string; at: number; sha: string }[];
  };
  /** Open pull requests into the default branch, oldest first. */
  open: {
    branch: string;
    number: number;
    title: string;
    openedAt: number;
    state: PullStateName;
    /** The kinds of the reasons it is in that state. */
    reasons: string[];
    author: PersonRef;
    createdVia: string | null;
    /** The session label that app reported. */
    session: string | null;
    /** The id of its coding session (`SessionSummary.id`); never null: one opened by hand is its author's session. */
    sessionId: string;
    /** The pull request whose branch this one is based on, when stacked. */
    stackedOn: number | null;
  }[];
  /** Merged branches nobody deleted, oldest merge first. */
  leftover: { branch: string; number: number; mergedAt: number }[];
};

/** Set while merging is paused on a repository. */
export type MergingPaused = { at: number; by: PersonRef } | null;
/** The pull requests landing on one branch, in the order they are expected to land. */
export type QueueTarget = {
  /** The branch they land on. */
  target: string;
  /** Set while merging is paused on the repository (every target alike). */
  paused: MergingPaused;
  entries: {
    position: number;
    number: number;
    title: string;
    author: PersonRef;
    /** The app that opened it; null means by hand. */
    createdVia: string | null;
    /** The session label that app reported. */
    session: string | null;
    /** The id of its coding session (`SessionSummary.id`); never null: one opened by hand is its author's session. */
    sessionId: string;
    /** Its pull request state: agent_followup, human_review, waiting or ready. */
    state: string;
    /** What holds it back, in plain words; empty when it is ready. */
    blockers: string[];
    /** Minutes until it is expected to land; null without run or review history. */
    etaMinutes: number | null;
  }[];
};

export type HealthTrend = 'better' | 'same' | 'worse';
export type HealthArea = {
  /** `agent:<handle>`, `tests` or `merging`. */
  id: string;
  label: string;
  /** An agent's colour; null for the other rows. */
  color: string | null;
  /** The agent's handle, for an agent's row. */
  agent: string | null;
  /** Problems this ISO week and last: an agent's findings, the percentage of test runs on main that failed, reverts. */
  thisWeek: number;
  lastWeek: number;
  /** The last 8 ISO weeks (Monday 00:00 UTC), oldest first. */
  weeks: number[];
  trend: HealthTrend;
  status: string;
  detail: string;
  /** Problems open now. */
  open: number;
};
/** GET /api/repos/{o}/{r}/health */
export type HealthReport = {
  summary: string;
  /** Findings waiting for a person, plus pull requests waiting for a person's approval for another reason. */
  decisionsWaiting: number;
  /** One row per invited agent, then "Tests on main" and "Merging". */
  areas: HealthArea[];
  /** People and coding sessions that merged this week, most merged first. */
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
    trend: HealthTrend;
  }[];
};

/** GET /api/repos/{o}/{r}/live */
export type LivePayload = {
  queue: QueueTarget[];
  /** Open pull requests grouped by coding session or person. */
  floor: SessionSummary[];
  /** The newest 50 audit and pull request events, newest first. */
  events: AuditEvent[];
};

/** GET /api/search: every list at most 8; `branches` and `files` only when a repository was given. */
export type SearchResults = {
  /** `name` is `owner/name`. */
  repos: { name: string; description: string | null }[];
  pulls: { repo: string; number: number; title: string; state: string }[];
  agents: { handle: string; name: string; color: string }[];
  people: { login: string; name: string | null }[];
  branches: { repo: string; name: string }[];
  /** Paths on the repository's default branch. */
  files: { repo: string; path: string }[];
};

const r = (owner: string, repo: string) =>
  `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
const q = (params: Record<string, string | number>) =>
  new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
/** The body of a decision on a finding: only what was given (empty text counts as nothing), or no body at all. */
const decisionText = (t: {
  reason?: string | null;
  teach?: string | null;
}): { reason?: string; teach?: string } | undefined => {
  const out: { reason?: string; teach?: string } = {};
  const reason = t.reason?.trim();
  const teach = t.teach?.trim();
  if (reason) out.reason = reason;
  if (teach) out.teach = teach;
  return Object.keys(out).length ? out : undefined;
};
/** `?a=1&b=2`, or nothing when there are no parameters. */
const qs = (params: Record<string, string | number>) => {
  const s = q(params);
  return s ? `?${s}` : '';
};

export const api = {
  setupStatus: () =>
    apiFetch<{ setupRequired: boolean; appName: string }>('/api/setup/status'),
  setup: (body: {
    name: string;
    username: string;
    email: string;
    password: string;
  }) => apiFetch<{ ok: true }>('/api/setup', { method: 'POST', json: body }),

  validateInvite: (token: string) =>
    apiFetch<{ email: string; inviter: string | null }>(
      `/api/invites/token/${token}`
    ),
  acceptInvite: (body: {
    token: string;
    name: string;
    username: string;
    password: string;
  }) =>
    apiFetch<{ email: string }>('/api/invites/accept', {
      method: 'POST',
      json: body,
    }),
  invitations: () => apiFetch<Invitation[]>('/api/invites'),
  invite: (body: { email: string; role: 'admin' | 'user' }) =>
    apiFetch<{ invitation: Invitation; inviteUrl: string; emailed: boolean }>(
      '/api/invites',
      { method: 'POST', json: body }
    ),
  revokeInvite: (id: string) =>
    apiFetch(`/api/invites/manage/${id}`, { method: 'DELETE' }),

  members: () => apiFetch<Member[]>('/api/users'),
  agents: () => apiFetch<Agent[]>('/api/agents'),
  /** Without `preset` both `handle` and `name` are required; with it they default to the preset's. */
  createAgent: (body: {
    handle?: string;
    name?: string;
    preset?: PresetFacet;
  }) =>
    apiFetch<{ agent: Agent }>('/api/admin/agents', {
      method: 'POST',
      json: body,
    }),
  /** Creates every recommended preset whose handle is free; again, only the ones still missing. */
  createAgentCrew: () =>
    apiFetch<CrewResult>('/api/admin/agents/crew', { method: 'POST' }),
  agentPresets: () => apiFetch<AgentPreset[]>('/api/agents/presets'),
  /** Clef and Fixer, with their last seven days. */
  agentsBuiltin: () => apiFetch<BuiltinAgent[]>('/api/agents/builtin'),
  agentStats: (handle: string) =>
    apiFetch<AgentStats>(`/api/agents/${encodeURIComponent(handle)}/stats`),
  deleteAgent: (handle: string) =>
    apiFetch(`/api/admin/agents/${encodeURIComponent(handle)}`, {
      method: 'DELETE',
    }),
  repoAgents: (o: string, n: string) =>
    apiFetch<RepoAgent[]>(`${r(o, n)}/agents`),
  inviteAgent: (o: string, n: string, handle: string) =>
    apiFetch(`${r(o, n)}/agents/${encodeURIComponent(handle)}`, {
      method: 'PUT',
    }),
  removeAgent: (o: string, n: string, handle: string) =>
    apiFetch(`${r(o, n)}/agents/${encodeURIComponent(handle)}`, {
      method: 'DELETE',
    }),
  namespace: (slug: string) =>
    apiFetch<Namespace>(`/api/namespaces/${encodeURIComponent(slug)}`),
  team: () => apiFetch<{ team: Team | null }>('/api/team'),
  saveTeam: (body: { name: string; slug: string }) =>
    apiFetch<{ team: Team }>('/api/team', { method: 'PUT', json: body }),

  mcp: () =>
    apiFetch<{
      serverUrl: string;
      serverName: string;
      tools: McpTool[];
      moderatorTools: McpTool[];
    }>('/api/mcp'),
  mcpConnections: () => apiFetch<McpConnection[]>('/api/mcp/connections'),
  disconnectMcp: (clientId: string) =>
    apiFetch(`/api/mcp/connections/${encodeURIComponent(clientId)}`, {
      method: 'DELETE',
    }),
  setMcpModerator: (clientId: string, on: boolean) =>
    apiFetch(`/api/mcp/connections/${encodeURIComponent(clientId)}/moderator`, {
      method: on ? 'PUT' : 'DELETE',
    }),
  tokens: () => apiFetch<Token[]>('/api/tokens'),
  createToken: (body: { name: string; expiresInDays: number | null }) =>
    apiFetch<{ token: Token; plaintext: string }>('/api/tokens', {
      method: 'POST',
      json: body,
    }),
  deleteToken: (id: string) =>
    apiFetch(`/api/tokens/${id}`, { method: 'DELETE' }),
  emails: () => apiFetch<Emails>('/api/emails'),
  addEmail: (body: { email: string; label: string | null }) =>
    apiFetch<{ email: AlternateEmail; emailed: boolean }>('/api/emails', {
      method: 'POST',
      json: body,
    }),
  updateEmail: (id: string, body: { label: string | null }) =>
    apiFetch<AlternateEmail>(`/api/emails/${id}`, {
      method: 'PATCH',
      json: body,
    }),
  deleteEmail: (id: string) =>
    apiFetch(`/api/emails/${id}`, { method: 'DELETE' }),
  resendEmailVerification: (id: string) =>
    apiFetch<{ email: AlternateEmail; emailed: boolean }>(
      `/api/emails/${id}/resend`,
      { method: 'POST' }
    ),
  verifyEmail: (token: string) =>
    apiFetch<AlternateEmail>('/api/emails/verify', {
      method: 'POST',
      json: { token },
    }),

  repos: () => apiFetch<Repo[]>('/api/repos'),
  /** The Repositories board: every repository you can see, each with its `stats`. */
  repoStats: () => apiFetch<RepoWithStats[]>('/api/repos?stats=1'),
  createRepo: (body: {
    name: string;
    description?: string;
    addReadme: boolean;
    owner: 'user' | 'team';
    visibility: Visibility;
  }) => apiFetch<Repo>('/api/repos', { method: 'POST', json: body }),
  repo: (o: string, n: string) => apiFetch<RepoDetail>(r(o, n)),
  updateRepo: (
    o: string,
    n: string,
    body: {
      name?: string;
      description?: string | null;
      defaultBranch?: string;
      visibility?: Visibility;
      protectedBranches?: string[] | null;
      deleteMergedBranches?: boolean;
    }
  ) => apiFetch<Repo>(r(o, n), { method: 'PATCH', json: body }),
  deleteRepo: (o: string, n: string) => apiFetch(r(o, n), { method: 'DELETE' }),
  collaborators: (o: string, n: string) =>
    apiFetch<User[]>(`${r(o, n)}/collaborators`),
  addCollaborator: (o: string, n: string, u: string) =>
    apiFetch(`${r(o, n)}/collaborators/${u}`, { method: 'PUT' }),
  removeCollaborator: (o: string, n: string, u: string) =>
    apiFetch(`${r(o, n)}/collaborators/${u}`, { method: 'DELETE' }),
  /** 409 when the branch gained commits since you looked. */
  deleteBranch: (o: string, n: string, name: string) =>
    apiFetch(`${r(o, n)}/branches?${q({ name })}`, { method: 'DELETE' }),
  branches: (o: string, n: string) =>
    apiFetch<BranchInfo[]>(`${r(o, n)}/branches`),
  /** Deletes every merged, not deleted branch (never the default or a protected one, or one an open pull request uses). Needs push access. */
  cleanBranches: (o: string, n: string) =>
    apiFetch<{ deleted: string[] }>(`${r(o, n)}/branches/clean`, {
      method: 'POST',
    }),
  /** `days` is 1 to 30 (the server's default is 10); out of range is a 400. */
  branchMap: (o: string, n: string, days?: number) =>
    apiFetch<BranchMap>(
      `${r(o, n)}/branches/map${qs(days === undefined ? {} : { days })}`
    ),
  sessions: (o: string, n: string) =>
    apiFetch<SessionSummary[]>(`${r(o, n)}/sessions`),
  session: (o: string, n: string, id: string) =>
    apiFetch<SessionSummary>(`${r(o, n)}/sessions/${encodeURIComponent(id)}`),
  queue: (o: string, n: string) => apiFetch<QueueTarget[]>(`${r(o, n)}/queue`),
  /** Stops every landing on the repository until someone resumes. Needs push access; `reason` goes in the audit log. */
  pauseMerging: (o: string, n: string, reason?: string) =>
    apiFetch<{ paused: MergingPaused }>(`${r(o, n)}/merging/pause`, {
      method: 'POST',
      json: reason?.trim() ? { reason: reason.trim() } : undefined,
    }),
  resumeMerging: (o: string, n: string) =>
    apiFetch<{ paused: MergingPaused }>(`${r(o, n)}/merging/pause`, {
      method: 'DELETE',
    }),
  live: (o: string, n: string) => apiFetch<LivePayload>(`${r(o, n)}/live`),
  health: (o: string, n: string) => apiFetch<HealthReport>(`${r(o, n)}/health`),
  /** `cursor` is the previous page's `nextCursor`; `limit` is 1 to 100 (default 50). */
  repoAudit: (o: string, n: string, cursor?: string, limit?: number) =>
    apiFetch<AuditPage>(
      `${r(o, n)}/audit${qs({
        ...(cursor ? { cursor } : {}),
        ...(limit ? { limit } : {}),
      })}`
    ),
  /** Site admins only. */
  adminAudit: (cursor?: string) =>
    apiFetch<AuditPage>(`/api/admin/audit${qs(cursor ? { cursor } : {})}`),
  /**
   * Repositories, pull requests, agents and people matching `term` (at most 8 of each, only what you can read); with
   * `repo` (`owner/name`) also its branches and the files on its default branch. A `term` over 200 characters is a
   * 400. Pass the query function's `signal` so a superseded request is cancelled.
   */
  search: (term: string, repo?: string | null, signal?: AbortSignal) =>
    apiFetch<SearchResults>(
      `/api/search${qs({ q: term, ...(repo ? { repo } : {}) })}`,
      { signal }
    ),

  contents: (o: string, n: string, refPath: string) =>
    apiFetch<Contents>(`${r(o, n)}/contents?${q({ refPath })}`),
  treeCommits: (o: string, n: string, ref: string, path: string) =>
    apiFetch<Record<string, Commit>>(
      `${r(o, n)}/tree-commits?${q({ ref, path })}`
    ),
  lfsUrl: (o: string, n: string, oid: string, filename?: string) =>
    `${r(o, n)}/lfs/${oid}${filename ? `?${q({ filename })}` : ''}`,
  rawUrl: (o: string, n: string, ref: string, path: string) =>
    `${r(o, n)}/raw?${q({ ref, path })}`,
  commits: (o: string, n: string, ref: string, page: number) =>
    apiFetch<{ commits: Commit[]; hasMore: boolean }>(
      `${r(o, n)}/commits?${q({ ref, page })}`
    ),
  commit: (o: string, n: string, sha: string) =>
    apiFetch<{ commit: Commit; files: FileDiff[] }>(`${r(o, n)}/commit/${sha}`),
  compare: (o: string, n: string, base: string, head: string) =>
    apiFetch<Compare>(`${r(o, n)}/compare?${q({ base, head })}`),

  /**
   * `limit` (1 to 100) asks for one `page` of that many; without it the whole list. `q` keeps the pull requests every
   * word of it matches (a number, or part of the title, branch, author, app or session).
   */
  pulls: (
    o: string,
    n: string,
    state: PullListState,
    opts: { limit?: number; page?: number; q?: string } = {}
  ) =>
    apiFetch<PullList>(
      `${r(o, n)}/pulls?${q({
        state,
        ...(opts.limit ? { limit: opts.limit } : {}),
        ...(opts.limit && opts.page && opts.page > 1
          ? { page: opts.page }
          : {}),
        ...(opts.q?.trim() ? { q: opts.q.trim() } : {}),
      })}`
    ),
  createPull: (
    o: string,
    n: string,
    body: { title: string; body: string; base: string; head: string }
  ) => apiFetch<Pull>(`${r(o, n)}/pulls`, { method: 'POST', json: body }),
  pullTree: (o: string, n: string) =>
    apiFetch<StackTree>(`${r(o, n)}/pulls/tree`),
  retryStack: (o: string, n: string, num: number) =>
    apiFetch(`${r(o, n)}/pulls/${num}/stack/retry`, { method: 'POST' }),
  unstack: (o: string, n: string, num: number) =>
    apiFetch(`${r(o, n)}/pulls/${num}/stack/unstack`, { method: 'POST' }),
  dismissStackEdge: (o: string, n: string, num: number, pr: number) =>
    apiFetch(`${r(o, n)}/pulls/${num}/stack/dismiss`, {
      method: 'POST',
      json: { pr },
    }),
  pull: (o: string, n: string, num: number) =>
    apiFetch<PullDetail>(`${r(o, n)}/pulls/${num}`),
  updatePull: (
    o: string,
    n: string,
    num: number,
    body: { title?: string; body?: string; state?: 'open' | 'closed' }
  ) => apiFetch(`${r(o, n)}/pulls/${num}`, { method: 'PATCH', json: body }),
  pullCommits: (o: string, n: string, num: number) =>
    apiFetch<Commit[]>(`${r(o, n)}/pulls/${num}/commits`),
  pullFiles: (o: string, n: string, num: number) =>
    apiFetch<FileDiff[]>(`${r(o, n)}/pulls/${num}/files`),
  mergePull: (
    o: string,
    n: string,
    num: number,
    body: {
      approve?: boolean;
      /** The head commit the page shows; the server answers 409 if the branch has moved. */
      headSha?: string;
    }
  ) =>
    apiFetch<{ sha: string }>(`${r(o, n)}/pulls/${num}/merge`, {
      method: 'POST',
      json: body,
    }),
  /** Try a stopped rebase again (rebase_conflict); 409 when nothing is stopped or the branch is never rebased. */
  retryRebase: (o: string, n: string, num: number) =>
    apiFetch<RebaseView>(`${r(o, n)}/pulls/${num}/rebase`, { method: 'POST' }),
  runs: (o: string, n: string, page: number, workflow?: string) =>
    apiFetch<{
      configured: boolean;
      totalCount: number;
      workflows: { path: string; name: string }[];
      runs: WorkflowRun[];
    }>(
      `${r(o, n)}/actions/runs?${q(workflow ? { page, workflow } : { page })}`
    ),
  run: (o: string, n: string, num: number) =>
    apiFetch<{ run: WorkflowRun; jobs: WorkflowJob[] }>(
      `${r(o, n)}/actions/runs/${num}`
    ),
  stepLog: async (
    o: string,
    n: string,
    num: number,
    jobId: string,
    step: number
  ) => {
    const res = await fetch(
      `${r(o, n)}/actions/runs/${num}/jobs/${jobId}/steps/${step}/logs`,
      { credentials: 'include' }
    );
    return res.ok ? res.text() : '';
  },
  cancelRun: (o: string, n: string, num: number) =>
    apiFetch(`${r(o, n)}/actions/runs/${num}/cancel`, { method: 'POST' }),
  rerun: (o: string, n: string, num: number) =>
    apiFetch<{ runNumber: number }>(`${r(o, n)}/actions/runs/${num}/rerun`, {
      method: 'POST',
    }),
  agentRuns: (
    o: string,
    n: string,
    opts: {
      kind?: AgentRunKind;
      pull?: number;
      cursor?: string;
      limit?: number;
    }
  ) =>
    apiFetch<{ runs: AgentRun[]; nextCursor: string | null }>(
      `${r(o, n)}/agent-runs?${q(
        Object.fromEntries(
          Object.entries(opts).filter(([, v]) => v !== undefined)
        ) as Record<string, string | number>
      )}`
    ),
  agentRun: (o: string, n: string, id: string) =>
    apiFetch<AgentRunDetail>(`${r(o, n)}/agent-runs/${encodeURIComponent(id)}`),
  commitRuns: (o: string, n: string, sha: string) =>
    apiFetch<CommitRuns>(`${r(o, n)}/commits/${sha}/runs`),
  commitStatuses: (o: string, n: string, shas: string[]) =>
    apiFetch<Record<string, CommitRuns>>(
      `${r(o, n)}/commit-statuses?shas=${shas.join(',')}`
    ),
  approvals: (opts: { cursor?: string; limit?: number } = {}) =>
    apiFetch<ApprovalsPage>(
      `/api/approvals?${q({
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
        ...(opts.limit ? { limit: opts.limit } : {}),
      })}`
    ),
  /** One finding with its pull request, agent, excerpts and history; 404 when it doesn't exist or you can't read its repository. */
  approvalFlag: (flagId: string) =>
    apiFetch<Finding>(`/api/approvals/flags/${encodeURIComponent(flagId)}`),
  delegations: () => apiFetch<Delegations>('/api/me/delegations'),
  /** Replaces the set of agents GitOrange AI decides for you (handles); 400 for an unknown agent, 422 for a guarded one. */
  setDelegations: (agents: string[]) =>
    apiFetch<Delegations>('/api/me/delegations', {
      method: 'PUT',
      json: { agents },
    }),
  usage: (month: string) =>
    apiFetch<UsageReport>(`/api/admin/usage?${q({ month })}`),
  syncUsage: () =>
    apiFetch<{
      days: string[];
      errors: Record<string, Record<string, string>>;
    }>('/api/admin/usage/sync', { method: 'POST' }),
  insights: (o: string, n: string, days: number) =>
    apiFetch<RepoInsights>(`${r(o, n)}/insights?${q({ days })}`),
  adminSettings: () => apiFetch<AdminSettingsView>('/api/admin/settings'),
  saveSetting: (key: string, value: unknown) =>
    apiFetch(`/api/admin/settings/${key}`, { method: 'PUT', json: { value } }),
  resetSetting: (key: string) =>
    apiFetch(`/api/admin/settings/${key}`, { method: 'DELETE' }),
  /**
   * Approve a finding (or dismiss an agent's change request). A guarded agent's finding needs a `reason` (422 without
   * one); `teach` is a rule the agent learns when the pull request closes.
   */
  approveFlag: (
    o: string,
    n: string,
    num: number,
    id: string,
    opts: { reason?: string | null; teach?: string | null } = {}
  ) =>
    apiFetch(`${r(o, n)}/pulls/${num}/review/flags/${id}/approve`, {
      method: 'POST',
      json: decisionText(opts),
    }),
  requestFlagChanges: (
    o: string,
    n: string,
    num: number,
    id: string,
    note: string,
    teach?: string | null
  ) =>
    apiFetch(`${r(o, n)}/pulls/${num}/review/flags/${id}/request-changes`, {
      method: 'POST',
      json: { note: note.trim() || null, ...decisionText({ teach }) },
    }),
  /** Ask someone with push rights to decide a finding; `login: null` clears it. 422 for an agent or a reader. */
  assignFlag: (
    o: string,
    n: string,
    num: number,
    id: string,
    login: string | null
  ) =>
    apiFetch<{ ok: true; assignee: PersonRef | null }>(
      `${r(o, n)}/pulls/${num}/review/flags/${id}/assign`,
      { method: 'POST', json: { login } }
    ),
  /** Reopen your decision (or GitOrange AI's for you) while the pull request is open; 403 for anyone else's, 409 after it closed. */
  undoFlag: (o: string, n: string, num: number, id: string) =>
    apiFetch<{ ok: true }>(`${r(o, n)}/pulls/${num}/review/flags/${id}/undo`, {
      method: 'POST',
    }),
  /** Let GitOrange AI decide this finding now, as you. 422 for a guarded agent, 400 for an agent's own change request. */
  delegateFlag: (o: string, n: string, num: number, id: string) =>
    apiFetch<DelegateResult>(
      `${r(o, n)}/pulls/${num}/review/flags/${id}/delegate`,
      { method: 'POST' }
    ),
  /** A merged pull request's revert, opened as a new pull request; 409 `{ message, error }` when it can't be. */
  revertPull: (o: string, n: string, num: number) =>
    apiFetch<{ number: number }>(`${r(o, n)}/pulls/${num}/revert`, {
      method: 'POST',
    }),
  approvePull: (o: string, n: string, num: number, headSha: string) =>
    apiFetch(`${r(o, n)}/pulls/${num}/approval`, {
      method: 'POST',
      json: { headSha },
    }),
  withdrawApproval: (o: string, n: string, num: number) =>
    apiFetch(`${r(o, n)}/pulls/${num}/approval`, { method: 'DELETE' }),
  retryReviewer: (o: string, n: string, num: number, id: string) =>
    apiFetch(`${r(o, n)}/pulls/${num}/reviewers/${id}/retry`, {
      method: 'POST',
    }),
  retryReview: (o: string, n: string, num: number) =>
    apiFetch(`${r(o, n)}/pulls/${num}/review/retry`, { method: 'POST' }),
  setAutoMerge: (o: string, n: string, num: number, enabled: boolean) =>
    apiFetch(`${r(o, n)}/pulls/${num}/auto-merge`, {
      method: 'PUT',
      json: { enabled },
    }),
  comment: (o: string, n: string, num: number, body: string) =>
    apiFetch<Comment>(`${r(o, n)}/pulls/${num}/comments`, {
      method: 'POST',
      json: { body },
    }),
};

export const qk = {
  setup: ['setup'] as const,
  repos: ['repos'] as const,
  /** Under `qk.repos`, so whatever refreshes the repository list refreshes the board. */
  repoStats: ['repos', 'stats'] as const,
  members: ['members'] as const,
  agents: ['agents'] as const,
  /** The `agents` keys below sit under `qk.agents`: creating or deleting an agent refreshes them. */
  agentPresets: ['agents', 'presets'] as const,
  agentsBuiltin: ['agents', 'builtin'] as const,
  agentStats: (handle: string) => ['agents', handle, 'stats'] as const,
  invitations: ['invitations'] as const,
  tokens: ['tokens'] as const,
  emails: ['emails'] as const,
  mcp: ['mcp'] as const,
  approvals: ['approvals'] as const,
  /** Under `['approvals', …]`, so live "approvals" pings and every decision refresh them. */
  approvalFlag: (flagId: string) => ['approvals', 'flag', flagId] as const,
  delegations: ['approvals', 'delegations'] as const,
  /** Not repository-scoped (and not refreshed by live pings): results are cached briefly per query and scope. */
  search: (term: string, repo: string | null) =>
    ['search', term, repo] as const,
  adminAudit: (cursor = '') => ['admin', 'audit', cursor] as const,
  adminSettings: ['admin', 'settings'] as const,
  usage: (month: string) => ['usage', month] as const,
  mcpConnections: ['mcp', 'connections'] as const,
  namespace: (u: string) => ['namespace', u] as const,
  team: ['team'] as const,
  repo: (o: string, n: string) => ['repo', o, n] as const,
  contents: (o: string, n: string, refPath: string) =>
    ['repo', o, n, 'contents', refPath] as const,
  treeCommits: (o: string, n: string, ref: string, path: string) =>
    ['repo', o, n, 'tree-commits', ref, path] as const,
  commits: (o: string, n: string, ref: string, page: number) =>
    ['repo', o, n, 'commits', ref, page] as const,
  commit: (o: string, n: string, sha: string) =>
    ['repo', o, n, 'commit', sha] as const,
  compare: (o: string, n: string, base: string, head: string) =>
    ['repo', o, n, 'compare', base, head] as const,
  collaborators: (o: string, n: string) =>
    ['repo', o, n, 'collaborators'] as const,
  repoAgents: (o: string, n: string) => ['repo', o, n, 'agents'] as const,
  /** Under `['repo', o, n, 'pulls']`, so anything that refreshes the pull request lists refreshes every page. */
  pulls: (
    o: string,
    n: string,
    state: string,
    limit = 0,
    page = 1,
    search = ''
  ) => ['repo', o, n, 'pulls', state, limit, page, search] as const,
  pullTree: (o: string, n: string) => ['repo', o, n, 'pull-tree'] as const,
  pull: (o: string, n: string, num: number) =>
    ['repo', o, n, 'pull', num] as const,
  pullCommits: (o: string, n: string, num: number) =>
    ['repo', o, n, 'pull', num, 'commits'] as const,
  pullFiles: (o: string, n: string, num: number) =>
    ['repo', o, n, 'pull', num, 'files'] as const,
  runs: (o: string, n: string, page: number, workflow: string) =>
    ['repo', o, n, 'runs', page, workflow] as const,
  run: (o: string, n: string, num: number) =>
    ['repo', o, n, 'run', num] as const,
  stepLog: (o: string, n: string, num: number, jobId: string, step: number) =>
    ['repo', o, n, 'run', num, 'log', jobId, step] as const,
  agentRuns: (o: string, n: string, kind: string, cursor: string) =>
    ['repo', o, n, 'agent-runs', kind, cursor] as const,
  pullAgentRun: (o: string, n: string, num: number, kind: string) =>
    ['repo', o, n, 'agent-runs', 'pull', num, kind] as const,
  agentRun: (o: string, n: string, id: string) =>
    ['repo', o, n, 'agent-run', id] as const,
  commitRuns: (o: string, n: string, sha: string) =>
    ['repo', o, n, 'commit-runs', sha] as const,
  commitStatuses: (o: string, n: string, shas: string) =>
    ['repo', o, n, 'commit-statuses', shas] as const,
  insights: (o: string, n: string, days: number) =>
    ['repo', o, n, 'insights', days] as const,
  // Repository-scoped from here: all start with ['repo', owner, name], so the repository's live pings refresh them.
  branches: (o: string, n: string) => ['repo', o, n, 'branches'] as const,
  branchMap: (o: string, n: string, days?: number) =>
    ['repo', o, n, 'branch-map', days ?? 'default'] as const,
  sessions: (o: string, n: string) => ['repo', o, n, 'sessions'] as const,
  session: (o: string, n: string, id: string) =>
    ['repo', o, n, 'session', id] as const,
  queue: (o: string, n: string) => ['repo', o, n, 'queue'] as const,
  live: (o: string, n: string) => ['repo', o, n, 'live'] as const,
  health: (o: string, n: string) => ['repo', o, n, 'health'] as const,
  repoAudit: (o: string, n: string, cursor = '') =>
    ['repo', o, n, 'audit', cursor] as const,
};
