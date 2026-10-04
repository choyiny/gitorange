import { useAppName } from '@/lib/appName';

export function Logo({ size = 32 }: { size?: number }) {
  const appName = useAppName();
  // The square PNG (public/logo.png), also the favicon's source, so every logo matches.
  return (
    <img
      src="/logo.png"
      height={size}
      width={size}
      alt={appName}
      style={{ display: 'block' }}
    />
  );
}
