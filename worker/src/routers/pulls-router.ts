import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  pullRequestComments,
  pullRequests,
  repositories,
  type PullRequest,
} from '../db/app.schema';
import { MergeConflictError, type GitService } from '../git/service';
import { GitPushError } from '../git/remote';
import { loadRepo, type RepoEnv } from '../lib/repos';
import { usersById, type PublicUser } from '../lib/users';
import {
  json200Response,
  json201Response,
  json400Response,
  json403Response,
  json404Response,
  json409Response,
  validationHook,
} from './openapi-helpers';
import {
  commitSchema,
  fileDiffSchema,
  ownerRepoParams,
  publicUserSchema,
} from './schemas';
import { compareShas } from './repos-router';

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
    mergedAt: pr.mergedAt?.toISOString() ?? null,
    closedAt: pr.closedAt?.toISOString() ?? null,
    createdAt: pr.createdAt.toISOString(),
    updatedAt: pr.updatedAt.toISOString(),
    commentCount,
  };
}

const pullRef = (n: number) => `refs/pull/${n}/head`;

/**
 * The two commits a PR compares. Open PRs track their live branches; once merged or
 * closed, the head is pinned at refs/pull/N/head so the diff survives branch deletion.
 */
async function pullShas(
  git: GitService,
  pr: PullRequest
): Promise<{ base: string; head: string } | null> {
  if (pr.state === 'merged' && pr.mergeCommitSha) {
    const merge = await git.commit(pr.mergeCommitSha);
    const head = (await git.resolve(pullRef(pr.number))) ?? merge?.parents[1];
    if (!merge || !head) return null;
    return { base: merge.parents[0], head };
  }
  const head =
    pr.state === 'open'
      ? await git.resolve(pr.headRef)
      : ((await git.resolve(pullRef(pr.number))) ??
        (await git.resolve(pr.headRef)));
  const base = await git.resolve(pr.baseRef);
  return head && base ? { base, head } : null;
}

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
    query: z.object({ state: z.enum(['open', 'closed']).default('open') }),
  },
  responses: {
    ...json200Response(
      z.object({
        pulls: z.array(pullSchema),
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
        state === 'open'
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
  return c.json(
    {
      pulls: rows.map((r) => serializePull(r.pr, people, Number(r.comments))),
      openCount: count('open'),
      closedCount: count('closed') + count('merged'),
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
  const git = c.get('git');
  const repo = c.get('repo');
  const body = c.req.valid('json');
  if (body.base === body.head)
    return c.json({ error: 'Base and head must be different branches' }, 400);
  // Both sides must be branch names: resolve() also accepts SHAs and tags, and a merge
  // pushes to refs/heads/<base>, so a non-branch base would create a stray branch.
  const refs = await git.refs();
  const baseSha = refs.get(`refs/heads/${body.base}`);
  const headSha = refs.get(`refs/heads/${body.head}`);
  if (!baseSha || !headSha) return c.json({ error: 'Branch not found' }, 400);
  if ((await git.mergeBase(baseSha, headSha)) === headSha) {
    return c.json(
      {
        error: `There isn't anything to compare. ${body.base} is up to date with ${body.head}.`,
      },
      400
    );
  }
  const existing = await db
    .select({ number: pullRequests.number })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repo.id),
        eq(pullRequests.state, 'open'),
        eq(pullRequests.baseRef, body.base),
        eq(pullRequests.headRef, body.head)
      )
    )
    .get();
  if (existing)
    return c.json(
      {
        error: `A pull request already exists for ${body.head} (#${existing.number}).`,
      },
      409
    );

  // Claim the next number atomically: the bump and the insert share one batch, and the
  // insert reads the number the bump just reserved.
  const id = crypto.randomUUID();
  const now = new Date();
  const author = c.get('user')!;
  await db.batch([
    db
      .update(repositories)
      .set({
        nextPrNumber: sql`${repositories.nextPrNumber} + 1`,
        updatedAt: now,
      })
      .where(eq(repositories.id, repo.id)),
    db.insert(pullRequests).values({
      id,
      repositoryId: repo.id,
      number:
        sql`(SELECT next_pr_number - 1 FROM repositories WHERE id = ${repo.id})` as unknown as number,
      title: body.title.trim(),
      body: body.body,
      authorId: author.id,
      baseRef: body.base,
      headRef: body.head,
      state: 'open',
      createdAt: now,
      updatedAt: now,
    }),
  ]);
  const pr = (await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.id, id))
    .get())!;
  await git
    .setRef(pullRef(pr.number), headSha)
    .catch((e) => console.error('[pulls] pin ref failed', e));
  return c.json(serializePull(pr, await usersById(db, [author.id])), 201);
});

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
        canMerge: z.boolean(),
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
  const people = await usersById(db, [
    pr.authorId,
    pr.mergedById ?? '',
    ...comments.map((x) => x.authorId),
  ]);
  const [shas, headLive] = await Promise.all([
    pullShas(git, pr),
    git.resolve(pr.headRef),
  ]);
  let mergeable: boolean | null = null;
  let conflicts: string[] = [];
  let commitCount = 0;
  if (shas) {
    const commits = await git.commitsBetween(shas.base, shas.head);
    commitCount = commits.length;
    if (pr.state === 'open') {
      const plan = await git.planMerge(shas.base, shas.head);
      mergeable = !plan.upToDate && plan.conflicts.length === 0;
      conflicts = plan.upToDate ? [] : plan.conflicts;
    }
  }
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
      canMerge: c.get('perms').write,
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
  return c.json(await c.get('git').commitsBetween(shas.base, shas.head), 200);
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
            method: z.enum(['merge', 'squash']).default('merge'),
            title: z.string().max(256).optional(),
            message: z.string().max(65536).optional(),
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
  const db = c.get('db');
  const pr = await getPull(c, c.req.valid('param').number);
  if (!pr) return c.json({ error: 'Not Found' }, 404);
  if (pr.state !== 'open')
    return c.json({ error: 'Pull request is not open' }, 400);
  const body = c.req.valid('json');
  const user = c.get('user')!;
  const owner = c.get('repoOwner');
  const git = c.get('git');
  const headSha = await git.resolve(pr.headRef);
  if (!headSha)
    return c.json({ error: 'The head branch no longer exists' }, 400);
  const title =
    body.title?.trim() ||
    (body.method === 'squash'
      ? `${pr.title} (#${pr.number})`
      : `Merge pull request #${pr.number} from ${owner.username}/${pr.headRef}`);
  const message = body.message ?? (body.method === 'squash' ? '' : pr.title);
  let sha: string;
  try {
    ({ sha } = await git.merge({
      base: pr.baseRef,
      head: pr.headRef,
      method: body.method,
      message: message ? `${title}\n\n${message}` : title,
      author: {
        name: user.name,
        email: user.email,
        timestamp: Math.floor(Date.now() / 1000),
      },
      extraRefs: [{ ref: pullRef(pr.number), sha: headSha }],
    }));
  } catch (e) {
    if (e instanceof MergeConflictError)
      return c.json({ error: e.message }, 409);
    if (e instanceof GitPushError)
      return c.json(
        { error: 'Base branch was modified. Review and try the merge again.' },
        409
      );
    return c.json(
      { error: e instanceof Error ? e.message : 'Merge failed' },
      400
    );
  }
  const now = new Date();
  // The git push is the commit point; record it only after it succeeded.
  await db
    .update(pullRequests)
    .set({
      state: 'merged',
      mergeCommitSha: sha,
      mergedById: user.id,
      mergedAt: now,
      closedAt: now,
      updatedAt: now,
    })
    .where(eq(pullRequests.id, pr.id));
  await db
    .update(repositories)
    .set({ updatedAt: now })
    .where(eq(repositories.id, pr.repositoryId));
  return c.json({ sha }, 200);
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
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    pullRequestId: pr.id,
    authorId: user.id,
    body: c.req.valid('json').body,
    createdAt: now,
    updatedAt: now,
  };
  await c
    .get('db')
    .batch([
      c.get('db').insert(pullRequestComments).values(row),
      c
        .get('db')
        .update(pullRequests)
        .set({ updatedAt: now })
        .where(eq(pullRequests.id, pr.id)),
    ]);
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
