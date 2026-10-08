/** Rebase fixtures: a pull request whose base moved, running queued sweeps and rebase runs inline, conflict rows. */
import { expect } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../../db/schema';
import type { Repository } from '../../db/app.schema';
import { executeSweep, startSweep, type SweepParams } from '../../merge/auto';
import { executeRebase, type RebaseParams } from '../../merge/rebase';
import type { StepRunner } from '../../merge/resolution';
import type {
  ConflictResolverApi,
  ResolveRequest,
  ResolveResult,
} from '../../merge/resolver';
import { bootstrapAdmin, call, makeEnv, settle, type TestEnv } from './app';
import { commitFiles } from './seed';

export const step = {
  do: async (_name: string, a: unknown, b?: unknown) =>
    ((b ?? a) as () => Promise<unknown>)(),
  sleep: async () => {},
} as unknown as StepRunner;

/** A step runner that records step names and can act before a step runs (`before(name)`). */
export function namedSteps(before?: (name: string) => Promise<void> | void) {
  const names: string[] = [];
  const runner = {
    do: async (name: string, a: unknown, b?: unknown) => {
      names.push(name);
      await before?.(name);
      return ((b ?? a) as () => Promise<unknown>)();
    },
    sleep: async () => {},
  } as unknown as StepRunner;
  return { names, step: runner };
}

/** A resolver answering `answer(request, id)` (default: done, no files), recording each request. */
export function fakeResolver(
  answer?: (
    req: ResolveRequest,
    id: string
  ) => Partial<ResolveResult> | Promise<Partial<ResolveResult>>
) {
  const requests: { id: string; request: ResolveRequest }[] = [];
  const resolver = (id: string): ConflictResolverApi => ({
    resolve: async (request) => {
      requests.push({ id, request });
      return {
        status: 'done',
        explanation: 'Kept both.',
        files: {},
        transcript: '[]',
        ...(await answer?.(request, id)),
      };
    },
  });
  return { resolver, requests };
}

const ranSweeps = new WeakMap<TestEnv, Set<string>>();
/** Runs every sweep started so far (once each). */
export async function runSweeps(t: TestEnv) {
  const db = drizzle(t.env.DB, { schema });
  const done = ranSweeps.get(t) ?? new Set<string>();
  ranSweeps.set(t, done);
  for (;;) {
    await settle(t);
    const next = t.actions.resolutions.find(
      (s) => !done.has(s.id) && (s.params as { sweep?: SweepParams }).sweep
    );
    if (!next) return;
    done.add(next.id);
    await executeSweep(
      { env: t.env, db, step },
      (next.params as { sweep: SweepParams }).sweep
    );
  }
}

const ranRebases = new WeakMap<TestEnv, Set<string>>();
/** Runs every sweep and rebase run started so far (once each), until none are left; returns how many rebases ran. */
export async function runRebases(
  t: TestEnv,
  opts: {
    resolver?: (id: string) => ConflictResolverApi;
    step?: StepRunner;
  } = {}
) {
  const db = drizzle(t.env.DB, { schema });
  const done = ranRebases.get(t) ?? new Set<string>();
  ranRebases.set(t, done);
  let n = 0;
  for (;;) {
    // A written rebase starts a sweep (its own new head; pull requests stacked on its branch): run it first.
    await runSweeps(t);
    const next = t.actions.resolutions.find(
      (s) => !done.has(s.id) && (s.params as { rebase?: RebaseParams }).rebase
    );
    if (!next) return n;
    done.add(next.id);
    n++;
    await executeRebase(
      {
        env: t.env,
        db,
        step: opts.step ?? step,
        resolver: opts.resolver,
        instanceId: next.id,
      },
      (next.params as { rebase: RebaseParams }).rebase
    );
  }
}

/** Starts the sweep a push of `branch` (from `old`) starts, and runs it. */
export async function moved(t: TestEnv, branch: string, old: string) {
  const repo = [...t.fake.repos.values()][0];
  const id = (await t.env.DB.prepare(
    "SELECT id FROM repositories WHERE name = 'app'"
  ).first<{ id: string }>())!.id;
  await startSweep(t.env, { id } as Repository, [
    {
      ref: `refs/heads/${branch}`,
      old,
      new: repo.refs.get(`refs/heads/${branch}`)!,
    },
  ]);
  await runSweeps(t);
}

export type ResolutionRow = {
  id: string;
  commit: string | null;
  status: string;
  model: string;
  paths: string;
  error: string | null;
  base: string;
  head: string;
  result: string | null;
  files: string | null;
};

/** Every merge_resolutions row, oldest first. */
export async function rows(t: TestEnv): Promise<ResolutionRow[]> {
  return (
    await t.env.DB.prepare(
      `SELECT id, commit_sha AS "commit", status, model, conflicted_paths AS paths, error_message AS error,
              base_sha AS base, head_sha AS head, result_sha AS result, resolved_files AS files
         FROM merge_resolutions ORDER BY created_at, rowid`
    ).all<ResolutionRow>()
  ).results;
}

export const NOTES = 'one\ntwo\nthree\nfour\nfive\n';

/**
 * octocat/app: `notes.txt` on main; PR #1 from `feature` with two commits (`Add b`, then `Elaborate on three`, which
 * changes line three); then main moves: line three changes too (`conflict`), or `other.txt` is added. Not swept yet.
 */
export async function divergedPull(opts: { conflict?: boolean } = {}) {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'internal' },
  });
  const repo = [...t.fake.repos.values()][0];
  const root = await commitFiles(repo, 'main', { 'notes.txt': NOTES }, 'base');
  const f1 = await commitFiles(
    repo,
    'feature',
    { 'notes.txt': NOTES, 'b.txt': 'b\n' },
    'Add b',
    [root]
  );
  const f2 = await commitFiles(
    repo,
    'feature',
    {
      'notes.txt': NOTES.replace('three', 'three, and a half'),
      'b.txt': 'b\n',
    },
    'Elaborate on three'
  );
  const res = await call(t, '/api/repos/octocat/app/pulls', {
    cookie: admin,
    json: {
      title: 'Elaborate',
      body: 'Line three needs more detail.',
      base: 'main',
      head: 'feature',
    },
  });
  expect(res.status).toBe(201);
  await settle(t);
  const tip = await commitFiles(
    repo,
    'main',
    opts.conflict
      ? { 'notes.txt': NOTES.replace('three', 'THREE (main)') }
      : { 'notes.txt': NOTES, 'other.txt': 'x\n' },
    'Main moves'
  );
  return { t, admin, repo, root, f1, f2, tip };
}

export type Detail = {
  mergeable: boolean | null;
  rebase: {
    status: string;
    onto: string;
    commit: string | null;
    files: string[];
    error: string | null;
  } | null;
  pullState: {
    state: string;
    reasons: { kind: string; [k: string]: unknown }[];
  } | null;
};

/** The pull request page's data. */
export async function detail(
  t: TestEnv,
  cookie: string,
  n = 1
): Promise<Detail> {
  return (await (
    await call(t, `/api/repos/octocat/app/pulls/${n}`, { cookie })
  ).json()) as Detail;
}
