import { describe, expect, it } from 'vitest';
import { repoBand, repoRest, repoTabOf, repoTabs } from './repoNav';

describe('repoRest', () => {
  it('splits and decodes the path after /owner/repo', () => {
    expect(repoRest('/o/r')).toEqual([]);
    expect(repoRest('/o/r/')).toEqual([]);
    expect(repoRest('/o/r/blob/main/src/a%20b.ts')).toEqual([
      'blob',
      'main',
      'src',
      'a b.ts',
    ]);
    // A malformed escape stays as it was rather than throwing.
    expect(repoRest('/o/r/tree/%E0%A4%A')).toEqual(['tree', '%E0%A4%A']);
  });
});

describe('repoTabOf', () => {
  it('marks Pull requests on the list, a pull request and compare', () => {
    for (const rest of [
      ['pulls'],
      ['pull', '3'],
      ['pull', '3', 'files'],
      ['compare'],
      ['compare', 'main...feat'],
    ])
      expect(repoTabOf(rest, false)).toBe('pulls');
  });

  it('marks Actions, Insights and Settings on their pages', () => {
    expect(repoTabOf(['actions'], false)).toBe('actions');
    expect(repoTabOf(['actions', 'runs', '4', 'job', 'j'], false)).toBe(
      'actions'
    );
    expect(repoTabOf(['actions', 'agent', 'x'], false)).toBe('actions');
    expect(repoTabOf(['insights'], false)).toBe('insights');
    expect(repoTabOf(['settings'], false)).toBe('settings');
  });

  it('marks Code everywhere else; commits are Code except on agent repositories', () => {
    for (const rest of [
      [],
      ['tree', 'main'],
      ['blob', 'main', 'a.ts'],
      ['nope'],
    ])
      expect(repoTabOf(rest, false)).toBe('code');
    expect(repoTabOf(['commits', 'main'], false)).toBe('code');
    expect(repoTabOf(['commit', 'abc'], false)).toBe('code');
    expect(repoTabOf(['commits'], true)).toBe('commits');
    expect(repoTabOf(['commit', 'abc'], true)).toBe('commits');
  });
});

describe('repoTabs', () => {
  it('shows the existing tabs, Settings only to admins', () => {
    expect(repoTabs(false, true).map((t) => t.id)).toEqual([
      'code',
      'pulls',
      'actions',
      'insights',
      'settings',
    ]);
    expect(repoTabs(false, false).map((t) => t.id)).toEqual([
      'code',
      'pulls',
      'actions',
      'insights',
    ]);
  });

  it('shows Code, Commits and Settings on agent repositories', () => {
    expect(repoTabs(true, true).map((t) => [t.id, t.path])).toEqual([
      ['code', ''],
      ['commits', 'commits'],
      ['settings', 'settings'],
    ]);
  });
});

describe('repoBand (the default trail for a repository page)', () => {
  const base = '/o/r';

  it('names the tab on its top page', () => {
    expect(repoBand([], base, false)).toEqual({
      tab: 'code',
      icon: 'code',
      crumbs: [{ label: 'Code' }],
      title: 'Code',
    });
    expect(repoBand(['pulls'], base, false)).toMatchObject({
      tab: 'pulls',
      icon: 'pull',
      title: 'Pull requests',
    });
    expect(repoBand(['settings'], base, false).title).toBe('Settings');
  });

  it('names a folder or file by its last segment', () => {
    expect(repoBand(['tree', 'main', 'src', 'lib'], base, false)).toEqual({
      tab: 'code',
      icon: 'code',
      crumbs: [{ label: 'lib' }],
      title: 'lib',
    });
    expect(repoBand(['blob', 'main', 'a.ts'], base, false)).toMatchObject({
      icon: 'file',
      title: 'a.ts',
    });
  });

  it('links back to the list from one item', () => {
    expect(repoBand(['pull', '12', 'files'], base, false)).toEqual({
      tab: 'pulls',
      icon: 'pull',
      crumbs: [{ label: 'Pull requests', to: '/o/r/pulls' }, { label: '#12' }],
      title: '#12',
    });
    expect(repoBand(['compare', 'a...b'], base, false).title).toBe(
      'New pull request'
    );
    expect(repoBand(['commit', 'abcdef1234567'], base, false)).toEqual({
      tab: 'code',
      icon: 'commit',
      crumbs: [{ label: 'Commits', to: '/o/r/commits' }, { label: 'abcdef1' }],
      title: 'abcdef1',
    });
    expect(repoBand(['actions', 'runs', '7'], base, false)).toMatchObject({
      crumbs: [{ label: 'Actions', to: '/o/r/actions' }, { label: 'Run #7' }],
      title: 'Run #7',
    });
    expect(repoBand(['actions', 'agent', 'x'], base, false).title).toBe(
      'Agent run'
    );
  });
});
