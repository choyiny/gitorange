import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { PendingButton } from '@/components/ui/PendingButton';

/**
 * A destructive button that asks again in place (no dialog): "Delete" becomes "Delete token" and "Cancel".
 * Escape or Cancel goes back to the first button and returns focus to it. `error` is the last attempt's failure; the confirm button shows it with "Retry".
 */
export function InlineConfirm({
  label,
  confirmLabel,
  pendingLabel,
  accessibleName,
  onConfirm,
  pending = false,
  error = null,
  disabled = false,
}: {
  label: string;
  confirmLabel: string;
  pendingLabel?: string;
  /** Names what the button acts on for assistive tech ("Delete token laptop"). */
  accessibleName?: string;
  onConfirm: () => void;
  pending?: boolean;
  error?: string | null;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // Set when the person backs out, so focus goes back to the button they pressed (not lost to the page).
  const backedOut = useRef(false);
  useEffect(() => {
    if (!asking && backedOut.current) {
      backedOut.current = false;
      trigger.current?.focus();
    }
  }, [asking]);
  const cancel = () => {
    backedOut.current = true;
    setAsking(false);
  };
  if (!asking)
    return (
      <button
        ref={trigger}
        type="button"
        className="btn small danger"
        aria-label={accessibleName}
        disabled={disabled}
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
    );
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !pending) {
      e.stopPropagation();
      cancel();
    }
  };
  return (
    <span
      className="confirm"
      role="group"
      aria-label={accessibleName}
      onKeyDown={onKeyDown}
    >
      <PendingButton
        className="small danger"
        pending={pending}
        pendingLabel={pendingLabel}
        error={error}
        autoFocus
        onClick={onConfirm}
      >
        {confirmLabel}
      </PendingButton>
      <button
        type="button"
        className="btn small"
        disabled={pending}
        onClick={cancel}
      >
        Cancel
      </button>
    </span>
  );
}
