export function Spinner({ size = 32 }: { size?: number }) {
  return (
    <div className="d-flex flex-justify-center py-6">
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        style={{ animation: 'rotate-keyframes 1s linear infinite' }}
      >
        <circle
          cx="8"
          cy="8"
          r="7"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="2"
        />
        <path
          d="M15 8a7.002 7.002 0 00-7-7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <style>
        {'@keyframes rotate-keyframes{100%{transform:rotate(360deg)}}'}
      </style>
    </div>
  );
}
