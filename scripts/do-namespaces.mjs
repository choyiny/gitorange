#!/usr/bin/env node
// Fills in the Durable Object namespace IDs that Site admin → Usage & cost needs, from the deployed Worker.
//
//   node scripts/do-namespaces.mjs           # print them
//   node scripts/do-namespaces.mjs --write   # also write them into wrangler.jsonc's top-level vars
//
// Reads account_id and the Worker name from ./wrangler.jsonc and lists the account's Durable Object namespaces with
// wrangler's own login (`wrangler auth token`), so there is no extra token to create. Run it after the first
// `yarn deploy` (the namespaces exist only once the Worker does), then deploy again.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const VARS = {
  JobRunner: 'JOB_RUNNER_NAMESPACE_ID',
  MergeResolver: 'MERGE_RESOLVER_NAMESPACE_ID',
  AgentReviewer: 'AGENT_REVIEWER_NAMESPACE_ID',
  LiveHub: 'LIVE_NAMESPACE_ID',
};

const file = 'wrangler.jsonc';
const config = fs.readFileSync(file, 'utf8');
const account = config.match(/"account_id"\s*:\s*"([0-9a-f]{32})"/)?.[1];
const worker = config.match(/^\s*"name"\s*:\s*"([^"]+)"/m)?.[1];
if (!account || !worker) {
  console.error(`${file} needs a real account_id and name first.`);
  process.exit(1);
}

const token = execFileSync('yarn', ['-s', 'wrangler', 'auth', 'token'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .pop();
const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/workers/durable_objects/namespaces?per_page=1000`,
  { headers: { Authorization: `Bearer ${token}` } }
);
const body = await res.json();
if (!body.success) {
  console.error(
    'Listing Durable Object namespaces failed:',
    body.errors?.map((e) => e.message).join('; ')
  );
  process.exit(1);
}

const found = {};
for (const ns of body.result ?? [])
  if (ns.script === worker && VARS[ns.class]) found[VARS[ns.class]] = ns.id;
const missing = Object.values(VARS).filter((v) => !found[v]);
for (const [v, id] of Object.entries(found)) console.log(`${v}=${id}`);
if (missing.length)
  console.error(
    `Not found for worker "${worker}" (deploy it first?): ${missing.join(', ')}`
  );

if (process.argv.includes('--write')) {
  // Only the top-level (production) vars: the first occurrence of each key, which comes before "env".
  let out = config;
  for (const [v, id] of Object.entries(found))
    out = out.replace(new RegExp(`("${v}"\\s*:\\s*)"[^"]*"`), `$1"${id}"`);
  fs.writeFileSync(file, out);
  console.log(
    `Wrote ${Object.keys(found).length} namespace IDs into ${file}. Run yarn deploy to apply them.`
  );
}
if (missing.length) process.exit(1);
