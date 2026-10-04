import { z } from '@hono/zod-openapi';

export const publicUserSchema = z
  .object({
    id: z.string(),
    username: z.string(),
    name: z.string(),
    image: z.string().nullable(),
  })
  .openapi('User');

export const permsSchema = z.object({
  read: z.boolean(),
  write: z.boolean(),
  admin: z.boolean(),
});

export const repoSchema = z
  .object({
    id: z.string(),
    owner: publicUserSchema,
    name: z.string(),
    fullName: z.string(),
    ownerType: z.enum(['user', 'team']),
    visibility: z.enum(['private', 'internal']),
    description: z.string().nullable(),
    defaultBranch: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Repository');

// A git identity, plus the member it belongs to when the email is a member's account email or a
// verified alternate (Settings → Emails).
const commitIdentitySchema = z.object({
  name: z.string(),
  email: z.string(),
  user: publicUserSchema.nullable(),
});

export const commitSchema = z
  .object({
    hash: z.string(),
    treeHash: z.string(),
    message: z.string(),
    author: commitIdentitySchema,
    committer: commitIdentitySchema,
    parents: z.array(z.string()),
    authoredAt: z.number(),
    committedAt: z.number(),
  })
  .openapi('Commit');

export const fileDiffSchema = z
  .object({
    path: z.string(),
    status: z.enum(['added', 'removed', 'modified']),
    oldHash: z.string().nullable(),
    newHash: z.string().nullable(),
    mode: z.string(),
    additions: z.number(),
    deletions: z.number(),
    binary: z.boolean(),
    tooLarge: z.boolean(),
    hunks: z.array(
      z.object({
        oldStart: z.number(),
        oldLines: z.number(),
        newStart: z.number(),
        newLines: z.number(),
        lines: z.array(z.string()),
      })
    ),
  })
  .openapi('FileDiff');

export const ownerRepoParams = z.object({
  owner: z.string(),
  repo: z.string(),
});
