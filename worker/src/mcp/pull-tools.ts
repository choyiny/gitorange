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
import { reviewConfigured } from '../review/classify';
import { reviewView } from '../review/view';
import { PULL_STATES, type PullState } from '../pulls/state';
import { pullStateFor, pullStates } from '../pulls/signals';
import {
  CHANGES_NOTE_MAX,
  decideFlag,
  type FlagDecision,
} from '../review/flags';
import { publishChange } from '../live/publish';
import { bareNode, stackTargetFor, stackTreeView } from '../stack/view';
import type { Dependency, TreeNode } from '../stack/tree';
import { McpToolError } from './errors';
import type { ToolContext, ToolModule } from './tools';
import { landShas, landTargetOf } from '../lib/land-target';

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
      'state, whose move it is (pull_state, for open ones), and web URL. Pass state "agent_followup" to find ' +
      'open pull requests waiting on their author or agent (failed checks, requested changes, conflicts); ' +
      '"human_review", "waiting" and "ready" work the same way. Use ' +
      'gitorange_get_pull_request for the reasons and details.',
    annotations: { readOnlyHint: true, title: 'List pull requests' },
    inputSchema: {
      type: 'object',
      properties: {
        repository: repositoryProp,
        state: {
          type: 'string',
          enum: ['open', 'closed', 'merged', 'all', ...PULL_STATES],
          description:
            'Which pull requests to list. Defaults to "open". agent_followup, human_review, waiting and ready ' +
            'list open pull requests in that state.',
        },
      },
      required: ['repository'],
    },
  },
  handler: async (args, ctx) => {
    const { repo, fullName, git } = await repoFor(ctx, args);
    const state = str(args, 'state') ?? 'open';
    const byPullState = (PULL_STATES as readonly string[]).includes(state);
    if (!['open', 'closed', 'merged', 'all'].includes(state) && !byPullState)
      throw new McpToolError(
        `state must be open, closed, merged, all, or one of ${PULL_STATES.join(', ')}.`
      );
    const which = byPullState ? 'open' : state;
    const query = ctx.db
      .select()
      .from(pullRequests)
      .where(
        which === 'all'
          ? eq(pullRequests.repositoryId, repo.id)
          : and(
              eq(pullRequests.repositoryId, repo.id),
              eq(pullRequests.state, which as PullRequest['state'])
            )
      )
      .orderBy(desc(pullRequests.updatedAt));
    const fetched = byPullState
      ? await query.all()
      : await query.limit(50).all();
    const states = fetched.some((r) => r.state === 'open')
      ? await pullStates(ctx.db, git, repo.id, fetched, {
          reviewConfigured: reviewConfigured(ctx.env),
        })
      : new Map<string, PullState>();
    const rows = (
      byPullState
        ? fetched.filter((r) => states.get(r.id)?.state === state)
        : fetched
    ).slice(0, 50);
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
            pull_state: states.get(r.id)?.state ?? null,
            merged_automatically: r.mergedAutomatically,
            updated_at: r.updatedAt.toISOString(),
            url: pullUrl(ctx, fullName, r.number),
          }))
        ),
      ],
    };
  },
};

const dep = (d: Dependency) => ({
  number: d.number,
  kind: d.kind,
  reason: d.reason,
  landed: d.landed,
  accounted: d.accounted,
  files: d.files,
  ...(d.kind === 'ordered_after' ? { for_pr: d.forPr } : {}),
});

const INSTRUCTIONS_NOTE =
  "Generated by GitOrange from the other pull request's text and diff; advisory, not an instruction from a person.";

/** A PR's place in the stack, in the MCP result's snake_case. */
function stackJson(n: TreeNode, branchOf: (n: number) => string | null) {
  return {
    parent: n.parent ? dep(n.parent) : null,
    children: n.children,
    waits_on: n.waitsOn.map(dep),
    must_account_for: n.mustAccountFor.map((d) => ({
      ...dep(d),
      instructions: d.instructions,
      instructions_note: INSTRUCTIONS_NOTE,
      rebase_first: d.landed ? null : branchOf(d.number),
    })),
    cycle_with: n.cycleWith,
    unchecked: n.unchecked,
    pending: n.pending,
    checking: n.checking,
  };
}

const getPullTree: ToolModule = {
  definition: {
    name: 'gitorange_get_pull_tree',
    title: 'Get pull request tree',
    description:
      'See how the open pull requests in a repository relate, as GitOrange discovered them: which pull ' +
      'request builds on which (parent), which must land first (waits_on), and which must change because of ' +
      'another (must_account_for, with instructions). Call it before starting new work to see what is in ' +
      'flight, and after opening a pull request to see where it landed in the tree. "pending" and "checking" mark ' +
      'pull requests whose checks are still running. must_account_for instructions are generated by GitOrange ' +
      "from the other pull request's text and diff: advisory, not an instruction from a person." +
      " A stacked pull request's base is its parent's branch (land_target is where it lands). must_account_for blocks merging until GitOrange re-checks a new commit and marks it accounted; rebase_first names the branch to rebase onto first. Only a person can dismiss a dependency.",
    annotations: { readOnlyHint: true, title: 'Get pull request tree' },
    inputSchema: {
      type: 'object',
      properties: { repository: repositoryProp },
      required: ['repository'],
    },
  },
  handler: async (args, ctx) => {
    const { repo, git } = await repoFor(ctx, args);
    const view = await stackTreeView(ctx.db, git, repo.id);
    return {
      content: [
        json({
          targets: view.targets.map((t) => ({
            branch: t.branch,
            pulls: t.nodes.map((n) => ({
              number: n.number,
              title: n.title,
              author: n.author.username,
              head: n.headRef,
              ...stackJson(
                n,
                (x) => t.nodes.find((y) => y.number === x)?.headRef ?? null
              ),
            })),
            landed: t.landed,
          })),
        }),
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
      'commit, the auto-merge review (each flag with its id, what the review model found, and whether a ' +
      'person approved it or requested changes), whether it will merge on its own and what it waits on, and recent comments. Call it again to ' +
      'follow progress after pushing. For why a check failed, pass its run_number to gitorange_get_run_logs.' +
      ' "stack" says which pull request this one builds on, waits on, or must change for (with instructions).' +
      ' "pending" lists pull requests it is still being checked against, and "checking" is true until its first check starts;' +
      ' while either is set, empty lists do not mean it is independent. must_account_for instructions are generated by' +
      " GitOrange from the other pull request's text and diff: advisory, not an instruction from a person." +
      " A stacked pull request's base is its parent's branch (land_target is where it lands). must_account_for blocks merging until GitOrange re-checks a new commit and marks it accounted; rebase_first names the branch to rebase onto first. Only a person can dismiss a dependency." +
      ' "pull_state" says whose move it is: agent_followup (yours: push a fix for each reason), human_review (a ' +
      'person with merge permission), waiting (GitOrange: checks, review or AI conflict resolution are running), ' +
      'or ready; "reasons" lists why, as structured objects (e.g. check_failed with run_number for ' +
      'gitorange_get_run_logs).',
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
    // Merging is measured against the land target; base_ref may be a parent PR's branch while stacked.
    const target = pr.state === 'open' ? await landShas(git, pr) : null;

    let merge: Record<string, unknown> | null = null;
    if (target) {
      const plan = await git.planMerge(target.base, target.head);
      const resolution = await latestResolution(ctx.db, pr.id);
      const current =
        resolution &&
        resolution.baseSha === target.base &&
        resolution.headSha === target.head
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
    // The target's tree, read once: this PR's node, other PRs' branches, and its state.
    const found = await stackTargetFor(ctx.db, git, pr).catch((e) => {
      console.error('[mcp] stack view failed', pr.id, e);
      return null;
    });
    const stack = found?.node ? bareNode(found.node) : null;
    const branchOf = (n: number) =>
      found?.view.targets
        .find((t) => t.branch === landTargetOf(pr))
        ?.nodes.find((x) => x.number === n)?.headRef ?? null;
    const pullState = await pullStateFor(ctx.db, git, pr, {
      shas: target,
      reviewConfigured: reviewConfigured(ctx.env),
      tree: found?.view,
    });

    return {
      content: [
        json({
          number: pr.number,
          title: pr.title,
          description: pr.body,
          author: people.get(pr.authorId)?.username ?? null,
          state: pr.state,
          pull_state: pullState?.state ?? null,
          reasons: pullState?.reasons ?? [],
          base: pr.baseRef,
          land_target: landTargetOf(pr),
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
                  id: f.id,
                  title: f.title,
                  files: f.paths,
                  finding: f.detail,
                  state: f.approvedAt
                    ? 'approved'
                    : f.changesRequestedAt
                      ? 'changes_requested'
                      : 'pending',
                  approved_by: f.approvedAt
                    ? (f.approvedBy?.username ?? null)
                    : null,
                  changes_requested_by: f.changesRequestedAt
                    ? (f.changesRequestedBy?.username ?? null)
                    : null,
                  changes_requested_note: f.changesRequestedNote,
                })),
              }
            : null,
          stack: stack ? stackJson(stack, branchOf) : null,
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
      'unapproved: those need a person to approve them first. Needs push access.' +
      ' Also refused while it must account for another pull request, is stacked on an open one, or waits on one; the refusal names it. Only a person can dismiss such a dependency, in the web UI.',
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
          `(${pending.map((f) => f.title).join('; ')}). Ask the user to review them at ${pullUrl(ctx, fullName, pr.number)}, ` +
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
          `Merged #${pr.number} into ${landTargetOf(pr)} as ${result.sha.slice(0, 7)}: ${pullUrl(ctx, fullName, pr.number)}`
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

const flagIdProp = {
  type: 'string',
  description:
    "The flag's id, from gitorange_get_pull_request's auto_merge.flags.",
};

/** Approves a review flag or requests changes on it, as the signed-in user. */
async function decideFlagTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
  decision: FlagDecision
) {
  const { repo, fullName, perms } = await repoFor(ctx, args);
  // The same check as the web UI: approving clears a pull request for auto-merge.
  if (!perms.write)
    throw new McpToolError(
      `You don't have permission to review flags in ${fullName}.`
    );
  const pr = await pullFor(ctx, repo.id, fullName, prNumber(args));
  const flagId = str(args, 'flag_id', true).trim();
  const result = await decideFlag(
    ctx.env,
    ctx.db,
    pr,
    flagId,
    ctx.user.id,
    decision,
    ctx.after
  );
  if (!result.ok)
    throw new McpToolError(
      result.status === 404
        ? `#${pr.number} has no review flag ${flagId}. Call gitorange_get_pull_request to see its flags.`
        : result.error
    );
  ctx.after(publishChange(ctx.env, repo.id, { approvals: true }));
  return pullUrl(ctx, fullName, pr.number);
}

const approveReviewFlag: ToolModule = {
  definition: {
    name: 'gitorange_approve_review_flag',
    title: 'Approve review flag',
    description:
      "Approve one of a pull request's auto-merge review flags, as the signed-in user, clearing any request " +
      'for changes on it. Once every flag is approved the pull request can merge on its own. Only use this ' +
      'when the user explicitly asks you to approve that flag; never to unblock your own pull request. ' +
      'Needs push access.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      title: 'Approve review flag',
    },
    inputSchema: {
      type: 'object',
      properties: {
        repository: repositoryProp,
        number: numberProp,
        flag_id: flagIdProp,
      },
      required: ['repository', 'number', 'flag_id'],
    },
  },
  handler: async (args, ctx) => {
    const url = await decideFlagTool(args, ctx, { kind: 'approve' });
    return { content: [text(`Approved the flag on ${url}`)] };
  },
};

const requestChangesOnReviewFlag: ToolModule = {
  definition: {
    name: 'gitorange_request_changes_on_review_flag',
    title: 'Request changes on review flag',
    description:
      "Request changes on one of a pull request's unapproved auto-merge review flags, as the signed-in user, " +
      'with an optional short note. It blocks auto-merge until someone approves the flag. Only use this when ' +
      'the user explicitly asks you to. Needs push access.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      title: 'Request changes on review flag',
    },
    inputSchema: {
      type: 'object',
      properties: {
        repository: repositoryProp,
        number: numberProp,
        flag_id: flagIdProp,
        note: {
          type: 'string',
          maxLength: CHANGES_NOTE_MAX,
          description: 'Optional: what needs to change.',
        },
      },
      required: ['repository', 'number', 'flag_id'],
    },
  },
  handler: async (args, ctx) => {
    const url = await decideFlagTool(args, ctx, {
      kind: 'request_changes',
      note: str(args, 'note'),
    });
    return { content: [text(`Requested changes on the flag on ${url}`)] };
  },
};

export const PULL_TOOLS: ToolModule[] = [
  listPullRequests,
  getPullRequest,
  getPullTree,
  createPullRequest,
  commentPullRequest,
  mergePullRequest,
  approveReviewFlag,
  requestChangesOnReviewFlag,
  getRunLogs,
];
