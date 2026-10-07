/**
 * What a learned edit may change, and the Worker's check of it before anything is committed. Pure: the learn-mode
 * Durable Object's tool guard (learn/contract.ts) uses the same rules.
 */
import { diffLines } from 'diff';
import {
  AGENT_PATH,
  AgentConfigError,
  agentFrontMatter,
  parseAgentConfig,
} from '../agents/config';
import { encoder } from '../git/bytes';

export const KNOWLEDGE_DIR = 'knowledge';
/** One file, after the edit. */
export const MAX_LESSON_FILE_BYTES = 64 * 1024;
/** The whole edit: bytes of the lines added plus the lines removed. */
export const MAX_LESSON_CHANGE_BYTES = 20 * 1024;

export const FRONT_MATTER_CHANGED = `The edit changed ${AGENT_PATH}'s front matter; only the instructions below it may change.`;

/** Code points HFS+ ignores in names (git's verify_path), so `.g\u200Cit` would be `.git` there. */
const HFS_IGNORABLE = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/;

/**
 * A name some filesystem reads as `.git`, as git's verify_path refuses: any case, trailing dots or spaces (Windows
 * drops them), or the NTFS short name `git~1` (any `git~…`).
 */
const isGitName = (s: string) => {
  const t = s.toLowerCase().replace(/[. ]+$/, '');
  return t === '.git' || t.startsWith('git~');
};

/** A path segment a learned edit may use: not empty, `.`, `..`, a `.git` lookalike, or with `\`, NUL or an HFS+-ignorable code point. */
const safeSegment = (s: string) =>
  s !== '' &&
  s !== '.' &&
  s !== '..' &&
  !/[\\\0]/.test(s) &&
  !HFS_IGNORABLE.test(s) &&
  !isGitName(s);

/** AGENT.md, or a file under knowledge/ (repository-relative, every segment `safeSegment`). */
export function isLearnablePath(path: string): boolean {
  if (path === AGENT_PATH) return true;
  const parts = path.split('/');
  return (
    parts.length >= 2 && parts[0] === KNOWLEDGE_DIR && parts.every(safeSegment)
  );
}

export const utf8Bytes = (s: string) => encoder.encode(s).length;

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Text that encodes as UTF-8 and isn't binary: no NUL, no lone surrogate. */
export const isText = (s: string) =>
  !s.includes('\0') && !LONE_SURROGATE.test(s);

/** UTF-8 bytes of the lines `after` adds to `before` plus the lines it removes (null: no file). */
export function changeBytes(
  before: string | null,
  after: string | null
): number {
  let n = 0;
  for (const part of diffLines(before ?? '', after ?? ''))
    if (part.added || part.removed) n += utf8Bytes(part.value);
  return n;
}

export type LearnedEdit =
  | { ok: true; changes: Record<string, string | null> }
  | { ok: false; error: string };

const fail = (error: string): LearnedEdit => ({ ok: false, error });

/**
 * Checks a learned edit against the files at its base commit (`base[path]`: the content there, null when absent;
 * AGENT.md always given; a file that isn't UTF-8 text comes as a string that fails `isText`, see `contentsAt`).
 * Drops files written back unchanged; refuses paths outside AGENT.md and knowledge/, one path inside another, deleting
 * AGENT.md, changing an
 * existing binary file (the learner never saw it), binary or oversize files, an edit over MAX_LESSON_CHANGE_BYTES, an
 * AGENT.md that no longer parses, and any change to its front matter (byte-for-byte). `changes` empty: nothing to
 * commit.
 */
export function validateLearned(
  base: Record<string, string | null>,
  files: Record<string, string | null>
): LearnedEdit {
  const changes: Record<string, string | null> = {};
  for (const [path, content] of Object.entries(files))
    if (content !== (base[path] ?? null)) changes[path] = content;
  const paths = Object.keys(changes).sort();
  for (const path of paths)
    if (!isLearnablePath(path))
      return fail(
        `The edit changed ${path}: only ${AGENT_PATH} and ${KNOWLEDGE_DIR}/ may change.`
      );
  for (const path of paths) {
    const inside = paths.find((p) => p.startsWith(`${path}/`));
    if (inside)
      return fail(
        `The edit writes ${path} both as a file and as a directory (${inside}).`
      );
  }
  if (AGENT_PATH in changes && changes[AGENT_PATH] === null)
    return fail(`The edit deleted ${AGENT_PATH}.`);
  let total = 0;
  for (const path of paths) {
    const before = base[path] ?? null;
    if (before !== null && !isText(before))
      return fail(`${path} is not UTF-8 text; the edit may not change it.`);
    const text = changes[path];
    if (text !== null) {
      if (!isText(text)) return fail(`${path} is not UTF-8 text.`);
      if (utf8Bytes(text) > MAX_LESSON_FILE_BYTES)
        return fail(`${path} is larger than 64 KB.`);
    }
    total += changeBytes(before, text);
  }
  if (total > MAX_LESSON_CHANGE_BYTES)
    return fail(
      `The edit changes ${total.toLocaleString('en-US')} bytes; at most 20 KB may change at once.`
    );
  const md = changes[AGENT_PATH];
  if (typeof md === 'string') {
    try {
      parseAgentConfig(md);
    } catch (e) {
      if (e instanceof AgentConfigError)
        return fail(`${AGENT_PATH} no longer parses: ${e.message}`);
      throw e;
    }
    if (agentFrontMatter(md) !== agentFrontMatter(base[AGENT_PATH] ?? ''))
      return fail(FRONT_MATTER_CHANGED);
  }
  return { ok: true, changes };
}
