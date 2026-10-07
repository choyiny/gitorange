import type { Lesson, LessonStatus } from './uiApi';

export const LESSON_STATUS: Record<
  LessonStatus,
  { label: string; className: string }
> = {
  pending: { label: 'Queued', className: 'color-fg-muted' },
  learning: { label: 'Learning', className: 'color-fg-attention' },
  committed: { label: 'Learned', className: 'color-fg-success' },
  nothing: { label: 'Nothing to learn', className: 'color-fg-muted' },
  failed: { label: 'Failed', className: 'color-fg-danger' },
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "learned from 2 dismissed findings" */
export const learnedPhrase = (findings: number) =>
  `learned from ${plural(findings, 'dismissed finding')}`;

/** The timeline entry as text: "@secagent learned from 2 dismissed findings · abc1234". */
export const learnedText = (handle: string, findings: number, sha: string) =>
  `@${handle} ${learnedPhrase(findings)} · ${sha.slice(0, 7)}`;

/** A lesson's dismissed findings: `Dismissed "Token logged", "No expiry"`. */
export const dismissedText = (titles: string[]) =>
  titles.length
    ? `Dismissed ${titles.map((t) => `"${t}"`).join(', ')}`
    : 'Dismissed findings';

/** What follows a lesson's status: its commit, why there was nothing to learn (first line), or its error. */
export function lessonNote(
  l: Pick<Lesson, 'status' | 'commitSha' | 'summary' | 'error'>
): { kind: 'commit'; sha: string } | { kind: 'text'; text: string } | null {
  if (l.status === 'committed' && l.commitSha)
    return { kind: 'commit', sha: l.commitSha };
  if (l.status === 'nothing')
    return {
      kind: 'text',
      text: l.summary?.trim().split('\n')[0] || 'Nothing general to learn.',
    };
  if (l.status === 'failed')
    return { kind: 'text', text: l.error ?? 'Failed.' };
  return null;
}
