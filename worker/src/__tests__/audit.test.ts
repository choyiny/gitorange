import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { recordAudit } from '../lib/audit';
import { findRepoById, gitFor } from '../lib/repos';
import { landPull } from '../merge/land';
import { decideFlag } from '../review/flags';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
  type TestEnv,
} from './helpers/app';
import { newAgent } from './helpers/agents';
import { findings, reviewedPull } from './helpers/lessons';
import { appRepo, BASE, openPull } from './helpers/reviews';
import { commitPaths } from './helpers/seed';

type AuditRow = {
  action: string;
  actor_kind: string;
  actor: string | null;
  via: string | null;
  target: string;
  data: Record<string, unknown>;
  repo: string | null;
};

type AuditEventJson = {
  id: string;
  at: number;
  actor: { kind: string; login: string | null; name: string | null };
  via: string | null;
  action: string;
  target: string;
  data: Record<string, unknown>;
  repo: string | null;
  pull: number | null;
};
type AuditPageJson = { events: AuditEventJson[]; nextCursor: string | null };

/** Every audit_events row, oldest first, with its actor's username and its repository's name. */
async function auditRows(t: TestEnv): Promise<AuditRow[]> {
  const { results } = await t.env.DB.prepare(
    `SELECT a.action, a.actor_kind, u.username AS actor, a.via, a.target, a.data, r.name AS repo
       FROM audit_events a
       LEFT JOIN users u ON u.id = a.actor_id
       LEFT JOIN repositories r ON r.id = a.repository_id
      ORDER BY a.created_at, a.rowid`
  ).all<Omit<AuditRow, 'data'> & { data: string }>();
  return results.map((r) => ({ ...r, data: JSON.parse(r.data) }));
}

/** The rows recorded by `run`. */
async function recorded(t: TestEnv, run: () => Promise<unknown>) {
  const before = (await auditRows(t)).length;
  await run();
  await settle(t);
  return (await auditRows(t)).slice(before);
}

async function ok(res: Response | Promise<Response>, status = 200) {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return r;
}

async function page(t: TestEnv, cookie: string, path: string) {
  const res = await call(t, path, { cookie });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as AuditPageJson;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordAudit', () => {
  it('never throws: a failed write is logged and the caller carries on', async () => {
    const t = makeEnv();
    const db = drizzle(t.env.DB, { schema });
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'insert')
          return () => {
            throw new Error('D1 is down');
          };
        return Reflect.get(target, prop, receiver);
      },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      recordAudit(failing, {
        repositoryId: null,
        actorId: null,
        action: 'instance.settings',
        target: 'app.name',
      })
    ).resolves.toBeUndefined();
    // Data that can't be stored is no different.
    await expect(
      recordAudit(db, {
        repositoryId: null,
        actorId: null,
        action: 'instance.settings',
        target: 'app.name',
        data: { big: 1n },
      })
    ).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(2);
    expect(await auditRows(t)).toEqual([]);
  });

  it('records a system event with no actor', async () => {
    const t = makeEnv();
    await recordAudit(drizzle(t.env.DB, { schema }), {
      repositoryId: null,
      actorId: null,
      action: 'instance.settings',
      target: 'app.name',
      data: { value: 'X' },
    });
    expect(await auditRows(t)).toEqual([
      {
        action: 'instance.settings',
        actor_kind: 'system',
        actor: null,
        via: null,
        target: 'app.name',
        data: { value: 'X' },
        repo: null,
      },
    ]);
  });
});

describe('mutations write the audit log', () => {
  it('repository create, settings, visibility, collaborators, branch delete and delete', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await addMember(t, admin, 'bob');
    const base = '/api/repos/octocat/app';

    expect(
      await recorded(t, () =>
        ok(
          call(t, '/api/repos', {
            cookie: admin,
            json: { name: 'app', visibility: 'private' },
          }),
          201
        )
      )
    ).toEqual([
      {
        action: 'repository.created',
        actor_kind: 'person',
        actor: 'octocat',
        via: null,
        target: 'octocat/app',
        data: { visibility: 'private' },
        repo: 'app',
      },
    ]);

    expect(
      await recorded(t, () =>
        ok(
          call(t, base, {
            cookie: admin,
            method: 'PATCH',
            json: { description: 'The app', protectedBranches: ['release/*'] },
          })
        )
      )
    ).toMatchObject([
      {
        action: 'settings.changed',
        actor: 'octocat',
        target: 'octocat/app',
        data: {
          changes: {
            description: { from: null, to: 'The app' },
            protectedBranches: { from: [], to: ['release/*'] },
          },
        },
        repo: 'app',
      },
    ]);
    // Saving what is already there changes nothing, and records nothing.
    expect(
      await recorded(t, () =>
        ok(
          call(t, base, {
            cookie: admin,
            method: 'PATCH',
            json: { description: 'The app' },
          })
        )
      )
    ).toEqual([]);
    expect(
      await recorded(t, () =>
        ok(
          call(t, base, {
            cookie: admin,
            method: 'PATCH',
            json: { visibility: 'internal' },
          })
        )
      )
    ).toMatchObject([
      {
        action: 'visibility.changed',
        data: { from: 'private', to: 'internal' },
        repo: 'app',
      },
    ]);

    // Collaborators: only real changes.
    const addBob = () =>
      ok(
        call(t, `${base}/collaborators/bob`, { cookie: admin, method: 'PUT' })
      );
    const removeBob = () =>
      ok(
        call(t, `${base}/collaborators/bob`, {
          cookie: admin,
          method: 'DELETE',
        })
      );
    expect(await recorded(t, addBob)).toMatchObject([
      { action: 'collaborator.added', target: 'bob', repo: 'app' },
    ]);
    expect(await recorded(t, addBob)).toEqual([]);
    expect(await recorded(t, removeBob)).toMatchObject([
      { action: 'collaborator.removed', target: 'bob', repo: 'app' },
    ]);
    expect(await recorded(t, removeBob)).toEqual([]);

    // Deleting a branch.
    const repo = [...t.fake.repos.values()][0];
    const main = await commitPaths(repo, 'main', BASE, 'base');
    repo.refs.set('refs/heads/old', main);
    expect(
      await recorded(t, () =>
        ok(
          call(t, `${base}/branches?name=old`, {
            cookie: admin,
            method: 'DELETE',
          })
        )
      )
    ).toMatchObject([
      {
        action: 'branch.deleted',
        target: 'old',
        data: { sha: main },
        repo: 'app',
      },
    ]);

    // Deleting the repository: an instance event, since the repository's own log goes with it.
    await ok(call(t, base, { cookie: admin, method: 'DELETE' }));
    await settle(t);
    expect(await auditRows(t)).toMatchObject([
      {
        action: 'repository.deleted',
        actor: 'octocat',
        target: 'octocat/app',
        repo: null,
      },
    ]);
  });

  it('agents: create, invite, remove, delete', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await ok(
      call(t, '/api/repos', {
        cookie: admin,
        json: { name: 'app', visibility: 'internal' },
      }),
      201
    );
    expect(
      await recorded(t, () => newAgent(t, admin, 'secagent', 'Security'))
    ).toMatchObject([
      {
        action: 'agent.created',
        actor_kind: 'person',
        actor: 'octocat',
        target: 'secagent',
        data: { name: 'Security', preset: null },
        repo: null,
      },
    ]);
    const invite = () =>
      ok(
        call(t, '/api/repos/octocat/app/agents/secagent', {
          cookie: admin,
          method: 'PUT',
        })
      );
    const remove = () =>
      ok(
        call(t, '/api/repos/octocat/app/agents/secagent', {
          cookie: admin,
          method: 'DELETE',
        })
      );
    expect(await recorded(t, invite)).toMatchObject([
      { action: 'agent.invited', target: 'secagent', repo: 'app' },
    ]);
    expect(await recorded(t, invite)).toEqual([]);
    expect(await recorded(t, remove)).toMatchObject([
      { action: 'agent.removed', target: 'secagent', repo: 'app' },
    ]);
    expect(await recorded(t, remove)).toEqual([]);
    expect(
      await recorded(t, () =>
        ok(
          call(t, '/api/admin/agents/secagent', {
            cookie: admin,
            method: 'DELETE',
          })
        )
      )
    ).toMatchObject([
      {
        action: 'agent.deleted',
        actor: 'octocat',
        target: 'secagent',
        repo: null,
      },
    ]);
  });

  it('findings approved, dismissed and sent back for changes, by a person or an app', async () => {
    const { t, admin } = await reviewedPull();
    const [tokenLogged, noExpiry, rotation] = await findings(t);
    expect([tokenLogged.kind, noExpiry.kind, rotation.kind]).toEqual([
      'change_requested',
      'change_requested',
      'needs_person',
    ]);
    const flagPath = (id: string, verb: string) =>
      `/api/repos/octocat/app/pulls/1/review/flags/${id}/${verb}`;
    const dismiss = () =>
      ok(
        call(t, flagPath(tokenLogged.id, 'approve'), {
          cookie: admin,
          method: 'POST',
        })
      );
    expect(await recorded(t, dismiss)).toMatchObject([
      {
        action: 'finding.approved',
        actor_kind: 'person',
        actor: 'octocat',
        via: null,
        target: 'Token logged',
        data: {
          finding: tokenLogged.id,
          kind: 'change_requested',
          agent: 'secagent',
          pull: 1,
        },
        repo: 'app',
      },
    ]);
    // Approving again keeps the first decision and records nothing.
    expect(await recorded(t, dismiss)).toEqual([]);

    expect(
      await recorded(t, () =>
        ok(
          call(t, flagPath(rotation.id, 'request-changes'), {
            cookie: admin,
            json: { note: 'Rotate it in the same change.' },
          })
        )
      )
    ).toMatchObject([
      {
        action: 'finding.changes_requested',
        target: 'Secret rotation',
        data: {
          finding: rotation.id,
          kind: 'needs_person',
          note: 'Rotate it in the same change.',
          pull: 1,
        },
      },
    ]);

    // A moderator app's decision carries its name.
    const db = drizzle(t.env.DB, { schema });
    const pr = (await db.query.pullRequests.findFirst())!;
    const adminId = (await t.env.DB.prepare(
      "SELECT id FROM users WHERE username = 'octocat'"
    ).first<{ id: string }>())!.id;
    expect(
      await recorded(t, () =>
        decideFlag(
          t.env,
          db,
          pr,
          noExpiry.id,
          adminId,
          { kind: 'approve' },
          (w) => void t.waits.push(w),
          { via: 'Claude Code' }
        )
      )
    ).toMatchObject([
      {
        action: 'finding.approved',
        actor: 'octocat',
        via: 'Claude Code',
        target: 'No expiry',
      },
    ]);
  });

  it('a person approving and merging a pull request', async () => {
    const { t, admin, repo } = await appRepo();
    const { head } = await openPull(t, admin, repo, {
      'src/app.ts': 'export const a = 2;\n',
    });
    const approve = () =>
      ok(
        call(t, '/api/repos/octocat/app/pulls/1/approval', {
          cookie: admin,
          method: 'POST',
        })
      );
    expect(await recorded(t, approve)).toMatchObject([
      {
        action: 'pull.approved',
        actor: 'octocat',
        target: '#1',
        data: { pull: 1, headSha: head },
        repo: 'app',
      },
    ]);
    // Approving the same commit again records nothing.
    expect(await recorded(t, approve)).toEqual([]);
    expect(
      await recorded(t, () =>
        ok(
          call(t, '/api/repos/octocat/app/pulls/1/merge', {
            cookie: admin,
            json: {},
          })
        )
      )
    ).toMatchObject([
      {
        action: 'pull.merged',
        actor_kind: 'person',
        actor: 'octocat',
        target: '#1',
        data: {
          pull: 1,
          title: 'Change things',
          sha: head,
          into: 'main',
          automatic: false,
        },
        repo: 'app',
      },
    ]);
  });

  it('GitOrange landing a pull request on its own', async () => {
    const { t, admin, repo } = await appRepo();
    await openPull(t, admin, repo, { 'src/app.ts': 'export const a = 2;\n' });
    await ok(
      call(t, '/api/repos/octocat/app/pulls/1/approval', {
        cookie: admin,
        method: 'POST',
      })
    );
    const db = drizzle(t.env.DB, { schema });
    const pr = (await db.query.pullRequests.findFirst())!;
    const found = (await findRepoById(db, pr.repositoryId))!;
    const rows = await recorded(t, async () =>
      expect(
        await landPull({
          env: t.env,
          db,
          repo: found.repo,
          repoFullName: 'octocat/app',
          git: gitFor(t.env, found.repo),
          pr,
          by: null,
          after: (w) => void t.waits.push(w),
        })
      ).toMatchObject({ ok: true })
    );
    expect(rows).toMatchObject([
      {
        action: 'pull.merged',
        actor_kind: 'system',
        actor: null,
        target: '#1',
        data: { pull: 1, automatic: true },
        repo: 'app',
      },
    ]);
  });

  it('personal access tokens and instance settings', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const created = await recorded(t, async () => {
      const res = await ok(
        call(t, '/api/tokens', {
          cookie: admin,
          json: { name: 'laptop', expiresInDays: 30 },
        }),
        201
      );
      const { token, plaintext } = (await res.json()) as {
        token: { id: string };
        plaintext: string;
      };
      // The secret never reaches the log.
      expect(JSON.stringify(await auditRows(t))).not.toContain(plaintext);
      return token.id;
    });
    expect(created).toMatchObject([
      {
        action: 'token.created',
        actor: 'octocat',
        target: 'laptop',
        repo: null,
      },
    ]);
    const id = created[0].data.token as string;
    const del = () =>
      ok(call(t, `/api/tokens/${id}`, { cookie: admin, method: 'DELETE' }));
    expect(await recorded(t, del)).toMatchObject([
      { action: 'token.deleted', target: 'laptop', data: { token: id } },
    ]);
    expect(await recorded(t, del)).toEqual([]);

    expect(
      await recorded(t, () =>
        ok(
          call(t, '/api/admin/settings/app.name', {
            cookie: admin,
            method: 'PUT',
            json: { value: 'Acme Git' },
          })
        )
      )
    ).toMatchObject([
      {
        action: 'instance.settings',
        actor: 'octocat',
        target: 'app.name',
        data: { value: 'Acme Git' },
        repo: null,
      },
    ]);
    expect(
      await recorded(t, () =>
        ok(
          call(t, '/api/admin/settings/app.name', {
            cookie: admin,
            method: 'DELETE',
          })
        )
      )
    ).toMatchObject([
      {
        action: 'instance.settings',
        target: 'app.name',
        data: { reset: true },
      },
    ]);
  });
});

/** octocat/<name> with pull request #1, then an empty audit log and timeline. */
async function quietRepo(t: TestEnv, admin: string, name = 'app') {
  await ok(
    call(t, '/api/repos', {
      cookie: admin,
      json: { name, visibility: 'private' },
    }),
    201
  );
  const repo = [...t.fake.repos.values()].at(-1)!;
  const main = await commitPaths(repo, 'main', BASE, 'base');
  repo.refs.set('refs/heads/feature', main);
  await commitPaths(repo, 'feature', { ...BASE, 'b.txt': 'b\n' }, 'Add b');
  await ok(
    call(t, `/api/repos/octocat/${name}/pulls`, {
      cookie: admin,
      json: { title: 'Add b', body: '', base: 'main', head: 'feature' },
    }),
    201
  );
  await settle(t);
  const ids = (await t.env.DB.prepare(
    `SELECT r.id AS repo, p.id AS pull, r.owner_id AS owner
       FROM repositories r JOIN pull_requests p ON p.repository_id = r.id WHERE r.name = ?`
  )
    .bind(name)
    .first<{ repo: string; pull: string; owner: string }>())!;
  await t.env.DB.batch([
    t.env.DB.prepare('DELETE FROM audit_events WHERE repository_id = ?').bind(
      ids.repo
    ),
    t.env.DB.prepare('DELETE FROM pr_events WHERE repository_id = ?').bind(
      ids.repo
    ),
  ]);
  return ids;
}

function auditInsert(
  t: TestEnv,
  e: {
    id: string;
    repo: string | null;
    actor: string | null;
    kind?: string;
    action?: string;
    at: number;
  }
) {
  return t.env.DB.prepare(
    `INSERT INTO audit_events (id, repository_id, actor_id, actor_kind, via, action, target, data, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, 'main', '{}', ?)`
  ).bind(
    e.id,
    e.repo,
    e.actor,
    e.kind ?? (e.actor ? 'person' : 'system'),
    e.action ?? 'branch.deleted',
    e.at
  );
}

function prEventInsert(
  t: TestEnv,
  e: {
    id: string;
    repo: string;
    pull: string;
    kind: string;
    actor: string | null;
    at: number;
    data?: unknown;
  }
) {
  return t.env.DB.prepare(
    `INSERT INTO pr_events (id, repository_id, pull_request_id, kind, state, data, actor_id, computed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    e.id,
    e.repo,
    e.pull,
    e.kind,
    e.kind === 'state_changed' ? 'waiting' : null,
    JSON.stringify(e.data ?? {}),
    e.actor,
    e.at,
    e.at
  );
}

describe('GET /api/repos/{owner}/{repo}/audit', () => {
  it('merges the audit log with the pull request timeline, newest first, a page at a time', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const ids = await quietRepo(t, admin);
    const other = await quietRepo(t, admin, 'other');
    await t.env.DB.batch([
      auditInsert(t, { id: 'a1', repo: ids.repo, actor: ids.owner, at: 1000 }),
      auditInsert(t, { id: 'a2', repo: ids.repo, actor: null, at: 2000 }),
      auditInsert(t, { id: 'a3', repo: ids.repo, actor: ids.owner, at: 3000 }),
      prEventInsert(t, {
        id: 'p1',
        repo: ids.repo,
        pull: ids.pull,
        kind: 'state_changed',
        actor: null,
        at: 1500,
        data: { reasons: [] },
      }),
      // At the same moment as a3: ties still page without gaps or repeats.
      prEventInsert(t, {
        id: 'p2',
        repo: ids.repo,
        pull: ids.pull,
        kind: 'rebased',
        actor: ids.owner,
        at: 3000,
      }),
      // Approvals are in the audit log itself (pull.approved), never twice.
      prEventInsert(t, {
        id: 'p3',
        repo: ids.repo,
        pull: ids.pull,
        kind: 'approved',
        actor: ids.owner,
        at: 2500,
      }),
      // Another repository's and the instance's events stay out.
      auditInsert(t, { id: 'o1', repo: other.repo, actor: null, at: 2200 }),
      auditInsert(t, { id: 'i1', repo: null, actor: null, at: 2300 }),
    ]);

    const base = '/api/repos/octocat/app/audit';
    const first = await page(t, admin, `${base}?limit=2`);
    expect(first.events.map((e) => e.id)).toEqual(['p2', 'a3']);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await page(
      t,
      admin,
      `${base}?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`
    );
    expect(second.events.map((e) => e.id)).toEqual(['a2', 'p1']);
    const third = await page(
      t,
      admin,
      `${base}?limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`
    );
    expect(third.events.map((e) => e.id)).toEqual(['a1']);
    expect(third.nextCursor).toBeNull();
    expect((await page(t, admin, base)).events.map((e) => e.id)).toEqual([
      'p2',
      'a3',
      'a2',
      'p1',
      'a1',
    ]);

    const [p2, a3, a2, p1] = first.events.concat(second.events);
    expect(a3).toEqual({
      id: 'a3',
      at: 3000,
      actor: { kind: 'person', login: 'octocat', name: 'Admin' },
      via: null,
      action: 'branch.deleted',
      target: 'main',
      data: {},
      repo: 'octocat/app',
      pull: null,
    });
    expect(a2.actor).toEqual({ kind: 'system', login: null, name: null });
    expect(p2).toEqual({
      id: 'p2',
      at: 3000,
      actor: { kind: 'person', login: 'octocat', name: 'Admin' },
      via: null,
      action: 'pull.rebased',
      target: '#1',
      data: {},
      repo: 'octocat/app',
      pull: 1,
    });
    expect(p1).toMatchObject({
      action: 'pull.state_changed',
      actor: { kind: 'system', login: null, name: null },
      data: { state: 'waiting', reasons: [] },
      pull: 1,
    });
  });

  it('reports an agent as an agent, and an app by name', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const ids = await quietRepo(t, admin);
    const agent = await newAgent(t, admin, 'secagent', 'Security');
    await t.env.DB.batch([
      prEventInsert(t, {
        id: 'p1',
        repo: ids.repo,
        pull: ids.pull,
        kind: 'learned',
        actor: agent.id,
        at: 1000,
      }),
      prEventInsert(t, {
        id: 'p2',
        repo: ids.repo,
        pull: ids.pull,
        kind: 'withdrawn',
        actor: ids.owner,
        at: 2000,
        data: { head_sha: 'abc', via: 'Claude Code' },
      }),
    ]);
    const { events } = await page(t, admin, '/api/repos/octocat/app/audit');
    expect(events).toMatchObject([
      { id: 'p2', via: 'Claude Code', action: 'pull.withdrawn' },
      {
        id: 'p1',
        actor: { kind: 'agent', login: 'secagent', name: 'Security' },
        action: 'pull.learned',
      },
    ]);
  });

  it('refuses a cursor it did not make', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await quietRepo(t, admin);
    const res = await call(t, '/api/repos/octocat/app/audit?cursor=nonsense', {
      cookie: admin,
    });
    expect(res.status).toBe(400);
  });

  it('is hidden from members who cannot read the repository', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const bob = await addMember(t, admin, 'bob');
    const ids = await quietRepo(t, admin);
    await auditInsert(t, {
      id: 'a1',
      repo: ids.repo,
      actor: ids.owner,
      at: 1000,
    }).run();
    const base = '/api/repos/octocat/app/audit';
    expect((await call(t, base, { cookie: bob })).status).toBe(404);
    await ok(
      call(t, '/api/repos/octocat/app/collaborators/bob', {
        cookie: admin,
        method: 'PUT',
      })
    );
    expect((await page(t, bob, base)).events.map((e) => e.id)).toContain('a1');
    await ok(
      call(t, '/api/repos/octocat/app/collaborators/bob', {
        cookie: admin,
        method: 'DELETE',
      })
    );
    expect((await call(t, base, { cookie: bob })).status).toBe(404);
    // An internal repository's log is every member's to read.
    await ok(
      call(t, '/api/repos/octocat/app', {
        cookie: admin,
        method: 'PATCH',
        json: { visibility: 'internal' },
      })
    );
    expect((await page(t, bob, base)).events.length).toBeGreaterThan(0);
  });
});

describe('GET /api/admin/audit', () => {
  it('shows every repository and the instance to site admins only', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const bob = await addMember(t, admin, 'bob');
    const ids = await quietRepo(t, admin);
    await t.env.DB.prepare('DELETE FROM audit_events').run();
    await t.env.DB.prepare('DELETE FROM pr_events').run();
    await t.env.DB.batch([
      auditInsert(t, { id: 'a1', repo: ids.repo, actor: ids.owner, at: 1000 }),
      auditInsert(t, {
        id: 'i1',
        repo: null,
        actor: ids.owner,
        action: 'token.created',
        at: 2000,
      }),
      prEventInsert(t, {
        id: 'p1',
        repo: ids.repo,
        pull: ids.pull,
        kind: 'rebased',
        actor: null,
        at: 1500,
      }),
    ]);
    const { events, nextCursor } = await page(t, admin, '/api/admin/audit');
    expect(events.map((e) => [e.id, e.repo])).toEqual([
      ['i1', null],
      ['p1', 'octocat/app'],
      ['a1', 'octocat/app'],
    ]);
    expect(nextCursor).toBeNull();
    const paged = await page(t, admin, '/api/admin/audit?limit=1');
    expect(paged.events.map((e) => e.id)).toEqual(['i1']);
    expect(
      (
        await page(
          t,
          admin,
          `/api/admin/audit?limit=2&cursor=${encodeURIComponent(paged.nextCursor!)}`
        )
      ).events.map((e) => e.id)
    ).toEqual(['p1', 'a1']);
    expect((await call(t, '/api/admin/audit', { cookie: bob })).status).toBe(
      403
    );
  });
});
