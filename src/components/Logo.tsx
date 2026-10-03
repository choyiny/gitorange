import { useAppName } from '@/lib/appName';

export function Logo({ size = 32 }: { size?: number }) {
  const appName = useAppName();
  return (
    <svg
      height={size}
      width={size}
      viewBox="0 0 32 32"
      aria-label={appName}
      role="img"
    >
      <circle cx="16" cy="17" r="13" fill="#f6821f" />
      <path d="M16 4c1-2 4-3 6-2-1 2-3 3-6 2z" fill="#3fb950" />
      <path
        d="M11 13v8m0-8a2 2 0 1 0 0-.01M11 21a2 2 0 1 0 0 .01M21 15a2 2 0 1 0 0-.01M21 15c0 3-4 3-8 5"
        stroke="#fff"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
