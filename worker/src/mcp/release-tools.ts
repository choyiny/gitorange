import { cutRelease, listReleases, unreleased } from '../lib/releases';
import { publishChange } from '../live/publish';
import { McpToolError } from './errors';
import { appName } from './moderators';
import { repoFor, repositoryProp, str, text } from './pull-tools';
import type { ToolModule } from './tools';

const json = (v: unknown) => text(JSON.stringify(v, null, 2));

const listReleasesTool: ToolModule = {
  definition: {
    name: 'gitorange_list_releases',
    title: 'List releases',
    description:
      "List a repository's releases (newest version first, each with its tag, title, when it was cut and the pull request numbers it shipped) and what is unreleased: the pull requests merged into the default branch since the latest release, the version they would make (next; null for a first release, which needs a typed version) and the default branch head. " +
      'Call it before gitorange_create_release and pass its head as head_sha.',
    annotations: { readOnlyHint: true, title: 'List releases' },
    inputSchema: {
      type: 'object',
      properties: { repository: repositoryProp },
      required: ['repository'],
    },
  },
  handler: async (args, ctx) => {
    const { repo, git, fullName } = await repoFor(ctx, args);
    const [u, list, refs] = await Promise.all([
      unreleased(ctx.db, repo, ctx.baseURL, fullName),
      listReleases(ctx.db, repo),
      git.refs(),
    ]);
    return {
      content: [
        json({
          unreleased: {
            pulls: u.pulls.map((p) => ({
              number: p.number,
              title: p.title,
              author: p.author,
              bump: p.bump ?? 'patch (default)',
            })),
            latest: u.latest?.tag ?? null,
            next: u.next,
            head: refs.get(`refs/heads/${repo.defaultBranch}`) ?? null,
          },
          releases: list.map((r) => ({
            tag: r.tag,
            title: r.title,
            created_at: new Date(r.createdAt * 1000).toISOString(),
            pulls: r.pulls.map((p) => p.number),
          })),
        }),
      ],
    };
  },
};

const createRelease: ToolModule = {
  definition: {
    name: 'gitorange_create_release',
    title: 'Create release',
    description:
      'Cut a release: tag the default branch head with the next semantic version (vX.Y.Z) and record the pull requests it ships. ' +
      'Call gitorange_list_releases first and pass the head it returned as head_sha; if the branch moved since, this is refused with the new head so you can check what it adds. ' +
      'The version is computed from the largest bump of the unreleased pull requests; the first release needs version (for example v0.1.0). ' +
      'A release is permanent: it cannot be deleted or its tag moved. Needs push access.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      title: 'Create release',
    },
    inputSchema: {
      type: 'object',
      properties: {
        repository: repositoryProp,
        head_sha: {
          type: 'string',
          description:
            'The default branch head you checked, from gitorange_list_releases.',
        },
        version: {
          type: 'string',
          description:
            'Optional override like "v1.4.0", after the latest release. Required for the first release.',
        },
        title: {
          type: 'string',
          description: 'Optional; defaults to the tag.',
        },
        notes: {
          type: 'string',
          description:
            'Optional Markdown release notes; defaults to the generated changelog.',
        },
      },
      required: ['repository', 'head_sha'],
    },
  },
  handler: async (args, ctx) => {
    const { repo, fullName, perms } = await repoFor(ctx, args);
    if (!perms.write)
      throw new McpToolError(
        `You don't have push access to ${fullName}, so you can't cut a release.`
      );
    const result = await cutRelease({
      env: ctx.env,
      db: ctx.db,
      repo,
      repoFullName: fullName,
      origin: ctx.baseURL,
      actor: {
        id: ctx.user.id,
        via: ctx.clientId ? await appName(ctx.db, ctx.clientId) : null,
      },
      headSha: str(args, 'head_sha', true).trim(),
      version: str(args, 'version'),
      title: str(args, 'title'),
      notes: str(args, 'notes'),
    });
    if (!result.ok)
      throw new McpToolError(
        result.status === 409 && result.head
          ? `${result.message}. The head is now ${result.head}: call gitorange_list_releases and cut with that head_sha.`
          : result.message
      );
    ctx.after(publishChange(ctx.env, repo.id));
    return {
      content: [
        json({
          tag: result.release.tag,
          title: result.release.title,
          commit: result.release.commitSha,
          pulls: result.release.pulls.map((p) => p.number),
          url: `${ctx.baseURL}/${fullName}/releases/${result.release.tag}`,
        }),
      ],
    };
  },
};

export const RELEASE_TOOLS: ToolModule[] = [listReleasesTool, createRelease];
