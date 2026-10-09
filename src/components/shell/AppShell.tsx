import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useTheme } from '@/components/ThemeProvider';
import { useCurrentPageHead } from '@/components/ui/PageHead';
import { useCurrentUser } from '@/lib/auth';
import {
  addRecent,
  browserStorage,
  readRecent,
  recentKey,
  removeRecent,
  writeRecent,
  type RecentRepo,
} from '@/lib/recentRepos';
import { Rail } from './Rail';
import { TopBand } from './TopBand';
import { useMediaQuery } from './useMediaQuery';

/** Which menu hanging off the chrome is open: one at a time. */
export type ShellMenu = 'org' | 'create' | 'acct' | 'search' | null;

/** The repository being viewed, as the shell needs it (rail, search). */
export interface ShellRepo {
  fullName: string;
  defaultBranch: string;
  branches: string[];
  /** Admin rights on it (its Settings tab). */
  admin: boolean;
  /** Set on an agent's instruction repository. */
  agent: RecentRepo['agent'] | null;
}

interface ShellApi {
  enterRepo(repo: ShellRepo): void;
  leaveRepo(fullName: string): void;
  forgetRepo(fullName: string): void;
}

const ShellContext = createContext<ShellApi>({
  enterRepo() {},
  leaveRepo() {},
  forgetRepo() {},
});

/**
 * For `RepoLayout`: marks `repo` as the repository being viewed while mounted (the rail highlights it, search
 * scopes branches to it) and records the visit for the rail's recent list. Pass null while it loads.
 */
export function useShellRepo(repo: ShellRepo | null) {
  const shell = useContext(ShellContext);
  // By value: callers build `repo` inline, and a refetch that changes nothing shouldn't re-record the visit.
  const sig = repo ? JSON.stringify(repo) : '';
  useEffect(() => {
    if (!sig) return;
    const current = JSON.parse(sig) as ShellRepo;
    shell.enterRepo(current);
    return () => shell.leaveRepo(current.fullName);
  }, [shell, sig]);
}

/** For `RepoLayout`: drops a repository the person can no longer open from the recent list. */
export function useForgetRepo() {
  return useContext(ShellContext).forgetRepo;
}

const NARROW = '(max-width: 900px)';
const PIN_KEY = 'go-pin';

function readPin(): boolean {
  try {
    return localStorage.getItem(PIN_KEY) === '1';
  } catch {
    return false;
  }
}

function writePin(pinned: boolean) {
  try {
    localStorage.setItem(PIN_KEY, pinned ? '1' : '0');
  } catch {
    // Blocked storage: the choice lasts for this page only.
  }
}

const sameAgent = (a: RecentRepo['agent'], b: RecentRepo['agent']) =>
  a?.handle === b?.handle && (a?.color ?? null) === (b?.color ?? null);

/**
 * The signed-in app's frame, after HQ: the rail (collapsed, peeking on hover, pinned, or a drawer below 900px),
 * the top band (trail and `<h1>`, search, create, Approvals, account) and the work panel, `<main id="main"
 * class="content">`, which is the only scroller. On a route change the panel scrolls to the top (or to the URL's
 * #fragment), open menus and the drawer close, and focus moves to the band's `<h1>`.
 */
export function AppShell() {
  const { chrome } = useTheme();
  const user = useCurrentUser();
  const head = useCurrentPageHead();
  const { pathname, hash } = useLocation();
  const narrow = useMediaQuery(NARROW);

  const [boot, setBoot] = useState(true);
  const [pinned, setPinned] = useState(readPin);
  const [navOpen, setNavOpen] = useState(false);
  const [menu, setMenu] = useState<ShellMenu>(null);
  const [repo, setRepo] = useState<ShellRepo | null>(null);

  const key = user ? recentKey(user.id) : null;
  const [recent, setRecent] = useState<RecentRepo[]>(() =>
    key ? readRecent(browserStorage(), key) : []
  );
  const loadedKey = useRef(key);
  useEffect(() => {
    if (key === loadedKey.current) return;
    loadedKey.current = key;
    setRecent(key ? readRecent(browserStorage(), key) : []);
  }, [key]);
  useEffect(() => {
    if (key && key === loadedKey.current)
      writeRecent(browserStorage(), key, recent);
  }, [key, recent]);

  const mainRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // The first layout paints without transitions, so the rail never animates from full width on load.
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setBoot(false));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);

  // A new page starts at the top of the panel (before paint, so the old scroll position never flashes).
  useLayoutEffect(() => {
    if (mainRef.current && !hash) mainRef.current.scrollTop = 0;
    // Only a new path: a #fragment change on the same page is an in-page link the browser scrolls to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    setMenu(null);
    setNavOpen(false);
    // Focus the page's name, unless the page focused a field of its own (autofocus).
    const raf = requestAnimationFrame(() => {
      const active = document.activeElement;
      const typing =
        active instanceof HTMLElement &&
        mainRef.current?.contains(active) &&
        active.matches('input, textarea, select, [contenteditable="true"]');
      if (!typing) titleRef.current?.focus({ preventScroll: true });
    });
    // A #fragment on a new page: its target usually renders after the data loads.
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (hash) {
      let id = hash.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // Use it as written.
      }
      let tries = 0;
      const seek = () => {
        const target = document.getElementById(id);
        if (target) target.scrollIntoView();
        else if (tries++ < 30) timer = setTimeout(seek, 100);
      };
      seek();
    }
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Leaving the narrow layout closes the drawer.
  useEffect(() => {
    if (!narrow) setNavOpen(false);
  }, [narrow]);

  // An opened drawer takes focus (it comes before the band in the page, so Tab alone would never reach it).
  useEffect(() => {
    if (!navOpen || !narrow) return;
    const raf = requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>('.snav a')
        ?.focus({ preventScroll: true })
    );
    return () => cancelAnimationFrame(raf);
  }, [navOpen, narrow]);

  // Escape closes the open menu (focus returns to its button), else the drawer (focus returns to its button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (menu) {
        const trigger = document.querySelector<HTMLElement>(
          `[data-menu-trigger="${menu}"]`
        );
        setMenu(null);
        trigger?.focus();
      } else if (navOpen) {
        setNavOpen(false);
        document.querySelector<HTMLElement>('.drawer-btn')?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menu, navOpen]);

  // A press outside the open menu (and its button) closes it; for search that also clears the query.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest?.(`[data-menu-root="${menu}"]`)) setMenu(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [menu]);

  const togglePin = useCallback(() => {
    setPinned((p) => {
      writePin(!p);
      return !p;
    });
  }, []);

  const shell = useMemo<ShellApi>(
    () => ({
      enterRepo(next) {
        setRepo(next);
        setRecent((list) =>
          list[0]?.fullName.toLowerCase() === next.fullName.toLowerCase() &&
          sameAgent(list[0].agent, next.agent ?? undefined)
            ? list
            : addRecent(
                list,
                next.agent
                  ? { fullName: next.fullName, agent: next.agent }
                  : { fullName: next.fullName }
              )
        );
      },
      leaveRepo(fullName) {
        setRepo((cur) => (cur?.fullName === fullName ? null : cur));
      },
      forgetRepo(fullName) {
        setRecent((list) => removeRecent(list, fullName));
      },
    }),
    []
  );

  const skipToContent = (e: React.MouseEvent) => {
    e.preventDefault();
    mainRef.current?.focus();
  };

  return (
    <ShellContext.Provider value={shell}>
      <div
        className={`app${boot ? ' boot' : ''}${navOpen && narrow ? ' nav-open' : ''}`}
        data-chrome={chrome}
      >
        <a className="skip-link" href="#main" onClick={skipToContent}>
          Skip to content
        </a>
        <Rail
          pinned={pinned}
          onTogglePin={togglePin}
          narrow={narrow}
          navOpen={navOpen}
          menu={menu}
          setMenu={setMenu}
          recent={recent}
          repo={repo}
        />
        <div className="app-main">
          <TopBand
            head={head}
            titleRef={titleRef}
            menu={menu}
            setMenu={setMenu}
            navOpen={navOpen}
            onDrawer={() => setNavOpen((o) => !o)}
            repo={repo}
            recent={recent}
          />
          <main id="main" className="content" ref={mainRef} tabIndex={-1}>
            <div className="view">
              <Outlet />
            </div>
          </main>
        </div>
        <div
          className="scrim"
          aria-hidden="true"
          onClick={() => setNavOpen(false)}
        />
      </div>
    </ShellContext.Provider>
  );
}
