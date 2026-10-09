import { createContext, useContext, useEffect, type ReactNode } from 'react';

/** One step of the trail in the top band. The last crumb is the page itself. */
export interface Crumb {
  label: string;
  to?: string;
}

/** What a page tells the top band: its trail, its name (the band's `<h1>`) and, on repository pages, its tab. */
export interface PageHeadInfo {
  crumbs: Crumb[];
  title: string;
  tab?: string;
}

/**
 * Where `PageHead` publishes its trail and title. The app shell provides it and draws the top band from it;
 * without a provider (pages outside the shell) the trail is simply not shown.
 */
export const PageHeadContext = createContext<
  ((info: PageHeadInfo | null) => void) | null
>(null);

/**
 * The page's statement under the top band: title, a lede in plain words and the page's actions. The trail and
 * title also go to the top band (through `PageHeadContext`), whose `<h1>` names the page.
 */
export function PageHead({
  crumbs,
  title,
  lede,
  actions,
  tab,
}: {
  crumbs: Crumb[];
  title: string;
  lede?: ReactNode;
  actions?: ReactNode;
  /** The repository tab this page belongs to (e.g. "pulls"), for repository pages. */
  tab?: string;
}) {
  const publish = useContext(PageHeadContext);
  const trail = crumbs
    .map((c) => `${c.label}\u0000${c.to ?? ''}`)
    .join('\u0001');
  useEffect(() => {
    if (!publish) return;
    publish({ crumbs, title, tab });
    return () => publish(null);
    // `trail` stands in for `crumbs`, which callers usually build inline (a new array every render).
  }, [publish, trail, title, tab]);

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
