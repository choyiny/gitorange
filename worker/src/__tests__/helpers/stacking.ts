/** Shared fixtures for the stacking tests (stacking-discovery and stacking-landing). */
import { expect } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../../db/schema';
import type { StepRunner } from '../../merge/resolution';
import { executeClassification } from '../../review/classify';
import {
  autoResolveConflicts,
  executeSweep,
  type SweepParams,
} from '../../merge/auto';
import type { ClassifierAnswer, Repository } from '../../db/app.schema';
import type { ReviewModels } from '../../review/models';
import { executeStacking, type StackParams } from '../../stack/discover';
import { executeReconcile, type ReconcileParams } from '../../stack/reconcile';
import type {
  DecideInput,
  ExplainInput,
  PrSide,
  Recheck,
  RecheckInput,
  Relation,
  StackModels,
} from '../../stack/models';
import { bootstrapAdmin, call, makeEnv, settle, type TestEnv } from './app';
import { commitPaths } from './seed';

// Checks are required (and none ever run), so auto-merge waits and the PRs stay open.
export const POLICY = (extra = '') => `
model: clef
checks:
  require: all
${extra}`;

/** The #28/#29 shape: a config file and docs on main. */
export const MAIN = {
  'src/config.ts': 'export const vars = ["BASE_URL"];\n',
  'docs/configuration.md': '# Configuration\n\n- BASE_URL\n',
  'notes.txt': 'one\ntwo\nthree\n',
};

export const step = {
  do: async (_name: string, a: unknown, b?: unknown) =>
    ((b ?? a) as () => Promise<unknown>)(),
  // Durable sleeps (the conflict sweep's settle delay) pass instantly.
  sleep: async () => {},
} as unknown as StepRunner;

export const reviewModels: ReviewModels = {
  summarize: async (f) => `Changes ${f.path}.`,
  classify: async () => ({}),
  investigate: async () => ({
    detail: '',
    diagram: null,
    snippets: [],
    paths: [],
  }),
};

/** `triaged`: what Clef was asked; `related`: what the reasoning model was asked. */
export type StackCalls = {
  triaged: DecideInput[];
  related: ExplainInput[];
  rechecked: RecheckInput[];
  ordered: number;
};

export const CONFLICT: Relation = {
  kind: 'conflicts',
  prerequisite: 'a',
  reason: 'Both edit notes.txt.',
  instructions: null,
};

/**
 * Fake models. Clef answers "related" from `related`, and kind/prerequisite from `relation` with `confidence`;
 * the reasoning model answers `explainAs` (default: the same relation).
 */
export function stackModels(
  opts: {
    related?: (i: DecideInput) => boolean;
    relation?: (i: { a: PrSide; b: PrSide }) => Relation;
    confidence?: number;
    explainAs?: Relation;
    failTriage?: boolean;
    recheck?: (i: RecheckInput) => Recheck | Promise<Recheck>;
    order?: () =>
      | Record<string, ClassifierAnswer>
      | Promise<Record<string, ClassifierAnswer>>;
  } = {}
): { models: StackModels; calls: StackCalls } {
  const calls: StackCalls = {
    triaged: [],
    related: [],
    rechecked: [],
    ordered: 0,
  };
  const confidence = opts.confidence ?? 0.9;
  return {
    calls,
    models: {
      decide: async (_model, i) => {
        if (opts.failTriage) throw new Error('model down');
        calls.triaged.push(i);
        const rel = opts.relation?.(i) ?? CONFLICT;
        return {
          related: { type: 'noul', value: opts.related?.(i) ? 0.9 : 0.05 },
          kind: {
            type: 'choice',
            value: rel.kind,
            confidence,
            probabilities: { [rel.kind]: confidence },
          },
          prerequisite: {
            type: 'choice',
            value: rel.prerequisite ?? 'a',
            confidence,
            probabilities: { [rel.prerequisite ?? 'a']: confidence },
          },
        };
      },
      explain: async (i) => {
        calls.related.push(i);
        const rel = opts.explainAs ?? opts.relation?.(i) ?? CONFLICT;
        return i.decided ? { ...rel, ...i.decided } : rel;
      },
      recheck: async (i) => {
        calls.rechecked.push(i);
        return (
          (await opts.recheck?.(i)) ?? {
            accounted: false,
            reason: 'Not yet.',
            instructions: 'Still add the check.',
          }
        );
      },
      order: async () => {
        calls.ordered++;
        return (
          (await opts.order?.()) ?? {
            first: {
              type: 'choice',
              value: 'a',
              confidence: 0.9,
              probabilities: { a: 0.9 },
            },
          }
        );
      },
    },
  };
}

/** Runs every review, sweep and stack Workflow started so far (once each), until none are left. */
export const ran = new WeakMap<TestEnv, Set<string>>();
export async function drain(
  t: TestEnv,
  models: StackModels,
  stackStep: StepRunner = step
) {
  const db = drizzle(t.env.DB, { schema });
  const done = ran.get(t) ?? new Set<string>();
  ran.set(t, done);
  for (;;) {
    await settle(t);
    const next = t.actions.resolutions.find((s) => !done.has(s.id));
    if (!next) return;
    done.add(next.id);
    const p = next.params as {
      classificationId?: string;
      sweep?: SweepParams;
      stack?: StackParams;
      reconcile?: ReconcileParams;
    };
    if (p.classificationId)
      await executeClassification(
        { env: t.env, db, step, models: reviewModels },
        p.classificationId
      );
    else if (p.sweep) await executeSweep({ env: t.env, db, step }, p.sweep);
    else if (p.stack)
      await executeStacking(
        { env: t.env, db, step: stackStep, models },
        p.stack
      );
    else if (p.reconcile)
      await executeReconcile({ env: t.env, db, step, models }, p.reconcile);
  }
}

/** A repository with `review.yml` on main (none when `policy` is null), and helpers to open PRs from branches off main. */
export async function repoWithPolicy(
  policy: string | null = POLICY(),
  visibility: 'private' | 'internal' = 'private'
) {
  const t = makeEnv({ actions: true });
  const admin = await bootstrapAdmin(t);
  await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility },
  });
  const repo = [...t.fake.repos.values()][0];
  const files: Record<string, string> =
    policy === null
      ? { ...MAIN }
      : { ...MAIN, '.gitorange/review.yml': policy };
  const main = await commitPaths(repo, 'main', files, 'base');
  async function open(
    branch: string,
    changes: Record<string, string>,
    title: string
  ) {
    repo.refs.set(`refs/heads/${branch}`, main);
    await commitPaths(repo, branch, { ...files, ...changes }, title);
    const res = await call(t, '/api/repos/octocat/app/pulls', {
      cookie: admin,
      json: { title, body: `${title}.`, base: 'main', head: branch },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { number: number }).number;
  }
  return { t, admin, repo, open, files };
}

/** Pushes `files` to `branch` and starts the sweep a push starts. */
export async function pushTo(
  t: TestEnv,
  repo: Parameters<typeof commitPaths>[0],
  branch: string,
  files: Record<string, string>
) {
  const old = repo.refs.get(`refs/heads/${branch}`)!;
  await commitPaths(repo, branch, files, `Update ${branch}`);
  const row = await t.env.DB.prepare(
    "SELECT id FROM repositories WHERE name = 'app'"
  ).first<{ id: string }>();
  await autoResolveConflicts(t.env, { id: row!.id } as Repository, [
    {
      ref: `refs/heads/${branch}`,
      old,
      new: repo.refs.get(`refs/heads/${branch}`)!,
    },
  ]);
}

export async function events(t: TestEnv, number: number) {
  return (
    await t.env.DB.prepare(
      `SELECT e.kind, e.data FROM pr_events e JOIN pull_requests p ON p.id = e.pull_request_id
        WHERE p.number = ? AND e.kind <> 'state_changed' ORDER BY e.created_at, e.rowid`
    )
      .bind(number)
      .all<{ kind: string; data: string }>()
  ).results.map((r) => ({ kind: r.kind, data: JSON.parse(r.data) }));
}

export async function edges(t: TestEnv) {
  const { results } = await t.env.DB.prepare(
    `SELECT a.number AS a, b.number AS b, e.stage, e.kind, e.prerequisite, e.reason,
            e.instructions, e.conflict_files AS conflictFiles
       FROM pr_edges e
       JOIN pull_requests a ON a.id = e.pr_a_id
       JOIN pull_requests b ON b.id = e.pr_b_id
      ORDER BY a.number, b.number`
  ).all<Record<string, unknown>>();
  return results;
}

export const SETUP_CHECKS = {
  'src/setup-checks.ts':
    'import { vars } from "./config";\nexport const checks = vars.map(check);\n',
  'docs/configuration.md':
    '# Configuration\n\nEvery variable needs a setup check.\n\n- BASE_URL\n',
};
export const USAGE = {
  'src/usage.ts': 'export const token = env.CF_ANALYTICS_TOKEN;\n',
  'src/config.ts': 'export const vars = ["BASE_URL", "CF_ANALYTICS_TOKEN"];\n',
};
export const MUST: Relation = {
  kind: 'must_account_for',
  prerequisite: 'a',
  reason:
    '#1 adds a setup check per config variable; this adds CF_ANALYTICS_TOKEN without one.',
  instructions:
    'Rebase onto setup-checks and add a check for CF_ANALYTICS_TOKEN.',
};
