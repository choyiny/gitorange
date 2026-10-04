import { describe, expect, it } from 'vitest';
import { app } from '../index';
import { publishChange } from '../live/publish';
import { bootstrapAdmin, call, makeEnv, addMember } from './helpers/app';

/** Opens /api/live as a browser would and collects what it hears. */
async function listen(
  t: ReturnType<typeof makeEnv>,
  cookie: string,
  query = ''
) {
  const res = await app.fetch(
    new Request(`http://test.local/api/live${query}`, {
      headers: { Upgrade: 'websocket', Cookie: cookie },
    }),
    t.env,
    t.ctx
  );
  if (res.status !== 101)
    return { status: res.status, messages: [] as string[] };
  const ws = res.webSocket!;
  ws.accept();
  const messages: string[] = [];
  ws.addEventListener('message', (e) => messages.push(String(e.data)));
  return { status: 101, messages, ws };
}

const tick = () => new Promise((r) => setTimeout(r, 50));

describe('live updates', () => {
  it('pings a repository’s open pages, and approval inboxes, when it changes', async () => {
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
    const page = await listen(t, admin, '?repo=octocat/app');
    const elsewhere = await listen(t, admin);
    expect(page.status).toBe(101);

    await publishChange(t.env, repoId);
    await tick();
    expect(page.messages).toEqual(['{"type":"repo"}']);
    expect(elsewhere.messages).toEqual([]); // not following that repository

    await publishChange(t.env, repoId, { approvals: true });
    await tick();
    expect(elsewhere.messages).toEqual(['{"type":"approvals"}']);
    page.ws!.close();
    elsewhere.ws!.close();
  });

  it('pings after a successful change through the API', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'internal' },
    });
    const page = await listen(t, admin, '?repo=octocat/app');
    await call(t, '/api/repos/octocat/app', {
      cookie: admin,
      method: 'PATCH',
      json: { description: 'Live' },
    });
    await Promise.all(t.waits.splice(0));
    await tick();
    expect(page.messages).toContain('{"type":"repo"}');
    page.ws!.close();
  });

  it('only lets members follow repositories they can read', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'secret', visibility: 'private' },
    });
    const member = await addMember(t, admin, 'grace');
    expect((await listen(t, member, '?repo=octocat/secret')).status).toBe(404);
    expect((await listen(t, '', '')).status).toBe(401);
    const plain = await app.fetch(
      new Request('http://test.local/api/live', { headers: { Cookie: admin } }),
      t.env,
      t.ctx
    );
    expect(plain.status).toBe(426);
  });
});
