import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

// Isolated per-file storage means every test file starts from an empty D1.
await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);

// Storage is shared between tests within a file, so start each test from empty tables.
// Children before parents so foreign keys never block the delete.
const TABLES = [
  'oauth_client_assertions',
  'oauth_access_tokens',
  'oauth_refresh_tokens',
  'oauth_consents',
  'oauth_client_resources',
  'oauth_clients',
  'oauth_resources',
  'jwkss',
  'workflow_steps',
  'workflow_jobs',
  'workflow_runs',
  'merge_resolutions',
  'lfs_objects',
  'pull_request_comments',
  'pull_requests',
  'repository_collaborators',
  'repositories',
  'teams',
  'personal_access_tokens',
  'invitations',
  'sessions',
  'accounts',
  'verifications',
  'users',
  'rate_limits',
];
beforeEach(async () => {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
