import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { schema } from './db/schema';
import { personalAccessTokens, repositories } from './db/app.schema';
import { users } from './db/auth.schema';
import { findRepo, gitFor, permissionsFor } from './lib/repos';
import { hashToken } from './lib/tokens';

const GIT_PATH =
  /^\/([^/]+)\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function isGitRequest(url: URL) {
  return GIT_PATH.test(url.pathname);
}

function unauthorized(realm: string) {
  return new Response(
    'Authentication required. Use a personal access token as the password.\n',
    {
      status: 401,
      headers: {
        'WWW-Authenticate': `Basic realm="${realm}"`,
        'Content-Type': 'text/plain',
      },
    }
  );
}

function parseBasic(
  header: string | null
): { user: string; pass: string } | null {
  if (!header?.startsWith('Basic ')) return null;
  try {
    const decoded = atob(header.slice(6));
    const i = decoded.indexOf(':');
    return i < 0
      ? { user: decoded, pass: '' }
      : { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}

/**
 * Git smart-HTTP endpoint: `https://host/<owner>/<repo>.git`. Authenticates the user with a
 * personal access token, authorizes against the repo, then streams the request to the
 * Artifacts remote with a short-lived repo-scoped token. Artifacts credentials never leave the worker.
 */
export async function handleGitRequest(
  request: Request,
  env: CloudflareBindings,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const [, owner, name, endpoint] = url.pathname.match(GIT_PATH)!;
  const realm = env.APP_NAME || 'GitOrange';
  const db = drizzle(env.DB, { schema });

  const creds = parseBasic(request.headers.get('Authorization'));
  if (!creds) return unauthorized(realm);
  // Like GitHub, accept the token in either slot.
  const token =
    creds.pass && creds.pass !== 'x-oauth-basic' ? creds.pass : creds.user;
  const pat = await db
    .select({ pat: personalAccessTokens, user: users })
    .from(personalAccessTokens)
    .innerJoin(users, eq(users.id, personalAccessTokens.userId))
    .where(eq(personalAccessTokens.tokenHash, await hashToken(token)))
    .get();
  if (
    !pat ||
    pat.user.banned ||
    (pat.pat.expiresAt && pat.pat.expiresAt < new Date())
  )
    return unauthorized(realm);
  ctx.waitUntil(
    db
      .update(personalAccessTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(personalAccessTokens.id, pat.pat.id))
      .run()
  );

  const found = await findRepo(db, owner, name);
  const perms = found ? await permissionsFor(db, found.repo, pat.user) : null;
  if (!found || !perms?.read)
    return new Response('Repository not found.\n', { status: 404 });

  const service =
    endpoint === 'info/refs' ? url.searchParams.get('service') : endpoint;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return new Response('Unsupported service\n', { status: 403 });
  }
  const isPush = service === 'git-receive-pack';
  if (isPush && !perms.write) {
    return new Response(
      `Permission to ${owner}/${name}.git denied to ${pat.user.username}.\n`,
      { status: 403 }
    );
  }

  const headers = new Headers();
  for (const h of [
    'Content-Type',
    'Content-Encoding',
    'Accept',
    'Git-Protocol',
    'User-Agent',
  ]) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  const git = gitFor(env, found.repo);
  const upstream = await git.client.forward(
    `/${endpoint}${url.search}`,
    {
      method: request.method,
      headers,
      body: request.method === 'POST' ? request.body : null,
    },
    isPush ? 'write' : 'read'
  );
  const respHeaders = new Headers();
  for (const h of ['Content-Type', 'Cache-Control', 'Expires', 'Pragma']) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  if (isPush && request.method === 'POST' && upstream.ok) {
    // Receive-pack responses are small status reports; buffer so we can sync metadata after the push lands.
    const body = await upstream.arrayBuffer();
    ctx.waitUntil(
      afterPush(
        env,
        found.repo.id,
        found.repo.defaultBranch,
        found.repo.artifactsName
      )
    );
    return new Response(body, {
      status: upstream.status,
      headers: respHeaders,
    });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

/** Bumps `updated_at` and adopts the first pushed branch as default if the default doesn't exist. */
async function afterPush(
  env: CloudflareBindings,
  repoId: string,
  defaultBranch: string,
  artifactsName: string
) {
  const db = drizzle(env.DB, { schema });
  const patch: { updatedAt: Date; defaultBranch?: string } = {
    updatedAt: new Date(),
  };
  try {
    const repo = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .get();
    if (repo) {
      const branches = await gitFor(env, { ...repo, artifactsName }).branches();
      if (branches.length && !branches.some((b) => b.name === defaultBranch)) {
        patch.defaultBranch =
          branches.find((b) => b.name === 'main')?.name ?? branches[0].name;
      }
    }
  } catch (e) {
    console.error('[git] post-push sync failed', e);
  }
  await db.update(repositories).set(patch).where(eq(repositories.id, repoId));
}
