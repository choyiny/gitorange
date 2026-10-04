import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

// Idempotent: with shared storage only the first test file applies them.
await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);

// Test files share one worker and its storage (`--no-isolate`): empty every table before each
// test. Read from the schema so new tables are never missed; foreign keys are checked at commit.
const TABLES = (
  await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'"
  ).all<{ name: string }>()
).results.map((r) => r.name);
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('PRAGMA defer_foreign_keys = on'),
    ...TABLES.map((t) => env.DB.prepare(`DELETE FROM "${t}"`)),
  ]);
});
