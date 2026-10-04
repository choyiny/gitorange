import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { logger } from 'hono/logger';
import { createAuth } from './auth';
import { requireAuth } from './auth/guards';
import { injectDb } from './db/middleware';
import { handleGitRequest, isGitRequest } from './git-http';
import { handleLfsRequest, isLfsRequest } from './lfs-http';
import { invitesRouter } from './routers/invites-router';
import { actionsRouter } from './routers/actions-router';
import { pullsRouter } from './routers/pulls-router';
import { reposRouter } from './routers/repos-router';
import { setupRouter } from './routers/setup-router';
import { tokensRouter } from './routers/tokens-router';
import { usersRouter } from './routers/users-router';
import { namespacesRouter, teamRouter } from './routers/teams-router';
import { mcpApiRouter, mcpRouter } from './mcp';
import { wellKnownRouter } from './mcp/well-known';
import type { AppEnv } from './variables';
import type { Context, MiddlewareHandler } from 'hono';
import type { RepoEnv } from './lib/repos';
import { publishChange } from './live/publish';
import { liveSocket } from './live/route';
import { approvalsRouter } from './routers/approvals-router';

const app = new OpenAPIHono<AppEnv>();

app.use('*', injectDb);
app.use('*', logger());
app.use('*', async (c, next) => {
  const auth = createAuth(c.env);
  c.set('auth', auth);
  // The MCP endpoint and OAuth discovery authenticate with bearer tokens, never cookies.
  const p = c.req.path;
  if (p === '/mcp' || p.startsWith('/.well-known/')) return next();
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session?.user) c.set('user', session.user as AppEnv['Variables']['user']);
  await next();
});

app.on(['GET', 'POST'], '/api/auth/*', (c) => c.get('auth').handler(c.req.raw));

// OAuth discovery and the MCP server (bearer-token auth, see worker/src/mcp)
app.route('/', wellKnownRouter);
app.route('/mcp', mcpRouter);

// Public
app.route('/api/setup', setupRouter);
app.route('/api/invites', invitesRouter);

// Members only
app.use('/api/repos/*', requireAuth);
app.use('/api/repos', requireAuth);
// Every successful change to a repository pings its open pages (and approval inboxes, for pull
// request changes), so they update without a reload.
const pingAfterChange: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (c.req.method === 'GET' || c.res.status >= 400) return;
  const repo = (c as unknown as Context<RepoEnv>).get('repo');
  if (repo)
    c.executionCtx.waitUntil(
      publishChange(c.env, repo.id, {
        approvals: c.req.path.includes('/pulls'),
      })
    );
};
app.use('/api/repos/:owner/:repo', pingAfterChange);
app.use('/api/repos/:owner/:repo/*', pingAfterChange);
app.use('/api/approvals', requireAuth);
app.route('/api/approvals', approvalsRouter);
app.use('/api/live', requireAuth);
app.get('/api/live', liveSocket);
app.route('/api/repos', reposRouter);
app.route('/api/repos', pullsRouter);
app.route('/api/repos', actionsRouter);
app.use('/api/users/*', requireAuth);
app.use('/api/users', requireAuth);
app.route('/api/users', usersRouter);
app.use('/api/team', requireAuth);
app.route('/api/team', teamRouter);
app.use('/api/namespaces/*', requireAuth);
app.route('/api/namespaces', namespacesRouter);
app.use('/api/mcp/*', requireAuth);
app.use('/api/mcp', requireAuth);
app.route('/api/mcp', mcpApiRouter);
app.use('/api/tokens/*', requireAuth);
app.use('/api/tokens', requireAuth);
app.route('/api/tokens', tokensRouter);

app.doc('/api/doc', {
  openapi: '3.0.0',
  info: {
    version: '1.0.0',
    title: 'GitOrange',
    description: 'Single-tenant git hosting on Cloudflare Artifacts',
  },
});
app.get('/api/swagger-ui', swaggerUI({ url: '/api/doc' }));

app.onError((err, c) => {
  console.error('[api] unhandled', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});
app.notFound((c) => c.json({ error: 'Not Found' }, 404));

export { app };
export { ActionsRun } from './actions/run-workflow';
export { JobRunner } from './actions/job-runner';
export { MergeResolver } from './merge/resolver';
export { MergeResolutionWorkflow } from './merge/workflow';
export { LiveHub } from './live/hub';

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (isGitRequest(url)) return handleGitRequest(request, env, ctx);
    if (isLfsRequest(url)) return handleLfsRequest(request, env, ctx);
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<CloudflareBindings>;
