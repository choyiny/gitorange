import {
  createAgent,
  listAgents,
  repositoryAgentList,
  serializeAgent,
  type AgentView,
} from '../agents/accounts';
import { inviteAgent, removeAgent } from '../agents/membership';
import { latestLessons, type LessonView } from '../learn/view';
import { publishChange } from '../live/publish';
import { McpToolError } from './errors';
import { repoFor, repositoryProp, str, text } from './pull-tools';
import type { ToolContext, ToolModule } from './tools';

// Reviewer agents over MCP: the same rules as Site admin → Agents and Repository settings → Agents. Deleting an
// agent stays in the web UI.

const json = (v: unknown) => text(JSON.stringify(v, null, 2));

const handleProp = {
  type: 'string',
  description:
    'The agent\'s handle, e.g. "securityagent" (from gitorange_list_agents).',
};

function agentJson(ctx: ToolContext, v: AgentView, lessons?: LessonView[]) {
  const a = serializeAgent(v);
  return {
    handle: a.username,
    name: a.name,
    bio: a.bio,
    trigger: a.trigger,
    engine: a.engine,
    // Its AGENT.md and knowledge/ live here; null when the user can't read it.
    repository: a.repository,
    repository_url: a.repository ? `${ctx.baseURL}/${a.repository}` : null,
    config_error: a.configError,
    // What it learned lately from change requests people dismissed (where the user can read the pull request).
    ...(lessons
      ? {
          lessons: lessons.map((l) => ({
            pull_request: `${l.repository}#${l.number}`,
            status: l.status,
            commit: l.commitSha,
            summary: l.summary,
            error: l.error,
            finished_at: l.finishedAt,
          })),
        }
      : {}),
  };
}

/** The repository a membership tool changes, after the web UI's check: admin of the repository. */
async function administeredRepo(
  ctx: ToolContext,
  args: Record<string, unknown>,
  verb: string
) {
  const found = await repoFor(ctx, args);
  if (!found.perms.admin)
    throw new McpToolError(
      `Only an admin of ${found.fullName} can ${verb} agents.`
    );
  return found;
}

const listAgentsTool: ToolModule = {
  definition: {
    name: 'gitorange_list_agents',
    title: 'List reviewer agents',
    description:
      'List the reviewer agents on this server: each one reviews pull requests in the repositories that invite ' +
      "it, when its trigger question is likely to apply to the change. Returns each agent's handle, name, bio, " +
      'trigger and its own repository, where its AGENT.md and knowledge/ live, and its latest lessons: what it ' +
      'learned from change requests people dismissed (status, commit, summary).',
    annotations: { readOnlyHint: true, title: 'List reviewer agents' },
    inputSchema: { type: 'object', properties: {} },
  },
  handler: async (_args, ctx) => {
    const agents = await listAgents(ctx.db, ctx.user);
    const lessons = await latestLessons(
      ctx.db,
      agents.map((v) => v.agent.userId),
      ctx.user
    );
    return {
      content: [
        json(
          agents.map((v) =>
            agentJson(ctx, v, lessons.get(v.agent.userId) ?? [])
          )
        ),
        ...(agents.length
          ? []
          : [text('No agents yet. A site admin creates them.')]),
      ],
    };
  },
};

const listRepositoryAgents: ToolModule = {
  definition: {
    name: 'gitorange_list_repository_agents',
    title: "List a repository's agents",
    description:
      'List the reviewer agents a repository has invited. With none, a person approves each pull request commit.',
    annotations: { readOnlyHint: true, title: "List a repository's agents" },
    inputSchema: {
      type: 'object',
      properties: { repository: repositoryProp },
      required: ['repository'],
    },
  },
  handler: async (args, ctx) => {
    const { repo, fullName } = await repoFor(ctx, args);
    const rows = await repositoryAgentList(ctx.db, repo.id, ctx.user);
    return {
      content: [
        json(
          rows.map((r) => ({
            ...agentJson(ctx, r),
            invited_at: r.invitedAt.toISOString(),
          }))
        ),
        ...(rows.length
          ? []
          : [
              text(
                `${fullName} has invited no agents, so a person approves each commit.`
              ),
            ]),
      ],
    };
  },
};

const inviteAgentTool: ToolModule = {
  definition: {
    name: 'gitorange_invite_agent',
    title: 'Invite an agent',
    description:
      'Invite a reviewer agent to review pull requests in a repository. Inviting it again does nothing. Needs ' +
      'admin access to the repository; a repository invites at most 10 agents.',
    annotations: { readOnlyHint: false, title: 'Invite an agent' },
    inputSchema: {
      type: 'object',
      properties: { repository: repositoryProp, handle: handleProp },
      required: ['repository', 'handle'],
    },
  },
  handler: async (args, ctx) => {
    const { repo, fullName } = await administeredRepo(ctx, args, 'invite');
    const handle = str(args, 'handle', true).trim();
    const result = await inviteAgent(ctx.db, repo.id, handle, ctx.user.id);
    if (!result.ok)
      throw new McpToolError(
        result.status === 404
          ? `No agent named ${handle}. Call gitorange_list_agents to see them.`
          : result.error
      );
    ctx.after(publishChange(ctx.env, repo.id));
    return {
      content: [
        text(
          `@${handle.toLowerCase()} now reviews pull requests in ${fullName}, starting with the next commit pushed.`
        ),
      ],
    };
  },
};

const removeAgentTool: ToolModule = {
  definition: {
    name: 'gitorange_remove_agent',
    title: 'Remove an agent',
    description:
      'Stop a reviewer agent from reviewing a repository: its running reviews there are cancelled and its ' +
      'findings stop counting. Needs admin access to the repository.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      title: 'Remove an agent',
    },
    inputSchema: {
      type: 'object',
      properties: { repository: repositoryProp, handle: handleProp },
      required: ['repository', 'handle'],
    },
  },
  handler: async (args, ctx) => {
    const { repo, fullName } = await administeredRepo(ctx, args, 'remove');
    const handle = str(args, 'handle', true).trim();
    const result = await removeAgent(
      ctx.env,
      ctx.db,
      repo.id,
      handle,
      ctx.user.id,
      (w) => ctx.after(w)
    );
    if (!result.ok)
      throw new McpToolError(
        `No agent named ${handle}. Call gitorange_list_repository_agents to see the ones ${fullName} invited.`
      );
    ctx.after(publishChange(ctx.env, repo.id, { approvals: true }));
    return {
      content: [
        text(`@${handle.toLowerCase()} no longer reviews ${fullName}.`),
      ],
    };
  },
};

const createAgentTool: ToolModule = {
  definition: {
    name: 'gitorange_create_agent',
    title: 'Create a reviewer agent',
    description:
      'Create a reviewer agent (site admins only). It gets a starter AGENT.md in its own repository, ' +
      '<handle>/<handle>: change what it reviews for, its trigger and its knowledge/ by pushing there with git. ' +
      'Then invite it to repositories with gitorange_invite_agent.',
    annotations: { readOnlyHint: false, title: 'Create a reviewer agent' },
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description:
            'Its handle, which is also its username: letters, numbers and single hyphens, up to 39 characters.',
        },
        name: {
          type: 'string',
          description:
            'Display name, e.g. "Security Agent" (up to 100 characters).',
        },
      },
      required: ['handle', 'name'],
    },
  },
  handler: async (args, ctx) => {
    if (ctx.user.role !== 'admin')
      throw new McpToolError('Only a site admin can create agents.');
    const handle = str(args, 'handle', true).trim();
    const name = str(args, 'name', true).trim();
    if (!handle || handle.length > 39)
      throw new McpToolError('handle must be 1 to 39 characters.');
    if (!name || name.length > 100)
      throw new McpToolError('name must be 1 to 100 characters.');
    const result = await createAgent(ctx.env, ctx.db, ctx.user, {
      handle,
      name,
    });
    if (!result.ok) throw new McpToolError(result.error);
    const agent = agentJson(ctx, result.agent);
    return {
      content: [
        json(agent),
        text(
          `Created @${agent.handle}. Its instructions are AGENT.md in ${agent.repository}: ` +
            `git clone ${ctx.baseURL}/${agent.repository}.git, edit AGENT.md (what it reviews for, its trigger ` +
            'question and threshold) and add notes under knowledge/, then push to main. Have the user run the ' +
            'clone themselves so their personal access token never passes through this conversation.'
        ),
      ],
    };
  },
};

export const AGENT_TOOLS: ToolModule[] = [
  listAgentsTool,
  listRepositoryAgents,
  inviteAgentTool,
  removeAgentTool,
  createAgentTool,
];
