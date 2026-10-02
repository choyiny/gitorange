import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_D1_MIGRATIONS: D1Migration[];
      BETTER_AUTH_SECRET: string;
    }
  }
}
