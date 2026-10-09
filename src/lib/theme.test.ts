import { describe, expect, it } from 'vitest';
import {
  MODE_KEY,
  THEME_KEY,
  THEMES,
  parseMode,
  parseThemeId,
  resolveTheme,
  rootAttributes,
} from './theme';

describe('THEMES', () => {
  it('lists the seven HQ colourways and GitHub, in menu order', () => {
    expect(THEMES.map((t) => t.id)).toEqual([
      'navy',
      'ink',
      'slate',
      'indigo',
      'forest',
      'claret',
      'paper',
      'github',
    ]);
    expect(THEMES.filter((t) => t.skin === 'dev').map((t) => t.id)).toEqual([
      'github',
    ]);
    for (const t of THEMES) expect(t.swatch).toHaveLength(2);
  });

  it('stores the preference under the go- keys', () => {
    expect(THEME_KEY).toBe('go-theme-id');
    expect(MODE_KEY).toBe('go-mode');
  });
});

describe('resolveTheme', () => {
  it('puts GitHub on the Dev skin', () => {
    expect(resolveTheme('github', 'light', false).skin).toBe('dev');
    expect(resolveTheme('github', 'dark', false)).toMatchObject({
      skin: 'dev',
      dark: true,
    });
    expect(resolveTheme('navy', 'light', false).skin).toBe('hq');
  });

  it('turns Paper into the midnight chrome in dark mode', () => {
    expect(resolveTheme('paper', 'dark', false)).toEqual({
      skin: 'hq',
      chrome: 'midnight',
      dark: true,
    });
    expect(resolveTheme('paper', 'light', true).chrome).toBe('paper');
  });

  it('keeps the other colourways in dark mode', () => {
    expect(resolveTheme('claret', 'dark', false)).toEqual({
      skin: 'hq',
      chrome: 'claret',
      dark: true,
    });
    expect(resolveTheme('forest', 'dark', true).chrome).toBe('forest');
  });

  it('follows the system in System mode', () => {
    expect(resolveTheme('navy', 'system', true).dark).toBe(true);
    expect(resolveTheme('navy', 'system', false).dark).toBe(false);
    expect(resolveTheme('paper', 'system', true).chrome).toBe('midnight');
    expect(resolveTheme('paper', 'system', false).chrome).toBe('paper');
  });

  it('ignores the system when the mode is chosen', () => {
    expect(resolveTheme('navy', 'light', true).dark).toBe(false);
    expect(resolveTheme('navy', 'dark', false).dark).toBe(true);
  });
});

describe('stored values', () => {
  it('falls back to Navy and System for anything unknown', () => {
    expect(parseThemeId('claret')).toBe('claret');
    expect(parseThemeId('neon')).toBe('navy');
    expect(parseThemeId(null)).toBe('navy');
    expect(parseMode('dark')).toBe('dark');
    expect(parseMode('auto')).toBe('system');
    expect(parseMode(undefined)).toBe('system');
  });
});

describe('rootAttributes', () => {
  it('leaves data-theme off in System mode and lets Primer follow the system', () => {
    expect(rootAttributes('navy', 'system')).toEqual({
      'data-skin': 'hq',
      'data-theme': null,
      'data-color-mode': 'auto',
      'data-light-theme': 'light',
      'data-dark-theme': 'dark',
    });
  });

  it('pins both our tokens and Primer to the chosen mode', () => {
    expect(rootAttributes('github', 'dark')).toEqual({
      'data-skin': 'dev',
      'data-theme': 'dark',
      'data-color-mode': 'dark',
      'data-light-theme': 'light',
      'data-dark-theme': 'dark',
    });
    expect(rootAttributes('paper', 'light')).toMatchObject({
      'data-skin': 'hq',
      'data-theme': 'light',
      'data-color-mode': 'light',
    });
  });
});
