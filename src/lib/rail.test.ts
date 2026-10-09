import { describe, expect, it } from 'vitest';
import { railClasses } from './rail';

describe('railClasses', () => {
  it('is collapsed (64px in the layout) by default', () => {
    expect(railClasses({ pinned: false, peek: false, narrow: false })).toBe(
      'snav shut'
    );
  });

  it('peeks as an overlay: still shut in the layout, so the page never moves', () => {
    expect(railClasses({ pinned: false, peek: true, narrow: false })).toBe(
      'snav shut peeking'
    );
  });

  it('pinned takes its full width in the layout, and a peek changes nothing', () => {
    expect(railClasses({ pinned: true, peek: false, narrow: false })).toBe(
      'snav pinned'
    );
    expect(railClasses({ pinned: true, peek: true, narrow: false })).toBe(
      'snav pinned'
    );
  });

  it('is a full drawer (labels shown) on narrow screens, whatever else is set', () => {
    for (const pinned of [false, true])
      for (const peek of [false, true])
        expect(railClasses({ pinned, peek, narrow: true })).toBe('snav');
  });
});
