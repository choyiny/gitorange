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
  group: 'General' | 'AI models' | 'Reviews' | 'Actions';
  schema: z.ZodType<T>;
  default: (env: CloudflareBindings) => T;
  /** Another setting this one takes its (resolved, override included) value from until it is overridden itself. */
  follows?: string;
};

const modelId = z
  .string()
  .trim()
  .regex(
    /^@cf\/[\w.-]+\/[\w.:-]+$/,
    'A Workers AI model id, like @cf/zai-org/glm-5.3'
  );

/**
 * The longest a Pi review may run. Counted from the reviewer row's created_at — PI_START_SLACK_MS, this,
 * PI_RECHECK_MS and PI_EXPIRE_SLACK_MS (review/pi-contract.ts) — it still ends before stale recovery
 * (REVIEW_STALE_MS, review/head.ts) could fail a row that is still being reviewed. The settings test pins it.
 */
export const PI_MAX_MINUTES = 60;

const whole = (min: number, max: number) => z.number().int().min(min).max(max);

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
      "Runs each reviewer agent's single-pass review (engine: pass, and engine: pi where Pi isn't set up) and writes its findings' explanations and diagrams.",
    group: 'AI models',
    schema: modelId,
    default: (env) => env.REVIEW_MODEL || '@cf/zai-org/glm-5.3',
  } satisfies Definition<string>,
  'ai.review_pi_model': {
    label: 'Agent deep review model',
    description:
      'Runs reviewer agents with `engine: pi`, which read the repository with tools. It must support tool calling. Follows the agent review model until set here.',
    group: 'AI models',
    schema: modelId,
    default: (env) => env.REVIEW_MODEL || '@cf/zai-org/glm-5.3',
    follows: 'ai.review_model',
  } satisfies Definition<string>,
  'review.pi_minutes': {
    label: 'Deep review time limit (minutes)',
    description: `How long an engine: pi review may run before it fails (Retry runs it again). From 5 to ${PI_MAX_MINUTES} minutes.`,
    group: 'Reviews',
    schema: whole(5, PI_MAX_MINUTES),
    default: () => 30,
  } satisfies Definition<number>,
  'review.pi_max_tool_calls': {
    label: 'Deep review tool calls',
    description:
      'File reads and searches one engine: pi review may make; past them it is told to answer with what it has. From 5 to 500.',
    group: 'Reviews',
    schema: whole(5, 500),
    default: () => 60,
  } satisfies Definition<number>,
  'review.pi_max_model_calls': {
    label: 'Deep review model calls',
    description:
      'Model calls one engine: pi review may make before it is stopped and fails. From 5 to 500.',
    group: 'Reviews',
    schema: whole(5, 500),
    default: () => 80,
  } satisfies Definition<number>,
  'review.pi_max_input_tokens': {
    label: 'Deep review input tokens',
    description:
      'Input tokens, summed over the whole review, before an engine: pi review is stopped and fails. From 100,000 to 50,000,000.',
    group: 'Reviews',
    schema: whole(100_000, 50_000_000),
    default: () => 4_000_000,
  } satisfies Definition<number>,
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

/** A setting's value from the stored rows: its saved value, else what it follows, else its default. */
function resolve(
  key: SettingKey,
  rows: { key: string; value: unknown }[],
  env: CloudflareBindings
): { value: unknown; overridden: boolean; fallback: unknown } {
  const def: Definition<unknown> = SETTINGS[key];
  const row = rows.find((r) => r.key === key);
  // A stored value that no longer validates (the rules changed) falls back to the default.
  const parsed = row ? def.schema.safeParse(row.value) : null;
  const fallback =
    def.follows && isSettingKey(def.follows)
      ? resolve(def.follows, rows, env).value
      : def.default(env);
  return {
    value: parsed?.success ? parsed.data : fallback,
    overridden: Boolean(parsed?.success),
    fallback,
  };
}

/** Several settings in one query, each falling back to its default. */
export async function getSettings<K extends SettingKey>(
  db: DrizzleDB,
  env: CloudflareBindings,
  keys: K[]
): Promise<{ [P in K]: SettingValue<P> }> {
  const wanted: string[] = [...keys];
  for (const key of keys) {
    const f = (SETTINGS[key] as Definition<unknown>).follows;
    if (f) wanted.push(f);
  }
  const rows = keys.length
    ? await db
        .select()
        .from(instanceSettings)
        .where(inArray(instanceSettings.key, wanted))
        .all()
    : [];
  const out = {} as { [P in K]: SettingValue<P> };
  for (const key of keys)
    out[key] = resolve(key, rows, env).value as SettingValue<K>;
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
    const def: Definition<unknown> = SETTINGS[key];
    const row = rows.find((r) => r.key === key);
    const r = resolve(key, rows, env);
    return {
      key,
      label: def.label,
      description: def.description,
      group: def.group,
      value: r.value,
      default: r.fallback,
      overridden: r.overridden,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      ...bounds(def.schema),
    };
  });
}

/** A number setting's inclusive limits, for the Site admin input. */
function bounds(schema: z.ZodType): { min?: number; max?: number } {
  if (!(schema instanceof z.ZodNumber)) return {};
  const { minValue, maxValue } = schema;
  return {
    ...(Number.isFinite(minValue) && { min: minValue as number }),
    ...(Number.isFinite(maxValue) && { max: maxValue as number }),
  };
}

/** The instance's display name: Site admin's setting, else `APP_NAME`, else "GitOrange". */
export const instanceName = (db: DrizzleDB, env: CloudflareBindings) =>
  getSetting(db, env, 'app.name');

// Internal state kept beside the settings (not shown in Site admin as an editable setting).
export const RETENTION_STATUS_KEY = 'actions.retention_status';
