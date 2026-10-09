import { Fragment, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertFillIcon,
  InboxIcon,
  ThreeBarsIcon,
} from '@primer/octicons-react';
import type { PageHeadInfo } from '@/components/ui/PageHead';
import { useApprovalCount } from '@/lib/approvals';
import { useCurrentUser } from '@/lib/auth';
import type { RecentRepo } from '@/lib/recentRepos';
import { useSetupChecks } from '@/lib/setupChecks';
import { AccountMenu } from './AccountMenu';
import type { ShellMenu, ShellRepo } from './AppShell';
import { CreateMenu } from './CreateMenu';
import { GlobalSearch } from './GlobalSearch';
import { PageIcon } from './icons';

/** Site admins only: a red button while Site admin → Setup reports errors. */
function SetupErrors() {
  const errors = useSetupChecks().data?.counts.error ?? 0;
  if (!errors) return null;
  const label = `${errors} setup error${errors === 1 ? '' : 's'}`;
  return (
    <Link
      to="/admin#setup"
      className="tool tool-alert"
      aria-label={`${label}: open Site admin, Setup`}
      title="This deployment is misconfigured. Open Site admin → Setup"
    >
      <AlertFillIcon />
      <span className="tool-label">{label}</span>
    </Link>
  );
}

/** Approvals inbox, with how many items wait on the person. Updates live. */
function ApprovalsTool() {
  const count = useApprovalCount().data ?? 0;
  return (
    <Link
      to="/approvals"
      className="tool"
      aria-label={count ? `Approvals, ${count} waiting on you` : 'Approvals'}
      title="Approvals waiting on you"
    >
      <InboxIcon />
      {count > 0 && (
        <span className="tool-dot" aria-hidden="true">
          {count}
        </span>
      )}
    </Link>
  );
}

/**
 * The top band: the drawer button (phones), the page's icon, trail and name (the page's `<h1>`, focused on
 * navigation), search, the create menu, setup errors (site admins), Approvals and the account menu.
 */
export function TopBand({
  head,
  titleRef,
  menu,
  setMenu,
  navOpen,
  onDrawer,
  repo,
  recent,
}: {
  head: PageHeadInfo | null;
  titleRef: RefObject<HTMLHeadingElement>;
  menu: ShellMenu;
  setMenu(menu: ShellMenu): void;
  navOpen: boolean;
  onDrawer(): void;
  repo: ShellRepo | null;
  recent: RecentRepo[];
}) {
  const user = useCurrentUser();
  const admin = user?.role === 'admin';
  const ancestors = (head?.crumbs ?? []).slice(0, -1);
  return (
    <header className="topnav">
      <div className="ph-bar">
        <button
          type="button"
          className="drawer-btn"
          aria-label="Open navigation"
          aria-expanded={navOpen}
          onClick={onDrawer}
        >
          <ThreeBarsIcon />
        </button>
        {head?.icon && (
          <span className="ph-ic" aria-hidden="true">
            <PageIcon name={head.icon} size={15} />
          </span>
        )}
        <div className="ph-trail">
          {ancestors.map((c, i) => (
            <Fragment key={`${i}-${c.label}`}>
              {c.to ? (
                <Link className="crumb-anc" to={c.to}>
                  {c.label}
                </Link>
              ) : (
                <span className="crumb-anc">{c.label}</span>
              )}
              <span className="crumb-sep" aria-hidden="true">
                /
              </span>
            </Fragment>
          ))}
          <h1 ref={titleRef} tabIndex={-1}>
            {head?.title ?? ''}
          </h1>
        </div>
        <span className="ph-grow" />
        <GlobalSearch
          open={menu === 'search'}
          onOpen={() => setMenu('search')}
          onClose={() => setMenu(null)}
          repo={repo}
          recent={recent}
        />
        <div className="ph-tools">
          {admin && <SetupErrors />}
          <CreateMenu open={menu === 'create'} setMenu={setMenu} />
          <ApprovalsTool />
          <AccountMenu open={menu === 'acct'} setMenu={setMenu} />
        </div>
      </div>
    </header>
  );
}
