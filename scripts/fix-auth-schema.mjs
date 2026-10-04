#!/usr/bin/env node
/**
 * Post-processes the generated auth.schema.ts: better-auth CLI 1.7 emits an untypeable
 * `.default()` for empty-array defaults (`clientCredentialsScopes`); the column has none, so
 * it is dropped.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'worker/src/db/auth.schema.ts';
const src = readFileSync(FILE, 'utf8');
const fixed = src.replace(/\)\s*\.default\(\)/g, ')');
if (fixed !== src) writeFileSync(FILE, fixed);
