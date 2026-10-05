import { DotFillIcon } from '@primer/octicons-react';
import type { PullEvent, PullReason } from '@/lib/uiApi';
import { blocking, reasonText } from '@/lib/pullState';
import { timeAgo } from '@/lib/format';
import { PullStateLabel } from './PullStateLabel';

/** One GitOrange timeline entry, inside the page's TimelineItem layout. */
export function PullEventItem({ e }: { e: PullEvent }) {
  if (e.kind === 'state_changed' && e.state) {
    const reasons = ((e.data?.reasons as PullReason[]) ?? []).filter(blocking);
    return (
      <div className="TimelineItem ml-md-4 pl-md-3" style={{ marginLeft: 0 }}>
        <div className="TimelineItem-badge">
          <DotFillIcon />
        </div>
        <div
          className="TimelineItem-body f6 d-flex flex-items-center flex-wrap"
          style={{ gap: 4 }}
        >
          <PullStateLabel state={{ state: e.state, reasons: [] }} />
          {reasons.length > 0 && (
            <span>{reasons.map(reasonText).join('; ')}</span>
          )}
          <span className="color-fg-muted">{timeAgo(e.createdAt)}</span>
        </div>
      </div>
    );
  }
  return null;
}
