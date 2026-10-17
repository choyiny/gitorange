import type { Cloudflare } from './cloudflare.ts';
import type { ResourceNames } from './names.ts';

export const R2_MARKER_KEY = '.gitorange/ownership.json';

const TABLES_SQL =
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' " +
  "AND name NOT IN ('sqlite_sequence','d1_migrations')";
const INSTALL_ROW_SQL =
  'SELECT installation_id, ownership_nonce FROM install_state LIMIT 1';

export interface InstallRow {
  installation_id: string;
  ownership_nonce: string;
}

/** What Cloudflare holds right now, as far as the plan needs to know. */
export interface Observed {
  /** `vars` holds plain-text vars; null when the worker does not exist. */
  worker: { exists: boolean; vars: Record<string, string> | null };
  d1: { uuid: string; name: string }[];
  /** User tables per D1 uuid, only for databases named `names.d1`. */
  d1Tables: Record<string, string[]>;
  /** The `install_state` row per D1 uuid (null: no table or no row), only for `names.d1`. */
  d1InstallRow: Record<string, InstallRow | null>;
  r2: string[];
  /** Raw ownership marker body per bucket (null: no marker), only for our buckets that exist. */
  r2Markers: Record<string, string | null>;
  workflows: { name: string; scriptName: string }[];
  artifactsNamespaces: string[];
}

/** Read-only: every list call runs in parallel, then the per-resource lookups for our names. */
export async function observe(
  cf: Cloudflare,
  accountId: string,
  names: ResourceNames
): Promise<Observed> {
  const [vars, d1, r2, workflows, artifactsNamespaces] = await Promise.all([
    cf.workerVars(accountId, names.worker),
    cf.listD1(accountId),
    cf.listR2(accountId),
    cf.listWorkflows(accountId),
    cf.listArtifactsNamespaces(accountId),
  ]);

  const ours = d1.filter((d) => d.name === names.d1);
  const buckets = [names.lfs, names.actionsLogs, names.actionsCache].filter(
    (b) => r2.includes(b)
  );

  const [d1Reads, markers] = await Promise.all([
    Promise.all(
      ours.map(async (db) => {
        const rows = await cf.queryD1(accountId, db.uuid, TABLES_SQL);
        const tables = rows.map((r) => String(r.name));
        let row: InstallRow | null = null;
        if (tables.includes('install_state')) {
          const found = await cf.queryD1(accountId, db.uuid, INSTALL_ROW_SQL);
          if (found[0]) {
            row = {
              installation_id: String(found[0].installation_id),
              ownership_nonce: String(found[0].ownership_nonce),
            };
          }
        }
        return { uuid: db.uuid, tables, row };
      })
    ),
    Promise.all(
      buckets.map(
        async (b) =>
          [b, await cf.getR2Object(accountId, b, R2_MARKER_KEY)] as const
      )
    ),
  ]);

  const d1Tables: Observed['d1Tables'] = {};
  const d1InstallRow: Observed['d1InstallRow'] = {};
  for (const r of d1Reads) {
    d1Tables[r.uuid] = r.tables;
    d1InstallRow[r.uuid] = r.row;
  }

  return {
    worker: { exists: vars !== null, vars },
    d1,
    d1Tables,
    d1InstallRow,
    r2,
    r2Markers: Object.fromEntries(markers),
    workflows,
    artifactsNamespaces,
  };
}
