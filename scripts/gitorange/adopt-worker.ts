// `gitorange adopt --worker <name>` (spec §7): takes over a GitOrange deployed by hand (no state
// file, no ownership markers) from the deployed worker's settings. Read-only up to the confirmed
// report; then writes the state and the generated wrangler.jsonc under <home>/<worker>/. Never
// deploys, never runs wrangler or docker, never reads or sends a secret value.
import { parse } from 'jsonc-parser';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from './apply.ts';
import { DO_VARS, renderConfig, writeConfig } from './apply-steps.ts';
import { TUNABLE_VARS } from './config.ts';
import { plainTextVars, type WorkerBinding } from './cloudflare.ts';
import { installDir } from './home.ts';
import {
  installationIdOf,
  resourceNames,
  validateName,
  type ResourceNames,
} from './names.ts';
import {
  acquireLock,
  listStates,
  newState,
  writeState,
  type InstallState,
  type Resource,
  type ResourceKind,
} from './state.ts';
import { compareRunning } from './versions.ts';

/** The template's resource bindings: name -> settings type, state key and resource kind (in plan order). */
const TEMPLATE = {
  DB: { type: 'd1', key: 'd1', kind: 'd1' },
  LFS: { type: 'r2_bucket', key: 'lfs', kind: 'r2' },
  ACTIONS_LOGS: { type: 'r2_bucket', key: 'actionsLogs', kind: 'r2' },
  ACTIONS_CACHE: { type: 'r2_bucket', key: 'actionsCache', kind: 'r2' },
  ACTIONS_RUN: { type: 'workflow', key: 'actionsWorkflow', kind: 'workflow' },
  MERGE_RESOLUTION: {
    type: 'workflow',
    key: 'mergeWorkflow',
    kind: 'workflow',
  },
} as const satisfies Record<
  string,
  { type: string; key: keyof ResourceNames; kind: ResourceKind }
>;
type TemplateName = keyof typeof TEMPLATE;
const TEMPLATE_NAMES = Object.keys(TEMPLATE) as TemplateName[];

/** The Artifacts binding: its namespace is a name, not a recorded resource. */
const ARTIFACTS = { name: 'ARTIFACTS', type: 'artifacts' } as const;

/** Bindings adopt accepts without mapping them to anything: name -> type. */
const OTHER_BINDINGS: Record<string, string> = {
  AI: 'ai',
  ASSETS: 'assets',
  EMAIL: 'send_email',
};
const OTHER_TYPES = new Set(['plain_text', 'secret_text']);
const DO_TYPE = 'durable_object_namespace';

const NOTHING = 'Nothing was changed.';

/** Secret names GitOrange uses: a plain var of that name likely holds one, so its value is never shown. */
const SECRET_NAMES = new Set([
  'BETTER_AUTH_SECRET',
  'SETUP_CODE_HASH',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'CF_ANALYTICS_TOKEN',
]);
/** The one secret the first upgrade generates when the worker lacks it (generatedSecrets). */
const GENERATED_SECRET = 'BETTER_AUTH_SECRET';
/** Vars the first upgrade is expected to change. */
const EXPECTED_TO_CHANGE = new Set([
  'GITORANGE_VERSION',
  'GITORANGE_INSTALLATION',
]);
const DO_ID_VARS = new Set(Object.values(DO_VARS));
/**
 * Vars older GitOrange versions set that the worker no longer reads: dropping them changes
 * nothing. None yet; add a var here when a release stops reading it.
 */
const RETIRED_VARS: ReadonlySet<string> = new Set<string>();

const hostOf = (url: string | undefined): string | null => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const origins = (v: string) =>
  v
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');

/**
 * The worker's plain vars that the first upgrade's deploy would drop or change (wrangler deploy
 * replaces every var with the generated config's): one line each, current -> new. `stops` would
 * change what the worker does; `drops` do not (retired vars, a TRUSTED_ORIGINS that only trusts
 * local development origins, which GitOrange never reads) and are shown in the report. A var
 * named like a secret has its value withheld. An empty Durable Object namespace id var is one
 * the upgrade fills in. Tunable vars are skipped (adopt keeps them as found) except those named in
 * `compare`, which an upgrade checks for dashboard edits since adopt or the last upgrade.
 */
export function varChanges(
  current: Record<string, string>,
  next: Record<string, string>,
  retired: ReadonlySet<string> = RETIRED_VARS,
  compare: ReadonlySet<string> = new Set()
): { stops: string[]; drops: string[] } {
  const stops: string[] = [];
  const drops: string[] = [];
  for (const [name, value] of Object.entries(current).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (SECRET_NAMES.has(name)) {
      stops.push(
        name === GENERATED_SECRET
          ? `  ${name}  (value not shown) -> removed; the upgrade would generate a ${name} secret in its place`
          : `  ${name}  (value not shown) -> removed; set it as a secret instead`
      );
    } else if (
      EXPECTED_TO_CHANGE.has(name) ||
      (TUNABLE_VARS.includes(name) && !compare.has(name))
    ) {
      // Tunable vars are kept as found (inputs.vars), never changed by the upgrade.
      continue;
    } else if (DO_ID_VARS.has(name) && value === '') {
      continue;
    } else if (!(name in next)) {
      if (retired.has(name)) {
        drops.push(
          `  ${name}  ${JSON.stringify(value)} -> removed (GitOrange no longer reads it)`
        );
      } else if (
        name === 'TRUSTED_ORIGINS' &&
        origins(value).every((o) => LOCAL_HOSTS.has(hostOf(o) ?? ''))
      ) {
        drops.push(
          `  ${name}  ${JSON.stringify(value)} -> removed (drops local development origins)`
        );
      } else {
        stops.push(
          `  ${name}  ${JSON.stringify(value)} -> removed (GitOrange's config does not set it)`
        );
      }
    } else if (next[name] !== value) {
      stops.push(
        `  ${name}  ${JSON.stringify(value)} -> ${JSON.stringify(next[name])}`
      );
    }
  }
  return { stops, drops };
}

/** The error for vars a deploy would drop or change: `who` is the upgrade, `then` what to run next. */
export const varStops = (
  worker: string,
  stops: string[],
  who: string,
  then: string
) =>
  new Error(
    [
      `Worker ${worker} has vars ${who} would drop or change:`,
      ...stops,
      `Change or remove them on the worker, then ${then}. ${NOTHING}`,
    ].join('\n')
  );

/** The generated config's plain vars, from its text. */
export function configVars(text: string): Record<string, string> {
  const vars = (parse(text) as { vars?: Record<string, unknown> }).vars ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars))
    if (typeof v === 'string') out[k] = v;
  return out;
}

/** What the template declares about Durable Objects and the containers application. */
type TemplateShape = {
  /** `exports` Durable Object classes, in template order. */
  classes: string[];
  /** Durable Object binding name -> class. */
  doBindings: Map<string, string>;
  /** The class of the Durable Object-managed container (the Actions runner). */
  containerClass: string | null;
  /** The template's plain vars (the defaults a tunable var is compared with). */
  vars: Record<string, string>;
};

function templateShape(ctx: Ctx): TemplateShape {
  const t = parse(readFileSync(ctx.source.templatePath, 'utf8')) as {
    exports?: Record<string, { type?: string }>;
    durable_objects?: { bindings?: { name: string; class_name: string }[] };
    containers?: { class_name?: string; scheduling_policy?: string }[];
    vars?: Record<string, unknown>;
  };
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.vars ?? {}))
    if (typeof v === 'string') vars[k] = v;
  return {
    classes: Object.entries(t.exports ?? {})
      .filter(([, e]) => e?.type === 'durable-object')
      .map(([k]) => k),
    doBindings: new Map(
      (t.durable_objects?.bindings ?? []).map((b) => [b.name, b.class_name])
    ),
    containerClass:
      t.containers?.find((c) => c.scheduling_policy === 'durable_object')
        ?.class_name ?? null,
    vars,
  };
}

/** A Durable Object binding to a class of this worker (no other script named). */
const ownDo = (b: WorkerBinding, worker: string) =>
  b.type === DO_TYPE && (!b.script_name || b.script_name === worker);

const isTemplate = (b: WorkerBinding) =>
  b.name in TEMPLATE && TEMPLATE[b.name as TemplateName].type === b.type;

export const noWorker = (worker: string, accountId: string) =>
  `No worker named ${worker} on account ${accountId}. ${NOTHING}`;

/** The deployed `version` from `/.well-known/gitorange`, else null (hand-deployed workers may not say). */
async function wellKnownVersion(
  ctx: Ctx,
  baseUrl: string
): Promise<string | null> {
  try {
    const res = await ctx.fetchImpl(`${baseUrl}/.well-known/gitorange`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      version?: unknown;
    } | null;
    return typeof body?.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

/** The custom domain the worker is served on (null = workers.dev). Several without a tie-break stop. */
async function servedOn(
  ctx: Ctx,
  accountId: string,
  worker: string,
  baseUrl: string | undefined
): Promise<string | null> {
  const domains = (await ctx.cf.workerDomains(accountId))
    .filter((d) => d.service === worker)
    .map((d) => d.hostname.toLowerCase());
  if (domains.length <= 1) return domains[0] ?? null;
  const base = hostOf(baseUrl);
  if (base && domains.includes(base)) return base;
  throw new Error(
    `Worker ${worker} serves several custom domains (${domains.join(', ')}) and its BASE_URL names none of them. ${NOTHING}`
  );
}

const missing = (n: string, what: string, ref: string) =>
  new Error(
    `Binding ${n} points to ${what} ${ref}, which does not exist. ${NOTHING}`
  );

/** Each bound template resource, checked to exist (and, for a workflow, to run on this worker). */
async function boundResources(
  ctx: Ctx,
  accountId: string,
  worker: string,
  bindings: WorkerBinding[]
): Promise<Resource[]> {
  const bound = (n: TemplateName) =>
    bindings.find((b) => b.name === n && isTemplate(b));
  const adopted = (n: TemplateName, name: string, id: string): Resource => ({
    key: TEMPLATE[n].key,
    kind: TEMPLATE[n].kind,
    name,
    id,
    ownership: 'adopted',
    state: 'ready',
  });
  const out: Resource[] = [];

  const db = bound('DB');
  if (!db) {
    throw new Error(
      `The worker has no D1 binding DB: it does not look like a GitOrange install. ${NOTHING}`
    );
  }
  const dbId = db.id ?? db.database_id ?? '(no id)';
  const d1 = (await ctx.cf.listD1(accountId)).find((d) => d.uuid === dbId);
  if (!d1) throw missing('DB', 'D1', dbId);
  out.push(adopted('DB', d1.name, d1.uuid));

  const buckets = (['LFS', 'ACTIONS_LOGS', 'ACTIONS_CACHE'] as const).filter(
    (n) => bound(n)
  );
  if (buckets.length > 0) {
    const all = await ctx.cf.listR2(accountId);
    for (const n of buckets) {
      const bucket = bound(n)!.bucket_name ?? '(no name)';
      if (!all.includes(bucket)) throw missing(n, 'R2 bucket', bucket);
      out.push(adopted(n, bucket, bucket));
    }
  }

  const flows = (['ACTIONS_RUN', 'MERGE_RESOLUTION'] as const).filter((n) =>
    bound(n)
  );
  if (flows.length > 0) {
    const all = await ctx.cf.listWorkflows(accountId);
    for (const n of flows) {
      const name = bound(n)!.workflow_name ?? '(no name)';
      const hit = all.find((x) => x.name === name);
      if (!hit) throw missing(n, 'workflow', name);
      // Deploying would rebind another worker's Workflow: never take it over.
      if (hit.scriptName !== worker) {
        throw new Error(
          `Binding ${n} points to workflow ${name}, which belongs to worker ${hit.scriptName}, not ${worker}. ${NOTHING}`
        );
      }
      out.push(adopted(n, name, name));
    }
  }
  return out;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One line per resource kind, padded like the rest of the report. */
const row = (kind: string, text: string) => `  ${kind.padEnd(10)} ${text}`;
const NOT_BOUND = 'not bound; the first upgrade creates it';
const NOT_VERIFIED = '(bound, not verified)';

/**
 * What adopting `worker` would record, as a report and its digest. Read-only: Cloudflare reads,
 * one GET of `/.well-known/gitorange` (and the GitHub compare `compareRunning` makes), nothing
 * written. Throws (with what was found) on anything it cannot map.
 */
export async function planAdoptWorker(
  ctx: Ctx,
  o: { accountId: string; worker: string }
): Promise<{
  state: InstallState;
  report: string;
  digest: string;
  /** Printed after the report, outside its digest: why a binding could not be verified. */
  notes: string[];
}> {
  const { accountId, worker } = o;
  const badName = validateName(worker);
  if (badName) {
    throw new Error(
      `Worker ${worker} cannot be an installation name: ${badName} ${NOTHING}`
    );
  }
  const settings = await ctx.cf.workerSettings(accountId, worker);
  if (!settings) throw new Error(noWorker(worker, accountId));
  const { bindings } = settings;
  const shape = templateShape(ctx);

  // Durable Object classes: the generated config declares exactly the template's, so a class the
  // worker has beyond them (bound or only exported) would be left out of the first upgrade.
  const namespaces = (await ctx.cf.durableObjectNamespaces(accountId)).filter(
    (n) => n.script === worker
  );
  const ownClasses = [
    ...new Set([
      ...bindings
        .filter((b) => ownDo(b, worker))
        .map((b) => b.class_name ?? '(no class)'),
      ...namespaces.map((n) => n.class),
    ]),
  ];
  const unknownClasses = ownClasses.filter((c) => !shape.classes.includes(c));
  if (unknownClasses.length > 0) {
    throw new Error(
      `Worker ${worker} has Durable Object classes GitOrange's template does not declare: ${unknownClasses.join(', ')}. ` +
        `The first upgrade's config declares exactly the template's classes (${shape.classes.join(', ')}). ${NOTHING}`
    );
  }

  const unknown = bindings.filter((b) => {
    if (isTemplate(b)) return false;
    if (b.name === ARTIFACTS.name && b.type === ARTIFACTS.type) return false;
    if (OTHER_BINDINGS[b.name] === b.type || OTHER_TYPES.has(b.type))
      return false;
    // A Durable Object binding is the template's when it binds the template's name to its class here.
    return !(ownDo(b, worker) && shape.doBindings.get(b.name) === b.class_name);
  });
  if (unknown.length > 0) {
    throw new Error(
      `Worker ${worker} has bindings GitOrange's template does not: ${unknown.map((b) => `${b.name} (${b.type})`).join(', ')}. ${NOTHING}`
    );
  }
  const vars = plainTextVars(bindings);
  if (vars.GITORANGE_INSTALLATION) {
    throw new Error(
      `Worker ${worker} already carries a gitorange installation (GITORANGE_INSTALLATION): adopt it from its checkout with ${ctx.source.command('adopt --from <checkout>')}. ${NOTHING}`
    );
  }
  const secrets = bindings
    .filter((b) => b.type === 'secret_text')
    .map((b) => b.name)
    .sort();

  const resources = await boundResources(ctx, accountId, worker, bindings);
  const names: ResourceNames = { ...resourceNames(worker), worker };
  for (const r of resources) names[r.key as keyof ResourceNames] = r.name;
  resources.push({
    key: 'worker',
    kind: 'worker',
    name: worker,
    id: worker,
    ownership: 'adopted',
    state: 'ready',
  });

  // Each bound Durable Object class exists here, on SQLite storage (the template declares SQLite).
  for (const b of bindings.filter((x) => ownDo(x, worker))) {
    if (!namespaces.some((n) => n.class === b.class_name)) {
      throw new Error(
        `Binding ${b.name} points to Durable Object class ${b.class_name}, which does not exist on ${worker}. ${NOTHING}`
      );
    }
  }
  const kv = namespaces.filter((n) => n.sqlite === false).map((n) => n.class);
  if (kv.length > 0) {
    throw new Error(
      `Durable Object class ${kv.join(', ')} on ${worker} uses the KV storage backend; the template declares it with SQLite storage. ${NOTHING}`
    );
  }
  const doNamespaceIds: Record<string, string> = {};
  for (const n of namespaces) {
    const v = DO_VARS[n.class];
    if (v) doNamespaceIds[v] = n.id;
  }

  // Unverifiable bindings (spec §7): accepted on the binding, the reason printed outside the digest.
  const notes: string[] = [];
  const artifactsBinding = bindings.find(
    (b) => b.name === ARTIFACTS.name && b.type === ARTIFACTS.type
  );
  let artifactsLine = row('artifacts', `${names.artifacts}: ${NOT_BOUND}`);
  if (artifactsBinding) {
    const ns = artifactsBinding.namespace ?? '(no namespace)';
    names.artifacts = ns;
    let why: string | null = null;
    try {
      if (!(await ctx.cf.listArtifactsNamespaces(accountId)).includes(ns))
        why = 'the API does not list it';
    } catch (e) {
      why = message(e);
    }
    artifactsLine = row('artifacts', why ? `${ns} ${NOT_VERIFIED}` : ns);
    if (why)
      notes.push(
        `Note: the Artifacts namespace ${ns} could not be confirmed (${why}); its binding on ${worker} is taken as the proof.`
      );
  }

  // The containers application follows the worker: wrangler names it <worker>-<class> and refuses
  // to deploy over an application of the same namespace under another name.
  const cls = shape.containerClass;
  const containerName = cls ? `${worker}-${cls}`.toLowerCase() : null;
  let containersLine: string | null = null;
  if (cls && containerName) {
    const ns = namespaces.find((n) => n.class === cls);
    containersLine = row('containers', `${containerName}: ${NOT_BOUND}`);
    if (ns) {
      let apps: { id: string; name: string; namespaceId: string | null }[] = [];
      let why: string | null = null;
      try {
        apps = await ctx.cf.listContainerApps(accountId);
      } catch (e) {
        why = message(e);
      }
      const app = apps.find((a) => a.namespaceId === ns.id || a.id === ns.id);
      if (!app) why ??= `the API lists no application for ${cls}`;
      if (app && app.name !== containerName) {
        throw new Error(
          `The containers application for ${cls} is named ${app.name}, but the generated config names it ${containerName}; wrangler refuses to deploy over an application with another name. ${NOTHING}`
        );
      }
      containersLine = row(
        'containers',
        why ? `${containerName} ${NOT_VERIFIED}` : containerName
      );
      if (why)
        notes.push(
          `Note: the containers application ${containerName} could not be confirmed (${why}); its ${cls} binding on ${worker} is taken as the proof.`
        );
    }
  }

  const hostname = await servedOn(ctx, accountId, worker, vars.BASE_URL);
  let baseUrl = `https://${hostname}`;
  if (hostname === null) {
    const sub = await ctx.cf.workersSubdomain(accountId);
    if (!sub) {
      throw new Error(
        `Worker ${worker} has no custom domain and the account has no workers.dev subdomain: no URL serves it. ${NOTHING}`
      );
    }
    baseUrl = `https://${worker}.${sub}.workers.dev`;
  }
  // A zone route (or a BASE_URL naming another host) would silently move the install's URL.
  const deployedHost = hostOf(vars.BASE_URL);
  if (deployedHost && deployedHost !== new URL(baseUrl).hostname) {
    throw new Error(
      `BASE_URL is ${vars.BASE_URL}, but the worker has no custom domain for it (adopt would record ${baseUrl}). Routes other than custom domains are not supported by adopt. ${NOTHING}`
    );
  }

  // Tunable vars the operator set away from the template's defaults are kept as found.
  const kept: Record<string, string> = {};
  for (const k of [...TUNABLE_VARS].sort()) {
    const v = vars[k];
    if (v !== undefined && v !== shape.vars[k]) kept[k] = v;
  }

  const fresh = newState({
    installationId: installationIdOf(
      accountId,
      worker,
      hostname ?? 'workers.dev'
    ),
    accountId,
    inputs: {
      name: worker,
      hostname,
      workersDev: hostname === null,
      fromEmail: vars.FROM_EMAIL || null,
      ...(Object.keys(kept).length > 0 ? { vars: kept } : {}),
    },
    names,
    baseUrl,
  });
  const s: InstallState = {
    ...fresh,
    status: 'installed',
    resources,
    doNamespaceIds,
  };

  const to = await ctx.source.version(ctx.runner);
  // What the first upgrade cannot carry over stops here, before anything is written.
  const changes = varChanges(vars, configVars(renderConfig(ctx, s, to).text));
  if (changes.stops.length > 0)
    throw varStops(
      worker,
      changes.stops,
      'the first upgrade',
      'run adopt again'
    );

  const running =
    (await wellKnownVersion(ctx, baseUrl)) ?? (vars.GITORANGE_VERSION || null);
  if (running !== null) s.deployedVersion = running;
  const cmp = await compareRunning(
    running,
    { version: to, commit: ctx.source.commit ?? '' },
    ctx.fetchImpl
  );

  const list = (xs: string[]) => (xs.length > 0 ? xs.join(', ') : 'none');
  const present = shape.classes.filter((c) => ownClasses.includes(c));
  const absent = shape.classes.filter((c) => !ownClasses.includes(c));
  const i = s.inputs;
  const lines: string[] = [];
  if (cmp.kind === 'custom') {
    lines.push(
      `The first upgrade will need --replace-custom-code: ${cmp.reason}.`,
      ''
    );
  }
  lines.push(
    `Adopt worker ${worker} on account ${accountId} as ${i.name}`,
    `  Installation   ${s.installationId}`,
    `  URL            ${baseUrl}`,
    '',
    'Resources (recorded as adopted, as found):',
    ...resources.map((r) =>
      row(r.kind, `${r.name}${r.id !== r.name ? ` (${r.id})` : ''}`)
    ),
    ...TEMPLATE_NAMES.filter(
      (n) => !resources.some((r) => r.key === TEMPLATE[n].key)
    ).map((n) =>
      row(TEMPLATE[n].kind, `${names[TEMPLATE[n].key]}: ${NOT_BOUND}`)
    ),
    artifactsLine,
    ...(containersLine ? [containersLine] : []),
    `  durable objects  ${list(present)}${absent.length > 0 ? `; the first upgrade adds ${absent.join(', ')}` : ''}`,
    '',
    'Inputs:',
    `  Hostname       ${i.hostname ?? 'workers.dev'}`,
    `  Sender         ${i.fromEmail ?? '(none: email is off)'}`,
    ...Object.entries(kept).map(
      ([k, v]) => `  Kept: ${k} ${JSON.stringify(v)}`
    ),
    '',
    `Secrets on the worker (names only): ${list(secrets)}`
  );
  if (changes.drops.length > 0)
    lines.push(
      '',
      'The first upgrade drops these vars (the worker does not need them):',
      ...changes.drops
    );
  lines.push(
    '',
    `Running ${running ?? 'unknown'}; this package ${to} (${cmp.kind === 'custom' ? `custom: ${cmp.reason}` : cmp.kind})`,
    'Adopt deploys nothing and changes nothing on Cloudflare; the first upgrade deploys this package.'
  );
  const report = lines.join('\n');
  const digest = createHash('sha256').update(report).digest('hex').slice(0, 12);
  return { state: s, report, digest, notes };
}

/**
 * Prints the plan, then (after confirm, `yes`, or a matching `expectPlan`) writes the state and
 * the generated wrangler.jsonc into `<home>/<worker>/`. Deploys nothing.
 */
export async function adoptWorker(
  outer: Ctx,
  o: {
    accountId: string;
    worker: string;
    yes: boolean;
    expectPlan?: string;
    home: string;
  }
): Promise<InstallState> {
  const dir = installDir(o.home, o.worker);
  const ctx: Ctx = { ...outer, dir, configDir: dir };
  const taken = () => {
    if (listStates(dir).length > 0)
      throw new Error(`${dir} already has an install. ${NOTHING}`);
  };
  taken();
  const p = await planAdoptWorker(ctx, o);
  ctx.io.print(p.report);
  for (const n of p.notes) ctx.io.print(`\n${n}`);
  if (o.expectPlan !== undefined && o.expectPlan !== p.digest) {
    throw new Error(
      `The plan changed since it was reviewed (expected ${o.expectPlan}, now ${p.digest}). Review it again with --plan. ${NOTHING}`
    );
  }
  const consented =
    o.yes ||
    o.expectPlan === p.digest ||
    (await ctx.io.confirm('Adopt this install?', true));
  if (!consented) throw new Error(NOTHING);

  const s: InstallState = { ...p.state, adoptedAt: ctx.now().toISOString() };
  const configFile = join(dir, 'wrangler.jsonc');
  const dirExisted = existsSync(dir);
  const configExisted = existsSync(configFile);
  let release: (() => void) | undefined = acquireLock(dir, s.installationId);
  try {
    taken();
    // Config first: a state file is what makes the directory an install.
    writeConfig(ctx, s, s.deployedVersion ?? '');
    writeState(dir, s);
  } catch (e) {
    if (!configExisted) rmSync(configFile, { force: true });
    release();
    release = undefined;
    if (!dirExisted) rmSync(dir, { recursive: true, force: true });
    throw e;
  } finally {
    release?.();
  }
  ctx.io.print(
    `Adopted ${o.worker} into ${dir}.\nCheck it: ${ctx.source.command(`status --name ${o.worker}`)}\nUpgrade it: ${ctx.source.command(`upgrade --name ${o.worker}`)}`
  );
  return s;
}
