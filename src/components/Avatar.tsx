import { useMemo } from 'react';

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** GitHub-style identicon: a 5x5 mirrored grid in a color derived from the username. */
function Identicon({ seed, size }: { seed: string; size: number }) {
  const { cells, color } = useMemo(() => {
    const h = hash(seed);
    const h2 = hash(seed + ':');
    const cells: [number, number][] = [];
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 3; x++) {
        if ((h2 >> (y * 3 + x)) & 1) {
          cells.push([x, y]);
          if (x < 2) cells.push([4 - x, y]);
        }
      }
    }
    return { cells, color: `hsl(${h % 360}, 55%, ${45 + (h % 15)}%)` };
  }, [seed]);
  return (
    <svg
      width={size}
      height={size}
      viewBox="-0.5 -0.5 6 6"
      style={{ background: '#f0f0f0', display: 'block' }}
    >
      {cells.map(([x, y], i) => (
        <rect key={i} x={x} y={y} width={1.02} height={1.02} fill={color} />
      ))}
    </svg>
  );
}

export function Avatar({
  user,
  size = 20,
  className = '',
}: {
  user: { username: string; image?: string | null };
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`avatar avatar-user ${className}`}
      style={{
        width: size,
        height: size,
        display: 'inline-block',
        overflow: 'hidden',
        verticalAlign: 'middle',
        flexShrink: 0,
      }}
      title={user.username}
    >
      {user.image ? (
        <img
          src={user.image}
          width={size}
          height={size}
          alt={`@${user.username}`}
        />
      ) : (
        <Identicon seed={user.username} size={size} />
      )}
    </span>
  );
}
