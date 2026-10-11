import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  prEvents,
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
import { actionsConfigured, rerun } from '../actions/trigger';
import { landPull } from '../merge/land';
import { rebaseTips, rebaseView, retryRebase } from '../merge/rebase';
import { settleStates } from '../pulls/settle';
import { reviewConfigured } from '../review/head';
import { reviewersView } from '../review/reviewers-view';
import { approvalsAt } from '../review/approvals';
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
import { appName } from './moderators';
import type { ToolContext, ToolModule } from './tools';
import { landShas, landTargetOf } from '../lib/land-target';

export const text = (t: string) => ({ type: 'text' as const, text: t });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

export function str(
  args: Record<string, unknown>,
  key: string,
  required: true
): string;
export function str(
  args: Record<string, unknown>,
  key: string,
  required?: false
): string | undefined;
export function str(
  args: Record<string, unknown>,
  key: string,
  required = false
) {
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

/** The longest session label, and the longest request, a pull request records. */
export const SESSION_MAX = 64;
export const REQUEST_MAX = 4000;

/**
 * An optional text argument, trimmed: null when it is absent or blank, an error over `max` characters. `strip` first
 * removes control, format and line-separator characters (a label is one line of plain text).
 */
function optionalText(
  args: Record<string, unknown>,
  key: string,
  max: number,
  strip = false
): string | null {
  let v = str(args, key);
  if (v === undefined) return null;
  if (strip) v = v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
  v = v.trim();
  if (!v) return null;
  if (Array.from(v).length > max)
    throw new McpToolError(`${key} must be at most ${max} characters.`);
  return v;
}

export function prNumber(args: Record<string, unknown>) {
  const n = args.number;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1)
    throw new McpToolError('number must be a positive integer.');
  return n;
}

export const repositoryProp = {
  type: 'string',
  description: 'Full name, e.g. "ada/analytical-engine".',
};
export const numberProp = {
  type: 'integer',
  minimum: 1,
  description: 'The pull request number, e.g. 12.',
};

/** The repository the user names, if they can read it; one answer for missing and hidden. */
export async function repoFor(ctx: ToolContext, args: Record<string, unknown>) {
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

export async function pullFor(
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

export const pullUrl = (ctx: ToolContext, fullName: string, n: number) =>
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

/**
 * What an agent must do after GitOrange rebased its branch: move its local commits onto the rebased branch. Only the
 * commits after the old head are replayed, so work it hasn't pushed yet is kept (a hard reset would drop it).
 */
export const rebasedNote = (branch: string, from: string, to: string) =>
  `GitOrange rebased this branch (${from.slice(0, 7)} → ${to.slice(0, 7)}); run \`git fetch && git rebase --onto origin/${branch} ${from}\` before you push again (it keeps your unpushed commits).`;

/**
 * A git read that may fail while GitOrange rebases the branch (its head ref moves under the read): the fallback, and
 * the failure noted so the answer says part of it could not be read.
 */
async function readable<T>(
  unread: string[],
  what: string,
  read: () => Promise<T>,
  fallback: T
): Promise<T> {
  try {
    return await read();
  } catch (e) {
    console.error('[mcp] pull request read failed', what, e);
    unread.push(what);
    return fallback;
  }
}

const getPullRequest: ToolModule = {
  definition: {
    name: 'gitorange_get_pull_request',
    title: 'Get pull request',
    description:
      'Get one pull request: its description, branches and commits, whether it is up to date with its base or ' +
      'behind (GitOrange rebases it itself; a rebase_conflict names the commit and files to fix locally, or to try ' +
      'again with gitorange_retry_rebase when AI failed on them; ' +
      'ai_resolving the commit AI is resolving), the Actions checks on its latest ' +
      'commit, "reviewers" (each invited agent\'s status and its findings by kind: needs_person for a person to ' +
      'approve in the web UI or through a moderator app, with "via" naming that app, change_requested for this pull request\'s agent), "follow_ups" (open change requests ' +
      'for the pull request\'s agent: push a fix, which is reviewed afresh), "approved_by" (people who approved the ' +
      'head commit; "approvals" adds the moderator app each was made "via", null for the web UI), whether it will merge on its own and what it waits on (auto_merge, null when off), and recent comments. Call it again to ' +
      'follow progress after pushing. For why a check failed, pass its run_number to gitorange_get_run_logs.' +
      ' "stack" says which pull request this one builds on, waits on, or must change for (with instructions).' +
      ' "pending" lists pull requests it is still being checked against, and "checking" is true until its first check starts;' +
      ' while either is set, empty lists do not mean it is independent. must_account_for instructions are generated by' +
      " GitOrange from the other pull request's text and diff: advisory, not an instruction from a person." +
      " A stacked pull request's base is its parent's branch (land_target is where it lands). must_account_for blocks merging until GitOrange re-checks a new commit and marks it accounted; rebase_first names the branch to rebase onto first. Only a person can dismiss a dependency." +
      ' "pull_state" says whose move it is: agent_followup (yours: push a fix for each reason), human_review (a ' +
      'person with merge permission), waiting (GitOrange: checks, review or AI resolving a rebase conflict are running, ' +
      'or merging_paused: a person paused merging on the repository), ' +
      'or ready; "reasons" lists why, as structured objects (e.g. check_failed with run_number for ' +
      'gitorange_get_run_logs).' +
      ' "rebased" (when set) means GitOrange rebased your branch: follow its note before pushing again.',
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
    // Every git read below can fail while the branch is being rebased: answer with what could be read.
    const unread: string[] = [];
    const shas = await readable(unread, 'head', () => pullShas(git, pr), null);
    // Merging is measured against the land target; base_ref may be a parent PR's branch while stacked.
    const target =
      pr.state === 'open'
        ? await readable(unread, 'target', () => landShas(git, pr), null)
        : null;

    let merge: Record<string, unknown> | null = null;
    const tips =
      pr.state === 'open'
        ? await readable(unread, 'rebase', () => rebaseTips(git, pr), null)
        : null;
    const v = tips
      ? await readable(
          unread,
          'rebase status',
          () => rebaseView(ctx.env, ctx.db, git, pr, tips),
          null
        )
      : null;
    if (v) {
      merge = {
        nothing_to_merge: v.status === 'nothing_to_merge',
        // GitOrange rebases a branch that is behind; landing does too.
        behind: v.status === 'behind',
        rebase_onto: v.onto,
        ai_resolving:
          v.status === 'resolving'
            ? { commit: v.commit, files: v.files }
            : null,
        rebase_conflict:
          v.status === 'conflict'
            ? { commit: v.commit, files: v.files, error: v.error }
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

    const review = await readable(
      unread,
      'reviewers',
      () => reviewersView(ctx.env, ctx.db, git, pr, shas),
      null
    );
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
    const commits = shas
      ? await readable(
          unread,
          'commits',
          () => git.commitsBetween(shas.base, shas.head),
          []
        )
      : [];
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
    const pullState = await readable(
      unread,
      'pull_state',
      () =>
        pullStateFor(ctx.db, git, pr, {
          shas: target,
          reviewConfigured: reviewConfigured(ctx.env),
          tree: found?.view,
        }),
      null
    );
    // Said only of a rebase that is running; a failed read is reported as that, whatever the cause.
    const notes = [
      v?.status === 'resolving'
        ? 'GitOrange is rebasing this pull request.'
        : null,
      unread.length
        ? `Part of this pull request could not be read (${unread.join(', ')}); call again in a minute.`
        : null,
    ].filter(Boolean);

    // GitOrange rebased the branch to its current head: the agent's clone is stale until it rebases onto it.
    const last = shas
      ? await ctx.db
          .select({ data: prEvents.data })
          .from(prEvents)
          .where(
            and(eq(prEvents.pullRequestId, pr.id), eq(prEvents.kind, 'rebased'))
          )
          .orderBy(desc(prEvents.createdAt))
          .limit(1)
          .get()
      : undefined;
    const r = last?.data as { from?: string; to?: string } | undefined;
    const rebased =
      pr.state === 'open' && r?.from && r.to && r.to === shas?.head
        ? {
            from: r.from,
            to: r.to,
            note: rebasedNote(pr.headRef, r.from, r.to),
          }
        : null;

    const approvals = shas ? await approvalsAt(ctx.db, pr.id, shas.head) : [];
    const approvers = await usersById(
      ctx.db,
      approvals.map((a) => a.userId)
    );
    const approvedBy = approvals.map(
      (a) => approvers.get(a.userId)?.username ?? null
    );
    // The same approvals with the moderator app each was made through (null: in the web UI).
    const approvalsVia = approvals.map((a, i) => ({
      user: approvedBy[i],
      via: a.via,
    }));

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
          // Who opened it, as the app reported: the app, its session label, and the person's original request.
          created_via: pr.createdVia,
          session: pr.sessionLabel,
          request: pr.request,
          commits: commits.map((c) => ({
            sha: c.hash.slice(0, 7),
            message: c.message.split('\n')[0],
          })),
          merge,
          note: pr.state === 'open' && notes.length ? notes.join(' ') : null,
          rebased,
          checks: runs.map((r) => ({
            workflow: r.name,
            run_number: r.runNumber,
            status: r.status,
            conclusion: r.conclusion,
            error: r.errorMessage,
            url: `${ctx.baseURL}/${fullName}/actions/runs/${r.runNumber}`,
          })),
          auto_merge:
            review && review.autoMerge.state !== 'off'
              ? {
                  state: review.autoMerge.state,
                  waiting_on: review.autoMerge.reasons,
                }
              : null,
          reviewers: (review?.reviewers ?? []).map((r) => ({
            agent: r.agent.username,
            status: r.status,
            requested: r.requested,
            probability: r.probability,
            agent_sha: r.agentSha,
            summary: r.summary,
            error: r.error,
            still_invited: r.invited,
            findings: r.flags.map((f) => ({
              id: f.id,
              kind: f.kind,
              title: f.title,
              files: f.paths,
              finding: f.detail,
              state: f.approvedAt
                ? f.kind === 'change_requested'
                  ? 'dismissed'
                  : 'approved'
                : f.changesRequestedAt
                  ? 'changes_requested'
                  : 'open',
              changes_requested_note: f.changesRequestedNote,
              // The moderator app it was approved or dismissed through; null in the web UI or while open.
              via: f.approvedVia,
              // needs_person: the agent's plain yes/no question for the owner.
              question: f.question,
              // Approving it (or dismissing it) needs a reason; it is never approved in bulk or by AI.
              guarded: f.guarded,
            })),
          })),
          approved_by: approvedBy,
          approvals: approvalsVia,
          // What the pull request's agent should change: open change requests of agents still invited.
          follow_ups: (review?.reviewers ?? [])
            .filter((r) => r.invited && r.status === 'changes_requested')
            .flatMap((r) =>
              r.flags
                .filter((f) => f.kind === 'change_requested' && !f.approvedAt)
                .map((f) => ({
                  agent: r.agent.username,
                  finding_id: f.id,
                  title: f.title,
                  instructions: f.detail,
                }))
            ),
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
      'branch if omitted). Opening it starts its checks and, where reviewer agents are invited, ' +
      'their review; follow both with gitorange_get_pull_request. Needs push access. Always pass `request` ' +
      "(the person's original request, in their words) and `session` (a short label for this coding session, the " +
      'same on every pull request you open in it): GitOrange shows them to the people who review the change and ' +
      'groups your pull requests into one session.',
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
        session: {
          type: 'string',
          maxLength: SESSION_MAX,
          description:
            'A short label for this coding session (at most 64 characters), e.g. "s4": the same on every pull ' +
            'request you open in it, different from your other sessions.',
        },
        request: {
          type: 'string',
          maxLength: REQUEST_MAX,
          description:
            "The person's original request that led to this change, in their own words (at most 4000 characters), " +
            'not your summary of it.',
        },
      },
      required: ['repository', 'head', 'title'],
    },
  },
  handler: async (args, ctx) => {
    const { repo, git, fullName, perms } = await repoFor(ctx, args);
    if (!perms.write)
      throw new McpToolError(`You don't have push access to ${fullName}.`);
    // Checked before anything is opened: a refused call leaves no pull request behind.
    const sessionLabel = optionalText(args, 'session', SESSION_MAX, true);
    const request = optionalText(args, 'request', REQUEST_MAX);
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
      // Self-reported provenance: the app is the OAuth client of this token, the rest is what the agent passed.
      createdVia: ctx.clientId ? await appName(ctx.db, ctx.clientId) : null,
      sessionLabel,
      request,
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
          created_via: result.pr.createdVia,
          session: result.pr.sessionLabel,
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
      'Rebase and merge a pull request: if its target branch moved, GitOrange rebases it first, then moves the target ' +
      'branch to its head (a fast-forward), so every commit keeps its author, message and SHA and history stays linear. ' +
      'When it had to rebase and the new head needs checks or a fresh review, it stops with "Rebased onto … — waiting ' +
      'for checks" and lands once they pass (auto-merge) — call it again then. Refused while checks fail or run, review ' +
      "is not satisfied (an agent's change request, findings for a person, or no approval yet), or a rebase conflict " +
      'needs fixing locally. Needs push access.' +
      ' Also refused while it must account for another pull request, is stacked on an open one, or waits on one; the refusal names it. Only a person can dismiss such a dependency, in the web UI.' +
      ' Also refused while a person has paused merging on the repository, until they resume it.',
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
    const result = await landPull({
      env: ctx.env,
      db: ctx.db,
      repo,
      repoFullName: fullName,
      git,
      pr,
      by: ctx.user,
      after: ctx.after,
    });
    if (!result.ok)
      throw new McpToolError(
        (result.reason === 'review'
          ? `${result.error} People approve in GitOrange's web UI, or through a moderator app: ask the user to review it at ${pullUrl(ctx, fullName, pr.number)} or on their Approvals page.`
          : result.error) +
          // Landing rewrote the branch: the agent's local copy is now stale.
          (result.rebased && result.rebasedFrom
            ? ` ${rebasedNote(pr.headRef, result.rebasedFrom, result.rebased)}`
            : '')
      );
    return {
      content: [
        text(
          `Merged #${pr.number} into ${landTargetOf(pr)}: it is now at ${result.sha.slice(0, 7)}: ${pullUrl(ctx, fullName, pr.number)}`
        ),
      ],
    };
  },
};

const retryRebaseTool: ToolModule = {
  definition: {
    name: 'gitorange_retry_rebase',
    title: 'Try the rebase again',
    description:
      "Try a pull request's stopped rebase again (its rebase_conflict in gitorange_get_pull_request): GitOrange sets " +
      'aside where it stopped and rebases it again, asking AI again about the commit it could not resolve (the model ' +
      'failed or could not be reached, or AI had already resolved too many commits). Refused when nothing is stopped, ' +
      'and for a "Not rebased" branch (bring it up to date yourself). A conflict AI never takes (binary or generated ' +
      'files) stops again: rebase locally instead. Follow it with gitorange_get_pull_request. Needs push access.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      title: 'Try the rebase again',
    },
    inputSchema: {
      type: 'object',
      properties: { repository: repositoryProp, number: numberProp },
      required: ['repository', 'number'],
    },
  },
  handler: async (args, ctx) => {
    const { repo, git, fullName, perms } = await repoFor(ctx, args);
    // The same check as the web UI (merge permission).
    if (!perms.write)
      throw new McpToolError(
        `You don't have permission to rebase pull requests in ${fullName}.`
      );
    const pr = await pullFor(ctx, repo.id, fullName, prNumber(args));
    const result = await retryRebase(ctx.env, ctx.db, git, pr);
    if (!result.ok) throw new McpToolError(result.error);
    ctx.after(publishChange(ctx.env, repo.id, { approvals: true }));
    ctx.after(settleStates(ctx.env, ctx.db, repo.id));
    return {
      content: [
        text(
          `Rebasing #${pr.number} onto ${result.view.onto} again: follow it with gitorange_get_pull_request. ${pullUrl(ctx, fullName, pr.number)}`
        ),
      ],
    };
  },
};

const rerunChecksTool: ToolModule = {
  definition: {
    name: 'gitorange_rerun_checks',
    title: 'Re-run failed checks',
    description:
      "Re-run a pull request's failed Actions runs at its current head (the check_failed reasons in " +
      'gitorange_get_pull_request), for example after a failure that had nothing to do with your change (the runner ' +
      'could not start, a network error). It starts a new run of each workflow whose latest run at the head failed. ' +
      "Use it instead of pushing an empty commit, which resets a person's approval. Read the logs with " +
      'gitorange_get_run_logs first: a failure your change caused needs a fix pushed instead. Follow it with ' +
      'gitorange_get_pull_request. Needs push access.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      title: 'Re-run failed checks',
    },
    inputSchema: {
      type: 'object',
      properties: { repository: repositoryProp, number: numberProp },
      required: ['repository', 'number'],
    },
  },
  handler: async (args, ctx) => {
    const { repo, git, fullName, perms } = await repoFor(ctx, args);
    // The same check as the re-run route.
    if (!perms.write)
      throw new McpToolError(
        `You don't have permission to re-run checks in ${fullName}.`
      );
    if (!actionsConfigured(ctx.env))
      throw new McpToolError('Actions is not set up on this server.');
    const pr = await pullFor(ctx, repo.id, fullName, prNumber(args));
    if (pr.state !== 'open')
      throw new McpToolError(`#${pr.number} is not open.`);
    const shas = await pullShas(git, pr);
    if (!shas) throw new McpToolError(`#${pr.number} has no head to check.`);
    const runs = await ctx.db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.repositoryId, repo.id),
          eq(workflowRuns.headSha, shas.head)
        )
      )
      .orderBy(desc(workflowRuns.runNumber))
      .all();
    // A workflow's latest run decides: a later success or a run in progress means nothing to re-run.
    const latest = new Map<string, (typeof runs)[number]>();
    for (const run of runs)
      if (!latest.has(run.workflowPath)) latest.set(run.workflowPath, run);
    const failed = [...latest.values()].filter(
      (r) => r.status === 'completed' && r.conclusion === 'failure'
    );
    if (!failed.length)
      throw new McpToolError(
        `#${pr.number} has no failed run at ${shas.head.slice(0, 7)} to re-run.`
      );
    const started: { name: string; from_run: number; run_number: number }[] =
      [];
    for (const run of failed) {
      const id = await rerun(ctx.env, ctx.db, repo, fullName, run, ctx.user.id);
      const created = await ctx.db
        .select({ runNumber: workflowRuns.runNumber })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, id))
        .get();
      started.push({
        name: run.name,
        from_run: run.runNumber,
        run_number: created!.runNumber,
      });
    }
    ctx.after(publishChange(ctx.env, repo.id));
    ctx.after(settleStates(ctx.env, ctx.db, repo.id));
    return {
      content: [
        json({
          rerun: started,
          note: `Follow them with gitorange_get_pull_request. ${pullUrl(ctx, fullName, pr.number)}`,
        }),
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
    "The finding's id, from gitorange_get_pull_request's reviewers[].findings.",
};

/** Requests changes on a review flag as the signed-in user (people approve and dismiss only in the web UI). */
async function decideFlagTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
  decision: FlagDecision
) {
  const { repo, fullName, perms } = await repoFor(ctx, args);
  // The same check as the web UI.
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

const requestChangesOnReviewFlag: ToolModule = {
  definition: {
    name: 'gitorange_request_changes_on_review_flag',
    title: 'Request changes on review flag',
    description:
      "Request changes on one of a pull request's findings that need a person (kind needs_person), as the " +
      'signed-in user, with an optional short note. It blocks merging until a person approves the finding in ' +
      'the web UI. Only use this when the user explicitly asks you to. Needs push access.',
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
  retryRebaseTool,
  rerunChecksTool,
  requestChangesOnReviewFlag,
  getRunLogs,
];
