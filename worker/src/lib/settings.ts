import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { DrizzleDB } from '../db/middleware';
import { instanceSettings } from '../db/app.schema';
import { DEFAULT_APP_NAME } from './app-name';

/**
 * Instance settings a site admin changes in Site admin, without a deploy. Each has a default:
 * the wrangler var it replaces (so existing deploys keep working), or a built-in value. Values
 * are read only where they are used (invitations, reviews, the MCP handshake, page loads), never
 * on every request; deploy-time facts (BASE_URL, bucket names, the R2 account) stay in wrangler.
 */
type Definition<T> = {
  label: string;
  description: string;
  group: 'General' | 'AI models' | 'Actions';
  schema: z.ZodType<T>;
  default: (env: CloudflareBindings) => T;
};

const modelId = z
  .string()
  .trim()
  .regex(
    /^@cf\/[\w.-]+\/[\w.:-]+$/,
    'A Workers AI model id, like @cf/zai-org/glm-5.3'
  );

export const SETTINGS = {
  'app.name': {
    label: 'Instance name',
    description:
      'Shown in page titles, sign-in and setup pages, invitation emails, the git sign-in prompt, and as the MCP server name.',
    group: 'General',
    schema: z.string().trim().min(1).max(60),
    default: (env) => env.APP_NAME?.trim() || DEFAULT_APP_NAME,
  } satisfies Definition<string>,
  'email.from': {
    label: 'Invitation sender',
    description:
      'The address invitation emails come from. Its domain must be onboarded to Cloudflare Email Sending.',
    group: 'General',
    schema: z.string().trim().email(),
    default: (env) => env.FROM_EMAIL,
  } satisfies Definition<string>,
  'ai.resolver_model': {
    label: 'Conflict resolution model',
    description:
      'Workers AI model the conflict-resolution agent uses. It must support tool calling.',
    group: 'AI models',
    schema: modelId,
    default: (env) => env.RESOLVER_MODEL || '@cf/zai-org/glm-5.3',
  } satisfies Definition<string>,
  'ai.summary_model': {
    label: 'Review summary model',
    description:
      'Writes the one-line summary of each changed file in a review.',
    group: 'AI models',
    schema: modelId,
    default: (env) => env.SUMMARY_MODEL || '@cf/zai-org/glm-5.3-flash',
  } satisfies Definition<string>,
  'ai.review_model': {
    label: 'Agent review model',
    description:
      "Runs each reviewer agent's review and writes its findings' explanations and diagrams.",
    group: 'AI models',
    schema: modelId,
    default: (env) => env.REVIEW_MODEL || '@cf/zai-org/glm-5.3',
  } satisfies Definition<string>,
  'actions.retention_days': {
    label: 'Keep Actions runs for',
    description:
      'Finished workflow runs, with their jobs, steps, and logs, are deleted this many days after they finish, and agent runs this many days after they start. Empty keeps them forever.',
    group: 'Actions',
    schema: z.number().int().min(1).max(400).nullable(),
    default: () => 90,
  } satisfies Definition<number | null>,
  'actions.max_concurrent_jobs': {
    label: 'Jobs running at once',
    description:
      'The most Actions jobs that run at the same time across the instance, each in its own container. Jobs past the limit wait in a queue, first come first served, and the run page shows how many are ahead.',
    group: 'Actions',
    schema: z.number().int().min(1).max(500),
    default: () => 10,
  } satisfies Definition<number>,
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = ReturnType<
  (typeof SETTINGS)[K]['default']
>;

export const isSettingKey = (k: string): k is SettingKey => k in SETTINGS;

/** Several settings in one query, each falling back to its default. */
export async function getSettings<K extends SettingKey>(
  db: DrizzleDB,
  env: CloudflareBindings,
  keys: K[]
): Promise<{ [P in K]: SettingValue<P> }> {
  const rows = keys.length
    ? await db
        .select()
        .from(instanceSettings)
        .where(inArray(instanceSettings.key, keys))
        .all()
    : [];
  const out = {} as { [P in K]: SettingValue<P> };
  for (const key of keys) {
    const row = rows.find((r) => r.key === key);
    // A stored value that no longer validates (the rules changed) falls back to the default.
    const parsed = row
      ? (SETTINGS[key].schema as z.ZodType).safeParse(row.value)
      : null;
    out[key] = (
      parsed?.success ? parsed.data : SETTINGS[key].default(env)
    ) as SettingValue<K>;
  }
  return out;
}

export async function getSetting<K extends SettingKey>(
  db: DrizzleDB,
  env: CloudflareBindings,
  key: K
): Promise<SettingValue<K>> {
  return (await getSettings(db, env, [key]))[key];
}

/**
 * Saves a setting, or with `value === undefined` resets it to its default. Throws a ZodError
 * when the value doesn't validate.
 */
export async function setSetting(
  db: DrizzleDB,
  key: SettingKey,
  value: unknown,
  userId: string
) {
  if (value === undefined) {
    await db.delete(instanceSettings).where(eq(instanceSettings.key, key));
    return;
  }
  const parsed = (SETTINGS[key].schema as z.ZodType).parse(value);
  const row = {
    key,
    value: parsed,
    updatedById: userId,
    updatedAt: new Date(),
  };
  await db
    .insert(instanceSettings)
    .values(row)
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: parsed, updatedById: userId, updatedAt: row.updatedAt },
    });
}

/** Every setting with its current value, default, and whether it was changed, for Site admin. */
export async function listSettings(db: DrizzleDB, env: CloudflareBindings) {
  const rows = await db.select().from(instanceSettings).all();
  return (Object.keys(SETTINGS) as SettingKey[]).map((key) => {
    const def = SETTINGS[key];
    const row = rows.find((r) => r.key === key);
    const parsed = row ? (def.schema as z.ZodType).safeParse(row.value) : null;
    const fallback = def.default(env);
    return {
      key,
      label: def.label,
      description: def.description,
      group: def.group,
      value: parsed?.success ? parsed.data : fallback,
      default: fallback,
      overridden: Boolean(parsed?.success),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  });
}

/** The instance's display name: Site admin's setting, else `APP_NAME`, else "GitOrange". */
export const instanceName = (db: DrizzleDB, env: CloudflareBindings) =>
  getSetting(db, env, 'app.name');

// Internal state kept beside the settings (not shown in Site admin as an editable setting).
export const RETENTION_STATUS_KEY = 'actions.retention_status';
