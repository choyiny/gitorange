import { defineConfig } from 'drizzle-kit';
import fs from 'fs';
import path from 'path';

function getLocalD1DB(): string | undefined {
  const base = path.resolve('.wrangler');
  if (!fs.existsSync(base)) return undefined;
  const files = (fs.readdirSync(base, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => path.join(base, f))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return files[0];
}

const local = getLocalD1DB();

export default defineConfig({
  dialect: 'sqlite',
  schema: './worker/src/db/index.ts',
  out: './migrations',
  ...(process.env.NODE_ENV === 'production'
    ? {
        driver: 'd1-http',
        dbCredentials: {
          accountId: process.env.CLOUDFLARE_D1_ACCOUNT_ID!,
          databaseId: process.env.CLOUDFLARE_DATABASE_ID!,
          token: process.env.CLOUDFLARE_D1_API_TOKEN!,
        },
      }
    : local
      ? { dbCredentials: { url: local } }
      : {}),
});
