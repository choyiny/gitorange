import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  agents,
  mergeResolutions,
  pullRequestComments,
  pullRequests,
  reviewerStatuses,
  type PullRequest,
} from '../db/app.schema';
import type { GitService } from '../git/service';
import { NO_MODEL, SUPERSEDED } from '../merge/resolution';
import {
  ensureRebase,
  rebaseTips,
  rebaseView,
  retryRebase,
  type RebaseView,
} from '../merge/rebase';
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
  flagDecisionFields,
  ownerRepoParams,
  personRefSchema,
  prEventSchema,
  publicUserSchema,
  pullReasonSchema,
  pullStateSchema,
} from './schemas';
import { compareShas } from './repos-router';
import { attributeCommits } from '../lib/commit-authors';
import { landPull, pullRef } from '../merge/land';
import { addComment, openPull, pullShas } from '../lib/pulls';
import { revertPull } from '../lib/revert';
import { pullSessionId, pullSessionIds } from '../lib/sessions';
import { reviewConfigured } from '../review/head';
import { maybeAutoMerge } from '../review/auto-merge';
import {
  listReview,
  reviewInputs,
  reviewVerdict,
  type GateReviewer,
} from '../review/gate';
import {
  assignFlag,
  CHANGES_NOTE_MAX,
  DECISION_REASON_MAX,
  decideFlag,
  TEACH_NOTE_MAX,
  undoFlag,
} from '../review/flags';
import { decideFinding } from '../review/delegate';
import { reviewersView } from '../review/reviewers-view';
import { publishChange } from '../live/publish';
import { settleStates } from '../pulls/settle';
import { retryReviewer } from '../review/reviewers';
import { ensureHeadReview, retryHeadReview } from '../review/head';
import { chunks, stackTreeView, stackViewFor } from '../stack/view';
import { agentColor } from '../agents/presets';
import { pullSearch } from '../lib/pull-search';
import { ensureStacking, retryFailedPairs } from '../stack/discover';
import { dismissEdge, onPullClosed, startReconcile } from '../stack/retarget';
import { queueLessons } from '../learn/lessons';
import { PULL_STATES, type PullState } from '../pulls/state';
import { pullStates, pullStateFor } from '../pulls/signals';
import { eventsFor } from '../pulls/events';
import {
  approvalsAt,
  approvePull,
  withdrawApproval,
} from '../review/approvals';
import { landShas, landTargetOf } from '../lib/land-target';

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
    /** Where it lands; baseRef may be a parent PR's branch while stacked. */
    landTarget: z.string(),
    headRef: z.string(),
    mergeCommitSha: z.string().nullable(),
    mergedBy: publicUserSchema.nullable(),
    /** GitOrange merged it on its own (auto-merge); mergedBy is then null. */
    mergedAutomatically: z.boolean(),
    mergedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    /** The app that opened it over MCP, self-reported (the OAuth client's name); null when opened by hand. */
    createdVia: z.string().nullable(),
    /** The coding session label that app reported, if any. */
    sessionLabel: z.string().nullable(),
    /** The id `GET /sessions` gives its coding session; never null (one opened by hand is its author's session). */
    sessionId: z.string(),
    /** The person's original request that app reported, if any. */
    request: z.string().nullable(),
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
  sessionId: string,
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
    landTarget: landTargetOf(pr),
    headRef: pr.headRef,
    mergeCommitSha: pr.mergeCommitSha,
    mergedBy: pr.mergedById ? (people.get(pr.mergedById) ?? ghost) : null,
    mergedAutomatically: pr.mergedAutomatically,
    mergedAt: pr.mergedAt?.toISOString() ?? null,
    closedAt: pr.closedAt?.toISOString() ?? null,
    createdVia: pr.createdVia,
    sessionLabel: pr.sessionLabel,
    sessionId,
    request: pr.request,
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
      /**
       * `closed` is every closed and merged pull request, newest number first; `merged` only the merged ones, newest
       * merge first; the four pull states are open pull requests in that state.
       */
      state: z
        .enum(['open', 'closed', 'merged', ...PULL_STATES] as const)
        .default('open'),
      /** Rows per page (1 to 100). Without it the whole list comes back, as it always did. */
      limit: z.coerce.number().int().min(1).max(100).optional(),
      /** Which page of `limit` rows, from 1. */
      page: z.coerce.number().int().min(1).default(1),
      /**
       * Only the pull requests every word of this matches: a number (`#12`), or part of the title, branch, author, the
       * app that opened it or its session label; "by hand" matches the ones no app opened.
       */
      q: z.string().trim().max(100).optional(),
    }),
  },
  responses: {
    ...json200Response(
      z.object({
        /** Commit the checks ran on: the branch tip, or the pinned head once closed. */
        pulls: z.array(
          pullSchema.extend({
            headSha: z.string().nullable(),
            /** Open PRs: AI resolving a rebase conflict at the current tips, or failed to. */
            aiResolution: z.enum(['running', 'failed']).nullable(),
            /** Open PRs: the head commit's review in a word (agents, or a person's approval). */
            review: z
              .object({
                state: z.enum([
                  'reviewing',
                  'failed',
                  'changes_requested',
                  'review_required',
                  'needs_approval',
                  'approved',
                ]),
                /** Agents' findings waiting for a person. */
                flags: z.number(),
              })
              .nullable(),
            /** Open PRs: whose move it is, and why. */
            pullState: pullStateSchema.nullable(),
            /**
             * Open PRs: each reviewer agent that was asked to review the head commit, by handle, with the state of its
             * review. An agent Clef did not wake for this commit is left out.
             */
            reviewers: z.array(
              z.object({
                handle: z.string(),
                name: z.string(),
                color: z.string(),
                status: z.enum(reviewerStatuses),
              })
            ),
          })
        ),
        /** Every open pull request, and every closed or merged one, whatever the page. */
        openCount: z.number(),
        closedCount: z.number(),
        /** How many pull requests `state` matches, before paging. */
        total: z.number(),
      }),
      'Pull requests'
    ),
  },
});
pullsRouter.openapi(listRoute, async (c) => {
  const db = c.get('db');
  const repo = c.get('repo');
  const { state, limit, page, q } = c.req.valid('query');
  const openList = state !== 'closed' && state !== 'merged';
  const byPullState = (PULL_STATES as readonly string[]).includes(state);
  const counts = await db
    .select({ state: pullRequests.state, n: sql<number>`COUNT(*)` })
    .from(pullRequests)
    .where(eq(pullRequests.repositoryId, repo.id))
    .groupBy(pullRequests.state)
    .all();
  const count = (s: string) =>
    Number(counts.find((r) => r.state === s)?.n ?? 0);
  const offset = ((limit ? page : 1) - 1) * (limit ?? 0);
  const search = q ? pullSearch(q) : undefined;
  const inList = and(
    eq(pullRequests.repositoryId, repo.id),
    openList
      ? eq(pullRequests.state, 'open')
      : state === 'merged'
        ? eq(pullRequests.state, 'merged')
        : sql`${pullRequests.state} != 'open'`,
    search
  );
  let listed = db
    .select({
      pr: pullRequests,
      comments: sql<number>`(SELECT COUNT(*) FROM pull_request_comments WHERE pull_request_id = ${pullRequests.id})`,
    })
    .from(pullRequests)
    .where(inList)
    .orderBy(
      ...(state === 'merged'
        ? [desc(pullRequests.mergedAt), desc(pullRequests.number)]
        : [desc(pullRequests.number)])
    )
    .$dynamic();
  // A pull-state filter is applied after the states are computed, so it pages below; the rest page in SQL.
  if (limit && !byPullState) listed = listed.limit(limit).offset(offset);
  const rows = await listed.all();
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
    {
      status: string;
      baseSha: string;
      headSha: string;
      errorMessage: string | null;
      model: string;
      commitSha: string | null;
    }
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
        commitSha: mergeResolutions.commitSha,
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
  // The review gate's inputs, read once for both the review summary and the states.
  const tips = openList
    ? rows.flatMap(({ pr }) => {
        const head = refs.get(`refs/heads/${pr.headRef}`);
        return pr.state === 'open' &&
          head &&
          refs.get(`refs/heads/${landTargetOf(pr)}`)
          ? [{ pullRequestId: pr.id, head }]
          : [];
      })
    : [];
  const gates = await reviewInputs(db, repo.id, tips, reviewConfigured(c.env));
  const states = openList
    ? await pullStates(
        db,
        c.get('git'),
        repo.id,
        rows.map((r) => r.pr),
        { refs, reviewConfigured: reviewConfigured(c.env), reviews: gates }
      )
    : new Map<string, PullState>();
  const matching = byPullState
    ? rows.filter((r) => states.get(r.pr.id)?.state === state)
    : rows;
  // The counts above are the repository's; a search makes its own.
  const total = byPullState
    ? matching.length
    : search
      ? Number(
          (
            await db
              .select({ n: sql<number>`COUNT(*)` })
              .from(pullRequests)
              .where(inList)
              .get()
          )?.n ?? 0
        )
      : state === 'open'
        ? count('open')
        : state === 'merged'
          ? count('merged')
          : count('closed') + count('merged');
  const shown =
    limit && byPullState ? matching.slice(offset, offset + limit) : matching;
  const review = (pr: PullRequest) => {
    const gate = gates.get(pr.id);
    return gate ? listReview(reviewVerdict(gate)) : null;
  };
  const aiResolution = (pr: PullRequest) => {
    const r = resolutions.get(pr.id);
    const onto =
      refs.get(`refs/heads/${pr.baseRef}`) ??
      refs.get(`refs/heads/${landTargetOf(pr)}`);
    if (
      !r ||
      r.baseSha !== onto ||
      r.headSha !== refs.get(`refs/heads/${pr.headRef}`)
    )
      return null;
    // A stop AI never attempted (binary, delete/edit, generated, too many commits) isn't an AI resolution.
    if (r.model === NO_MODEL) return null;
    // A per-commit resolution (a squash-era row, commit_sha NULL, is never resumed).
    if ((r.status === 'running' || r.status === 'resolved') && r.commitSha)
      return 'running' as const;
    if (r.status === 'failed' && r.errorMessage !== SUPERSEDED)
      return 'failed' as const;
    return null;
  };
  // The reviewer agents asked to review each shown pull request's head commit: already read for the gate above (a
  // reviewer row per agent at the head), so only the agents' names and colours need one more query.
  const asked = new Map<string, GateReviewer[]>();
  for (const { pr } of shown) {
    const rs = (gates.get(pr.id)?.reviewers ?? []).filter(
      (r) => r.requested && r.status !== 'not_needed'
    );
    if (rs.length) asked.set(pr.id, rs);
  }
  const looks = new Map<string, { name: string; color: string | null }>();
  const agentIds = [
    ...new Set([...asked.values()].flatMap((rs) => rs.map((r) => r.agentId))),
  ];
  for (const part of chunks(agentIds, 90))
    for (const a of await db
      .select({ id: agents.userId, name: agents.name, color: agents.color })
      .from(agents)
      .where(inArray(agents.userId, part))
      .all())
      looks.set(a.id, a);
  const reviewers = (pr: PullRequest) =>
    (asked.get(pr.id) ?? []).map((r) => {
      const look = looks.get(r.agentId);
      return {
        handle: r.handle,
        name: look?.name ?? r.handle,
        color: agentColor({ color: look?.color }, r.handle),
        status: r.status,
      };
    });
  const sessionIds = await pullSessionIds(shown.map((r) => r.pr));
  return c.json(
    {
      pulls: shown.map((r) => ({
        ...serializePull(
          r.pr,
          people,
          sessionIds.get(r.pr.id)!,
          Number(r.comments)
        ),
        headSha: headSha(r.pr),
        aiResolution: aiResolution(r.pr),
        review: review(r.pr),
        pullState: states.get(r.pr.id) ?? null,
        reviewers: reviewers(r.pr),
      })),
      openCount: count('open'),
      closedCount: count('closed') + count('merged'),
      total,
    },
    200
  );
});

const dependencySchema = z.object({
  number: z.number(),
  kind: z.enum([
    'builds_on',
    'must_account_for',
    'conflicts',
    'independent',
    'ordered_after',
  ]),
  reason: z.string(),
  instructions: z.string().nullable(),
  landed: z.boolean(),
  files: z.array(z.string()),
  accounted: z.boolean(),
  /** ordered_after: the PR this order was added for. */
  forPr: z.number().nullable(),
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
  return c.json(
    serializePull(
      pr,
      await usersById(db, [author.id]),
      await pullSessionId(pr)
    ),
    201
  );
});

const reviewFlagSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['needs_person', 'change_requested']),
    title: z.string(),
    paths: z.array(z.string()),
    detail: z.string().nullable(),
    detailModel: z.string().nullable(),
    agentSha: z.string().nullable(),
    approvedBy: publicUserSchema.nullable(),
    approvedAt: z.string().nullable(),
    /** The moderator app the approval or dismissal came through; null when made in the web UI. */
    approvedVia: z.string().nullable(),
    changesRequestedBy: publicUserSchema.nullable(),
    changesRequestedAt: z.string().nullable(),
    changesRequestedNote: z.string().nullable(),
    ...flagDecisionFields,
  })
  .openapi('ReviewFlag');

const reviewSchema = z
  .object({
    headSha: z.string(),
    agentsInvited: z.boolean(),
    status: z
      .enum(['summarizing', 'triggering', 'reviewing', 'done', 'failed'])
      .nullable(),
    errorMessage: z.string().nullable(),
    summaryModel: z.string().nullable(),
    files: z.array(
      z.object({
        path: z.string(),
        status: z.enum(['added', 'removed', 'modified']),
        additions: z.number(),
        deletions: z.number(),
        summary: z.string(),
      })
    ),
    createdAt: z.string().nullable(),
    durationMs: z.number().nullable(),
    reviewers: z.array(
      z.object({
        id: z.string(),
        agent: publicUserSchema,
        /** `<handle>/<handle>`, for the agent_sha link; null once that repository is deleted. */
        agentRepository: z.string().nullable(),
        /** Still invited; a removed agent's row stays as history and stops counting. */
        invited: z.boolean(),
        status: z.enum(reviewerStatuses),
        requested: z.boolean(),
        probability: z.number().nullable(),
        agentSha: z.string().nullable(),
        summary: z.string().nullable(),
        error: z.string().nullable(),
        createdAt: z.string(),
        finishedAt: z.string().nullable(),
        flags: z.array(reviewFlagSchema),
      })
    ),
    /** Requested agents' reviews of this pull request's earlier head commits, newest first (at most 50); history. */
    earlier: z.array(
      z.object({
        id: z.string(),
        headSha: z.string(),
        agent: publicUserSchema,
        status: z.enum(reviewerStatuses),
        summary: z.string().nullable(),
        error: z.string().nullable(),
        createdAt: z.string(),
        finishedAt: z.string().nullable(),
        flags: z.array(reviewFlagSchema),
      })
    ),
    /** Whether review lets this commit land, and why not (open pull requests only). */
    verdict: z
      .object({ satisfied: z.boolean(), reasons: z.array(pullReasonSchema) })
      .nullable(),
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

const rebaseViewSchema = z
  .object({
    status: z.enum([
      'nothing_to_merge',
      'up_to_date',
      'behind',
      'resolving',
      'conflict',
    ]),
    /** The branch it rebases onto: base_ref, or the land target when that branch is gone. */
    onto: z.string(),
    /** The commit AI is resolving, or where the rebase stopped (null: before any commit). */
    commit: z.string().nullable(),
    files: z.array(z.string()),
    error: z.string().nullable(),
  })
  .openapi('RebaseStatus');

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
        /** It can land: up to date with its base, or behind it (landing rebases it first). */
        mergeable: z.boolean().nullable(),
        /** Where it stands against its base; null unless it is open with both branches. */
        rebase: rebaseViewSchema.nullable(),
        /** The head commit's review by agents and people; null when the branches are gone. */
        review: reviewSchema.nullable(),
        canMerge: z.boolean(),
        /** People who approved the head commit, oldest first (a new commit needs a new approval). */
        approvals: z.array(
          z.object({
            user: publicUserSchema,
            createdAt: z.string(),
            /** The moderator app the approval came through; null when made in the web UI. */
            via: z.string().nullable(),
          })
        ),
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
  const [shas, headLive] = await Promise.all([
    pullShas(git, pr),
    git.resolve(pr.headRef),
  ]);
  const approvals = shas ? await approvalsAt(db, pr.id, shas.head) : [];
  const people = await usersById(db, [
    pr.authorId,
    pr.mergedById ?? '',
    ...comments.map((x) => x.authorId),
    ...events.map((e) => e.actorId ?? ''),
    ...approvals.map((a) => a.userId),
  ]);
  let mergeable: boolean | null = null;
  let rebase: RebaseView | null = null;
  let commitCount = 0;
  // Merging is measured against the land target, which base_ref (the diff's base) may not be while stacked.
  const target = pr.state === 'open' ? await landShas(git, pr) : null;
  if (shas)
    commitCount = (await git.commitsBetween(shas.base, shas.head)).length;
  const tips = pr.state === 'open' ? await rebaseTips(git, pr) : null;
  if (tips) {
    rebase = await rebaseView(c.env, db, git, pr, tips);
    mergeable = rebase.status === 'up_to_date' || rebase.status === 'behind';
    // Backstop for missed triggers, and for a run that died mid-resolution (it would show resolving forever): a
    // pull request behind its base gets a rebase run unless a fresh one is running (ensureRebase decides).
    if (rebase.status === 'behind' || rebase.status === 'resolving')
      c.executionCtx.waitUntil(ensureRebase(c.env, db, git, pr));
  }
  const review = await reviewersView(c.env, db, git, pr, shas);
  // Backstop for missed triggers: a head with no review gets one where agents are invited.
  if (target && review?.agentsInvited && review.status === null)
    c.executionCtx.waitUntil(
      ensureHeadReview(c.env, db, pr, target).catch((e) =>
        console.error('[review] start failed', e)
      )
    );
  // A tree that can't be read never takes the page down; merging still refuses (stackGate).
  const stack = await stackViewFor(db, git, pr).catch((e) => {
    console.error('[stack] view failed', pr.id, e);
    return null;
  });
  const pullState = await pullStateFor(db, git, pr, {
    shas: target,
    reviewConfigured: reviewConfigured(c.env),
  });
  return c.json(
    {
      pull: serializePull(pr, people, await pullSessionId(pr), comments.length),
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
      rebase,
      review,
      canMerge: c.get('perms').write,
      approvals: approvals.map((a) => ({
        user: people.get(a.userId) ?? ghost,
        createdAt: a.createdAt.toISOString(),
        via: a.via,
      })),
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
  if (patch.state === 'closed') {
    // Children stacked on its branch go back to the land target; a reconcile restacks them.
    c.executionCtx.waitUntil(onPullClosed(c.env, c.get('db'), pr, 'closed'));
    // The agents whose change requests on it were dismissed learn from them.
    c.executionCtx.waitUntil(queueLessons(c.env, c.get('db'), pr));
  }
  if (patch.state === 'open') {
    // A reopened PR rebases onto everything that landed while it was closed.
    const shas = await landShas(c.get('git'), pr);
    c.executionCtx.waitUntil(
      ensureRebase(c.env, c.get('db'), c.get('git'), { ...pr, state: 'open' })
    );
    if (shas)
      c.executionCtx.waitUntil(
        ensureHeadReview(
          c.env,
          c.get('db'),
          { ...pr, state: 'open' },
          shas
        ).catch((e) => console.error('[review] start failed', e))
      );
    // Its pairs were kept while it was closed: discovery checks what changed since, and a reconcile restacks
    // the land target with it back in.
    if (shas)
      c.executionCtx.waitUntil(
        ensureStacking(
          c.env,
          c.get('db'),
          c.get('git'),
          { ...pr, state: 'open' },
          shas
        ).catch((e) => console.error('[stack] start failed', e))
      );
    c.executionCtx.waitUntil(
      startReconcile(c.env, pr.repositoryId, landTargetOf(pr))
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
    (
      await compareShas(c.get('git'), shas.base, shas.head, {
        mergeability: false,
      })
    ).files,
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
            /** Approve the head commit as you merge it (a recorded approval; needs merge permission). */
            approve: z.boolean().optional(),
            /** The head commit you reviewed (and, with `approve`, approve); 409 if the branch has moved since. */
            headSha: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(
      z.object({ sha: z.string() }),
      'Merged: the target branch is now at sha'
    ),
    ...json400Response,
    ...json403Response,
    ...json404Response,
    409: {
      content: {
        'application/json': {
          schema: z.object({
            error: z.string(),
            /** Which gate refused it. */
            reason: z
              .enum(['stack', 'checks', 'review', 'rebase', 'paused'])
              .optional(),
            /**
             * Set when landing rebased the branch and pushed this new head first, then stopped for its checks or
             * review: not a failure; it lands once they pass (on its own with auto-merge, else merge again).
             */
            rebased: z.string().optional(),
          }),
        },
      },
      description:
        'Refused (or rebased first, and waiting for checks or review)',
    },
  },
});
pullsRouter.openapi(mergeRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to merge' }, 403);
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const body = c.req.valid('json');
  const user = c.get('user')!;
  if (body.approve) {
    // This request lands the pull request itself: no auto-merge race, and it is merged by this person. A
    // refused merge below keeps the approval: it is this person's decision about this commit.
    const approved = await approvePull(
      c.env,
      c.get('db'),
      c.get('git'),
      pr,
      user.id,
      (work) => c.executionCtx.waitUntil(work),
      { followUps: false, expectedHead: body.headSha }
    );
    if (!approved.ok) return c.json({ error: approved.error }, approved.status);
  }
  const result = await landPull({
    env: c.env,
    db: c.get('db'),
    repo: c.get('repo'),
    repoFullName: fullName(c),
    git: c.get('git'),
    pr,
    by: user,
    expectedHead: body.headSha,
    after: (work) => c.executionCtx.waitUntil(work),
  });
  if (!result.ok) {
    if (body.approve) {
      // The approval stands though the merge was refused: open pages and the pull request's state catch up
      // (a refusal skips the ping that follows successful changes). It lands once whatever refused it clears:
      // on its own where agents review, else by a later click.
      c.executionCtx.waitUntil(
        publishChange(c.env, pr.repositoryId, { approvals: true })
      );
      c.executionCtx.waitUntil(
        settleStates(c.env, c.get('db'), pr.repositoryId)
      );
    }
    if (result.status === 400) return c.json({ error: result.error }, 400);
    return c.json(
      {
        error: result.error,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.rebased ? { rebased: result.rebased } : {}),
      },
      409
    );
  }
  return c.json({ sha: result.sha }, 200);
});

const retryRebaseRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/rebase',
  tags: ['Pull requests'],
  summary: 'Try a stopped rebase again',
  description:
    'Sets aside where the rebase stopped (rebase_conflict: AI could not resolve a commit, too many commits for AI, ' +
    'and the like) and starts a rebase run, which asks AI again. Needs merge permission. 409 when nothing is ' +
    'stopped, or for a branch GitOrange never rebases ("Not rebased: ...").',
  request: { params: numberParams },
  responses: {
    ...json200Response(
      rebaseViewSchema,
      'The rebase is starting over: where the pull request now stands'
    ),
    ...json403Response,
    ...json404Response,
    ...json409Response,
  },
});
pullsRouter.openapi(retryRebaseRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to do that' }, 403);
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const result = await retryRebase(c.env, c.get('db'), c.get('git'), pr);
  if (!result.ok) return c.json({ error: result.error }, 409);
  return c.json(result.view, 200);
});

// ── revert ───────────────────────────────────────────────────────────────────

const revertRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/revert',
  tags: ['Pull requests'],
  summary: 'Revert a merged pull request',
  description:
    'Opens a pull request ("Revert #n: <title>", authored by you) that undoes the commits this one landed, on top of its target as it is now, from a new branch `revert-<n>`. It never pushes to the target: the revert is reviewed and lands like any other change. Needs push access. 409 `{ message }` when it is not merged, or does not revert cleanly.',
  request: { params: numberParams },
  responses: {
    ...json201Response(
      z.object({ number: z.number() }),
      'The revert pull request'
    ),
    ...json403Response,
    ...json404Response,
    409: {
      content: {
        'application/json': {
          schema: z.object({
            message: z.string(),
            /** The same text, as every other error carries it. */
            error: z.string(),
          }),
        },
      },
      description: 'Not merged, or it does not revert cleanly',
    },
  },
});
pullsRouter.openapi(revertRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have push access' }, 403);
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const result = await revertPull({
    env: c.env,
    db: c.get('db'),
    git: c.get('git'),
    repo: c.get('repo'),
    repoFullName: fullName(c),
    pr,
    user: c.get('user')!,
    after: (work) => c.executionCtx.waitUntil(work),
  });
  if (!result.ok)
    return c.json({ message: result.message, error: result.message }, 409);
  return c.json({ number: result.pr.number }, 201);
});

// ── a person's approval ──────────────────────────────────────────────────────

const approvalResponses = {
  ...json200Response(
    z.object({ ok: z.literal(true), headSha: z.string() }),
    'The head commit is approved (or no longer approved by you)'
  ),
  ...json400Response,
  ...json403Response,
  ...json404Response,
};

const approveRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/approval',
  tags: ['Pull requests'],
  request: {
    params: numberParams,
    body: {
      required: false,
      content: {
        'application/json': {
          schema: z.object({
            /** The head commit you reviewed; 409 if the branch has moved since. */
            headSha: z.string().optional(),
          }),
        },
      },
    },
  },
  // Approving a head the person didn't see is refused (409); withdrawing never is.
  responses: { ...approvalResponses, ...json409Response },
});
pullsRouter.openapi(approveRoute, async (c) => {
  // Approving lets a pull request land, so it takes merge permission (agents never hold a session).
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to approve' }, 403);
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  // The body is optional: no JSON body approves whatever the head is now.
  const body = (c.req.valid('json') ?? {}) as { headSha?: string };
  const result = await approvePull(
    c.env,
    c.get('db'),
    c.get('git'),
    pr,
    c.get('user')!.id,
    (work) => c.executionCtx.waitUntil(work),
    { expectedHead: body.headSha }
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true as const, headSha: result.headSha }, 200);
});

const withdrawRoute = createRoute({
  method: 'delete',
  path: '/{owner}/{repo}/pulls/{number}/approval',
  tags: ['Pull requests'],
  request: { params: numberParams },
  responses: approvalResponses,
});
pullsRouter.openapi(withdrawRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to approve' }, 403);
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const result = await withdrawApproval(
    c.env,
    c.get('db'),
    c.get('git'),
    pr,
    c.get('user')!.id,
    (work) => c.executionCtx.waitUntil(work)
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true as const, headSha: result.headSha }, 200);
});

// ── review findings ──────────────────────────────────────────────────────────

const flagParams = numberParams.extend({ flagId: z.string() });

/** A rule refused it: a guarded agent's finding without a reason, GitOrange AI and a guarded agent, an assignee. */
const json422Response = {
  422: {
    content: { 'application/json': { schema: errorSchema } },
    description: 'Refused by a rule',
  },
};

const teachField = z
  .string()
  .max(TEACH_NOTE_MAX)
  .nullable()
  .optional()
  .openapi({
    description:
      'A rule for the agent in your words; it learns it when the pull request closes. Undoing the decision drops it.',
  });

const approveFlagRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/review/flags/{flagId}/approve',
  tags: ['Pull requests'],
  summary: "Approve a finding (or dismiss an agent's change request)",
  description:
    "Needs push rights. A guarded agent's finding (Security, Data, or `guarded: true`) needs a `reason` (422 " +
    'without one); it is recorded in the audit log with your name.',
  request: {
    params: flagParams,
    body: {
      required: false,
      content: {
        'application/json': {
          schema: z.object({
            reason: z.string().max(DECISION_REASON_MAX).nullable().optional(),
            teach: teachField,
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), 'Approved'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
    ...json409Response,
    ...json422Response,
  },
});
pullsRouter.openapi(approveFlagRoute, async (c) => {
  // Approving clears a pull request for auto-merge, so it takes merge permission.
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to approve' }, 403);
  const { number, flagId } = c.req.valid('param');
  const pr = await getPull(c, number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  // The body is optional: no JSON body approves with no reason or teach note.
  const body = (c.req.valid('json') ?? {}) as {
    reason?: string | null;
    teach?: string | null;
  };
  const result = await decideFlag(
    c.env,
    c.get('db'),
    pr,
    flagId,
    c.get('user')!.id,
    { kind: 'approve', reason: body.reason, teach: body.teach },
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
            teach: teachField,
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
    ...json409Response,
    ...json422Response,
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
  const body = c.req.valid('json');
  const result = await decideFlag(
    c.env,
    c.get('db'),
    pr,
    flagId,
    c.get('user')!.id,
    { kind: 'request_changes', note: body.note, teach: body.teach },
    (work) => c.executionCtx.waitUntil(work)
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true as const }, 200);
});

const assignFlagRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/review/flags/{flagId}/assign',
  tags: ['Pull requests'],
  summary: 'Ask someone to decide a finding',
  description:
    'Needs push rights, and so does the person asked (422 otherwise, or for a reviewer agent). `login: null` clears it.',
  request: {
    params: flagParams,
    body: {
      content: {
        'application/json': {
          schema: z.object({ login: z.string().min(1).max(100).nullable() }),
        },
      },
    },
  },
  responses: {
    ...json200Response(
      z.object({ ok: z.literal(true), assignee: personRefSchema.nullable() }),
      'Assigned (or cleared)'
    ),
    ...json400Response,
    ...json403Response,
    ...json404Response,
    ...json422Response,
  },
});
pullsRouter.openapi(assignFlagRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to do that' }, 403);
  const { number, flagId } = c.req.valid('param');
  const pr = await getPull(c, number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const result = await assignFlag(
    c.get('db'),
    { repo: c.get('repo'), fullName: fullName(c) },
    pr,
    flagId,
    c.get('user')!.id,
    c.req.valid('json').login
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true as const, assignee: result.assignee }, 200);
});

const undoFlagRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/review/flags/{flagId}/undo',
  tags: ['Pull requests'],
  summary: 'Undo your decision on a finding',
  description:
    'Reopens an approval, dismissal or request for changes you made (or GitOrange AI made for you), with its ' +
    "reason and teach note, while the pull request is open (409 after it merged or closed). 403 for anyone else's.",
  request: { params: flagParams },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), 'Reopened'),
    ...json403Response,
    ...json404Response,
    ...json409Response,
  },
});
pullsRouter.openapi(undoFlagRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to do that' }, 403);
  const { number, flagId } = c.req.valid('param');
  const pr = await getPull(c, number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const result = await undoFlag(
    c.env,
    c.get('db'),
    pr,
    flagId,
    c.get('user')!.id,
    (work) => c.executionCtx.waitUntil(work)
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true as const }, 200);
});

const delegateFlagRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/review/flags/{flagId}/delegate',
  tags: ['Pull requests'],
  summary: 'Let GitOrange AI decide a finding now',
  description:
    "GitOrange AI decides one finding for a person as you, with the instance's reasoning model: approve, request " +
    'changes (its reason is the note), or leave it for you with a reason (always, where no model is set up). ' +
    'Recorded via "GitOrange AI" and undoable while the pull request is open. Never a guarded agent\'s finding ' +
    "(422) or an agent's own change request (400). Needs push rights.",
  request: { params: flagParams },
  responses: {
    ...json200Response(
      z.object({
        decision: z.enum(['approve', 'request_changes', 'leave']),
        reason: z.string(),
        /** False when it left the finding for you. */
        applied: z.boolean(),
      }),
      'What GitOrange AI decided'
    ),
    ...json400Response,
    ...json403Response,
    ...json404Response,
    ...json409Response,
    ...json422Response,
  },
});
pullsRouter.openapi(delegateFlagRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to do that' }, 403);
  const { number, flagId } = c.req.valid('param');
  const pr = await getPull(c, number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const result = await decideFinding(
    c.env,
    c.get('db'),
    flagId,
    c.get('user')!.id,
    {
      after: (work) => c.executionCtx.waitUntil(work),
      pullRequestId: pr.id,
    }
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(
    {
      decision: result.decision,
      reason: result.reason,
      applied: result.applied,
    },
    200
  );
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
  const shas = pr.state === 'open' ? await landShas(c.get('git'), pr) : null;
  if (!shas)
    return c.json({ error: 'Only open pull requests are reviewed' }, 400);
  const result = await retryHeadReview(c.env, c.get('db'), pr, shas);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true as const }, 200);
});

const reviewerParams = numberParams.extend({ reviewerId: z.string() });

const retryReviewerRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/reviewers/{reviewerId}/retry',
  tags: ['Pull requests'],
  request: { params: reviewerParams },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), 'Review restarted'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
    503: {
      description: 'The review could not be started',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});
pullsRouter.openapi(retryReviewerRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to do that' }, 403);
  const { number, reviewerId } = c.req.valid('param');
  const pr = await getPull(c, number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  const result = await retryReviewer(
    c.env,
    c.get('db'),
    pr,
    reviewerId,
    await c.get('git').resolve(pr.headRef),
    (work) => c.executionCtx.waitUntil(work)
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
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
  const shas = await landShas(c.get('git'), pr);
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

const unstackRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/stack/unstack',
  tags: ['Pull requests'],
  request: { params: numberParams },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), 'Unstacked'),
    ...json400Response,
    ...json403Response,
    ...json404Response,
  },
});
pullsRouter.openapi(unstackRoute, async (c) => {
  // A maintainer's decision, like approving a flag: merge permission, and never offered to agents (no MCP tool).
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to do that' }, 403);
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr || pr.state !== 'open') return c.json({ error: 'Not Found' }, 404);
  let parent = (await stackViewFor(c.get('db'), c.get('git'), pr))?.parent
    ?.number;
  if (!parent && pr.baseRef !== landTargetOf(pr)) {
    // Its edge may already be dismissed (an earlier attempt crashed before retargeting): it still sits on the
    // parent's branch, so finish the retarget.
    const head = await c
      .get('db')
      .select({ number: pullRequests.number })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, pr.repositoryId),
          eq(pullRequests.state, 'open'),
          eq(pullRequests.headRef, pr.baseRef)
        )
      )
      .get();
    parent = head?.number;
  }
  if (!parent)
    return c.json({ error: 'This pull request is not stacked' }, 400);
  await dismissEdge(c.env, c.get('db'), pr, parent, c.get('user')!.id);
  return c.json({ ok: true as const }, 200);
});

const dismissRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/pulls/{number}/stack/dismiss',
  tags: ['Pull requests'],
  request: {
    params: numberParams,
    body: {
      content: {
        'application/json': {
          schema: z.object({ pr: z.number().int().min(1) }),
        },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ ok: z.literal(true) }), 'Dismissed'),
    ...json403Response,
    ...json404Response,
  },
});
pullsRouter.openapi(dismissRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have permission to do that' }, 403);
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr || pr.state !== 'open') return c.json({ error: 'Not Found' }, 404);
  const result = await dismissEdge(
    c.env,
    c.get('db'),
    pr,
    c.req.valid('json').pr,
    c.get('user')!.id
  );
  if (result === 'not_found')
    return c.json({ error: 'No dependency on that pull request' }, 404);
  return c.json({ ok: true as const }, 200);
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
