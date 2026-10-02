#!/usr/bin/env node
/**
 * Regenerate worker/worker-configuration.d.ts from wrangler.jsonc.ci so the tracked types
 * file only reflects placeholder values, never a deployer's local (gitignored) wrangler.jsonc.
 *
 * `wrangler types --config` still reads wrangler.jsonc from the cwd for its runtime-types
 * phase, so swap the CI config into place, run it, then restore the local file. A crash leaves
 * the original at .wrangler.jsonc.local-backup for manual recovery.
 */
import { copyFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const LOCAL = 'wrangler.jsonc';
const CI = 'wrangler.jsonc.ci';
const BACKUP = '.wrangler.jsonc.local-backup';

if (!existsSync(CI)) {
  console.error(`cf-typegen: ${CI} is missing`);
  process.exit(1);
}
if (existsSync(BACKUP)) {
  console.error(
    `cf-typegen: ${BACKUP} already exists — a previous run crashed. ` +
      `Restore it to ${LOCAL} or delete it, then retry.`
  );
  process.exit(1);
}

const hadLocal = existsSync(LOCAL);
if (hadLocal) renameSync(LOCAL, BACKUP);

let exitCode = 0;
try {
  copyFileSync(CI, LOCAL);
  const result = spawnSync(
    'yarn',
    [
      'wrangler',
      'types',
      'worker/worker-configuration.d.ts',
      '--env-interface',
      'CloudflareBindings',
    ],
    { stdio: 'inherit' }
  );
  exitCode = result.status ?? 1;
} finally {
  if (hadLocal) renameSync(BACKUP, LOCAL);
  else if (existsSync(LOCAL)) unlinkSync(LOCAL);
}

process.exit(exitCode);
