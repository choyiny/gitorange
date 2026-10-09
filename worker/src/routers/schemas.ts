import { z } from '@hono/zod-openapi';
import { agentFacets, auditActorKinds, lessonStatuses } from '../db/app.schema';
import { PULL_STATES, REASON_KINDS } from '../pulls/state';

export const publicUserSchema = z
  .object({
    id: z.string(),
    username: z.string(),
    name: z.string(),
    image: z.string().nullable(),
  })
  .openapi('User');

/** A reviewer agent: its account plus the fields cached from its AGENT.md. */
export const agentSchema = publicUserSchema
  .extend({
    bio: z.string(),
    trigger: z.object({ ask: z.string(), above: z.number() }),
    engine: z.enum(['pass', 'pi']),
    /** `#rrggbb`: AGENT.md's colour, else a stable one from the palette. */
    color: z.string(),
    /** What it covers (AGENT.md `facet`); null when AGENT.md doesn't say. */
    facet: z.enum(agentFacets).nullable(),
    /** Its findings are never approved in bulk, by one key or by AI, and approving one needs a reason. */
    guarded: z.boolean(),
    /** `<handle>/<handle>`; null once its repository was deleted, or when the viewer can't read it. */
    repository: z.string().nullable(),
    /** The commit of the AGENT.md these fields came from; null when `repository` is. */
    configSha: z.string().nullable(),
    /** Why the default branch's AGENT.md is invalid, if it is; null when `repository` is. */
    configError: z.string().nullable(),
    createdAt: z.string(),
    deletedAt: z.string().nullable(),
  })
  .openapi('Agent');

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
    // Branch name patterns GitOrange never rebases (exact names, or globs: * within a segment, ** across).
    protectedBranches: z.array(z.string()),
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

/** One structured reason; its other fields depend on `kind` (snake_case, as agents read them). */
export const pullReasonSchema = z
  .object({ kind: z.enum(REASON_KINDS) })
  .catchall(z.unknown())
  .openapi('PullReason');

export const pullStateSchema = z
  .object({
    state: z.enum(PULL_STATES),
    reasons: z.array(pullReasonSchema),
  })
  .openapi('PullState');

export const prEventSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    /** state_changed: the state it changed to. */
    state: z.enum(PULL_STATES).nullable(),
    data: z.record(z.string(), z.unknown()).nullable(),
    actor: publicUserSchema.nullable(),
    createdAt: z.string(),
  })
  .openapi('PullEvent');

/** A reviewer preset (worker/src/agents/presets.ts), for Agents → New reviewer. */
export const agentPresetSchema = z
  .object({
    facet: z.enum(agentFacets),
    name: z.string(),
    handle: z.string(),
    bio: z.string(),
    color: z.string(),
    guarded: z.boolean(),
    triggerAsk: z.string(),
    triggerAbove: z.number(),
    engine: z.enum(['pass', 'pi']),
    /** Part of "the recommended crew" (POST /api/admin/agents/crew). */
    recommended: z.boolean(),
    /** Its handle is taken (it was created already, or someone else holds the name): it can't be created. */
    exists: z.boolean(),
  })
  .openapi('AgentPreset');

/** One entry of an audit log: an audit_events row, or a pull request timeline event (`pull.<kind>`). */
export const auditEventSchema = z
  .object({
    id: z.string(),
    /** Epoch milliseconds. */
    at: z.number(),
    actor: z.object({
      kind: z.enum(auditActorKinds),
      login: z.string().nullable(),
      name: z.string().nullable(),
    }),
    /** The app it went through: a connected MCP app's name, or "GitOrange AI". */
    via: z.string().nullable(),
    action: z.string(),
    target: z.string(),
    data: z.record(z.string(), z.unknown()),
    /** `owner/name`; null for an instance event. */
    repo: z.string().nullable(),
    pull: z.number().nullable(),
  })
  .openapi('AuditEvent');

export const auditPageSchema = z
  .object({
    events: z.array(auditEventSchema),
    /** Pass as `cursor` for the next (older) page; null on the last. */
    nextCursor: z.string().nullable(),
  })
  .openapi('AuditPage');

/** What an agent learned from one pull request's dismissed change requests (learn/view.ts LessonView). */
export const lessonSchema = z
  .object({
    id: z.string(),
    repository: z.string(),
    number: z.number(),
    title: z.string(),
    findings: z.array(z.string()),
    status: z.enum(lessonStatuses),
    commitSha: z.string().nullable(),
    summary: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .openapi('AgentLesson');
