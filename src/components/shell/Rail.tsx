import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ChevronDownIcon,
  HomeIcon,
  InboxIcon,
  RepoIcon,
  ShieldIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
  SlidersIcon,
} from '@primer/octicons-react';
import { AgentAvatar } from '@/components/AgentAvatar';
import { useAppName } from '@/lib/appName';
import { useApprovalCount } from '@/lib/approvals';
import { useCurrentUser } from '@/lib/auth';
import { railClasses } from '@/lib/rail';
import type { RecentRepo } from '@/lib/recentRepos';
import type { ShellMenu, ShellRepo } from './AppShell';
import { CrewIcon } from './icons';

/** Which rail entry the current page belongs to. */
function railKey(pathname: string, repo: ShellRepo | null): string | null {
  if (repo) return `repo:${repo.fullName.toLowerCase()}`;
  if (pathname === '/') return 'home';
  if (pathname === '/repos' || pathname === '/new') return 'repos';
  if (pathname === '/approvals' || pathname.startsWith('/approvals/'))
    return 'approvals';
  if (pathname === '/agents' || pathname.startsWith('/agents/'))
    return 'agents';
  if (pathname.startsWith('/settings/')) return 'settings';
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return 'admin';
  return null;
}

function RailItem({
  to,
  label,
  icon,
  current,
  count,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  current: boolean;
  /** A waiting count (Approvals): a badge on the open rail, a dot on the collapsed one. */
  count?: number;
}) {
  return (
    <Link
      className={`snav-item${count !== undefined ? ' has-count' : ''}`}
      to={to}
      title={label}
      aria-label={count ? `${label}, ${count} waiting` : label}
      aria-current={current ? 'page' : undefined}
    >
      <span className="snav-ic">{icon}</span>
      <span className="snav-nm">{label}</span>
      {count ? (
        <>
          <span className="nav-count warn">{count}</span>
          <span className="snav-dot" />
        </>
      ) : null}
    </Link>
  );
}

function RecentItem({ repo, current }: { repo: RecentRepo; current: boolean }) {
  const [owner, name] = repo.fullName.split('/');
  return (
    <Link
      className="snav-item"
      to={`/${repo.fullName}`}
      title={repo.fullName}
      aria-label={repo.agent ? `${repo.fullName}, agent` : repo.fullName}
      aria-current={current ? 'page' : undefined}
    >
      <span className="snav-ic">
        {repo.agent ? (
          <AgentAvatar
            handle={repo.agent.handle}
            color={repo.agent.color}
            size={24}
          />
        ) : (
          <RepoIcon />
        )}
      </span>
      <span className="snav-nm">
        {name}
        <span className="snav-own"> · {repo.agent ? 'agent' : owner}</span>
      </span>
    </Link>
  );
}

/**
 * The rail, after HQ: brand, the instance, the global pages, the five most recently visited repositories, the
 * account pages and the pin. Collapsed to 64px by default; pointing at it (or tabbing into it) opens it over the
 * page ("peek"); pinned it stays 236px wide; below 900px it is a drawer opened from the top band. Only classes
 * change between states, so nothing under the pointer re-renders.
 */
export function Rail({
  pinned,
  onTogglePin,
  narrow,
  navOpen,
  menu,
  setMenu,
  recent,
  repo,
}: {
  pinned: boolean;
  onTogglePin(): void;
  narrow: boolean;
  navOpen: boolean;
  menu: ShellMenu;
  setMenu(menu: ShellMenu): void;
  recent: RecentRepo[];
  repo: ShellRepo | null;
}) {
  const user = useCurrentUser();
  const admin = user?.role === 'admin';
  const appName = useAppName();
  const approvals = useApprovalCount().data ?? 0;
  const { pathname } = useLocation();
  const current = railKey(pathname, repo);

  const navRef = useRef<HTMLElement>(null);
  const [peek, setPeek] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const menuRef = useRef(menu);
  menuRef.current = menu;

  const openPeek = () => {
    clearTimeout(timer.current);
    if (!pinned && !narrow) setPeek(true);
  };
  // Closes shortly after the pointer and focus have both left (and the instance menu is shut).
  const closePeek = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const nav = navRef.current;
      if (menuRef.current === 'org') return;
      if (
        nav &&
        (nav.matches(':hover') || nav.contains(document.activeElement))
      )
        return;
      setPeek(false);
    }, 220);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    setPeek(false);
  }, [narrow, pinned]);
  useEffect(() => {
    if (menu !== 'org') closePeek();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);

  // The closed drawer is off screen: keep it out of the tab order and away from assistive tech.
  useEffect(() => {
    if (navRef.current) navRef.current.inert = narrow && !navOpen;
  }, [narrow, navOpen]);

  // A peek is an overlay: the rail keeps its 64px in the layout and its panel opens over the page.
  const className = railClasses({ pinned, peek, narrow });

  return (
    <nav
      ref={navRef}
      className={className}
      aria-label={appName}
      onPointerEnter={openPeek}
      onPointerLeave={closePeek}
      onFocus={openPeek}
      onBlur={(e) => {
        if (!navRef.current?.contains(e.relatedTarget as Node | null))
          closePeek();
      }}
    >
      <div className="snav-panel">
        <Link className="snav-brand" to="/" aria-label={`${appName} home`}>
          <img src="/logo.png" width={26} height={26} alt="" />
          <span className="brand-wordmark">GitOrange</span>
        </Link>
        <div className="snav-ws" data-menu-root="org">
          <button
            type="button"
            className="snav-org-btn"
            data-menu-trigger="org"
            aria-expanded={menu === 'org'}
            aria-label={`Instance: ${appName}`}
            title={appName}
            onClick={() => setMenu(menu === 'org' ? null : 'org')}
          >
            <span className="org-dot" aria-hidden="true" />
            <span className="snav-org-nm">{appName}</span>
            <ChevronDownIcon className="chev" />
          </button>
          {menu === 'org' && (
            <div className="ws-menu">
              <div className="dd-label">Instance</div>
              <div className="ws-item on">
                <span
                  className="wd"
                  style={{ background: 'var(--brand-orange)' }}
                />
                <span>
                  <b>{appName}</b>
                  <span className="sub">
                    {window.location.host} · single-tenant
                  </span>
                </span>
              </div>
              {admin && (
                <>
                  <div className="dd-sep" />
                  <Link
                    className="ws-item"
                    to="/admin"
                    onClick={() => setMenu(null)}
                  >
                    <span>
                      <b>Instance settings</b>
                      <span className="sub">Site admin</span>
                    </span>
                  </Link>
                </>
              )}
            </div>
          )}
        </div>
        <div className="snav-list">
          <div className="snav-sec">
            <RailItem
              to="/"
              label="Home"
              icon={<HomeIcon />}
              current={current === 'home'}
            />
            <RailItem
              to="/repos"
              label="Repositories"
              icon={<RepoIcon />}
              current={current === 'repos'}
            />
            <RailItem
              to="/approvals"
              label="Approvals"
              icon={<InboxIcon />}
              current={current === 'approvals'}
              count={approvals}
            />
            <RailItem
              to="/agents"
              label="Agents"
              icon={<CrewIcon />}
              current={current === 'agents'}
            />
          </div>
          {recent.length > 0 && (
            <div
              className="snav-sec"
              role="group"
              aria-label="Recent repositories"
            >
              <div className="snav-rule" />
              {recent.map((r) => (
                <RecentItem
                  key={r.fullName}
                  repo={r}
                  current={current === `repo:${r.fullName.toLowerCase()}`}
                />
              ))}
            </div>
          )}
          <div className="snav-sec">
            <div className="snav-rule" />
            <RailItem
              to="/settings/tokens"
              label="Settings"
              icon={<SlidersIcon />}
              current={current === 'settings'}
            />
            {admin && (
              <RailItem
                to="/admin"
                label="Site admin"
                icon={<ShieldIcon />}
                current={current === 'admin'}
              />
            )}
          </div>
        </div>
        <div className="snav-fold-row">
          <button
            type="button"
            className="snav-fold"
            aria-label="Keep the rail open"
            aria-pressed={pinned}
            title={
              pinned
                ? 'Unpin: the rail collapses and opens when you point at it'
                : 'Keep the rail open'
            }
            onClick={onTogglePin}
          >
            {pinned ? <SidebarCollapseIcon /> : <SidebarExpandIcon />}
            <span>{pinned ? 'Unpin' : 'Keep open'}</span>
          </button>
        </div>
      </div>
    </nav>
  );
}
