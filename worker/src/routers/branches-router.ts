import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import {
  MAP_DAYS_DEFAULT,
  MAP_DAYS_MAX,
  branchInfos,
  branchMap,
  cleanBranches,
} from '../lib/branches';
import { loadRepo, type RepoEnv } from '../lib/repos';
import {
  json200Response,
  json400Response,
  json403Response,
  json404Response,
  validationHook,
} from './openapi-helpers';
import { personRefSchema } from './sessions-router';
import { ownerRepoParams, pullStateSchema } from './schemas';

// Branches (worker/src/lib/branches.ts): the list, one-click clean-up of merged branches nobody deleted, and the model
// behind the branch map. Deleting one branch is DELETE /branches?name= in repos-router.ts.

const branchInfoSchema = z
  .object({
    name: z.string(),
    sha: z.string(),
    isDefault: z.boolean(),
    /** The default branch and every branch matching the repository's protected patterns. */
    isProtected: z.boolean(),
    /** When the tip commit was committed, epoch milliseconds; null when it can't be read. */
    updatedAt: z.number().nullable(),
    /** Whoever opened its pull request, else the member whose email is on the tip commit. */
    author: personRefSchema.nullable(),
    /** The branch's newest pull request, whatever its state. */
    pull: z
      .object({
        number: z.number(),
        title: z.string(),
        state: z.enum(['open', 'closed', 'merged']),
        /** Whose move it is; null unless the pull request is open. */
        pullState: pullStateSchema.nullable(),
        /** The app that opened it; null means by hand. */
        createdVia: z.string().nullable(),
        session: z.string().nullable(),
      })
      .nullable(),
    /** Its newest pull request is merged and the branch is still there (never the default or a protected branch). */
    mergedNotDeleted: z.boolean(),
  })
  .openapi('BranchInfo');

const branchMapSchema = z
  .object({
    /** The window, epoch milliseconds. */
    from: z.number(),
    to: z.number(),
    main: z.object({
      name: z.string(),
      /** From the latest Actions runs on the default branch. */
      status: z.enum(['passing', 'failing', 'running', 'unknown']),
      /** Pull requests merged into it in the window, oldest first. */
      landings: z.array(
        z.object({
          number: z.number(),
          title: z.string(),
          at: z.number(),
          sha: z.string(),
        })
      ),
    }),
    /** Open pull requests into the default branch, oldest first. */
    open: z.array(
      z.object({
        branch: z.string(),
        number: z.number(),
        title: z.string(),
        openedAt: z.number(),
        state: z.enum(['agent_followup', 'human_review', 'waiting', 'ready']),
        /** The kinds of the reasons it is in that state. */
        reasons: z.array(z.string()),
        author: personRefSchema,
        createdVia: z.string().nullable(),
        session: z.string().nullable(),
        /** The pull request whose branch this one is based on, when stacked. */
        stackedOn: z.number().nullable(),
      })
    ),
    /** Merged branches nobody deleted, oldest merge first. */
    leftover: z.array(
      z.object({ branch: z.string(), number: z.number(), mergedAt: z.number() })
    ),
  })
  .openapi('BranchMap');

export const branchesRouter = new OpenAPIHono<RepoEnv>({
  defaultHook: validationHook,
});
// Only these routes: the other repository routers load the repository for their own paths.
branchesRouter.use('/:owner/:repo/branches', loadRepo);
branchesRouter.use('/:owner/:repo/branches/*', loadRepo);

const listRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/branches',
  tags: ['Branches'],
  summary: 'Branches',
  description:
    'Every branch with its tip, flags and newest pull request, by name. `mergedNotDeleted` marks branches whose newest pull request merged but that are still here.',
  request: { params: ownerRepoParams },
  responses: {
    ...json200Response(z.array(branchInfoSchema), 'Branches'),
    ...json404Response,
  },
});
branchesRouter.openapi(listRoute, async (c) =>
  c.json(
    await branchInfos(c.env, c.get('db'), c.get('git'), c.get('repo')),
    200
  )
);

const cleanRoute = createRoute({
  method: 'post',
  path: '/{owner}/{repo}/branches/clean',
  tags: ['Branches'],
  summary: 'Delete merged branches',
  description:
    'Deletes every merged, not deleted branch: never the default branch, a protected branch, or one an open pull request uses. Needs push access. Recorded in the audit log as one `branches.cleaned` event.',
  request: { params: ownerRepoParams },
  responses: {
    ...json200Response(
      z.object({ deleted: z.array(z.string()) }),
      'The branches deleted'
    ),
    ...json403Response,
    ...json404Response,
  },
});
branchesRouter.openapi(cleanRoute, async (c) => {
  if (!c.get('perms').write)
    return c.json({ error: 'You do not have push access' }, 403);
  const deleted = await cleanBranches(
    c.get('db'),
    c.get('git'),
    c.get('repo'),
    c.get('user')!.id
  );
  return c.json({ deleted }, 200);
});

const mapRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/branches/map',
  tags: ['Branches'],
  summary: 'Branch map',
  description:
    'What the branch map draws: the default branch with what landed on it in the last `days` days, the open pull requests into it, and merged branches nobody deleted.',
  request: {
    params: ownerRepoParams,
    query: z.object({
      days: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAP_DAYS_MAX)
        .default(MAP_DAYS_DEFAULT)
        .openapi({
          description: `How many days back landings reach (default ${MAP_DAYS_DEFAULT}, at most ${MAP_DAYS_MAX}).`,
        }),
    }),
  },
  responses: {
    ...json200Response(branchMapSchema, 'The branch map'),
    ...json400Response,
    ...json404Response,
  },
});
branchesRouter.openapi(mapRoute, async (c) =>
  c.json(
    await branchMap(
      c.env,
      c.get('db'),
      c.get('git'),
      c.get('repo'),
      c.req.valid('query').days
    ),
    200
  )
);
