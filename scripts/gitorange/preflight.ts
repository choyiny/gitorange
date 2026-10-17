import { CloudflareError, type Cloudflare } from './cloudflare.ts';
import type { Runner } from './runner.ts';

export type Failure = { check: string; message: string; fix: string };

export interface PreflightInput {
  accountId: string;
  hostname: string | null;
  workersDev: boolean;
  fromEmail: string | null;
  workerName: string;
}

interface Outcome {
  failures: Failure[];
  baseUrl?: string | null;
  zoneId?: string | null;
}

const TOKEN_FIX =
  'Create an API token with the permissions listed in docs/setup.md and log in again.';

class TokenProblem extends Error {}

function isAuth(e: unknown): e is CloudflareError {
  return e instanceof CloudflareError && (e.status === 401 || e.status === 403);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Wraps one check: a 401/403 becomes a token problem, anything else a failure for `check`. */
async function guard(
  check: string,
  what: string,
  fn: () => Promise<Outcome>,
  fix: string
): Promise<Outcome> {
  try {
    return await fn();
  } catch (e) {
    if (isAuth(e)) throw new TokenProblem(what);
    return {
      failures: [{ check, message: `Could not check ${what}: ${msg(e)}`, fix }],
    };
  }
}

const one = (check: string, message: string, fix: string): Outcome => ({
  failures: [{ check, message, fix }],
});

/** Read-only checks that run before any plan or write; every check runs and every failure is reported. */
export async function preflight(
  cf: Cloudflare,
  runner: Runner,
  input: PreflightInput
): Promise<{
  failures: Failure[];
  baseUrl: string | null;
  zoneId: string | null;
}> {
  const a = input.accountId;

  const artifacts = () =>
    guard(
      'artifacts',
      'Artifacts access',
      async () => {
        try {
          await cf.listArtifactsNamespaces(a);
          return { failures: [] };
        } catch (e) {
          if (e instanceof CloudflareError && e.codes.includes(10004))
            return one(
              'artifacts',
              'Artifacts is not available on this account (it needs Workers Paid).',
              'Subscribe to Workers Paid at https://dash.cloudflare.com/?to=/:account/workers/plans and make sure Artifacts is enabled, then run the installer again.'
            );
          throw e;
        }
      },
      'Check that the account has Workers Paid and Artifacts access.'
    );

  const r2 = () =>
    guard(
      'r2',
      'R2',
      async () => {
        try {
          await cf.listR2(a);
          return { failures: [] };
        } catch (e) {
          if (e instanceof CloudflareError && e.codes.includes(10042))
            return one(
              'r2',
              'R2 is not enabled on this account.',
              'Enable R2 at https://dash.cloudflare.com/?to=/:account/r2/overview, then run the installer again.'
            );
          throw e;
        }
      },
      'Enable R2 at https://dash.cloudflare.com/?to=/:account/r2/overview.'
    );

  const subdomain = () =>
    guard(
      'workers-dev',
      'the workers.dev subdomain',
      async () => {
        const sub = await cf.workersSubdomain(a);
        if (sub === null)
          return {
            failures: [
              {
                check: 'workers-dev',
                message: 'The account has no workers.dev subdomain yet.',
                fix: 'Open Workers & Pages in the Cloudflare dashboard once so it is created, then run the installer again.',
              },
            ],
            baseUrl: null,
          };
        return {
          failures: [],
          baseUrl: input.workersDev
            ? `https://${input.workerName}.${sub}.workers.dev`
            : null,
        };
      },
      'Open Workers & Pages in the Cloudflare dashboard once.'
    );

  const zone = () =>
    guard(
      'zone',
      'the hostname zone',
      async () => {
        const host = input.hostname!;
        const z = await cf.findZone(a, host);
        const failures: Failure[] = [];
        if (!z)
          failures.push({
            check: 'zone',
            message: `No zone covering ${host} was found in this account.`,
            fix: 'Add the domain to this Cloudflare account (or pick a hostname on a zone it already has), then run the installer again.',
          });
        else if (z.status !== 'active')
          failures.push({
            check: 'zone',
            message: `The zone ${z.name} is ${z.status}, not active.`,
            fix: 'Finish the zone setup (point the registrar at Cloudflare nameservers) and wait until it is active.',
          });
        const taken = (await cf.workerDomains(a)).find(
          (d) =>
            d.hostname.toLowerCase() === host.toLowerCase() &&
            d.service !== input.workerName
        );
        if (taken)
          failures.push({
            check: 'zone',
            message: `${host} is already served by the worker "${taken.service}".`,
            fix: `Remove that custom domain from "${taken.service}" or choose another hostname.`,
          });
        return { failures, baseUrl: `https://${host}`, zoneId: z?.id ?? null };
      },
      'Check the zone and custom domains in the Cloudflare dashboard.'
    );

  const email = () =>
    guard(
      'email',
      'Email Sending',
      async () => {
        const domain = input.fromEmail!.split('@').pop()!.toLowerCase();
        const fix = `Add ${domain} under Email Sending in the Cloudflare dashboard (Compute & AI → Email Service), verify it, then run the installer again.`;
        const res = await runner.run('yarn', [
          '-s',
          'wrangler',
          'email',
          'sending',
          'list',
        ]);
        if (res.code !== 0)
          return one(
            'email',
            `Could not list Email Sending domains: ${res.stderr.split('\n')[0] || `exit ${res.code}`}`,
            fix
          );
        const listed = res.stdout
          .toLowerCase()
          .split(/[^a-z0-9.-]+/)
          .some((t) => t.replace(/^\.+|\.+$/g, '') === domain);
        return listed
          ? { failures: [] }
          : one(
              'email',
              `The sender domain ${domain} is not set up for Email Sending.`,
              fix
            );
      },
      'Check Email Sending in the Cloudflare dashboard.'
    );

  const docker = async (): Promise<Outcome> => {
    const fail = one(
      'docker',
      'Docker is not running.',
      'Start Docker Desktop (or the Docker daemon); the deploy builds the Actions runner image.'
    );
    try {
      const res = await runner.run('docker', [
        'info',
        '--format',
        '{{.ServerVersion}}',
      ]);
      return res.code === 0 ? { failures: [] } : fail;
    } catch {
      return fail;
    }
  };

  const noop = async (): Promise<Outcome> => ({ failures: [] });
  const settled = await Promise.allSettled([
    artifacts(),
    r2(),
    input.workersDev ? subdomain() : noop(),
    !input.workersDev && input.hostname ? zone() : noop(),
    input.fromEmail ? email() : noop(),
    docker(),
  ]);

  const failures: Failure[] = [];
  let baseUrl: string | null = null;
  let zoneId: string | null = null;
  const denied: string[] = [];
  for (const s of settled) {
    if (s.status === 'rejected') {
      if (s.reason instanceof TokenProblem) denied.push(s.reason.message);
      else throw s.reason;
      continue;
    }
    failures.push(...s.value.failures);
    if (s.value.baseUrl !== undefined && s.value.baseUrl !== null)
      baseUrl = s.value.baseUrl;
    if (s.value.zoneId !== undefined) zoneId = s.value.zoneId;
  }
  if (denied.length)
    failures.unshift({
      check: 'token',
      message: `The API token cannot read: ${denied.join(', ')}.`,
      fix: TOKEN_FIX,
    });
  return { failures, baseUrl, zoneId };
}
