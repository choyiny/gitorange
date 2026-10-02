import { Link, useNavigate } from 'react-router-dom';
import {
  PlusIcon,
  TriangleDownIcon,
  RepoIcon,
  PersonAddIcon,
  PersonIcon,
  SignOutIcon,
  KeyIcon,
  ShieldLockIcon,
} from '@primer/octicons-react';
import type { ReactNode } from 'react';
import { signOut, useCurrentUser } from '@/lib/auth';
import { Avatar } from './Avatar';
import { Dropdown } from './Dropdown';
import { Logo } from './Logo';

export function Header({
  context,
  nav,
}: {
  context?: ReactNode;
  nav?: ReactNode;
}) {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';
  return (
    <header className="AppHeader">
      <div className="AppHeader-globalBar">
        <Link to="/" className="AppHeader-logo" aria-label="Homepage">
          <Logo size={24} />
        </Link>
        <div className="AppHeader-context flex-1">
          {context ?? (
            <Link to="/" className="text-bold">
              Dashboard
            </Link>
          )}
        </div>
        {user && (
          <div className="d-flex flex-items-center" style={{ gap: 8 }}>
            <Dropdown
              align="right"
              width={220}
              trigger={(_, toggle) => (
                <button
                  className="btn btn-sm d-inline-flex flex-items-center"
                  style={{ gap: 4, height: 32 }}
                  onClick={toggle}
                  aria-label="Create something new"
                >
                  <PlusIcon />
                  <TriangleDownIcon />
                </button>
              )}
            >
              {(close) => (
                <div className="py-2">
                  <Link className="select-panel-item" to="/new" onClick={close}>
                    <RepoIcon className="color-fg-muted" /> New repository
                  </Link>
                  {isAdmin && (
                    <Link
                      className="select-panel-item"
                      to="/admin?invite=1"
                      onClick={close}
                    >
                      <PersonAddIcon className="color-fg-muted" /> Invite member
                    </Link>
                  )}
                </div>
              )}
            </Dropdown>
            <Dropdown
              align="right"
              width={260}
              trigger={(_, toggle) => (
                <button
                  className="btn-invisible p-0 border-0"
                  style={{ background: 'none', cursor: 'pointer' }}
                  onClick={toggle}
                  aria-label="Open user navigation menu"
                >
                  <Avatar
                    user={{
                      username: user.username ?? user.name,
                      image: user.image,
                    }}
                    size={32}
                  />
                </button>
              )}
            >
              {(close) => (
                <div className="py-2">
                  <div
                    className="d-flex flex-items-center px-3 pb-2 mb-1 border-bottom"
                    style={{ gap: 8 }}
                  >
                    <Avatar
                      user={{
                        username: user.username ?? user.name,
                        image: user.image,
                      }}
                      size={32}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div className="text-bold f5">
                        {user.displayUsername ?? user.username}
                      </div>
                      <div className="color-fg-muted f6 text-truncate">
                        {user.name}
                      </div>
                    </div>
                  </div>
                  <Link
                    className="select-panel-item"
                    to={`/${user.username}`}
                    onClick={close}
                  >
                    <PersonIcon className="color-fg-muted" /> Your profile
                  </Link>
                  <Link
                    className="select-panel-item"
                    to={`/${user.username}?tab=repositories`}
                    onClick={close}
                  >
                    <RepoIcon className="color-fg-muted" /> Your repositories
                  </Link>
                  <div className="border-top my-1" />
                  <Link
                    className="select-panel-item"
                    to="/settings/tokens"
                    onClick={close}
                  >
                    <KeyIcon className="color-fg-muted" /> Personal access
                    tokens
                  </Link>
                  {isAdmin && (
                    <Link
                      className="select-panel-item"
                      to="/admin"
                      onClick={close}
                    >
                      <ShieldLockIcon className="color-fg-muted" /> Site admin
                    </Link>
                  )}
                  <div className="border-top my-1" />
                  <button
                    className="select-panel-item"
                    onClick={async () => {
                      close();
                      await signOut();
                      navigate('/login');
                    }}
                  >
                    <SignOutIcon className="color-fg-muted" /> Sign out
                  </button>
                </div>
              )}
            </Dropdown>
          </div>
        )}
      </div>
      {nav}
    </header>
  );
}
