import { AwsClient } from 'aws4fetch';
import { fromHex } from '../git/bytes';

/** R2's single-request upload limit; the basic LFS transfer adapter has no multipart. */
export const LFS_MAX_OBJECT_SIZE = 5 * 1024 ** 3;
/** Lifetime of pre-signed URLs handed to git-lfs. */
export const LFS_URL_TTL_SECONDS = 900;

export const OID_RE = /^[0-9a-f]{64}$/;

/** One copy per repository: the key encodes ownership, so deleting a repo deletes its prefix. */
export function lfsKey(repositoryId: string, oid: string) {
  return `lfs/${repositoryId}/${oid}`;
}

export const lfsPrefix = (repositoryId: string) => `lfs/${repositoryId}/`;

export function lfsConfigured(env: CloudflareBindings): boolean {
  return Boolean(
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY &&
    env.R2_ACCOUNT_ID &&
    env.LFS_BUCKET_NAME
  );
}

export const LFS_NOT_CONFIGURED =
  "Git LFS isn't configured on this server. An administrator needs to set the R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY secrets.";

/** The base64 SHA-256 header S3/R2 use to verify upload integrity; the LFS oid *is* the SHA-256. */
export function sha256Header(oid: string): string {
  let bin = '';
  for (const b of fromHex(oid)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Pre-signs a direct-to-R2 request via the S3 API. URLs are minted per request after the
 * permission check and never stored (D1 keeps only the bare key).
 */
export async function presign(
  env: CloudflareBindings,
  key: string,
  method: 'GET' | 'PUT',
  opts: { headers?: Record<string, string>; filename?: string } = {}
): Promise<string> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  const url = new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.LFS_BUCKET_NAME}/${key}`
  );
  url.searchParams.set('X-Amz-Expires', String(LFS_URL_TTL_SECONDS));
  if (opts.filename) {
    const safe = opts.filename.replace(/["\\\r\n]/g, '_');
    url.searchParams.set(
      'response-content-disposition',
      `attachment; filename="${safe}"`
    );
  }
  const signed = await client.sign(
    new Request(url, { method, headers: opts.headers }),
    {
      aws: { signQuery: true },
    }
  );
  return signed.url;
}

/**
 * Whether R2 holds the object for `oid` at exactly `size` bytes. When R2 recorded a SHA-256
 * checksum (pre-signed uploads require one), it must equal the oid as well.
 */
export async function storedObjectMatches(
  env: CloudflareBindings,
  key: string,
  oid: string,
  size: number
) {
  const head = await env.LFS.head(key);
  if (!head || head.size !== size) return false;
  const sum = head.checksums?.sha256;
  if (sum) {
    const hex = [...new Uint8Array(sum)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    if (hex !== oid) return false;
  }
  return true;
}

/** Deletes every LFS object under a repository's prefix. */
export async function deleteRepositoryObjects(
  env: CloudflareBindings,
  repositoryId: string
) {
  let cursor: string | undefined;
  do {
    const page = await env.LFS.list({
      prefix: lfsPrefix(repositoryId),
      cursor,
      limit: 1000,
    });
    if (page.objects.length)
      await env.LFS.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export interface LfsPointer {
  oid: string;
  size: number;
}

/** Parses a Git LFS pointer file (spec v1). Returns null for anything else. */
export function parseLfsPointer(text: string): LfsPointer | null {
  if (
    text.length > 1024 ||
    !text.startsWith('version https://git-lfs.github.com/spec/v1')
  )
    return null;
  const oid = text.match(/^oid sha256:([0-9a-f]{64})$/m)?.[1];
  const size = text.match(/^size (\d+)$/m)?.[1];
  if (!oid || size === undefined) return null;
  return { oid, size: Number(size) };
}
