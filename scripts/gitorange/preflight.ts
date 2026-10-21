import { CloudflareError, type Cloudflare } from './cloudflare.ts';
import { withEnv, type Runner } from './runner.ts';
import type { Source } from './source.ts';

export type Failure = { check: string; message: string; fix: string };

export interface PreflightInput {
  accountId: string;
  hostname: string | null;
  workersDev: boolean;
  fromEmail: string | null;
  workerName: string;
  /** Runs wrangler: the checkout's (yarn) or the package's own. */
  source: Source;
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

/**
 * Parses the cli-table3 output of `wrangler email sending list` (header zone|name|enabled|tag, cells split by
 * a box-drawing or ASCII bar). Returns null when no header with `name` and `enabled` is found.
 */
export function parseEmailTable(
  out: string
): { name: string; enabled: string }[] | null {
  // eslint-disable-next-line no-control-regex
  const lines = out.replace(/\u001b\[[0-9;]*m/g, '').split('\n');
  let name = -1;
  let enabled = -1;
  const rows: { name: string; enabled: string }[] = [];
  for (const line of lines) {
    if (!/[│|]/.test(line)) continue;
    const cells = line
      .split(/[│|]/)
      .slice(1, -1)
      .map((c) => c.trim());
    if (name < 0) {
      const lower = cells.map((c) => c.toLowerCase());
      if (lower.includes('name') && lower.includes('enabled')) {
        name = lower.indexOf('name');
        enabled = lower.indexOf('enabled');
      }
      continue;
    }
    if (cells.length > Math.max(name, enabled))
      rows.push({ name: cells[name], enabled: cells[enabled] });
  }
  return name < 0 ? null : rows;
}

/** Whether a Workers route pattern (`host/path`, optionally `*`-prefixed or with a scheme) covers `host`. */
export function routeCovers(pattern: string, host: string): boolean {
  const h = pattern
    .replace(/^https?:\/\//i, '')
    .split('/', 1)[0]!
    .toLowerCase();
  const want = host.toLowerCase();
  return h.startsWith('*') ? want.endsWith(h.slice(1)) : h === want;
}

export const DOCKER_NOT_INSTALLED =
  'Docker is not installed. GitOrange runs Actions jobs in containers, and deploying builds the runner image with Docker. Install Docker Desktop (https://docs.docker.com/get-docker/), start it, then run the same command again.';
export const DOCKER_NOT_RUNNING =
  'Docker is installed but not running. Start Docker Desktop (or the Docker daemon), then run the same command again.';

/** Every deploy builds the runner image: what is wrong with Docker here, or null when it answers. */
export async function dockerProblem(runner: Runner): Promise<string | null> {
  try {
    const v = await runner.run('docker', ['--version']);
    if (v.code !== 0) return DOCKER_NOT_INSTALLED;
  } catch {
    return DOCKER_NOT_INSTALLED;
  }
  try {
    const res = await runner.run('docker', [
      'info',
      '--format',
      '{{.ServerVersion}}',
    ]);
    if (res.code === 0) return null;
  } catch {
    // falls through: the daemon did not answer
  }
  return DOCKER_NOT_RUNNING;
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
  // wrangler picks the account itself (and may ask) unless told: always the chosen one.
  const run = withEnv(runner, { CLOUDFLARE_ACCOUNT_ID: a });

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
          // 10042 is unverified (not in wrangler's source); the generic r2 failure below keeps the activation link anyway.
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
        const onHost = (await cf.workerDomains(a)).filter(
          (d) => d.hostname.toLowerCase() === host.toLowerCase()
        );
        const taken = onHost.find((d) => d.service !== input.workerName);
        if (taken)
          failures.push({
            check: 'zone',
            message: `${host} is already served by the worker "${taken.service}".`,
            fix: `Remove that custom domain from "${taken.service}" or choose another hostname.`,
          });
        if (z) {
          // Without a terminal, wrangler's deploy replaces conflicting DNS records and other
          // workers' origins on the hostname (override_existing_dns_record/_origin): check first.
          // This worker's own custom domain owns its record (a resume), so that one is fine.
          const own = onHost.some((d) => d.service === input.workerName);
          const records = own ? [] : await cf.dnsRecords(z.id, host);
          if (records.length > 0)
            failures.push({
              check: 'zone',
              message: `\`${host}\` already has DNS records (${records.map((r) => `${r.type} ${r.content}`).join(', ')}). Nothing was changed.`,
              fix: `Delete those records in the Cloudflare dashboard (DNS → Records for ${z.name}) or choose another hostname.`,
            });
          const scripts = [
            ...new Set(
              (await cf.workerRoutes(z.id))
                .filter(
                  (r) =>
                    r.script !== null &&
                    r.script !== input.workerName &&
                    routeCovers(r.pattern, host)
                )
                .map((r) => r.script!)
            ),
          ];
          if (scripts.length > 0)
            failures.push({
              check: 'zone',
              message: `\`${host}\` is routed to ${scripts.map((x) => `\`${x}\``).join(', ')}. Nothing was changed.`,
              fix: `Remove those routes in the Cloudflare dashboard (Workers Routes for ${z.name}) or choose another hostname.`,
            });
        }
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
        // Bare: the generated config does not exist yet, and this reads none.
        const c = input.source.wranglerBare(['email', 'sending', 'list']);
        const res = await run.run(c.cmd, c.args);
        if (res.code !== 0)
          return one(
            'email',
            `Could not list Email Sending domains: ${res.stderr.split('\n')[0] || `exit ${res.code}`}`,
            fix
          );
        const table = parseEmailTable(res.stdout);
        if (table === null) {
          if (/No sending subdomains found/i.test(res.stdout))
            return one(
              'email',
              `The sender domain ${domain} is not set up for Email Sending.`,
              fix
            );
          const first =
            res.stdout.split('\n').find((l) => l.trim()) ?? '(empty output)';
          return one(
            'email',
            `Could not read the Email Sending list: ${first.trim()}`,
            fix
          );
        }
        const listed = table.some(
          (r) =>
            r.name.toLowerCase() === domain && /^(yes|true)$/i.test(r.enabled)
        );
        return listed
          ? { failures: [] }
          : one(
              'email',
              `The sender domain ${domain} is not listed and enabled for Email Sending.`,
              fix
            );
      },
      'Check Email Sending in the Cloudflare dashboard.'
    );

  // Two failures, each with the whole text in `message` (no separate fix line).
  const docker = async (): Promise<Outcome> => {
    const problem = await dockerProblem(runner);
    return problem
      ? { failures: [{ check: 'docker', message: problem, fix: '' }] }
      : { failures: [] };
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
