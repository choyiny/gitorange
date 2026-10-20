import { describe, expect, it } from 'vitest';
import { FIRST_NOTES, refreshDraft, suggestedDraft } from './releaseDraft';

const changes = (latest: string | null, next: string | null, notes: string) =>
  ({ latest, next, notesPreview: notes }) as Parameters<
    typeof suggestedDraft
  >[0];

describe('suggestedDraft', () => {
  it('suggests the next version and its notes, or a typed first release', () => {
    expect(suggestedDraft(changes('v0.1.0', 'v0.2.0', '### Minor'))).toEqual({
      version: 'v0.2.0',
      notes: '### Minor',
    });
    expect(suggestedDraft(changes(null, null, FIRST_NOTES))).toEqual({
      version: '',
      notes: FIRST_NOTES,
    });
  });
});

describe('refreshDraft', () => {
  const before = { version: 'v0.2.0', notes: 'old notes' };
  const after = { version: 'v1.0.0', notes: 'new notes' };

  it('moves fields still at the old suggestion to the new one', () => {
    expect(refreshDraft(before, before, after)).toEqual(after);
  });

  it('keeps what the person typed', () => {
    expect(
      refreshDraft({ version: 'v0.3.0', notes: 'mine' }, before, after)
    ).toEqual({ version: 'v0.3.0', notes: 'mine' });
    expect(
      refreshDraft({ version: 'v0.2.0', notes: 'mine' }, before, after)
    ).toEqual({ version: 'v1.0.0', notes: 'mine' });
    expect(
      refreshDraft({ version: 'v0.5.0', notes: 'old notes' }, before, after)
    ).toEqual({ version: 'v0.5.0', notes: 'new notes' });
  });
});
