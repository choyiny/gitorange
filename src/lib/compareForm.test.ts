import { describe, expect, it } from 'vitest';
import {
  compareHref,
  comparison,
  parseRange,
  prefillTitle,
} from './compareForm';
import type { Commit, Compare } from './uiApi';

describe('parseRange', () => {
  it('reads base and head from base...head', () => {
    expect(parseRange('main...feature/x', 'main')).toEqual({
      base: 'main',
      head: 'feature/x',
    });
    expect(parseRange('release...claude/s4-usd', 'main')).toEqual({
      base: 'release',
      head: 'claude/s4-usd',
    });
  });

  it('reads a lone branch as the head, against the default branch', () => {
    expect(parseRange('feature/x', 'main')).toEqual({
      base: 'main',
      head: 'feature/x',
    });
  });

  it('uses the default branch for a missing base and no head for a missing head', () => {
    expect(parseRange('...feature', 'main')).toEqual({
      base: 'main',
      head: 'feature',
    });
    expect(parseRange('main...', 'main')).toEqual({ base: 'main', head: '' });
    expect(parseRange('', 'main')).toEqual({ base: 'main', head: '' });
  });
});

describe('compareHref', () => {
  it('writes the range after the repository', () => {
    expect(compareHref('/o/r', 'main', 'claude/s4-usd')).toBe(
      '/o/r/compare/main...claude/s4-usd'
    );
  });
});

const commit = (message: string): Commit =>
  ({ hash: 'a'.repeat(40), message }) as Commit;

describe('prefillTitle', () => {
  it('uses the message of a single commit, first line only', () => {
    expect(
      prefillTitle([commit('Bill in US dollars\n\nMore detail.')], 'x')
    ).toBe('Bill in US dollars');
  });

  it('makes a title out of the branch name for several commits', () => {
    expect(
      prefillTitle([commit('a'), commit('b')], 'claude/s4-usd_invoices')
    ).toBe('Claude s4 usd invoices');
  });

  it('makes a title out of the branch name for no commits', () => {
    expect(prefillTitle([], 'rate-limit')).toBe('Rate limit');
  });
});

const cmp = (extra: Partial<Compare>): Compare => ({
  baseSha: 'b',
  headSha: 'h',
  status: 'ahead',
  mergeable: true,
  conflicts: [],
  commits: [commit('x')],
  files: [],
  ...extra,
});

describe('comparison', () => {
  it('is ready with commits that are ahead', () => {
    expect(comparison(cmp({}))).toMatchObject({
      ready: true,
      canRebase: true,
      conflicts: false,
    });
  });

  it('has nothing to compare without commits or when the head is behind', () => {
    expect(comparison(cmp({ commits: [] })).ready).toBe(false);
    expect(comparison(cmp({ status: 'behind' })).ready).toBe(false);
    expect(comparison(cmp({ status: 'identical', commits: [] })).ready).toBe(
      false
    );
  });

  it('says it can be rebased when it is mergeable or simply ahead', () => {
    expect(
      comparison(cmp({ status: 'diverged', mergeable: true })).canRebase
    ).toBe(true);
    expect(
      comparison(cmp({ status: 'ahead', mergeable: false })).canRebase
    ).toBe(true);
  });

  it('says it cannot be rebased on its own when there are conflicts', () => {
    expect(
      comparison(
        cmp({ status: 'diverged', mergeable: false, conflicts: ['a.ts'] })
      )
    ).toMatchObject({ canRebase: false, conflicts: true, ready: true });
  });

  it('says nothing either way when it is neither mergeable nor in conflict', () => {
    expect(
      comparison(cmp({ status: 'diverged', mergeable: false, conflicts: [] }))
    ).toMatchObject({ canRebase: false, conflicts: false });
  });
});
