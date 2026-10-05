import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  mergeResolutions,
  pullRequestComments,
  pullRequests,
  type MergeResolution,
  type PullRequest,
} from '../db/app.schema';
import type { GitService } from '../git/service';
import {
  cancelStale,
  latestResolution,
  resolutionConfigured,
  startResolution,
  NO_MODEL,
  SUPERSEDED,
} from '../merge/resolution';
import { generatedConflicts } from '../merge/generated';
import { loadRepo, type RepoEnv } from '../lib/repos';
import { usersById, type PublicUser } from '../lib/users';
import {
  json200Response,
  json201Response,
  json400Response,
  json403Response,
  json404Response,
  json409Response,
  errorSchema,
  validationHook,
} from './openapi-helpers';
import {
  commitSchema,
  fileDiffSchema,
  ownerRepoParams,
  prEventSchema,
  publicUserSchema,
  pullStateSchema,
} from './schemas';
import { compareShas } from './repos-router';
import { attributeCommits } from '../lib/commit-authors';
import { ensureResolution } from '../merge/auto';
import { landPull, pullRef } from '../merge/land';
import { addComment, openPull, pullShas } from '../lib/pulls';
import {
  ensureClassification,
  retryClassification,
  reviewConfigured,
} from '../review/classify';
import { maybeAutoMerge, type ReviewProgress } from '../review/auto-merge';
import { reviewProgressFor } from '../review/list';
import { CHANGES_NOTE_MAX, decideFlag } from '../review/flags';
import { reviewView } from '../review/view';
import { stackTreeView, stackViewFor } from '../stack/view';
import { retryFailedPairs } from '../stack/discover';
import { PULL_STATES, type PullState } from '../pulls/state';
import { pullStates, pullStateFor } from '../pulls/signals';
import { eventsFor } from '../pulls/events';

export const pullsRouter = new OpenAPIHono<RepoEnv>({
  defaultHook: validationHook,
});
pullsRouter.use('/:owner/:repo/*', loadRepo);

const pullSchema = z
  .object({
    id: z.string(),
    number: z.number(),
    title: z.string(),
    body: z.string(),
    state: z.enum(['open', 'closed', 'merged']),
    author: publicUserSchema,
    baseRef: z.string(),
    headRef: z.string(),
    mergeCommitSha: z.string().nullable(),
    mergedBy: publicUserSchema.nullable(),
    /** GitOrange merged it on its own (auto-merge); mergedBy is then null. */
    mergedAutomatically: z.boolean(),
    mergedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    commentCount: z.number(),
  })
  .openapi('PullRequest');

const ghost: PublicUser = {
  id: 'ghost',
  username: 'ghost',
  name: 'Deleted user',
  image: null,
};

function serializePull(
  pr: PullRequest,
  people: Map<string, PublicUser>,
  commentCount = 0
) {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    author: people.get(pr.authorId) ?? ghost,
    baseRef: pr.baseRef,
    headRef: pr.headRef,
    mergeCommitSha: pr.mergeCommitSha,
    mergedBy: pr.mergedById ? (people.get(pr.mergedById) ?? ghost) : null,
    mergedAutomatically: pr.mergedAutomatically,
    mergedAt: pr.mergedAt?.toISOString() ?? null,
    closedAt: pr.closedAt?.toISOString() ?? null,
    createdAt: pr.createdAt.toISOString(),
    updatedAt: pr.updatedAt.toISOString(),
    commentCount,
  };
}

const fullName = (c: Context<RepoEnv>) =>
  `${c.get('namespace').username}/${c.get('repo').name}`;

const numberParams = ownerRepoParams.extend({
  number: z.coerce.number().int().min(1),
});

function getPull(
  c: Context<RepoEnv>,
  n: number
): Promise<PullRequest | undefined> {
  return c
    .get('db')
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, c.get('repo').id),
        eq(pullRequests.number, n)
      )
    )
    .get();
}

// ── list / create ────────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/pulls',
  tags: ['Pull requests'],
  request: {
    params: ownerRepoParams,
    query: z.object({
      state: z
        .enum(['open', 'closed', ...PULL_STATES] as const)
        .default('open'),
    }),
  },
  responses: {
    ...json200Response(
      z.object({
        /** Commit the checks ran on: the branch tip, or the pinned head once closed. */
        pulls: z.array(
          pullSchema.extend({
            headSha: z.string().nullable(),
            /** Open PRs: the latest AI conflict resolution for the current base and head tips. */
            aiResolution: z
              .enum(['queued', 'running', 'proposed', 'failed'])
              .nullable(),
            /** Open PRs under a review.yml: the head commit's auto-merge review. */
            review: z
              .object({
                state: z.enum([
                  'reviewing',
                  'failed',
                  'review_required',
                  'approved',
                ]),
                /** Unapproved flags, when review is required. */
                flags: z.number(),
              })
              .nullable(),
            /** Open PRs: whose move it is, and why. */
            pullState: pullStateSchema.nullable(),
          })
        ),
        openCount: z.number(),
        closedCount: z.number(),
      }),
      'Pull requests'
    ),
  },
});
pullsRouter.openapi(listRoute, async (c) => {
  const db = c.get('db');
  const repo = c.get('repo');
  const { state } = c.req.valid('query');
  const openList = state !== 'closed';
  const byPullState = (PULL_STATES as readonly string[]).includes(state);
  const counts = await db
    .select({ state: pullRequests.state, n: sql<number>`COUNT(*)` })
    .from(pullRequests)
    .where(eq(pullRequests.repositoryId, repo.id))
    .groupBy(pullRequests.state)
    .all();
  const count = (s: string) =>
    Number(counts.find((r) => r.state === s)?.n ?? 0);
  const rows = await db
    .select({
      pr: pullRequests,
      comments: sql<number>`(SELECT COUNT(*) FROM pull_request_comments WHERE pull_request_id = ${pullRequests.id})`,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repo.id),
        openList
          ? eq(pullRequests.state, 'open')
          : sql`${pullRequests.state} != 'open'`
      )
    )
    .orderBy(desc(pullRequests.number))
    .all();
  const people = await usersById(
    db,
    rows.flatMap((r) => [r.pr.authorId, r.pr.mergedById ?? ''])
  );
  // One ref listing answers every row's head commit.
  const refs = rows.length
    ? await c
        .get('git')
        .refs()
        .catch(() => new Map<string, string>())
    : new Map<string, string>();
  const headSha = (pr: PullRequest) =>
    (pr.state === 'open'
      ? refs.get(`refs/heads/${pr.headRef}`)
      : (refs.get(pullRef(pr.number)) ??
        refs.get(`refs/heads/${pr.headRef}`))) ?? null;
  // Latest resolution of every open PR in one query.
  const resolutions = new Map<
    string,
    Pick<
      MergeResolution,
      'status' | 'baseSha' | 'headSha' | 'errorMessage' | 'model'
    >
  >();
  if (openList && rows.length)
    for (const r of await db
      .select({
        pullRequestId: mergeResolutions.pullRequestId,
        status: mergeResolutions.status,
        baseSha: mergeResolutions.baseSha,
        headSha: mergeResolutions.headSha,
        errorMessage: mergeResolutions.errorMessage,
        model: mergeResolutions.model,
      })
      .from(mergeResolutions)
      .innerJoin(
        pullRequests,
        eq(pullRequests.id, mergeResolutions.pullRequestId)
      )
      .where(
        and(
          eq(pullRequests.repositoryId, repo.id),
          eq(pullRequests.state, 'open'),
          sql`${mergeResolutions}.rowid = (SELECT m.rowid FROM merge_resolutions m WHERE m.pull_request_id = ${mergeResolutions.pullRequestId} ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1)`
        )
      )
      .all())
      resolutions.set(r.pullRequestId, r);
  const reviews = openList
    ? await reviewProgressFor(
        db,
        c.get('git'),
        repo.id,
        rows.map((r) => r.pr),
        refs
      )
    : new Map<string, ReviewProgress>();
  const states = openList
    ? await pullStates(
        db,
        c.get('git'),
        repo.id,
        rows.map((r) => r.pr),
        { refs, reviewConfigured: reviewConfigured(c.env) }
      )
    : new Map<string, PullState>();
  const shown = byPullState
    ? rows.filter((r) => states.get(r.pr.id)?.state === state)
    : rows;
  const review = (pr: PullRequest) => {
    const p = reviews.get(pr.id);
    return p
      ? { state: p.state, flags: p.state === 'review_required' ? p.flags : 0 }
      : null;
  };
  const aiResolution = (pr: PullRequest) => {
    const r = resolutions.get(pr.id);
    if (
      !r ||
      r.baseSha !== refs.get(`refs/heads/${pr.baseRef}`) ||
      r.headSha !== refs.get(`refs/heads/${pr.headRef}`)
    )
      return null;
    // Conflicts AI can't resolve (NO_MODEL) were never an AI attempt.
    if (r.model === NO_MODEL) return null;
    if (r.status === 'rejected') return 'failed';
    if (r.status === 'applied' || r.errorMessage === SUPERSEDED) return null;
    return r.status;
  };
  return c.json(
    {
      pulls: shown.map((r) => ({
        ...serializePull(r.pr, people, Number(r.comments)),
        headSha: headSha(r.pr),
        aiResolution: aiResolution(r.pr),
        review: review(r.pr),
        pullState: states.get(r.pr.id) ?? null,
      })),
      openCount: count('open'),
      closedCount: count('closed') + count('merged'),
    },
    200
  );
});

const dependencySchema = z.object({
  number: z.number(),
  kind: z.enum(['builds_on', 'must_account_for', 'conflicts', 'independent']),
  reason: z.string(),
  instructions: z.string().nullable(),
  landed: z.boolean(),
  files: z.array(z.string()),
});
const stackNodeSchema = z.object({
  number: z.number(),
  parent: dependencySchema.nullable(),
  children: z.array(z.number()),
  waitsOn: z.array(dependencySchema),
  mustAccountFor: z.array(dependencySchema),
  cycleWith: z.array(z.number()),
  unchecked: z.array(z.number()),
  /** Other PRs a check against is still running. */
  pending: z.array(z.number()),
  /** No stack run has started for this PR's current head yet. */
  checking: z.boolean(),
});

const treeRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/pulls/tree',
  tags: ['Pull requests'],
  request: { params: ownerRepoParams },
  responses: {
    ...json200Response(
      z.object({
        targets: z.array(
          z.object({
            branch: z.string(),
            nodes: z.array(
              stackNodeSchema.extend({
                title: z.string(),
                headRef: z.string(),
                author: publicUserSchema,
                pullState: pullStateSchema.nullable(),
              })
            ),
            landed: z.array(
              z.object({ number: z.number(), title: z.string() })
            ),
          })
        ),
      }),
      'How open pull requests stack, per target branch (empty when none is open)'
    ),
    ...json404Response,
  },
});
pullsRouter.openapi(treeRoute, async (c) => {
  const db = c.get('db');
  const repo = c.get('repo');
  const view = await stackTreeView(db, c.get('git'), repo.id);
  const open = view.targets.length
    ? await db
        .select()
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repositoryId, repo.id),
            eq(pullRequests.state, 'open')
          )
        )
        .all()
    : [];
  const states = await pullStates(db, c.get('git'), repo.id, open, {
    tree: view,
    reviewConfigured: reviewConfigured(c.env),
  });
  const idOf = new Map(open.map((p) => [p.number, p.id]));
  return c.json(
    {
      ...view,
      targets: view.targets.map((t) => ({
        ...t,
        nodes: t.nodes.map((n) => ({
          ...n,
          pullState: states.get(idOf.get(n.number) ?? '') ?? null,
        })),
      })),
    },
    200
  );
});

const createPullRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls',
  tags: ['Pull requests'],
  request: {
    params: ownerRepoParams,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            title: z.string().min(1).max(256),
            body: z.string().max(65536).default(''),
            base: z.string().min(1),
            head: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(pullSchema, 'Created'),
    ...json400Response,
    ...json403Response,
    ...json409Response,
  },
});
pullsRouter.openapi(createPullRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json(
      { error: 'You do not have push access to this repository' },
      403
    );
  const db = c.get('db');
  const body = c.req.valid('json');
  const author = c.get('user')!;
  const result = await openPull({
    env: c.env,
    db,
    git: c.get('git'),
    repo: c.get('repo'),
    repoFullName: fullName(c),
    author,
    title: body.title,
    body: body.body,
    base: body.base,
    head: body.head,
    after: (work) => c.executionCtx.waitUntil(work),
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  const pr = result.pr;
  return c.json(serializePull(pr, await usersById(db, [author.id])), 201);
});

const resolutionSchema = z
  .object({
    id: z.string(),
    status: z.enum([
      'queued',
      'running',
      'proposed',
      'applied',
      'rejected',
      'failed',
    ]),
    model: z.string(),
    baseSha: z.string(),
    headSha: z.string(),
    resultSha: z.string().nullable(),
    conflictedPaths: z.array(z.string()),
    touchedExtraPaths: z.array(z.string()),
    explanation: z.string().nullable(),
    errorMessage: z.string().nullable(),
    durationMs: z.number().nullable(),
    /** The branches moved since this attempt; it can't be applied. */
    stale: z.boolean(),
    createdAt: z.string(),
  })
  .openapi('MergeResolution');

function serializeResolution(
  r: MergeResolution,
  shas: { base: string; head: string } | null
) {
  return {
    id: r.id,
    status: r.status,
    model: r.model,
    baseSha: r.baseSha,
    headSha: r.headSha,
    resultSha: r.resultSha,
    conflictedPaths: r.conflictedPaths,
    touchedExtraPaths: r.touchedExtraPaths ?? [],
    explanation: r.explanation,
    errorMessage: r.errorMessage,
    durationMs: r.durationMs,
    stale: !shas || shas.base !== r.baseSha || shas.head !== r.headSha,
    createdAt: r.createdAt.toISOString(),
  };
}

const answerSchema = z.union([
  z.object({ type: z.literal('noul'), value: z.number() }),
  z.object({
    type: z.literal('choice'),
    value: z.string(),
    confidence: z.number(),
    probabilities: z.record(z.string(), z.number()),
  }),
  z.object({
    type: z.literal('score'),
    value: z.number(),
    confidence: z.number(),
    probabilities: z.record(z.string(), z.number()),
  }),
]);

const reviewSchema = z
  .object({
    classification: z
      .object({
        id: z.string(),
        status: z.enum([
          'summarizing',
          'classifying',
          'investigating',
          'done',
          'failed',
        ]),
        verdict: z.enum(['auto', 'human']).nullable(),
        headSha: z.string(),
        summaryModel: z.string(),
        classifierModel: z.string(),
        files: z.array(
          z.object({
            path: z.string(),
            status: z.enum(['added', 'removed', 'modified']),
            additions: z.number(),
            deletions: z.number(),
            summary: z.string(),
          })
        ),
        errorMessage: z.string().nullable(),
        durationMs: z.number().nullable(),
        createdAt: z.string(),
      })
      .nullable(),
    questions: z.array(
      z.object({
        id: z.string(),
        ask: z.string(),
        type: z.enum(['noul', 'choice', 'score']),
        threshold: z.string(),
        answer: answerSchema.nullable(),
        flagged: z.boolean(),
      })
    ),
    flags: z.array(
      z.object({
        id: z.string(),
        source: z.enum(['question', 'limit']),
        key: z.string(),
        title: z.string(),
        value: z.unknown(),
        paths: z.array(z.string()),
        detail: z.string().nullable(),
        detailModel: z.string().nullable(),
        approvedBy: publicUserSchema.nullable(),
        approvedAt: z.string().nullable(),
        changesRequestedBy: publicUserSchema.nullable(),
        changesRequestedAt: z.string().nullable(),
        changesRequestedNote: z.string().nullable(),
      })
    ),
    autoMerge: z.object({
      state: z.enum(['off', 'disabled', 'waiting', 'blocked', 'ready']),
      reasons: z.array(z.string()),
      disabledAt: z.string().nullable(),
    }),
  })
  .openapi('PullReview');

// ── one PR ───────────────────────────────────────────────────────────────────

const commentSchema = z.object({
  id: z.string(),
  author: publicUserSchema,
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const getPullRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/pulls/{number}',
  tags: ['Pull requests'],
  request: { params: numberParams },
  responses: {
    ...json200Response(
      z.object({
        pull: pullSchema,
        comments: z.array(commentSchema),
        baseSha: z.string().nullable(),
        headSha: z.string().nullable(),
        headBranchExists: z.boolean(),
        commitCount: z.number(),
        mergeable: z.boolean().nullable(),
        conflicts: z.array(z.string()),
        /** Every conflict is a text conflict, so AI can try to resolve them. */
        conflictsResolvable: z.boolean(),
        /** The conflicts are resolved by a valid AI resolution, which merging will land. */
        resolvedByAi: z.boolean(),
        aiResolution: z.boolean(),
        resolution: resolutionSchema.nullable(),
        /** Head commit's review; null without review.yml. Closed PRs keep the last review. */
        review: reviewSchema.nullable(),
        canMerge: z.boolean(),
        /** Place in the target's stack tree; null when the PR isn't open. */
        stack: stackNodeSchema.nullable(),
        /** Whose move it is, and why; null unless the PR is open with both branches. */
        pullState: pullStateSchema.nullable(),
        /** GitOrange's timeline entries (state changes), oldest first. */
        events: z.array(prEventSchema),
      }),
      'Pull request'
    ),
    ...json404Response,
  },
});
pullsRouter.openapi(getPullRoute, async (c) => {
  const db = c.get('db');
  const git = c.get('git');
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const comments = await db
    .select()
    .from(pullRequestComments)
    .where(eq(pullRequestComments.pullRequestId, pr.id))
    .orderBy(asc(pullRequestComments.createdAt))
    .all();
  const events = await eventsFor(db, pr.id);
  const people = await usersById(db, [
    pr.authorId,
    pr.mergedById ?? '',
    ...comments.map((x) => x.authorId),
    ...events.map((e) => e.actorId ?? ''),
  ]);
  const [shas, headLive] = await Promise.all([
    pullShas(git, pr),
    git.resolve(pr.headRef),
  ]);
  let mergeable: boolean | null = null;
  let conflicts: string[] = [];
  let conflictsResolvable = false;
  let resolvedByAi = false;
  let commitCount = 0;
  const resolution = await latestResolution(db, pr.id);
  if (shas) {
    const commits = await git.commitsBetween(shas.base, shas.head);
    commitCount = commits.length;
    if (pr.state === 'open') {
      const plan = await git.planMerge(shas.base, shas.head, {
        collectConflictFiles: true,
      });
      conflicts = plan.upToDate ? [] : plan.conflicts;
      resolvedByAi =
        conflicts.length > 0 &&
        resolution?.status === 'proposed' &&
        resolution.baseSha === shas.base &&
        resolution.headSha === shas.head;
      mergeable = !plan.upToDate && (conflicts.length === 0 || resolvedByAi);
      // Text conflicts outside generated files (those are regenerated, not merged by the model).
      conflictsResolvable =
        !plan.upToDate &&
        plan.conflicts.length > 0 &&
        plan.conflictFiles.length === plan.conflicts.length &&
        !(await generatedConflicts(git, shas.base, plan.conflicts)).length;
      // Backstop for missed triggers: unresolved text conflicts get a resolution attempt, and an
      // attempt for commits the branches moved past is cancelled.
      if (conflictsResolvable && !resolvedByAi)
        c.executionCtx.waitUntil(
          ensureResolution(c.env, db, git, pr, shas).catch((e) =>
            console.error('[merge] auto-resolve failed', e)
          )
        );
      else if (
        (resolution?.status === 'running' || resolution?.status === 'queued') &&
        (resolution.baseSha !== shas.base || resolution.headSha !== shas.head)
      )
        c.executionCtx.waitUntil(
          cancelStale(c.env, db, git, pr, shas).catch((e) =>
            console.error('[merge] cancel stale failed', e)
          )
        );
    }
  }
  const review = await reviewView(db, git, pr, shas);
  // Backstop for missed triggers: a reviewable commit without a review gets one.
  if (shas && pr.state === 'open' && review && !review.classification)
    c.executionCtx.waitUntil(
      ensureClassification(c.env, db, git, pr, shas).catch((e) =>
        console.error('[review] start failed', e)
      )
    );
  const stack = await stackViewFor(db, git, pr);
  const pullState = await pullStateFor(db, git, pr, {
    shas,
    reviewConfigured: reviewConfigured(c.env),
  });
  return c.json(
    {
      pull: serializePull(pr, people, comments.length),
      comments: comments.map((x) => ({
        id: x.id,
        author: people.get(x.authorId) ?? ghost,
        body: x.body,
        createdAt: x.createdAt.toISOString(),
        updatedAt: x.updatedAt.toISOString(),
      })),
      baseSha: shas?.base ?? null,
      headSha: shas?.head ?? null,
      headBranchExists: !!headLive,
      commitCount,
      mergeable,
      conflicts,
      conflictsResolvable,
      aiResolution: resolutionConfigured(c.env),
      resolvedByAi,
      resolution: resolution ? serializeResolution(resolution, shas) : null,
      review,
      canMerge: c.get('perms').write,
      stack,
      pullState,
      events: events.map((e) => ({
        id: e.id,
        kind: e.kind,
        state: e.state,
        data: e.data ?? null,
        actor: e.actorId ? (people.get(e.actorId) ?? ghost) : null,
        createdAt: e.createdAt.toISOString(),
      })),
    },
    200
  );
});

const updatePullRoute = createRoute({
  method: 'patch',
  path: '/{owner}/{repo}/pulls/{number}',
  tags: ['Pull requests'],
  request: {
    params: numberParams,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            title: z.string().min(1).max(256).optional(),
            body: z.string().max(65536).optional(),
            state: z.enum(['open', 'closed']).optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), 'Updated'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
  },
});
pullsRouter.openapi(updatePullRoute, async (c) => {
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const user = c.get('user')!;
  if (!c.get('perms').write && pr.authorId !== user.id)
    return c.json({ error: 'Forbidden' }, 403);
  const body = c.req.valid('json');
  if (pr.state === 'merged' && body.state)
    return c.json({ error: 'This pull request is already merged' }, 400);
  const now = new Date();
  const patch: Partial<PullRequest> = { updatedAt: now };
  if (body.title !== undefined) patch.title = body.title.trim();
  if (body.body !== undefined) patch.body = body.body;
  if (body.state === 'closed' && pr.state === 'open') {
    patch.state = 'closed';
    patch.closedAt = now;
    const head = await c.get('git').resolve(pr.headRef);
    if (head)
      await c
        .get('git')
        .setRef(pullRef(pr.number), head)
        .catch(() => {});
  }
  if (body.state === 'open' && pr.state === 'closed') {
    if (!(await c.get('git').resolve(pr.headRef)))
      return c.json({ error: 'The head branch no longer exists' }, 400);
    patch.state = 'open';
    patch.closedAt = null;
  }
  await c
    .get('db')
    .update(pullRequests)
    .set(patch)
    .where(eq(pullRequests.id, pr.id));
  if (patch.state === 'open') {
    // A reopened PR may conflict with everything that landed while it was closed.
    const shas = await pullShas(c.get('git'), { ...pr, state: 'open' });
    if (shas)
      c.executionCtx.waitUntil(
        ensureResolution(
          c.env,
          c.get('db'),
          c.get('git'),
          { ...pr, state: 'open' },
          shas
        ).catch((e) => console.error('[merge] auto-resolve failed', e))
      );
    if (shas)
      c.executionCtx.waitUntil(
        ensureClassification(
          c.env,
          c.get('db'),
          c.get('git'),
          { ...pr, state: 'open' },
          shas
        ).catch((e) => console.error('[review] start failed', e))
      );
  }
  return c.json({ ok: true as const }, 200);
});

const pullCommitsRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/pulls/{number}/commits',
  tags: ['Pull requests'],
  request: { params: numberParams },
  responses: {
    ...json200Response(z.array(commitSchema), 'Commits'),
    ...json404Response,
  },
});
pullsRouter.openapi(pullCommitsRoute, async (c) => {
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const shas = await pullShas(c.get('git'), pr);
  if (!shas) return c.json([], 200);
  return c.json(
    await attributeCommits(
      c.get('db'),
      await c.get('git').commitsBetween(shas.base, shas.head)
    ),
    200
  );
});

const pullFilesRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/pulls/{number}/files',
  tags: ['Pull requests'],
  request: { params: numberParams },
  responses: {
    ...json200Response(z.array(fileDiffSchema), 'Changed files'),
    ...json404Response,
  },
});
pullsRouter.openapi(pullFilesRoute, async (c) => {
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const shas = await pullShas(c.get('git'), pr);
  if (!shas) return c.json([], 200);
  return c.json(
    (await compareShas(c.get('git'), shas.base, shas.head)).files,
    200
  );
});

const mergeRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/merge',
  tags: ['Pull requests'],
  request: {
    params: numberParams,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            // Squash and rebase onto the base tip; `squash` is an alias.
            method: z.enum(['rebase', 'squash']).default('rebase'),
            title: z.string().max(256).optional(),
            message: z.string().max(65536).optional(),
            /** Land a proposed AI conflict resolution instead of merging the branches. */
            resolutionId: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ sha: z.string() }), 'Merged'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
    ...json409Response,
  },
});
pullsRouter.openapi(mergeRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to merge' }, 403);
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const body = c.req.valid('json');
  const user = c.get('user')!;
  const result = await landPull({
    env: c.env,
    db: c.get('db'),
    repo: c.get('repo'),
    repoFullName: fullName(c),
    git: c.get('git'),
    pr,
    by: user,
    author: user,
    title: body.title,
    message: body.message,
    resolutionId: body.resolutionId,
    after: (work) => c.executionCtx.waitUntil(work),
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ sha: result.sha }, 200);
});

// ── auto-merge review ────────────────────────────────────────────────────────

const flagParams = numberParams.extend({ flagId: z.string() });

const approveFlagRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/review/flags/{flagId}/approve',
  tags: ['Pull requests'],
  request: { params: flagParams },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), 'Approved'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
  },
});
pullsRouter.openapi(approveFlagRoute, async (c) => {
  // Approving clears a pull request for auto-merge, so it takes merge permission.
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to approve' }, 403);
  const { number, flagId } = c.req.valid('param');
  const pr = await getPull(c, number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const result = await decideFlag(
    c.env,
    c.get('db'),
    pr,
    flagId,
    c.get('user')!.id,
    { kind: 'approve' },
    (work) => c.executionCtx.waitUntil(work)
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true as const }, 200);
});

const requestChangesFlagRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/review/flags/{flagId}/request-changes',
  tags: ['Pull requests'],
  request: {
    params: flagParams,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            note: z.string().max(CHANGES_NOTE_MAX).nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), 'Changes requested'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
  },
});
pullsRouter.openapi(requestChangesFlagRoute, async (c) => {
  // Whoever can approve a flag can request changes on it instead.
  if (!c.get('perms').write)
    return c.json(
      { error: 'You do not have permission to request changes' },
      403
    );
  const { number, flagId } = c.req.valid('param');
  const pr = await getPull(c, number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const result = await decideFlag(
    c.env,
    c.get('db'),
    pr,
    flagId,
    c.get('user')!.id,
    { kind: 'request_changes', note: c.req.valid('json').note },
    (work) => c.executionCtx.waitUntil(work)
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true as const }, 200);
});

const retryReviewRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/review/retry',
  tags: ['Pull requests'],
  request: { params: numberParams },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), 'Review restarted'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
  },
});
pullsRouter.openapi(retryReviewRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to do that' }, 403);
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const shas = pr.state === 'open' ? await pullShas(c.get('git'), pr) : null;
  if (!shas)
    return c.json({ error: 'Only open pull requests are reviewed' }, 400);
  const row = await retryClassification(
    c.env,
    c.get('db'),
    c.get('git'),
    pr,
    shas
  );
  if (!row)
    return c.json(
      { error: 'The target branch has no .gitorange/review.yml' },
      400
    );
  return c.json({ ok: true as const }, 200);
});

const retryStackRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/stack/retry',
  tags: ['Pull requests'],
  request: { params: numberParams },
  responses: {
    202: {
      description:
        'Failed checks against other pull requests are being retried',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean() }) },
      },
    },
    ...json403Response,
    ...json404Response,
    ...json409Response,
    503: {
      description: 'The retry could not be started',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});
pullsRouter.openapi(retryStackRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to do that' }, 403);
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr || pr.state !== 'open') return c.json({ error: 'Not Found' }, 404);
  const shas = await pullShas(c.get('git'), pr);
  if (!shas) return c.json({ error: 'Not Found' }, 404);
  const result = await retryFailedPairs(
    c.env,
    c.get('db'),
    c.get('git'),
    pr,
    shas
  );
  if (result === 'off')
    return c.json({ error: 'AI is not configured on this instance' }, 409);
  if (result === 'unavailable')
    return c.json(
      { error: 'The retry could not be started; try again later' },
      503
    );
  return c.json({ ok: true }, 202);
});

const autoMergeRoute = createRoute({
  method: 'put',
  path: '/{owner}/{repo}/pulls/{number}/auto-merge',
  tags: ['Pull requests'],
  request: {
    params: numberParams,
    body: {
      content: {
        'application/json': { schema: z.object({ enabled: z.boolean() }) },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), 'Updated'),
    ...json403Response,
    ...json404Response,
  },
});
pullsRouter.openapi(autoMergeRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to do that' }, 403);
  const db = c.get('db');
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const { enabled } = c.req.valid('json');
  await db
    .update(pullRequests)
    .set({ autoMergeDisabledAt: enabled ? null : new Date() })
    .where(eq(pullRequests.id, pr.id));
  if (enabled)
    c.executionCtx.waitUntil(
      maybeAutoMerge(c.env, db, pr.id).catch((e) =>
        console.error('[review] auto-merge failed', e)
      )
    );
  return c.json({ ok: true as const }, 200);
});

// ── AI conflict resolution ───────────────────────────────────────────────────

const startResolutionRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/resolutions',
  tags: ['Pull requests'],
  request: { params: numberParams },
  responses: {
    ...json201Response(resolutionSchema, 'Resolution started'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
    ...json409Response,
  },
});
pullsRouter.openapi(startResolutionRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to merge' }, 403);
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  if (pr.state !== 'open')
    return c.json({ error: 'Pull request is not open' }, 400);
  const shas = await pullShas(c.get('git'), pr);
  if (!shas) return c.json({ error: 'The head branch no longer exists' }, 400);
  const result = await startResolution(
    c.env,
    c.get('db'),
    c.get('git'),
    pr,
    shas,
    c.get('user')!.id
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(serializeResolution(result.resolution, shas), 201);
});

const rejectResolutionRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/resolutions/{id}/reject',
  tags: ['Pull requests'],
  request: { params: numberParams.extend({ id: z.string() }) },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), 'Discarded'),
    ...json403Response,
    ...json404Response,
  },
});
pullsRouter.openapi(rejectResolutionRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to merge' }, 403);
  const { number, id } = c.req.valid('param');
  const pr = await getPull(c, number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const updated = await c
    .get('db')
    .update(mergeResolutions)
    .set({ status: 'rejected', decidedAt: new Date() })
    .where(
      and(
        eq(mergeResolutions.id, id),
        eq(mergeResolutions.pullRequestId, pr.id),
        inArray(mergeResolutions.status, ['proposed', 'failed'])
      )
    )
    .returning({ id: mergeResolutions.id });
  if (!updated.length) return c.json({ error: 'Not Found' }, 404);
  return c.json({ ok: true as const }, 200);
});

// ── comments ─────────────────────────────────────────────────────────────────

const createCommentRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/comments',
  tags: ['Pull requests'],
  request: {
    params: numberParams,
    body: {
      content: {
        'application/json': {
          schema: z.object({ body: z.string().min(1).max(65536) }),
        },
      },
    },
  },
  responses: {
    ...json201Response(commentSchema, 'Created'),
    ...json404Response,
  },
});
pullsRouter.openapi(createCommentRoute, async (c) => {
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const user = c.get('user')!;
  const row = await addComment(
    c.env,
    c.get('db'),
    pr,
    user.id,
    c.req.valid('json').body
  );
  const now = row.createdAt;
  const people = await usersById(c.get('db'), [user.id]);
  return c.json(
    {
      id: row.id,
      author: people.get(user.id)!,
      body: row.body,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    201
  );
});
