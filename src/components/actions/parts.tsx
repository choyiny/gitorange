import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { agentKindLabel, AGENT_RUN_KINDS } from '@/lib/agentRuns';
import type { AgentRunKind } from '@/lib/uiApi';

/** The title block of a run page: an optional lead (a status mark or an avatar), the title, a line under it. */
export function RunHeader({
  lead,
  title,
  lede,
  actions,
}: {
  lead?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="phead">
      <div className="phead-row">
        <div className="phead-main">
          <div className="act-headline">
            {lead}
            <h2 className="ph-title">{title}</h2>
          </div>
          {lede && <p className="lede">{lede}</p>}
        </div>
        {actions && <div className="phead-actions">{actions}</div>}
      </div>
    </header>
  );
}

/** Newer / older (or previous / next) with where you are. A missing handler is a disabled button. */
export function Pager({
  prevLabel,
  nextLabel,
  onPrev,
  onNext,
  note,
}: {
  prevLabel: string;
  nextLabel: string;
  onPrev?: () => void;
  onNext?: () => void;
  note?: ReactNode;
}) {
  return (
    <nav className="act-pager" aria-label="Pagination">
      <button
        type="button"
        className="btn small"
        disabled={!onPrev}
        onClick={onPrev}
      >
        {prevLabel}
      </button>
      {note && <span className="muted small">{note}</span>}
      <button
        type="button"
        className="btn small"
        disabled={!onNext}
        onClick={onNext}
      >
        {nextLabel}
      </button>
    </nav>
  );
}

/** A row of links that filter a list; the current one is marked. */
export function FilterLinks({
  label,
  items,
}: {
  label: string;
  items: { key: string; label: string; to: string; current: boolean }[];
}) {
  return (
    <nav className="act-pills" aria-label={label}>
      {items.map((i) => (
        <Link
          key={i.key}
          to={i.to}
          aria-current={i.current ? 'true' : undefined}
          title={i.key.includes('/') ? i.key : undefined}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

/** Which kind of agent run to list: all, or one of the six. */
export function KindFilter({
  base,
  current,
}: {
  base: string;
  current: AgentRunKind | null;
}) {
  return (
    <FilterLinks
      label="Kind of agent run"
      items={[
        {
          key: 'all',
          label: 'All',
          to: `${base}/actions?agent=all`,
          current: current === null,
        },
        ...AGENT_RUN_KINDS.map(({ kind }) => ({
          key: kind,
          label: agentKindLabel(kind),
          to: `${base}/actions?agent=${kind}`,
          current: current === kind,
        })),
      ]}
    />
  );
}
