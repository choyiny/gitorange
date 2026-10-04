import { NavLink } from 'react-router-dom';

/** Tabs across the Site admin pages. */
export function AdminNav() {
  const cls = ({ isActive }: { isActive: boolean }) =>
    `UnderlineNav-item${isActive ? ' selected' : ''}`;
  return (
    <nav className="UnderlineNav mb-4" aria-label="Site admin">
      <div className="UnderlineNav-body">
        <NavLink end to="/admin" className={cls}>
          People &amp; team
        </NavLink>
        <NavLink to="/admin/usage" className={cls}>
          Usage &amp; cost
        </NavLink>
      </div>
    </nav>
  );
}
