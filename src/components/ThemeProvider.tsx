import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  MODE_KEY,
  THEME_KEY,
  parseMode,
  parseThemeId,
  resolveTheme,
  rootAttributes,
  type Chrome,
  type Mode,
  type Skin,
  type ThemeId,
} from '@/lib/theme';

export interface ThemeState {
  theme: ThemeId;
  mode: Mode;
  setTheme(id: ThemeId): void;
  setMode(mode: Mode): void;
  /** What shows right now: the shell sets `.app[data-chrome]` from `chrome` (Paper turns midnight in the dark). */
  skin: Skin;
  chrome: Chrome;
  dark: boolean;
}

const ThemeContext = createContext<ThemeState | null>(null);

const DARK_QUERY = '(prefers-color-scheme: dark)';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows and blocked storage: the choice lasts for this page only.
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.(DARK_QUERY).matches ?? false;
}

/** Holds the theme preference (per browser), keeps `<html>`'s attributes in step and follows the system. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() =>
    parseThemeId(stored(THEME_KEY))
  );
  const [mode, setModeState] = useState<Mode>(() =>
    parseMode(stored(MODE_KEY))
  );
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const onChange = () => setSystemDark(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Before paint, so a theme switch never shows a frame of the old one.
  useLayoutEffect(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(rootAttributes(theme, mode))) {
      if (value == null) root.removeAttribute(name);
      else root.setAttribute(name, value);
    }
  }, [theme, mode]);

  const setTheme = useCallback((id: ThemeId) => {
    store(THEME_KEY, id);
    setThemeState(id);
  }, []);
  const setMode = useCallback((m: Mode) => {
    store(MODE_KEY, m);
    setModeState(m);
  }, []);

  const value = useMemo<ThemeState>(
    () => ({
      theme,
      mode,
      setTheme,
      setMode,
      ...resolveTheme(theme, mode, systemDark),
    }),
    [theme, mode, setTheme, setMode, systemDark]
  );
  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}
