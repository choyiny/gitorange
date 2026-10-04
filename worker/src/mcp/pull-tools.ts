import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  pullRequestComments,
  pullRequests,
  workflowJobs,
  workflowRuns,
  workflowSteps,
  type PullRequest,
} from '../db/app.schema';
import { findRepo, gitFor, permissionsFor } from '../lib/repos';
import { usersById } from '../lib/users';
import { addComment, openPull, pullShas } from '../lib/pulls';
import { landPull } from '../merge/land';
import { latestResolution } from '../merge/resolution';
import { reviewView } from '../review/view';
import { McpToolError } from './errors';
import type { ToolContext, ToolModule } from './tools';

const text = (t: string) => ({ type: 'text' as const, text: t });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

function str(
  args: Record<string, unknown>,
  key: string,
  required: true
): string;
function str(
  args: Record<string, unknown>,
  key: string,
  required?: false
): string | undefined;
function str(args: Record<string, unknown>, key: string, required = false) {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new McpToolError(`${key} is required.`);
    return undefined;
  }
  if (typeof v !== 'string') throw new McpToolError(`${key} must be a string.`);
  if (required && !v.trim())
    throw new McpToolError(`${key} must not be empty.`);
  return v;
}

function prNumber(args: Record<string, unknown>) {
  const n = args.number;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1)
    throw new McpToolError('number must be a positive integer.');
  return n;
}

const repositoryProp = {
  type: 'string',
  description: 'Full name, e.g. "ada/analytical-engine".',
};
const numberProp = {
  type: 'integer',
  minimum: 1,
  description: 'The pull request number, e.g. 12.',
};

/** The repository the user names, if they can read it; one answer for missing and hidden. */
async function repoFor(ctx: ToolContext, args: Record<string, unknown>) {
  const fullName = str(args, 'repository', true)
    .trim()
    .replace(/\.git$/, '');
  const [owner, name, ...rest] = fullName.split('/');
  const notFound = new McpToolError(
    `No repository named ${fullName}. Call gitorange_list_repositories to see the ones you can access.`
  );
  if (!owner || !name || rest.length) throw notFound;
  const found = await findRepo(ctx.db, owner, name);
  if (!found) throw notFound;
  const perms = await permissionsFor(ctx.db, found.repo, ctx.user);
  if (!perms.read) throw notFound;
  const fullNameCanonical = `${found.namespace.username}/${found.repo.name}`;
  return {
    repo: found.repo,
    perms,
    fullName: fullNameCanonical,
    git: gitFor(ctx.env, found.repo),
  };
}

async function pullFor(
  ctx: ToolContext,
  repositoryId: string,
  fullName: string,
  number: number
): Promise<PullRequest> {
  const pr = await ctx.db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repositoryId),
        eq(pullRequests.number, number)
      )
    )
    .get();
  if (!pr)
    throw new McpToolError(
      `${fullName} has no pull request #${number}. Call gitorange_list_pull_requests to see them.`
    );
  return pr;
}

const pullUrl = (ctx: ToolContext, fullName: string, n: number) =>
  `${ctx.baseURL}/${fullName}/pull/${n}`;

const listPullRequests: ToolModule = {
  definition: {
    name: 'gitorange_list_pull_requests',
    title: 'List pull requests',
    description:
      "List a repository's pull requests, most recently updated first: number, title, author, branches, " +
      'state, and web URL. Use gitorange_get_pull_request for checks, review flags, and whether it can merge.',
    annotations: { readOnlyHint: true, title: 'List pull requests' },
    inputSchema: {
      type: 'object',
      properties: {
        repository: repositoryProp,
        state: {
          type: 'string',
          enum: ['open', 'closed', 'merged', 'all'],
          description: 'Which pull requests to list. Defaults to "open".',
        },
      },
      required: ['repository'],
    },
  },
  handler: async (args, ctx) => {
    const { repo, fullName } = await repoFor(ctx, args);
    const state = str(args, 'state') ?? 'open';
    if (!['open', 'closed', 'merged', 'all'].includes(state))
      throw new McpToolError('state must be open, closed, merged, or all.');
    const rows = await ctx.db
      .select()
      .from(pullRequests)
      .where(
        state === 'all'
          ? eq(pullRequests.repositoryId, repo.id)
          : and(
              eq(pullRequests.repositoryId, repo.id),
              eq(pullRequests.state, state as PullRequest['state'])
            )
      )
      .orderBy(desc(pullRequests.updatedAt))
      .limit(50)
      .all();
    const people = await usersById(
      ctx.db,
      rows.map((r) => r.authorId)
    );
    return {
      content: [
        json(
          rows.map((r) => ({
            number: r.number,
            title: r.title,
            author: people.get(r.authorId)?.username ?? null,
            base: r.baseRef,
            head: r.headRef,
            state: r.state,
            merged_automatically: r.mergedAutomatically,
            updated_at: r.updatedAt.toISOString(),
            url: pullUrl(ctx, fullName, r.number),
          }))
        ),
      ],
    };
  },
};

const getPullRequest: ToolModule = {
  definition: {
    name: 'gitorange_get_pull_request',
    title: 'Get pull request',
    description:
      'Get one pull request: its description, branches and commits, whether it merges cleanly (or has ' +
      'conflicts, and what AI conflict resolution is doing about them), the Actions checks on its latest ' +
      'commit, the auto-merge review (each flag, what the review model found, and whether a person approved ' +
      'it), whether it will merge on its own and what it waits on, and recent comments. Call it again to ' +
      'follow progress after pushing. For why a check failed, pass its run_number to gitorange_get_run_logs.',
    annotations: { readOnlyHint: true, title: 'Get pull request' },
    inputSchema: {
      type: 'object',
      properties: { repository: repositoryProp, number: numberProp },
      required: ['repository', 'number'],
    },
  },
  handler: async (args, ctx) => {
    const { repo, git, fullName, perms } = await repoFor(ctx, args);
    const pr = await pullFor(ctx, repo.id, fullName, prNumber(args));
    const shas = await pullShas(git, pr);

    let merge: Record<string, unknown> | null = null;
    if (pr.state === 'open' && shas) {
      const plan = await git.planMerge(shas.base, shas.head);
      const resolution = await latestResolution(ctx.db, pr.id);
      const current =
        resolution &&
        resolution.baseSha === shas.base &&
        resolution.headSha === shas.head
          ? resolution
          : null;
      merge = {
        nothing_to_merge: plan.upToDate,
        conflicts: plan.upToDate ? [] : plan.conflicts,
        ai_conflict_resolution: current
          ? {
              status: current.status,
              explanation: current.explanation,
              error: current.errorMessage,
            }
          : null,
      };
    }

    const runs = shas
      ? await ctx.db
          .select()
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.repositoryId, repo.id),
              eq(workflowRuns.headSha, shas.head)
            )
          )
          .orderBy(asc(workflowRuns.runNumber))
          .all()
      : [];

    const review = await reviewView(ctx.db, git, pr, shas);
    const comments = await ctx.db
      .select()
      .from(pullRequestComments)
      .where(eq(pullRequestComments.pullRequestId, pr.id))
      .orderBy(desc(pullRequestComments.createdAt))
      .limit(10)
      .all();
    const people = await usersById(ctx.db, [
      pr.authorId,
      pr.mergedById ?? '',
      ...comments.map((x) => x.authorId),
    ]);
    const commits = shas ? await git.commitsBetween(shas.base, shas.head) : [];

    return {
      content: [
        json({
          number: pr.number,
          title: pr.title,
          description: pr.body,
          author: people.get(pr.authorId)?.username ?? null,
          state: pr.state,
          base: pr.baseRef,
          head: pr.headRef,
          head_sha: shas?.head ?? null,
          commits: commits.map((c) => ({
            sha: c.hash.slice(0, 7),
            message: c.message.split('\n')[0],
          })),
          merge,
          checks: runs.map((r) => ({
            workflow: r.name,
            run_number: r.runNumber,
            status: r.status,
            conclusion: r.conclusion,
            error: r.errorMessage,
            url: `${ctx.baseURL}/${fullName}/actions/runs/${r.runNumber}`,
          })),
          auto_merge: review
            ? {
                state: review.autoMerge.state,
                waiting_on: review.autoMerge.reasons,
                review: review.classification
                  ? {
                      status: review.classification.status,
                      verdict: review.classification.verdict,
                      error: review.classification.errorMessage,
                    }
                  : null,
                flags: review.flags.map((f) => ({
                  title: f.title,
                  files: f.paths,
                  finding: f.detail,
                  approved_by: f.approvedBy?.username ?? null,
                })),
              }
            : null,
          merged:
            pr.state === 'merged'
              ? {
                  by: pr.mergedById
                    ? (people.get(pr.mergedById)?.username ?? null)
                    : null,
                  automatically: pr.mergedAutomatically,
                  commit: pr.mergeCommitSha,
                }
              : null,
          recent_comments: comments.reverse().map((x) => ({
            author: people.get(x.authorId)?.username ?? null,
            body: x.body,
            created_at: x.createdAt.toISOString(),
          })),
          can_merge: perms.write,
          url: pullUrl(ctx, fullName, pr.number),
        }),
      ],
    };
  },
};

const createPullRequest: ToolModule = {
  definition: {
    name: 'gitorange_create_pull_request',
    title: 'Create pull request',
    description:
      'Open a pull request from a branch you already pushed (head) into another branch (base, the default ' +
      'branch if omitted). Opening it starts its checks and, if the repository has a .gitorange/review.yml, ' +
      'an auto-merge review; follow both with gitorange_get_pull_request. Needs push access.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      title: 'Create pull request',
    },
    inputSchema: {
      type: 'object',
      properties: {
        repository: repositoryProp,
        head: {
          type: 'string',
          description: 'The branch with the changes, already pushed.',
        },
        base: {
          type: 'string',
          description:
            'The branch to merge into. Defaults to the default branch.',
        },
        title: { type: 'string', description: 'A short title.' },
        body: {
          type: 'string',
          description: 'Markdown description: what changed and why.',
        },
      },
      required: ['repository', 'head', 'title'],
    },
  },
  handler: async (args, ctx) => {
    const { repo, git, fullName, perms } = await repoFor(ctx, args);
    if (!perms.write)
      throw new McpToolError(`You don't have push access to ${fullName}.`);
    const result = await openPull({
      env: ctx.env,
      db: ctx.db,
      git,
      repo,
      repoFullName: fullName,
      author: ctx.user,
      title: str(args, 'title', true),
      body: str(args, 'body') ?? '',
      base: str(args, 'base')?.trim() || repo.defaultBranch,
      head: str(args, 'head', true).trim(),
      after: ctx.after,
    });
    if (!result.ok) throw new McpToolError(result.error);
    return {
      content: [
        json({
          number: result.pr.number,
          title: result.pr.title,
          base: result.pr.baseRef,
          head: result.pr.headRef,
          url: pullUrl(ctx, fullName, result.pr.number),
        }),
      ],
    };
  },
};

const commentPullRequest: ToolModule = {
  definition: {
    name: 'gitorange_comment_pull_request',
    title: 'Comment on pull request',
    description:
      'Add a Markdown comment to a pull request, as the signed-in user.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      title: 'Comment on pull request',
    },
    inputSchema: {
      type: 'object',
      properties: {
        repository: repositoryProp,
        number: numberProp,
        body: { type: 'string', description: 'The comment, in Markdown.' },
      },
      required: ['repository', 'number', 'body'],
    },
  },
  handler: async (args, ctx) => {
    const { repo, fullName } = await repoFor(ctx, args);
    const pr = await pullFor(ctx, repo.id, fullName, prNumber(args));
    await addComment(ctx.env, ctx.db, pr, ctx.user.id, str(args, 'body', true));
    return {
      content: [text(`Commented on ${pullUrl(ctx, fullName, pr.number)}`)],
    };
  },
};

const mergePullRequest: ToolModule = {
  definition: {
    name: 'gitorange_merge_pull_request',
    title: 'Merge pull request',
    description:
      'Rebase and merge a pull request: its changes become one commit on top of the target branch, keeping ' +
      'history linear (AI-resolved conflicts are included). Refused while any auto-merge review flag is ' +
      'unapproved: those need a person to approve them in the web UI first. Needs push access.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      title: 'Merge pull request',
    },
    inputSchema: {
      type: 'object',
      properties: {
        repository: repositoryProp,
        number: numberProp,
        title: {
          type: 'string',
          description:
            'Commit title. Defaults to "<pull request title> (#<number>)".',
        },
        message: {
          type: 'string',
          description: 'Optional commit message body.',
        },
      },
      required: ['repository', 'number'],
    },
  },
  handler: async (args, ctx) => {
    const { repo, git, fullName, perms } = await repoFor(ctx, args);
    if (!perms.write)
      throw new McpToolError(
        `You don't have permission to merge in ${fullName}.`
      );
    const pr = await pullFor(ctx, repo.id, fullName, prNumber(args));
    if (pr.state !== 'open')
      throw new McpToolError(`#${pr.number} is already ${pr.state}.`);
    // The human gate holds for agents too: unapproved flags block merging here.
    const review = await reviewView(ctx.db, git, pr, await pullShas(git, pr));
    const pending = review?.flags.filter((f) => !f.approvedAt) ?? [];
    if (pending.length)
      throw new McpToolError(
        `#${pr.number} has ${pending.length} review flag${pending.length === 1 ? '' : 's'} waiting for a person's approval ` +
          `(${pending.map((f) => f.title).join('; ')}). Ask the user to review and approve ${pullUrl(ctx, fullName, pr.number)}, ` +
          'or their Approvals page; it then merges on its own.'
      );
    const result = await landPull({
      env: ctx.env,
      db: ctx.db,
      repo,
      repoFullName: fullName,
      git,
      pr,
      by: ctx.user,
      author: ctx.user,
      title: str(args, 'title'),
      message: str(args, 'message'),
      after: ctx.after,
    });
    if (!result.ok) throw new McpToolError(result.error);
    return {
      content: [
        text(
          `Merged #${pr.number} into ${pr.baseRef} as ${result.sha.slice(0, 7)}: ${pullUrl(ctx, fullName, pr.number)}`
        ),
      ],
    };
  },
};

/** Tail of a log, so one failing step doesn't flood the conversation. */
const MAX_LOG_LINES = 300;
const MAX_LOG_CHARS = 40_000;
function tail(log: string, lines = MAX_LOG_LINES) {
  const all = log.replace(/\n$/, '').split('\n');
  let out = all.slice(-lines).join('\n');
  if (out.length > MAX_LOG_CHARS) out = out.slice(-MAX_LOG_CHARS);
  const shown = out.split('\n').length;
  return shown < all.length
    ? `… (showing the last ${shown} of ${all.length} lines)\n${out}`
    : out;
}

const getRunLogs: ToolModule = {
  definition: {
    name: 'gitorange_get_run_logs',
    title: 'Get Actions run logs',
    description:
      "Read an Actions run's jobs, steps, and step logs (run_number comes from gitorange_get_pull_request's " +
      'checks, or the Actions tab). By default it returns the logs of the steps that failed; pass job and step ' +
      'for one particular step. Logs show their last lines; secrets are already masked.',
    annotations: { readOnlyHint: true, title: 'Get Actions run logs' },
    inputSchema: {
      type: 'object',
      properties: {
        repository: repositoryProp,
        run_number: {
          type: 'integer',
          minimum: 1,
          description: 'The run number, e.g. 13.',
        },
        job: {
          type: 'string',
          description:
            'Optional job name (as listed, e.g. "test" or "build (22)") to narrow to one job.',
        },
        step: {
          type: 'integer',
          minimum: 1,
          description:
            "Optional step number within the job, to read that step's log even if it passed.",
        },
        lines: {
          type: 'integer',
          minimum: 10,
          maximum: 2000,
          description: `How many lines to show from the end of each log (default ${MAX_LOG_LINES}).`,
        },
      },
      required: ['repository', 'run_number'],
    },
  },
  handler: async (args, ctx) => {
    const { repo, fullName } = await repoFor(ctx, args);
    const runNumber = args.run_number;
    if (typeof runNumber !== 'number' || !Number.isInteger(runNumber))
      throw new McpToolError('run_number must be an integer.');
    const jobName = str(args, 'job')?.trim();
    const stepNumber =
      typeof args.step === 'number' && Number.isInteger(args.step)
        ? args.step
        : undefined;
    const lines =
      typeof args.lines === 'number' && Number.isInteger(args.lines)
        ? Math.min(2000, Math.max(10, args.lines))
        : MAX_LOG_LINES;
    const run = await ctx.db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.repositoryId, repo.id),
          eq(workflowRuns.runNumber, runNumber)
        )
      )
      .get();
    if (!run)
      throw new McpToolError(`${fullName} has no Actions run #${runNumber}.`);
    let jobs = await ctx.db
      .select()
      .from(workflowJobs)
      .where(eq(workflowJobs.runId, run.id))
      .orderBy(asc(workflowJobs.name))
      .all();
    if (jobName) {
      jobs = jobs.filter((j) => j.name === jobName || j.jobKey === jobName);
      if (!jobs.length)
        throw new McpToolError(
          `Run #${runNumber} has no job named "${jobName}".`
        );
    }
    const steps = jobs.length
      ? await ctx.db
          .select()
          .from(workflowSteps)
          .where(
            inArray(
              workflowSteps.jobId,
              jobs.map((j) => j.id)
            )
          )
          .orderBy(asc(workflowSteps.number))
          .all()
      : [];
    const readLog = async (key: string | null) => {
      if (!key) return null;
      const obj = await ctx.env.ACTIONS_LOGS.get(key);
      return obj ? tail(await obj.text(), lines) : null;
    };
    const out = [];
    for (const j of jobs) {
      const own = steps.filter((st) => st.jobId === j.id);
      const wanted = own.filter((st) =>
        stepNumber !== undefined
          ? st.number === stepNumber
          : st.conclusion === 'failure'
      );
      out.push({
        job: j.name,
        status: j.status,
        conclusion: j.conclusion,
        steps: own.map((st) => ({
          number: st.number,
          name: st.name,
          status: st.status,
          conclusion: st.conclusion,
        })),
        logs: await Promise.all(
          wanted.map(async (st) => ({
            step: st.number,
            name: st.name,
            log:
              (await readLog(st.logR2Key)) ??
              (st.status === 'completed'
                ? '(no log was recorded)'
                : '(still running; call again when the step finishes)'),
          }))
        ),
      });
    }
    return {
      content: [
        json({
          run_number: run.runNumber,
          workflow: run.name,
          event: run.event,
          ref: run.ref,
          head_sha: run.headSha,
          status: run.status,
          conclusion: run.conclusion,
          error: run.errorMessage,
          url: `${ctx.baseURL}/${fullName}/actions/runs/${run.runNumber}`,
          jobs: out,
        }),
      ],
    };
  },
};

export const PULL_TOOLS: ToolModule[] = [
  listPullRequests,
  getPullRequest,
  createPullRequest,
  commentPullRequest,
  mergePullRequest,
  getRunLogs,
];
