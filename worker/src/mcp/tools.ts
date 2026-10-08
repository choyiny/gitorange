import { and, desc, eq, sql } from 'drizzle-orm';
import { attributeCommits } from '../lib/commit-authors';
import {
  pullRequests,
  repositories,
  teams,
  workflowRuns,
} from '../db/app.schema';
import { users } from '../db/auth.schema';
import type { DrizzleDB } from '../db/middleware';
import { createRepository } from '../lib/repo-create';
import { INSIGHT_PERIODS, repoInsights } from '../lib/insights';
import { isMonth, usageReport } from '../usage/report';
import {
  findRepo,
  gitFor,
  permissionsFor,
  permissionsForMany,
  teamNamespace,
  userNamespace,
  visibleTo,
} from '../lib/repos';
import type { SessionUser } from '../variables';
import { McpToolError } from './errors';
import { AGENT_TOOLS } from './agent-tools';
import { PULL_TOOLS } from './pull-tools';
import { MODERATOR_TOOLS } from './moderator-tools';
import type { Moderator } from './moderators';

export type ToolContext = {
  db: DrizzleDB;
  env: CloudflareBindings;
  user: SessionUser;
  baseURL: string;
  /** Runs follow-up work after the response (reviews, Actions, conflict sweeps). */
  after: (work: Promise<unknown>) => void;
  /** This connection as a moderator, read for this call; set only when calling a moderator tool. */
  moderator: Moderator | null;
};
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};
export type ToolModule = {
  definition: {
    name: string;
    title: string;
    description: string;
    annotations: {
      readOnlyHint: boolean;
      destructiveHint?: boolean;
      title: string;
    };
    inputSchema: Record<string, unknown>;
  };
  handler: (
    args: Record<string, unknown>,
    ctx: ToolContext
  ) => Promise<ToolResult>;
};

const text = (t: string) => ({ type: 'text' as const, text: t });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

function optionalString(args: Record<string, unknown>, key: string) {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new McpToolError(`${key} must be a string.`);
  return v;
}
function requireString(args: Record<string, unknown>, key: string) {
  const v = optionalString(args, key);
  if (!v?.trim())
    throw new McpToolError(
      `${key} is required and must be a non-empty string.`
    );
  return v.trim();
}
function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[]
): T | undefined {
  const v = optionalString(args, key);
  if (v === undefined) return undefined;
  if (!(values as readonly string[]).includes(v))
    throw new McpToolError(`${key} must be one of: ${values.join(', ')}.`);
  return v as T;
}
function optionalBoolean(args: Record<string, unknown>, key: string) {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean')
    throw new McpToolError(`${key} must be true or false.`);
  return v;
}

const urls = (baseURL: string, fullName: string) => ({
  web_url: `${baseURL}/${fullName}`,
  clone_url: `${baseURL}/${fullName}.git`,
});

// ── tools ────────────────────────────────────────────────────────────────────

const listRepositories: ToolModule = {
  definition: {
    name: 'gitorange_list_repositories',
    title: 'List repositories',
    description:
      'List the repositories the signed-in user can see on this server, most recently updated first. ' +
      "Returns each repository's full name (owner/name), description, visibility, whether the user can push, " +
      'and its web and clone URLs. Use this first to find a repository for gitorange_get_repository.',
    annotations: { readOnlyHint: true, title: 'List repositories' },
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Optional text to filter by repository or owner name (case-insensitive).',
        },
      },
    },
  },
  handler: async (args, ctx) => {
    const query = optionalString(args, 'query')?.trim().toLowerCase();
    const rows = await ctx.db
      .select({ repo: repositories, owner: users, team: teams })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .leftJoin(teams, eq(teams.id, repositories.teamId))
      .where(visibleTo(ctx.user))
      .orderBy(desc(repositories.updatedAt))
      .limit(200)
      .all();
    const matching = rows
      .map((r) => {
        const ns = r.team ? teamNamespace(r.team) : userNamespace(r.owner);
        return { ...r, ns, fullName: `${ns.username}/${r.repo.name}` };
      })
      .filter((r) => !query || r.fullName.toLowerCase().includes(query));
    // One collaborator lookup for every listed repository, not one per row.
    const perms = await permissionsForMany(
      ctx.db,
      matching.map((r) => r.repo),
      ctx.user
    );
    const out = matching.map(({ repo, ns, fullName }) => ({
      full_name: fullName,
      description: repo.description,
      visibility: repo.visibility,
      owner_type: ns.kind,
      can_push: perms.get(repo.id)!.write,
      default_branch: repo.defaultBranch,
      updated_at: repo.updatedAt.toISOString(),
      ...urls(ctx.baseURL, fullName),
    }));
    if (!out.length)
      return {
        content: [
          text(
            query
              ? `No repositories match "${query}".`
              : 'No repositories yet. Create one with gitorange_create_repository.'
          ),
        ],
      };
    return { content: [json(out)] };
  },
};

const getRepository: ToolModule = {
  definition: {
    name: 'gitorange_get_repository',
    title: 'Get repository',
    description:
      'Get one repository by its full name (owner/name, from gitorange_list_repositories): description, ' +
      'visibility, default branch, protected branch patterns (never rebased by GitOrange), branches, open pull request count, the latest commit on the default ' +
      'branch, the latest Actions run status, and how to clone it.',
    annotations: { readOnlyHint: true, title: 'Get repository' },
    inputSchema: {
      type: 'object',
      properties: {
        repository: {
          type: 'string',
          description: 'Full name, e.g. "ada/analytical-engine".',
        },
      },
      required: ['repository'],
    },
  },
  handler: async (args, ctx) => {
    const fullName = requireString(args, 'repository').replace(/\.git$/, '');
    const [owner, name, ...rest] = fullName.split('/');
    // One answer for "doesn't exist" and "not visible to you", so ids can't be probed.
    const notFound = new McpToolError(
      `No repository named ${fullName}. Call gitorange_list_repositories to see the ones you can access.`
    );
    if (!owner || !name || rest.length) throw notFound;
    const found = await findRepo(ctx.db, owner, name);
    if (!found) throw notFound;
    const perms = await permissionsFor(ctx.db, found.repo, ctx.user);
    if (!perms.read) throw notFound;
    const repo = found.repo;
    const canonical = `${found.namespace.username}/${repo.name}`;
    const git = gitFor(ctx.env, repo);
    const [branches, openPulls, latestRun] = await Promise.all([
      git.branches(),
      ctx.db
        .select({ n: sql<number>`COUNT(*)` })
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repositoryId, repo.id),
            eq(pullRequests.state, 'open')
          )
        )
        .get(),
      ctx.db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.repositoryId, repo.id))
        .orderBy(desc(workflowRuns.runNumber))
        .limit(1)
        .get(),
    ]);
    const head = branches.find((b) => b.name === repo.defaultBranch);
    const raw = head ? await git.commit(head.sha) : null;
    const [commit = null] = raw ? await attributeCommits(ctx.db, [raw]) : [];
    return {
      content: [
        json({
          full_name: canonical,
          description: repo.description,
          visibility: repo.visibility,
          owner_type: found.namespace.kind,
          permissions: perms,
          empty: branches.length === 0,
          default_branch: repo.defaultBranch,
          // Branches GitOrange never rebases, besides the default branch (globs: * within a segment, ** across).
          protected_branches: repo.protectedBranches ?? [],
          branches: branches.map((b) => b.name),
          open_pull_requests: Number(openPulls?.n ?? 0),
          latest_commit: commit
            ? {
                sha: commit.hash,
                message: commit.message.split('\n')[0],
                author: commit.author.name,
                author_username: commit.author.user?.username ?? null,
                committed_at: new Date(commit.committedAt * 1000).toISOString(),
              }
            : null,
          latest_actions_run: latestRun
            ? {
                workflow: latestRun.name,
                run_number: latestRun.runNumber,
                status: latestRun.status,
                conclusion: latestRun.conclusion,
                url: `${ctx.baseURL}/${canonical}/actions/runs/${latestRun.runNumber}`,
              }
            : null,
          ...urls(ctx.baseURL, canonical),
        }),
        text(cloneHelp(ctx.baseURL, canonical)),
      ],
    };
  },
};

/** camelCase keys → snake_case, like the rest of the MCP tools' output. */
function snakeKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(snakeKeys);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        snakeKeys(x),
      ])
    );
  return v;
}

const getRepositoryInsights: ToolModule = {
  definition: {
    name: 'gitorange_get_repository_insights',
    title: 'Get repository insights',
    description:
      "KPIs for one repository's pull requests over the last N days (default 30): opened, merged, how many " +
      'GitOrange auto-merged versus a person merged, how many merged with no person involved, how often the ' +
      'review needed a person (findings by agent, approved, still pending, median time to ' +
      'approval), AI conflict resolution attempts and outcomes, the CI pass rate on pull requests, and median ' +
      'times to merge and to the first green run (in seconds). Use it to see how well agents land changes.',
    annotations: { readOnlyHint: true, title: 'Get repository insights' },
    inputSchema: {
      type: 'object',
      properties: {
        repository: {
          type: 'string',
          description: 'Full name, e.g. "ada/analytical-engine".',
        },
        days: {
          type: 'integer',
          enum: [...INSIGHT_PERIODS],
          description: 'The period, in days, ending now. Defaults to 30.',
        },
      },
      required: ['repository'],
    },
  },
  handler: async (args, ctx) => {
    const fullName = requireString(args, 'repository').replace(/\.git$/, '');
    const days = args.days ?? 30;
    if (!(INSIGHT_PERIODS as readonly unknown[]).includes(days))
      throw new McpToolError(
        `days must be one of: ${INSIGHT_PERIODS.join(', ')}.`
      );
    const [owner, name, ...rest] = fullName.split('/');
    // One answer for "doesn't exist" and "not visible to you", so ids can't be probed.
    const notFound = new McpToolError(
      `No repository named ${fullName}. Call gitorange_list_repositories to see the ones you can access.`
    );
    if (!owner || !name || rest.length) throw notFound;
    const found = await findRepo(ctx.db, owner, name);
    if (!found) throw notFound;
    const perms = await permissionsFor(ctx.db, found.repo, ctx.user);
    if (!perms.read) throw notFound;
    const canonical = `${found.namespace.username}/${found.repo.name}`;
    const insights = await repoInsights(
      ctx.env,
      ctx.db,
      found.repo,
      days as number
    );
    return {
      content: [
        json({
          full_name: canonical,
          ...(snakeKeys(insights) as object),
          web_url: `${ctx.baseURL}/${canonical}/insights?days=${days}`,
        }),
      ],
    };
  },
};

const getUsage: ToolModule = {
  definition: {
    name: 'gitorange_get_usage',
    title: 'Get usage and cost',
    description:
      "Site admins only. This GitOrange deployment's Cloudflare usage and estimated cost for a calendar month " +
      '(UTC, default the current one): per product and metric, the cost at list price, the cost if GitOrange had ' +
      "the account's included allowances to itself, and a projection to month end; Actions runner minutes and " +
      'cost by repository; Workers AI cost by feature. Figures are estimates from Cloudflare analytics and ' +
      "GitOrange's own records, not an invoice. Lines that could not be measured say why.",
    annotations: { readOnlyHint: true, title: 'Get usage and cost' },
    inputSchema: {
      type: 'object',
      properties: {
        month: {
          type: 'string',
          description: 'YYYY-MM. Defaults to the current month.',
        },
      },
    },
  },
  handler: async (args, ctx) => {
    if (ctx.user.role !== 'admin')
      throw new McpToolError('Only site admins can see usage and cost.');
    const month =
      optionalString(args, 'month') ?? new Date().toISOString().slice(0, 7);
    if (!isMonth(month)) throw new McpToolError('month must be YYYY-MM.');
    const r = await usageReport(ctx.db, ctx.env, month);
    return {
      content: [
        json({
          month: r.month,
          estimate_note:
            'Estimates, not an invoice. Included allowances and the plan fee are per Cloudflare account, shared with anything else on it.',
          cloudflare_analytics_configured: r.analyticsConfigured,
          last_sync: r.lastSync,
          totals_usd: snakeKeys(r.totals),
          plan_fee_usd_account_wide: r.prices.planFee,
          prices_checked_on: r.prices.checkedOn,
          lines: r.lines.map((l) => ({
            product: l.productLabel,
            metric: l.label,
            unit: l.unit,
            quantity: l.quantity,
            included_account_wide: l.includedLabel,
            list_cost_usd: l.listCost,
            dedicated_cost_usd: l.dedicatedCost,
            projected_list_cost_usd: l.projectedListCost,
            status: l.status,
            source: l.source,
            ...(l.reason ? { reason: l.reason } : {}),
            ...(l.note ? { note: l.note } : {}),
          })),
          actions: snakeKeys(r.actions),
          workers_ai: snakeKeys(r.ai),
          ai_gateway_whole_gateway: r.gateway && snakeKeys(r.gateway),
          not_measured: r.notMeasured,
          web_url: `${ctx.baseURL}/admin/usage?month=${r.month}`,
        }),
      ],
    };
  },
};

function cloneHelp(baseURL: string, fullName: string) {
  return (
    `To work on it locally: git clone ${baseURL}/${fullName}.git\n` +
    `Git asks for a username (the user's username on this server) and a password: a personal access token ` +
    `the user creates at ${baseURL}/settings/tokens. Have the user run the clone themselves so the token ` +
    `never passes through this conversation.`
  );
}

const createRepositoryTool: ToolModule = {
  definition: {
    name: 'gitorange_create_repository',
    title: 'Create repository',
    description:
      'Create a new repository owned by the signed-in user (or by the shared team). Personal repositories ' +
      "are private by default; team repositories are visible to every member. Returns the new repository's " +
      'full name and its web and clone URLs, plus how to push to it.',
    annotations: { readOnlyHint: false, title: 'Create repository' },
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Repository name: letters, numbers, ".", "-" and "_" (other characters become "-").',
        },
        description: {
          type: 'string',
          description: 'Optional one-line description (up to 350 characters).',
        },
        owner: {
          type: 'string',
          enum: ['user', 'team'],
          description:
            '"user" (default) for a personal repository, or "team" for the shared team.',
        },
        visibility: {
          type: 'string',
          enum: ['private', 'internal'],
          description:
            'Personal repositories only. "private" (default): only the owner, collaborators, and site admins. ' +
            '"internal": every member can read it.',
        },
        add_readme: {
          type: 'boolean',
          description:
            'Start with a README.md commit on main, so it can be cloned right away. Defaults to false.',
        },
      },
      required: ['name'],
    },
  },
  handler: async (args, ctx) => {
    const name = requireString(args, 'name');
    const description = optionalString(args, 'description');
    if (description && description.length > 350)
      throw new McpToolError('description must be 350 characters or fewer.');
    if (name.length > 100)
      throw new McpToolError('name must be 100 characters or fewer.');
    const result = await createRepository(ctx.env, ctx.db, ctx.user, {
      name,
      description,
      owner: optionalEnum(args, 'owner', ['user', 'team'] as const),
      visibility: optionalEnum(args, 'visibility', [
        'private',
        'internal',
      ] as const),
      addReadme: optionalBoolean(args, 'add_readme') ?? false,
    });
    if (!result.ok) throw new McpToolError(result.error);
    const fullName = `${result.namespace.username}/${result.repo.name}`;
    return {
      content: [
        json({
          full_name: fullName,
          visibility: result.repo.visibility,
          owner_type: result.namespace.kind,
          default_branch: result.repo.defaultBranch,
          ...urls(ctx.baseURL, fullName),
        }),
        text(
          `Created ${fullName}.\n` +
            `To push an existing project: git remote add origin ${ctx.baseURL}/${fullName}.git && git push -u origin main\n` +
            cloneHelp(ctx.baseURL, fullName)
        ),
      ],
    };
  },
};

export const TOOL_MODULES: ToolModule[] = [
  listRepositories,
  getRepository,
  getRepositoryInsights,
  createRepositoryTool,
  getUsage,
  ...PULL_TOOLS,
  ...AGENT_TOOLS,
];
export const TOOL_DEFINITIONS = TOOL_MODULES.map((m) => m.definition);
/** Only for moderator connections: listed and callable after index.ts reads the moderator row on that call. */
export const MODERATOR_TOOL_DEFINITIONS = MODERATOR_TOOLS.map(
  (m) => m.definition
);
export const MODERATOR_TOOL_NAMES = new Set(
  MODERATOR_TOOL_DEFINITIONS.map((d) => d.name)
);
export const TOOL_HANDLERS = new Map(
  [...TOOL_MODULES, ...MODERATOR_TOOLS].map((m) => [m.definition.name, m])
);
