import { describe, expect, it } from 'vitest';
import {
  canRetryRebase,
  rebasedFirst,
  rebasedText,
  rebaseHeadline,
} from './rebaseStatus';

const view = { onto: 'main', commit: null, files: [], error: null };

describe('rebase status text', () => {
  it('says where the branch stands against its base', () => {
    expect(
      rebaseHeadline({ ...view, status: 'up_to_date' }, 'feature').title
    ).toBe('Up to date with main');
    expect(rebaseHeadline({ ...view, status: 'behind' }, 'feature')).toEqual({
      title: 'Behind main',
      detail:
        'GitOrange rebases it onto the latest commits; merging rebases it first if it still needs to.',
    });
    expect(
      rebaseHeadline({ ...view, status: 'nothing_to_merge' }, 'feature').title
    ).toBe('This branch is up to date');
  });

  it('names the conflicting commit, and what to do', () => {
    expect(
      rebaseHeadline(
        {
          ...view,
          status: 'conflict',
          commit: 'abc1234def',
          files: ['x.ts'],
          error: 'Commit abc1234 conflicts in x.ts. Rebase locally.',
        },
        'feature'
      )
    ).toEqual({
      title: 'Commit abc1234 conflicts with main',
      detail: 'Commit abc1234 conflicts in x.ts. Rebase locally.',
    });
    expect(rebaseHeadline({ ...view, status: 'conflict' }, 'feature')).toEqual({
      title: 'This branch can’t be rebased onto main',
      detail: 'Rebase feature onto main locally, then push.',
    });
    expect(
      rebaseHeadline(
        { ...view, status: 'resolving', commit: 'abc1234def' },
        'feature'
      ).title
    ).toBe('Resolving commit abc1234’s conflict with AI');
  });

  it('offers to try a stopped rebase again, except on a branch GitOrange never rebases', () => {
    expect(
      canRetryRebase({
        ...view,
        status: 'conflict',
        commit: 'abc1234def',
        error: 'The model could not be reached or failed to answer.',
      })
    ).toBe(true);
    expect(
      canRetryRebase({
        ...view,
        status: 'conflict',
        error: 'Not rebased: main is the default branch.',
      })
    ).toBe(false);
    expect(canRetryRebase({ ...view, status: 'behind' })).toBe(false);
    expect(canRetryRebase({ ...view, status: 'resolving' })).toBe(false);
    expect(canRetryRebase(null)).toBe(false);
  });

  it('describes a rebase on the timeline', () => {
    expect(
      rebasedText({
        from: 'aaaaaaa1',
        to: 'bbbbbbb2',
        onto: 'main',
        skipped: 2,
        resolved: 1,
      })
    ).toBe(
      'GitOrange rebased this branch onto main (aaaaaaa → bbbbbbb), skipping 2 commits main already has; AI resolved the conflicts of 1 commit'
    );
    expect(
      rebasedText({
        from: 'aaaaaaa1',
        to: 'bbbbbbb2',
        onto: 'main',
        skipped: 0,
        resolved: 0,
      })
    ).toBe('GitOrange rebased this branch onto main (aaaaaaa → bbbbbbb)');
  });

  it('tells a merge that rebased first and waits apart from a refusal', () => {
    const rebased = 'b'.repeat(40);
    expect(rebasedFirst(409, { error: 'x', reason: 'checks', rebased })).toBe(
      true
    );
    expect(rebasedFirst(409, { error: 'x', reason: 'review', rebased })).toBe(
      true
    );
    // Checks that failed before any rebase: a real refusal.
    expect(rebasedFirst(409, { error: 'x', reason: 'checks' })).toBe(false);
    expect(rebasedFirst(409, { error: 'x', reason: 'rebase', rebased })).toBe(
      false
    );
    expect(rebasedFirst(400, { error: 'x', reason: 'checks', rebased })).toBe(
      false
    );
    expect(rebasedFirst(409, null)).toBe(false);
  });
});
