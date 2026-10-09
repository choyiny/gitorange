import { Link } from 'react-router-dom';
import {
  ChevronDownIcon,
  KeyIcon,
  PersonAddIcon,
  PlusIcon,
  RepoIcon,
} from '@primer/octicons-react';
import { useCurrentUser } from '@/lib/auth';
import type { ShellMenu } from './AppShell';
import { CrewIcon } from './icons';

/** The "+" menu: New repository, New reviewer and Invite member (site admins create those), New access token. */
export function CreateMenu({
  open,
  setMenu,
}: {
  open: boolean;
  setMenu(menu: ShellMenu): void;
}) {
  const user = useCurrentUser();
  const admin = user?.role === 'admin';
  const close = () => setMenu(null);
  return (
    <span className="tool-wrap" data-menu-root="create">
      <button
        type="button"
        className="tool"
        data-menu-trigger="create"
        aria-label="Create new"
        aria-expanded={open}
        onClick={() => setMenu(open ? null : 'create')}
      >
        <PlusIcon />
        <ChevronDownIcon className="chev" />
      </button>
      {open && (
        <div className="ws-menu right create-menu">
          <Link className="ws-item" to="/new" onClick={close}>
            <RepoIcon />
            <span>
              <b>New repository</b>
            </span>
          </Link>
          {admin && (
            <Link className="ws-item" to="/agents/new" onClick={close}>
              <CrewIcon />
              <span>
                <b>New reviewer</b>
              </span>
            </Link>
          )}
          <Link className="ws-item" to="/settings/tokens" onClick={close}>
            <KeyIcon />
            <span>
              <b>New access token</b>
            </span>
          </Link>
          {admin && (
            <Link className="ws-item" to="/admin?invite=1" onClick={close}>
              <PersonAddIcon />
              <span>
                <b>Invite member</b>
              </span>
            </Link>
          )}
        </div>
      )}
    </span>
  );
}
