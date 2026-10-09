import { useMemo } from 'react';
import { identiconCells } from '@/lib/identicon';

/** A person's GitHub-style identicon: a mirrored 5×5 pattern in a colour from their username. */
export function Identicon({
  login,
  size = 20,
  className,
}: {
  login: string;
  size?: number;
  className?: string;
}) {
  const { color, cells } = useMemo(() => identiconCells(login), [login]);
  return (
    <svg
      className={className ? `identicon ${className}` : 'identicon'}
      width={size}
      height={size}
      viewBox="0 0 7 7"
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      <rect width="7" height="7" className="idn-bg" />
      <g fill={color}>
        {cells.map((on, i) =>
          on ? (
            <rect
              key={i}
              x={(i % 5) + 1}
              y={Math.floor(i / 5) + 1}
              width="1"
              height="1"
            />
          ) : null
        )}
      </g>
    </svg>
  );
}
