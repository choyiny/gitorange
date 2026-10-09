/**
 * Themes: seven HQ colourways and GitHub, each shown in System, Light or Dark appearance. The preference is per
 * browser (localStorage). `index.html` applies it before the first paint with an inline script that mirrors
 * `rootAttributes`; `ThemeProvider` keeps it applied afterwards. Pure: no DOM access here.
 */

export type ThemeId =
  | 'navy'
  | 'ink'
  | 'slate'
  | 'indigo'
  | 'forest'
  | 'claret'
  | 'paper'
  | 'github';
/** `hq` is the XY Space look (our tokens); `dev` is GitHub's Primer look. */
export type Skin = 'hq' | 'dev';
/** The rail and top band colourway (`.app[data-chrome]`). `midnight` is Paper in dark mode. */
export type Chrome =
  | 'navy'
  | 'ink'
  | 'slate'
  | 'indigo'
  | 'forest'
  | 'claret'
  | 'paper'
  | 'midnight';
export type Mode = 'system' | 'light' | 'dark';

export interface Theme {
  id: ThemeId;
  label: string;
  skin: Skin;
  chrome: Chrome;
  /** Two colours for the menu swatch: the chrome and the accent. */
  swatch: [string, string];
}

export const THEMES: readonly Theme[] = [
  {
    id: 'navy',
    label: 'Navy',
    skin: 'hq',
    chrome: 'navy',
    swatch: ['#16203a', '#3730a3'],
  },
  {
    id: 'ink',
    label: 'Ink',
    skin: 'hq',
    chrome: 'ink',
    swatch: ['#101113', '#3730a3'],
  },
  {
    id: 'slate',
    label: 'Slate',
    skin: 'hq',
    chrome: 'slate',
    swatch: ['#1e242b', '#3730a3'],
  },
  {
    id: 'indigo',
    label: 'Indigo',
    skin: 'hq',
    chrome: 'indigo',
    swatch: ['#241f52', '#3730a3'],
  },
  {
    id: 'forest',
    label: 'Forest',
    skin: 'hq',
    chrome: 'forest',
    swatch: ['#122a1f', '#3730a3'],
  },
  {
    id: 'claret',
    label: 'Claret',
    skin: 'hq',
    chrome: 'claret',
    swatch: ['#2c1419', '#3730a3'],
  },
  {
    id: 'paper',
    label: 'Paper',
    skin: 'hq',
    chrome: 'paper',
    swatch: ['#dee2ea', '#3730a3'],
  },
  // The Dev skin restyles the chrome itself (tokens.css), so its chrome value is never shown.
  {
    id: 'github',
    label: 'GitHub',
    skin: 'dev',
    chrome: 'navy',
    swatch: ['#f6f8fa', '#1f883d'],
  },
];

export const THEME_KEY = 'go-theme-id';
export const MODE_KEY = 'go-mode';
export const DEFAULT_THEME: ThemeId = 'navy';
export const DEFAULT_MODE: Mode = 'system';

export function parseThemeId(value: unknown): ThemeId {
  return THEMES.find((t) => t.id === value)?.id ?? DEFAULT_THEME;
}

export function parseMode(value: unknown): Mode {
  return value === 'light' || value === 'dark' ? value : DEFAULT_MODE;
}

export interface ResolvedTheme {
  skin: Skin;
  chrome: Chrome;
  dark: boolean;
}

/** What a theme looks like right now: System mode follows `systemDark`; Paper turns midnight in the dark. */
export function resolveTheme(
  id: ThemeId,
  mode: Mode,
  systemDark: boolean
): ResolvedTheme {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  const dark = mode === 'dark' || (mode === 'system' && systemDark);
  return {
    skin: theme.skin,
    chrome: theme.chrome === 'paper' && dark ? 'midnight' : theme.chrome,
    dark,
  };
}

/**
 * The attributes `<html>` carries for a theme: our `data-skin`/`data-theme` (absent = follow the system) and
 * Primer's `data-color-mode`, so Primer's own variables switch with ours. `null` means remove the attribute.
 * Keep the boot script in `index.html` in step with this.
 */
export function rootAttributes(
  id: ThemeId,
  mode: Mode
): Record<string, string | null> {
  return {
    'data-skin': resolveTheme(id, mode, false).skin,
    'data-theme': mode === 'system' ? null : mode,
    'data-color-mode': mode === 'system' ? 'auto' : mode,
    'data-light-theme': 'light',
    'data-dark-theme': 'dark',
  };
}
