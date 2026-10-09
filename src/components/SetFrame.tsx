import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ChecklistIcon,
  CreditCardIcon,
  HistoryIcon,
  KeyIcon,
  MailIcon,
  PeopleIcon,
  PlugIcon,
  SlidersIcon,
} from '@primer/octicons-react';
import {
  adminSection,
  settingsSection,
  type AdminSection,
  type SettingsSection,
} from '@/lib/siteNav';
import { CrewIcon } from '@/components/shell/icons';

interface NavItem<T extends string> {
  id: T;
  label: string;
  icon: ReactNode;
  to: string;
  /** An in-page section of the target page (`#setup`). */
  hash?: string;
}

const SETTINGS: NavItem<SettingsSection>[] = [
  {
    id: 'tokens',
    label: 'Access tokens',
    icon: <KeyIcon />,
    to: '/settings/tokens',
  },
  { id: 'mcp', label: 'MCP server', icon: <PlugIcon />, to: '/settings/mcp' },
  { id: 'emails', label: 'Emails', icon: <MailIcon />, to: '/settings/emails' },
];

const ADMIN: NavItem<AdminSection>[] = [
  {
    id: 'people',
    label: 'People and team',
    icon: <PeopleIcon />,
    to: '/admin',
  },
  {
    id: 'setup',
    label: 'Setup checks',
    icon: <ChecklistIcon />,
    to: '/admin',
    hash: '#setup',
  },
  {
    id: 'settings',
    label: 'Instance settings',
    icon: <SlidersIcon />,
    to: '/admin',
    hash: '#settings',
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: <CrewIcon />,
    to: '/admin/agents',
  },
  {
    id: 'usage',
    label: 'Usage and cost',
    icon: <CreditCardIcon />,
    to: '/admin/usage',
  },
  {
    id: 'audit',
    label: 'Audit log',
    icon: <HistoryIcon />,
    to: '/admin/audit',
  },
];

/**
 * The frame Settings and Site admin share: a side nav (a scrolling row on phones) and the page beside it. A
 * section of the page you are already on is an in-page jump: the work panel scrolls to it.
 */
function Frame<T extends string>({
  label,
  items,
  current,
  children,
}: {
  label: string;
  items: NavItem<T>[];
  current: T | null;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  // A section of the page you are on: scroll the panel to it (the link still updates the address). Another page:
  // the router navigates, and the shell scrolls to the fragment once it has rendered.
  const jump = (item: NavItem<T>) => {
    if (item.to !== pathname) return;
    if (item.hash)
      document.getElementById(item.hash.slice(1))?.scrollIntoView();
    else {
      const panel = document.getElementById('main');
      if (panel) panel.scrollTop = 0;
    }
  };
  return (
    <div className="setlayout">
      <nav className="setnav" aria-label={label}>
        {items.map((item) => (
          <Link
            key={item.id}
            to={{ pathname: item.to, hash: item.hash }}
            aria-current={item.id === current ? 'page' : undefined}
            onClick={() => jump(item)}
          >
            {item.icon}
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="setbody">{children}</div>
    </div>
  );
}

/** The personal settings pages (Access tokens, MCP server, Emails). */
export function SettingsFrame({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <Frame
      label="Your settings"
      items={SETTINGS}
      current={settingsSection(pathname)}
    >
      {children}
    </Frame>
  );
}

/** The Site admin pages. */
export function AdminFrame({ children }: { children: ReactNode }) {
  const { pathname, hash } = useLocation();
  return (
    <Frame
      label="Site admin"
      items={ADMIN}
      current={adminSection(pathname, hash)}
    >
      {children}
    </Frame>
  );
}

/** Rows standing in for a list while it loads (inside a frame, where the page header is already there). */
export function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div
      className="sk-rows"
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk sk-row" />
      ))}
    </div>
  );
}
