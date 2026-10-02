#!/usr/bin/env node
/**
 * Post-processes worker/src/db/auth.schema.ts after `yarn auth:generate`.
 *
 * The better-auth CLI (1.7) renders a column whose default is an empty array (oauth-provider's
 * `clientCredentialsScopes`) as `.default()`, which doesn't typecheck. The database column has no
 * default either way, so the call is dropped. Remove this step once the CLI is fixed.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'worker/src/db/auth.schema.ts';
const src = readFileSync(FILE, 'utf8');
const fixed = src.replace(/\)\s*\.default\(\)/g, ')');
if (fixed !== src) writeFileSync(FILE, fixed);
