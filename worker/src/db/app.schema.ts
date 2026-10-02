import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import { users } from './auth.schema';

export const repositories = sqliteTable(
  'repositories',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
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
    uniqueIndex('repositories_owner_name_uq').on(t.ownerId, t.name),
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

export type Repository = typeof repositories.$inferSelect;
export type PullRequest = typeof pullRequests.$inferSelect;
