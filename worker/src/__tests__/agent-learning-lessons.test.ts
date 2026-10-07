import { describe, expect, it } from 'vitest';
import { call } from './helpers/app';
import { agentModels, BASE, runReviews, startReview } from './helpers/reviews';
import { commitPaths } from './helpers/seed';
import {
  CHANGE,
  closePull,
  decide,
  FINDINGS,
  findings,
  lessons,
  mergePull,
  ONE_CHANGE_REQUEST,
  reviewedPull,
} from './helpers/lessons';

const changeRequests = async (
  t: Awaited<ReturnType<typeof reviewedPull>>['t'],
  agent = 'secagent'
) =>
  (await findings(t)).filter(
    (f) => f.agent === agent && f.kind === 'change_requested'
  );

describe('lessons from dismissed change requests', () => {
  it('queues one lesson per agent whose change requests a person dismissed, when the pull request closes', async () => {
    const { t, admin } = await reviewedPull(['perfagent', 'secagent']);
    const sec = await changeRequests(t);
    for (const f of sec) await decide(t, admin, f.id);
    // perfagent: only its finding for a person is approved; its change requests stay open.
    const person = (await findings(t)).find(
      (f) => f.agent === 'perfagent' && f.kind === 'needs_person'
    )!;
    await decide(t, admin, person.id);
    // Nothing while the pull request is open.
    expect(await lessons(t)).toEqual([]);

    await closePull(t, admin);
    const rows = await lessons(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: 'secagent',
      status: 'pending',
      attempts: 0,
      run_id: null,
      base_sha: null,
      commit_sha: null,
      retryable: 0,
    });
    expect(JSON.parse(rows[0].finding_ids)).toEqual(sec.map((f) => f.id));
  });

  it('queues nothing when no change request was dismissed', async () => {
    const { t, admin } = await reviewedPull();
    const person = (await findings(t)).find((f) => f.kind === 'needs_person')!;
    await decide(t, admin, person.id);
    await closePull(t, admin);
    expect(await lessons(t)).toEqual([]);
  });

  it('learns once: reopening and closing again adds no second lesson', async () => {
    const { t, admin } = await reviewedPull();
    for (const f of await changeRequests(t)) await decide(t, admin, f.id);
    await closePull(t, admin);
    const [first] = await lessons(t);
    await closePull(t, admin, 'open');
    await closePull(t, admin);
    expect((await lessons(t)).map((l) => l.id)).toEqual([first.id]);
  });

  it('queues a lesson when the pull request merges (merge button)', async () => {
    // The finding for a person stays open, so nothing auto-merges before the merge button.
    const { t, admin } = await reviewedPull();
    const crs = await changeRequests(t);
    for (const f of crs) await decide(t, admin, f.id);
    expect(await lessons(t)).toEqual([]);
    await mergePull(t, admin);
    const rows = await lessons(t);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].finding_ids)).toEqual(crs.map((f) => f.id));
  });

  it('queues a lesson when the pull request auto-merges', async () => {
    // Dismissing the only change request clears the review gate: the pull request lands by itself.
    const { t, admin } = await reviewedPull(['secagent'], ONE_CHANGE_REQUEST);
    const [cr] = await changeRequests(t);
    await decide(t, admin, cr.id);
    const rows = await lessons(t);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].finding_ids)).toEqual([cr.id]);
  });

  it('counts a change request dismissed on an earlier commit of the pull request', async () => {
    const { t, admin, repo } = await reviewedPull();
    const [cr] = await changeRequests(t);
    await decide(t, admin, cr.id);
    // A newer commit, reviewed again; its findings stay open, so the pull request stays open.
    await commitPaths(
      repo,
      'feature',
      { ...BASE, ...CHANGE, 'src/more.ts': 'export const b = 1;\n' },
      'More'
    );
    await startReview(t);
    await runReviews(t, agentModels({ review: () => FINDINGS }).models);
    await closePull(t, admin);
    expect(JSON.parse((await lessons(t))[0].finding_ids)).toEqual([cr.id]);
  });

  it('skips an agent deleted before the pull request closed', async () => {
    const { t, admin } = await reviewedPull();
    for (const f of await changeRequests(t)) await decide(t, admin, f.id);
    const res = await call(t, '/api/admin/agents/secagent', {
      cookie: admin,
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    await closePull(t, admin);
    expect(await lessons(t)).toEqual([]);
  });
});
