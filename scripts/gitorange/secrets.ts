// Secrets, the setup code, credential checks and prefilled token links for the installer.
// Nothing here ever puts a secret or token into a returned message.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AwsClient } from 'aws4fetch';

export function generateAuthSecret(): string {
  return randomBytes(32).toString('hex');
}

// No I, L or O. 20 characters of 31 is about 99 bits.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateSetupCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < 5; g++) {
    let group = '';
    for (let i = 0; i < 4; i++)
      group += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    groups.push(group);
  }
  return groups.join('-');
}

/** Same as worker/src/lib/setup-code.ts: strip dashes, upper-case, SHA-256, lowercase hex. */
export function setupCodeHash(code: string): string {
  return createHash('sha256')
    .update(code.replace(/-/g, '').toUpperCase())
    .digest('hex');
}

/**
 * Hands `fn` the path of a 0600 JSON file for `wrangler deploy --secrets-file`. Wrangler tries
 * JSON first whatever the extension and falls back to dotenv (parseBulkInputToObject), and the
 * flag is additive: secrets left out are not deleted. The whole directory is removed afterwards.
 */
export async function withSecretsFile<T>(
  secrets: Record<string, string>,
  fn: (path: string) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'gitorange-'));
  try {
    const path = join(dir, 'secrets.json');
    writeFileSync(path, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' });
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Prefilled R2 API-token page (the form void's platform-setup.ts builds): an account token with
 * Object Read & Write preselected, so a read-only token cannot slip past checkR2Keys. The
 * caller prints which buckets to scope it to.
 */
export function r2TokenLink(accountId: string, _buckets: string[]): string {
  return (
    'https://dash.cloudflare.com/?' +
    new URLSearchParams({
      to: `/${accountId}/r2/api-tokens/create`,
      type: 'account',
      name: 'GitOrange Uploads',
      permission: 'object-write',
      bucketScope: 'all',
    })
  );
}

/**
 * Account-owned token template (outlives the person running the install), as void builds it.
 * Key `account_analytics` / `read` is from spec §2.
 */
export function analyticsTokenLink(accountId: string, name: string): string {
  return (
    'https://dash.cloudflare.com/?' +
    new URLSearchParams({
      to: `/${accountId}/api-tokens`,
      name,
      permissionGroupKeys: JSON.stringify([
        { key: 'account_analytics', type: 'read' },
      ]),
    })
  );
}

export async function checkR2Keys(
  accountId: string,
  bucket: string,
  keys: { id: string; secret: string },
  fetchImpl: typeof fetch
): Promise<string | null> {
  try {
    const client = new AwsClient({
      accessKeyId: keys.id,
      secretAccessKey: keys.secret,
      service: 's3',
      region: 'auto',
    });
    const url = `https://${accountId}.r2.cloudflarestorage.com/${bucket}?list-type=2&max-keys=1`;
    const signed = await client.sign(url);
    const res = await fetchImpl(signed);
    return res.status === 200
      ? null
      : `R2 rejected these keys (HTTP ${res.status}).`;
  } catch (e) {
    const text = e instanceof Error ? e.message : 'request failed';
    const safe = keys.secret ? text.split(keys.secret).join('***') : text;
    return `Couldn't reach R2 to check these keys (${safe}).`;
  }
}

const ANALYTICS_MESSAGE =
  "This token can't read Account Analytics for this account.";

export async function checkAnalyticsToken(
  accountId: string,
  token: string,
  fetchImpl: typeof fetch
): Promise<string | null> {
  try {
    const res = await fetchImpl(
      'https://api.cloudflare.com/client/v4/graphql',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query:
            'query($accountTag: string) { viewer { accounts(filter: { accountTag: $accountTag }) { accountTag } } }',
          variables: { accountTag: accountId },
        }),
      }
    );
    const body = (await res.json()) as {
      errors?: unknown[] | null;
      data?: { viewer?: { accounts?: { accountTag?: string }[] } } | null;
    };
    const found = body.data?.viewer?.accounts?.some(
      (a) => a.accountTag === accountId
    );
    if (!res.ok || (body.errors && body.errors.length > 0) || !found)
      return ANALYTICS_MESSAGE;
    return null;
  } catch {
    return ANALYTICS_MESSAGE;
  }
}
