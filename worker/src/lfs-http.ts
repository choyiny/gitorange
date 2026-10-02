import { and, eq, inArray } from 'drizzle-orm';
import { lfsObjects } from './db/app.schema';
import { authenticateRepoRequest, type GitAccess } from './git-http';
import {
  LFS_MAX_OBJECT_SIZE,
  LFS_NOT_CONFIGURED,
  LFS_URL_TTL_SECONDS,
  OID_RE,
  lfsConfigured,
  lfsKey,
  presign,
  sha256Header,
  storedObjectMatches,
} from './lib/lfs';

/**
 * Git LFS endpoint (Batch API + basic transfer adapter + minimal locks API) at
 * `https://host/<owner>/<repo>.git/info/lfs/...`. Bytes never pass through the worker:
 * the batch API hands out short-lived pre-signed R2 URLs after the usual permission checks.
 * https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md
 */
const LFS_PATH =
  /^\/([^/]+)\/([^/]+?)\.git\/info\/lfs\/(objects\/batch|objects\/verify|locks(?:\/verify|\/[^/]+\/unlock)?)$/;
const LFS_JSON = 'application/vnd.git-lfs+json';

export function isLfsRequest(url: URL) {
  return LFS_PATH.test(url.pathname);
}

function lfsJson(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': LFS_JSON, ...headers },
  });
}

const lfsError = (status: number, message: string) =>
  lfsJson({ message }, status);

type BatchObject = { oid: string; size: number };

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export async function handleLfsRequest(
  request: Request,
  env: CloudflareBindings,
  ctx: ExecutionContext
) {
  const url = new URL(request.url);
  const [, owner, name, endpoint] = url.pathname.match(LFS_PATH)!;

  const access = await authenticateRepoRequest(request, env, ctx, owner, name);
  if (access instanceof Response) {
    // git-lfs reads JSON bodies; keep the auth challenge header for the credential helper.
    return access.status === 401
      ? lfsJson(
          {
            message:
              'Credentials needed. Use a personal access token as the password.',
          },
          401,
          {
            'WWW-Authenticate':
              access.headers.get('WWW-Authenticate') ?? 'Basic',
          }
        )
      : lfsError(404, 'Repository not found');
  }

  if (endpoint.startsWith('locks'))
    return handleLocks(request, endpoint, access);
  if (request.method !== 'POST') return lfsError(405, 'Method not allowed');
  if (!lfsConfigured(env)) return lfsError(501, LFS_NOT_CONFIGURED);
  if (endpoint === 'objects/verify') return handleVerify(request, env, access);
  return handleBatch(request, env, access, url);
}

async function handleBatch(
  request: Request,
  env: CloudflareBindings,
  access: GitAccess,
  url: URL
) {
  const body = await readJson<{
    operation?: string;
    objects?: BatchObject[];
    transfers?: string[];
    hash_algo?: string;
  }>(request);
  if (
    !body ||
    (body.operation !== 'upload' && body.operation !== 'download') ||
    !Array.isArray(body.objects)
  ) {
    return lfsError(
      422,
      'Expected {"operation": "upload" | "download", "objects": [...]}'
    );
  }
  if (body.transfers && !body.transfers.includes('basic'))
    return lfsError(422, 'Only the basic transfer adapter is supported');
  if (body.hash_algo && body.hash_algo !== 'sha256')
    return lfsError(409, 'Only sha256 is supported');
  if (body.objects.length > 1000)
    return lfsError(422, 'At most 1000 objects per batch request');
  const upload = body.operation === 'upload';
  if (upload && !access.perms.write)
    return lfsError(403, 'You do not have push access to this repository');

  const { db, repo, user } = access;
  const valid = body.objects.filter(
    (o) => OID_RE.test(o?.oid) && Number.isSafeInteger(o?.size) && o.size >= 0
  );
  const known = valid.length
    ? await db
        .select()
        .from(lfsObjects)
        .where(
          and(
            eq(lfsObjects.repositoryId, repo.id),
            inArray(lfsObjects.oid, [...new Set(valid.map((o) => o.oid))])
          )
        )
        .all()
    : [];
  const byOid = new Map(known.map((r) => [r.oid, r]));

  /** Records an object R2 already holds (e.g. an upload whose verify call never arrived). */
  const adopt = async (o: BatchObject) => {
    const key = lfsKey(repo.id, o.oid);
    if (!(await storedObjectMatches(env, key, o.oid, o.size))) return false;
    await db
      .insert(lfsObjects)
      .values({
        id: crypto.randomUUID(),
        repositoryId: repo.id,
        oid: o.oid,
        size: o.size,
        r2Key: key,
        uploadedById: user.id,
        createdAt: new Date(),
      })
      .onConflictDoNothing();
    return true;
  };

  const verifyHref = `${url.origin}${url.pathname.replace(/objects\/batch$/, 'objects/verify')}`;
  const auth = request.headers.get('Authorization')!;

  const objects = await Promise.all(
    body.objects.map(async (o) => {
      const base = { oid: o?.oid, size: o?.size };
      if (
        !OID_RE.test(o?.oid) ||
        !Number.isSafeInteger(o?.size) ||
        o.size < 0
      ) {
        return {
          ...base,
          error: {
            code: 422,
            message:
              'Invalid object: oid must be a sha256 hex string and size a non-negative integer',
          },
        };
      }
      const row = byOid.get(o.oid);
      if (upload) {
        if (o.size > LFS_MAX_OBJECT_SIZE)
          return {
            ...base,
            error: { code: 422, message: 'Object exceeds the 5 GB limit' },
          };
        if (row || (await adopt(o))) return base; // already stored: no actions
        const header = { 'x-amz-checksum-sha256': sha256Header(o.oid) };
        return {
          ...base,
          authenticated: true,
          actions: {
            upload: {
              href: await presign(env, lfsKey(repo.id, o.oid), 'PUT', {
                headers: header,
              }),
              header,
              expires_in: LFS_URL_TTL_SECONDS,
            },
            verify: {
              href: verifyHref,
              header: { Authorization: auth },
              expires_in: LFS_URL_TTL_SECONDS,
            },
          },
        };
      }
      if (!row && !(await adopt(o)))
        return {
          ...base,
          error: { code: 404, message: 'Object does not exist' },
        };
      return {
        ...base,
        authenticated: true,
        actions: {
          download: {
            href: await presign(env, lfsKey(repo.id, o.oid), 'GET'),
            expires_in: LFS_URL_TTL_SECONDS,
          },
        },
      };
    })
  );
  return lfsJson({ transfer: 'basic', objects, hash_algo: 'sha256' });
}

async function handleVerify(
  request: Request,
  env: CloudflareBindings,
  access: GitAccess
) {
  if (!access.perms.write)
    return lfsError(403, 'You do not have push access to this repository');
  const o = await readJson<BatchObject>(request);
  if (!o || !OID_RE.test(o.oid) || !Number.isSafeInteger(o.size))
    return lfsError(422, 'Expected {"oid", "size"}');
  const key = lfsKey(access.repo.id, o.oid);
  if (!(await storedObjectMatches(env, key, o.oid, o.size))) {
    return lfsError(
      422,
      'Object is missing from storage or does not match its oid and size'
    );
  }
  await access.db
    .insert(lfsObjects)
    .values({
      id: crypto.randomUUID(),
      repositoryId: access.repo.id,
      oid: o.oid,
      size: o.size,
      r2Key: key,
      uploadedById: access.user.id,
      createdAt: new Date(),
    })
    .onConflictDoNothing();
  return lfsJson({});
}

/**
 * GitOrange doesn't implement file locking. Listing and verifying report no locks so pushes
 * aren't noisy; creating or releasing a lock says so explicitly.
 */
function handleLocks(request: Request, endpoint: string, access: GitAccess) {
  if (endpoint === 'locks' && request.method === 'GET')
    return lfsJson({ locks: [] });
  if (endpoint === 'locks/verify' && request.method === 'POST') {
    if (!access.perms.write)
      return lfsError(403, 'You do not have push access to this repository');
    return lfsJson({ ours: [], theirs: [] });
  }
  if (endpoint === 'locks' && request.method === 'POST')
    return lfsError(501, 'File locking is not supported by this server');
  if (request.method === 'POST') return lfsError(404, 'Lock not found');
  return lfsError(405, 'Method not allowed');
}
