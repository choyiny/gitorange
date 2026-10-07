/** Committing a learned edit to the agent's repository: the message, and compare-and-swap with one retry. */
import { AGENT_PATH } from '../agents/config';
import type { Signature } from '../git/objects';
import { GitPushError } from '../git/remote';
import type { GitService } from '../git/service';
import { validateLearned } from './validate';

/** One trailer per dismissed finding: `Dismissed-Finding: <pr_review_flags.id>`. */
export const LESSON_TRAILER = 'Dismissed-Finding';

export const branchMoved = (branch: string) =>
  `${branch} kept moving while the edit was being committed; nothing was committed.`;

export type LearnedCommit =
  | { status: 'committed'; sha: string }
  | { status: 'nothing' }
  | { status: 'failed'; error: string };

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * The summary, then `Learned from #N (owner/repo): dismissed "<title>", …`, then one trailer per finding. From a
 * private repository (`private`; agent repositories are readable by every member) only the summary and the trailers.
 */
export function lessonCommitMessage(m: {
  summary: string;
  number: number;
  repository: string;
  /** The pull request's title: redacted from a private lesson's summary. */
  pullTitle?: string;
  titles: string[];
  findingIds: string[];
  private: boolean;
}): string {
  const said = m.summary.trim() || 'Learned from dismissed change requests.';
  const summary = m.private
    ? redactPrivate(
        said,
        [
          m.repository,
          m.repository.split('/')[1] ?? '',
          m.pullTitle ?? '',
          ...m.titles,
        ],
        m.number
      )
    : said;
  const trailers = m.findingIds
    .map((id) => `${LESSON_TRAILER}: ${id}`)
    .join('\n');
  if (m.private) return `${summary}\n\n${trailers}`;
  const titles = m.titles.map((t) => `"${oneLine(t, 80)}"`).join(', ');
  return `${summary}\n\nLearned from #${m.number} (${m.repository}): dismissed ${titles}\n\n${trailers}`;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A private lesson's summary without what names its pull request: the repository, the pull request's title and the
 * findings' titles (whole, case-insensitive; names under 3 characters are left, they'd match ordinary words), and
 * `#<number>`. The learner is told not to write them; this doesn't rely on it.
 */
export function redactPrivate(
  summary: string,
  names: string[],
  number: number
): string {
  let out = summary;
  for (const name of [...new Set(names.map((n) => n.trim()))]
    .filter((n) => n.length >= 3)
    .sort((a, b) => b.length - a.length))
    out = out.replace(
      new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`, 'gi'),
      '[private]'
    );
  return out.replace(new RegExp(`#${number}(?!\\d)`, 'g'), '#[private]');
}

// Byte-exact: a byte-order mark is kept (the front matter check compares it), and invalid UTF-8 is detected.
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const lossy = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

/**
 * Each path's text at commit `sha`; null where it is absent (or not a file). A file that isn't valid UTF-8 comes back
 * with a NUL in it, so `isText` fails and `validateLearned` refuses to change it.
 */
export async function contentsAt(
  git: GitService,
  sha: string,
  paths: string[]
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const path of new Set(paths)) {
    const entry = await git.entryAt(sha, path);
    const bytes =
      entry?.type === 'blob' ? await git.blob(entry.entry.hash) : null;
    if (!bytes) {
      out[path] = null;
      continue;
    }
    try {
      out[path] = strict.decode(bytes);
    } catch {
      out[path] = `\0${lossy.decode(bytes)}`;
    }
  }
  return out;
}

const REGULAR = new Set(['100644', '100755']);

/**
 * Why `paths` can't be written as files at commit `sha`, or null: each must be absent or a regular file (never a
 * directory, symlink or submodule, whose contents the edit would drop unchecked), and no directory on its way may be a
 * file.
 */
export async function shapeConflict(
  git: GitService,
  sha: string,
  paths: string[]
): Promise<string | null> {
  for (const path of [...paths].sort()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if ((await git.entryAt(sha, dir))?.type === 'blob')
        return `${dir} is a file, so the edit can't write ${path}; nothing was committed.`;
    }
    const entry = await git.entryAt(sha, path);
    if (entry?.type === 'tree')
      return `${path} is a directory, so the edit can't write it as a file; nothing was committed.`;
    if (entry && !REGULAR.has(entry.entry.mode))
      return `${path} is not a regular file, so the edit can't change it; nothing was committed.`;
  }
  return null;
}

/** How far back from the tip findLessonCommit looks for an earlier try's commit. */
const LESSON_COMMIT_LOOKBACK = 20;

/**
 * The commit an earlier try of this lesson already pushed on `branch` (its step died before recording it), or null:
 * between the tip and `baseSha`, a commit by `author` carrying a `Dismissed-Finding` trailer for every one of
 * `findingIds`. Null when the tip is still `baseSha`, or `baseSha` isn't within the last few commits.
 */
export async function findLessonCommit(
  git: GitService,
  branch: string,
  baseSha: string,
  author: { email: string },
  findingIds: string[]
): Promise<string | null> {
  const tip = await git.resolve(branch);
  if (!tip || tip === baseSha || !findingIds.length) return null;
  for (const c of await git.log(tip, LESSON_COMMIT_LOOKBACK)) {
    if (c.hash === baseSha) return null;
    const trailers = new Set(
      c.message
        .split('\n')
        .filter((l) => l.startsWith(`${LESSON_TRAILER}: `))
        .map((l) => l.slice(LESSON_TRAILER.length + 2).trim())
    );
    if (
      c.author.email === author.email &&
      findingIds.every((id) => trailers.has(id))
    )
      return c.hash;
  }
  return null;
}

/**
 * Validates `files` (the learner's changed files, from `baseSha`) and commits them on `branch` with compare-and-swap
 * from `baseSha`, refusing a path that is a directory or lies under a file (`shapeConflict`). When the branch moved,
 * once more from its new tip, and only if none of the changed files moved with it and the shapes still allow it
 * (someone's edit is never overwritten); a second loss fails. `fresh` gives a GitService with no cached refs.
 */
export async function commitLearned(opts: {
  git: GitService;
  fresh: () => GitService;
  branch: string;
  baseSha: string;
  files: Record<string, string | null>;
  author: Signature;
  message: string;
}): Promise<LearnedCommit> {
  const { branch, author, message } = opts;
  const base = await contentsAt(opts.git, opts.baseSha, [
    ...Object.keys(opts.files),
    AGENT_PATH,
  ]);
  const checked = validateLearned(base, opts.files);
  if (!checked.ok) return { status: 'failed', error: checked.error };
  const { changes } = checked;
  const paths = Object.keys(changes);
  if (!paths.length) return { status: 'nothing' };
  const shape = await shapeConflict(opts.git, opts.baseSha, paths);
  if (shape) return { status: 'failed', error: shape };
  try {
    const sha = await opts.git.commitFiles({
      branch,
      parent: opts.baseSha,
      files: changes,
      author,
      message,
    });
    return { status: 'committed', sha };
  } catch (e) {
    if (!(e instanceof GitPushError)) throw e;
  }
  const git = opts.fresh();
  const tip = await git.resolve(branch);
  if (!tip)
    return {
      status: 'failed',
      error: `${branch} no longer exists; nothing was committed.`,
    };
  const moved = await shapeConflict(git, tip, paths);
  if (moved) return { status: 'failed', error: moved };
  const now = await contentsAt(git, tip, [...paths, AGENT_PATH]);
  const touched = paths.filter((p) => now[p] !== base[p]).sort();
  if (touched.length)
    return {
      status: 'failed',
      error: `${touched.join(', ')} changed on ${branch} while the agent was learning; nothing was committed.`,
    };
  const again = validateLearned(now, changes);
  if (!again.ok) return { status: 'failed', error: again.error };
  try {
    const sha = await git.commitFiles({
      branch,
      parent: tip,
      files: again.changes,
      author,
      message,
    });
    return { status: 'committed', sha };
  } catch (e) {
    if (e instanceof GitPushError)
      return { status: 'failed', error: branchMoved(branch) };
    throw e;
  }
}
