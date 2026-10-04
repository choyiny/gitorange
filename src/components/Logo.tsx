import { useAppName } from '@/lib/appName';

export function Logo({ size = 32 }: { size?: number }) {
  const appName = useAppName();
  // public/logo.png, also the favicon's source.
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
