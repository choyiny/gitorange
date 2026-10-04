import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { schema } from '../db/schema';
import { usersByCommitEmail } from '../lib/commit-authors';
import {
  addMember,
  bootstrapAdmin,
  call,
  makeEnv,
  type TestEnv,
} from './helpers/app';
import { commitFiles } from './helpers/seed';

type Alternate = {
  id: string;
  email: string;
  label: string | null;
  verified: boolean;
};
type Identity = {
  name: string;
  email: string;
  user: { username: string } | null;
};
type Commit = { hash: string; author: Identity; committer: Identity };

async function addEmail(
  t: TestEnv,
  cookie: string,
  email: string,
  label?: string
) {
  return call(t, '/api/emails', { cookie, json: { email, label } });
}

/** The token from the most recent verification email. */
function lastToken(t: TestEnv) {
  const m = t.sent.at(-1)?.text?.match(/verify\?token=(\S+)/);
  if (!m) throw new Error('no verification email');
  return m[1];
}

async function verify(t: TestEnv, cookie: string, token: string) {
  return call(t, '/api/emails/verify', { cookie, json: { token } });
}

async function addVerified(t: TestEnv, cookie: string, email: string) {
  expect((await addEmail(t, cookie, email)).status).toBe(201);
  expect((await verify(t, cookie, lastToken(t))).status).toBe(200);
}

describe('Settings → Emails', () => {
  it('adds an alternate unverified, lowercased, with a label, and emails a link', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const res = await addEmail(t, admin, '  Me@Work.Example ', 'Work');
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      email: Alternate;
      emailed: boolean;
    };
    expect(body.emailed).toBe(true);
    expect(body.email).toMatchObject({
      email: 'me@work.example',
      label: 'Work',
      verified: false,
    });
    const mail = t.sent.at(-1)!;
    expect(mail.to).toBe('me@work.example');
    expect(mail.subject).toBe('Verify your email for GitOrange');
    expect(mail.text).toMatch(
      /http:\/\/test\.local\/settings\/emails\/verify\?token=gve_[0-9a-f]+/
    );

    const list = (await (
      await call(t, '/api/emails', { cookie: admin })
    ).json()) as {
      primary: string;
      alternates: Alternate[];
      emailConfigured: boolean;
    };
    expect(list.primary).toBe('octocat@example.com');
    expect(list.emailConfigured).toBe(true);
    expect(list.alternates.map((a) => a.email)).toEqual(['me@work.example']);
  });

  it('validates format and label length', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    expect((await addEmail(t, admin, 'not-an-email')).status).toBe(400);
    expect(
      (await addEmail(t, admin, 'a@b.example', 'x'.repeat(41))).status
    ).toBe(400);
  });

  it('keeps an address unique across members and primaries', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const bob = await addMember(t, admin, 'bob');
    expect((await addEmail(t, admin, 'octocat@example.com')).status).toBe(409);
    expect((await addEmail(t, admin, 'BOB@example.com')).status).toBe(409);
    expect((await addEmail(t, admin, 'shared@example.com')).status).toBe(201);
    expect((await addEmail(t, admin, 'shared@example.com')).status).toBe(409);
    // Still reserved while the owner's link is valid, even unverified.
    expect((await addEmail(t, bob, 'shared@example.com')).status).toBe(409);
    // Invitations refuse it too.
    expect(
      (
        await call(t, '/api/invites', {
          cookie: admin,
          json: { email: 'shared@example.com' },
        })
      ).status
    ).toBe(409);
  });

  it('lets another member claim an address whose verification expired', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const bob = await addMember(t, admin, 'bob');
    await addEmail(t, admin, 'stale@example.com');
    await t.env.DB.prepare(
      'UPDATE user_emails SET verification_expires_at = ? WHERE email = ?'
    )
      .bind(Math.floor(Date.now() / 1000) - 60, 'stale@example.com')
      .run();
    expect((await addEmail(t, bob, 'stale@example.com')).status).toBe(201);
    const mine = (await (
      await call(t, '/api/emails', { cookie: admin })
    ).json()) as { alternates: Alternate[] };
    expect(mine.alternates).toEqual([]);
  });

  it('verifies only with a correct, unexpired token of the signed-in member', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const bob = await addMember(t, admin, 'bob');
    await addEmail(t, admin, 'me@work.example');
    const token = lastToken(t);

    expect((await verify(t, admin, 'gve_wrong')).status).toBe(404);
    // Someone else's link does nothing for them.
    expect((await verify(t, bob, token)).status).toBe(404);
    expect((await verify(t, '', token)).status).toBe(401);

    await t.env.DB.prepare(
      'UPDATE user_emails SET verification_expires_at = ? WHERE email = ?'
    )
      .bind(Math.floor(Date.now() / 1000) - 1, 'me@work.example')
      .run();
    expect((await verify(t, admin, token)).status).toBe(400);

    await t.env.DB.prepare(
      'UPDATE user_emails SET verification_expires_at = ? WHERE email = ?'
    )
      .bind(Math.floor(Date.now() / 1000) + 3600, 'me@work.example')
      .run();
    const ok = await verify(t, admin, token);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Alternate).verified).toBe(true);
    // Single use: the token is cleared.
    expect((await verify(t, admin, token)).status).toBe(404);
    const row = await t.env.DB.prepare(
      'SELECT verification_token_hash, verified_at FROM user_emails'
    ).first<{ verification_token_hash: string | null; verified_at: number }>();
    expect(row?.verification_token_hash).toBeNull();
    expect(row?.verified_at).toBeTruthy();
  });

  it('rate-limits resends to one a minute and issues a fresh link', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const { email } = (await (
      await addEmail(t, admin, 'me@work.example')
    ).json()) as { email: Alternate };
    const first = lastToken(t);
    const resend = () =>
      call(t, `/api/emails/${email.id}/resend`, {
        cookie: admin,
        method: 'POST',
      });
    expect((await resend()).status).toBe(429);
    await t.env.DB.prepare('UPDATE user_emails SET verification_sent_at = ?')
      .bind(Math.floor(Date.now() / 1000) - 61)
      .run();
    const again = await resend();
    expect(again.status).toBe(200);
    expect(((await again.json()) as { emailed: boolean }).emailed).toBe(true);
    const second = lastToken(t);
    expect(second).not.toBe(first);
    expect((await verify(t, admin, first)).status).toBe(404);
    expect((await verify(t, admin, second)).status).toBe(200);
    expect((await resend()).status).toBe(400); // already verified
  });

  it('keeps the row unverified and says so when email is not configured', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    (t.env as { EMAIL?: unknown }).EMAIL = undefined;
    const res = await addEmail(t, admin, 'me@work.example');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { email: Alternate; emailed: boolean };
    expect(body.emailed).toBe(false);
    expect(body.email.verified).toBe(false);
    const list = (await (
      await call(t, '/api/emails', { cookie: admin })
    ).json()) as { emailConfigured: boolean };
    expect(list.emailConfigured).toBe(false);
  });

  it('edits labels and deletes only your own rows', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const bob = await addMember(t, admin, 'bob');
    const { email } = (await (
      await addEmail(t, admin, 'me@work.example')
    ).json()) as { email: Alternate };
    const patch = await call(t, `/api/emails/${email.id}`, {
      cookie: admin,
      method: 'PATCH',
      json: { label: 'Personal' },
    });
    expect(((await patch.json()) as Alternate).label).toBe('Personal');
    expect(
      (
        await call(t, `/api/emails/${email.id}`, {
          cookie: bob,
          method: 'PATCH',
          json: { label: 'x' },
        })
      ).status
    ).toBe(404);
    await call(t, `/api/emails/${email.id}`, { cookie: bob, method: 'DELETE' });
    let list = (await (
      await call(t, '/api/emails', { cookie: admin })
    ).json()) as { alternates: Alternate[] };
    expect(list.alternates).toHaveLength(1);
    await call(t, `/api/emails/${email.id}`, {
      cookie: admin,
      method: 'DELETE',
    });
    list = (await (await call(t, '/api/emails', { cookie: admin })).json()) as {
      alternates: Alternate[];
    };
    expect(list.alternates).toHaveLength(0);
  });
});

describe('profile email', () => {
  it("shows a member's account email to other members, never for the team", async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const bob = await addMember(t, admin, 'bob');
    const res = await call(t, '/api/namespaces/octocat', { cookie: bob });
    const body = (await res.json()) as { owner: { email: string | null } };
    expect(body.owner.email).toBe('octocat@example.com');
  });
});

describe('commit attribution', () => {
  async function repoWithCommits() {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    const bob = await addMember(t, admin, 'bob');
    await call(t, '/api/repos', {
      cookie: admin,
      json: { name: 'app', visibility: 'internal' },
    });
    const repo = [...t.fake.repos.values()][0];
    const by = (name: string, email: string) => ({ name, email });
    await commitFiles(
      repo,
      'main',
      { a: '1' },
      'primary',
      undefined,
      by('Octo Cat', 'OctoCat@Example.com')
    );
    await commitFiles(
      repo,
      'main',
      { a: '2' },
      'verified alt',
      undefined,
      by('Bob B', 'bob@work.example')
    );
    await commitFiles(
      repo,
      'main',
      { a: '3' },
      'unverified alt',
      undefined,
      by('Bob B', 'bob@home.example')
    );
    await commitFiles(
      repo,
      'main',
      { a: '4' },
      'stranger',
      undefined,
      by('Someone', 'someone@else.example')
    );
    await addVerified(t, bob, 'bob@work.example');
    expect((await addEmail(t, bob, 'bob@home.example')).status).toBe(201);
    return { t, admin, bob };
  }

  it('links commits by account email and verified alternates only', async () => {
    const { t, bob } = await repoWithCommits();
    const res = await call(t, '/api/repos/octocat/app/commits?ref=main', {
      cookie: bob,
    });
    const { commits } = (await res.json()) as { commits: Commit[] };
    const byMsg = Object.fromEntries(
      commits.map((c) => [
        (c as unknown as { message: string }).message.trim(),
        c,
      ])
    );
    expect(byMsg['primary'].author.user?.username).toBe('octocat');
    expect(byMsg['primary'].committer.user?.username).toBe('octocat');
    expect(byMsg['verified alt'].author.user?.username).toBe('bob');
    expect(byMsg['unverified alt'].author.user).toBeNull();
    expect(byMsg['stranger'].author).toMatchObject({
      name: 'Someone',
      user: null,
    });
  });

  it('attributes the single-commit, latest-commit, and tree views', async () => {
    const { t, bob } = await repoWithCommits();
    const contents = (await (
      await call(t, '/api/repos/octocat/app/contents?refPath=', {
        cookie: bob,
      })
    ).json()) as { latestCommit: Commit; commitSha: string };
    expect(contents.latestCommit.author.user).toBeNull(); // the stranger
    const one = (await (
      await call(t, `/api/repos/octocat/app/commit/${contents.commitSha}`, {
        cookie: bob,
      })
    ).json()) as { commit: Commit };
    expect(one.commit.author.user).toBeNull();
    const tree = (await (
      await call(t, '/api/repos/octocat/app/tree-commits?ref=main', {
        cookie: bob,
      })
    ).json()) as Record<string, Commit>;
    expect(tree['a'].author).toHaveProperty('user', null);
  });

  it('looks up any number of emails in a fixed number of queries', async () => {
    const t = makeEnv();
    const admin = await bootstrapAdmin(t);
    await addVerified(t, admin, 'alt@example.com');
    let prepared = 0;
    const counting = new Proxy(t.env.DB, {
      get(target, prop, receiver) {
        if (prop === 'prepare')
          return (sql: string) => {
            prepared++;
            return target.prepare(sql);
          };
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const db = drizzle(counting, { schema });
    const emails = [
      'octocat@example.com',
      'ALT@example.com',
      ...Array.from({ length: 50 }, (_, i) => `x${i}@example.com`),
    ];
    const found = await usersByCommitEmail(db, emails);
    expect(prepared).toBe(2);
    expect(found.get('octocat@example.com')?.username).toBe('octocat');
    expect(found.get('alt@example.com')?.username).toBe('octocat');
    expect(found.size).toBe(2);
  });
});
