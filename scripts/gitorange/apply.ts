// Apply (spec §6): creates what the plan says, step by step, recording each idempotency key in the
// state file so a rerun (`--resume`) continues from the first unrecorded step. Step helpers live
// in apply-steps.ts.
import {
  applyMigrations,
  assertConfigWritable,
  buildVersion,
  confirmR2Keys,
  deploy,
  existingSecretNames,
  migrationsDigest,
  optionalSecrets,
  readDoNamespaceIds,
  sameIds,
  skippedAfter,
  summary,
  verify,
  writeConfig,
  writeInstallRow,
  type Ctx,
  type Optional,
} from './apply-steps.ts';
import { observe, R2_MARKER_KEY, type Observed } from './observe.ts';
import { computePlan, formatPlan, type Desired } from './plan.ts';
import {
  generateAuthSecret,
  generateSetupCode,
  setupCodeHash,
} from './secrets.ts';
import {
  acquireLock,
  hasStep,
  recordResource,
  recordStep,
  transition,
  writeState,
  type InstallState,
  type Resource,
  type Status,
} from './state.ts';

export { verify, type Ctx, type Optional };

const desiredOf = (s: InstallState): Desired => ({
  installationId: s.installationId,
  ownershipNonce: s.ownershipNonce,
  names: s.names,
});

const resource = (
  key: string,
  kind: Resource['kind'],
  name: string,
  id: string
): Resource => ({ key, kind, name, id, ownership: 'created', state: 'ready' });

const RANK: Record<Status, number> = {
  planned: 0,
  failed: 0,
  provisioning: 1,
  deploying: 2,
  verifying: 3,
  installed: 4,
};

function wrap(e: unknown, step: string, s: InstallState): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(
    `${msg}\n\nStep ${step} failed. Nothing after it ran. Run: yarn gitorange install --resume --name ${s.inputs.name}`,
    { cause: e }
  );
}

export async function install(
  ctx: Ctx,
  opts: {
    state: InstallState;
    expectPlan?: string;
    yes: boolean;
    optional: Optional;
  }
): Promise<InstallState> {
  let s = opts.state;
  let step = 'plan';
  let code: string | null = null;
  let optional = opts.optional;
  const acct = s.accountId;
  const save = (next: InstallState) => {
    s = next;
    writeState(ctx.dir, s);
  };
  // A resumed run may already be past a phase (e.g. killed while verifying): never move back.
  const enter = (to: Status) => {
    if (RANK[s.status] < RANK[to] || s.status === 'failed') {
      save(transition(s, to));
    }
  };

  const release = acquireLock(ctx.dir, s.installationId);
  try {
    // 1. Draft saved, lock held; the plan is recomputed against Cloudflare as it is now.
    save(s);
    assertConfigWritable(ctx);
    const desired = desiredOf(s);
    let obs: Observed = await observe(ctx.cf, acct, s.names);
    const plan = computePlan(desired, obs, s);
    if (opts.expectPlan !== undefined && opts.expectPlan !== plan.digest) {
      throw new Error(
        `The plan changed since it was reviewed (expected ${opts.expectPlan}, now ${plan.digest}):\n\n` +
          `${formatPlan(plan, s.inputs, s.baseUrl)}\n\nReview it again with --plan, then apply with --expect-plan ${plan.digest}.`
      );
    }
    enter('provisioning');

    // 2. D1 and R2 (Workflows and the worker come from the deploy).
    for (const a of plan.actions) {
      if (a.kind !== 'd1' && a.kind !== 'r2') continue;
      if (s.resources.some((r) => r.key === a.key)) continue;
      step = `provision:${a.key}`;
      let action = a.action;
      if (action === 'create') {
        save(recordStep(s, `provision-intent:${a.key}`));
        // Look again: a PlanStop if someone else took the name meanwhile.
        obs = await observe(ctx.cf, acct, s.names);
        action = computePlan(desired, obs, s).actions.find(
          (x) => x.key === a.key
        )!.action;
      }
      let id: string;
      if (a.kind === 'd1') {
        id =
          action === 'create'
            ? (await ctx.cf.createD1(acct, a.name)).uuid
            : obs.d1.find((d) => d.name === a.name)!.uuid;
      } else {
        if (action === 'create') {
          await ctx.cf.createR2(acct, a.name);
          // The marker goes in before the bucket is recorded: a recorded bucket always has one.
          await ctx.cf.putR2Object(
            acct,
            a.name,
            R2_MARKER_KEY,
            JSON.stringify({
              installationId: s.installationId,
              ownershipNonce: s.ownershipNonce,
              key: a.key,
            })
          );
        }
        id = a.name;
      }
      save(recordResource(s, resource(a.key, a.kind, a.name, id)));
    }
    if (!hasStep(s, 'lifecycle:v1')) {
      step = 'lifecycle:v1';
      await ctx.cf.putR2Lifecycle(acct, s.names.actionsCache, [
        { id: 'expire-7d', prefix: 'actions-cache/', days: 7 },
      ]);
      save(recordStep(s, step));
    }

    // 2b. Supplied R2 keys are checked against the LFS bucket before anything is deployed.
    if (optional.r2) {
      step = 'r2-keys';
      optional = { ...optional, r2: await confirmR2Keys(ctx, s, optional.r2) };
    }

    // 3. wrangler.jsonc
    step = 'config';
    const version = await buildVersion(ctx);
    save(recordStep(s, `config:${writeConfig(ctx, s, version)}`));

    // 4. Migrations, then the install_state row (the D1 ownership marker).
    const digest = migrationsDigest(ctx.cwd);
    if (!hasStep(s, `migrations:${digest}`)) {
      step = `migrations:${digest}`;
      await applyMigrations(ctx);
      const d1 = s.resources.find((r) => r.key === 'd1')!;
      await writeInstallRow(ctx, s, d1.id, version, digest);
      save(recordStep(s, step));
    }

    // 5–6. Secrets and the first deploy.
    if (!hasStep(s, 'deploy:1')) {
      step = 'secrets';
      const workerIsNew =
        plan.actions.find((a) => a.key === 'worker')?.action === 'create';
      const have = await existingSecretNames(ctx, s.names.worker, workerIsNew);
      const secrets: Record<string, string> = {};
      if (!have.includes('BETTER_AUTH_SECRET')) {
        secrets.BETTER_AUTH_SECRET = generateAuthSecret();
      }
      if (!hasStep(s, 'setup-code:1')) {
        code = generateSetupCode();
        secrets.SETUP_CODE_HASH = setupCodeHash(code);
      }
      Object.assign(secrets, optionalSecrets(optional));
      step = 'deploy:1';
      enter('deploying');
      await deploy(ctx, secrets);
      s = recordStep(s, 'deploy:1');
      if (code) s = recordStep(s, 'setup-code:1');
      for (const key of [
        'worker',
        'actionsWorkflow',
        'mergeWorkflow',
      ] as const) {
        const kind = key === 'worker' ? 'worker' : 'workflow';
        s = recordResource(s, resource(key, kind, s.names[key], s.names[key]));
      }
      save({ ...s, skipped: skippedAfter(null, optional) });
    } else if (Object.keys(optionalSecrets(optional)).length > 0) {
      // Resumed past the first deploy with credentials supplied now: send just those.
      step = 'deploy:credentials';
      enter('deploying');
      await deploy(ctx, optionalSecrets(optional));
      save({ ...s, skipped: skippedAfter(s.skipped, optional) });
    }

    // 7. Durable Object namespace ids: one more deploy only when they changed.
    if (!hasStep(s, 'do-namespaces')) {
      step = 'do-namespaces';
      enter('deploying');
      const ids = await readDoNamespaceIds(ctx, s);
      if (!sameIds(ids, s.doNamespaceIds)) {
        writeConfig(ctx, s, version, ids);
        await deploy(ctx, {});
      }
      save(recordStep({ ...s, doNamespaceIds: ids }, step));
    }

    // 8. Verify.
    step = 'verify';
    enter('verifying');
    await verify(ctx, s);

    // 9. Done.
    step = 'summary';
    save(transition(s, 'installed'));
  } catch (e) {
    if (s.status !== 'installed') s = transition(s, 'failed');
    writeState(ctx.dir, s);
    throw wrap(e, step, s);
  } finally {
    release();
  }
  ctx.io.print(summary(s, code, optional));
  return s;
}

/**
 * `--resume` on an installed instance (spec §6): adds supplied optional credentials and reissues
 * a lost setup code while no user exists, in one deploy; otherwise only verifies. The status stays
 * `installed` throughout.
 */
export async function resumeInstalled(
  ctx: Ctx,
  state: InstallState,
  optional: Optional
): Promise<InstallState> {
  let s = state;
  let step = 'r2-keys';
  let code: string | null = null;
  let opt = optional;
  const release = acquireLock(ctx.dir, s.installationId);
  try {
    if (opt.r2) opt = { ...opt, r2: await confirmR2Keys(ctx, s, opt.r2) };

    step = 'setup-status';
    const statusUrl = `${s.baseUrl}/api/setup/status`;
    const res = await ctx.fetchImpl(statusUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`${statusUrl} answered HTTP ${res.status}.`);
    const { setupRequired } = (await res.json()) as { setupRequired?: boolean };

    const secrets = optionalSecrets(opt);
    if (setupRequired) {
      code = generateSetupCode();
      secrets.SETUP_CODE_HASH = setupCodeHash(code);
    }
    const changed = Object.keys(secrets).length > 0;
    if (changed) {
      step = 'config';
      assertConfigWritable(ctx);
      writeConfig(ctx, s, await buildVersion(ctx));
      step = 'deploy';
      await deploy(ctx, secrets);
      if (code) {
        const n = s.steps.filter((x) => x.key.startsWith('setup-code:')).length;
        s = recordStep(s, `setup-code:${n + 1}`);
      }
      s = { ...s, skipped: skippedAfter(s.skipped, opt) };
      writeState(ctx.dir, s);
    }

    step = 'verify';
    await verify(ctx, s);
    ctx.io.print(changed ? summary(s, code, opt) : 'Nothing to do.');
    return s;
  } catch (e) {
    writeState(ctx.dir, s);
    throw wrap(e, step, s);
  } finally {
    release();
  }
}
