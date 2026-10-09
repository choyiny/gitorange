import { describe, expect, it } from 'vitest';
import { agentColor } from '../agents/presets';
import { call, type TestEnv } from './helpers/app';
import { crewRepo } from './helpers/crew';
import { appRepo, invitedAgent, openPull } from './helpers/reviews';

type Listed = {
  pulls: {
    number: number;
    state: string;
    pullState: { state: string } | null;
    reviewers: {
      handle: string;
      name: string;
      color: string;
      status: string;
    }[];
  }[];
  openCount: number;
  closedCount: number;
  total: number;
};

async function list(t: TestEnv, cookie: string, query: string) {
  const res = await call(t, `/api/repos/octocat/app/pulls${query}`, {
    cookie,
  });
  return { status: res.status, body: (await res.json()) as Listed };
}

const numbers = (b: Listed) => b.pulls.map((p) => p.number);

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 1);

/**
 * Seven merged pull requests (numbers 1 to 7, merged in the order 3 5 1 7 6 4 2 from newest), two closed ones
 * (8 and 9) and two open ones (10 and 11).
 */
async function manyPulls() {
  const s = await crewRepo();
  const mergedAt = [5, 1, 7, 2, 6, 3, 4];
  for (const [i, h] of mergedAt.entries())
    await s.mergedRow(i + 1, `merged-${i + 1}`, T0 + h * HOUR);
  for (const name of ['closed-a', 'closed-b']) {
    await s.branch(name);
    const n = await s.web(name);
    const res = await call(s.t, `/api/repos/octocat/app/pulls/${n}`, {
      cookie: s.admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    expect(res.status).toBe(200);
  }
  for (const name of ['open-a', 'open-b']) {
    await s.branch(name);
    await s.web(name);
  }
  return s;
}

describe('pull request list: pages', () => {
  it('returns everything, as before, without a limit', async () => {
    const s = await manyPulls();
    const closed = await list(s.t, s.admin, '?state=closed');
    expect(numbers(closed.body)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(closed.body.total).toBe(9);
    const open = await list(s.t, s.admin, '');
    expect(numbers(open.body)).toEqual([11, 10]);
    expect(open.body.total).toBe(2);
  });

  it('lists the merged ones newest merge first, and pages them', async () => {
    const s = await manyPulls();
    const all = await list(s.t, s.admin, '?state=merged');
    expect(numbers(all.body)).toEqual([3, 5, 1, 7, 6, 4, 2]);
    expect(all.body.total).toBe(7);
    const first = await list(s.t, s.admin, '?state=merged&limit=3');
    expect(numbers(first.body)).toEqual([3, 5, 1]);
    expect(first.body.total).toBe(7);
    const second = await list(s.t, s.admin, '?state=merged&limit=3&page=2');
    expect(numbers(second.body)).toEqual([7, 6, 4]);
    const third = await list(s.t, s.admin, '?state=merged&limit=3&page=3');
    expect(numbers(third.body)).toEqual([2]);
    const past = await list(s.t, s.admin, '?state=merged&limit=3&page=4');
    expect(numbers(past.body)).toEqual([]);
    expect(past.body.total).toBe(7);
  });

  it('pages the closed ones (merged and closed together, newest number first)', async () => {
    const s = await manyPulls();
    const a = await list(s.t, s.admin, '?state=closed&limit=4');
    expect(numbers(a.body)).toEqual([9, 8, 7, 6]);
    expect(a.body.total).toBe(9);
    const c = await list(s.t, s.admin, '?state=closed&limit=4&page=3');
    expect(numbers(c.body)).toEqual([1]);
  });

  it('keeps the counts whatever the page', async () => {
    const s = await manyPulls();
    const { body } = await list(s.t, s.admin, '?state=merged&limit=1');
    expect(body.openCount).toBe(2);
    expect(body.closedCount).toBe(9);
  });

  it('pages the open ones, and a pull-state filter after it is applied', async () => {
    const s = await manyPulls();
    const p1 = await list(s.t, s.admin, '?limit=1');
    expect(numbers(p1.body)).toEqual([11]);
    expect(p1.body.total).toBe(2);
    expect(numbers((await list(s.t, s.admin, '?limit=1&page=2')).body)).toEqual(
      [10]
    );
    // Both open pull requests are in the same state; filter by it.
    const state = (await list(s.t, s.admin, '')).body.pulls[0].pullState!.state;
    const filtered = await list(s.t, s.admin, `?state=${state}&limit=1`);
    expect(numbers(filtered.body)).toEqual([11]);
    expect(filtered.body.total).toBe(2);
  });

  it('refuses a limit or a page out of range', async () => {
    const s = await manyPulls();
    for (const q of ['limit=0', 'limit=101', 'limit=x', 'limit=5&page=0'])
      expect((await list(s.t, s.admin, `?state=merged&${q}`)).status).toBe(400);
    expect((await list(s.t, s.admin, '?state=merged&limit=100')).status).toBe(
      200
    );
  });
});

describe('pull request list: search', () => {
  /** manyPulls, with merged 2 and 6 opened by Claude Code's session s4 and merged 4 by Codex's s5. */
  async function sessions() {
    const s = await manyPulls();
    await s.t.env.DB.prepare(
      "UPDATE pull_requests SET created_via = 'Claude Code', session_label = 's4' WHERE number IN (2, 6)"
    ).run();
    await s.t.env.DB.prepare(
      "UPDATE pull_requests SET created_via = 'Codex', session_label = 's5' WHERE number = 4"
    ).run();
    return s;
  }
  const find = async (
    s: { t: TestEnv; admin: string },
    q: string,
    extra = ''
  ) => list(s.t, s.admin, `?state=merged&q=${encodeURIComponent(q)}${extra}`);

  it('matches a number, with or without the hash, and the start of one', async () => {
    const s = await sessions();
    expect(numbers((await find(s, '#5')).body)).toEqual([5]);
    // Plain digits are the start of a number, or anywhere in the text: #4's session is s5.
    expect(numbers((await find(s, '5')).body)).toEqual([5, 4]);
    expect(numbers((await find(s, '#50')).body)).toEqual([]);
  });

  it('matches the title and the branch, every word of it, without caring about case', async () => {
    const s = await sessions();
    expect(numbers((await find(s, 'MERGED 3')).body)).toEqual([3]);
    expect(numbers((await find(s, 'merged-7')).body)).toEqual([7]);
    expect(numbers((await find(s, 'merged zebra')).body)).toEqual([]);
  });

  it('matches the app and the session, with the dot or without', async () => {
    const s = await sessions();
    expect(numbers((await find(s, 'claude s4')).body)).toEqual([6, 2]);
    expect(numbers((await find(s, 'Claude·s4')).body)).toEqual([6, 2]);
    expect(numbers((await find(s, 'codex')).body)).toEqual([4]);
    expect(numbers((await find(s, 's5')).body)).toEqual([4]);
  });

  it('matches "by hand" on the pull requests no app opened', async () => {
    const s = await sessions();
    expect(numbers((await find(s, 'by hand')).body)).toEqual([3, 5, 1, 7]);
  });

  it('matches the author by username', async () => {
    const s = await sessions();
    expect((await find(s, 'octocat')).body.total).toBe(7);
    expect((await find(s, 'nobody')).body.total).toBe(0);
  });

  it('takes % and _ as themselves, not as wildcards', async () => {
    const s = await sessions();
    expect(numbers((await find(s, '%')).body)).toEqual([]);
    expect(numbers((await find(s, 'merged_')).body)).toEqual([]);
  });

  it('counts and pages the matches, not the whole list', async () => {
    const s = await sessions();
    const first = await find(s, 'claude', '&limit=1');
    expect(numbers(first.body)).toEqual([6]);
    expect(first.body.total).toBe(2);
    expect(numbers((await find(s, 'claude', '&limit=1&page=2')).body)).toEqual([
      2,
    ]);
    // The repository's own counts do not change with a search.
    expect(first.body.closedCount).toBe(9);
  });

  it('searches the closed list too, and an open list', async () => {
    const s = await sessions();
    const closed = await list(s.t, s.admin, '?state=closed&q=closed-a');
    expect(closed.body.total).toBe(1);
    const open = await list(s.t, s.admin, '?q=open-b');
    expect(numbers(open.body)).toEqual([11]);
    expect(open.body.total).toBe(1);
  });

  it('ignores a blank search, and refuses a long one', async () => {
    const s = await sessions();
    expect(
      (await list(s.t, s.admin, '?state=merged&q=%20%20')).body.total
    ).toBe(7);
    expect(
      (await list(s.t, s.admin, `?state=merged&q=${'a'.repeat(101)}`)).status
    ).toBe(400);
  });
});

describe('pull request list: reviewers', () => {
  async function reviewed() {
    const { t, admin, repo } = await appRepo();
    for (const handle of ['dataagent', 'secagent', 'speedagent', 'fixagent'])
      await invitedAgent(t, admin, handle);
    const { head, number } = await openPull(t, admin, repo, {
      'src/b.ts': 'export const b = 2;\n',
    });
    return { t, admin, head, number };
  }

  async function row(
    t: TestEnv,
    number: number,
    handle: string,
    head: string,
    status: string,
    opts: { requested?: boolean; at?: number } = {}
  ) {
    await t.env.DB.prepare(
      `INSERT OR REPLACE INTO pr_reviewers (id, pull_request_id, head_sha, agent_id, requested, status, created_at)
       SELECT ?, p.id, ?, u.id, ?, ?, ?
         FROM pull_requests p, users u, repositories r
        WHERE p.repository_id = r.id AND r.name = 'app' AND p.number = ? AND u.username = ?`
    )
      .bind(
        `${number}-${handle}-${head.slice(0, 8)}`,
        head,
        opts.requested === false ? 0 : 1,
        status,
        opts.at ?? 1_790_000_000,
        number,
        handle
      )
      .run();
  }

  it("lists the requested agents' reviews of the current head, by handle, with name and colour", async () => {
    const { t, admin, head, number } = await reviewed();
    await row(t, number, 'secagent', head, 'approved');
    await row(t, number, 'dataagent', head, 'flagged');
    await row(t, number, 'fixagent', head, 'reviewing');
    // Invited, but Clef did not wake it for this commit.
    await row(t, number, 'speedagent', head, 'not_needed', {
      requested: false,
    });
    const { body } = await list(t, admin, '');
    expect(body.pulls[0].reviewers).toEqual([
      {
        handle: 'dataagent',
        name: 'dataagent agent',
        color: agentColor({ color: null }, 'dataagent'),
        status: 'flagged',
      },
      {
        handle: 'fixagent',
        name: 'fixagent agent',
        color: agentColor({ color: null }, 'fixagent'),
        status: 'reviewing',
      },
      {
        handle: 'secagent',
        name: 'secagent agent',
        color: agentColor({ color: null }, 'secagent'),
        status: 'approved',
      },
    ]);
  });

  it('leaves out an agent whose requested row is not needed, and reads only the current head', async () => {
    const { t, admin, head, number } = await reviewed();
    const older = 'f'.repeat(40);
    // It flagged an earlier commit and is not needed for this one.
    await row(t, number, 'secagent', older, 'flagged', { at: 1_780_000_000 });
    await row(t, number, 'secagent', head, 'not_needed', { requested: false });
    await row(t, number, 'dataagent', older, 'changes_requested', {
      at: 1_780_000_000,
    });
    await row(t, number, 'dataagent', head, 'approved');
    const { body } = await list(t, admin, '');
    expect(body.pulls[0].reviewers.map((r) => [r.handle, r.status])).toEqual([
      ['dataagent', 'approved'],
    ]);
  });

  it('has none for a pull request nobody reviewed, or one that is closed', async () => {
    const { t, admin, head, number } = await reviewed();
    expect((await list(t, admin, '')).body.pulls[0].reviewers).toEqual([]);
    await row(t, number, 'secagent', head, 'approved');
    await call(t, `/api/repos/octocat/app/pulls/${number}`, {
      cookie: admin,
      method: 'PATCH',
      json: { state: 'closed' },
    });
    const closed = await list(t, admin, '?state=closed');
    expect(closed.body.pulls).toHaveLength(1);
    expect(closed.body.pulls[0].reviewers).toEqual([]);
  });

  it('uses an agent’s own colour when AGENT.md declares one', async () => {
    const { t, admin, head, number } = await reviewed();
    await t.env.DB.prepare(
      "UPDATE agents SET color = '#123456' WHERE user_id = (SELECT id FROM users WHERE username = 'secagent')"
    ).run();
    await row(t, number, 'secagent', head, 'approved');
    const { body } = await list(t, admin, '');
    expect(body.pulls[0].reviewers[0].color).toBe('#123456');
  });
});
