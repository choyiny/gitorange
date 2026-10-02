import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Tests run inside the real workerd runtime via Miniflare against a real D1.
 * Paths are relative to the REPO ROOT: the script is `vitest run --config worker/vitest.config.ts`.
 */
const d1Migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        bindings: {
          TEST_D1_MIGRATIONS: d1Migrations,
          BETTER_AUTH_SECRET: 'test-secret-not-used-in-any-real-deployment',
          // Fake R2 S3 credentials: pre-signing is pure HMAC, so tests can check URLs offline.
          R2_ACCESS_KEY_ID: 'test-access-key-id',
          R2_SECRET_ACCESS_KEY: 'test-secret-access-key',
        },
      },
    }),
  ],
  test: {
    // Worker suites, plus pure-logic SPA modules (no DOM) such as the syntax highlighter.
    include: ['worker/src/__tests__/**/*.test.ts', 'src/lib/**/*.test.ts'],
    setupFiles: ['./worker/test/setup.ts'],
  },
});
