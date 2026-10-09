import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { agentFacets, type Facet } from '../db/app.schema';
import { decoder } from '../git/bytes';
import type { GitService } from '../git/service';

/** Who an agent is and how it reviews, at the root of its repository. */
export const AGENT_PATH = 'AGENT.md';
/** Its profile picture; without it the generated avatar is shown. */
export const AVATAR_PATH = 'avatar.png';
export const MAX_AGENT_MD = 64 * 1024;

export type AgentEngine = 'pass' | 'pi';

export interface AgentConfig {
  name: string;
  bio: string;
  trigger: { ask: string; above: number };
  engine: AgentEngine;
  /** Its colour across GitOrange, `#rrggbb` (lowercase); absent ⇒ a stable one from the palette (agentColor). */
  color?: string;
  /** What it covers; the seven named facets are presets (presets.ts). */
  facet?: Facet;
  /** Its findings are never approved in bulk, by one key or by AI, and approving one needs a reason (isGuarded). */
  guarded?: boolean;
  /** The Markdown body: what the agent cares about and how it judges. */
  instructions: string;
}

export class AgentConfigError extends Error {}

const BETWEEN = 'must be between 0 and 1 (exclusive)';
const COLOR = 'must be a colour like "#2a78d6"';
const FACETS = `must be one of ${agentFacets.slice(0, -1).join(', ')} or ${agentFacets.at(-1)}`;

// Strict: a typo such as `treshold` is an error, not a silently ignored key.
const frontmatter = z
  .object({
    name: z.string().trim().min(1).max(100),
    bio: z.string().trim().max(300).default(''),
    trigger: z
      .object({
        ask: z.string().trim().min(1).max(500),
        // Clef's probability that the question applies, at or above which the agent reviews.
        above: z
          .number()
          .gt(0, { message: BETWEEN })
          .lt(1, { message: BETWEEN }),
      })
      .strict(),
    engine: z
      .enum(['pass', 'pi'], { message: 'must be pass or pi' })
      .default('pass'),
    color: z
      .string({
        // YAML reads an unquoted # as the start of a comment, which leaves the value empty.
        message: `${COLOR}, in quotes (an unquoted # starts a YAML comment)`,
      })
      .regex(/^#[0-9a-fA-F]{6}$/, { message: COLOR })
      .transform((c) => c.toLowerCase())
      .optional(),
    facet: z.enum(agentFacets, { message: FACETS }).optional(),
    guarded: z.boolean({ message: 'must be true or false' }).optional(),
  })
  .strict();

const FRONTMATTER =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/** Parses AGENT.md, throwing AgentConfigError with a message fit to show on the agent's profile. */
export function parseAgentConfig(source: string): AgentConfig {
  const match = FRONTMATTER.exec(source.replace(/^﻿/, ''));
  if (!match)
    throw new AgentConfigError(
      `${AGENT_PATH} must start with YAML frontmatter between --- lines.`
    );
  let raw: unknown;
  try {
    raw = parseYaml(match[1]);
  } catch (e) {
    throw new AgentConfigError(
      `${AGENT_PATH} frontmatter is not valid YAML: ${e instanceof Error ? e.message : e}`
    );
  }
  const parsed = frontmatter.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.join('.');
    throw new AgentConfigError(
      `${AGENT_PATH}: ${where ? `${where}: ` : ''}${issue.message}`
    );
  }
  const instructions = match[2].trim();
  if (!instructions)
    throw new AgentConfigError(
      `${AGENT_PATH} has no instructions below the frontmatter.`
    );
  return { ...parsed.data, instructions };
}

/**
 * AGENT.md's front matter exactly as written: from the start of the file through the closing `---` line (and its line
 * break), a leading byte-order mark included. Null without one. A learned edit must leave it byte-for-byte unchanged.
 */
export function agentFrontMatter(source: string): string | null {
  const match = FRONTMATTER.exec(source.replace(/^﻿/, ''));
  return match ? source.slice(0, source.length - match[2].length) : null;
}

/** AGENT.md at a commit, parsed; never throws for a missing or invalid file. */
export async function readAgentConfig(
  git: GitService,
  sha: string
): Promise<{ ok: true; config: AgentConfig } | { ok: false; error: string }> {
  const entry = await git.entryAt(sha, AGENT_PATH);
  if (entry?.type !== 'blob')
    return { ok: false, error: `${AGENT_PATH} is missing.` };
  const blob = await (await git.client.repo()).readBlob(entry.entry.hash);
  if (!blob) return { ok: false, error: `${AGENT_PATH} could not be read.` };
  // The size comes with the Blob; an oversized file is refused before its bytes are loaded.
  if (blob.size > MAX_AGENT_MD)
    return { ok: false, error: `${AGENT_PATH} is larger than 64 KB.` };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    return { ok: true, config: parseAgentConfig(decoder.decode(bytes)) };
  } catch (e) {
    if (e instanceof AgentConfigError) return { ok: false, error: e.message };
    throw e;
  }
}
