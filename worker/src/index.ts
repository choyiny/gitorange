import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { logger } from 'hono/logger';
import { createAuth } from './auth';
import { requireAuth } from './auth/guards';
import { injectDb } from './db/middleware';
import { handleGitRequest, isGitRequest } from './git-http';
import { invitesRouter } from './routers/invites-router';
import { pullsRouter } from './routers/pulls-router';
import { reposRouter } from './routers/repos-router';
import { setupRouter } from './routers/setup-router';
import { tokensRouter } from './routers/tokens-router';
import { usersRouter } from './routers/users-router';
import type { AppEnv } from './variables';

const app = new OpenAPIHono<AppEnv>();

app.use('*', injectDb);
app.use('*', logger());
app.use('*', async (c, next) => {
  const auth = createAuth(c.env);
  c.set('auth', auth);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session?.user) c.set('user', session.user as AppEnv['Variables']['user']);
  await next();
});

app.on(['GET', 'POST'], '/api/auth/*', (c) => c.get('auth').handler(c.req.raw));

// Public
app.route('/api/setup', setupRouter);
app.route('/api/invites', invitesRouter);

// Members only
app.use('/api/repos/*', requireAuth);
app.use('/api/repos', requireAuth);
app.route('/api/repos', reposRouter);
app.route('/api/repos', pullsRouter);
app.use('/api/users/*', requireAuth);
app.use('/api/users', requireAuth);
app.route('/api/users', usersRouter);
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

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (isGitRequest(url)) return handleGitRequest(request, env, ctx);
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<CloudflareBindings>;
