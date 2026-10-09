import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  real,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { oauthClients, oauthConsents, users } from './auth.schema';

// The instance's one shared team. Its slug shares the URL namespace with usernames.
export const teams = sqliteTable('teams', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const repositories = sqliteTable(
  'repositories',
  {
    id: text('id').primaryKey(),
    // The owning user for personal repositories; the creator for team repositories.
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Set ⇒ a team repository.
    teamId: text('team_id').references(() => teams.id),
    // private: owner, collaborators, and site admins only. internal: every member can read.
    visibility: text('visibility', { enum: ['private', 'internal'] })
      .notNull()
      .default('internal'),
    name: text('name').notNull(),
    description: text('description'),
    defaultBranch: text('default_branch').notNull().default('main'),
    // Branch name patterns GitOrange never rebases (lib/protected-branches.ts); null ⇒ none. The default branch is
    // always protected.
    protectedBranches: text('protected_branches', { mode: 'json' }).$type<
      string[]
    >(),
    // Immutable Artifacts repo name (r_<id>) so renames never touch git storage.
    artifactsName: text('artifacts_name').notNull().unique(),
    nextPrNumber: integer('next_pr_number').notNull().default(1),
    // Set ⇒ merging is paused (the merge button and auto-merge refuse) since then, by that member. No foreign key:
    // resolved with the ghost-user fallback like other user ids; nothing deletes users.
    mergingPausedAt: integer('merging_paused_at', { mode: 'timestamp' }),
    mergingPausedById: text('merging_paused_by_id'),
    // Every landing (merge button or auto-merge) deletes the pull request's head branch.
    deleteMergedBranches: integer('delete_merged_branches', {
      mode: 'boolean',
    })
      .notNull()
      .default(true),
    // The most common source file extension on the default branch, cached at `language_sha` (its commit).
    language: text('language'),
    languageSha: text('language_sha'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    // Names are unique per namespace: per user for personal repos, per team for team repos.
    uniqueIndex('repositories_personal_name_uq')
      .on(t.ownerId, t.name)
      .where(sql`team_id IS NULL`),
    uniqueIndex('repositories_team_name_uq')
      .on(t.teamId, t.name)
      .where(sql`team_id IS NOT NULL`),
    index('repositories_updated_idx').on(t.updatedAt),
  ]
);

export const repositoryCollaborators = sqliteTable(
  'repository_collaborators',
  {
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.userId] }),
    index('repository_collaborators_user_idx').on(t.userId),
  ]
);

/** What a reviewer agent covers (AGENT.md `facet`); the seven named ones are presets (worker/src/agents/presets.ts). */
export const agentFacets = [
  'security',
  'data',
  'speed',
  'features',
  'reliability',
  'privacy',
  'shipping',
  'other',
] as const;
export type Facet = (typeof agentFacets)[number];

// Reviewer agents: an account in `users` with no credential, sessions or tokens, plus this row. The cached
// fields come from AGENT.md on its repository's default branch at `config_sha` (the latest valid one);
// `config_error` is the latest parse error. Reviews read the repository itself, never these fields.
export const agents = sqliteTable(
  'agents',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Its `<handle>/<handle>` repository; null once a site admin deletes that repository.
    repositoryId: text('repository_id').references(() => repositories.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    bio: text('bio').notNull().default(''),
    triggerAsk: text('trigger_ask').notNull(),
    triggerAbove: real('trigger_above').notNull(),
    engine: text('engine', { enum: ['pass', 'pi'] })
      .notNull()
      .default('pass'),
    // AGENT.md's `color` (#rrggbb, lowercase); null ⇒ a stable colour from the palette (agentColor).
    color: text('color'),
    facet: text('facet', { enum: agentFacets }),
    // The effective guard (guardedOf in worker/src/agents/presets.ts): AGENT.md's `guarded`, or a security or data
    // facet. Every writer stores it that way, so filtering on this column agrees with isGuarded.
    guarded: integer('guarded', { mode: 'boolean' }).notNull().default(false),
    configSha: text('config_sha'),
    configError: text('config_error'),
    createdById: text('created_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    // Set ⇒ a "deleted agent": uninvited everywhere; its user row keeps past reviews attributed.
    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  },
  // A push finds its repository's agent by this (one lookup per push).
  (t) => [uniqueIndex('agents_repository_uq').on(t.repositoryId)]
);
export type Agent = typeof agents.$inferSelect;

// Agents invited to review a repository's pull requests.
export const repositoryAgents = sqliteTable(
  'repository_agents',
  {
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.userId, { onDelete: 'cascade' }),
    invitedById: text('invited_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.agentId] }),
    index('repository_agents_agent_idx').on(t.agentId),
  ]
);

export const invitations = sqliteTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    role: text('role', { enum: ['admin', 'user'] })
      .notNull()
      .default('user'),
    // SHA-256 of the secret in the invite link; the plaintext is only ever emailed.
    tokenHash: text('token_hash').notNull().unique(),
    invitedById: text('invited_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    acceptedAt: integer('accepted_at', { mode: 'timestamp' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('invitations_email_idx').on(t.email)]
);

export const personalAccessTokens = sqliteTable(
  'personal_access_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('personal_access_tokens_user_idx').on(t.userId)]
);

// Alternate addresses a member authors git commits with (the account email is the primary one).
// An address belongs to one member instance-wide. Only verified rows attribute commits; an
// unverified row reserves its address until `verification_expires_at`, after which anyone may
// claim it (the stale row is replaced).
export const userEmails = sqliteTable(
  'user_emails',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Lowercased.
    email: text('email').notNull().unique(),
    // Optional free-text label, e.g. "Work".
    label: text('label'),
    verifiedAt: integer('verified_at', { mode: 'timestamp' }),
    // SHA-256 of the secret in the verification link; the plaintext is only ever emailed.
    verificationTokenHash: text('verification_token_hash').unique(),
    verificationExpiresAt: integer('verification_expires_at', {
      mode: 'timestamp',
    }),
    // When the last verification email went out (resends are rate-limited).
    verificationSentAt: integer('verification_sent_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('user_emails_user_idx').on(t.userId)]
);

export const pullRequests = sqliteTable(
  'pull_requests',
  {
    id: text('id').primaryKey(),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id),
    baseRef: text('base_ref').notNull(),
    headRef: text('head_ref').notNull(),
    // Where it finally lands. base_ref is what the diff is against and may be a parent PR's head branch when
    // stacked; readers that mean "where this lands" use landTargetOf (worker/src/lib/land-target.ts).
    // NULL (every row from before this column): lands into base_ref. Set on create and on every retarget.
    landTarget: text('land_target'),
    state: text('state', { enum: ['open', 'closed', 'merged'] })
      .notNull()
      .default('open'),
    mergeCommitSha: text('merge_commit_sha'),
    // How many commits a rebase landing added to the target (merge_commit_sha is the landed head). NULL: landed before
    // rebase merging, as one squash commit.
    landedCommits: integer('landed_commits'),
    mergedById: text('merged_by_id').references(() => users.id),
    mergedAt: integer('merged_at', { mode: 'timestamp' }),
    closedAt: integer('closed_at', { mode: 'timestamp' }),
    // Merged by GitOrange on its own (auto-merge); such merges have no merged_by_id.
    mergedAutomatically: integer('merged_automatically', { mode: 'boolean' })
      .notNull()
      .default(false),
    // A maintainer turned auto-merge off for this pull request.
    autoMergeDisabledAt: integer('auto_merge_disabled_at', {
      mode: 'timestamp',
    }),
    // Provenance, self-reported by the MCP client that opened it: the OAuth client's name ("Claude Code"), its
    // coding session's label, and the person's original request (≤ 4000 characters). Null when opened by hand.
    createdVia: text('created_via'),
    sessionLabel: text('session_label'),
    request: text('request'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    uniqueIndex('pull_requests_repo_number_uq').on(t.repositoryId, t.number),
    index('pull_requests_repo_state_idx').on(t.repositoryId, t.state),
    index('pull_requests_repo_target_idx').on(
      t.repositoryId,
      t.landTarget,
      t.state
    ),
    // The Approvals inbox: every open pull request across repositories, newest first.
    index('pull_requests_state_updated_idx').on(t.state, t.updatedAt),
  ]
);

export const pullRequestComments = sqliteTable(
  'pull_request_comments',
  {
    id: text('id').primaryKey(),
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('pull_request_comments_pr_idx').on(t.pullRequestId)]
);

// Git LFS objects: `r2_key` is a bare key, never a URL; a row exists only once the upload is in R2.
export const lfsObjects = sqliteTable(
  'lfs_objects',
  {
    id: text('id').primaryKey(),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    oid: text('oid').notNull(),
    size: integer('size').notNull(),
    r2Key: text('r2_key').notNull(),
    uploadedById: text('uploaded_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [uniqueIndex('lfs_objects_repo_oid_uq').on(t.repositoryId, t.oid)]
);

// ── AI merge-conflict resolution ─────────────────────────────────────────────
// One AI resolution of one pull request commit whose replay conflicted during a rebase (worker/src/merge/rebase.ts), or
// a rebase that stopped for the agent (model 'none'). Squash-era rows (one per pull request and tips, commit_sha NULL)
// stay as history.

export const mergeResolutions = sqliteTable(
  'merge_resolutions',
  {
    // `<pr id>-<onto 12>-<head 12>-<commit 12 | all>` (resolutionId): one row per pull request, tips and commit.
    id: text('id').primaryKey(),
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    /** The tip the rebase was onto (base_ref's), and the pull request head it rebased. */
    baseSha: text('base_sha').notNull(),
    headSha: text('head_sha').notNull(),
    /** The pull request commit whose replay conflicted; NULL when the rebase stopped before any (too many commits). */
    commitSha: text('commit_sha'),
    // running → resolved (contents ready) → applied (the rebase was written), or failed. rejected: a stop set aside to try again (retryRebase), or a squash-era discard.
    status: text('status', {
      enum: ['running', 'resolved', 'applied', 'failed', 'rejected'],
    })
      .notNull()
      .default('running'),
    model: text('model').notNull(),
    conflictedPaths: text('conflicted_paths', { mode: 'json' })
      .$type<string[]>()
      .notNull(),
    /** The resolved contents of conflictedPaths (path → text), once resolved. */
    resolvedFiles: text('resolved_files', { mode: 'json' }).$type<
      Record<string, string>
    >(),
    /** Files the model changed outside the conflicted ones. */
    touchedExtraPaths: text('touched_extra_paths', { mode: 'json' }).$type<
      string[]
    >(),
    explanation: text('explanation'),
    errorMessage: text('error_message'),
    /** The rebased commit made from commit_sha with these contents, once written. */
    resultSha: text('result_sha'),
    transcriptR2Key: text('transcript_r2_key'),
    durationMs: integer('duration_ms'),
    createdById: text('created_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    decidedAt: integer('decided_at', { mode: 'timestamp' }),
  },
  (t) => [index('merge_resolutions_pr_idx').on(t.pullRequestId, t.createdAt)]
);

// ── Instance settings ────────────────────────────────────────────────────────
// Instance-wide settings a site admin changes without a deploy (worker/src/lib/settings.ts is
// the registry of keys). A missing row means the default: the wrangler var, or a built-in value.

export const instanceSettings = sqliteTable('instance_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>(),
  updatedById: text('updated_by_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// ── Reviews ──────────────────────────────────────────────────────────────────
// One review per PR head commit (id `<pull request id>-<head sha>`): its one-liners and status; its agents are
// pr_reviewers rows, their findings pr_review_flags.

export type FileSummary = {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  summary: string;
};

export type ClassifierAnswer =
  | { type: 'noul'; value: number }
  | {
      type: 'choice';
      value: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | {
      type: 'score';
      value: number;
      confidence: number;
      probabilities: Record<string, number>;
    };

export const prClassifications = sqliteTable(
  'pr_classifications',
  {
    id: text('id').primaryKey(),
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    headSha: text('head_sha').notNull(),
    // summarizing → triggering (Clef) → reviewing (agents) → done | failed.
    status: text('status', {
      enum: ['summarizing', 'triggering', 'reviewing', 'done', 'failed'],
    }).notNull(),
    summaryModel: text('summary_model').notNull(),
    classifierModel: text('classifier_model').notNull(),
    files: text('files', { mode: 'json' }).$type<FileSummary[]>(),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
  },
  (t) => [
    // The id `<pull request id>-<head sha>` keeps one review per head.
    index('pr_classifications_pr_head_idx').on(t.pullRequestId, t.headSha),
  ]
);

export const prReviewFlags = sqliteTable(
  'pr_review_flags',
  {
    id: text('id').primaryKey(),
    classificationId: text('classification_id')
      .notNull()
      .references(() => prClassifications.id, { onDelete: 'cascade' }),
    // `<agent id>:<index>`: the agent's findings in the order it gave them.
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).$type<unknown>(),
    paths: text('paths', { mode: 'json' }).$type<string[]>().notNull(),
    // The investigation as Markdown; null while it runs or if it failed.
    detail: text('detail'),
    detailModel: text('detail_model'),
    approvedById: text('approved_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedAt: integer('approved_at', { mode: 'timestamp' }),
    // How the current decision (approval, dismissal, or request for changes) was made: the connected app's name when
    // a moderator app made it over MCP, "GitOrange AI" when the AI decided for the person; null from the web.
    approvedVia: text('approved_via'),
    // A person asked for changes instead of approving: blocks auto-merge until someone approves
    // (which clears these). Never set together with approved_at.
    changesRequestedById: text('changes_requested_by_id').references(
      () => users.id,
      { onDelete: 'set null' }
    ),
    changesRequestedAt: integer('changes_requested_at', { mode: 'timestamp' }),
    changesRequestedNote: text('changes_requested_note'),
    // The agent that raised it (agent findings only); its kind; the agent repository commit it reviewed at.
    // The database's foreign key is NO ACTION, not SET NULL: drizzle's ALTER TABLE ADD (migration 0018) can't carry
    // an ON DELETE clause. Never rely on SET NULL: delete or null these rows before an agents row goes.
    agentId: text('agent_id').references(() => agents.userId, {
      onDelete: 'set null',
    }),
    // needs_person: a person approves it. change_requested: the PR's agent changes it (a person may dismiss it,
    // which sets approved_*).
    kind: text('kind', { enum: ['needs_person', 'change_requested'] })
      .notNull()
      .default('needs_person'),
    agentSha: text('agent_sha'),
    // needs_person: the agent's plain yes/no question for the owner (≤ 200 characters, no jargon).
    question: text('question'),
    // Who was asked to decide it, by whom and when. No foreign keys: resolved with the ghost-user fallback like
    // other user ids; nothing deletes users.
    assigneeId: text('assignee_id'),
    assignedById: text('assigned_by_id'),
    assignedAt: integer('assigned_at', { mode: 'timestamp' }),
    // The decider's reason (required to approve a guarded agent's finding).
    decisionReason: text('decision_reason'),
    // What the decider taught the agent with the decision; its learner reads it as the rule (no foreign key, as above).
    teachNote: text('teach_note'),
    teachById: text('teach_by_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    uniqueIndex('pr_review_flags_classification_key_uq').on(
      t.classificationId,
      t.key
    ),
  ]
);

export const reviewerStatuses = [
  'not_needed',
  'reviewing',
  'approved',
  'flagged',
  'changes_requested',
  'failed',
] as const;
export type ReviewerStatus = (typeof reviewerStatuses)[number];

// One invited agent on one head commit of a pull request: whether Clef asked it to review, and how its review
// ended. A new head gets new rows; older ones are history.
export const prReviewers = sqliteTable(
  'pr_reviewers',
  {
    id: text('id').primaryKey(),
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    headSha: text('head_sha').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.userId, { onDelete: 'cascade' }),
    // Clef's probability that the agent's trigger applies; null when Clef wasn't asked or didn't answer.
    probability: real('probability'),
    requested: integer('requested', { mode: 'boolean' }).notNull(),
    // The agent repository commit the review reads AGENT.md and knowledge/ at.
    agentSha: text('agent_sha'),
    status: text('status', { enum: reviewerStatuses }).notNull(),
    // The agent's one-sentence summary, or a note ("Removed from the repository.").
    summary: text('summary'),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
  },
  (t) => [
    uniqueIndex('pr_reviewers_pr_head_agent_uq').on(
      t.pullRequestId,
      t.headSha,
      t.agentId
    ),
    // An agent's recent reviews (its profile), and cancelling its reviews.
    index('pr_reviewers_agent_created_idx').on(t.agentId, t.createdAt),
  ]
);
export type PrReviewer = typeof prReviewers.$inferSelect;

// A person's approval of one head commit of a pull request. A new commit needs a new approval.
export const prApprovals = sqliteTable(
  'pr_approvals',
  {
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    headSha: text('head_sha').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    // The connected app's name when a moderator app approved over MCP; null from the web.
    via: text('via'),
  },
  (t) => [primaryKey({ columns: [t.pullRequestId, t.headSha, t.userId] })]
);
export type PrApproval = typeof prApprovals.$inferSelect;

// A connected MCP app the user lets make review decisions as them (Settings → MCP server → Connected apps). Read on
// every MCP call. Bound to the consent it was turned on under: revoking that consent anywhere (Connected apps, or
// better-auth's own delete-consent) deletes the row, and a later re-consent is a new consent that starts as an ordinary
// connection. (Not a created_at comparison: better-auth stamps consents in whole seconds.)
// Careful in migrations: a table rebuild of oauth_consents (drizzle's DROP + recreate for SQLite column changes, e.g.
// after `yarn auth:update`) deletes every consent row, and this cascade takes every moderator with it — users then
// turn moderator on again. A moderator app also always gets the consent screen (forced in worker/src/auth/index.ts).
export const mcpModerators = sqliteTable(
  'mcp_moderators',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    consentId: text('consent_id')
      .notNull()
      .references(() => oauthConsents.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.clientId] }),
    index('mcp_moderators_consent_id_idx').on(t.consentId),
  ]
);

// ── Agent learning ───────────────────────────────────────────────────────────

export const lessonStatuses = [
  'pending',
  'learning',
  'committed',
  'nothing',
  'failed',
] as const;
export type LessonStatus = (typeof lessonStatuses)[number];

// One lesson per (agent, pull request): the agent's change requests on that pull request that a person dismissed,
// learned from once the pull request closed (merged or not). Written at close, before its run starts, so a second
// close or a retried step never learns twice. A run claims it (pending → learning) with its MERGE_RESOLUTION instance
// id in run_id, which fences every write of that run; at most one lesson of an agent is learning at a time.
export const agentLessons = sqliteTable(
  'agent_lessons',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.userId, { onDelete: 'cascade' }),
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    // The pull request's repository: the agent run's repository, and Insights.
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    // pr_review_flags ids: the agent's change_requested findings a person dismissed, oldest first.
    findingIds: text('finding_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull(),
    status: text('status', { enum: lessonStatuses }).notNull(),
    // The MERGE_RESOLUTION instance that claimed it; null while pending.
    runId: text('run_id'),
    // Runs started (each claim adds one); names the learner object `learn:<id>:<attempts>`.
    attempts: integer('attempts').notNull().default(0),
    // Failed only: the daily sweep may try once more (a model, tool or limit failure; never a rejected edit).
    retryable: integer('retryable', { mode: 'boolean' })
      .notNull()
      .default(false),
    // The agent repository's default-branch commit the run learned from.
    baseSha: text('base_sha'),
    commitSha: text('commit_sha'),
    // The learner's 2–4 line summary (committed, or why there was nothing to learn).
    summary: text('summary'),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
  },
  (t) => [
    uniqueIndex('agent_lessons_agent_pr_uq').on(t.agentId, t.pullRequestId),
    // At most one lesson of an agent learning at a time (the claim checks first; this makes it a rule).
    uniqueIndex('agent_lessons_one_learning_uq')
      .on(t.agentId)
      .where(sql`status = 'learning'`),
    // The profile's Learning section, and an agent's next pending lesson.
    index('agent_lessons_agent_created_idx').on(t.agentId, t.createdAt),
    // The daily sweep.
    index('agent_lessons_status_idx').on(t.status),
    // Insights: lessons committed in a repository.
    index('agent_lessons_repo_finished_idx').on(t.repositoryId, t.finishedAt),
  ]
);
export type AgentLesson = typeof agentLessons.$inferSelect;

// ── Stacking ─────────────────────────────────────────────────────────────────

export type EdgeKind =
  | 'builds_on'
  | 'must_account_for'
  | 'conflicts'
  | 'independent'
  | 'ordered_after';
export type EdgeStage = 'triage' | 'deep' | 'recheck' | 'done' | 'failed';

/**
 * Stacking: how two pull requests into the same target relate. One `pair` row per unordered pair (`a` is
 * the lower number, or the landed one), plus `order` rows for ordering edges. Reset and re-evaluated when
 * either head moves.
 */
export const prEdges = sqliteTable(
  'pr_edges',
  {
    id: text('id').primaryKey(),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    landTarget: text('land_target').notNull(),
    prAId: text('pr_a_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    prBId: text('pr_b_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    // pair: one discovery verdict per unordered pair. order: an ordering edge (kind ordered_after) added so
    // `for_pr_id` can stack on several prerequisites; decided at a_head, b_head and for_head.
    slot: text('slot', { enum: ['pair', 'order'] })
      .notNull()
      .default('pair'),
    // No foreign key: order rows go with the pair's pr_a_id/pr_b_id and repository_id cascades.
    forPrId: text('for_pr_id'),
    forHead: text('for_head'),
    aHead: text('a_head').notNull(),
    bHead: text('b_head').notNull(),
    stage: text('stage', {
      enum: ['triage', 'deep', 'recheck', 'done', 'failed'],
    }).notNull(),
    kind: text('kind', {
      enum: [
        'builds_on',
        'must_account_for',
        'conflicts',
        'independent',
        'ordered_after',
      ],
    }),
    // Which side the other depends on; null when independent.
    prerequisite: text('prerequisite', { enum: ['a', 'b'] }),
    files: text('files', { mode: 'json' }).$type<string[]>(),
    conflictFiles: text('conflict_files', { mode: 'json' }).$type<string[]>(),
    reason: text('reason'),
    // must_account_for: what the dependent PR must change, addressed to its author.
    instructions: text('instructions'),
    // must_account_for: set when a re-check of the dependent's head (accounted_head) found it accounted for.
    accountedForAt: integer('accounted_for_at', { mode: 'timestamp' }),
    accountedHead: text('accounted_head'),
    // A maintainer dismissed it (Dismiss, or Unstack for a parent): it neither stacks nor blocks. Survives head
    // moves.
    dismissedAt: integer('dismissed_at', { mode: 'timestamp' }),
    // No foreign key: resolved with the ghost-user fallback like other user ids; nothing deletes users.
    dismissedById: text('dismissed_by_id'),
    errorMessage: text('error_message'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    uniqueIndex('pr_edges_pair_uq').on(t.prAId, t.prBId, t.slot),
    index('pr_edges_repo_idx').on(t.repositoryId, t.landTarget),
    index('pr_edges_b_idx').on(t.prBId),
  ]
);
export type PrEdge = typeof prEdges.$inferSelect;

// ── Pull request timeline ────────────────────────────────────────────────────
// GitOrange's own timeline entries. state_changed: the PR's computed state changed (states are never stored
// otherwise). Milestone 2b adds stacking events.

export type PrEventKind =
  | 'state_changed'
  | 'stacked'
  | 'unstacked'
  | 'ordered'
  | 'must_account_for'
  | 'accounted_for'
  | 'dismissed'
  // A person approved a head commit (Decision 22), or withdrew that approval.
  | 'approved'
  | 'withdrawn'
  // An agent committed what it learned from this pull request's dismissed change requests.
  | 'learned'
  // GitOrange rebased the pull request's branch onto its base.
  | 'rebased';

export const prEvents = sqliteTable(
  'pr_events',
  {
    id: text('id').primaryKey(),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: [
        'state_changed',
        'stacked',
        'unstacked',
        'ordered',
        'must_account_for',
        'accounted_for',
        'dismissed',
        'approved',
        'withdrawn',
        'learned',
        'rebased',
      ],
    }).notNull(),
    // state_changed: the state it changed to.
    state: text('state', {
      enum: ['agent_followup', 'human_review', 'waiting', 'ready'],
    }),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
    actorId: text('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // state_changed: when the recorded state was computed. A computation older than the latest recorded one
    // never records (see worker/src/pulls/events.ts).
    computedAt: integer('computed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('pr_events_pr_kind_idx').on(t.pullRequestId, t.kind, t.computedAt),
    // The audit log merges these, newest first: per repository, and instance-wide.
    index('pr_events_repo_created_idx').on(t.repositoryId, t.createdAt),
    index('pr_events_created_idx').on(t.createdAt),
  ]
);
export type PrEvent = typeof prEvents.$inferSelect;

// ── Audit log ────────────────────────────────────────────────────────────────
// Who did what, recorded by recordAudit (worker/src/lib/audit.ts), which never throws. The log a page shows merges
// these with pr_events (listAudit). `repository_id` null ⇒ an instance event (tokens, settings, agents, a deleted
// repository); a repository's own events go with it.

export const auditActions = [
  'settings.changed',
  'collaborator.added',
  'collaborator.removed',
  'agent.invited',
  'agent.removed',
  'agent.created',
  'agent.deleted',
  'branch.deleted',
  'branches.cleaned',
  'merging.paused',
  'merging.resumed',
  'pull.merged',
  'pull.reverted',
  'pull.approved',
  'finding.approved',
  'finding.changes_requested',
  'finding.assigned',
  'finding.delegated',
  'finding.undone',
  'finding.taught',
  'token.created',
  'token.deleted',
  'visibility.changed',
  'repository.created',
  'repository.deleted',
  'instance.settings',
] as const;
export type AuditAction = (typeof auditActions)[number];
/** person: a member. agent: a reviewer agent. ai: GitOrange AI deciding for `actor_id`. system: GitOrange itself. */
export const auditActorKinds = ['person', 'agent', 'ai', 'system'] as const;
export type AuditActorKind = (typeof auditActorKinds)[number];

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    repositoryId: text('repository_id').references(() => repositories.id, {
      onDelete: 'cascade',
    }),
    actorId: text('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    actorKind: text('actor_kind', { enum: auditActorKinds }).notNull(),
    // The app it went through: a connected MCP app's name, or "GitOrange AI".
    via: text('via'),
    action: text('action', { enum: auditActions }).notNull(),
    // What it was done to, as people read it: "#12", a branch, a handle, a token or setting name.
    target: text('target').notNull(),
    data: text('data', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('audit_events_repo_created_idx').on(t.repositoryId, t.createdAt),
    index('audit_events_created_idx').on(t.createdAt),
  ]
);
export type AuditEventRow = typeof auditEvents.$inferSelect;

// A person lets GitOrange AI answer this agent's findings on their pull requests ("Let Claude decide"). Never a
// guarded agent's (isGuarded).
export const aiDelegations = sqliteTable(
  'ai_delegations',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.userId, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.agentId] }),
    index('ai_delegations_agent_idx').on(t.agentId),
  ]
);
export type AiDelegation = typeof aiDelegations.$inferSelect;

// ── Actions ──────────────────────────────────────────────────────────────────
// A workflow run: one `.github/workflows/*.yml` file triggered by one event.

const runStatus = ['queued', 'in_progress', 'completed'] as const;
const runConclusion = ['success', 'failure', 'cancelled', 'skipped'] as const;

export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    id: text('id').primaryKey(),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    runNumber: integer('run_number').notNull(),
    workflowPath: text('workflow_path').notNull(),
    name: text('name').notNull(),
    event: text('event', { enum: ['push', 'pull_request'] }).notNull(),
    ref: text('ref').notNull(),
    headSha: text('head_sha').notNull(),
    // Commit subject (push) or pull request title.
    displayTitle: text('display_title').notNull(),
    actorId: text('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    status: text('status', { enum: runStatus }).notNull().default('queued'),
    conclusion: text('conclusion', { enum: runConclusion }),
    // Why the run failed before any job started, e.g. an invalid workflow file.
    errorMessage: text('error_message'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  (t) => [
    uniqueIndex('workflow_runs_repo_number_uq').on(t.repositoryId, t.runNumber),
    // Checks for a commit, in run order (with only (repository_id, head_sha), SQLite picks the
    // run-number index for that ORDER BY and walks every run of the repository).
    index('workflow_runs_repo_sha_number_idx').on(
      t.repositoryId,
      t.headSha,
      t.runNumber
    ),
    // Retention cleanup: finished runs older than the cutoff.
    index('workflow_runs_status_completed_idx').on(t.status, t.completedAt),
    // The Actions page: runs of one workflow file (count, newest first) and the file list.
    index('workflow_runs_repo_path_number_idx').on(
      t.repositoryId,
      t.workflowPath,
      t.runNumber
    ),
  ]
);

export const workflowJobs = sqliteTable(
  'workflow_jobs',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    jobKey: text('job_key').notNull(),
    name: text('name').notNull(),
    runsOn: text('runs_on').notNull(),
    needs: text('needs', { mode: 'json' }).$type<string[]>().notNull(),
    matrixValues: text('matrix_values', { mode: 'json' }).$type<
      Record<string, unknown>
    >(),
    status: text('status', { enum: runStatus }).notNull().default('queued'),
    conclusion: text('conclusion', { enum: runConclusion }),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  (t) => [index('workflow_jobs_run_idx').on(t.runId)]
);

export const workflowSteps = sqliteTable(
  'workflow_steps',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => workflowJobs.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: runStatus }).notNull().default('queued'),
    conclusion: text('conclusion', { enum: runConclusion }),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    logR2Key: text('log_r2_key'),
  },
  (t) => [uniqueIndex('workflow_steps_job_number_uq').on(t.jobId, t.number)]
);

// ── usage & cost ─────────────────────────────────────────────────────────────

/**
 * One Actions runner container, from boot to destroy. A job restarted after an interruption has
 * one row per attempt. Container memory and disk are billed on the provisioned instance size, so
 * duration × size is the bill (vCPU is billed on active use: duration × vCPUs is an upper bound).
 * Rows outlive their job and repository so past months keep their cost.
 */
export const runnerSessions = sqliteTable(
  'runner_sessions',
  {
    /** `<job id>:<attempt>`, so a retried boot step updates its own row. */
    id: text('id').primaryKey(),
    jobId: text('job_id').references(() => workflowJobs.id, {
      onDelete: 'set null',
    }),
    repositoryId: text('repository_id').references(() => repositories.id, {
      onDelete: 'set null',
    }),
    instanceType: text('instance_type').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    /** Null while running, or when the executor died before destroying the container. */
    stoppedAt: integer('stopped_at', { mode: 'timestamp_ms' }),
    /** Hard stop: the JobRunner's orphan alarm destroys the container by this time. */
    deadlineAt: integer('deadline_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('runner_sessions_started_idx').on(t.startedAt),
    index('runner_sessions_job_idx').on(t.jobId),
  ]
);

/** One Workers AI call (or one merge resolution's whole conversation), with its token counts. */
export const aiUsage = sqliteTable(
  'ai_usage',
  {
    id: text('id').primaryKey(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    /** `AiFeature` from lib/ai-gateway.ts. */
    feature: text('feature').notNull(),
    model: text('model').notNull(),
    repositoryId: text('repository_id').references(() => repositories.id, {
      onDelete: 'set null',
    }),
    pullRequestId: text('pull_request_id').references(() => pullRequests.id, {
      onDelete: 'set null',
    }),
    classificationId: text('classification_id'),
    mergeResolutionId: text('merge_resolution_id'),
    /** Model calls this row covers (a merge resolution makes several). */
    requests: integer('requests').notNull().default(1),
    /** Null when the model did not report usage. */
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    tokensCached: integer('tokens_cached'),
    /** The agent run step that made the call (agent_steps.id), when it ran in one. Not a foreign key: usage outlives pruned runs. */
    agentStepId: text('agent_step_id'),
  },
  (t) => [
    index('ai_usage_created_idx').on(t.createdAt),
    index('ai_usage_agent_step_idx').on(t.agentStepId),
  ]
);

/**
 * Agent runs: every MERGE_RESOLUTION Workflow (review, conflict resolution, stack discovery, sweep),
 * recorded step by step for the Actions tab. Metadata and short decisions only: never prompts,
 * diffs, or model text. The id is the Workflow instance id, so a replayed run finds its row.
 */
export const agentRunKinds = [
  'review',
  'conflict_resolution',
  'stack_discovery',
  'sweep',
  'learning',
  'rebase',
] as const;
export type AgentRunKind = (typeof agentRunKinds)[number];
export const agentRunStatuses = ['running', 'succeeded', 'failed'] as const;
export type AgentRunStatus = (typeof agentRunStatuses)[number];

export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    pullRequestId: text('pull_request_id').references(() => pullRequests.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').$type<AgentRunKind>().notNull(),
    status: text('status', { enum: agentRunStatuses }).notNull(),
    title: text('title').notNull(),
    workflowInstanceId: text('workflow_instance_id').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    /** Short, for a failed run. */
    error: text('error'),
  },
  (t) => [
    // The Actions tab: a repository's runs (of one kind), newest first.
    index('agent_runs_repo_started_idx').on(t.repositoryId, t.startedAt),
    index('agent_runs_repo_kind_started_idx').on(
      t.repositoryId,
      t.kind,
      t.startedAt
    ),
    // A pull request's latest runs.
    index('agent_runs_pr_started_idx').on(t.pullRequestId, t.startedAt),
    // Retention: runs older than the cutoff.
    index('agent_runs_started_idx').on(t.startedAt),
  ]
);

export const agentSteps = sqliteTable(
  'agent_steps',
  {
    /** `<run id>:<step name>`: Workflow step names are unique within an instance. */
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    /** Order the executor reached the step in (deterministic, so stable across replays). */
    position: integer('position').notNull(),
    /** The Workflow step name, e.g. `summary:3`; humanized for display. */
    name: text('name').notNull(),
    status: text('status', { enum: agentRunStatuses }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    attempts: integer('attempts').notNull().default(0),
    /** Models called in this step (comma-separated when several), from ai_usage. */
    model: text('model'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    /** Dollars at list price (usage/pricing.ts) when the step's calls were made. */
    costEstimate: real('cost_estimate'),
    /** A short decision summary (≤ 1 KB). */
    decision: text('decision'),
    /** Short, for a failed step. */
    error: text('error'),
  },
  (t) => [index('agent_steps_run_position_idx').on(t.runId, t.position)]
);

/**
 * Daily usage per metric and resource. `source` is `cloudflare` (GraphQL Analytics, filtered to
 * this deployment's resources) or `gitorange` (counted by the app, e.g. emails sent). Costs are
 * computed on read from worker/src/usage/pricing.ts, so a price fix re-prices history.
 */
export const usageDaily = sqliteTable(
  'usage_daily',
  {
    /** UTC day, YYYY-MM-DD. */
    date: text('date').notNull(),
    product: text('product').notNull(),
    metric: text('metric').notNull(),
    /** Script, namespace, bucket, database, or gateway the number is for; '' when none. */
    resource: text('resource').notNull().default(''),
    quantity: real('quantity').notNull(),
    source: text('source', { enum: ['cloudflare', 'gitorange'] }).notNull(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.metric, t.resource] })]
);

/** The latest sync of Cloudflare analytics per day, with the probes that failed. */
export const usageSyncs = sqliteTable('usage_syncs', {
  /** The UTC day synced, YYYY-MM-DD. */
  id: text('id').primaryKey(),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  status: text('status', { enum: ['ok', 'partial', 'error'] }).notNull(),
  /** Probe id → error message, for probes that failed or were not configured. */
  errors: text('errors', { mode: 'json' })
    .$type<Record<string, string>>()
    .notNull(),
});

export type Repository = typeof repositories.$inferSelect;
export type RunnerSession = typeof runnerSessions.$inferSelect;
export type AiUsage = typeof aiUsage.$inferSelect;
export type UsageDaily = typeof usageDaily.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type LfsObject = typeof lfsObjects.$inferSelect;
export type PullRequest = typeof pullRequests.$inferSelect;
export type InstanceSetting = typeof instanceSettings.$inferSelect;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type WorkflowJob = typeof workflowJobs.$inferSelect;
export type WorkflowStep = typeof workflowSteps.$inferSelect;
export type MergeResolution = typeof mergeResolutions.$inferSelect;
export type PrClassification = typeof prClassifications.$inferSelect;
export type PrReviewFlag = typeof prReviewFlags.$inferSelect;
export type UserEmail = typeof userEmails.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type AgentStep = typeof agentSteps.$inferSelect;
