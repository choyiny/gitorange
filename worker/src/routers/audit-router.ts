import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { requireAdmin } from '../auth/guards';
import {
  AUDIT_PAGE_DEFAULT,
  AUDIT_PAGE_MAX,
  decodeCursor,
  listAudit,
} from '../lib/audit';
import { loadRepo, type RepoEnv } from '../lib/repos';
import type { AppEnv } from '../variables';
import {
  json200Response,
  json400Response,
  json403Response,
  json404Response,
  validationHook,
} from './openapi-helpers';
import { auditPageSchema, ownerRepoParams } from './schemas';

// The audit log (worker/src/lib/audit.ts): a repository's, for anyone who can read the repository, and the whole
// instance's, for site admins.

const pageQuery = z.object({
  cursor: z
    .string()
    .refine((s) => decodeCursor(s) !== null, {
      message: 'is not a cursor this log handed out',
    })
    .optional()
    .openapi({ description: 'The previous page’s nextCursor.' }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(AUDIT_PAGE_MAX)
    .optional()
    .openapi({
      description: `Events per page (default ${AUDIT_PAGE_DEFAULT}).`,
    }),
});

// ── /api/repos/{owner}/{repo}/audit ──────────────────────────────────────────

export const repoAuditRouter = new OpenAPIHono<RepoEnv>({
  defaultHook: validationHook,
});
// Only this route: the other repository routers load the repository for their own paths.
repoAuditRouter.use('/:owner/:repo/audit', loadRepo);

const repoAuditRoute = createRoute({
  method: 'get',
  path: '/{owner}/{repo}/audit',
  tags: ['Audit'],
  request: { params: ownerRepoParams, query: pageQuery },
  responses: {
    ...json200Response(
      auditPageSchema,
      'The repository’s audit log and pull request events, newest first'
    ),
    ...json400Response,
    ...json404Response,
  },
});
repoAuditRouter.openapi(repoAuditRoute, async (c) => {
  const { cursor, limit } = c.req.valid('query');
  return c.json(
    await listAudit(c.get('db'), {
      repositoryId: c.get('repo').id,
      cursor,
      limit,
    }),
    200
  );
});

// ── /api/admin/audit ─────────────────────────────────────────────────────────

export const adminAuditRouter = new OpenAPIHono<AppEnv>({
  defaultHook: validationHook,
});
adminAuditRouter.use('*', requireAdmin);

const adminAuditRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Audit'],
  request: { query: pageQuery },
  responses: {
    ...json200Response(
      auditPageSchema,
      'Every repository’s audit log and pull request events, plus instance events, newest first'
    ),
    ...json400Response,
    ...json403Response,
  },
});
adminAuditRouter.openapi(adminAuditRoute, async (c) => {
  const { cursor, limit } = c.req.valid('query');
  return c.json(
    await listAudit(c.get('db'), { repositoryId: null, cursor, limit }),
    200
  );
});
