/** Pure helpers for the code browser: paths, line selection in a file, front matter. */

/** The lines a `#L12` or `#L12-L20` fragment selects (1-based, `start <= end`). */
export interface LineRange {
  start: number;
  end: number;
}

export function parseLineHash(hash: string): LineRange | null {
  const m = /^#L(\d+)(?:-L(\d+))?$/.exec(hash);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  if (a < 1 || b < 1) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** The fragment after clicking a line number: that line, or with Shift a range from the selected line. */
export function nextLineHash(
  current: LineRange | null,
  line: number,
  shift: boolean
): string {
  if (!shift || !current) return `#L${line}`;
  const [from, to] = [current.start, line].sort((a, b) => a - b);
  return from === to ? `#L${from}` : `#L${from}-L${to}`;
}

export const inLineRange = (range: LineRange | null, n: number) =>
  !!range && n >= range.start && n <= range.end;

/** A file's text as lines; the empty line after a final newline is not a line. */
export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** A repository path as URL segments: `a b/c#d` → `a%20b/c%23d` (a name may hold `#`, `?` or `%`). */
export const encodeRepoPath = (path: string) =>
  path.split('/').map(encodeURIComponent).join('/');

export interface PathCrumb {
  label: string;
  /** Where the segment links; null for the last one (the page itself). */
  to: string | null;
}

/** A path inside the repository as links down from its root: `src / lib / a.ts`. */
export function pathCrumbs(
  base: string,
  ref: string,
  path: string
): PathCrumb[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((label, i) => ({
    label,
    to:
      i === parts.length - 1
        ? null
        : `${base}/tree/${ref}/${encodeRepoPath(parts.slice(0, i + 1).join('/'))}`,
  }));
}

export const parentPath = (path: string) =>
  path.split('/').slice(0, -1).join('/');

export const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path);

// The first line of real front matter is a `key:` straight after the opening `---`. A README that opens with a
// horizontal rule (and has another one further down) starts with a blank line or prose instead.
const FIRST_KEY = /^(?:[A-Za-z_][\w.-]*|"[^"\n]*"|'[^'\n]*')[ \t]*:(?:[ \t]|$)/;

/**
 * A leading `---` YAML block and the text after it. An agent's AGENT.md starts with its settings this way. It needs
 * a closing `---` line and must begin with a `key:`, so a horizontal rule is not mistaken for one.
 */
export function splitFrontmatter(text: string): {
  frontmatter: string | null;
  body: string;
} {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m || !FIRST_KEY.test(m[1])) return { frontmatter: null, body: text };
  return {
    frontmatter: m[1].replace(/\r/g, ''),
    body: text.slice(m[0].length).replace(/^(?:[ \t]*\r?\n)+/, ''),
  };
}
