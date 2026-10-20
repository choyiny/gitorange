/**
 * The cut-release form's version and notes: what the page suggests, and what survives a refetch (after a 409 the
 * suggestion moves to the new head, but whatever the person typed stays theirs).
 */
import type { UnreleasedChanges } from './uiApi';

export const FIRST_NOTES = 'First release.';

export type ReleaseDraft = { version: string; notes: string };

/** The suggestion: the next version and its generated notes, or a typed version for the first release. */
export function suggestedDraft(
  u: Pick<UnreleasedChanges, 'latest' | 'next' | 'notesPreview'>
): ReleaseDraft {
  return u.latest
    ? { version: u.next ?? '', notes: u.notesPreview }
    : { version: '', notes: FIRST_NOTES };
}

/** Each field still equal to the old suggestion takes the new one; a field the person changed keeps their text. */
export function refreshDraft(
  current: ReleaseDraft,
  previous: ReleaseDraft,
  fresh: ReleaseDraft
): ReleaseDraft {
  return {
    version:
      current.version === previous.version ? fresh.version : current.version,
    notes: current.notes === previous.notes ? fresh.notes : current.notes,
  };
}
