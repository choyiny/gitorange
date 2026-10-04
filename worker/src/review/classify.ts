import type { WorkflowStepConfig } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { pingingSteps } from '../live/publish';
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
  mermaidSource,
  reviewModel,
  summaryModel,
  type ClefQuestion,
  type Investigation,
  type ReviewModels,
} from './models';
import {
  parsePolicy,
  PolicyError,
  questionType,
  readPolicy,
  type PolicyQuestion,
  type ReviewPolicy,
} from './policy';
import { maybeAutoMerge } from './auto-merge';
import { IGNORE_PATH, ignoreMatcher, isLockfile, readIgnore } from './ignore';

/** Review runs on the same Workflow binding as AI conflict resolution. */
export const reviewConfigured = resolutionConfigured;

/** Diff text sent to summarize one file; a larger file is flagged instead. */
const MAX_SUMMARY_DIFF = 200 * 1024;
/** Diff text sent to investigate one flag; the rest is listed but left out. */
const MAX_INVESTIGATE_DIFF = 120 * 1024;
/** One file's share of that: a huge file shows its start and is listed as cut. */
const MAX_INVESTIGATE_FILE = 24 * 1024;
/** Files summarized at once. */
const SUMMARY_BATCH = 8;

const MODEL_RETRIES: WorkflowStepConfig = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
};
/** One investigation: a bigger prompt than a summary, so more time, and fewer retries. */
const INVESTIGATE_RETRIES: WorkflowStepConfig = {
  retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
  timeout: '8 minutes',
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

/** One diff line with the line number it has in the file (new side; old side for removals). */
type NumberedLine = { kind: ' ' | '+' | '-'; n: number; text: string };

function numberedLines(d: FileDiff): NumberedLine[][] {
  return d.hunks.map((h) => {
    let oldN = h.oldStart;
    let newN = h.newStart;
    const out: NumberedLine[] = [];
    for (const l of h.lines) {
      const kind = l[0] as NumberedLine['kind'];
      if (kind === '-') out.push({ kind, n: oldN++, text: l.slice(1) });
      else if (kind === '+') out.push({ kind, n: newN++, text: l.slice(1) });
      else if (kind === ' ') {
        // Context lines exist on both sides.
        oldN++;
        out.push({ kind, n: newN++, text: l.slice(1) });
      }
    }
    return out;
  });
}

/**
 * A diff for the investigating model, each line numbered: added and context lines with their
 * line in the new file, removed lines with their line in the old file (marked "old").
 */
export function renderNumberedDiff(d: FileDiff): string {
  return numberedLines(d)
    .map((hunk) =>
      hunk
        .map((l) =>
          l.kind === '-'
            ? `-${String(l.n).padStart(5)} old | ${l.text}`
            : `${l.kind}${String(l.n).padStart(5)}     | ${l.text}`
        )
        .join('\n')
    )
    .join('\n...\n');
}

const MAX_SNIPPET_LINES = 30;

/** The diff lines a snippet points at: new-side lines in range, and removals between them. */
export function snippetLines(
  d: FileDiff,
  start: number,
  end: number
): string | null {
  if (end < start) [start, end] = [end, start];
  end = Math.min(end, start + MAX_SNIPPET_LINES - 1);
  const removedFile = d.status === 'removed';
  const picked: string[] = [];
  for (const hunk of numberedLines(d)) {
    // Removals have no new-side number: keep them when they border the range, so an excerpt
    // shows what a change replaced.
    let prevIn = false;
    let held: string[] = [];
    for (const l of hunk) {
      const numbered = removedFile ? l.kind === '-' : l.kind !== '-';
      if (!numbered) {
        held.push(`${l.kind}${l.text}`);
        continue;
      }
      const inRange = l.n >= start && l.n <= end;
      if (inRange || prevIn) picked.push(...held);
      held = [];
      if (inRange) picked.push(`${l.kind}${l.text}`);
      prevIn = inRange;
    }
    if (prevIn) picked.push(...held);
  }
  return picked.length ? picked.join('\n') : null;
}

const escapeHtml = (t: string) =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The flag's comment body: the explanation, its diagram as a Mermaid block, and each code
 * excerpt as an expandable block taken from the real diff (never from model output).
 */
/** Text for one Markdown table cell. */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

async function composeDetail(
  git: GitService,
  changes: FileChange[],
  out: Investigation,
  ignored: (path: string) => boolean
): Promise<string> {
  const parts = [out.detail];
  if (out.changes?.length)
    parts.push(
      [
        '| | Before | After |',
        '|---|---|---|',
        ...out.changes.map(
          (c) =>
            `| **${cell(c.what)}** | ${cell(c.before) || '—'} | ${cell(c.after) || '—'} |`
        ),
      ].join('\n')
    );
  const diagram = out.diagram && mermaidSource(out.diagram);
  if (diagram) parts.push('```mermaid\n' + diagram + '\n```');
  for (const s of out.snippets) {
    const ch = changes.find((c) => c.path === s.path);
    if (!ch || ignored(ch.path)) continue;
    const [d] = await git.fileDiffs([ch]);
    if (d.binary || d.tooLarge) continue;
    const lines = snippetLines(d, s.start, s.end);
    if (!lines) continue;
    const fence = lines.includes('```') ? '~~~~' : '```';
    parts.push(
      `<details><summary><code>${escapeHtml(s.path)}</code> lines ${s.start}–${s.end}${
        s.why ? `: ${escapeHtml(s.why)}` : ''
      }</summary>\n\n${fence}diff\n${lines}\n${fence}\n\n</details>`
    );
  }
  return parts.join('\n\n');
}

type Summarized = FileSummary & { unsummarized?: boolean };

/** One file's one-liner: fixed text where a model can't say more, otherwise the summary model. */
async function summarizeFile(
  git: GitService,
  models: ReviewModels,
  ch: FileChange,
  ignored: (path: string) => boolean
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
  if (isLockfile(ch.path))
    return { ...base, ...counts, summary: 'Dependency lockfile updated.' };
  if (ignored(ch.path))
    return {
      ...base,
      ...counts,
      summary: `Changed; ignored by ${IGNORE_PATH}.`,
    };
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
  source: 'question' | 'limit';
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

/** Source before tests, docs, and config: what a reviewer would read first. */
function readingOrder(path: string): number {
  if (/(^|\/)(__tests__|test|tests)\/|\.test\.[jt]sx?$/.test(path)) return 2;
  if (/\.(md|mdx|txt)$/i.test(path) || path.startsWith('docs/')) return 3;
  return 1;
}

/**
 * Diffs for the investigating model, within a budget it can read quickly: the flag's own files
 * first, then source, tests, and docs. Ignored files (lockfiles, .orangeignore) are left out, and each file
 * is capped; whatever doesn't fit is named so the model knows it exists (its one-line summary is
 * in the prompt too).
 */
export async function diffsFor(
  git: GitService,
  changes: FileChange[],
  first: string[],
  /** Lockfiles and files matched by `.orangeignore`: named, never shown. */
  ignored: (path: string) => boolean,
  /** Read only `first` (the files picked as relevant); list the rest by name. */
  only = false
): Promise<string> {
  const skipped: string[] = [];
  const unpicked: string[] = [];
  const order = changes
    .filter((c) => {
      const noise = ignored(c.path);
      if (noise) skipped.push(c.path);
      else if (only && !first.includes(c.path)) unpicked.push(c.path);
      return !noise && !(only && !first.includes(c.path));
    })
    .sort(
      (a, b) =>
        Number(!first.includes(a.path)) - Number(!first.includes(b.path)) ||
        readingOrder(a.path) - readingOrder(b.path)
    );
  let out = '';
  const left: string[] = [];
  for (const ch of order) {
    if (out.length >= MAX_INVESTIGATE_DIFF) {
      left.push(ch.path);
      continue;
    }
    const [d] = await git.fileDiffs([ch]);
    let body =
      d.binary || d.tooLarge
        ? '(binary or too large to show)'
        : renderNumberedDiff(d) || '(no textual change)';
    if (body.length > MAX_INVESTIGATE_FILE)
      body = `${body.slice(0, MAX_INVESTIGATE_FILE)}\n… (the rest of this file's diff is not shown)`;
    const block = `--- ${ch.path} (${ch.status})\n${body}\n\n`;
    if (out.length + block.length > MAX_INVESTIGATE_DIFF) left.push(ch.path);
    else out += block;
  }
  const notes = [
    unpicked.length &&
      `Not shown (judged unrelated to this flag from their summaries): ${unpicked.join(', ')}`,
    skipped.length &&
      `Ignored (lockfiles and ${IGNORE_PATH}), not shown: ${skipped.join(', ')}`,
    left.length && `Not shown (over the size budget): ${left.join(', ')}`,
  ].filter(Boolean);
  return notes.length ? `${out}${notes.join('\n')}` : out;
}

export interface ReviewDeps {
  env: CloudflareBindings;
  db: DrizzleDB;
  step: StepRunner;
  models: ReviewModels;
}

/** Runs one review to completion. Called from the MERGE_RESOLUTION Workflow. */
export async function executeClassification(deps: ReviewDeps, id: string) {
  const { env, db, models } = deps;
  let step = deps.step;
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
    // From the target branch, like review.yml: a pull request can't hide its own files.
    const ignoreText = baseTip ? await readIgnore(git, baseTip) : null;
    return {
      ok: true as const,
      ignoreText,
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
  // From here on, each step shows on the pull request (and in approval inboxes) as it finishes.
  step = pingingSteps(env, step, job.pr.repositoryId, { approvals: true });
  const git = gitFor(env, job.repo);
  const { policy, pr, changes } = job;
  const ignored = ignoreMatcher(job.ignoreText);
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
                summarizeFile(git, models, ch, ignored)
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
        .do(`investigate:${i}`, INVESTIGATE_RETRIES, async () => {
          const flag = describeFlag(policy, f);
          // Read only the files that matter for this flag, picked from the one-liners by the
          // fast model; on any failure, read them all (within the budget).
          const picked = models.selectFiles
            ? await models
                .selectFiles({
                  flag,
                  summaries,
                  paths: changes.map((c) => c.path).filter((p) => !ignored(p)),
                })
                .catch(() => [] as string[])
            : [];
          const focus = picked.length ? picked : f.paths;
          const out = await models.investigate({
            flag,
            title: pr.title,
            description: pr.body,
            summaries,
            diffs: await diffsFor(
              git,
              changes,
              focus,
              ignored,
              picked.length > 0
            ),
            paths: focus,
          });
          const changed = new Set(changes.map((c) => c.path));
          await db
            .update(prReviewFlags)
            .set({
              detail: await composeDetail(git, changes, out, ignored),
              detailModel: reviewModel(env),
              paths: out.paths.filter((p) => changed.has(p)),
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
