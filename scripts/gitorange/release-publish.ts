import { join } from 'node:path';
import type { Runner } from './runner.ts';

export const NPM_REGISTRY = 'https://registry.npmjs.org/gitorange';

/** The version of a plain `vX.Y.Z` tag; anything else is a usage error. */
export function checkTag(tag: string): string {
  const m = /^v(\d+\.\d+\.\d+)$/.exec(tag ?? '');
  if (!m) throw new Error('Usage: yarn release:publish vX.Y.Z');
  return m[1];
}

/**
 * Refuses, in order: a tag missing on `origin`, a tag whose commit is not on origin's main, a
 * version already on npm. Git runs with `-C <repo>` only and fetches into `refs/release-publish/`,
 * so the working copy and the operator's branches are never touched.
 */
export async function preflight(o: {
  tag: string;
  repo: string;
  fetchImpl: typeof fetch;
  runner: Runner;
}): Promise<{ commit: string }> {
  const version = checkTag(o.tag);
  const git = (...args: string[]) =>
    o.runner.run('git', ['-C', o.repo, ...args]);
  const ls = await git('ls-remote', '--tags', 'origin', `refs/tags/${o.tag}`);
  if (ls.code !== 0 || !ls.stdout.trim()) {
    throw new Error(
      `Tag ${o.tag} is missing on origin. Push it first (git push origin ${o.tag}).`
    );
  }
  const fetched = await git(
    'fetch',
    '--quiet',
    'origin',
    '+refs/heads/main:refs/release-publish/main',
    `+refs/tags/${o.tag}:refs/release-publish/tag`
  );
  if (fetched.code !== 0) {
    throw new Error(`Could not fetch main and ${o.tag} from origin.`);
  }
  const ancestor = await git(
    'merge-base',
    '--is-ancestor',
    'refs/release-publish/tag',
    'refs/release-publish/main'
  );
  if (ancestor.code !== 0) {
    throw new Error(
      `Tag ${o.tag} is not on main; publish only releases cut in GitOrange.`
    );
  }
  const npm = await o.fetchImpl(`${NPM_REGISTRY}/${version}`);
  if (npm.status === 200) {
    throw new Error(`gitorange@${version} is already on npm.`);
  }
  const rev = await git('rev-parse', 'refs/release-publish/tag^{commit}');
  const commit = rev.stdout.trim();
  if (rev.code !== 0 || !commit) {
    throw new Error(`Could not resolve ${o.tag} to a commit.`);
  }
  return { commit };
}

/** The build checks out the commit preflight verified, never a local tag of the same name. */
export function worktreeAddArgs(
  repo: string,
  dir: string,
  commit: string
): string[] {
  return ['-C', repo, 'worktree', 'add', '--detach', dir, commit];
}

export type SmokeStep = { cmd: string; args: string[]; cwd: string };

/**
 * CI's Package job, for the packed build in `pkgDir`: pack the tarball, render an install's config
 * for it (smoke-config.ts), dry-run deploy it with the worktree's pinned wrangler (no Docker:
 * `--containers-rollout=none`), and install the tarball in a fresh directory. `help` then runs the
 * installed CLI. Argv only, never a shell. Everything it writes is under `scratch`.
 */
export function packageSmoke(o: {
  worktree: string;
  pkgDir: string;
  scratch: string;
  name: string;
  version: string;
  node: string;
}): { tarball: string; steps: SmokeStep[]; help: SmokeStep } {
  const pkg = join(o.scratch, 'pkg');
  const smoke = join(o.scratch, 'smoke');
  const app = join(o.scratch, 'app');
  // npm pack names an unscoped package's tarball <name>-<version>.tgz.
  const tarball = join(pkg, `${o.name}-${o.version}.tgz`);
  const wt = o.worktree;
  return {
    tarball,
    steps: [
      {
        cmd: 'npm',
        args: ['pack', o.pkgDir, '--pack-destination', pkg],
        cwd: wt,
      },
      {
        cmd: o.node,
        args: ['scripts/gitorange/smoke-config.ts', o.pkgDir, smoke],
        cwd: wt,
      },
      {
        cmd: o.node,
        args: [
          join(wt, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
          'deploy',
          '--dry-run',
          '--containers-rollout=none',
          '--outdir',
          join(o.scratch, 'o'),
          '--config',
          join(smoke, 'wrangler.jsonc'),
        ],
        cwd: wt,
      },
      { cmd: 'npm', args: ['init', '-y'], cwd: app },
      { cmd: 'npm', args: ['install', tarball], cwd: app },
    ],
    help: {
      cmd: join(app, 'node_modules', '.bin', 'gitorange'),
      args: ['--help'],
      cwd: app,
    },
  };
}

/** The commands `gitorange --help` must list (as CI checks: a line starting `  <command> `). */
export const HELP_COMMANDS = ['install', 'upgrade', 'adopt', 'status'];

export const missingCommands = (help: string): string[] =>
  HELP_COMMANDS.filter((c) => !new RegExp(`^  ${c} `, 'm').test(help));
