import { describe, expect, it } from 'vitest';
import {
  dismissedText,
  learnedPhrase,
  learnedText,
  LESSON_STATUS,
  lessonNote,
} from './lessons';

describe('lessons', () => {
  it('says what the timeline event says', () => {
    expect(learnedText('secagent', 2, 'abcdef1234')).toBe(
      '@secagent learned from 2 dismissed findings · abcdef1'
    );
    expect(learnedPhrase(1)).toBe('learned from 1 dismissed finding');
  });

  it('names the dismissed findings', () => {
    expect(dismissedText(['Token logged', 'No expiry'])).toBe(
      'Dismissed "Token logged", "No expiry"'
    );
    expect(dismissedText([])).toBe('Dismissed findings');
  });

  it('follows the status with the commit, the explanation, or the error', () => {
    const base = { commitSha: null, summary: null, error: null };
    expect(
      lessonNote({ ...base, status: 'committed', commitSha: 'a'.repeat(40) })
    ).toEqual({ kind: 'commit', sha: 'a'.repeat(40) });
    expect(
      lessonNote({
        ...base,
        status: 'nothing',
        summary: 'One-offs.\nNothing general.',
      })
    ).toEqual({ kind: 'text', text: 'One-offs.' });
    expect(lessonNote({ ...base, status: 'nothing' })).toEqual({
      kind: 'text',
      text: 'Nothing general to learn.',
    });
    expect(
      lessonNote({ ...base, status: 'failed', error: 'Too big.' })
    ).toEqual({
      kind: 'text',
      text: 'Too big.',
    });
    expect(lessonNote({ ...base, status: 'learning' })).toBeNull();
    expect(LESSON_STATUS.committed.label).toBe('Learned');
  });
});
