import { approvePull } from '../review/approvals';
import {
  DECISION_REASON_MAX,
  decideFlag,
  type FlagKind,
} from '../review/flags';
import { publishChange } from '../live/publish';
import { McpToolError } from './errors';
import { NOT_MODERATOR, type Moderator } from './moderators';
import {
  numberProp,
  prNumber,
  pullFor,
  pullUrl,
  repoFor,
  repositoryProp,
  str,
  text,
} from './pull-tools';
import type { ToolContext, ToolModule } from './tools';

/** index.ts refuses these before the handler for a non-moderator; this is the second lock. */
function moderatorOf(ctx: ToolContext): Moderator {
  if (!ctx.moderator) throw new McpToolError(NOT_MODERATOR);
  return ctx.moderator;
}

const headShaProp = {
  type: 'string',
  description:
    'The full head commit SHA you reviewed (head_sha from gitorange_get_pull_request). If the pull request has ' +
    'new commits since, nothing is recorded: look again.',
};
const findingIdProp = {
  type: 'string',
  description:
    "The finding's id, from gitorange_get_pull_request's reviewers[].findings.",
};
const reasonProp = {
  type: 'string',
  maxLength: DECISION_REASON_MAX,
  description:
    "Why. Required for a guarded agent's finding (guarded: true in gitorange_get_pull_request): it goes in the " +
    "audit log with the user's name. Ask the user for it; never make one up.",
};

/** The repository, pull request and head SHA a moderator tool acts on, after the same checks as the web UI. */
async function moderatedPull(
  args: Record<string, unknown>,
  ctx: ToolContext,
  verb: string
) {
  const moderator = moderatorOf(ctx);
  const { repo, fullName, perms, git } = await repoFor(ctx, args);
  // The same permission as the web's approve and dismiss: merge (push) access.
  if (!perms.write)
    throw new McpToolError(
      `You don't have permission to ${verb} in ${fullName}.`
    );
  const pr = await pullFor(ctx, repo.id, fullName, prNumber(args));
  const headSha = str(args, 'head_sha', true).trim().toLowerCase();
  // An abbreviation or a branch name is not "the head you reviewed"; say so rather than "new commits".
  if (!/^[0-9a-f]{40}$/.test(headSha))
    throw new McpToolError(
      'Pass the full 40-character head_sha from gitorange_get_pull_request, not an abbreviation or branch name.'
    );
  return { moderator, repo, fullName, git, pr, headSha };
}

/** Approves (needs_person) or dismisses (change_requested) one finding through the web's `decideFlag`. */
async function decideFinding(
  args: Record<string, unknown>,
  ctx: ToolContext,
  kind: FlagKind
) {
  const { moderator, repo, fullName, git, pr, headSha } = await moderatedPull(
    args,
    ctx,
    kind === 'needs_person' ? 'approve findings' : 'dismiss change requests'
  );
  const findingId = str(args, 'finding_id', true).trim();
  const result = await decideFlag(
    ctx.env,
    ctx.db,
    pr,
    findingId,
    ctx.user.id,
    // A guarded agent's finding needs the reason; decideFlag refuses it without one, as on the web.
    { kind: 'approve', reason: str(args, 'reason') },
    ctx.after,
    { via: moderator.name, kind, expectedHead: { sha: headSha, git } }
  );
  if (!result.ok)
    throw new McpToolError(
      result.status === 404
        ? `#${pr.number} has no finding ${findingId}. Call gitorange_get_pull_request to see its findings.`
        : result.error
    );
  ctx.after(publishChange(ctx.env, repo.id, { approvals: true }));
  return pullUrl(ctx, fullName, pr.number);
}

const approveReviewFinding: ToolModule = {
  definition: {
    name: 'gitorange_approve_review_finding',
    title: 'Approve review finding',
    description:
      "Moderator apps only. Approve one of a pull request's findings that needs a person (kind needs_person), " +
      'as the signed-in user, recorded as made via this app — the same as Approve in the web UI. Read the ' +
      "finding with gitorange_get_pull_request first and pass the head_sha you reviewed. A guarded agent's finding " +
      '(guarded: true) needs a reason from the user. Needs push access.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      title: 'Approve review finding',
    },
    inputSchema: {
      type: 'object',
      properties: {
        repository: repositoryProp,
        number: numberProp,
        finding_id: findingIdProp,
        head_sha: headShaProp,
        reason: reasonProp,
      },
      required: ['repository', 'number', 'finding_id', 'head_sha'],
    },
  },
  handler: async (args, ctx) => {
    const url = await decideFinding(args, ctx, 'needs_person');
    return { content: [text(`Approved the finding on ${url}`)] };
  },
};

const dismissChangeRequest: ToolModule = {
  definition: {
    name: 'gitorange_dismiss_change_request',
    title: 'Dismiss change request',
    description:
      "Moderator apps only. Dismiss an agent's change request on a pull request (a finding of kind " +
      'change_requested), as the signed-in user, recorded as made via this app — the same as Dismiss in the web ' +
      "UI. Pass the head_sha you reviewed. A guarded agent's change request needs a reason from the user. Needs " +
      'push access.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      title: 'Dismiss change request',
    },
    inputSchema: {
      type: 'object',
      properties: {
        repository: repositoryProp,
        number: numberProp,
        finding_id: findingIdProp,
        head_sha: headShaProp,
        reason: reasonProp,
      },
      required: ['repository', 'number', 'finding_id', 'head_sha'],
    },
  },
  handler: async (args, ctx) => {
    const url = await decideFinding(args, ctx, 'change_requested');
    return { content: [text(`Dismissed the change request on ${url}`)] };
  },
};

const approvePullRequest: ToolModule = {
  definition: {
    name: 'gitorange_approve_pull_request',
    title: 'Approve pull request',
    description:
      "Moderator apps only. Approve a pull request's head commit as the signed-in user, recorded as made via " +
      'this app — the same as Approve in the web UI. It satisfies review when no agent was requested and stands ' +
      "over findings for a person and failed agent reviews, but not over an agent's open change request or a " +
      "guarded agent's finding (approve those one at a time, with a reason). Pass the head_sha you reviewed. Needs " +
      'push access.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      title: 'Approve pull request',
    },
    inputSchema: {
      type: 'object',
      properties: {
        repository: repositoryProp,
        number: numberProp,
        head_sha: headShaProp,
      },
      required: ['repository', 'number', 'head_sha'],
    },
  },
  handler: async (args, ctx) => {
    const { moderator, repo, fullName, git, pr, headSha } = await moderatedPull(
      args,
      ctx,
      'approve pull requests'
    );
    const result = await approvePull(
      ctx.env,
      ctx.db,
      git,
      pr,
      ctx.user.id,
      ctx.after,
      { expectedHead: headSha, via: moderator.name }
    );
    if (!result.ok) throw new McpToolError(result.error);
    ctx.after(publishChange(ctx.env, repo.id, { approvals: true }));
    return {
      content: [
        text(
          `Approved ${result.headSha.slice(0, 7)} on ${pullUrl(ctx, fullName, pr.number)}`
        ),
      ],
    };
  },
};

/** Listed and callable only for a moderator connection; index.ts checks on every call. */
export const MODERATOR_TOOLS: ToolModule[] = [
  approveReviewFinding,
  dismissChangeRequest,
  approvePullRequest,
];
