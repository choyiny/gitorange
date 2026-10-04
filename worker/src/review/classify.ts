import type { WorkflowStepConfig } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  prClassifications,
  prReviewFlags,
  pullRequests,
  type ClassifierAnswer,
  type FileSummary,
  type PrClassification,
  type PullRequest,
} from '../db/app.schema';
import { decoder } from '../git/bytes';
import type { FileChange, FileDiff, GitService } from '../git/service';
import { findRepoById, gitFor } from '../lib/repos';
import type { StepRunner } from '../merge/resolution';
import { resolutionConfigured } from '../merge/resolution';
import {
  classifierModel,
  reviewModel,
  summaryModel,
  type ClefQuestion,
  type ReviewModels,
} from './models';
import {
  parsePolicy,
  PolicyError,
  pathFlags,
  questionType,
  readPolicy,
  type PolicyQuestion,
  type ReviewPolicy,
} from './policy';
import { maybeAutoMerge } from './auto-merge';

/** Review runs on the same Workflow binding as AI conflict resolution. */
export const reviewConfigured = resolutionConfigured;

const LOCKFILE =
  /(^|\/)(yarn\.lock|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|uv\.lock|Gemfile\.lock|composer\.lock)$/;
/** Diff text sent to summarize one file; a larger file is flagged instead. */
const MAX_SUMMARY_DIFF = 200 * 1024;
/** Diff text sent to investigate one flag; the rest is listed but left out. */
const MAX_INVESTIGATE_DIFF = 400 * 1024;
/** Files summarized at once. */
const SUMMARY_BATCH = 8;

const MODEL_RETRIES: WorkflowStepConfig = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
};

/** The current classification of a pull request's head commit under a policy version. */
export async function classificationFor(
  db: DrizzleDB,
  pullRequestId: string,
  headSha: string,
  policySha: string
): Promise<PrClassification | undefined> {
  return db
    .select()
    .from(prClassifications)
    .where(
      and(
        eq(prClassifications.pullRequestId, pullRequestId),
        eq(prClassifications.headSha, headSha),
        eq(prClassifications.policySha, policySha)
      )
    )
    .get();
}

/**
 * Starts reviewing a pull request's head commit if the target branch has a review.yml and this
 * commit wasn't reviewed under that policy yet. An invalid review.yml is recorded as a failed
 * review (shown on the pull request) without calling any model.
 */
export async function ensureClassification(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest,
  shas: { base: string; head: string }
): Promise<PrClassification | null> {
  if (!reviewConfigured(env) || pr.state !== 'open') return null;
  const policy = await readPolicy(git, shas.base);
  if (!policy) return null;
  const existing = await classificationFor(db, pr.id, shas.head, policy.sha);
  if (existing) return existing;
  let parsed: ReviewPolicy | null = null;
  let error: string | null = null;
  try {
    parsed = parsePolicy(policy.text);
  } catch (e) {
    if (!(e instanceof PolicyError)) throw e;
    error = e.message;
  }
  const now = new Date();
  const row: PrClassification = {
    id: crypto.randomUUID(),
    pullRequestId: pr.id,
    headSha: shas.head,
    policySha: policy.sha,
    status: error ? 'failed' : 'summarizing',
    summaryModel: summaryModel(env),
    classifierModel: classifierModel(parsed?.model ?? 'clef'),
    files: null,
    answers: null,
    verdict: null,
    errorMessage: error,
    durationMs: null,
    createdAt: now,
    finishedAt: error ? now : null,
  };
  const inserted = await db
    .insert(prClassifications)
    .values(row)
    .onConflictDoNothing()
    .returning({ id: prClassifications.id });
  // Another trigger got here first.
  if (!inserted.length)
    return (await classificationFor(db, pr.id, shas.head, policy.sha)) ?? null;
  if (error) return row;
  try {
    await env.MERGE_RESOLUTION.create({
      id: `review-${row.id}`,
      params: { classificationId: row.id },
    });
  } catch (e) {
    console.error('[review] could not start', row.id, e);
    await failClassification(
      db,
      row.id,
      'The review could not be started. Try again.'
    );
    return { ...row, status: 'failed' };
  }
  return row;
}

/** Forgets a failed review of a pull request's head commit and starts a new one. */
export async function retryClassification(
  env: CloudflareBindings,
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest,
  shas: { base: string; head: string }
) {
  const policy = await readPolicy(git, shas.base);
  if (!policy) return null;
  await db
    .delete(prClassifications)
    .where(
      and(
        eq(prClassifications.pullRequestId, pr.id),
        eq(prClassifications.headSha, shas.head),
        eq(prClassifications.policySha, policy.sha),
        eq(prClassifications.status, 'failed')
      )
    );
  return ensureClassification(env, db, git, pr, shas);
}

async function failClassification(db: DrizzleDB, id: string, message: string) {
  await db
    .update(prClassifications)
    .set({ status: 'failed', errorMessage: message, finishedAt: new Date() })
    .where(eq(prClassifications.id, id));
}

/** A file's diff as unified-diff text. */
export function renderDiff(d: FileDiff): string {
  return d.hunks
    .map(
      (h) =>
        `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`
    )
    .join('\n');
}

type Summarized = FileSummary & { unsummarized?: boolean };

/** One file's one-liner: fixed text where a model can't say more, otherwise the summary model. */
async function summarizeFile(
  git: GitService,
  models: ReviewModels,
  ch: FileChange
): Promise<Summarized> {
  const base = {
    path: ch.path,
    status: ch.status,
    additions: 0,
    deletions: 0,
  };
  if (ch.mode === '160000')
    return { ...base, summary: 'Submodule pointer updated.' };
  const [d] = await git.fileDiffs([ch]);
  const counts = { additions: d.additions, deletions: d.deletions };
  if (LOCKFILE.test(ch.path))
    return { ...base, ...counts, summary: 'Dependency lockfile updated.' };
  if (d.binary) return { ...base, summary: `Binary file ${ch.status}.` };
  const diff = renderDiff(d);
  if (d.tooLarge || diff.length > MAX_SUMMARY_DIFF)
    return {
      ...base,
      ...counts,
      summary: 'Too large to summarize.',
      unsummarized: true,
    };
  const summary = await models.summarize({
    path: ch.path,
    status: ch.status,
    ...counts,
    diff,
  });
  return { ...base, ...counts, summary };
}

/** review.yml questions in Clef's request shape. */
export function clefQuestions(
  policy: ReviewPolicy
): Record<string, ClefQuestion> {
  const out: Record<string, ClefQuestion> = {};
  for (const [id, q] of Object.entries(policy.human_review.questions)) {
    if ('above' in q)
      out[id] = {
        type: 'noul',
        instructions: q.ask,
        ...(q.yes || q.no
          ? {
              criteria: {
                ...(q.yes ? { true: q.yes } : {}),
                ...(q.no ? { false: q.no } : {}),
              },
            }
          : {}),
      };
    else if ('options' in q)
      out[id] = { type: 'choice', instructions: q.ask, criteria: q.options };
    else out[id] = { type: 'score', instructions: q.ask, criteria: q.levels };
  }
  return out;
}

/** Whether an answer crosses its question's threshold. */
export function crosses(q: PolicyQuestion, a: ClassifierAnswer): boolean {
  if ('above' in q) return a.type === 'noul' && a.value > q.above;
  if ('options' in q)
    return (
      a.type === 'choice' &&
      q.flag.includes(a.value) &&
      a.confidence >= q.min_confidence
    );
  return a.type === 'score' && a.value >= q.at_least;
}

export type NewFlag = {
  source: 'question' | 'path' | 'limit';
  key: string;
  value: unknown;
  paths: string[];
  /** Fixed explanation for flags that aren't investigated by a model. */
  detail?: string;
};

/** Everything that needs a person, in the order it is shown. */
export function computeFlags(
  policy: ReviewPolicy,
  files: Summarized[],
  answers: Record<string, ClassifierAnswer>,
  tooMany: number | null
): NewFlag[] {
  const flags: NewFlag[] = [];
  if (tooMany !== null)
    flags.push({
      source: 'limit',
      key: 'max_files',
      value: { files: tooMany, max: policy.limits.max_files },
      paths: [],
      detail: `This pull request changes ${tooMany} files, more than review.yml's \`limits.max_files\` (${policy.limits.max_files}), so it wasn't classified.`,
    });
  const unsummarized = files.filter((f) => f.unsummarized).map((f) => f.path);
  if (unsummarized.length)
    flags.push({
      source: 'limit',
      key: 'unsummarized',
      value: null,
      paths: unsummarized,
      detail:
        'These files are too large, or failed, to summarize, so the classifier never saw what changed in them.',
    });
  for (const f of pathFlags(
    policy,
    files.map((f) => f.path)
  ))
    flags.push({ source: 'path', key: f.pattern, value: null, paths: f.paths });
  for (const [id, q] of Object.entries(policy.human_review.questions)) {
    const a = answers[id];
    if (a && crosses(q, a))
      flags.push({ source: 'question', key: id, value: a, paths: [] });
  }
  return flags;
}

const pct = (n: number) => n.toFixed(2);

/** A flag in words, for the investigating model. */
function describeFlag(policy: ReviewPolicy, f: NewFlag): string {
  if (f.source === 'path')
    return `The review rules require a person for changes to "${f.key}", which matched: ${f.paths.join(', ')}.`;
  const q = policy.human_review.questions[f.key];
  const a = f.value as ClassifierAnswer;
  const kind = questionType(q);
  if (kind === 'noul' && a.type === 'noul' && 'above' in q)
    return `Review question "${f.key}": ${q.ask}\nThe classifier answered yes with probability ${pct(a.value)} (the threshold is ${q.above}).`;
  if (a.type === 'choice')
    return `Review question "${f.key}": ${q.ask}\nThe classifier chose "${a.value}" (confidence ${pct(a.confidence)}), an option that needs a person.`;
  if (a.type === 'score' && 'levels' in q)
    return `Review question "${f.key}": ${q.ask}\nThe classifier scored it ${pct(a.value)} on a scale from 0 (${q.levels[0]}) to ${q.levels.length - 1} (${q.levels[q.levels.length - 1]}); a person is needed from ${q.at_least}.`;
  return `Review question "${f.key}": ${q.ask}`;
}

/** Diffs for the investigating model: the given files first, within the size budget. */
async function diffsFor(
  git: GitService,
  changes: FileChange[],
  first: string[]
): Promise<string> {
  const order = [
    ...changes.filter((c) => first.includes(c.path)),
    ...changes.filter((c) => !first.includes(c.path)),
  ];
  let out = '';
  let left = 0;
  for (const [i, ch] of order.entries()) {
    const [d] = await git.fileDiffs([ch]);
    const body =
      d.binary || d.tooLarge
        ? '(binary or too large to show)'
        : renderDiff(d) || '(no textual change)';
    const block = `--- ${ch.path} (${ch.status})\n${body}\n\n`;
    if (out.length + block.length > MAX_INVESTIGATE_DIFF) {
      left = order.length - i;
      break;
    }
    out += block;
  }
  return left ? `${out}(${left} more changed files not shown)` : out;
}

export interface ReviewDeps {
  env: CloudflareBindings;
  db: DrizzleDB;
  step: StepRunner;
  models: ReviewModels;
}

/** Runs one review to completion. Called from the MERGE_RESOLUTION Workflow. */
export async function executeClassification(deps: ReviewDeps, id: string) {
  const { env, db, step, models } = deps;
  const job = await step.do('load', async () => {
    const row = await db
      .select()
      .from(prClassifications)
      .where(eq(prClassifications.id, id))
      .get();
    if (!row || row.status === 'done' || row.status === 'failed') return null;
    const pr = await db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.id, row.pullRequestId))
      .get();
    const found = pr && (await findRepoById(db, pr.repositoryId));
    if (!pr || !found) return null;
    const git = gitFor(env, found.repo);
    const bytes = await git.blob(row.policySha);
    const baseTip = await git.resolve(pr.baseRef);
    const mergeBase = baseTip && (await git.mergeBase(baseTip, row.headSha));
    const [from, to] = await Promise.all([
      mergeBase ? git.commit(mergeBase) : null,
      git.commit(row.headSha),
    ]);
    if (!bytes || !from || !to)
      return {
        ok: false as const,
        error: 'The commits or review.yml could not be read.',
      };
    let policy: ReviewPolicy;
    try {
      policy = parsePolicy(decoder.decode(bytes));
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    const changes = await git.diffTrees(from.treeHash, to.treeHash);
    return {
      ok: true as const,
      row,
      pr,
      repo: found.repo,
      policy,
      changes,
      startedAt: Date.now(),
    };
  });
  if (!job) return;
  if (!job.ok) {
    await step.do('fail', async () => {
      await failClassification(db, id, job.error);
      return true;
    });
    return;
  }
  const git = gitFor(env, job.repo);
  const { policy, pr, changes } = job;
  const tooMany =
    changes.length > policy.limits.max_files ? changes.length : null;

  // 1. One line per file. A file whose summary still fails after retries is flagged rather
  // than failing the whole review.
  const files: Summarized[] = [];
  if (tooMany === null)
    for (let i = 0; i < changes.length; i += SUMMARY_BATCH)
      files.push(
        ...(await Promise.all(
          changes.slice(i, i + SUMMARY_BATCH).map((ch, j) =>
            step
              .do(`summary:${i + j}`, MODEL_RETRIES, () =>
                summarizeFile(git, models, ch)
              )
              .catch(
                (e): Summarized => (
                  console.error('[review] summary failed', ch.path, e),
                  {
                    path: ch.path,
                    status: ch.status,
                    additions: 0,
                    deletions: 0,
                    summary: 'Could not be summarized.',
                    unsummarized: true,
                  }
                )
              )
          )
        ))
      );
  await step.do('save-files', async () => {
    await db
      .update(prClassifications)
      .set({
        status: 'classifying',
        files: files.map(({ unsummarized: _, ...f }) => f),
      })
      .where(eq(prClassifications.id, id));
    return true;
  });

  // 2. Clef answers the policy's questions over the one-liners, never the raw diff.
  const questions = clefQuestions(policy);
  let answers: Record<string, ClassifierAnswer> = {};
  if (tooMany === null && Object.keys(questions).length)
    try {
      answers = await step.do('classify', MODEL_RETRIES, () =>
        models.classify(
          policy.model,
          {
            pull_request: { title: pr.title, description: pr.body },
            files: files.map(({ unsummarized: _, ...f }) => f),
          },
          questions
        )
      );
    } catch (e) {
      console.error('[review] classify failed', id, e);
      await step.do('fail', async () => {
        await failClassification(
          db,
          id,
          'The classifier could not be reached or failed to answer. Try again.'
        );
        return true;
      });
      return;
    }

  // 3. Record what needs a person.
  const flags = computeFlags(policy, files, answers, tooMany);
  const flagIds = await step.do('flags', async () => {
    const now = new Date();
    const rows = flags.map((f) => ({
      id: crypto.randomUUID(),
      classificationId: id,
      source: f.source,
      key: f.key,
      value: f.value,
      paths: f.paths,
      detail: f.detail ?? null,
      detailModel: null,
      approvedById: null,
      approvedAt: null,
      createdAt: now,
    }));
    if (rows.length)
      await db.insert(prReviewFlags).values(rows).onConflictDoNothing();
    await db
      .update(prClassifications)
      .set({ answers, status: rows.length ? 'investigating' : 'done' })
      .where(eq(prClassifications.id, id));
    // Ids as stored (a replayed step keeps the first insert's rows).
    const stored = await db
      .select({
        id: prReviewFlags.id,
        source: prReviewFlags.source,
        key: prReviewFlags.key,
      })
      .from(prReviewFlags)
      .where(eq(prReviewFlags.classificationId, id))
      .all();
    return flags.map(
      (f) => stored.find((s) => s.source === f.source && s.key === f.key)!.id
    );
  });

  // 4. GLM-5.3 looks into each flag with the full diffs. A failure leaves the flag without
  // detail; it can still be approved.
  const toInvestigate = flags
    .map((f, i) => ({ f, flagId: flagIds[i] }))
    .filter(({ f }) => f.source !== 'limit');
  const summaries = files
    .map((f) => `- ${f.path} (${f.status}): ${f.summary}`)
    .join('\n');
  await Promise.all(
    toInvestigate.map(({ f, flagId }, i) =>
      step
        .do(`investigate:${i}`, MODEL_RETRIES, async () => {
          const out = await models.investigate({
            flag: describeFlag(policy, f),
            title: pr.title,
            description: pr.body,
            summaries,
            diffs: await diffsFor(git, changes, f.paths),
            paths: f.paths,
          });
          const changed = new Set(changes.map((c) => c.path));
          await db
            .update(prReviewFlags)
            .set({
              detail: out.detail,
              detailModel: reviewModel(env),
              paths:
                f.source === 'path'
                  ? f.paths
                  : out.paths.filter((p) => changed.has(p)),
            })
            .where(eq(prReviewFlags.id, flagId));
          return true;
        })
        .catch((e) => {
          console.error('[review] investigation failed', flagId, e);
          return false;
        })
    )
  );

  await step.do('finish', async () => {
    await db
      .update(prClassifications)
      .set({
        status: 'done',
        verdict: flags.length ? 'human' : 'auto',
        durationMs: Date.now() - job.startedAt,
        finishedAt: new Date(),
      })
      .where(eq(prClassifications.id, id));
    return true;
  });
  await step.do('auto-merge', async () => {
    await maybeAutoMerge(env, db, pr.id);
    return true;
  });
}
