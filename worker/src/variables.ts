import type { DrizzleDB } from './db/middleware';
import type { createAuth } from './auth';

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  username?: string | null;
  role?: string | null;
  image?: string | null;
  banned?: boolean | null;
};

export type Variables = {
  db: DrizzleDB;
  auth: ReturnType<typeof createAuth>;
  user?: SessionUser;
};

export type AppEnv = { Bindings: CloudflareBindings; Variables: Variables };
