import type { WorkflowStepConfig } from 'cloudflare:workers';
import type { FileSummary } from '../db/app.schema';
import type { FileChange, FileDiff, GitService } from '../git/service';
import { IGNORE_PATH, isLockfile } from './ignore';
import { mermaidSource, type Investigation, type ReviewModels } from './models';

/** Diff text sent to summarize one file; a larger file is flagged instead. */
export const MAX_SUMMARY_DIFF = 200 * 1024;
/** Diff text sent to investigate one flag; the rest is listed but left out. */
const MAX_INVESTIGATE_DIFF = 120 * 1024;
/** One file's share of that: a huge file shows its start and is listed as cut. */
const MAX_INVESTIGATE_FILE = 24 * 1024;
/** Files summarized at once. */
export const SUMMARY_BATCH = 8;

export const MODEL_RETRIES: WorkflowStepConfig = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
};

/** Newlines would let text pose as a prompt line of its own. */
export const oneLine = (t: string) => t.replace(/\s*[\r\n]+\s*/g, ' ');

/** The one-liners as models read them: `- path (status): summary`, one file a line. */
export function summaryLines(
  files: Pick<FileSummary, 'path' | 'status' | 'summary'>[]
): string {
  return files
    .map((f) => `- ${oneLine(f.path)} (${f.status}): ${oneLine(f.summary)}`)
    .join('\n');
}

/** A file's diff as unified-diff text. */
export function renderDiff(d: FileDiff): string {
  return d.hunks
    .map(
      (h) =>
        `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`
    )
    .join('\n');
}

/** One diff line with the line number it has in the file (new side; old side for removals). */
type NumberedLine = { kind: ' ' | '+' | '-'; n: number; text: string };

function numberedLines(d: FileDiff): NumberedLine[][] {
  return d.hunks.map((h) => {
    let oldN = h.oldStart;
    let newN = h.newStart;
    const out: NumberedLine[] = [];
    for (const l of h.lines) {
      const kind = l[0] as NumberedLine['kind'];
      if (kind === '-') out.push({ kind, n: oldN++, text: l.slice(1) });
      else if (kind === '+') out.push({ kind, n: newN++, text: l.slice(1) });
      else if (kind === ' ') {
        // Context lines exist on both sides.
        oldN++;
        out.push({ kind, n: newN++, text: l.slice(1) });
      }
    }
    return out;
  });
}

/** Diff with line numbers: new-file for added/context lines, old-file ("old") for removals. */
export function renderNumberedDiff(d: FileDiff): string {
  return numberedLines(d)
    .map((hunk) =>
      hunk
        .map((l) =>
          l.kind === '-'
            ? `-${String(l.n).padStart(5)} old | ${l.text}`
            : `${l.kind}${String(l.n).padStart(5)}     | ${l.text}`
        )
        .join('\n')
    )
    .join('\n...\n');
}

const MAX_SNIPPET_LINES = 30;

/** The diff lines a snippet points at: new-side lines in range, and removals between them. */
export function snippetLines(
  d: FileDiff,
  start: number,
  end: number
): string | null {
  if (end < start) [start, end] = [end, start];
  end = Math.min(end, start + MAX_SNIPPET_LINES - 1);
  const removedFile = d.status === 'removed';
  const picked: string[] = [];
  for (const hunk of numberedLines(d)) {
    // Keep removals bordering the range so an excerpt shows what a change replaced.
    let prevIn = false;
    let held: string[] = [];
    for (const l of hunk) {
      const numbered = removedFile ? l.kind === '-' : l.kind !== '-';
      if (!numbered) {
        held.push(`${l.kind}${l.text}`);
        continue;
      }
      const inRange = l.n >= start && l.n <= end;
      if (inRange || prevIn) picked.push(...held);
      held = [];
      if (inRange) picked.push(`${l.kind}${l.text}`);
      prevIn = inRange;
    }
    if (prevIn) picked.push(...held);
  }
  return picked.length ? picked.join('\n') : null;
}

const escapeHtml = (t: string) =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Text for one Markdown table cell. */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

/** A finding's or flag's comment body. Excerpts come from the real diff, never from model output. */
export async function composeDetail(
  git: GitService,
  changes: FileChange[],
  out: Pick<Investigation, 'detail' | 'changes' | 'diagram' | 'snippets'>,
  ignored: (path: string) => boolean
): Promise<string> {
  const parts = [out.detail];
  if (out.changes?.length)
    parts.push(
      [
        '| | Before | After |',
        '|---|---|---|',
        ...out.changes.map(
          (c) =>
            `| **${cell(c.what)}** | ${cell(c.before) || '—'} | ${cell(c.after) || '—'} |`
        ),
      ].join('\n')
    );
  const diagram = out.diagram && mermaidSource(out.diagram);
  if (diagram) parts.push('```mermaid\n' + diagram + '\n```');
  for (const s of out.snippets) {
    const ch = changes.find((c) => c.path === s.path);
    if (!ch || ignored(ch.path)) continue;
    const [d] = await git.fileDiffs([ch]);
    if (d.binary || d.tooLarge) continue;
    const lines = snippetLines(d, s.start, s.end);
    if (!lines) continue;
    const fence = lines.includes('```') ? '~~~~' : '```';
    parts.push(
      `<details><summary><code>${escapeHtml(s.path)}</code> lines ${s.start}–${s.end}${
        s.why ? `: ${escapeHtml(s.why)}` : ''
      }</summary>\n\n${fence}diff\n${lines}\n${fence}\n\n</details>`
    );
  }
  return parts.join('\n\n');
}

export type Summarized = FileSummary & { unsummarized?: boolean };

/** One file's one-liner: fixed text where a model can't say more, otherwise the summary model. */
export async function summarizeFile(
  git: GitService,
  summarize: ReviewModels['summarize'],
  ch: FileChange,
  ignored: (path: string) => boolean
): Promise<Summarized> {
  const base = {
    path: ch.path,
    status: ch.status,
    additions: 0,
    deletions: 0,
  };
  if (ch.mode === '160000')
    return { ...base, summary: 'Submodule pointer updated.' };
  const [d] = await git.fileDiffs([ch]);
  const counts = { additions: d.additions, deletions: d.deletions };
  if (isLockfile(ch.path))
    return { ...base, ...counts, summary: 'Dependency lockfile updated.' };
  if (ignored(ch.path))
    return {
      ...base,
      ...counts,
      summary: `Changed; ignored by ${IGNORE_PATH}.`,
    };
  if (d.binary) return { ...base, summary: `Binary file ${ch.status}.` };
  const diff = renderDiff(d);
  if (d.tooLarge || diff.length > MAX_SUMMARY_DIFF)
    return {
      ...base,
      ...counts,
      summary: 'Too large to summarize.',
      unsummarized: true,
    };
  const summary = await summarize({
    path: ch.path,
    status: ch.status,
    ...counts,
    diff,
  });
  return { ...base, ...counts, summary };
}

/** Source before tests, docs, and config: what a reviewer would read first. */
function readingOrder(path: string): number {
  if (/(^|\/)(__tests__|test|tests)\/|\.test\.[jt]sx?$/.test(path)) return 2;
  if (/\.(md|mdx|txt)$/i.test(path) || path.startsWith('docs/')) return 3;
  return 1;
}

/**
 * Diffs for the investigating model within a budget: the flag's files first, then source, tests,
 * docs. Ignored files are left out, each file is capped, and the overflow is listed by name.
 */
export async function diffsFor(
  git: GitService,
  changes: FileChange[],
  first: string[],
  /** Lockfiles and files matched by `.orangeignore`: named, never shown. */
  ignored: (path: string) => boolean,
  /** Read only `first` (the files picked as relevant); list the rest by name. */
  only = false
): Promise<string> {
  const skipped: string[] = [];
  const unpicked: string[] = [];
  const order = changes
    .filter((c) => {
      const noise = ignored(c.path);
      if (noise) skipped.push(c.path);
      else if (only && !first.includes(c.path)) unpicked.push(c.path);
      return !noise && !(only && !first.includes(c.path));
    })
    .sort(
      (a, b) =>
        Number(!first.includes(a.path)) - Number(!first.includes(b.path)) ||
        readingOrder(a.path) - readingOrder(b.path)
    );
  let out = '';
  const left: string[] = [];
  for (const ch of order) {
    if (out.length >= MAX_INVESTIGATE_DIFF) {
      left.push(ch.path);
      continue;
    }
    const [d] = await git.fileDiffs([ch]);
    let body =
      d.binary || d.tooLarge
        ? '(binary or too large to show)'
        : renderNumberedDiff(d) || '(no textual change)';
    if (body.length > MAX_INVESTIGATE_FILE)
      body = `${body.slice(0, MAX_INVESTIGATE_FILE)}\n… (the rest of this file's diff is not shown)`;
    const block = `--- ${oneLine(ch.path)} (${ch.status})\n${body}\n\n`;
    if (out.length + block.length > MAX_INVESTIGATE_DIFF) left.push(ch.path);
    else out += block;
  }
  const notes = [
    unpicked.length &&
      `Not shown (judged unrelated to this flag from their summaries): ${unpicked.map(oneLine).join(', ')}`,
    skipped.length &&
      `Ignored (lockfiles and ${IGNORE_PATH}), not shown: ${skipped.map(oneLine).join(', ')}`,
    left.length &&
      `Not shown (over the size budget): ${left.map(oneLine).join(', ')}`,
  ].filter(Boolean);
  return notes.length ? `${out}${notes.join('\n')}` : out;
}
