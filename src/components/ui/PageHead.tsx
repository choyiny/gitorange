import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { PageIconName } from '@/lib/pageIcon';

/** One step of the trail in the top band. The last crumb is the page itself. */
export interface Crumb {
  label: string;
  to?: string;
}

/**
 * What a page tells the top band: its icon, its trail, its name (the band's `<h1>`) and, on repository pages, the
 * tab it belongs to. Inside a repository the crumbs are relative to it: `RepoLayout` puts `owner / repo` in front,
 * so a pull request page publishes `[{ label: 'Pull requests', to }, { label: '#12' }]`.
 */
export interface PageHeadInfo {
  icon?: PageIconName;
  crumbs: Crumb[];
  title: string;
  tab?: string;
  /** The browser tab's title before the instance name, when it should say more than `title`. */
  documentTitle?: string;
}

/**
 * Where pages publish their `PageHeadInfo`. `PageHeadProvider` (around the whole app) provides it, the shell draws
 * the top band from it, and `RepoLayout` provides a nested one that adds the repository to the trail. Without a
 * provider publishing does nothing.
 */
export const PageHeadContext = createContext<
  ((info: PageHeadInfo | null) => void) | null
>(null);

const CurrentPageHead = createContext<PageHeadInfo | null>(null);

/** Holds the current page's head for the top band and the document title. */
export function PageHeadProvider({ children }: { children: ReactNode }) {
  const [head, setHead] = useState<PageHeadInfo | null>(null);
  return (
    <PageHeadContext.Provider value={setHead}>
      <CurrentPageHead.Provider value={head}>
        {children}
      </CurrentPageHead.Provider>
    </PageHeadContext.Provider>
  );
}

/** The head the current page published (null while none has). */
export function useCurrentPageHead(): PageHeadInfo | null {
  return useContext(CurrentPageHead);
}

/**
 * Names the page in the top band: `usePageHead({ icon: 'inbox', crumbs: [{ label: 'Approvals' }], title:
 * 'Approvals' })`. The band's `<h1>` shows `title` and takes focus when the route changes. Republishes only when
 * the values change (callers may build `crumbs` inline), and clears on unmount.
 */
export function usePageHead({
  icon,
  crumbs,
  title,
  tab,
  documentTitle,
}: PageHeadInfo) {
  const publish = useContext(PageHeadContext);
  const trail = crumbs
    .map((c) => `${c.label}\u0000${c.to ?? ''}`)
    .join('\u0001');
  useEffect(() => {
    if (!publish) return;
    publish({ icon, crumbs, title, tab, documentTitle });
    return () => publish(null);
    // `trail` stands in for `crumbs`, which callers usually build inline (a new array every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publish, icon, trail, title, tab, documentTitle]);
}

/**
 * The page's statement under the top band: title, a lede in plain words and the page's actions. The trail and
 * title also go to the top band (`usePageHead`), whose `<h1>` names the page.
 */
export function PageHead({
  icon,
  crumbs,
  title,
  lede,
  actions,
  tab,
}: {
  icon?: PageIconName;
  crumbs: Crumb[];
  title: string;
  lede?: ReactNode;
  actions?: ReactNode;
  /** The repository tab this page belongs to (e.g. "pulls"), for repository pages. */
  tab?: string;
}) {
  usePageHead({ icon, crumbs, title, tab });
  return (
    <header className="phead">
      <div className="phead-row">
        <div className="phead-main">
          <h2 className="ph-title">{title}</h2>
          {lede && <p className="lede">{lede}</p>}
        </div>
        {actions && <div className="phead-actions">{actions}</div>}
      </div>
    </header>
  );
}
