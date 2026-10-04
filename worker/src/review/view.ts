import { asc, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/middleware';
import {
  prReviewFlags,
  type ClassifierAnswer,
  type PrReviewFlag,
  type PullRequest,
} from '../db/app.schema';
import type { GitService } from '../git/service';
import { usersById, type PublicUser } from '../lib/users';
import { autoMergeStatus } from './auto-merge';
import { classificationFor, crosses } from './classify';
import {
  parsePolicy,
  questionType,
  readPolicy,
  type ReviewPolicy,
} from './policy';

/** A flag's heading on the pull request. */
function flagTitle(policy: ReviewPolicy | null, f: PrReviewFlag): string {
  if (f.source === 'path') return `Changes files matching ${f.key}`;
  if (f.source === 'limit')
    return f.key === 'max_files'
      ? 'Too many files to review automatically'
      : 'Files that could not be summarized';
  return policy?.human_review.questions[f.key]?.ask ?? f.key;
}

/** The threshold of a question, in words. */
function threshold(q: ReviewPolicy['human_review']['questions'][string]) {
  if ('above' in q) return `flags above ${q.above}`;
  if ('options' in q) return `flags ${q.flag.join(', ')}`;
  return `flags from ${q.at_least} (${q.levels[Math.ceil(q.at_least)] ?? ''})`;
}

/**
 * Everything the pull request page shows about auto-merge: the review of the current head
 * commit (one-liners, each question's answer, flags with their investigation and approval) and
 * whether it will merge on its own.
 */
export async function reviewView(
  db: DrizzleDB,
  git: GitService,
  pr: PullRequest,
  shas: { base: string; head: string } | null
) {
  const policyFile =
    shas && pr.state === 'open' ? await readPolicy(git, shas.base) : null;
  if (!shas || !policyFile) return null;
  let policy: ReviewPolicy | null = null;
  try {
    policy = parsePolicy(policyFile.text);
  } catch {
    // Shown through the failed review's message.
  }
  const review = await classificationFor(db, pr.id, shas.head, policyFile.sha);
  const flags = review
    ? await db
        .select()
        .from(prReviewFlags)
        .where(eq(prReviewFlags.classificationId, review.id))
        .orderBy(asc(prReviewFlags.createdAt))
        .all()
    : [];
  const people = await usersById(
    db,
    flags.map((f) => f.approvedById ?? '').filter(Boolean)
  );
  const status = await autoMergeStatus(db, git, pr);
  const answers = review?.answers ?? {};
  return {
    classification: review
      ? {
          id: review.id,
          status: review.status,
          verdict: review.verdict,
          headSha: review.headSha,
          summaryModel: review.summaryModel,
          classifierModel: review.classifierModel,
          files: review.files ?? [],
          errorMessage: review.errorMessage,
          durationMs: review.durationMs,
          createdAt: review.createdAt.toISOString(),
        }
      : null,
    questions: policy
      ? Object.entries(policy.human_review.questions).map(([id, q]) => {
          const answer: ClassifierAnswer | null = answers[id] ?? null;
          return {
            id,
            ask: q.ask,
            type: questionType(q),
            threshold: threshold(q),
            answer,
            flagged: answer ? crosses(q, answer) : false,
          };
        })
      : [],
    flags: flags.map((f) => ({
      id: f.id,
      source: f.source,
      key: f.key,
      title: flagTitle(policy, f),
      value: f.value ?? null,
      paths: f.paths,
      detail: f.detail,
      detailModel: f.detailModel,
      approvedBy: f.approvedById
        ? (people.get(f.approvedById) ?? null)
        : (null as PublicUser | null),
      approvedAt: f.approvedAt?.toISOString() ?? null,
    })),
    autoMerge: {
      state: status.state,
      reasons: 'reasons' in status ? status.reasons : [],
      disabledAt: status.state === 'disabled' ? status.at.toISOString() : null,
    },
  };
}
