import { describe, expect, it } from 'vitest';
import { addMember, bootstrapAdmin, call, makeEnv } from './helpers/app';

type Page = {
  items: { repo: { fullName: string }; pull: { number: number } }[];
  count: number;
  nextCursor: string | null;
};

/**
 * Two internal repositories (members read, only the owner merges) with 150 open pull requests:
 * 140 waiting on a person — a failed review (1), two unapproved flags (2), or a recorded human_review
 * state (1) — and 10 waiting on nobody. Rows go straight into D1.
 */
async function manyApprovals() {
  const t = makeEnv();
  const admin = await bootstrapAdmin(t);
  for (const name of ['app1', 'app2'])
    expect(
      (
        await call(t, '/api/repos', {
          cookie: admin,
          json: { name, visibility: 'internal' },
        })
      ).status
    ).toBe(201);
  const repos = (
    await t.env.DB.prepare(
      'SELECT id, name, owner_id AS owner FROM repositories ORDER BY name'
    ).all<{ id: string; name: string; owner: string }>()
  ).results;
  const now = Math.floor(Date.now() / 1000);
  const stmts: D1PreparedStatement[] = [];
  const expected: { key: string; updatedAt: number; id: string }[] = [];
  let count = 0;
  for (let i = 0; i < 150; i++) {
    const repo = repos[i % 2];
    const id = `p${String(i).padStart(3, '0')}`;
    const number = i + 1;
    // Three pull requests share each updated_at, so the id breaks ties.
    const updatedAt = now - Math.floor(i / 3);
    stmts.push(
      t.env.DB.prepare(
        `INSERT INTO pull_requests (id, repository_id, number, title, body, author_id, base_ref, head_ref,
           state, merged_automatically, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', ?, 'main', ?, 'open', 0, ?, ?)`
      ).bind(id, repo.id, number, `PR ${i}`, repo.owner, id, now, updatedAt)
    );
    if (i >= 140) continue; // waiting on nobody
    const kind = i % 3;
    if (kind === 0) {
      stmts.push(
        t.env.DB.prepare(
          `INSERT INTO pr_classifications (id, pull_request_id, head_sha, policy_sha, status, summary_model, classifier_model, error_message, created_at)
           VALUES (?, ?, 'h', 'p', 'failed', 's', 'c', 'The classifier failed.', ?)`
        ).bind(`c${id}`, id, now)
      );
      count += 1;
    } else if (kind === 1) {
      stmts.push(
        t.env.DB.prepare(
          `INSERT INTO pr_classifications (id, pull_request_id, head_sha, policy_sha, status, summary_model, classifier_model, verdict, created_at)
           VALUES (?, ?, 'h', 'p', 'done', 's', 'c', 'human', ?)`
        ).bind(`c${id}`, id, now)
      );
      for (const key of ['a', 'b'])
        stmts.push(
          t.env.DB.prepare(
            `INSERT INTO pr_review_flags (id, classification_id, source, key, paths, created_at)
             VALUES (?, ?, 'question', ?, '[]', ?)`
          ).bind(`f${id}${key}`, `c${id}`, key, now)
        );
      count += 2;
    } else {
      stmts.push(
        t.env.DB.prepare(
          `INSERT INTO pr_events (id, repository_id, pull_request_id, kind, state, data, computed_at, created_at)
           VALUES (?, ?, ?, 'state_changed', 'human_review', '{"reasons":[]}', ?, ?)`
        ).bind(`e${id}`, repo.id, id, now * 1000, now * 1000)
      );
      count += 1;
    }
    expected.push({
      key: `octocat/${repo.name}#${number}`,
      updatedAt,
      id,
    });
  }
  await t.env.DB.batch(stmts);
  expected.sort((a, b) =>
    a.updatedAt !== b.updatedAt
      ? b.updatedAt - a.updatedAt
      : a.id < b.id
        ? 1
        : -1
  );
  return { t, admin, count, order: expected.map((e) => e.key) };
}

const page = async (
  t: ReturnType<typeof makeEnv>,
  cookie: string,
  query = ''
) => {
  const res = await call(t, `/api/approvals${query}`, { cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
};

describe('Approvals pagination', () => {
  it('pages through more than 100 open pull requests, each item once, in order', async () => {
    const { t, admin, count, order } = await manyApprovals();
    const first = await page(t, admin);
    expect(first.items).toHaveLength(25); // the default limit
    expect(first.count).toBe(count);
    expect(count).toBe(187); // 47 failed reviews, 47 × 2 flags, 46 human_review

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p: Page = await page(
        t,
        admin,
        `?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      );
      expect(p.count).toBe(count);
      expect(p.items.length).toBeLessThanOrEqual(30);
      seen.push(...p.items.map((i) => `${i.repo.fullName}#${i.pull.number}`));
      cursor = p.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(5); // 140 items: 30, 30, 30, 30, 20
    expect(seen).toEqual(order);

    const all = await page(t, admin, '?limit=100');
    expect(all.items).toHaveLength(100);
    expect(all.nextCursor).not.toBeNull();
    const rest = await page(
      t,
      admin,
      `?limit=100&cursor=${encodeURIComponent(all.nextCursor!)}`
    );
    expect(rest.items).toHaveLength(40);
    expect(rest.nextCursor).toBeNull();
  });

  it("shows a member who can't merge nothing, however much waits elsewhere", async () => {
    const { t, admin } = await manyApprovals();
    const bob = await addMember(t, admin, 'bob');
    expect(await page(t, bob)).toEqual({
      items: [],
      count: 0,
      nextCursor: null,
    });
  });

  it('rejects an invalid cursor or limit', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    for (const query of [
      '?cursor=nonsense',
      `?cursor=${btoa('12:')}`,
      `?cursor=${btoa('x:p001')}`,
      '?limit=0',
      '?limit=101',
    ]) {
      const res = await call(t, `/api/approvals${query}`, { cookie: admin });
      expect(res.status, query).toBe(400);
    }
  });
});
