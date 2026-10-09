import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { agents, pullRequests, repositories, teams } from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import { agentColor } from '../agents/presets';
import type { GitService } from '../git/service';
import type { SessionUser } from '../variables';
import { contains, startsWith } from './text-match';
import {
  findRepo,
  findReposByIds,
  gitFor,
  permissionsFor,
  teamNamespace,
  userNamespace,
  visibleTo,
} from './repos';

// Global search (the top band's search box): repositories, pull requests, agents and people across the instance, plus
// branches and files of one repository when the page is in one. Every list respects what the caller can read
// (`visibleTo` / `permissionsFor`) and holds at most 8 results.

export const SEARCH_LIMIT = 8;
/** The default branch's file list is kept per isolate this long, and holds at most this many paths. */
export const FILE_CACHE_MS = 60_000;
export const MAX_FILE_PATHS = 5000;
/** The most trees read for one file list (one per directory, plus the root): a repository wider than this is cut off. */
export const MAX_FILE_TREES = 200;
const MAX_CACHED_REPOS = 32;

export type SearchResults = {
  repos: { name: string; description: string | null }[];
  pulls: { repo: string; number: number; title: string; state: string }[];
  agents: { handle: string; name: string; color: string }[];
  people: { login: string; name: string | null }[];
  branches: { repo: string; name: string }[];
  files: { repo: string; path: string }[];
};

const empty = (): SearchResults => ({
  repos: [],
  pulls: [],
  agents: [],
  people: [],
  branches: [],
  files: [],
});

/**
 * ORDER BY for a handle column, in the database so the best matches are never cut off by a pool read first: the exact
 * handle (any case), then those starting with the term, then the rest; ties shortest then alphabetical. Mirrors
 * `ranked` below, which does the same for lists read whole.
 */
const byHandle = (column: AnySQLiteColumn, term: string) => [
  sql`CASE WHEN lower(${column}) = lower(${term}) THEN 0 WHEN ${startsWith(column, term)} THEN 1 ELSE 2 END`,
  sql`length(${column})`,
  asc(column),
];

/** Exact matches first, then those starting with the term, then the rest; ties shortest then alphabetical. */
function ranked<T>(items: T[], text: (x: T) => string, term: string): T[] {
  const t = term.toLowerCase();
  const rank = (x: T) => {
    const s = text(x).toLowerCase();
    return s === t ? 0 : s.startsWith(t) ? 1 : 2;
  };
  return items
    .map((x) => ({ x, r: rank(x), s: text(x) }))
    .sort(
      (a, b) => a.r - b.r || a.s.length - b.s.length || a.s.localeCompare(b.s)
    )
    .map((e) => e.x);
}

const fileCache = new Map<string, { at: number; paths: string[] }>();

/**
 * Every file path in the tree of commit `tip`, read breadth first and kept for a minute per isolate under `key` (the
 * repository) and the commit. At most 5000 paths and at most `MAX_FILE_TREES` trees are read (a repository with
 * thousands of directories holding few files would otherwise be read tree by tree without ever reaching the path
 * cap): past either the list is what was seen.
 */
export async function filePaths(
  git: GitService,
  key: string,
  tip: string,
  now = Date.now()
): Promise<string[]> {
  const cacheKey = `${key}@${tip}`;
  const hit = fileCache.get(cacheKey);
  if (hit && now - hit.at < FILE_CACHE_MS) return hit.paths;
  const commit = await git.commit(tip);
  const paths: string[] = [];
  const queue: [string, string][] = commit ? [[commit.treeHash, '']] : [];
  let read = 0;
  while (
    queue.length &&
    paths.length < MAX_FILE_PATHS &&
    read < MAX_FILE_TREES
  ) {
    // Never more than the trees left in the budget.
    const batch = queue.splice(0, Math.min(8, MAX_FILE_TREES - read));
    read += batch.length;
    const trees = await Promise.all(batch.map(([hash]) => git.tree(hash)));
    batch.forEach(([, prefix], i) => {
      for (const e of trees[i]) {
        if (e.mode === '40000' || e.mode === '040000')
          queue.push([e.hash, `${prefix}${e.name}/`]);
        // Submodules are commits, not files.
        else if (e.mode !== '160000' && paths.length < MAX_FILE_PATHS)
          paths.push(`${prefix}${e.name}`);
      }
    });
  }
  for (const [k, v] of fileCache)
    if (now - v.at >= FILE_CACHE_MS) fileCache.delete(k);
  while (fileCache.size >= MAX_CACHED_REPOS)
    fileCache.delete(fileCache.keys().next().value!);
  fileCache.set(cacheKey, { at: now, paths });
  return paths;
}

/** Files whose path contains the term: names starting with it first, then names containing it, then shorter paths. */
function matchFiles(paths: string[], term: string): string[] {
  const t = term.toLowerCase();
  return paths
    .filter((p) => p.toLowerCase().includes(t))
    .map((p) => {
      const name = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
      return { p, r: name.startsWith(t) ? 0 : name.includes(t) ? 1 : 2 };
    })
    .sort(
      (a, b) => a.r - b.r || a.p.length - b.p.length || a.p.localeCompare(b.p)
    )
    .slice(0, SEARCH_LIMIT)
    .map((m) => m.p);
}

/**
 * Searches for `q` as `user`. `repo` (`owner/name`) scopes branches and files to that repository, and ranks its pull
 * requests first; a repository the caller can't read gives none.
 */
export async function search(
  env: CloudflareBindings,
  db: DrizzleDB,
  user: SessionUser,
  q: string,
  repo?: string
): Promise<SearchResults> {
  const term = q.trim().slice(0, 100);
  if (!term) return empty();
  const number = /^#?(\d{1,9})$/.exec(term)?.[1];

  const scoped = repo
    ? await (async () => {
        const [owner, name] = repo.split('/');
        const found = await findRepo(db, owner, name);
        if (!found || !(await permissionsFor(db, found.repo, user)).read)
          return null;
        return found;
      })()
    : null;

  const fullName = sql`COALESCE(${teams.slug}, ${users.username}, ${users.id}) || '/' || ${repositories.name}`;
  const [repoRows, pullRows, agentRows, peopleRows] = await Promise.all([
    db
      .select({ repo: repositories, owner: users, team: teams })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .leftJoin(teams, eq(teams.id, repositories.teamId))
      .where(
        and(
          visibleTo(user),
          or(contains(repositories.name, term), contains(fullName, term))
        )
      )
      .orderBy(
        sql`CASE WHEN lower(${repositories.name}) = lower(${term}) THEN 0 WHEN ${startsWith(repositories.name, term)} THEN 1 ELSE 2 END`,
        desc(repositories.updatedAt)
      )
      .limit(SEARCH_LIMIT)
      .all(),
    db
      .select({
        repositoryId: pullRequests.repositoryId,
        number: pullRequests.number,
        title: pullRequests.title,
        state: pullRequests.state,
      })
      .from(pullRequests)
      .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
      .where(
        and(
          visibleTo(user),
          or(
            contains(pullRequests.title, term),
            number ? eq(pullRequests.number, Number(number)) : undefined
          )
        )
      )
      .orderBy(
        ...(scoped
          ? [
              sql`CASE WHEN ${pullRequests.repositoryId} = ${scoped.repo.id} THEN 0 ELSE 1 END`,
            ]
          : []),
        desc(pullRequests.updatedAt)
      )
      .limit(SEARCH_LIMIT)
      .all(),
    db
      .select({
        handle: users.username,
        name: agents.name,
        color: agents.color,
      })
      .from(agents)
      .innerJoin(users, eq(users.id, agents.userId))
      .where(
        and(
          isNull(agents.deletedAt),
          isNotNull(users.username),
          or(contains(users.username, term), contains(agents.name, term))
        )
      )
      .orderBy(...byHandle(users.username, term))
      .limit(SEARCH_LIMIT)
      .all(),
    db
      .select({ login: users.username, name: users.name })
      .from(users)
      .leftJoin(agents, eq(agents.userId, users.id))
      .where(
        and(
          // People only: an agent is found under agents.
          isNull(agents.userId),
          isNotNull(users.username),
          or(isNull(users.banned), eq(users.banned, false)),
          or(contains(users.username, term), contains(users.name, term))
        )
      )
      .orderBy(...byHandle(users.username, term))
      .limit(SEARCH_LIMIT)
      .all(),
  ]);

  const pullRepos = await findReposByIds(
    db,
    pullRows.map((r) => r.repositoryId)
  );
  const out: SearchResults = {
    repos: repoRows.map(({ repo: r, owner, team }) => ({
      name: `${(team ? teamNamespace(team) : userNamespace(owner)).username}/${r.name}`,
      description: r.description,
    })),
    pulls: pullRows.flatMap((r) => {
      const found = pullRepos.get(r.repositoryId);
      return found
        ? [
            {
              repo: `${found.namespace.username}/${found.repo.name}`,
              number: r.number,
              title: r.title,
              state: r.state,
            },
          ]
        : [];
    }),
    // Ranked and limited in SQL (`byHandle`).
    agents: agentRows.map((a) => ({
      handle: a.handle!,
      name: a.name,
      color: agentColor(a, a.handle!),
    })),
    people: peopleRows.map((u) => ({ login: u.login!, name: u.name })),
    branches: [],
    files: [],
  };

  if (scoped) {
    const git = gitFor(env, scoped.repo);
    const full = `${scoped.namespace.username}/${scoped.repo.name}`;
    try {
      const branches = (await git.branches()).filter((b) =>
        b.name.toLowerCase().includes(term.toLowerCase())
      );
      out.branches = ranked(branches, (b) => b.name, term)
        .slice(0, SEARCH_LIMIT)
        .map((b) => ({ repo: full, name: b.name }));
      const tip = await git.resolve(scoped.repo.defaultBranch);
      if (tip)
        out.files = matchFiles(
          await filePaths(git, scoped.repo.id, tip),
          term
        ).map((path) => ({ repo: full, path }));
    } catch (e) {
      // The repository's git can't be read right now: the other lists still answer.
      console.warn('[search] could not read branches or files', full, e);
    }
  }
  return out;
}
