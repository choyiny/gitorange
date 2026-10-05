import type { PullState } from '@/lib/uiApi';
import {
  blocking,
  reasonText,
  STATE_CLASS,
  STATE_LABEL,
} from '@/lib/pullState';

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
  const stacked = state.reasons.find((r) => r.kind === 'stacked_on');
  const first = state.reasons.find(blocking) ?? state.reasons[0];
  return (
    <>
      <span
        className={`Label ${STATE_CLASS[state.state]} v-align-middle`}
        title={why || undefined}
      >
        {STATE_LABEL[state.state]}
        {state.state === 'ready' && stacked
          ? `, stacked on #${Number(stacked.pr)}`
          : ''}
        {why && <span className="sr-only">: {why}</span>}
      </span>
      {showReason && first && (
        <>
          {' '}
          <span className="f6 color-fg-muted wb-break-word">
            · {reasonText(first)}
          </span>
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
