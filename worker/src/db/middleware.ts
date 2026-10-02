import type { Context, Next } from 'hono';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { schema } from './schema';

export type DrizzleDB = DrizzleD1Database<typeof schema>;

export async function injectDb(
  c: Context<{ Bindings: CloudflareBindings; Variables: { db: DrizzleDB } }>,
  next: Next
) {
  c.set('db', drizzle(c.env.DB, { schema }));
  return next();
}
