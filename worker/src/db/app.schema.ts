import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './auth.schema';

// The instance's one shared team. Its slug shares the URL namespace with usernames
// (`/<slug>/<repo>`), so the two must never collide. Created by an admin in Site admin.
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
    // Set ⇒ a team repository, addressed as /<team slug>/<name>.
    teamId: text('team_id').references(() => teams.id),
    // private: owner, collaborators, and site admins only. internal: every member can read.
    visibility: text('visibility', { enum: ['private', 'internal'] })
      .notNull()
      .default('internal'),
    name: text('name').notNull(),
    description: text('description'),
    defaultBranch: text('default_branch').notNull().default('main'),
    // Immutable Artifacts repo name (r_<id>) so renames never touch git storage.
    artifactsName: text('artifacts_name').notNull().unique(),
    nextPrNumber: integer('next_pr_number').notNull().default(1),
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
    state: text('state', { enum: ['open', 'closed', 'merged'] })
      .notNull()
      .default('open'),
    mergeCommitSha: text('merge_commit_sha'),
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
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    uniqueIndex('pull_requests_repo_number_uq').on(t.repositoryId, t.number),
    index('pull_requests_repo_state_idx').on(t.repositoryId, t.state),
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

// Git LFS objects. Bytes live in R2 under `r2_key` (a bare key, never a URL); a row exists only
// once the upload is confirmed in R2. One copy per repository, so deleting a repo deletes its prefix.
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
// One attempt to resolve a pull request's merge conflicts with AI. The result is a squashed
// commit on the base branch, kept on a side ref (`refs/resolutions/<id>`) until it is applied.

export const mergeResolutions = sqliteTable(
  'merge_resolutions',
  {
    id: text('id').primaryKey(),
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    /** The base branch tip and PR head the resolution merges. */
    baseSha: text('base_sha').notNull(),
    headSha: text('head_sha').notNull(),
    status: text('status', {
      // queued: waiting for a free slot (resolutions per repository are capped).
      enum: ['queued', 'running', 'proposed', 'applied', 'rejected', 'failed'],
    })
      .notNull()
      .default('running'),
    model: text('model').notNull(),
    conflictedPaths: text('conflicted_paths', { mode: 'json' })
      .$type<string[]>()
      .notNull(),
    /** Files the model changed outside the conflicted ones. */
    touchedExtraPaths: text('touched_extra_paths', { mode: 'json' }).$type<
      string[]
    >(),
    explanation: text('explanation'),
    errorMessage: text('error_message'),
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

// ── Auto-merge review ────────────────────────────────────────────────────────
// One classification per pull request head commit and `.gitorange/review.yml` version: a
// one-line summary per changed file (GLM), Clef's answers to the policy's questions over those
// summaries, and the flags that need a person. Approving every flag clears it for auto-merge.

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
    // Blob sha of the `.gitorange/review.yml` the target branch had when this started.
    policySha: text('policy_sha').notNull(),
    status: text('status', {
      enum: ['summarizing', 'classifying', 'investigating', 'done', 'failed'],
    }).notNull(),
    summaryModel: text('summary_model').notNull(),
    classifierModel: text('classifier_model').notNull(),
    files: text('files', { mode: 'json' }).$type<FileSummary[]>(),
    answers: text('answers', { mode: 'json' }).$type<
      Record<string, ClassifierAnswer>
    >(),
    // auto: nothing flagged; human: flags need approval. Null until done (or when it failed).
    verdict: text('verdict', { enum: ['auto', 'human'] }),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
  },
  (t) => [
    uniqueIndex('pr_classifications_pr_head_policy_uq').on(
      t.pullRequestId,
      t.headSha,
      t.policySha
    ),
  ]
);

export const prReviewFlags = sqliteTable(
  'pr_review_flags',
  {
    id: text('id').primaryKey(),
    classificationId: text('classification_id')
      .notNull()
      .references(() => prClassifications.id, { onDelete: 'cascade' }),
    // question: a review.yml question crossed its threshold; limit: the pull request is too
    // large, or a file couldn't be summarized.
    source: text('source', { enum: ['question', 'limit'] }).notNull(),
    // The question id, or the limit's name.
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).$type<unknown>(),
    paths: text('paths', { mode: 'json' }).$type<string[]>().notNull(),
    // What the investigating model found, as Markdown (with a Mermaid diagram and expandable
    // code excerpts from the diff, when it gave them); null while it runs or if it failed.
    detail: text('detail'),
    detailModel: text('detail_model'),
    approvedById: text('approved_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedAt: integer('approved_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    uniqueIndex('pr_review_flags_classification_key_uq').on(
      t.classificationId,
      t.source,
      t.key
    ),
  ]
);

// ── Actions ──────────────────────────────────────────────────────────────────
// A workflow run is one `.github/workflows/*.yml` file triggered by one event. Its jobs run
// in containers driven by a Cloudflare Workflow; step logs live in R2 (`log_r2_key`).

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
    // The commit subject (push) or pull request title, shown in run lists.
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
    index('workflow_runs_repo_sha_idx').on(t.repositoryId, t.headSha),
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

export type Repository = typeof repositories.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type LfsObject = typeof lfsObjects.$inferSelect;
export type PullRequest = typeof pullRequests.$inferSelect;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type WorkflowJob = typeof workflowJobs.$inferSelect;
export type WorkflowStep = typeof workflowSteps.$inferSelect;
export type MergeResolution = typeof mergeResolutions.$inferSelect;
export type PrClassification = typeof prClassifications.$inferSelect;
export type PrReviewFlag = typeof prReviewFlags.$inferSelect;
