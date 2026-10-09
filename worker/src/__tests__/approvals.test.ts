import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { decideFinding } from '../review/delegate';
import {
  fakeDecider,
  flagCall,
  guard,
  QUESTION,
  questionedPull,
  userId,
} from './helpers/findings';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  settle,
} from './helpers/app';
import { newAgent } from './helpers/agents';
import { commitPaths } from './helpers/seed';
import {
  AGENT_MD,
  agentModels,
  appRepo,
  BASE,
  invitedAgent,
  openPull,
  runReviews,
  startReview,
} from './helpers/reviews';

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
  await newAgent(t, admin, 'secagent', 'Security');
  for (const name of ['app1', 'app2'])
    expect(
      (
        await call(t, `/api/repos/octocat/${name}/agents/secagent`, {
          cookie: admin,
          method: 'PUT',
        })
      ).status
    ).toBe(200);
  const agentId = (await t.env.DB.prepare('SELECT user_id FROM agents').first<{
    user_id: string;
  }>())!.user_id;
  const repos = (
    await t.env.DB.prepare(
      `SELECT id, name, owner_id AS owner, artifacts_name AS artifacts FROM repositories WHERE name LIKE 'app%' ORDER BY name`
    ).all<{ id: string; name: string; owner: string; artifacts: string }>()
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
    // Its branch is at commit 'h', the commit its review (if any) is of.
    t.fake.repos.get(repo.artifacts)!.refs.set(`refs/heads/${id}`, 'h');
    if (i >= 140) continue; // waiting on nobody
    const kind = i % 3;
    if (kind === 0) {
      stmts.push(
        t.env.DB.prepare(
          `INSERT INTO pr_classifications (id, pull_request_id, head_sha, status, summary_model, classifier_model, error_message, created_at)
           VALUES (?, ?, 'h', 'failed', 's', 'c', 'The review could not be started.', ?)`
        ).bind(`${id}-h`, id, now)
      );
      count += 1;
    } else if (kind === 1) {
      stmts.push(
        t.env.DB.prepare(
          `INSERT INTO pr_classifications (id, pull_request_id, head_sha, status, summary_model, classifier_model, created_at)
           VALUES (?, ?, 'h', 'done', 's', 'c', ?)`
        ).bind(`${id}-h`, id, now),
        t.env.DB.prepare(
          `INSERT INTO pr_reviewers (id, pull_request_id, head_sha, agent_id, requested, agent_sha, status, created_at)
           VALUES (?, ?, 'h', ?, 1, 'a', 'flagged', ?)`
        ).bind(`r${id}`, id, agentId, now)
      );
      for (const key of ['a', 'b'])
        stmts.push(
          t.env.DB.prepare(
            `INSERT INTO pr_review_flags (id, classification_id, key, value, paths, agent_id, kind, created_at)
             VALUES (?, ?, ?, '{"title":"T"}', '[]', ?, 'needs_person', ?)`
          ).bind(`f${id}${key}`, `${id}-h`, `${agentId}:${key}`, agentId, now)
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
      assignedToMe: 0,
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

describe('Approvals items', () => {
  it('groups findings for a person by agent, lists failed agent reviews, and leaves change requests to the agent', async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    await invitedAgent(t, admin, 'dataagent', AGENT_MD());
    await openPull(t, admin, repo, { 'src/b.ts': 'b\n' });
    await startReview(t);
    const finding = (
      kind: 'needs_person' | 'change_requested',
      title: string
    ) => ({
      kind,
      title,
      detail: 'Detail.',
      changes: [],
      diagram: null,
      snippets: [],
      paths: [],
    });
    await runReviews(
      t,
      agentModels({
        failReview: ['dataagent'],
        review: () => ({
          verdict: 'findings',
          summary: '',
          findings: [
            finding('needs_person', 'Export'),
            finding('change_requested', 'Name it'),
          ],
        }),
      }).models
    );
    const res = (await (
      await call(t, '/api/approvals', { cookie: admin })
    ).json()) as {
      items: {
        needsApproval: boolean;
        agents: {
          agent: { username: string };
          status: string;
          error: string | null;
          flags: { title: string; kind: string }[];
        }[];
      }[];
      count: number;
    };
    expect(res.items).toHaveLength(1);
    expect(res.items[0].needsApproval).toBe(false);
    expect(res.items[0].agents).toMatchObject([
      {
        agent: { username: 'dataagent' },
        status: 'failed',
        error: 'The review model failed: model down',
        flags: [],
      },
      {
        agent: { username: 'secagent' },
        status: 'changes_requested',
        flags: [{ title: 'Export', kind: 'needs_person' }],
      },
    ]);
    expect(res.count).toBe(2); // one finding for a person, one failed review
  });

  it("lists a pull request that needs a person's approval", async () => {
    const { t, admin, repo } = await appRepo();
    await openPull(t, admin, repo, { 'src/b.ts': 'b\n' });
    const res = (await (
      await call(t, '/api/approvals', { cookie: admin })
    ).json()) as {
      items: {
        needsApproval: boolean;
        agents: unknown[];
        pull: { headSha: string | null };
      }[];
      count: number;
    };
    expect(res.items).toMatchObject([{ needsApproval: true, agents: [] }]);
    expect(res.items[0].pull.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.count).toBe(1);
    await call(t, '/api/repos/octocat/app/pulls/1/approval', {
      cookie: admin,
      method: 'POST',
    });
    await settle(t); // the approval settles the pull request's recorded state
    const after = (await (
      await call(t, '/api/approvals', { cookie: admin })
    ).json()) as {
      items: unknown[];
    };
    expect(after.items).toEqual([]);
  });

  const needsPerson = {
    verdict: 'findings' as const,
    summary: '',
    findings: [
      {
        kind: 'needs_person' as const,
        title: 'Export',
        detail: 'Exports b.',
        changes: [],
        diagram: null,
        snippets: [],
        paths: [],
      },
    ],
  };
  const inbox = async (t: ReturnType<typeof makeEnv>, cookie: string) =>
    (await (await call(t, '/api/approvals', { cookie })).json()) as {
      items: {
        reviewFailed: string | null;
        agents: { status: string; flags: { id: string }[] }[];
      }[];
      count: number;
    };

  async function flagged() {
    const f = await appRepo();
    await invitedAgent(f.t, f.admin, 'secagent', AGENT_MD());
    await openPull(f.t, f.admin, f.repo, { 'src/b.ts': 'b\n' });
    await startReview(f.t);
    await runReviews(f.t, agentModels({ review: () => needsPerson }).models);
    return f;
  }

  it('drops a finding once a person approves it', async () => {
    const { t, admin } = await flagged();
    const before = await inbox(t, admin);
    expect(before.count).toBe(1);
    const flagId = before.items[0].agents[0].flags[0].id;
    expect(
      (
        await call(
          t,
          `/api/repos/octocat/app/pulls/1/review/flags/${flagId}/approve`,
          { cookie: admin, method: 'POST' }
        )
      ).status
    ).toBe(200);
    await settle(t);
    const after = await inbox(t, admin);
    expect(after.items).toEqual([]);
    expect(after.count).toBe(0);
  });

  it("doesn't leak a private repository's items to people who can't merge there", async () => {
    const { t, admin } = await flagged();
    const bob = await addMember(t, admin, 'bob');
    await t.env.DB.prepare(
      `UPDATE repositories SET visibility = 'private'`
    ).run();
    expect(await inbox(t, bob)).toEqual({
      items: [],
      count: 0,
      assignedToMe: 0,
      nextCursor: null,
    });
    expect((await inbox(t, admin)).count).toBe(1);
    // A collaborator with write access does see them.
    await call(t, '/api/repos/octocat/app/collaborators/bob', {
      cookie: admin,
      method: 'PUT',
    });
    expect((await inbox(t, bob)).count).toBe(1);
  });

  it('agrees with the repository insights on how many findings wait', async () => {
    const { t, admin } = await flagged();
    const res = await call(t, '/api/repos/octocat/app/insights', {
      cookie: admin,
    });
    const body = (await res.json()) as {
      flags: { pendingNow: number; pendingPullsNow: number };
    };
    expect((await inbox(t, admin)).count).toBe(1);
    expect(body.flags).toMatchObject({ pendingNow: 1, pendingPullsNow: 1 });
  });

  it("shows the review of the branch's current commit, not the newest review (and insights agree)", async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    const { head: first } = await openPull(t, admin, repo, {
      'src/b.ts': 'b\n',
    });
    const finding = (title: string) => ({
      kind: 'needs_person' as const,
      title,
      detail: 'Detail.',
      changes: [],
      diagram: null,
      snippets: [],
      paths: [],
    });
    const findings = (...titles: string[]) =>
      agentModels({
        review: () => ({
          verdict: 'findings',
          summary: '',
          findings: titles.map(finding),
        }),
      }).models;
    await startReview(t);
    await runReviews(t, findings('First A', 'First B'));
    // A second commit, reviewed later, then the branch goes back to the first (a force-push).
    await commitPaths(
      repo,
      'feature',
      { ...BASE, 'src/b.ts': 'b\n', 'src/c.ts': 'c\n' },
      'More'
    );
    await startReview(t);
    await runReviews(t, findings('Second'));
    await t.env.DB.prepare(
      'UPDATE pr_classifications SET created_at = created_at - 3600 WHERE head_sha = ?'
    )
      .bind(first)
      .run();
    repo.refs.set('refs/heads/feature', first);
    const res = (await (
      await call(t, '/api/approvals', { cookie: admin })
    ).json()) as {
      items: {
        pull: { headSha: string };
        agents: { flags: { title: string }[] }[];
      }[];
      count: number;
    };
    expect(res.items).toHaveLength(1);
    expect(res.items[0].pull.headSha).toBe(first);
    expect(res.items[0].agents[0].flags.map((f) => f.title)).toEqual([
      'First A',
      'First B',
    ]);
    expect(res.count).toBe(2);
    const insights = (await (
      await call(t, '/api/repos/octocat/app/insights', { cookie: admin })
    ).json()) as { flags: { pendingNow: number } };
    expect(insights.flags.pendingNow).toBe(2);
  });

  it("reads branch tips only where the viewer can merge, and keeps an item whose tips can't be read", async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    const { head } = await openPull(t, admin, repo, { 'src/b.ts': 'b\n' });
    await startReview(t);
    await runReviews(
      t,
      agentModels({
        review: () => ({
          verdict: 'findings',
          summary: '',
          findings: [
            {
              kind: 'needs_person',
              title: 'Export',
              detail: 'Detail.',
              changes: [],
              diagram: null,
              snippets: [],
              paths: [],
            },
          ],
        }),
      }).models
    );
    const advertise = repo.advertisement.bind(repo);
    let reads = 0;
    let unreadable = false;
    repo.advertisement = () => {
      reads += 1;
      if (unreadable) throw new Error('refs unreadable');
      return advertise();
    };
    type Items = {
      items: { pull: { headSha: string | null }; agents: unknown[] }[];
      count: number;
    };
    const inboxOf = async (cookie: string) =>
      (await (await call(t, '/api/approvals', { cookie })).json()) as Items;
    // bob reads octocat/app but can't merge there: nothing to show, and no refs read for it.
    const bob = await addMember(t, admin, 'bob');
    expect(await inboxOf(bob)).toMatchObject({ items: [], count: 0 });
    expect(reads).toBe(0);
    expect((await inboxOf(admin)).items).toHaveLength(1);
    expect(reads).toBe(1);
    // Refs can't be read: the item stays, with its newest review.
    unreadable = true;
    const res = await inboxOf(admin);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].pull.headSha).toBe(head);
    expect(res.items[0].agents).toHaveLength(1);
    expect(res.count).toBe(1);
  });

  it('counts a failed review once, however many agents it failed, and still shows each retry target', async () => {
    const { t, admin, repo } = await appRepo();
    await invitedAgent(t, admin, 'secagent', AGENT_MD());
    await invitedAgent(t, admin, 'dataagent', AGENT_MD());
    await openPull(t, admin, repo, { 'src/b.ts': 'b\n' });
    await startReview(t);
    await runReviews(
      t,
      agentModels({ failReview: ['secagent', 'dataagent'] }).models
    );
    await t.env.DB.prepare(
      `UPDATE pr_classifications SET status = 'failed', error_message = 'Review failed.'`
    ).run();
    const res = await inbox(t, admin);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].reviewFailed).toBe('Review failed.');
    expect(res.items[0].agents.map((a) => a.status)).toEqual([
      'failed',
      'failed',
    ]);
    expect(res.count).toBe(1);
  });
});

describe('Approvals: who decides each finding', () => {
  type Flag = {
    id: string;
    question: string | null;
    guarded: boolean;
    assignee: { login: string } | null;
    decidedVia: string | null;
    reason: string | null;
    teach: string | null;
    changesRequestedNote: string | null;
  };
  const flagsOf = async (t: ReturnType<typeof makeEnv>, cookie: string) => {
    const body = (await (
      await call(t, '/api/approvals', { cookie })
    ).json()) as {
      assignedToMe: number;
      items: { agents: { flags: Flag[] }[] }[];
    };
    return {
      assignedToMe: body.assignedToMe,
      flags: body.items.flatMap((i) => i.agents.flatMap((a) => a.flags)),
    };
  };

  it("shows a finding GitOrange AI sent back, with its reason, and a guarded agent's finding as guarded", async () => {
    const { t, admin, person } = await questionedPull();
    const db = drizzle(t.env.DB, { schema });
    const result = await decideFinding(t.env, db, person.id, await userId(t), {
      model: fakeDecider(() => ({
        decision: 'request_changes',
        reason: 'Ask which invoices were in US dollars.',
      })).model,
      after: (w) => t.ctx.waitUntil(w),
    });
    expect(result).toMatchObject({ ok: true, applied: true });
    await settle(t);
    const before = await flagsOf(t, admin);
    expect(before.assignedToMe).toBe(0);
    expect(before.flags).toMatchObject([
      {
        id: person.id,
        question: QUESTION,
        guarded: false,
        assignee: null,
        decidedVia: 'GitOrange AI',
        reason: 'Ask which invoices were in US dollars.',
        changesRequestedNote: 'Ask which invoices were in US dollars.',
        teach: null,
      },
    ]);
    await guard(t, 'dataagent');
    expect((await flagsOf(t, admin)).flags[0].guarded).toBe(true);
    // Assigned to yourself: counted.
    await flagCall(t, admin, person.id, 'assign', { login: 'octocat' });
    expect(await flagsOf(t, admin)).toMatchObject({
      assignedToMe: 1,
      flags: [{ assignee: { login: 'octocat' } }],
    });
  });
});
