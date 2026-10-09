import { Link } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import { StarIcon } from '@primer/octicons-react';
import type { AgentStats } from '@/lib/uiApi';
import { ActivityGrid } from '@/components/agents/ActivityGrid';
import { LoadError } from '@/components/Notice';
import { Section } from '@/components/ui/Section';

const pending = (
  <div className="sk-rows" role="status" aria-busy="true" aria-label="Loading">
    <div className="sk sk-row tall" />
  </div>
);

/**
 * How its findings fared, its best catch, and its reviews day by day. All of it counts only repositories you can
 * see, and covers everything the agent has done (the grid, the last 26 weeks).
 */
export function AgentRecord({
  stats,
  color,
}: {
  stats: UseQueryResult<AgentStats>;
  color: string;
}) {
  const s = stats.data;
  return (
    <>
      <Section title="Record">
        {stats.isError && !s ? (
          <LoadError
            what="its record"
            error={stats.error}
            onRetry={() => void stats.refetch()}
          />
        ) : !s ? (
          pending
        ) : (
          <>
            <div className="stats">
              <div className="stat">
                <b>{s.raised}</b>
                <span>findings raised</span>
              </div>
              <div className="stat">
                <b>{s.keptPct === null ? '—' : `${s.keptPct}%`}</b>
                <span>
                  kept ({s.kept} kept, {s.dismissed} dismissed)
                </span>
              </div>
              <div className="stat">
                <b>{s.rules}</b>
                <span>{s.rules === 1 ? 'rule learned' : 'rules learned'}</span>
              </div>
              <div className="stat">
                <b>{s.reviews}</b>
                <span>{s.reviews === 1 ? 'review' : 'reviews'}</span>
              </div>
            </div>
            {s.bestCatch && (
              <p className="callout">
                <StarIcon size={16} />
                <span>
                  <b>Best catch.</b> {s.bestCatch.title}{' '}
                  <Link
                    to={`/${s.bestCatch.repo}/pull/${s.bestCatch.number}`}
                    className="muted"
                  >
                    {s.bestCatch.repo}#{s.bestCatch.number}
                  </Link>
                </span>
              </p>
            )}
          </>
        )}
      </Section>
      <Section
        title="Activity"
        actions={<span className="muted small">Reviews per day, UTC</span>}
      >
        {stats.isError && !s ? null : !s ? (
          pending
        ) : (
          <div className="panel pad">
            <ActivityGrid byDay={s.byDay} color={color} />
          </div>
        )}
      </Section>
    </>
  );
}
