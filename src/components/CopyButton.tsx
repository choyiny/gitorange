import { useState } from 'react';
import { CopyIcon, CheckIcon } from '@primer/octicons-react';

export function CopyButton({
  text,
  className = 'btn btn-sm',
  label = 'Copy to clipboard',
}: {
  text: string;
  className?: string;
  label?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <CheckIcon className="color-fg-success" /> : <CopyIcon />}
    </button>
  );
}
