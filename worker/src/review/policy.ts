import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { GitService } from '../git/service';
import { decoder } from '../git/bytes';
import { matchesPatterns } from '../actions/plan';

/**
 * `.gitorange/review.yml`: which pull requests merge on their own. It is read from the target
 * branch, never from the pull request, so a PR can't loosen its own rules; a repository without
 * the file never auto-merges.
 */
export const POLICY_PATH = '.gitorange/review.yml';

export const DEFAULT_CLASSIFIER = 'clef';

const id = z
  .string()
  .regex(
    /^[A-Za-z0-9_.-]{1,100}$/,
    'Question ids may use letters, digits, _, . and -'
  );
const text = z.string().trim().min(1);

const noul = z
  .object({
    ask: text,
    yes: text.optional(),
    no: text.optional(),
    above: z.number().min(0).max(1),
  })
  .strict();
const choice = z
  .object({
    ask: text,
    options: z
      .record(id, z.string().nullable())
      .refine((o) => Object.keys(o).length >= 2, 'Give at least 2 options'),
    flag: z.array(id).min(1),
    min_confidence: z.number().min(0).max(1).default(0),
  })
  .strict()
  .refine((q) => q.flag.every((f) => f in q.options), {
    message: '`flag` must list option ids from `options`',
  });
const score = z
  .object({
    ask: text,
    levels: z.array(text).min(2).max(10),
    at_least: z.number().min(0),
  })
  .strict()
  .refine((q) => q.at_least <= q.levels.length - 1, {
    message: '`at_least` must be a level index',
  });

const schema = z
  .object({
    model: z.enum(['clef', 'clef-flash']).default(DEFAULT_CLASSIFIER),
    checks: z
      .object({
        require: z
          .union([z.enum(['all', 'none']), z.array(text).min(1)])
          .default('all'),
      })
      .strict()
      .default({ require: 'all' }),
    limits: z
      .object({
        max_files: z.number().int().min(1).max(300).default(100),
      })
      .strict()
      .default({ max_files: 100 }),
    human_review: z
      .object({
        paths: z.array(text).default([]),
        questions: z
          .record(id, z.union([noul, choice, score]))
          .refine((q) => Object.keys(q).length <= 64, 'At most 64 questions')
          .default({}),
      })
      .strict()
      .default({ paths: [], questions: {} }),
  })
  .strict();

export type ReviewPolicy = z.infer<typeof schema>;
export type PolicyQuestion = ReviewPolicy['human_review']['questions'][string];

/** The question's kind, from the fields it has. */
export function questionType(q: PolicyQuestion): 'noul' | 'choice' | 'score' {
  return 'above' in q ? 'noul' : 'options' in q ? 'choice' : 'score';
}

export class PolicyError extends Error {}

/** Parses review.yml, throwing PolicyError with a message fit to show on a pull request. */
export function parsePolicy(source: string): ReviewPolicy {
  let raw: unknown;
  try {
    raw = parseYaml(source) ?? {};
  } catch (e) {
    throw new PolicyError(
      `${POLICY_PATH} is not valid YAML: ${e instanceof Error ? e.message : e}`
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.join('.');
    throw new PolicyError(
      `${POLICY_PATH}: ${where ? `${where}: ` : ''}${issue.message}`
    );
  }
  return parsed.data;
}

/** The target branch's policy file, or null when it has none (auto-merge is off). */
export async function readPolicy(
  git: GitService,
  baseSha: string
): Promise<{ sha: string; text: string } | null> {
  const entry = await git.entryAt(baseSha, POLICY_PATH);
  if (entry?.type !== 'blob') return null;
  const bytes = await git.blob(entry.entry.hash);
  return bytes ? { sha: entry.entry.hash, text: decoder.decode(bytes) } : null;
}

/** Changed paths each path rule matches; rules that match nothing are left out. */
export function pathFlags(
  policy: ReviewPolicy,
  paths: string[]
): { pattern: string; paths: string[] }[] {
  return policy.human_review.paths
    .map((pattern) => ({
      pattern,
      paths: paths.filter((p) => matchesPatterns(p, [pattern])),
    }))
    .filter((f) => f.paths.length > 0);
}
