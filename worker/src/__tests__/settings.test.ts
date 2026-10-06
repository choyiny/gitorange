import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { runActionsRetention } from '../actions/retention';
import { getSetting, PI_MAX_MINUTES } from '../lib/settings';
import {
  PI_DEFAULT_LIMITS,
  PI_EXPIRE_SLACK_MS,
  PI_RECHECK_MS,
  PI_START_SLACK_MS,
} from '../review/pi-contract';
import { REVIEW_STALE_MS } from '../review/head';
import { addMember, bootstrapAdmin, call, makeEnv } from './helpers/app';

type Setting = {
  key: string;
  value: unknown;
  default: unknown;
  overridden: boolean;
  group: string;
  min?: number;
  max?: number;
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

describe('Pi review settings', () => {
  it('has a deep review model and the Pi limits, defaulting to the built-in limits', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const { settings } = await get(t, admin);
    const by = (key: string) => settings.find((s) => s.key === key)!;
    expect(by('ai.review_pi_model')).toMatchObject({
      // The same default as the agent review model (REVIEW_MODEL in wrangler.test.jsonc).
      value: '@cf/zai-org/glm-5.3',
      default: by('ai.review_model').default,
      overridden: false,
      group: 'AI models',
    });
    expect(
      [
        'review.pi_minutes',
        'review.pi_max_tool_calls',
        'review.pi_max_model_calls',
        'review.pi_max_input_tokens',
      ].map((k) => [by(k).value, by(k).group])
    ).toEqual([
      [PI_DEFAULT_LIMITS.wallClockMs / 60_000, 'Reviews'],
      [PI_DEFAULT_LIMITS.maxToolCalls, 'Reviews'],
      [PI_DEFAULT_LIMITS.maxModelCalls, 'Reviews'],
      [PI_DEFAULT_LIMITS.maxInputTokens, 'Reviews'],
    ]);
  });

  it('keeps the limits sane, and the longest Pi review well inside the stale window', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const cases: [string, unknown[], number[]][] = [
      ['review.pi_minutes', [4, PI_MAX_MINUTES + 1, 30.5, '30', null], [5, 60]],
      ['review.pi_max_tool_calls', [4, 501, 0], [5, 500]],
      ['review.pi_max_model_calls', [4, 501, -1], [5, 500]],
      [
        'review.pi_max_input_tokens',
        [99_999, 50_000_001],
        [100_000, 50_000_000],
      ],
    ];
    for (const [key, bad, good] of cases) {
      for (const v of bad)
        expect((await put(t, admin, key, v)).status, `${key} = ${v}`).toBe(400);
      for (const v of good)
        expect((await put(t, admin, key, v)).status, `${key} = ${v}`).toBe(200);
    }
    expect((await put(t, admin, 'ai.review_pi_model', 'gpt-4o')).status).toBe(
      400
    );
    expect(
      (await put(t, admin, 'ai.review_pi_model', '@cf/qwen/qwen3-coder')).status
    ).toBe(200);
    // From the row's created_at: the start step's worst case, the longest allowed review, its last check and the
    // DO's own expiry all end before stale recovery (2 h) could fail a row that is still being reviewed.
    expect(
      PI_START_SLACK_MS +
        PI_MAX_MINUTES * 60_000 +
        PI_RECHECK_MS +
        PI_EXPIRE_SLACK_MS
    ).toBeLessThan(REVIEW_STALE_MS);
  });

  it('follows the resolved agent review model until it is overridden itself', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const pi = async () =>
      (await get(t, admin)).settings.find(
        (x) => x.key === 'ai.review_pi_model'
      )!;
    expect((await put(t, admin, 'ai.review_model', '@cf/a/x')).status).toBe(
      200
    );
    expect(await pi()).toMatchObject({
      value: '@cf/a/x',
      default: '@cf/a/x',
      overridden: false,
    });
    const db = drizzle(t.env.DB, { schema });
    expect(await getSetting(db, t.env, 'ai.review_pi_model')).toBe('@cf/a/x');
    expect((await put(t, admin, 'ai.review_pi_model', '@cf/b/y')).status).toBe(
      200
    );
    expect(await pi()).toMatchObject({ value: '@cf/b/y', overridden: true });
    expect(await getSetting(db, t.env, 'ai.review_pi_model')).toBe('@cf/b/y');
  });

  it('exposes numeric bounds to Site admin', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const { settings } = await get(t, admin);
    const by = (key: string) => settings.find((x) => x.key === key)!;
    expect(by('review.pi_max_input_tokens')).toMatchObject({
      min: 100_000,
      max: 50_000_000,
    });
    expect(by('review.pi_minutes')).toMatchObject({ min: 5, max: 60 });
  });
});
