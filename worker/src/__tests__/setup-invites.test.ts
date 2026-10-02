import { describe, expect, it } from 'vitest';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  signIn,
} from './helpers/app';

describe('first-run setup', () => {
  it('reports setup required until the first admin exists, then closes', async () => {
    const t = makeEnv();
    expect(await (await call(t, '/api/setup/status')).json()).toEqual({
      setupRequired: true,
    });
    await bootstrapAdmin(t);
    expect(await (await call(t, '/api/setup/status')).json()).toEqual({
      setupRequired: false,
    });

    const again = await call(t, '/api/setup', {
      json: {
        name: 'Evil',
        username: 'evil',
        email: 'evil@example.com',
        password: 'password123',
      },
    });
    expect(again.status).toBe(403);
  });

  it('makes the first user a site admin', async () => {
    const t = makeEnv();
    const cookie = await bootstrapAdmin(t);
    const res = await call(t, '/api/auth/get-session', { cookie });
    const session = (await res.json()) as {
      user: { role: string; username: string };
    };
    expect(session.user.role).toBe('admin');
    expect(session.user.username).toBe('octocat');
  });

  it('rejects reserved usernames', async () => {
    const t = makeEnv();
    const res = await call(t, '/api/setup', {
      json: {
        name: 'X',
        username: 'settings',
        email: 'x@example.com',
        password: 'password123',
      },
    });
    expect(res.status).toBe(400);
  });

  it('does not allow public sign-up', async () => {
    const t = makeEnv();
    await bootstrapAdmin(t);
    const res = await call(t, '/api/auth/sign-up/email', {
      json: { name: 'X', email: 'x@example.com', password: 'password123' },
    });
    expect(res.ok).toBe(false);
  });
});

describe('invitations', () => {
  it('emails an invite link that creates a member exactly once', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const res = await call(t, '/api/invites', {
      cookie: admin,
      json: { email: 'Bob@Example.com', role: 'user' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      inviteUrl: string;
      emailed: boolean;
      invitation: { email: string };
    };
    expect(body.emailed).toBe(true);
    expect(body.invitation.email).toBe('bob@example.com');
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].text).toContain(body.inviteUrl);

    const token = body.inviteUrl.split('/invite/')[1];
    expect((await call(t, `/api/invites/token/${token}`)).status).toBe(200);
    const accept = await call(t, '/api/invites/accept', {
      json: { token, name: 'Bob', username: 'bob', password: 'password123' },
    });
    expect(accept.status).toBe(200);
    expect(await signIn(t, 'bob', 'password123')).toContain('session_token');

    const reuse = await call(t, '/api/invites/accept', {
      json: {
        token,
        name: 'Mallory',
        username: 'mallory',
        password: 'password123',
      },
    });
    expect(reuse.status).toBe(400);
  });

  it('stores only a hash of the invite token', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const res = await call(t, '/api/invites', {
      cookie: admin,
      json: { email: 'c@example.com' },
    });
    const { inviteUrl } = (await res.json()) as { inviteUrl: string };
    const token = inviteUrl.split('/invite/')[1];
    const row = await t.env.DB.prepare(
      'SELECT token_hash FROM invitations'
    ).first<{ token_hash: string }>();
    expect(row!.token_hash).not.toContain(token);
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('forbids members from inviting', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const bob = await addMember(t, admin, 'bob');
    expect(
      (
        await call(t, '/api/invites', {
          cookie: bob,
          json: { email: 'z@example.com' },
        })
      ).status
    ).toBe(403);
    expect(
      (await call(t, '/api/invites', { json: { email: 'z@example.com' } }))
        .status
    ).toBe(401);
  });

  it('refuses to invite an existing user', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const res = await call(t, '/api/invites', {
      cookie: admin,
      json: { email: 'octocat@example.com' },
    });
    expect(res.status).toBe(409);
  });
});
