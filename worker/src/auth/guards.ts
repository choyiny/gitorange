import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../variables';

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user || user.banned) return c.json({ error: 'Unauthorized' }, 401);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user || user.banned) return c.json({ error: 'Unauthorized' }, 401);
  if (user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);
  await next();
};
