import { Link } from 'react-router-dom';
import { GitBranchIcon } from '@primer/octicons-react';

/**
 * The compact branch map's place on the Health page. Until the branch map component (Branches page) can be drawn
 * here, this card says what the map shows and links to it.
 */
export function BranchMapCard({ base }: { base: string }) {
  return (
    <div className="panel hl-map">
      <span className="hl-map-icon" aria-hidden="true">
        <GitBranchIcon size={20} />
      </span>
      <div className="hl-map-text">
        <b>See the branch map</b>
        <span className="muted small">
          Every open change, where it branched from and where it lands on main.
        </span>
      </div>
      <Link className="btn small" to={`${base}/branches`}>
        Open the branch map
      </Link>
    </div>
  );
}
