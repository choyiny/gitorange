import { describe, expect, it } from 'vitest';
import { withVia } from './via';

describe('withVia', () => {
  it('names the app a decision came through', () => {
    expect(withVia('octocat', 'Claude Mod')).toBe('octocat via Claude Mod');
  });
  it('leaves web decisions as just the person', () => {
    expect(withVia('octocat', null)).toBe('octocat');
    expect(withVia('octocat', undefined)).toBe('octocat');
    expect(withVia('octocat', '')).toBe('octocat');
  });
});
