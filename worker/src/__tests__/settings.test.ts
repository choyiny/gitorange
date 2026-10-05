import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { runActionsRetention } from '../actions/retention';
import { getSetting } from '../lib/settings';
import { addMember, bootstrapAdmin, call, makeEnv } from './helpers/app';

type Setting = {
  key: string;
  value: unknown;
  default: unknown;
  overridden: boolean;
};
type Settings = {
  settings: Setting[];
  actions: {
    runs: number;
    oldestFinishedAt: string | null;
    retention: { deletedRuns: number; retentionDays: number | null } | null;
  };
};

const get = async (t: ReturnType<typeof makeEnv>, cookie: string) =>
  (await (await call(t, '/api/admin/settings', { cookie })).json()) as Settings;
const put = (
  t: ReturnType<typeof makeEnv>,
  cookie: string,
  key: string,
  value: unknown
) =>
  call(t, `/api/admin/settings/${key}`, {
    cookie,
    method: 'PUT',
    json: { value },
  });

describe('instance settings', () => {
  it('limits Actions jobs running at once: 10 by default, a whole number of at least 1', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    expect(
      (await get(t, admin)).settings.find(
        (s) => s.key === 'actions.max_concurrent_jobs'
      )
    ).toMatchObject({ value: 10, default: 10, overridden: false });
    expect((await put(t, admin, 'actions.max_concurrent_jobs', 0)).status).toBe(
      400
    );
    expect(
      (await put(t, admin, 'actions.max_concurrent_jobs', 2.5)).status
    ).toBe(400);
    expect(
      (await put(t, admin, 'actions.max_concurrent_jobs', '3')).status
    ).toBe(400);
    expect((await put(t, admin, 'actions.max_concurrent_jobs', 3)).status).toBe(
      200
    );
    const db = drizzle(t.env.DB, { schema });
    expect(await getSetting(db, t.env, 'actions.max_concurrent_jobs')).toBe(3);
  });

  it('defaults to the wrangler vars, and Site admin overrides them where they are used', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const before = await get(t, admin);
    const name = before.settings.find((s) => s.key === 'app.name')!;
    expect(name).toMatchObject({
      value: 'GitOrange', // APP_NAME in wrangler.test.jsonc
      default: 'GitOrange',
      overridden: false,
    });
    expect(
      before.settings.find((s) => s.key === 'actions.retention_days')
    ).toMatchObject({
      value: 90,
      overridden: false,
    });

    expect((await put(t, admin, 'app.name', 'XY Space Git')).status).toBe(200);
    expect((await put(t, admin, 'email.from', 'git@xyspace.dev')).status).toBe(
      200
    );

    // The new name reaches the web app and the invitation email; the sender is used too.
    const status = (await (await call(t, '/api/setup/status')).json()) as {
      appName: string;
    };
    expect(status.appName).toBe('XY Space Git');
    await call(t, '/api/invites', {
      cookie: admin,
      json: { email: 'grace@example.com', role: 'user' },
    });
    const mail = t.sent[0] as unknown as {
      subject: string;
      from: { email: string; name: string };
    };
    expect(mail.subject).toContain('XY Space Git');
    expect(mail.from).toEqual({
      email: 'git@xyspace.dev',
      name: 'XY Space Git',
    });

    // Resetting goes back to the default.
    expect(
      (
        await call(t, '/api/admin/settings/app.name', {
          cookie: admin,
          method: 'DELETE',
        })
      ).status
    ).toBe(200);
    expect(
      (
        (await (await call(t, '/api/setup/status')).json()) as {
          appName: string;
        }
      ).appName
    ).toBe('GitOrange');
  });

  it('validates values, rejects unknown keys, and is for site admins only', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const bad = await put(t, admin, 'ai.review_model', 'gpt-4');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain(
      'Workers AI model id'
    );
    expect((await put(t, admin, 'actions.retention_days', 0)).status).toBe(400);
    expect((await put(t, admin, 'actions.retention_days', null)).status).toBe(
      200
    ); // keep forever
    expect((await put(t, admin, 'nope', 1)).status).toBe(404);

    const member = await addMember(t, admin, 'grace');
    expect(
      (await call(t, '/api/admin/settings', { cookie: member })).status
    ).toBe(403);
    expect((await put(t, member, 'app.name', 'Mine')).status).toBe(403);
  });
});

describe('Actions retention', () => {
  async function seed() {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'internal' },
    });
    const repoId = (await t.env.DB.prepare(
      'SELECT id FROM repositories'
    ).first<{
      id: string;
    }>())!.id;
    const now = Date.UTC(2026, 9, 4) / 1000;
    const day = 86_400;
    const runs: [string, string, number | null][] = [
      ['old', 'completed', now - 100 * day],
      ['recent', 'completed', now - 10 * day],
      ['running', 'in_progress', null],
    ];
    for (const [i, [id, status, completed]] of runs.entries()) {
      await t.env.DB.prepare(
        `INSERT INTO workflow_runs (id, repository_id, run_number, workflow_path, name, event, ref, head_sha, display_title, status, conclusion, created_at, completed_at)
         VALUES (?, ?, ?, 'ci.yml', 'CI', 'push', 'refs/heads/main', 'abc', 'x', ?, ?, ?, ?)`
      )
        .bind(
          id,
          repoId,
          i + 1,
          status,
          status === 'completed' ? 'success' : null,
          now - 200 * day,
          completed
        )
        .run();
      await t.env.DB.prepare(
        `INSERT INTO workflow_jobs (id, run_id, job_key, name, runs_on, needs, status) VALUES (?, ?, 'test', 'test', 'ubuntu-latest', '[]', ?)`
      )
        .bind(`${id}-job`, id, status)
        .run();
      await t.env.ACTIONS_LOGS.put(
        `actions/${repoId}/${id}/${id}-job/1.log`,
        'log'
      );
    }
    return { t, admin, repoId, now: new Date(now * 1000) };
  }

  it('deletes finished runs older than the retention, with their jobs and logs', async () => {
    const { t, admin, repoId, now } = await seed();
    const db = drizzle(t.env.DB, { schema });
    const status = await runActionsRetention(t.env, db, now);
    expect(status).toMatchObject({
      retentionDays: 90,
      deletedRuns: 1,
      more: false,
    });
    const left = await t.env.DB.prepare(
      'SELECT id FROM workflow_runs ORDER BY id'
    ).all<{
      id: string;
    }>();
    expect(left.results.map((r) => r.id)).toEqual(['recent', 'running']);
    expect(
      (await t.env.DB.prepare(
        "SELECT COUNT(*) n FROM workflow_jobs WHERE run_id = 'old'"
      ).first<{
        n: number;
      }>())!.n
    ).toBe(0);
    const logs = await t.env.ACTIONS_LOGS.list({
      prefix: `actions/${repoId}/`,
    });
    expect(logs.objects.map((o) => o.key.split('/')[2]).sort()).toEqual([
      'recent',
      'running',
    ]);

    // Site admin shows what it did.
    const view = await get(t, admin);
    expect(view.actions).toMatchObject({
      runs: 2,
      retention: { deletedRuns: 1, retentionDays: 90 },
    });
  });

  it('follows the configured retention, and keeps everything when set to keep forever', async () => {
    const { t, admin, now } = await seed();
    const db = drizzle(t.env.DB, { schema });
    await put(t, admin, 'actions.retention_days', null);
    expect(await runActionsRetention(t.env, db, now)).toMatchObject({
      deletedRuns: 0,
    });
    await put(t, admin, 'actions.retention_days', 7);
    expect(await runActionsRetention(t.env, db, now)).toMatchObject({
      retentionDays: 7,
      deletedRuns: 2, // old and recent; the running one stays
    });
  });
});
