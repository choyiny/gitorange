import { describe, expect, it } from 'vitest';
import { addMember, call } from './helpers/app';
import { connect, tool } from './helpers/mcp';
import {
  closedLesson,
  fakeLearner,
  learnedMd,
  lessons,
  runLessons,
  SUMMARY,
} from './helpers/lessons';

/** @secagent learned from #1: one committed lesson. */
async function learned() {
  const s = await closedLesson();
  await runLessons(
    s.t,
    fakeLearner(() => ({ state: 'done', text: SUMMARY }), {
      files: () => ({ 'AGENT.md': learnedMd('secagent') }),
    }).api
  );
  return { ...s, lesson: (await lessons(s.t))[0] };
}

describe('what agents learned, where people look', () => {
  it("lists the agent's lessons on its profile, as the viewer may see them", async () => {
    const { t, admin, lesson } = await learned();
    const bob = await addMember(t, admin, 'bob');
    const profile = async (cookie: string) =>
      (
        (await (
          await call(t, '/api/namespaces/secagent', { cookie })
        ).json()) as { agent: { lessons: unknown[] } }
      ).agent.lessons;
    const expected = {
      id: lesson.id,
      repository: 'octocat/app',
      number: 1,
      title: 'Change things',
      findings: ['Token logged', 'No expiry'],
      status: 'committed',
      commitSha: lesson.commit_sha,
      summary: SUMMARY,
      error: null,
      createdAt: expect.any(String),
      finishedAt: expect.any(String),
    };
    expect(await profile(admin)).toEqual([expected]);
    expect(await profile(bob)).toEqual([expected]);
    // octocat/app turns private: bob no longer sees its pull request, nor the lesson.
    await t.env.DB.prepare(
      `UPDATE repositories SET visibility = 'private' WHERE name = 'app'`
    ).run();
    expect(await profile(bob)).toEqual([]);
    expect(await profile(admin)).toEqual([expected]);
  });

  it("adds a learned event to the pull request's timeline", async () => {
    const { t, admin, lesson } = await learned();
    const body = (await (
      await call(t, '/api/repos/octocat/app/pulls/1', { cookie: admin })
    ).json()) as {
      events: {
        kind: string;
        data: Record<string, unknown>;
        actor: { username: string } | null;
      }[];
    };
    const event = body.events.find((e) => e.kind === 'learned')!;
    expect(event.data).toEqual({
      handle: 'secagent',
      findings: 2,
      sha: lesson.commit_sha,
      repository: 'secagent/secagent',
    });
    expect(event.actor?.username).toBe('secagent');
  });

  it("gitorange_list_agents includes each agent's latest lessons", async () => {
    const { t, admin, lesson } = await learned();
    const token = (await connect(t, admin)).access_token as string;
    const listed = await tool(t, token, 'gitorange_list_agents');
    const [agent] = JSON.parse(listed.content[0].text) as {
      handle: string;
      lessons: unknown[];
    }[];
    expect(agent.handle).toBe('secagent');
    expect(agent.lessons).toEqual([
      {
        pull_request: 'octocat/app#1',
        status: 'committed',
        commit: lesson.commit_sha,
        summary: SUMMARY,
        error: null,
        finished_at: expect.any(String),
      },
    ]);
  });

  it('counts, per agent, the change requests people dismissed and the lessons it committed', async () => {
    const { t, admin } = await learned();
    const body = (await (
      await call(t, '/api/repos/octocat/app/insights', { cookie: admin })
    ).json()) as { learning: unknown };
    expect(body.learning).toEqual([
      { handle: 'secagent', dismissed: 2, lessonsCommitted: 1 },
    ]);
  });
});
