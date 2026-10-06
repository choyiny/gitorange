import type { PullState } from '@/lib/uiApi';
import { blocking, reasonText, STATE_CLASS, stateText } from '@/lib/pullState';

/** The state as a Primer Label; the title lists the reasons. */
export function PullStateLabel({
  state,
  showReason = false,
}: {
  state: PullState | null | undefined;
  /** Also print the first (blocking) reason beside the label, for touch and keyboard. */
  showReason?: boolean;
}) {
  if (!state) return null;
  const why = state.reasons.map(reasonText).join('; ');
  const { label, reason } = stateText(state);
  return (
    <>
      <span
        className={`Label ${STATE_CLASS[state.state]} v-align-middle`}
        title={why || undefined}
      >
        {label}
        {why && <span className="sr-only">: {why}</span>}
      </span>
      {showReason && reason && (
        <>
          {' '}
          <span className="f6 color-fg-muted wb-break-word">· {reason}</span>
        </>
      )}
    </>
  );
}

/** Reasons as a short list, most urgent first (the merge box and Approvals). */
export function PullStateReasons({ state }: { state: PullState }) {
  const shown = state.reasons.filter(blocking);
  if (!shown.length) return null;
  return (
    <ul className="ml-3 f6">
      {shown.map((r, i) => (
        <li key={i}>{reasonText(r)}</li>
      ))}
    </ul>
  );
}
