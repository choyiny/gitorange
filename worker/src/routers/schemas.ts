import { z } from '@hono/zod-openapi';
import {
  agentFacets,
  auditActorKinds,
  lessonStatuses,
  reviewerStatuses,
} from '../db/app.schema';
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
    // Every landing (the merge button or auto-merge) deletes the pull request's head branch.
    deleteMergedBranches: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Repository');

/** What an agent is doing on a repository's open pull requests: a reviewer status, or `idle` when it is on none. */
const agentActivitySchema = z.enum([...reviewerStatuses, 'idle']);

/** The Repositories board's numbers for one repository (`GET /api/repos?stats=1`; worker/src/lib/repo-stats.ts). */
export const repoStatsSchema = z
  .object({
    pulls: z.object({
      open: z.number(),
      /** A person's move: approve it, answer a finding. */
      needsPerson: z.number(),
      /** Its author's agent has changes to make: failed checks, requested changes, a rebase conflict. */
      changesRequested: z.number(),
      /** Waiting for checks or reviews that are running. */
      checking: z.number(),
      /** Ready, or waiting on its order or on other pull requests. */
      queued: z.number(),
    }),
    /** Pull requests merged in the last seven UTC days. */
    merged7d: z.number(),
    /** Merges per UTC day over those seven days, oldest first, today last. */
    mergedByDay: z.array(z.number()),
    /** The share GitOrange merged on its own, 0 to 100; null when nothing merged. */
    mergedAutomaticallyPct: z.number().nullable(),
    agents: z.array(
      z.object({
        handle: z.string(),
        name: z.string(),
        color: z.string(),
        status: agentActivitySchema,
      })
    ),
    /** Null when the repository's refs could not be read. */
    branchCount: z.number().nullable(),
    /** The language most of its source files are written in. */
    language: z.string().nullable(),
    /** Epoch milliseconds. */
    updatedAt: z.number(),
  })
  .openapi('RepositoryStats');

/** A repository in the list; `stats` only with `?stats=1`. */
export const repoWithStatsSchema = repoSchema
  .extend({ stats: repoStatsSchema.optional() })
  .openapi('RepositoryListItem');

/** An agent's record: how its findings fared and where it works now (worker/src/lib/agent-stats.ts). */
export const agentStatsSchema = z
  .object({
    handle: z.string(),
    raised: z.number(),
    kept: z.number(),
    dismissed: z.number(),
    /** kept / (kept + dismissed) as a whole percentage; null until one has been decided. */
    keptPct: z.number().nullable(),
    /** Committed lessons. */
    rules: z.number(),
    reviews: z.number(),
    /** 182 UTC days, oldest first, today last. */
    byDay: z.array(z.object({ date: z.string(), reviews: z.number() })),
    bestCatch: z
      .object({ title: z.string(), repo: z.string(), number: z.number() })
      .nullable(),
    repos: z.array(
      z.object({
        repo: z.string(),
        status: agentActivitySchema,
        number: z.number().nullable(),
      })
    ),
  })
  .openapi('AgentStats');

/** Clef or Fixer: the agents GitOrange has built in. */
export const builtinAgentSchema = z
  .object({
    id: z.enum(['clef', 'fixer']),
    name: z.string(),
    job: z.string(),
    stats: z.array(z.object({ label: z.string(), value: z.string() })),
  })
  .openapi('BuiltinAgent');

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

/** Who someone is on the crew pages: a person, or a reviewer agent with its colour (worker/src/lib/person-ref.ts). */
export const personRefSchema = z
  .object({
    /** The username, or the agent's handle. */
    login: z.string(),
    name: z.string().nullable(),
    isAgent: z.boolean(),
    /** An agent's `#rrggbb`; null for a person. */
    color: z.string().nullable(),
  })
  .openapi('PersonRef');

/** What every finding (review flag) shows about who decides it and how it was decided (review/reviewers-view.ts). */
export const flagDecisionFields = {
  /** needs_person: the agent's plain yes/no question for the owner; null when it asked none. */
  question: z.string().nullable(),
  /** Its agent is guarded: never approved in bulk, by one key or by AI; approving it needs a reason. */
  guarded: z.boolean(),
  /** Who was asked to decide it. */
  assignee: personRefSchema.nullable(),
  /** How the current decision was made: a moderator app's name, or "GitOrange AI"; null from the web, or open. */
  decidedVia: z.string().nullable(),
  /** The decider's reason (a person's for an approval, GitOrange AI's for either decision). */
  reason: z.string().nullable(),
  /** What the decider taught the agent with the decision. */
  teach: z.string().nullable(),
};

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
