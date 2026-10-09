import { and, asc, desc, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
  agents,
  prReviewers,
  pullRequests,
  repositories,
  repositoryAgents,
  type PullRequest,
  type Repository,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import { agentColor } from '../agents/presets';
import type { GitService } from '../git/service';
import { latestStates } from '../pulls/events';
import { pullStates } from '../pulls/signals';
import type { PullState, ReasonKind } from '../pulls/state';
import { reviewConfigured } from '../review/head';
import {
  currentStatus,
  lastUtcDays,
  newestPerPull,
  type AgentStatus,
} from './agent-stats';
import { gitFor } from './repos';

// The numbers on each repository card of the Repositories board (`GET /api/repos?stats=1`): what is open and whose
// move it is, what merged this week, which agents review it, how many branches it has, and its language.

export type RepoStats = {
  pulls: {
    open: number;
    needsPerson: number;
    changesRequested: number;
    checking: number;
    queued: number;
  };
  /** Pull requests merged in the last seven UTC days (today and the six before it). */
  merged7d: number;
  /** Merges per UTC day over those seven days, oldest first, today last. */
  mergedByDay: number[];
  /** The share of merged7d that GitOrange merged on its own, 0 to 100; null when nothing merged. */
  mergedAutomaticallyPct: number | null;
  /** The agents invited to review it, and what each is doing. */
  agents: {
    handle: string;
    name: string;
    color: string;
    status: AgentStatus;
  }[];
  /** Branches in the repository; null when its refs could not be read. */
  branchCount: number | null;
  /** The language most of its source files are written in; null when it has none (or none known yet). */
  language: string | null;
  /** When it last changed (a push or a settings change), epoch milliseconds. */
  updatedAt: number;
};

// ── Pull request buckets ─────────────────────────────────────────────────────

export type PullBucket =
  'needsPerson' | 'changesRequested' | 'checking' | 'queued';

/** Waiting reasons that mean something is running: checks, an agent's review, a rebase resolution or a stack check. */
const RUNNING: ReadonlySet<ReasonKind> = new Set([
  'checks_running',
  'agent_reviewing',
  'resolution_running',
  'stack_checking',
]);

/**
 * Which count of the board an open pull request falls in, from its computed state (`pullState`, never stored):
 *  - `human_review`: a person's move, so `needsPerson`;
 *  - `agent_followup`: its author's agent has changes to make (failed checks, requested changes, a rebase
 *    conflict), so `changesRequested`;
 *  - `waiting` because checks or reviews are running, so `checking`;
 *  - `ready`, or `waiting` on its order or on other pull requests (a rebase onto its parent, a paused queue),
 *    so `queued`: it is in the line to merge.
 */
export function pullBucket(s: PullState): PullBucket {
  switch (s.state) {
    case 'human_review':
      return 'needsPerson';
    case 'agent_followup':
      return 'changesRequested';
    case 'waiting':
      return s.reasons.some((r) => RUNNING.has(r.kind)) ? 'checking' : 'queued';
    case 'ready':
      return 'queued';
  }
}

// ── Language ─────────────────────────────────────────────────────────────────

/** Source file extensions (lowercase, no dot) and the language they are written in. */
const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  swift: 'Swift',
  rb: 'Ruby',
  php: 'PHP',
  c: 'C',
  h: 'C',
  cc: 'C++',
  cpp: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  cs: 'C#',
  scala: 'Scala',
  dart: 'Dart',
  lua: 'Lua',
  ex: 'Elixir',
  exs: 'Elixir',
  hs: 'Haskell',
  clj: 'Clojure',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  sql: 'SQL',
  html: 'HTML',
  htm: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  vue: 'Vue',
  svelte: 'Svelte',
  astro: 'Astro',
  md: 'Markdown',
  mdx: 'Markdown',
};
/** Prose: the answer only when the repository has no code at all (an agent's repository is all Markdown). */
const PROSE = new Set(['Markdown']);
/** Directories whose files are somebody else's code or build output. */
const SKIPPED_DIRS = new Set([
  'node_modules',
  'vendor',
  'third_party',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.next',
  '.git',
]);
/** The most trees read, and entries looked at, in one repository: past them the walk answers with what it saw. */
const MAX_TREES = 120;
const MAX_ENTRIES = 20_000;

/**
 * The language of the most source files in the tree of `commitSha`, read breadth first within a budget, ignoring
 * vendored and generated directories; Markdown only when nothing else is there. Null when there are no known source
 * files. Throws when the commit can't be read.
 */
export async function detectLanguage(
  git: GitService,
  commitSha: string
): Promise<string | null> {
  const commit = await git.commit(commitSha);
  if (!commit) throw new Error(`The commit ${commitSha.slice(0, 7)} is gone.`);
  const counts = new Map<string, number>();
  const queue = [commit.treeHash];
  let trees = 0;
  let entries = 0;
  for (let hash = queue.shift(); hash; hash = queue.shift()) {
    if (trees++ >= MAX_TREES) break;
    for (const e of await git.tree(hash)) {
      if (entries++ >= MAX_ENTRIES) {
        queue.length = 0;
        break;
      }
      if (e.mode === '40000' || e.mode === '040000') {
        if (!SKIPPED_DIRS.has(e.name)) queue.push(e.hash);
        continue;
      }
      const dot = e.name.lastIndexOf('.');
      const language =
        dot > 0 ? LANGUAGES[e.name.slice(dot + 1).toLowerCase()] : undefined;
      if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
    }
  }
  const ranked = [...counts]
    .filter(([language]) => !PROSE.has(language))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length) return ranked[0][0];
  return counts.size
    ? [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    : null;
}

// ── Stats ────────────────────────────────────────────────────────────────────

/** Runs `fn` over `items`, at most `limit` at a time; results in order. */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++)
        out[i] = await fn(items[i]);
    })
  );
  return out;
}

/** Repositories read from Artifacts at once: each needs its refs, and maybe its tree. */
const CONCURRENT_REPOSITORIES = 4;

/**
 * The board's stats for `repos` (which the caller already filtered to what the viewer can see), keyed by repository id.
 * D1 is read once for all of them (open pull requests, merges, agents, reviews); Artifacts once per repository for its
 * refs, from which come the branch count, each pull request's state (`pullStates`, batched for the whole repository:
 * never per pull request) and whether the language is out of date. When the refs can't be read, the states come from the
 * ones last recorded (`latestStates`) and the branch count is null.
 */
export async function repoStats(
  env: CloudflareBindings,
  db: DrizzleDB,
  repos: Repository[],
  opts: { now?: Date } = {}
): Promise<Map<string, RepoStats>> {
  const stats = new Map<string, RepoStats>();
  if (!repos.length) return stats;
  const now = opts.now ?? new Date();
  const ids = JSON.stringify(repos.map((r) => r.id));
  const inRepos = (column: AnySQLiteColumn): SQL =>
    sql`${column} IN (SELECT value FROM json_each(${ids}))`;
  const days = lastUtcDays(7, now);
  const sinceSeconds = Date.parse(days[0]) / 1000;

  const [openRows, mergedRows, agentRows, reviewerRows] = await Promise.all([
    db
      .select()
      .from(pullRequests)
      .where(
        and(inRepos(pullRequests.repositoryId), eq(pullRequests.state, 'open'))
      )
      .all(),
    db.all<{ repo: string; day: string; merged: number; auto: number }>(sql`
      SELECT repository_id AS repo, strftime('%Y-%m-%d', merged_at, 'unixepoch') AS day,
        COUNT(*) AS merged, COALESCE(SUM(merged_automatically), 0) AS auto
      FROM pull_requests
      WHERE state = 'merged' AND merged_at >= ${sinceSeconds} AND repository_id IN (SELECT value FROM json_each(${ids}))
      GROUP BY repository_id, day`),
    db
      .select({
        repositoryId: repositoryAgents.repositoryId,
        agentId: agents.userId,
        handle: users.username,
        name: users.name,
        color: agents.color,
      })
      .from(repositoryAgents)
      .innerJoin(agents, eq(agents.userId, repositoryAgents.agentId))
      .innerJoin(users, eq(users.id, agents.userId))
      .where(
        and(inRepos(repositoryAgents.repositoryId), isNull(agents.deletedAt))
      )
      .orderBy(asc(users.username))
      .all(),
    // Each agent's reviews of open pull requests, newest first (the newest row of a pull request is its current one).
    db
      .select({
        pullRequestId: prReviewers.pullRequestId,
        repositoryId: pullRequests.repositoryId,
        agentId: prReviewers.agentId,
        number: pullRequests.number,
        status: prReviewers.status,
      })
      .from(prReviewers)
      .innerJoin(pullRequests, eq(pullRequests.id, prReviewers.pullRequestId))
      .where(
        and(
          inRepos(pullRequests.repositoryId),
          eq(pullRequests.state, 'open'),
          eq(prReviewers.requested, true),
          ne(prReviewers.status, 'not_needed')
        )
      )
      .orderBy(desc(prReviewers.createdAt), sql`${prReviewers}.rowid DESC`)
      .all(),
  ]);

  const openBy = new Map<string, PullRequest[]>();
  for (const p of openRows)
    openBy.set(p.repositoryId, [...(openBy.get(p.repositoryId) ?? []), p]);
  const mergedBy = new Map<
    string,
    Map<string, { merged: number; auto: number }>
  >();
  for (const m of mergedRows) {
    const byDay = mergedBy.get(m.repo) ?? new Map();
    byDay.set(m.day, { merged: Number(m.merged), auto: Number(m.auto) });
    mergedBy.set(m.repo, byDay);
  }
  const agentsBy = new Map<string, typeof agentRows>();
  for (const a of agentRows)
    agentsBy.set(a.repositoryId, [...(agentsBy.get(a.repositoryId) ?? []), a]);
  const reviewing = newestPerPull(reviewerRows);

  const oneRepo = async (repo: Repository): Promise<RepoStats> => {
    const prs = openBy.get(repo.id) ?? [];
    const git = gitFor(env, repo);
    let refs: Map<string, string> | null = null;
    try {
      refs = await git.refs();
    } catch (e) {
      console.warn('[repo-stats] could not read refs', repo.id, e);
    }

    let states = new Map<string, PullState>();
    if (prs.length) {
      try {
        states = refs
          ? await pullStates(db, git, repo.id, prs, {
              refs,
              reviewConfigured: reviewConfigured(env),
            })
          : await latestStates(
              db,
              prs.map((p) => p.id)
            );
      } catch (e) {
        console.error('[repo-stats] could not compute states', repo.id, e);
        states = await latestStates(
          db,
          prs.map((p) => p.id)
        );
      }
    }
    const pulls = {
      open: prs.length,
      needsPerson: 0,
      changesRequested: 0,
      checking: 0,
      queued: 0,
    };
    for (const p of prs) {
      const s = states.get(p.id);
      if (s) pulls[pullBucket(s)] += 1;
    }

    const byDay = mergedBy.get(repo.id);
    const mergedByDay = days.map((d) => byDay?.get(d)?.merged ?? 0);
    const merged7d = mergedByDay.reduce((a, b) => a + b, 0);
    const automatic = days.reduce((a, d) => a + (byDay?.get(d)?.auto ?? 0), 0);

    return {
      pulls,
      merged7d,
      mergedByDay,
      mergedAutomaticallyPct: merged7d
        ? Math.round((automatic / merged7d) * 100)
        : null,
      agents: (agentsBy.get(repo.id) ?? []).map((a) => {
        const handle = a.handle ?? a.agentId;
        return {
          handle,
          name: a.name,
          color: agentColor(a, handle),
          status: currentStatus(reviewing.get(`${repo.id}:${a.agentId}`) ?? [])
            .status,
        };
      }),
      branchCount: refs
        ? [...refs.keys()].filter((r) => r.startsWith('refs/heads/')).length
        : null,
      language: refs ? await languageOf(db, git, repo, refs) : repo.language,
      updatedAt: repo.updatedAt.getTime(),
    };
  };

  const all = await pool(repos, CONCURRENT_REPOSITORIES, oneRepo);
  repos.forEach((r, i) => stats.set(r.id, all[i]));
  return stats;
}

/**
 * The repository's language at its default branch's tip: the cached one while the tip is the commit it was read at
 * (`language_sha`), else read again and cached. The cache is only a cache: a tree that can't be read keeps the old answer.
 */
async function languageOf(
  db: DrizzleDB,
  git: GitService,
  repo: Repository,
  refs: Map<string, string>
): Promise<string | null> {
  const tip = refs.get(`refs/heads/${repo.defaultBranch}`);
  if (!tip) return null;
  if (tip === repo.languageSha) return repo.language;
  try {
    const language = await detectLanguage(git, tip);
    await db
      .update(repositories)
      .set({ language, languageSha: tip })
      .where(eq(repositories.id, repo.id));
    return language;
  } catch (e) {
    console.warn('[repo-stats] could not read the language', repo.id, e);
    return repo.language;
  }
}
