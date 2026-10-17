import { createHash } from 'node:crypto';
import type { ResourceNames } from './names.ts';
import type { Observed } from './observe.ts';
import {
  hasStep,
  type InstallState,
  type Resource,
  type ResourceKind,
} from './state.ts';

export type Action = {
  action: 'create' | 'reuse' | 'deploy';
  kind: ResourceKind;
  key: string;
  name: string;
};

export type Plan = {
  installationId: string;
  actions: Action[];
  info: string[];
  digest: string;
};

/** The plan cannot go ahead; the message is the text shown to the person. */
export class PlanStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanStop';
  }
}

export interface Desired {
  installationId: string;
  ownershipNonce: string;
  names: ResourceNames;
}

type Key = Exclude<keyof ResourceNames, 'artifacts'>;

const ORDER: { key: Key; kind: ResourceKind }[] = [
  { key: 'd1', kind: 'd1' },
  { key: 'lfs', kind: 'r2' },
  { key: 'actionsLogs', kind: 'r2' },
  { key: 'actionsCache', kind: 'r2' },
  { key: 'actionsWorkflow', kind: 'workflow' },
  { key: 'mergeWorkflow', kind: 'workflow' },
  { key: 'worker', kind: 'worker' },
];

export const NO_CHANGE_LINE =
  'No Cloudflare resource or local file was changed.';

const notOurs = (name: string) =>
  new PlanStop(
    `\`${name}\` already exists and was not created by this installation. Nothing was changed.`
  );

const recordedButMissing = (name: string) =>
  new PlanStop(
    `\`${name}\` is recorded but missing in Cloudflare. It may have been deleted outside this installer. Nothing was changed.`
  );

function parseObject(
  raw: string | null | undefined
): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** One resource's action, or a PlanStop. `recorded` is this key's state-file entry, if any. */
function decide(
  key: Key,
  kind: ResourceKind,
  desired: Desired,
  observed: Observed,
  state: InstallState | null,
  recorded: Resource | undefined
): Action['action'] {
  const name = desired.names[key];
  const { installationId, ownershipNonce } = desired;

  switch (kind) {
    case 'd1': {
      const matches = observed.d1.filter((d) => d.name === name);
      if (matches.length > 1) {
        throw new PlanStop(
          `More than one D1 database is named \`${name}\`. Nothing was changed.`
        );
      }
      const db = matches[0];
      if (recorded) {
        if (!db || db.uuid !== recorded.id) {
          throw recordedButMissing(name);
        }
        return 'reuse';
      }
      if (!db) {
        return 'create';
      }
      const row = observed.d1InstallRow[db.uuid];
      if (
        row &&
        row.installation_id === installationId &&
        row.ownership_nonce === ownershipNonce
      ) {
        return 'reuse';
      }
      // A run killed between create and record: our intent, and nothing written to it yet.
      const tables = observed.d1Tables[db.uuid];
      if (
        state &&
        hasStep(state, `provision-intent:${key}`) &&
        tables !== undefined &&
        tables.length === 0
      ) {
        return 'reuse';
      }
      throw notOurs(name);
    }
    case 'r2': {
      // Spec §6: the marker, not the recorded name, proves ownership. Apply writes the marker
      // before it records the bucket, so a recorded bucket always has one.
      if (!observed.r2.includes(name)) {
        if (recorded) {
          throw recordedButMissing(name);
        }
        return 'create';
      }
      const raw = observed.r2Markers[name];
      const m = parseObject(raw);
      if (
        m &&
        m.installationId === installationId &&
        m.ownershipNonce === ownershipNonce &&
        m.key === key
      ) {
        return 'reuse';
      }
      // A run stopped between create and marker: our intent, no marker, nothing in it yet.
      // Apply writes the marker before recording it.
      const intent =
        state !== null && hasStep(state, `provision-intent:${key}`);
      if (intent && raw == null && observed.r2Empty[name] === true) {
        return 'reuse';
      }
      if (intent) {
        throw new PlanStop(
          `${notOurs(name).message} It may be the bucket this install created before it was interrupted; if it is empty, delete it and run --resume.`
        );
      }
      throw notOurs(name);
    }
    case 'workflow': {
      const matches = observed.workflows.filter((w) => w.name === name);
      if (matches.length > 1) {
        throw new PlanStop(
          `More than one Workflow is named \`${name}\`. Nothing was changed.`
        );
      }
      const wf = matches[0];
      if (!wf) {
        if (recorded) {
          throw recordedButMissing(name);
        }
        return 'create';
      }
      // Deploying would rebind a Workflow owned by another script: never take it over.
      if (wf.scriptName !== desired.names.worker) {
        throw notOurs(name);
      }
      return 'reuse';
    }
    case 'worker': {
      if (!observed.worker.exists) {
        if (recorded) {
          throw recordedButMissing(name);
        }
        return 'create';
      }
      const m = parseObject(observed.worker.vars?.GITORANGE_INSTALLATION);
      if (
        m &&
        m.installationId === installationId &&
        m.ownershipNonce === ownershipNonce
      ) {
        return 'deploy';
      }
      throw notOurs(name);
    }
  }
}

/** Pure: what install would do, in a fixed order, or a PlanStop when anything is not provably ours. */
export function computePlan(
  desired: Desired,
  observed: Observed,
  state: InstallState | null
): Plan {
  if (
    state &&
    (state.installationId !== desired.installationId ||
      state.ownershipNonce !== desired.ownershipNonce)
  ) {
    throw new Error(
      `State for ${state.installationId} does not belong to installation ${desired.installationId}`
    );
  }
  const actions: Action[] = ORDER.map(({ key, kind }) => {
    const recorded = state?.resources.find((r) => r.key === key);
    return {
      action: decide(key, kind, desired, observed, state, recorded),
      kind,
      key,
      name: desired.names[key],
    };
  });
  const info: string[] = [];
  if (observed.artifactsNamespaces.includes(desired.names.artifacts)) {
    info.push(`existing Artifacts namespace ${desired.names.artifacts} reused`);
  }
  return {
    installationId: desired.installationId,
    actions,
    info,
    digest: planDigest(desired.installationId, actions),
  };
}

/** First 12 hex of sha256 over the installation id and the ordered {action, kind, name} list. */
export function planDigest(
  installationId: string,
  actions: Pick<Action, 'action' | 'kind' | 'name'>[]
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        installationId,
        actions.map((a) => [a.action, a.kind, a.name]),
      ])
    )
    .digest('hex')
    .slice(0, 12);
}

/** Plain text: one aligned line per action, then hostname, URL, sender, info, and the no-change line. */
export function formatPlan(
  plan: Plan,
  inputs: InstallState['inputs'],
  baseUrl: string
): string {
  const aw = Math.max(...plan.actions.map((a) => a.action.length));
  const kw = Math.max(...plan.actions.map((a) => a.kind.length));
  const lines = plan.actions.map(
    (a) => `${a.action.padEnd(aw)}  ${a.kind.padEnd(kw)}  ${a.name}`
  );
  lines.push(
    '',
    `Hostname  ${inputs.hostname ?? 'workers.dev'}`,
    `URL       ${baseUrl}`,
    `Sender    ${inputs.fromEmail ?? '(none: email is off)'}`
  );
  if (plan.info.length > 0) {
    lines.push('', ...plan.info);
  }
  lines.push('', NO_CHANGE_LINE);
  return lines.join('\n');
}
