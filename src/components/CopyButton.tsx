import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CopyIcon, CheckIcon } from '@primer/octicons-react';

/**
 * Copies `text` and shows a check for 1.5 seconds. With `children` it carries a visible label ("Copy") that
 * reads "Copied" meanwhile; without, it is an icon button named by `label`.
 */
export function CopyButton({
  text,
  className = 'btn btn-sm',
  label = 'Copy to clipboard',
  children,
}: {
  text: string;
  className?: string;
  label?: string;
  children?: ReactNode;
}) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={className}
      aria-label={children ? undefined : label}
      title={children ? label : undefined}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Clipboard access can be refused (an insecure page, a denied permission); say nothing happened.
          return;
        }
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <CheckIcon className="color-fg-success" /> : <CopyIcon />}
      {children ? (done ? 'Copied' : children) : null}
    </button>
  );
}
