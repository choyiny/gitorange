import { NavLink } from 'react-router-dom';
import { KeyIcon, MailIcon, PlugIcon } from '@primer/octicons-react';

/** The sidebar shared by the personal settings pages; above the page on phones, so every page stays reachable. */
export function SettingsNav() {
  const item = ({ isActive }: { isActive: boolean }) =>
    `menu-item d-flex flex-items-center${isActive ? ' selected' : ''}`;
  return (
    <nav
      className="menu col-12 col-md-3 flex-shrink-0"
      style={{ height: 'fit-content' }}
      aria-label="Settings"
    >
      <NavLink to="/settings/emails" className={item} style={{ gap: 8 }}>
        <MailIcon /> Emails
      </NavLink>
      <NavLink to="/settings/tokens" className={item} style={{ gap: 8 }}>
        <KeyIcon /> Personal access tokens
      </NavLink>
      <NavLink to="/settings/mcp" className={item} style={{ gap: 8 }}>
        <PlugIcon /> MCP server
      </NavLink>
    </nav>
  );
}
