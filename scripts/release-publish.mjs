// Publishes a GitOrange release to npm from this machine:
//   yarn release:publish vX.Y.Z
// Builds from a throwaway worktree of the tag, never the working copy. The tag must be on origin's main. npm asks for the 2FA code itself.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  checkTag,
  preflight,
  worktreeAddArgs,
} from './gitorange/release-publish.ts';
import { processRunner } from './gitorange/runner.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function step(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
}

function walk(dir) {
  let files = 0;
  let bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const s = walk(p);
      files += s.files;
      bytes += s.bytes;
    } else {
      files++;
      bytes += statSync(p).size;
    }
  }
  return { files, bytes };
}

async function main() {
  const tag = process.argv[2];
  const version = checkTag(tag);
  const { commit } = await preflight({
    tag,
    repo: REPO,
    fetchImpl: fetch,
    runner: processRunner,
  });
  const tmp = mkdtempSync(join(tmpdir(), 'gitorange-release-'));
  try {
    execFileSync('git', worktreeAddArgs(REPO, tmp, commit), {
      stdio: 'inherit',
    });
    step('yarn', ['install', '--frozen-lockfile'], tmp);
    step(
      'yarn',
      ['vitest', 'run', '--config', 'scripts/gitorange/vitest.config.ts'],
      tmp
    );
    const out = join(tmp, 'build', 'npm');
    step(
      'node',
      ['scripts/gitorange/pack.mjs', '--out', out, '--version', version],
      tmp
    );
    const { files, bytes } = walk(out);
    const name = JSON.parse(
      readFileSync(join(out, 'package.json'), 'utf8')
    ).name;
    console.log(
      `\n${name}@${version}\ncommit ${commit}\n${files} files, ${(bytes / 1048576).toFixed(1)} MB`
    );
    console.log("Publish only tags cut in GitOrange's Releases tab.");
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await rl.question(`Publish gitorange@${version}? (y/N) `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Not published.');
      return;
    }
    step('npm', ['publish', out, '--access', 'public'], tmp);
    console.log(`Published gitorange@${version}.`);
  } finally {
    spawnSync('git', ['-C', REPO, 'worktree', 'remove', '--force', tmp], {
      stdio: 'ignore',
    });
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
