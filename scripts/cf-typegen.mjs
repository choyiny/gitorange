#!/usr/bin/env node
/**
 * Regenerates worker/worker-configuration.d.ts from wrangler.jsonc.ci, not the local config.
 * `wrangler types` still reads ./wrangler.jsonc, so the CI config is swapped in and the local one
 * restored after (a crash leaves it at .wrangler.jsonc.local-backup).
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
