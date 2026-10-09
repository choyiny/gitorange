/** Fixtures for sessions and branches: a repository with main, branches pushed like `git push`, and pull requests opened by hand or over MCP. */
import { expect } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../../db/schema';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
  type TestEnv,
} from './app';
import { connect, tool } from './mcp';
import { commitPaths } from './seed';

export { connect, tool };

export const FILES = { 'src/app.ts': 'export const a = 1;\n' };

/** octocat/app (internal) with a base commit on main. */
export async function crewRepo(opts: { actions?: boolean } = {}) {
  const t = makeEnv({ actions: opts.actions ?? false });
  const admin = await bootstrapAdmin(t);
  const created = await call(t, '/api/repos', {
    cookie: admin,
    json: { name: 'app', visibility: 'internal' },
  });
  expect(created.status).toBe(201);
  const repo = [...t.fake.repos.values()][0];
  const main = await commitPaths(repo, 'main', FILES, 'base');
  const db = drizzle(t.env.DB, { schema });
  const repoId = (await t.env.DB.prepare(
    "SELECT id FROM repositories WHERE name = 'app'"
  ).first<{ id: string }>())!.id;

  /** Pushes `branch` off main's current tip with one file of its own (so landing it is a fast-forward). */
  async function branch(name: string, extra: Record<string, string> = {}) {
    repo.refs.set(`refs/heads/${name}`, repo.refs.get('refs/heads/main')!);
    return commitPaths(
      repo,
      name,
      { ...FILES, [`${name.replace(/\//g, '_')}.txt`]: `${name}\n`, ...extra },
      name
    );
  }

  /** Opens a pull request from `head` on the web, as `cookie` (default the admin). */
  async function web(
    head: string,
    opts: { title?: string; base?: string; cookie?: string } = {}
  ) {
    const res = await call(t, '/api/repos/octocat/app/pulls', {
      cookie: opts.cookie ?? admin,
      json: {
        title: opts.title ?? head,
        body: '',
        base: opts.base ?? 'main',
        head,
      },
    });
    expect(res.status).toBe(201);
    await settle(t);
    return ((await res.json()) as { number: number }).number;
  }

  /** Opens a pull request over MCP with `token`'s app. */
  async function mcp(
    token: string,
    head: string,
    args: {
      title?: string;
      base?: string;
      session?: string;
      request?: string;
    } = {}
  ) {
    const res = await tool(t, token, 'gitorange_create_pull_request', {
      repository: 'octocat/app',
      head,
      title: args.title ?? head,
      ...(args.base ? { base: args.base } : {}),
      ...(args.session !== undefined ? { session: args.session } : {}),
      ...(args.request !== undefined ? { request: args.request } : {}),
    });
    await settle(t);
    if (res.isError) throw new Error(res.content[0].text);
    return (JSON.parse(res.content[0].text) as { number: number }).number;
  }

  /** Lands pull request `n` with the merge button (approving it first). */
  async function merge(n: number, cookie = admin) {
    const res = await call(t, `/api/repos/octocat/app/pulls/${n}/merge`, {
      cookie,
      json: { approve: true },
    });
    expect(res.status).toBe(200);
    await settle(t);
  }

  /** Sets one repository column straight in D1. */
  const setRepo = (column: string, value: string | number | null) =>
    t.env.DB.prepare(`UPDATE repositories SET ${column} = ? WHERE id = ?`)
      .bind(value, repoId)
      .run();

  /** Writes a merged pull request straight into D1, merged at `mergedAt` (epoch ms). */
  async function mergedRow(
    number: number,
    head: string,
    mergedAt: number,
    opts: {
      title?: string;
      base?: string;
      sha?: string | null;
      authorId?: string;
      /** `landed_commits`: null (the default) is a pull request merged before fast-forward landing existed. */
      landed?: number | null;
      /**
       * Pin `refs/pull/<n>/head` at the head branch's tip now, as the old merges did (default: when the branch
       * exists). `false` leaves no pin.
       */
      pin?: boolean;
    } = {}
  ) {
    const author =
      opts.authorId ??
      (await t.env.DB.prepare(
        "SELECT id FROM users WHERE username = 'octocat'"
      ).first<{
        id: string;
      }>())!.id;
    const at = Math.floor(mergedAt / 1000);
    // Numbers handed out by hand must not collide with the ones the next pull request gets.
    await t.env.DB.prepare(
      'UPDATE repositories SET next_pr_number = MAX(next_pr_number, ?) WHERE id = ?'
    )
      .bind(number + 1, repoId)
      .run();
    await t.env.DB.prepare(
      `INSERT INTO pull_requests (id, repository_id, number, title, author_id, base_ref, land_target, head_ref, state, merge_commit_sha, landed_commits, merged_at, closed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'merged', ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        `${repoId}-m${number}`,
        repoId,
        number,
        opts.title ?? `Merged ${number}`,
        author,
        opts.base ?? 'main',
        opts.base ?? 'main',
        head,
        opts.sha === undefined ? main : opts.sha,
        opts.landed ?? null,
        at,
        at,
        at - 3600,
        at
      )
      .run();
    const tip = repo.refs.get(`refs/heads/${head}`);
    if (tip && opts.pin !== false)
      repo.refs.set(`refs/pull/${number}/head`, tip);
  }

  return {
    t,
    admin,
    repo,
    main,
    db,
    repoId,
    branch,
    web,
    mcp,
    merge,
    setRepo,
    mergedRow,
  };
}
export type CrewRepo = Awaited<ReturnType<typeof crewRepo>>;

/** A second member who can push to octocat/app, signed in. */
export async function collaborator(
  s: { t: TestEnv; admin: string },
  username: string
) {
  const cookie = await addMember(s.t, s.admin, username);
  const res = await call(
    s.t,
    `/api/repos/octocat/app/collaborators/${username}`,
    { cookie: s.admin, method: 'PUT' }
  );
  expect(res.status).toBe(200);
  return cookie;
}
